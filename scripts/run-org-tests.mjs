/**
 * Runs the live-org contract suite.
 *
 *   npm run test:org
 *   npm run test:org -- --target-org nsorg
 *
 * A thin wrapper for one reason: vitest rejects CLI flags it does not know, so
 * `--target-org` cannot be passed straight through. This lifts it into an
 * environment variable and hands vitest only the arguments it understands.
 * Anything else on the command line is forwarded, so `--reporter=verbose` and
 * friends still work.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const passThrough = [];
let target;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--target-org' || arg === '-o') {
    target = args[index + 1];
    index += 1;
  } else if (arg.startsWith('--target-org=')) {
    target = arg.slice('--target-org='.length);
  } else {
    passThrough.push(arg);
  }
}

if (target !== undefined && target.length === 0) {
  process.stderr.write('--target-org needs an alias, e.g. `npm run test:org -- --target-org nsorg`\n');
  process.exit(2);
}

const child = spawn(
  process.execPath,
  [
    resolve(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'vitest.org.config.ts',
    ...passThrough,
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: target === undefined ? process.env : { ...process.env, SFRL_TARGET_ORG: target },
  },
);

child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 1));
});
