from pathlib import Path

path = Path("scripts/ferry-cloudflare-action.sh")
source = path.read_text()

source = source.replace(
    "docker exec dokku dokku network:set --global attach-post-deploy webserver\n",
    'docker exec dokku dokku network:set --global attach-post-deploy webserver || log "Dokku network setting returned non-zero; continuing"\n',
)

old_ssh = 'ssh-keyscan -p 3022 localhost >> "$HOME/.ssh/known_hosts" 2>/dev/null\n'
new_ssh = '''ssh_ready=false
for _ in $(seq 1 60); do
  if ssh-keyscan -p 3022 localhost >> "$HOME/.ssh/known_hosts" 2>/dev/null; then
    ssh_ready=true
    break
  fi
  sleep 2
done
$ssh_ready || die "Dokku SSH did not become ready"
'''
if old_ssh not in source:
    raise SystemExit("SSH patch target missing")
source = source.replace(old_ssh, new_ssh)

marker = 'log "Deploying the checked-out app through Ferry"\n'
initial_ingress = '''log "Initializing Cloudflare ingress before Ferry preflight"
ingress_payload="$(jq -nc --arg host "$APP_HOSTNAME" '{config:{ingress:[{hostname:$host,service:"http://dokku:80"},{service:"http_status:404"}]}}')"
cf_result "$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ingress_payload")" >/dev/null

log "Deploying the checked-out app through Ferry"
'''
if marker not in source:
    raise SystemExit("Deploy marker missing")
source = source.replace(marker, initial_ingress, 1)
path.write_text(source)
