import { readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = process.env.GITHUB_WORKSPACE || resolve(import.meta.dirname, '..');
const runtime = join(process.env.RUNNER_TEMP || tmpdir(), 'ferry-runtime');
const log = (message) => console.log(`\n\x1b[36m[ferry]\x1b[0m ${message}`);
const fail = (message) => { throw new Error(message); };
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options }).trim();

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7);
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

Object.assign(process.env, parseEnv(readFileSync(join(root, '.env'), 'utf8')));
Object.assign(process.env, parseEnv(process.env.FERRY_ENV_RAW || ''));
delete process.env.FERRY_ENV_RAW;
for (const key of ['CF_EMAIL', 'CF_GLOBAL_APIKEY', 'DOKKU_HOSTNAME']) if (!process.env[key]) fail(`FERRY_ENV requires ${key}`);
process.env.INITIAL_PASSWORD ||= randomBytes(24).toString('base64url');
console.log('::add-mask::' + process.env.INITIAL_PASSWORD);

const cfg = process.env;
const apps = [
  { name: cfg.HELLO1_APP, host: cfg.HELLO1_HOSTNAME || `${cfg.HELLO1_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.HELLO1_PORT), context: root, health: '/health' },
  { name: cfg.HELLO2_APP, host: cfg.HELLO2_HOSTNAME || `${cfg.HELLO2_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.HELLO2_PORT), context: join(root, 'apps/hello2'), health: '/health' },
  { name: cfg.OMNIROUTE_APP, host: cfg.OMNIROUTE_HOSTNAME || `${cfg.OMNIROUTE_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.OMNIROUTE_PORT), context: join(root, 'apps/omiroute'), health: '/api/monitoring/health' },
];

const headers = { 'X-Auth-Email': cfg.CF_EMAIL, 'X-Auth-Key': cfg.CF_GLOBAL_APIKEY, 'Content-Type': 'application/json' };
async function cf(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok || !data.success) fail(data.errors?.map((item) => item.message).join('; ') || `Cloudflare ${method} ${path} failed`);
  return data.result;
}
async function resolveZone(hostname, accountId) {
  let candidate = hostname;
  while (candidate.includes('.')) {
    const zones = await cf('GET', `/zones?name=${encodeURIComponent(candidate)}&account.id=${accountId}&per_page=1`);
    if (zones[0]?.id) return zones[0].id;
    candidate = candidate.slice(candidate.indexOf('.') + 1);
  }
  fail(`No Cloudflare zone for ${hostname}`);
}
async function waitHttp(url) {
  for (let i = 0; i < 120; i += 1) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (response.ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 5000));
  }
  fail(`${url} failed public health check`);
}
function prepareGitRepo(directory, name) {
  if (!existsSync(directory)) fail(`App directory does not exist: ${directory}`);
  if (existsSync(join(directory, '.git'))) return;
  log(`Initializing standalone Git repository for ${name}`);
  run('git', ['-C', directory, 'init', '-b', 'main']);
  run('git', ['-C', directory, 'config', 'user.name', 'github-actions']);
  run('git', ['-C', directory, 'config', 'user.email', 'github-actions@users.noreply.github.com']);
  run('git', ['-C', directory, 'add', '--all']);
  run('git', ['-C', directory, 'commit', '--allow-empty', '-m', `Build ${name}`]);
}

async function main() {
  log('Resolving Cloudflare account and tunnel');
  const accounts = cfg.CF_ACCOUNT_ID ? [{ id: cfg.CF_ACCOUNT_ID }] : await cf('GET', '/accounts?per_page=50');
  const accountId = accounts[0]?.id || fail('No Cloudflare account found');
  const tunnels = await cf('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
  let tunnel = tunnels.find((item) => item.name === cfg.TUNNEL_NAME);
  if (!tunnel) tunnel = await cf('POST', `/accounts/${accountId}/cfd_tunnel`, { name: cfg.TUNNEL_NAME, tunnel_secret: output('openssl', ['rand', '-base64', '32']), config_src: 'cloudflare' });
  const tunnelToken = await cf('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);

  for (const app of apps) {
    const zoneId = await resolveZone(app.host, accountId);
    const records = await cf('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(app.host)}&per_page=1`);
    const payload = { type: 'CNAME', name: app.host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1 };
    if (records[0]?.id) await cf('PUT', `/zones/${zoneId}/dns_records/${records[0].id}`, payload);
    else await cf('POST', `/zones/${zoneId}/dns_records`, payload);
  }

  log('Preparing Ferry runtime');
  rmSync(runtime, { recursive: true, force: true });
  run('git', ['clone', '--depth', '1', cfg.FERRY_REPOSITORY, runtime]);
  const ferryPath = join(runtime, 'ferry.sh');
  const source = readFileSync(ferryPath, 'utf8');
  const needle = '-H "Authorization: Bearer ${CF_API_TOKEN}"';
  if (!source.includes(needle)) fail('Unsupported Ferry Cloudflare authentication helper');
  writeFileSync(ferryPath, source.replace(needle, '-H "X-Auth-Email: ${CF_EMAIL}"\n        -H "X-Auth-Key: ${CF_GLOBAL_APIKEY}"'));
  chmodSync(ferryPath, 0o755);
  writeFileSync(join(runtime, '.env'), `TUNNEL_ID=${tunnel.id}\nTUNNEL_TOKEN=${tunnelToken}\nDOKKU_HOSTNAME=${cfg.DOKKU_HOSTNAME}\nCF_ACCOUNT_ID=${accountId}\nCF_API_TOKEN=global-key-compat\nCF_EMAIL=${cfg.CF_EMAIL}\nCF_GLOBAL_APIKEY=${cfg.CF_GLOBAL_APIKEY}\n`);

  try { output('docker', ['network', 'inspect', 'webserver']); } catch { run('docker', ['network', 'create', 'webserver']); }
  try { output('docker', ['volume', 'inspect', 'dokku-data']); } catch { run('docker', ['volume', 'create', 'dokku-data']); }
  run('docker', ['compose', '-f', join(runtime, 'docker-compose.yml'), 'up', '-d']);
  let ready = false;
  for (let i = 0; i < 90; i += 1) { try { output('docker', ['exec', 'dokku', 'dokku', 'version']); ready = true; break; } catch { await new Promise((done) => setTimeout(done, 2000)); } }
  if (!ready) fail('Dokku failed to start');
  try { run('docker', ['exec', 'dokku', 'dokku', 'network:set', '--global', 'attach-post-deploy', 'webserver']); } catch {}
  await cf('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: [{ service: 'http_status:404' }] } });

  const ferryEnv = { ...process.env, CF_ACCOUNT_ID: accountId, TUNNEL_ID: tunnel.id, TUNNEL_TOKEN: tunnelToken, CF_API_TOKEN: 'global-key-compat' };
  for (const app of apps) {
    prepareGitRepo(app.context, app.name);
    log(`Deploying ${app.name} at https://${app.host}`);
    run(ferryPath, ['deploy', app.name, '-H', app.host, '-p', String(app.port), '-d', app.context, '--no-push', '-y'], { cwd: runtime, env: ferryEnv });
    const tag = `ferry-ci/${app.name}:${process.env.GITHUB_SHA || 'latest'}`;
    run('docker', ['build', '--tag', tag, app.context]);
    try { run('docker', ['exec', 'dokku', 'dokku', 'network:set', app.name, 'attach-post-deploy', 'webserver']); } catch {}
    if (app.name === cfg.OMNIROUTE_APP) run('docker', ['exec', 'dokku', 'dokku', 'config:set', '--no-restart', app.name, `INITIAL_PASSWORD=${cfg.INITIAL_PASSWORD}`, 'HOSTNAME=0.0.0.0', `PORT=${app.port}`]);
    run('docker', ['exec', 'dokku', 'dokku', 'git:from-image', app.name, tag]);
  }

  const ingress = apps.map((app) => ({ hostname: app.host, service: 'http://dokku:80' }));
  ingress.push({ service: 'http_status:404' });
  await cf('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress } });
  run('docker', ['compose', '-f', join(runtime, 'docker-compose.yml'), 'restart', 'cloudflared']);
  for (const app of apps) await waitHttp(`https://${app.host}${app.health}`);
  log('All apps are publicly reachable');
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, apps.map((app) => `- https://${app.host}`).join('\n') + '\n', { flag: 'a' });
  const minutes = Number(cfg.KEEP_ALIVE_MINUTES || 350);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 350) fail('KEEP_ALIVE_MINUTES must be 1-350');
  await new Promise((done) => setTimeout(done, minutes * 60000));
}

main().catch((error) => { console.error(`\n[ferry] ${error.stack || error.message}`); process.exit(1); });
