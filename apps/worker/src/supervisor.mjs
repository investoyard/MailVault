// Keeps the MailVault worker running (started by `npm run start:worker`, i.e. the MailVault-Worker task).
//   exit code 75  -> restart requested from the admin panel: start a fresh copy straight away (re-reads .env)
//   other failure -> crash: start again after a short pause (longer if it keeps crashing)
//   exit code 0   -> normal shutdown (Ctrl+C / task stopped): stop too
// Plain JavaScript on purpose, so it needs no TypeScript loader itself.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTART_EXIT_CODE = 75; // keep in sync with apps/worker/src/index.ts

const here = dirname(fileURLToPath(import.meta.url));
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
const entry = resolve(here, 'index.ts');

const say = (msg) => console.log(JSON.stringify({ level: 30, time: Date.now(), service: 'mailvault-supervisor', msg }));

let child = null;
let stopping = false;
let quickCrashes = 0;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [tsxCli, entry], {
    cwd: resolve(here, '..'),
    stdio: 'inherit',
    env: { ...process.env, MAILVAULT_SUPERVISED: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(0);
    if (code === RESTART_EXIT_CODE) {
      say('worker restart requested: starting a fresh copy');
      quickCrashes = 0;
      return start();
    }
    if (code === 0 && !signal) {
      say('worker stopped');
      process.exit(0);
    }
    quickCrashes = Date.now() - startedAt < 60_000 ? quickCrashes + 1 : 0;
    const delay = Math.min(5_000 * 2 ** Math.max(0, quickCrashes - 1), 5 * 60_000);
    say(`worker exited (code ${code ?? signal}); starting again in ${Math.round(delay / 1000)} s`);
    setTimeout(start, delay);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

start();
