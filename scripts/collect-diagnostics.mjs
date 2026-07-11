import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.GITHUB_WORKSPACE || process.cwd();
const logDir = process.env.FERRY_LOG_DIR || join(root, 'workflow-logs');
const systemDir = join(logDir, 'system');
const appMap = [
  ['hello', 'ferry-hello-world'],
  ['hello2', 'hello2'],
  ['omiroute', 'omiroute'],
];
mkdirSync(systemDir, { recursive: true });

function capture(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    return [error.stdout, error.stderr, `COMMAND FAILED (${error.status ?? 'unknown'}): ${command} ${args.join(' ')}`].filter(Boolean).join('\n');
  }
}

function sanitize(text) {
  return String(text)
    .replace(/(X-Auth-Key\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/(TUNNEL_TOKEN\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(CF_GLOBAL_APIKEY\s*=\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(INITIAL_PASSWORD\s*=\s*)\S+/gi, '$1[REDACTED]');
}

function save(path, value) {
  writeFileSync(path, sanitize(value || 'No output\n'));
}

const metadata = {
  generatedAt: new Date().toISOString(),
  repository: process.env.GITHUB_REPOSITORY,
  runId: process.env.GITHUB_RUN_ID,
  runNumber: process.env.GITHUB_RUN_NUMBER,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  sha: process.env.GITHUB_SHA,
  ref: process.env.GITHUB_REF,
  jobStatus: process.env.JOB_STATUS,
  outcomes: {
    checkout: process.env.CHECKOUT_OUTCOME,
    loadImages: process.env.LOAD_IMAGES_OUTCOME,
    deploy: process.env.DEPLOY_OUTCOME,
  },
  cache: {
    runtimeHit: process.env.RUNTIME_CACHE_HIT || 'false',
    applicationsHit: process.env.APP_CACHE_HIT || 'false',
  },
};
writeFileSync(join(logDir, 'result.json'), JSON.stringify(metadata, null, 2));

save(join(systemDir, 'docker-ps.txt'), capture('docker', ['ps', '-a', '--no-trunc']));
save(join(systemDir, 'docker-images.txt'), capture('docker', ['images', '--digests', '--no-trunc']));
save(join(systemDir, 'docker-networks.txt'), capture('docker', ['network', 'ls']));
save(join(systemDir, 'dokku-version.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'version']));
save(join(systemDir, 'dokku-apps.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'apps:list']));
save(join(systemDir, 'cloudflared.log'), capture('docker', ['logs', '--timestamps', '--tail', '1000', 'cloudflared']));
save(join(systemDir, 'dokku-container.log'), capture('docker', ['logs', '--timestamps', '--tail', '1000', 'dokku']));

for (const [folder, app] of appMap) {
  const dir = join(logDir, 'apps', folder);
  mkdirSync(dir, { recursive: true });
  save(join(dir, 'app.log'), capture('docker', ['exec', 'dokku', 'dokku', 'logs', app, '-n', '1000']));
  save(join(dir, 'ps-report.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'ps:report', app]));
  save(join(dir, 'domains-report.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'domains:report', app]));
  save(join(dir, 'ports-report.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'ports:report', app]));
  save(join(dir, 'network-report.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'network:report', app]));
  save(join(dir, 'checks-report.txt'), capture('docker', ['exec', 'dokku', 'dokku', 'checks:report', app]));
}

function sanitizeTree(directory) {
  if (!readdirSync(directory, { withFileTypes: true })) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sanitizeTree(path);
    else if (statSync(path).size <= 20 * 1024 * 1024) writeFileSync(path, sanitize(readFileSync(path, 'utf8')));
  }
}
sanitizeTree(logDir);

const index = [
  '# Ferry workflow logs',
  '',
  `Generated: ${metadata.generatedAt}`,
  `Result: ${metadata.jobStatus || metadata.outcomes.deploy || 'unknown'}`,
  '',
  '## Layout',
  '- `steps/`: complete command output by workflow step',
  '- `apps/<app>/`: container logs and Dokku reports per app',
  '- `system/`: Docker, Dokku, and cloudflared state',
  '- `events.jsonl`: timestamped machine-readable events',
  '- `result.json`: run metadata and step outcomes',
  '',
  'Sensitive credential patterns are redacted before upload.',
].join('\n');
writeFileSync(join(logDir, 'README.md'), index);
console.log(`Collected diagnostics in ${logDir}`);
