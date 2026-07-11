import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const root = process.env.GITHUB_WORKSPACE || process.cwd();
const logDir = process.env.FERRY_LOG_DIR || join(root, 'workflow-logs');
const appDir = join(logDir, 'apps/omiroute');
const systemDir = join(logDir, 'system');
mkdirSync(appDir, { recursive: true }); mkdirSync(systemDir, { recursive: true });
function capture(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (error) { return [error.stdout, error.stderr, `FAILED: ${command} ${args.join(' ')}`].filter(Boolean).join('\n'); }
}
const sanitize = (text) => String(text).replace(/(TUNNEL_TOKEN|CF_GLOBAL_APIKEY|INITIAL_PASSWORD)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
const save = (path, value) => writeFileSync(path, sanitize(value || 'No output\n'));
save(join(systemDir, 'docker-ps.txt'), capture('docker', ['ps', '-a', '--no-trunc']));
save(join(systemDir, 'docker-images.txt'), capture('docker', ['images', '--digests']));
save(join(systemDir, 'cloudflared.log'), capture('docker', ['logs', '--timestamps', '--tail', '1000', 'cloudflared']));
save(join(systemDir, 'dokku.log'), capture('docker', ['logs', '--timestamps', '--tail', '1000', 'dokku']));
save(join(appDir, 'app.log'), capture('docker', ['exec', 'dokku', 'dokku', 'logs', 'omiroute', '-n', '1000']));
for (const [file, command] of [['ps-report.txt','ps:report'],['domains-report.txt','domains:report'],['ports-report.txt','ports:report'],['network-report.txt','network:report'],['checks-report.txt','checks:report']]) save(join(appDir, file), capture('docker', ['exec', 'dokku', 'dokku', command, 'omiroute']));
writeFileSync(join(logDir, 'result.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runId: process.env.GITHUB_RUN_ID, sha: process.env.GITHUB_SHA, status: process.env.JOB_STATUS, deploy: process.env.DEPLOY_OUTCOME, cache: { runtime: process.env.RUNTIME_CACHE_HIT, app: process.env.APP_CACHE_HIT } }, null, 2));
console.log(`Diagnostics collected: ${logDir}`);
