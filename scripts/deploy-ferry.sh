#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '\n\033[1;36m[ferry]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[ferry]\033[0m %s\n' "$*" >&2; exit 1; }

ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
RUNTIME="${RUNNER_TEMP:-/tmp}/ferry-runtime"

load_env_file() {
  local file="$1" line key value
  [[ -f "$file" ]] || die "Missing $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"; value="${line#*=}"
    [[ "$value" == \"*\" && "$value" == *\" ]] && value="${value:1:${#value}-2}"
    [[ "$value" == \'*\' && "$value" == *\' ]] && value="${value:1:${#value}-2}"
    export "$key=$value"
  done < "$file"
}

load_raw_env() {
  local line key value
  [[ -n "${FERRY_ENV_RAW:-}" ]] || die "Missing FERRY_ENV GitHub secret"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"; value="${line#*=}"
    [[ "$value" == \"*\" && "$value" == *\" ]] && value="${value:1:${#value}-2}"
    [[ "$value" == \'*\' && "$value" == *\' ]] && value="${value:1:${#value}-2}"
    export "$key=$value"
  done <<< "$FERRY_ENV_RAW"
  unset FERRY_ENV_RAW
}

load_env_file "$ROOT/.env"
load_raw_env
: "${CF_EMAIL:?FERRY_ENV requires CF_EMAIL}"
: "${CF_GLOBAL_APIKEY:?FERRY_ENV requires CF_GLOBAL_APIKEY}"
: "${DOKKU_HOSTNAME:?FERRY_ENV requires DOKKU_HOSTNAME}"

HELLO1_HOST="${HELLO1_HOSTNAME:-${HELLO1_HOST_PREFIX}.${DOKKU_HOSTNAME}}"
HELLO2_HOST="${HELLO2_HOSTNAME:-${HELLO2_HOST_PREFIX}.${DOKKU_HOSTNAME}}"
CF_API=https://api.cloudflare.com/client/v4

cf() {
  local method="$1" path="$2" data="${3:-}" args
  args=(-fsS -X "$method" -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_GLOBAL_APIKEY" -H "Content-Type: application/json")
  [[ -n "$data" ]] && args+=(--data "$data")
  curl "${args[@]}" "$CF_API$path"
}
result() {
  local response="$1"
  jq -e '.success == true' <<< "$response" >/dev/null || { jq -r '.errors[]?.message // "Cloudflare request failed"' <<< "$response" >&2; return 1; }
  jq -c '.result' <<< "$response"
}

log "Resolving Cloudflare account"
if [[ -z "${CF_ACCOUNT_ID:-}" ]]; then
  CF_ACCOUNT_ID="$(result "$(cf GET '/accounts?per_page=50')" | jq -r '.[0].id // empty')"
fi
[[ -n "$CF_ACCOUNT_ID" ]] || die "No Cloudflare account found"

log "Creating or reusing tunnel $TUNNEL_NAME"
tunnels="$(result "$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel?is_deleted=false&per_page=100")")"
TUNNEL_ID="$(jq -r --arg name "$TUNNEL_NAME" '[.[] | select(.name == $name)][0].id // empty' <<< "$tunnels")"
if [[ -z "$TUNNEL_ID" ]]; then
  secret="$(openssl rand 32 | base64 -w0)"
  payload="$(jq -nc --arg name "$TUNNEL_NAME" --arg secret "$secret" '{name:$name,tunnel_secret:$secret,config_src:"cloudflare"}')"
  TUNNEL_ID="$(result "$(cf POST "/accounts/$CF_ACCOUNT_ID/cfd_tunnel" "$payload")" | jq -r '.id')"
fi
TUNNEL_TOKEN="$(result "$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token")" | jq -r '.')"

resolve_zone() {
  local hostname="$1" candidate="$1" zones id
  while [[ "$candidate" == *.* ]]; do
    zones="$(result "$(cf GET "/zones?name=$candidate&account.id=$CF_ACCOUNT_ID&per_page=1")")"
    id="$(jq -r '.[0].id // empty' <<< "$zones")"
    [[ -n "$id" ]] && { printf '%s' "$id"; return; }
    candidate="${candidate#*.}"
  done
  return 1
}

upsert_dns() {
  local hostname="$1" zone records record_id payload
  zone="$(resolve_zone "$hostname")" || die "No Cloudflare zone for $hostname"
  records="$(result "$(cf GET "/zones/$zone/dns_records?type=CNAME&name=$hostname&per_page=1")")"
  record_id="$(jq -r '.[0].id // empty' <<< "$records")"
  payload="$(jq -nc --arg name "$hostname" --arg target "$TUNNEL_ID.cfargotunnel.com" '{type:"CNAME",name:$name,content:$target,proxied:true,ttl:1}')"
  if [[ -n "$record_id" ]]; then result "$(cf PUT "/zones/$zone/dns_records/$record_id" "$payload")" >/dev/null
  else result "$(cf POST "/zones/$zone/dns_records" "$payload")" >/dev/null; fi
}

log "Reconciling DNS"
upsert_dns "$HELLO1_HOST"
upsert_dns "$HELLO2_HOST"

log "Preparing Ferry"
rm -rf "$RUNTIME"
git clone --depth 1 "${FERRY_REPOSITORY}" "$RUNTIME"
python3 - "$RUNTIME/ferry.sh" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1]); s = p.read_text()
needle = '-H "Authorization: Bearer ${CF_API_TOKEN}"'
replacement = '-H "X-Auth-Email: ${CF_EMAIL}"\n        -H "X-Auth-Key: ${CF_GLOBAL_APIKEY}"'
if needle not in s: raise SystemExit('Unsupported Ferry authentication helper')
p.write_text(s.replace(needle, replacement))
PY
chmod +x "$RUNTIME/ferry.sh"
cat > "$RUNTIME/.env" <<EOF
TUNNEL_ID=$TUNNEL_ID
TUNNEL_TOKEN=$TUNNEL_TOKEN
DOKKU_HOSTNAME=$DOKKU_HOSTNAME
CF_ACCOUNT_ID=$CF_ACCOUNT_ID
CF_API_TOKEN=global-key-compat
CF_EMAIL=$CF_EMAIL
CF_GLOBAL_APIKEY=$CF_GLOBAL_APIKEY
EOF
chmod 600 "$RUNTIME/.env"

log "Starting Ferry runtime"
docker network inspect webserver >/dev/null 2>&1 || docker network create webserver >/dev/null
docker volume inspect dokku-data >/dev/null 2>&1 || docker volume create dokku-data >/dev/null
(cd "$RUNTIME" && docker compose up -d)
for _ in $(seq 1 90); do docker exec dokku dokku version >/dev/null 2>&1 && break; sleep 2; done
docker exec dokku dokku version >/dev/null 2>&1 || die "Dokku failed to start"
docker exec dokku dokku network:set --global attach-post-deploy webserver || true

# Ferry expects a remotely managed tunnel configuration to exist.
bootstrap='{"config":{"ingress":[{"service":"http_status:404"}]}}'
result "$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$bootstrap")" >/dev/null

export CF_EMAIL CF_GLOBAL_APIKEY CF_ACCOUNT_ID TUNNEL_ID TUNNEL_TOKEN DOKKU_HOSTNAME
export CF_API_TOKEN=global-key-compat

deploy_app() {
  local name="$1" hostname="$2" port="$3" context="$4" tag
  log "Deploying $name at https://$hostname"
  (cd "$RUNTIME" && ./ferry.sh deploy "$name" -H "$hostname" -p "$port" -d "$context" --no-push -y)
  tag="ferry-ci/$name:${GITHUB_SHA:-latest}"
  docker build --tag "$tag" "$context"
  docker exec dokku dokku network:set "$name" attach-post-deploy webserver || true
  docker exec dokku dokku git:from-image "$name" "$tag"
}

deploy_app "$HELLO1_APP" "$HELLO1_HOST" "$HELLO1_PORT" "$ROOT"
deploy_app "$HELLO2_APP" "$HELLO2_HOST" "$HELLO2_PORT" "$ROOT/apps/hello2"

log "Publishing final tunnel ingress"
ingress="$(jq -nc --arg h1 "$HELLO1_HOST" --arg h2 "$HELLO2_HOST" '{config:{ingress:[{hostname:$h1,service:"http://dokku:80"},{hostname:$h2,service:"http://dokku:80"},{service:"http_status:404"}]}}')"
result "$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ingress")" >/dev/null
docker compose -f "$RUNTIME/docker-compose.yml" restart cloudflared >/dev/null

wait_public() {
  local hostname="$1"
  for _ in $(seq 1 90); do curl -fsS --max-time 10 "https://$hostname/health" >/dev/null 2>&1 && return; sleep 5; done
  return 1
}
wait_public "$HELLO1_HOST" || die "$HELLO1_HOST failed public health check"
wait_public "$HELLO2_HOST" || die "$HELLO2_HOST failed public health check"

printf '\n### Ferry apps are live\n\n- https://%s\n- https://%s\n' "$HELLO1_HOST" "$HELLO2_HOST" >> "$GITHUB_STEP_SUMMARY"
log "Both apps are publicly reachable"
minutes="${KEEP_ALIVE_MINUTES:-350}"
[[ "$minutes" =~ ^[0-9]+$ ]] && (( minutes >= 1 && minutes <= 350 )) || die "KEEP_ALIVE_MINUTES must be 1-350"
end=$((SECONDS + minutes * 60))
while (( SECONDS < end )); do sleep 30; curl -fsS --max-time 10 "https://$HELLO1_HOST/health" >/dev/null || true; curl -fsS --max-time 10 "https://$HELLO2_HOST/health" >/dev/null || true; done
