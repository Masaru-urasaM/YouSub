import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const logsDir = path.resolve(process.cwd(), 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const logPath = path.join(logsDir, 'jest-latest.log');
const jsonPath = path.join(logsDir, 'jest-latest.json');
const extraArgs = process.argv.slice(2);

const jestArgs = [
  '--experimental-vm-modules',
  'node_modules/jest/bin/jest.js',
  '--json',
  `--outputFile=${jsonPath}`,
  ...extraArgs,
];

const startedAt = new Date().toISOString();
const chunks = [`=== YouSub Test Run (${startedAt}) ===\n`];

const child = spawn(process.execPath, jestArgs, {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});

child.stdout.on('data', (data) => {
  process.stdout.write(data);
  chunks.push(data.toString());
});

child.stderr.on('data', (data) => {
  process.stderr.write(data);
  chunks.push(data.toString());
});

child.on('close', (code) => {
  chunks.push(`\n=== Finished (${new Date().toISOString()}) exit=${code} ===\n`);
  fs.writeFileSync(logPath, chunks.join(''), 'utf8');
  console.log(`\n[test:log] Saved log: ${path.relative(process.cwd(), logPath)}`);
  console.log(`[test:log] Saved JSON: ${path.relative(process.cwd(), jsonPath)}`);
  process.exit(code ?? 1);
});
