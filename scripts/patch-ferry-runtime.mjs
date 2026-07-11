import { readFileSync, writeFileSync } from 'node:fs';

const path = 'scripts/ferry-cloudflare-action.sh';
let source = readFileSync(path, 'utf8');

function replaceRequired(oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Patch target missing: ${label}`);
  source = source.replace(oldText, newText);
}

const sshBlock = `mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
KEY="$HOME/.ssh/ferry_action_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$KEY" -C "github-actions@$TUNNEL_NAME"
docker exec -i dokku dokku ssh-keys:add github-actions < "$KEY.pub"
docker exec dokku dokku network:set --global attach-post-deploy webserver
ssh-keyscan -p 3022 localhost >> "$HOME/.ssh/known_hosts" 2>/dev/null
`;
replaceRequired(sshBlock, 'docker exec dokku dokku network:set --global attach-post-deploy webserver || log "Dokku global network setting returned non-zero; continuing"\n', 'SSH deployment setup');

replaceRequired(
  'log "Deploying the checked-out app through Ferry"\n',
  `log "Initializing empty Cloudflare ingress before Ferry preflight"
ingress_payload='{"config":{"ingress":[{"service":"http_status:404"}]}}'
cf_result "$(cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$ingress_payload")" >/dev/null

log "Creating deployment infrastructure with Ferry"
`,
  'Ferry deploy marker',
);

const deployBlock = `export CF_EMAIL CF_GLOBAL_APIKEY CF_ACCOUNT_ID TUNNEL_ID TUNNEL_TOKEN DOKKU_HOSTNAME
export CF_API_TOKEN=global-key-compat
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
git -C "$ROOT" config user.name github-actions
git -C "$ROOT" config user.email github-actions@users.noreply.github.com
(
  cd "$RUNTIME"
  ./ferry.sh deploy "$APP_NAME" -H "$APP_HOSTNAME" -p "$APP_PORT" -d "$ROOT" -y
)
`;
const imageDeployBlock = `export CF_EMAIL CF_GLOBAL_APIKEY CF_ACCOUNT_ID TUNNEL_ID TUNNEL_TOKEN DOKKU_HOSTNAME
export CF_API_TOKEN=global-key-compat
(
  cd "$RUNTIME"
  ./ferry.sh deploy "$APP_NAME" -H "$APP_HOSTNAME" -p "$APP_PORT" -d "$ROOT" --no-push -y
)

log "Building the app image on the shared Docker daemon"
IMAGE_TAG="ferry-ci/$APP_NAME:${GITHUB_SHA:-latest}"
docker build --tag "$IMAGE_TAG" "$ROOT"
docker exec dokku dokku network:set "$APP_NAME" attach-post-deploy webserver || true
log "Releasing the image through Dokku"
docker exec dokku dokku git:from-image "$APP_NAME" "$IMAGE_TAG"
`;
replaceRequired(deployBlock, imageDeployBlock, 'SSH git push deployment');
writeFileSync(path, source);
console.log('Patched Ferry runtime for GitHub-hosted deployment without SSH');
