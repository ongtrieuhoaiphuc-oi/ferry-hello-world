import { readFileSync, writeFileSync } from 'node:fs';

const path = 'scripts/ferry-cloudflare-action.sh';
let source = readFileSync(path, 'utf8');

const sshSection = /mkdir -p "\$HOME\/\.ssh"[\s\S]*?ssh-keyscan -p 3022 localhost[^\n]*\n/;
if (!sshSection.test(source)) throw new Error('Could not locate Ferry SSH setup');
source = source.replace(
  sshSection,
  'docker exec dokku dokku network:set --global attach-post-deploy webserver || log "Dokku global network setting returned non-zero; continuing"\n',
);

const marker = 'log "Deploying the checked-out app through Ferry"';
if (!source.includes(marker)) throw new Error('Could not locate Ferry deploy marker');
source = source.replace(
  marker,
  `log "Initializing empty Cloudflare ingress before Ferry preflight"
ingress_payload='{"config":{"ingress":[{"service":"http_status:404"}]}}'
cf_result "$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ingress_payload")" >/dev/null

log "Creating deployment infrastructure with Ferry"`,
);

const deploySection = /export CF_EMAIL CF_GLOBAL_APIKEY[\s\S]*?\.\/ferry\.sh deploy "\$APP_NAME"[^\n]*\n\)/;
if (!deploySection.test(source)) throw new Error('Could not locate Ferry git-push deployment');
source = source.replace(
  deploySection,
  `export CF_EMAIL CF_GLOBAL_APIKEY CF_ACCOUNT_ID TUNNEL_ID TUNNEL_TOKEN DOKKU_HOSTNAME
export CF_API_TOKEN=global-key-compat
(
  cd "$RUNTIME"
  ./ferry.sh deploy "$APP_NAME" -H "$APP_HOSTNAME" -p "$APP_PORT" -d "$ROOT" --no-push -y
)

log "Building app image on the shared Docker daemon"
IMAGE_TAG="ferry-ci/$APP_NAME:${GITHUB_SHA:-latest}"
docker build --tag "$IMAGE_TAG" "$ROOT"
docker exec dokku dokku network:set "$APP_NAME" attach-post-deploy webserver || true
log "Releasing image through Dokku without SSH"
docker exec dokku dokku git:from-image "$APP_NAME" "$IMAGE_TAG"`,
);

writeFileSync(path, source);
console.log('Node.js patch applied: Ferry infrastructure + Dokku image release, no SSH');
