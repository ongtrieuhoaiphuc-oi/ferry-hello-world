import { mkdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = process.env.GITHUB_WORKSPACE || resolve(import.meta.dirname, '..');
const runtimeDir = process.env.FERRY_RUNTIME_CACHE || '/tmp/ferry-runtime-cache';
const appDir = process.env.FERRY_APP_CACHE || '/tmp/ferry-app-cache';
const runtimeArchive = join(runtimeDir, 'runtime.tar.zst');
const appArchive = join(appDir, 'apps.tar.zst');
const runtimeImages = ['cloudflare/cloudflared:latest'];
const apps = [
  { tag: 'ferry-ci/ferry-hello-world:cached', context: root },
  { tag: 'ferry-ci/hello2:cached', context: join(root, 'apps/hello2') },
  { tag: 'ferry-ci/omiroute:cached', context: join(root, 'apps/omiroute') },
];

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(appDir, { recursive: true });

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

function pipeline(commandA, argsA, commandB, argsB) {
  return new Promise((resolvePromise, reject) => {
    const first = spawn(commandA, argsA, { stdio: ['ignore', 'pipe', 'inherit'] });
    const second = spawn(commandB, argsB, { stdio: ['pipe', 'inherit', 'inherit'] });
    first.stdout.pipe(second.stdin);
    let firstCode;
    let secondCode;
    const finish = () => {
      if (firstCode === undefined || secondCode === undefined) return;
      if (firstCode === 0 && secondCode === 0) resolvePromise();
      else reject(new Error(`Pipeline failed: ${commandA}=${firstCode}, ${commandB}=${secondCode}`));
    };
    first.on('error', reject);
    second.on('error', reject);
    first.on('close', (code) => { firstCode = code; finish(); });
    second.on('close', (code) => { secondCode = code; finish(); });
  });
}

function runAsync(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function loadArchive(archive) {
  await pipeline('zstd', ['-dc', archive], 'docker', ['load']);
}

async function saveArchive(images, archive) {
  await pipeline('docker', ['save', ...images], 'zstd', ['-T0', '-3', '-o', archive]);
}

async function prepareRuntime() {
  if (existsSync(runtimeArchive)) {
    console.log('[cache] Loading runtime images');
    await loadArchive(runtimeArchive);
    return;
  }
  console.log('[cache] Pulling runtime images');
  for (const image of runtimeImages) run('docker', ['pull', image]);
  await saveArchive(runtimeImages, runtimeArchive);
}

async function prepareApps() {
  if (existsSync(appArchive)) {
    console.log('[cache] Loading application images');
    await loadArchive(appArchive);
    return;
  }
  console.log('[build] Building all application images in parallel');
  await Promise.all(apps.map((app) => runAsync('docker', ['build', '--tag', app.tag, app.context])));
  await saveArchive(apps.map((app) => app.tag), appArchive);
}

await Promise.all([prepareRuntime(), prepareApps()]);
console.log('[cache] Runtime and application images are ready');
