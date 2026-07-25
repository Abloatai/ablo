/**
 * Run the Docker-backed SDK E2E suite without letting teardown overwrite the
 * test result. Containers are always torn down; a Jest failure remains the
 * process exit code even when teardown also fails.
 */
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const testArgs = process.argv.slice(2);

/** @param {string} script @param {readonly string[]} [args] */
function runScript(script, args = []) {
  const commandArgs = ['run', script];
  if (args.length > 0) commandArgs.push('--', ...args);

  return new Promise((resolve) => {
    const child = spawn(npm, commandArgs, { stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(`[test:e2e:run] could not start ${script}:`, error);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        console.error(`[test:e2e:run] ${script} terminated by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

let result = 1;
try {
  const bootResult = await runScript('test:e2e:up');
  result = bootResult === 0 ? await runScript('test:e2e', testArgs) : bootResult;
} finally {
  const teardownResult = await runScript('test:e2e:down');
  if (result === 0 && teardownResult !== 0) result = teardownResult;
  else if (result !== 0 && teardownResult !== 0) {
    console.error(
      `[test:e2e:run] teardown also failed (${String(teardownResult)}); ` +
        `preserving test exit code ${String(result)}`,
    );
  }
}

process.exitCode = result;
