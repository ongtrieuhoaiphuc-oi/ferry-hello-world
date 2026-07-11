import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const dir = process.env.FERRY_IMAGE_CACHE || '/tmp/ferry-image-cache';
const archive = `${dir}/runtime.tar.zst`;
mkdirSync(dir, { recursive: true });

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

if (existsSync(archive)) {
  const command = `zstd -dc ${JSON.stringify(archive)} | docker load`;
  const result = spawnSync('bash', ['-lc', command], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
} else {
  run('docker', ['pull', 'dokku/dokku:0.37.7']);
  run('docker', ['pull', 'cloudflare/cloudflared:latest']);
  const command = `docker save dokku/dokku:0.37.7 cloudflare/cloudflared:latest | zstd -T0 -3 -o ${JSON.stringify(archive)}`;
  const result = spawnSync('bash', ['-lc', command], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
