#!/usr/bin/env bash
set -Eeuo pipefail

log() { printf '\n\033[1;36m[ferry-action]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[ferry-action]\033[0m %s\n' "$*" >&2; exit 1; }

ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/.." && pwd)}"
PUBLIC_ENV="$ROOT/.env"
RUNTIME="$RUNNER_TEMP/ferry-runtime"

[[ -f "$PUBLIC_ENV" ]] || die "Missing tracked .env"
set -a
# shellcheck disable=SC1090
source "$PUBLIC_ENV"

# FERRY_ENV is a raw .env file stored as one GitHub Actions secret.
[[ -n "${FERRY_ENV_RAW:-}" ]] || die "Create the FERRY_ENV repository secret first"
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" == export\ * ]] && line="${line#export }"
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  key="${line%%=*}"
  value="${line#*=}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then value="${value:1:${#value}-2}"; fi
  if [[ "$value" == \'*\' && "$value" == *\' ]]; then value="${value:1:${#value}-2}"; fi
  export "$key=$value"
done <<< "$FERRY_ENV_RAW"
unset FERRY_ENV_RAW
set +a

: "${CF_EMAIL:?FERRY_ENV must contain CF_EMAIL}"
: "${CF_GLOBAL_APIKEY:?FERRY_ENV must contain CF_GLOBAL_APIKEY}"

APP_NAME="${APP_NAME:-${GITHUB_REPOSITORY##*/}}"
TUNNEL_NAME="${TUNNEL_NAME:-$APP_NAME}"
APP_PORT="${APP_PORT:-3000}"
DOKKU_HOSTNAME="${DOKKU_HOSTNAME:-${BASE_DOMAIN:-}}"
APP_HOSTNAME="${APP_HOSTNAME:-}"
[[ -n "$DOKKU_HOSTNAME" || -n "$APP_HOSTNAME" ]] || die "FERRY_ENV must contain DOKKU_HOSTNAME or APP_HOSTNAME"
if [[ -z "$APP_HOSTNAME" ]]; then APP_HOSTNAME="${APP_NAME}.${DOKKU_HOSTNAME}"; fi
if [[ -z "$DOKKU_HOSTNAME" ]]; then DOKKU_HOSTNAME="${APP_HOSTNAME#*.}"; fi

case "$APP_NAME" in (*[!a-zA-Z0-9-]*|'') die "APP_NAME may only contain letters, numbers and hyphens";; esac
case "$APP_HOSTNAME" in (*[!a-zA-Z0-9.-]*|'') die "Invalid APP_HOSTNAME";; esac

command -v jq >/dev/null || die "jq is required"
command -v docker >/dev/null || die "Docker is required"

CF_API="https://api.cloudflare.com/client/v4"
cf() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-fsS -X "$method" -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_GLOBAL_APIKEY" -H "Content-Type: application/json")
  [[ -n "$data" ]] && args+=(--data "$data")
  curl "${args[@]}" "$CF_API$path"
}
cf_result() {
  local response="$1"
  jq -e '.success == true' <<< "$response" >/dev/null || { jq -r '.errors[]?.message // "Cloudflare API request failed"' <<< "$response" >&2; return 1; }
  jq -c '.result' <<< "$response"
}

log "Resolving Cloudflare account"
if [[ -z "${CF_ACCOUNT_ID:-}" ]]; then
  response="$(cf GET '/accounts?per_page=50')"
  accounts="$(cf_result "$response")"
  CF_ACCOUNT_ID="$(jq -r '.[0].id // empty' <<< "$accounts")"
fi
[[ -n "$CF_ACCOUNT_ID" ]] || die "No Cloudflare account is available to this Global API Key"

log "Finding or creating tunnel $TUNNEL_NAME"
response="$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel?is_deleted=false&per_page=100")"
tunnels="$(cf_result "$response")"
TUNNEL_ID="$(jq -r --arg name "$TUNNEL_NAME" '[.[] | select(.name == $name)][0].id // empty' <<< "$tunnels")"
if [[ -z "$TUNNEL_ID" ]]; then
  TUNNEL_SECRET="$(openssl rand 32 | base64 -w0)"
  payload="$(jq -nc --arg name "$TUNNEL_NAME" --arg secret "$TUNNEL_SECRET" '{name:$name,tunnel_secret:$secret,config_src:"cloudflare"}')"
  TUNNEL_ID="$(cf_result "$(cf POST "/accounts/$CF_ACCOUNT_ID/cfd_tunnel" "$payload")" | jq -r '.id')"
  log "Created tunnel $TUNNEL_ID"
else
  log "Reusing tunnel $TUNNEL_ID"
fi

log "Fetching tunnel run token"
TUNNEL_TOKEN="$(cf_result "$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token")" | jq -r '.')"
[[ -n "$TUNNEL_TOKEN" && "$TUNNEL_TOKEN" != null ]] || die "Cloudflare did not return a tunnel token"

log "Resolving DNS zone for $APP_HOSTNAME"
search="$APP_HOSTNAME"
ZONE_ID=""
while [[ "$search" == *.* ]]; do
  response="$(cf GET "/zones?name=$search&account.id=$CF_ACCOUNT_ID&per_page=1")"
  zones="$(cf_result "$response")"
  ZONE_ID="$(jq -r '.[0].id // empty' <<< "$zones")"
  [[ -n "$ZONE_ID" ]] && break
  search="${search#*.}"
done
[[ -n "$ZONE_ID" ]] || die "No Cloudflare zone found for $APP_HOSTNAME"

log "Creating or updating proxied DNS record"
response="$(cf GET "/zones/$ZONE_ID/dns_records?type=CNAME&name=$APP_HOSTNAME&per_page=1")"
records="$(cf_result "$response")"
RECORD_ID="$(jq -r '.[0].id // empty' <<< "$records")"
dns_payload="$(jq -nc --arg name "$APP_HOSTNAME" --arg content "$TUNNEL_ID.cfargotunnel.com" '{type:"CNAME",name:$name,content:$content,proxied:true,ttl:1}')"
if [[ -n "$RECORD_ID" ]]; then
  cf_result "$(cf PUT "/zones/$ZONE_ID/dns_records/$RECORD_ID" "$dns_payload")" >/dev/null
else
  cf_result "$(cf POST "/zones/$ZONE_ID/dns_records" "$dns_payload")" >/dev/null
fi

log "Cloning Ferry"
rm -rf "$RUNTIME"
git clone --depth 1 "${FERRY_REPOSITORY:-https://github.com/gastonmorixe/ferry.git}" "$RUNTIME"

# Ferry expects a scoped Bearer token. This runtime-only compatibility patch maps
# its API helper to the Global API Key headers supplied in FERRY_ENV.
python3 - "$RUNTIME/ferry.sh" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = '-H "Authorization: Bearer ${CF_API_TOKEN}"'
new = '-H "X-Auth-Email: ${CF_EMAIL}"\n        -H "X-Auth-Key: ${CF_GLOBAL_APIKEY}"'
if old not in s:
    raise SystemExit('Unsupported Ferry version: Cloudflare auth helper changed')
p.write_text(s.replace(old, new))
PY
chmod +x "$RUNTIME/ferry.sh"

# Secrets exist only in the runner filesystem. Nothing sensitive is committed.
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

log "Starting the ephemeral Ferry stack"
docker network inspect webserver >/dev/null 2>&1 || docker network create webserver >/dev/null
docker volume inspect dokku-data >/dev/null 2>&1 || docker volume create dokku-data >/dev/null
(
  cd "$RUNTIME"
  docker compose up -d
)

log "Waiting for Dokku"
for _ in $(seq 1 60); do
  docker exec dokku dokku version >/dev/null 2>&1 && break
  sleep 2
done
docker exec dokku dokku version >/dev/null 2>&1 || die "Dokku did not become ready"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
KEY="$HOME/.ssh/ferry_action_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "github-actions@$TUNNEL_NAME"
docker exec -i dokku dokku ssh-keys:add github-actions < "$KEY.pub"
docker exec dokku dokku network:set --global attach-post-deploy webserver
ssh-keyscan -p 3022 localhost >> "$HOME/.ssh/known_hosts" 2>/dev/null

log "Deploying the checked-out app through Ferry"
export CF_EMAIL CF_GLOBAL_APIKEY CF_ACCOUNT_ID TUNNEL_ID TUNNEL_TOKEN DOKKU_HOSTNAME
export CF_API_TOKEN=global-key-compat
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
git -C "$ROOT" config user.name github-actions
git -C "$ROOT" config user.email github-actions@users.noreply.github.com
(
  cd "$RUNTIME"
  ./ferry.sh deploy "$APP_NAME" -H "$APP_HOSTNAME" -p "$APP_PORT" -d "$ROOT" -y
)

log "Ensuring Cloudflare ingress points at Dokku"
ingress_payload="$(jq -nc --arg host "$APP_HOSTNAME" '{config:{ingress:[{hostname:$host,service:"http://dokku:80"},{service:"http_status:404"}]}}')"
cf_result "$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ingress_payload")" >/dev/null
docker compose -f "$RUNTIME/docker-compose.yml" restart cloudflared >/dev/null

PUBLIC_URL="https://$APP_HOSTNAME"
log "Waiting for $PUBLIC_URL"
ready=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 10 "$PUBLIC_URL/health" >/dev/null 2>&1; then ready=true; break; fi
  sleep 5
done
$ready || { docker compose -f "$RUNTIME/docker-compose.yml" logs --tail=100; die "Public health check failed"; }

printf '\n### Ferry deployment\n\n- URL: %s\n- Tunnel: `%s`\n- Mode: ephemeral GitHub-hosted runner\n' "$PUBLIC_URL" "$TUNNEL_NAME" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
log "LIVE: $PUBLIC_URL"

minutes="${KEEP_ALIVE_MINUTES:-350}"
[[ "$minutes" =~ ^[0-9]+$ ]] || die "keep_alive_minutes must be a number"
(( minutes >= 1 && minutes <= 350 )) || die "keep_alive_minutes must be between 1 and 350"
log "Keeping the GitHub-hosted Ferry server online for $minutes minutes"
end=$((SECONDS + minutes * 60))
while (( SECONDS < end )); do
  sleep 30
  curl -fsS --max-time 10 "$PUBLIC_URL/health" >/dev/null || log "Health check missed; tunnel may be reconnecting"
done
