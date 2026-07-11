import { mkdirSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = process.env.GITHUB_WORKSPACE || resolve(import.meta.dirname, '..');
const runtimeDir = process.env.FERRY_RUNTIME_CACHE || '/tmp/ferry-runtime-cache';
const appDir = process.env.FERRY_APP_CACHE || '/tmp/omniroute-app-cache';
const runtimeArchive = join(runtimeDir, 'runtime.tar.zst');
const appArchive = join(appDir, 'omniroute.tar.zst');
const runtimeImages = ['dokku/dokku:0.37.7', 'cloudflare/cloudflared:latest'];
const appImage = 'omniroute-ci:cached';
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(appDir, { recursive: true });

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
function pipe(commandA, argsA, commandB, argsB) {
  return new Promise((resolvePromise, reject) => {
    const a = spawn(commandA, argsA, { stdio: ['ignore', 'pipe', 'inherit'] });
    const b = spawn(commandB, argsB, { stdio: ['pipe', 'inherit', 'inherit'] });
    a.stdout.pipe(b.stdin);
    let ac; let bc;
    const done = () => ac !== undefined && bc !== undefined && (ac === 0 && bc === 0 ? resolvePromise() : reject(new Error(`pipeline failed: ${ac}/${bc}`)));
    a.on('error', reject); b.on('error', reject);
    a.on('close', (code) => { ac = code; done(); }); b.on('close', (code) => { bc = code; done(); });
  });
}
const load = (file) => pipe('zstd', ['-dc', file], 'docker', ['load']);
const save = (images, file) => pipe('docker', ['save', ...images], 'zstd', ['-T0', '-3', '-o', file]);

await Promise.all([
  (async () => {
    if (existsSync(runtimeArchive)) return load(runtimeArchive);
    for (const image of runtimeImages) run('docker', ['pull', image]);
    return save(runtimeImages, runtimeArchive);
  })(),
  (async () => {
    if (existsSync(appArchive)) return load(appArchive);
    run('docker', ['build', '--tag', appImage, join(root, 'apps/omiroute')]);
    return save([appImage], appArchive);
  })(),
]);
console.log('OmniRoute and runtime images ready');
