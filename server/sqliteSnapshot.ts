import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SNAPSHOT_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const sourcePath = process.argv[1];
const targetPath = process.argv[2];
let source;
let verification;
try {
  if (!fs.existsSync(sourcePath)) throw new Error('Source SQLite database does not exist.');
  if (fs.existsSync(targetPath)) throw new Error('Snapshot destination already exists.');
  source = new DatabaseSync(sourcePath);
  source.exec('PRAGMA busy_timeout = 30000');
  source.exec('PRAGMA cache_size = -4096');
  source.prepare('VACUUM INTO ?').run(targetPath);
  source.close();
  source = null;
  verification = new DatabaseSync(targetPath, { readOnly: true });
  const result = verification.prepare('PRAGMA quick_check').get();
  if (!result || result.quick_check !== 'ok') throw new Error('SQLite snapshot quick_check failed.');
  const required = ['transactions', 'ledger_audit', 'users', 'schema_migrations'];
  for (const name of required) {
    const row = verification.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!row) throw new Error('Snapshot is missing required table: ' + name);
  }
  verification.close();
  verification = null;
} catch (error) {
  try { source?.close(); } catch {}
  try { verification?.close(); } catch {}
  try { fs.rmSync(targetPath, { force: true }); } catch {}
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
}
`;

export function createSqliteSnapshot(sourcePath: string, destinationPath: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('SQLite snapshot was cancelled.'));
  if (fs.existsSync(destinationPath)) return Promise.reject(new Error('Snapshot destination already exists.'));
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', SNAPSHOT_WORKER, sourcePath, destinationPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new Error('SQLite snapshot was cancelled.'));
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `SQLite snapshot worker exited with ${code ?? exitSignal ?? 'an unknown status'}.`));
    });
  });
}
