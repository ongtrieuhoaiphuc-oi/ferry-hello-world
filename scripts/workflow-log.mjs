import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [type = 'event', state = 'info', ...parts] = process.argv.slice(2);
const message = parts.join(' ') || state;
const logDir = process.env.FERRY_LOG_DIR || join(process.cwd(), 'workflow-logs');
mkdirSync(logDir, { recursive: true });
const entry = {
  timestamp: new Date().toISOString(),
  type,
  state,
  message,
  runId: process.env.GITHUB_RUN_ID || null,
  runNumber: process.env.GITHUB_RUN_NUMBER || null,
  sha: process.env.GITHUB_SHA || null,
};
appendFileSync(join(logDir, 'events.jsonl'), `${JSON.stringify(entry)}\n`);
console.log(`[${entry.timestamp}] ${type}:${state} ${message}`);
