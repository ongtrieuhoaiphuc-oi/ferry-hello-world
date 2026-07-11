import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const root = process.env.GITHUB_WORKSPACE || resolve(import.meta.dirname, '..');
const stateDir = join(process.env.RUNNER_TEMP || tmpdir(), 'ferry-direct');
const composeFile = join(root, 'infra/docker-compose.yml');
const envFile = join(stateDir, '.env');
const log = (message) => console.log(`\n\x1b[36m[deploy]\x1b[0m ${message}`);
const fail = (message) => { throw new Error(message); };
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options }).trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
console.log(`::add-mask::${process.env.INITIAL_PASSWORD}`);

const cfg = process.env;
const apps = [
  { name: cfg.HELLO1_APP, host: cfg.HELLO1_HOSTNAME || `${cfg.HELLO1_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.HELLO1_PORT), memory: Number(cfg.HELLO1_MEMORY || 256), image: 'ferry-ci/ferry-hello-world:cached', health: '/health', marker: '"status":"ok"' },
  { name: cfg.HELLO2_APP, host: cfg.HELLO2_HOSTNAME || `${cfg.HELLO2_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.HELLO2_PORT), memory: Number(cfg.HELLO2_MEMORY || 256), image: 'ferry-ci/hello2:cached', health: '/health', marker: '"app":"hello2"' },
  { name: cfg.OMNIROUTE_APP, host: cfg.OMNIROUTE_HOSTNAME || `${cfg.OMNIROUTE_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.OMNIROUTE_PORT), memory: Number(cfg.OMNIROUTE_MEMORY || 1024), image: 'ferry-ci/omiroute:cached', health: '/api/monitoring/health' },
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
function dokku(args, options = {}) { return run('docker', ['exec', 'dokku', 'dokku', ...args], options); }
function dokkuOutput(args) { return output('docker', ['exec', 'dokku', 'dokku', ...args]); }
async function waitApp(app) {
  const url = `https://${app.host}${app.health}`;
  let last = 'no response';
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      last = `HTTP ${response.status}`;
      if (response.status >= 200 && response.status < 400 && (!app.marker || body.includes(app.marker))) return;
      if (response.status < 400) last += ' wrong app response';
    } catch (error) { last = error.name; }
    if (attempt % 12 === 0) log(`Waiting for ${url}: ${last}`);
    await sleep(5000);
  }
  fail(`${url} failed: ${last}`);
}

async function main() {
  mkdirSync(stateDir, { recursive: true });
  log('Resolving Cloudflare account and tunnel');
  const accounts = cfg.CF_ACCOUNT_ID ? [{ id: cfg.CF_ACCOUNT_ID }] : await cf('GET', '/accounts?per_page=50');
  const accountId = accounts[0]?.id || fail('No Cloudflare account found');
  const tunnels = await cf('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
  let tunnel = tunnels.find((item) => item.name === cfg.TUNNEL_NAME);
  if (!tunnel) tunnel = await cf('POST', `/accounts/${accountId}/cfd_tunnel`, { name: cfg.TUNNEL_NAME, tunnel_secret: output('openssl', ['rand', '-base64', '32']), config_src: 'cloudflare' });
  const tunnelToken = await cf('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);

  log('Reconciling DNS records in parallel');
  await Promise.all(apps.map(async (app) => {
    const zoneId = await resolveZone(app.host, accountId);
    const records = await cf('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(app.host)}&per_page=1`);
    const payload = { type: 'CNAME', name: app.host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1 };
    if (records[0]?.id) await cf('PUT', `/zones/${zoneId}/dns_records/${records[0].id}`, payload);
    else await cf('POST', `/zones/${zoneId}/dns_records`, payload);
  }));

  writeFileSync(envFile, `TUNNEL_TOKEN=${tunnelToken}\nDOKKU_HOSTNAME=${cfg.DOKKU_HOSTNAME}\n`, { mode: 0o600 });
  try { output('docker', ['network', 'inspect', 'webserver']); } catch { run('docker', ['network', 'create', 'webserver']); }
  try { output('docker', ['volume', 'inspect', 'dokku-data']); } catch { run('docker', ['volume', 'create', 'dokku-data']); }
  run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'up', '-d']);

  let ready = false;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try { dokkuOutput(['version']); ready = true; break; } catch { await sleep(2000); }
  }
  if (!ready) fail('Dokku failed to start');
  try { dokku(['network:set', '--global', 'attach-post-deploy', 'webserver']); } catch {}

  log('Configuring Dokku apps directly');
  const currentApps = new Set(dokkuOutput(['apps:list']).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[a-z0-9][a-z0-9-]*$/i.test(line)));
  for (const app of apps) {
    log(`Configuring ${app.name}`);
    if (!currentApps.has(app.name)) dokku(['apps:create', app.name]);
    dokku(['domains:set', app.name, app.host]);
    dokku(['ports:set', app.name, `http:80:${app.port}`]);
    dokku(['resource:limit', '--memory', String(app.memory), app.name]);
    dokku(['network:set', app.name, 'attach-post-deploy', 'webserver']);
  }
  dokku(['config:set', '--no-restart', cfg.OMNIROUTE_APP,
    `INITIAL_PASSWORD=${cfg.INITIAL_PASSWORD}`, 'HOSTNAME=0.0.0.0', `PORT=${cfg.OMNIROUTE_PORT}`,
    'OMNIROUTE_MEMORY_MB=768', 'NODE_OPTIONS=--max-old-space-size=768']);

  log('Releasing cached images sequentially');
  for (const app of apps) {
    log(`Releasing ${app.name}`);
    dokku(['git:from-image', app.name, app.image]);
  }

  log('Publishing one combined Cloudflare ingress configuration');
  const ingress = apps.map((app) => ({ hostname: app.host, service: 'http://dokku:80' }));
  ingress.push({ service: 'http_status:404' });
  await cf('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress } });
  run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'restart', 'cloudflared']);
  await Promise.all(apps.map(waitApp));

  log('All apps are publicly reachable');
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, apps.map((app) => `- https://${app.host}`).join('\n') + '\n', { flag: 'a' });
  const minutes = Number(cfg.KEEP_ALIVE_MINUTES || 350);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 350) fail('KEEP_ALIVE_MINUTES must be 1-350');
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) {
    await sleep(30000);
    await Promise.allSettled(apps.map((app) => fetch(`https://${app.host}${app.health}`, { signal: AbortSignal.timeout(10000) })));
  }
}

main().catch((error) => {
  console.error(`\n[deploy] ${error.stack || error.message}`);
  process.exit(1);
});
