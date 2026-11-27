import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { validateTransactionInput } from '../server/validation';
import { createSqliteSnapshot } from '../server/sqliteSnapshot';

const dataDir = process.env.PACE_DATA_DIR ? path.resolve(process.env.PACE_DATA_DIR) : '';
const dbFile = dataDir ? path.join(dataDir, 'pace_it_ledger.sqlite') : '';
if (process.env.PACE_LOAD_TEST !== '1' || !dataDir) {
  throw new Error('Safety check: set PACE_LOAD_TEST=1 and PACE_DATA_DIR to a dedicated, empty test directory.');
}
if (fs.existsSync(dbFile)) {
  throw new Error(`Safety check: ${dbFile} already exists. The load test refuses to modify an existing database.`);
}
fs.mkdirSync(dataDir, { recursive: true });
if (fs.readdirSync(dataDir).length > 0) {
  throw new Error(`Safety check: ${dataDir} must be empty before the load test starts.`);
}

const { db, SQLITE_DATABASE_FILE } = await import('../server/db');
await db.ready();
const targetCounts = (process.env.PACE_LOAD_TEST_COUNTS || '10000,100000,300000,500000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 500_000);
if (!targetCounts.length) throw new Error('PACE_LOAD_TEST_COUNTS must contain at least one positive count up to 500000.');
const milestones = Array.from(new Set(targetCounts)).sort((a, b) => a - b);

const admin = db.bootstrapFirstAdmin({
  username: 'load_test_admin',
  displayName: 'Load Test Admin',
  password: 'LedgerLoadTest#2026',
  loadSampleData: false,
});
const fundSource = db.getFundSources().find((source) => source.active);
const department = db.getDepartments().find((item) => item.active)?.name || 'ALHAMRA-OFFICE';
const incomeHead = db.getHeads().find((item) => item.active && item.kind === 'income')?.name || 'OTHER-INCOME';
const expenseHead = db.getHeads().find((item) => item.active && item.kind === 'expense')?.name || 'OTHERS-COMPANY';
if (!fundSource) throw new Error('No active fund source was seeded in the isolated test database.');

const raw = (db as any).sqlite.raw;
const insert = raw.prepare(`
  INSERT INTO transactions (
    id, voucher_no, kind, tx_date, amount_paisa, department, department_review,
    head, sub_category, payment_method, reference_no, counterparty,
    counterparty_phone, purpose, notes, employee_id, employee_name,
    category_group, fund_source_id, status, edit_count, amount_changed,
    last_edit_reason, created_at, created_by_id, created_by_name, updated_at, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const departments = [department, 'BALUCHOR-OFFICE', 'SHIBGONJ-OFFICE', 'EDC-PROJECT', 'UPSTREAM'];
const methods = ['Cash in Hand', 'BRAC Bank ATM', 'BRAC Bank Transfer', 'Bank Cheque', 'bKash / Nagad'];
const purposes = ['Network equipment purchase', 'Office utilities', 'Vendor settlement', 'Branch operating cost', 'Company fund receipt'];
const dates = Array.from({ length: 1460 }, (_, index) => new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10));
const started = performance.now();
const syntheticInsertStarted = performance.now();
const syntheticInsertCpuStarted = process.cpuUsage();
let nextProgressRows = 50_000;
let inserted = 0;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] || 0;
}

function measure<T>(run: () => T, repetitions = 20): {
  averageMs: number; medianMs: number; p95Ms: number; p99Ms: number;
  throughputPerSec: number; samples: number; value: T; cpuMs: number;
} {
  let value!: T;
  const samples: number[] = [];
  const cpuBefore = process.cpuUsage();
  const at = performance.now();
  for (let i = 0; i < repetitions; i += 1) {
    const sampleAt = performance.now();
    value = run();
    samples.push(performance.now() - sampleAt);
  }
  const elapsed = performance.now() - at;
  const cpu = process.cpuUsage(cpuBefore);
  const averageMs = elapsed / repetitions;
  return {
    averageMs: Number(averageMs.toFixed(2)),
    medianMs: Number(percentile(samples, 0.50).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(2)),
    throughputPerSec: Number((repetitions / Math.max(elapsed / 1000, 0.001)).toFixed(2)),
    samples: repetitions,
    value,
    cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
  };
}

function fileBytes(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

async function testConcurrentAuditedWriters() {
  const workerScript = fileURLToPath(new URL('./concurrent-audit-worker.ts', import.meta.url));
  const workers = Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, workerScript], {
      env: { ...process.env, WORKER_ID: String(index + 1) },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Audited application writer ${index + 1} exited with code ${code}.`)));
  }));
  const start = performance.now();
  await Promise.all(workers);
  return Number((performance.now() - start).toFixed(2));
}

const adminTxInput = (amount: string, reason?: string) => validateTransactionInput({
  kind: 'income',
  txDate: '2026-11-26',
  amount,
  department,
  head: incomeHead,
  subCategory: 'Load Test Income',
  paymentMethod: 'Cash in Hand',
  referenceNo: 'LOAD-WRITE-CHECK',
  counterparty: 'Synthetic write benchmark',
  purpose: 'Create / edit / void verification',
  fundSourceId: fundSource.id,
  ...(reason ? { reason } : {}),
}, Boolean(reason));

const createStart = performance.now();
const written = db.createTransaction(adminTxInput('1.00'), admin);
const createdMs = performance.now() - createStart;
const editStart = performance.now();
db.editTransaction(written.id, adminTxInput('1.25', 'Load-test amount adjustment'), admin);
const editedMs = performance.now() - editStart;
const deleteStart = performance.now();
db.softDeleteTransaction(written.id, 'Load test cleanup', admin);
const deletedMs = performance.now() - deleteStart;
const auditBeforeSynthetic = db.verifyAuditChain();
if (!auditBeforeSynthetic.ok) throw new Error('Audit-chain verification failed before synthetic load data was added.');

const concurrentIncomeBefore = Number(raw.prepare(`
  SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM transactions
  WHERE deleted_at = '' AND fund_source_id = ? AND kind = 'income'
`).get(fundSource.id).total);
const concurrentMs = await testConcurrentAuditedWriters();
const concurrentResult = raw.prepare(`
  SELECT COUNT(*) AS rows, COALESCE(SUM(amount_paisa), 0) AS total
  FROM transactions
  WHERE deleted_at = '' AND fund_source_id = ? AND kind = 'income'
    AND reference_no LIKE 'LOAD-CONCURRENT-%'
`).get(fundSource.id) as any;
if (Number(concurrentResult.rows) !== 20 || Number(concurrentResult.total) !== 2_500) {
  throw new Error(`Concurrent writes were not fully committed: rows=${concurrentResult.rows}, amountPaisa=${concurrentResult.total}.`);
}
const concurrentIncomeAfter = Number(raw.prepare(`
  SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM transactions
  WHERE deleted_at = '' AND fund_source_id = ? AND kind = 'income'
`).get(fundSource.id).total);
if (concurrentIncomeAfter - concurrentIncomeBefore !== 2_500) {
  throw new Error('Concurrent income writes did not reconcile to the expected integer-paisa balance delta.');
}
const concurrentAudit = db.verifyAuditChain();
if (!concurrentAudit.ok) {
  const failures = { brokenLinks: concurrentAudit.brokenLinks, stateMismatches: concurrentAudit.stateMismatches };
  throw new Error(`Audit chain failed after concurrent application writes: ${JSON.stringify(failures)}`);
}
console.log(JSON.stringify({
  phase: 'Concurrent audited application writers', workers: 4, transactions: Number(concurrentResult.rows),
  amountPaisa: Number(concurrentResult.total), elapsedMs: concurrentMs,
  auditChain: { ok: concurrentAudit.ok, totalEntries: concurrentAudit.totalEntries },
}, null, 2));



// Seed real employee rows so employee summaries exercise the same join and result
// mapping used by the application, rather than grouping only orphaned test IDs.
const employeeInsert = raw.prepare(`
  INSERT INTO employees (id, code, name, role, department, branch, phone, email,
    photo_url, monthly_salary_paisa, joined_date, active, notes, created_at, updated_at)
  VALUES (?, ?, ?, 'Staff', ?, ?, '', '', '', 0, '2023-01-01', 1, 'Synthetic load-test employee', ?, ?)
`);
const loadEmployeeIds = Array.from({ length: 25 }, (_, index) => `LOAD-EMP-${index}`);
const employeeSeedAt = new Date().toISOString();
for (let index = 0; index < loadEmployeeIds.length; index += 1) {
  const employeeId = loadEmployeeIds[index];
  employeeInsert.run(
    employeeId, `LOAD-${String(index + 1).padStart(3, '0')}`, `Load Employee ${index}`,
    department, departments[index % departments.length], employeeSeedAt, employeeSeedAt,
  );
}

console.log(JSON.stringify({
  phase: 'CRUD and audit baseline',
  createMs: Number(createdMs.toFixed(2)),
  editMs: Number(editedMs.toFixed(2)),
  softDeleteMs: Number(deletedMs.toFixed(2)),
  auditChain: { ok: auditBeforeSynthetic.ok, entries: auditBeforeSynthetic.totalEntries },
}, null, 2));

for (const target of milestones) {
  while (inserted < target) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const stop = Math.min(target, inserted + 500);
      for (; inserted < stop; inserted += 1) {
        const date = dates[(inserted * 37) % dates.length];
        const kind = inserted % 5 === 0 ? 'income' : 'expense';
        const deleted = inserted % 97 === 0;
        const second = inserted % 86_400;
        const createdAt = `${date}T${String(Math.floor(second / 3600)).padStart(2, '0')}:${String(Math.floor((second % 3600) / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;
        const n = String(inserted).padStart(7, '0');
        insert.run(
          `load-${n}`, `LOAD-${n}`, kind, date, 2500 + (inserted % 300_000),
          departments[inserted % departments.length], inserted % 251 === 0 ? 1 : 0,
          kind === 'income' ? incomeHead : expenseHead,
          purposes[inserted % purposes.length], methods[inserted % methods.length],
          `LOAD-REF-${n}`, `Vendor ${inserted % 800}`, '',
          `Purpose ${inserted % 200}`,
          inserted % 1000 === 1 ? 'LEDGER_LOADTEST_SEARCH' : `Notes ${inserted % 500}`,
          `LOAD-EMP-${inserted % 25}`, `Load Employee ${inserted % 25}`,
          'general', '', inserted % 997 === 0 ? 'flagged' : 'verified',
          inserted % 41 === 0 ? 1 : 0, inserted % 223 === 0 ? 1 : 0,
          '', createdAt, admin.id, admin.displayName, createdAt, deleted ? createdAt : '',
        );
      }
      raw.exec('COMMIT');
      while (inserted >= nextProgressRows) {
        const elapsedMs = performance.now() - syntheticInsertStarted;
        const cpu = process.cpuUsage(syntheticInsertCpuStarted);
        const memory = process.memoryUsage();
        console.log(JSON.stringify({
          phase: 'Synthetic dataset insertion progress', rows: inserted, elapsedMs: Number(elapsedMs.toFixed(2)),
          rowsPerSecond: Number((inserted / Math.max(elapsedMs / 1000, 0.001)).toFixed(1)),
          cpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(2)),
          rssMb: Number((memory.rss / 1024 / 1024).toFixed(1)), heapMb: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
        }));
        nextProgressRows += 50_000;
      }
    } catch (error) {
      try { raw.exec('ROLLBACK'); } catch { }
      throw error;
    }
  }

  const pageOne = db.getTransactionsPage({ limit: 50 });
  const filterSample = pageOne.items[0];
  const defaultPage = measure(() => db.getTransactionsPage({ limit: 50 }));
  const cursorPage = measure(() => db.getTransactionsPage({ limit: 50, cursor: pageOne.nextCursor || undefined }));
  const datePage = measure(() => db.getTransactionsPage({ limit: 50, from: '2026-01-01', to: '2026-11-26', kind: 'expense' }));
  const combinedPage = measure(() => db.getTransactionsPage({
    limit: 50, from: filterSample.txDate, to: filterSample.txDate, kind: filterSample.kind,
    employeeId: filterSample.employeeId, department: filterSample.department,
    paymentMethod: filterSample.paymentMethod, head: filterSample.head,
  }));
  const headPage = measure(() => db.getTransactionsPage({ limit: 50, head: expenseHead }));
  const searchPage = measure(() => db.getTransactionsPage({ limit: 50, search: 'LEDGER_LOADTEST_SEARCH' }));
  const summary = measure(() => db.getPeriodSummary('2026-01-01', '2026-11-26', 'Load test range'));
  const dailySummary = measure(() => db.getPeriodSummary('2026-11-26', '2026-11-26', 'Daily load test'));
  const employeeStats = measure(() => db.getEmployeeSpendStats('2026-01-01', '2026-11-26'));
  const pageTwo = db.getTransactionsPage({ limit: 50, cursor: pageOne.nextCursor || undefined });
  const pageIds = new Set(pageOne.items.map((item) => item.id));
  const duplicateAcrossPages = pageTwo.items.some((item) => pageIds.has(item.id));
  const crudStarted = performance.now();
  const crudRecord = db.createTransaction(adminTxInput('1.00'), admin);
  const crudCreatedMs = performance.now() - crudStarted;
  const crudEditStarted = performance.now();
  db.editTransaction(crudRecord.id, adminTxInput('1.25', `Load-test update at ${target}`), admin);
  const crudEditedMs = performance.now() - crudEditStarted;
  const crudDeleteStarted = performance.now();
  db.softDeleteTransaction(crudRecord.id, `Load-test cleanup at ${target}`, admin);
  const crudDeletedMs = performance.now() - crudDeleteStarted;
  const explain = {
    activePage: raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT t.* FROM transactions t INDEXED BY idx_tx_active_date_created_id
      WHERE t.deleted_at = ''
      ORDER BY t.tx_date DESC, t.created_at DESC, t.id DESC LIMIT 51
    `).all().map((row: any) => String(row.detail)),
    employeePage: raw.prepare(`
      EXPLAIN QUERY PLAN SELECT t.id FROM transactions t INDEXED BY idx_tx_active_employee_date
      WHERE t.deleted_at = '' AND t.employee_id = ?
      ORDER BY t.tx_date DESC, t.created_at DESC, t.id DESC LIMIT 51
    `).all('LOAD-EMP-5').map((row: any) => String(row.detail)),
    auditSequence: raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM ledger_audit ORDER BY seq ASC')
      .all().map((row: any) => String(row.detail)),
  };
  const memory = process.memoryUsage();
  const dbBytes = fileBytes(dbFile) + fileBytes(`${dbFile}-wal`) + fileBytes(`${dbFile}-shm`);

  const timingSummary = (sample: ReturnType<typeof measure>) => ({
    averageMs: sample.averageMs,
    medianMs: sample.medianMs,
    p95Ms: sample.p95Ms,
    p99Ms: sample.p99Ms,
    throughputPerSec: sample.throughputPerSec,
    samples: sample.samples,
    cpuMs: sample.cpuMs,
  });
  console.log(JSON.stringify({
    transactions: target,
    insertedRows: inserted,
    elapsedSinceStartSec: Number(((performance.now() - started) / 1000).toFixed(2)),
    timings: {
      firstPage: timingSummary(defaultPage),
      cursorPage: timingSummary(cursorPage),
      dateFilteredPage: timingSummary(datePage),
      combinedFilterPage: timingSummary(combinedPage),
      headFilteredPage: timingSummary(headPage),
      substringSearchPage: timingSummary(searchPage),
      periodSummary: timingSummary(summary),
      dailyLedgerSummary: timingSummary(dailySummary),
      employeeStats: timingSummary(employeeStats),
    },
    resultCounts: {
      firstPageItems: defaultPage.value.items.length,
      dateFilteredRows: datePage.value.totalCount,
      combinedFilterRows: combinedPage.value.totalCount,
      headFilteredRows: headPage.value.totalCount,
      searchMatches: searchPage.value.totalCount,
      periodTransactions: summary.value.periodTransactionCount,
      employeeStatsRows: employeeStats.value.length,
    },
    pagination: { firstPage: pageOne.items.length, secondPage: pageTwo.items.length, duplicateAcrossPages },
    crudAtDatasetSize: {
      createMs: Number(crudCreatedMs.toFixed(2)),
      editMs: Number(crudEditedMs.toFixed(2)),
      softDeleteMs: Number(crudDeletedMs.toFixed(2)),
    },
    queryPlan: explain,
    memoryMb: { rss: Number((memory.rss / 1024 / 1024).toFixed(1)), heapUsed: Number((memory.heapUsed / 1024 / 1024).toFixed(1)) },
    databaseMbIncludingWal: Number((dbBytes / 1024 / 1024).toFixed(1)),
    cpuMsForRepeatedQueries: {
      page: defaultPage.cpuMs,
      datePage: datePage.cpuMs,
      headPage: headPage.cpuMs,
      search: searchPage.cpuMs,
      summary: summary.cpuMs,
      employeeStats: employeeStats.cpuMs,
    },
  }, null, 2));
}


const backupStarted = performance.now();
let backupBytes = 0;
let backupChunks = 0;
for await (const chunk of db.streamFullBackupJson()) {
  backupBytes += Buffer.byteLength(chunk);
  backupChunks += 1;
}
console.log(JSON.stringify({
  phase: 'Streaming backup',
  elapsedMs: Number((performance.now() - backupStarted).toFixed(2)),
  jsonBytes: backupBytes,
  chunks: backupChunks,
}, null, 2));

// Large exports are measured in a separate process (`npm run load-test:exports`).
// Keeping them out of the CRUD benchmark avoids cross-phase page-cache and memory
// pressure, and makes export throughput reproducible against the completed dataset.
console.log(JSON.stringify({
  phase: 'Streaming exports deferred to isolated export benchmark',
  command: 'npm run load-test:exports',
  dataDir,
}, null, 2));

const sqliteSnapshotPath = path.join(dataDir, 'load-test-snapshot.sqlite');
const sqliteBackupStarted = performance.now();
await createSqliteSnapshot(SQLITE_DATABASE_FILE, sqliteSnapshotPath);
const sqliteBackupElapsedMs = performance.now() - sqliteBackupStarted;
console.log(JSON.stringify({ phase: 'SQLite snapshot created', elapsedMs: Number(sqliteBackupElapsedMs.toFixed(2)) }));
const sqliteSnapshotDb = new DatabaseSync(sqliteSnapshotPath, { readOnly: true });
const sqliteSnapshotCheckRow = sqliteSnapshotDb.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
const sqliteSnapshotCheck = sqliteSnapshotCheckRow?.quick_check ?? 'no result';
const sqliteSnapshotCountRow = sqliteSnapshotDb.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n?: number } | undefined;
const sqliteSnapshotTransactions = Number(sqliteSnapshotCountRow?.n ?? 0);
sqliteSnapshotDb.close();
if (sqliteSnapshotCheck !== 'ok') throw new Error(`Snapshot database quick_check failed: ${sqliteSnapshotCheck}`);
console.log(JSON.stringify({
  phase: 'SQLite snapshot backup',
  elapsedMs: Number(sqliteBackupElapsedMs.toFixed(2)),
  snapshotBytes: fileBytes(sqliteSnapshotPath),
  transactionCount: sqliteSnapshotTransactions,
  quickCheck: sqliteSnapshotCheck,
}, null, 2));

// Reopen after the multi-process writer test so the integrity scan observes the
// latest committed WAL state rather than a page cache held by the original handle.
const integrityDb = new DatabaseSync(dbFile);
integrityDb.exec('PRAGMA busy_timeout = 5000');
const integrityRow = integrityDb.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
const integrity = integrityRow?.quick_check ?? 'no result';
if (integrity !== 'ok') throw new Error(`SQLite quick_check failed: ${integrity}`);
integrityDb.prepare("INSERT INTO transactions_fts(transactions_fts, rank) VALUES ('integrity-check', 1)").run();
integrityDb.close();
console.log(JSON.stringify({
  phase: 'Final database integrity',
  quickCheck: integrity,
  ftsExternalContentIntegrity: 'ok',
  auditChainNote: 'The audit chain was verified before synthetic rows were inserted. Synthetic load rows intentionally bypass app audit creation; this disposable test database must not be used as production data.',
}, null, 2));
