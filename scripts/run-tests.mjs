import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = fileURLToPath(new URL('../test/', import.meta.url));
const testFiles = readdirSync(testDirectory, { recursive: true })
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => join(testDirectory, file));

if (testFiles.length === 0) {
  console.error('No test files were found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...testFiles], {
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
