import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Dokku-free deploy: provision Cloudflare Tunnel + DNS, point remote ingress
// directly at Docker Compose service names, then bring the stack up.

const root = process.env.GITHUB_WORKSPACE || resolve(import.meta.dirname, '..');
const composeFile = join(root, 'docker-compose.yml');
const envFile = join(process.env.RUNNER_TEMP || '/tmp', 'ferry-compose.env');
const log = (message) => console.log(`\n\x1b[36m[edge]\x1b[0m ${message}`);
const fail = (message) => { throw new Error(message); };
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
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

const cfg = process.env;
cfg.OMNIROUTE_INITIAL_PASSWORD ||= randomBytes(24).toString('base64url');
console.log(`::add-mask::${cfg.OMNIROUTE_INITIAL_PASSWORD}`);

// DOKKU_HOSTNAME is kept as the base domain suffix for backwards-compatible secrets.
const apps = [
  { service: 'hello1', host: cfg.HELLO1_HOSTNAME || `${cfg.HELLO1_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.HELLO1_PORT || 3000), health: '/health', marker: '"status":"ok"' },
  { service: 'hello2', host: cfg.HELLO2_HOSTNAME || `${cfg.HELLO2_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.HELLO2_PORT || 3000), health: '/health', marker: '"app":"hello2"' },
  { service: 'omiroute', host: cfg.OMNIROUTE_HOSTNAME || `${cfg.OMNIROUTE_HOST_PREFIX}.${cfg.DOKKU_HOSTNAME}`, port: Number(cfg.OMNIROUTE_PORT || 20128), health: '/', marker: 'OmniRoute' },
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
async function waitApp(app) {
  const url = `https://${app.host}${app.health}`;
  let lastStatus = 'no response';
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      lastStatus = `HTTP ${response.status}`;
      const acceptableStatus = response.status >= 200 && response.status < 400;
      const acceptableBody = !app.marker || body.includes(app.marker);
      if (acceptableStatus && acceptableBody) return;
      if (acceptableStatus && !acceptableBody) lastStatus += ' wrong app response';
    } catch (error) { lastStatus = error.name; }
    if (attempt % 12 === 0) log(`Still waiting for ${url}: ${lastStatus}`);
    await sleep(5000);
  }
  fail(`${url} failed public health check: ${lastStatus}`);
}

async function main() {
  log('Resolving Cloudflare account and tunnel');
  const accounts = cfg.CF_ACCOUNT_ID ? [{ id: cfg.CF_ACCOUNT_ID }] : await cf('GET', '/accounts?per_page=50');
  const accountId = accounts[0]?.id || fail('No Cloudflare account found');
  const tunnels = await cf('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100`);
  let tunnel = tunnels.find((item) => item.name === cfg.TUNNEL_NAME);
  if (!tunnel) tunnel = await cf('POST', `/accounts/${accountId}/cfd_tunnel`, { name: cfg.TUNNEL_NAME, tunnel_secret: execFileSync('openssl', ['rand', '-base64', '32'], { encoding: 'utf8' }).trim(), config_src: 'cloudflare' });
  const tunnelToken = await cf('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);

  log('Upserting DNS records');
  await Promise.all(apps.map(async (app) => {
    const zoneId = await resolveZone(app.host, accountId);
    const records = await cf('GET', `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(app.host)}&per_page=1`);
    const payload = { type: 'CNAME', name: app.host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1 };
    if (records[0]?.id) await cf('PUT', `/zones/${zoneId}/dns_records/${records[0].id}`, payload);
    else await cf('POST', `/zones/${zoneId}/dns_records`, payload);
  }));

  log('Publishing tunnel ingress straight to compose services');
  const ingress = apps.map((app) => ({ hostname: app.host, service: `http://${app.service}:${app.port}` }));
  ingress.push({ service: 'http_status:404' });
  await cf('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress } });

  log('Starting edge stack with Docker Compose');
  writeFileSync(envFile, `TUNNEL_TOKEN=${tunnelToken}\nOMNIROUTE_INITIAL_PASSWORD=${cfg.OMNIROUTE_INITIAL_PASSWORD}\n`);
  run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'up', '-d', '--remove-orphans']);

  log('Waiting for public health checks');
  await Promise.all(apps.map((app) => waitApp(app)));
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
  console.error(`\n[edge] ${error.stack || error.message}`);
  process.exit(1);
});
