import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ledger-scale-test-'));
process.env.PACE_DATA_DIR = TMP_DIR;

const { db } = await import('../server/db');

test.after(async () => {
  // Release the SQLite database lock before removing the test directory.
  // This is required on Windows, where open database files cannot be unlinked.
  await db.ready();
  const raw = (db as any).sqlite?.raw;
  if (raw) {
    try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
    try { raw.close(); } catch { /* best effort */ }
  }
  fs.rmSync(TMP_DIR, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
});

test('keyset pagination, SQL summaries, substring search, and active/deleted filtering', async () => {
  await db.ready();
  const raw = (db as any).sqlite.raw;
  const insert = raw.prepare(`
    INSERT INTO transactions (
      id, voucher_no, kind, tx_date, amount_paisa, department, head, sub_category,
      payment_method, reference_no, counterparty, purpose, notes, employee_id,
      employee_name, created_at, created_by_id, created_by_name, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const timestamp = '2026-10-01T12:00:00.000Z';
  for (let i = 0; i < 120; i += 1) {
    const n = String(i).padStart(4, '0');
    const kind = i % 3 === 0 ? 'income' : 'expense';
    const txDate = `2026-10-${String(1 + (i % 10)).padStart(2, '0')}`;
    const isDeleted = i % 19 === 0;
    insert.run(
      `scale-${n}`, `SCALE-${n}`, kind, txDate, 1000 + i,
      'ALHAMRA-OFFICE', kind === 'income' ? 'OTHER-INCOME' : 'OTHERS-COMPANY',
      kind === 'income' ? 'Test receipt' : 'Test expense', 'Cash in Hand', `REF-${n}`,
      `Counterparty ${i % 8}`, 'Scalability test entry',
      i % 7 === 0 ? 'SEARCHABLELEDGERPHRASE' : 'Routine note',
      `scale-employee-${i % 5}`, `Test Employee ${i % 5}`,
      timestamp, 'scale-test-user', 'Scale Test', timestamp, isDeleted ? timestamp : '',
    );
  }

  const activeCount = Number(raw.prepare("SELECT COUNT(*) AS n FROM transactions WHERE deleted_at = ''").get().n);
  const first = db.getTransactionsPage({ limit: 17 });
  const second = db.getTransactionsPage({ limit: 17, cursor: first.nextCursor || undefined });
  assert.equal(first.items.length, 17);
  assert.equal(first.totalCount, activeCount);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 17);
  assert.equal(second.totalCount, activeCount);
  assert.equal(second.items.some((item: any) => first.items.some((prior: any) => prior.id === item.id)), false);
  assert.throws(() => db.getTransactionsPage({ limit: 17, cursor: 'not-a-valid-cursor' }), /cursor/i);

  const oldest = db.getTransactionsPage({ limit: 17, sort: 'oldest' });
  assert.equal(oldest.items.length, 17);
  assert.ok(oldest.items[0].txDate <= oldest.items[oldest.items.length - 1].txDate);

  const matching = db.getTransactionsPage({ limit: 50, search: 'searchableledgerphrase' });
  assert.equal(matching.totalCount, 17);
  assert.equal(matching.items.length, 17);
  assert.ok(matching.items.every((item: any) => item.notes.includes('SEARCHABLELEDGERPHRASE')));

  const exportSnapshot = db.openTransactionExportSnapshot(
    { from: '2026-10-01', to: '2026-10-31', search: 'searchableledgerphrase' },
    { from: '2026-10-01', to: '2026-10-31', label: 'October test' },
  );
  const streamedExportRows: any[] = [];
  try {
    for await (const row of exportSnapshot.rows) streamedExportRows.push(row);
    assert.equal(streamedExportRows.length, 17);
    assert.equal(exportSnapshot.summary?.periodTransactionCount, activeCount);
    assert.ok(streamedExportRows.every((row) => row.notes.includes('SEARCHABLELEDGERPHRASE')));
  } finally {
    exportSnapshot.close();
  }
  const { streamXlsxWorkbook } = await import('../server/xlsxStream');
  const workbookChunks: Buffer[] = [];
  async function* workbookRows() {
    yield ['Voucher', 'Amount (BDT)'];
    yield ['TEST-001', { value: 12.34, style: 2 }];
  }
  for await (const chunk of streamXlsxWorkbook([{ name: 'Transactions', rows: workbookRows() }])) workbookChunks.push(chunk);
  const workbookBytes = Buffer.concat(workbookChunks);
  assert.equal(workbookBytes.subarray(0, 2).toString('ascii'), 'PK');
  assert.ok(workbookBytes.length > 500);

  const { transactionCsv } = await import('../server/exportStreams');
  let fakeSnapshotClosed = false;
  const fakeSnapshot = {
    summary: null,
    rows: (async function* () {
      yield {
        voucherNo: 'CSV-001', txDate: '2026-10-01', kind: 'expense', department: 'HQ', head: 'Office',
        subCategory: 'Test', amountPaisa: 1234, paymentMethod: 'Cash', referenceNo: '',
        counterparty: '=HYPERLINK("x")', purpose: 'Text, with comma', status: 'verified', editCount: 0,
        amountChanged: false, lastEditReason: '', createdByName: 'Tester',
      } as any;
    })(),
    close: () => { fakeSnapshotClosed = true; },
  };
  const csvChunks: Buffer[] = [];
  for await (const chunk of transactionCsv(fakeSnapshot as any)) csvChunks.push(chunk);
  const csvText = Buffer.concat(csvChunks).toString('utf8');
  assert.ok(csvText.startsWith('\uFEFF'));
  assert.ok(csvText.includes("'=HYPERLINK("));
  assert.ok(csvText.includes('"Text, with comma"'));
  assert.equal(fakeSnapshotClosed, true);

  const filtered = db.getTransactionsPage({
    limit: 50,
    from: '2026-10-03',
    to: '2026-10-07',
    kind: 'expense',
    employeeId: 'scale-employee-2',
  });
  assert.ok(filtered.items.every((item: any) => item.kind === 'expense' && item.employeeId === 'scale-employee-2'));
  assert.ok(filtered.items.every((item: any) => item.txDate >= '2026-10-03' && item.txDate <= '2026-10-07'));

  const summary = db.getPeriodSummary('2026-10-01', '2026-10-31', 'October test');
  const direct = raw.prepare(`
    SELECT
      SUM(CASE WHEN kind = 'income' THEN amount_paisa ELSE 0 END) AS income,
      SUM(CASE WHEN kind = 'expense' THEN amount_paisa ELSE 0 END) AS expense,
      COUNT(*) AS count
    FROM transactions WHERE deleted_at = '' AND tx_date >= ? AND tx_date <= ?
  `).get('2026-10-01', '2026-10-31');
  const independentlyReadRows = raw.prepare(`
    SELECT kind, amount_paisa FROM transactions
    WHERE deleted_at = '' AND tx_date >= ? AND tx_date <= ?
  `).all('2026-10-01', '2026-10-31') as Array<{ kind: string; amount_paisa: number }>;
  const independentlyCalculated = independentlyReadRows.reduce((totals, row) => {
    if (row.kind === 'income') totals.income += Number(row.amount_paisa);
    else totals.expense += Number(row.amount_paisa);
    totals.count += 1;
    return totals;
  }, { income: 0, expense: 0, count: 0 });
  assert.equal(summary.periodIncomePaisa, independentlyCalculated.income);
  assert.equal(summary.periodExpensePaisa, independentlyCalculated.expense);
  assert.equal(summary.periodTransactionCount, independentlyCalculated.count);
  assert.equal(summary.incomeCount + summary.expenseCount, summary.periodTransactionCount);
  assert.equal(summary.closingBalancePaisa,
    summary.openingBalancePaisa + independentlyCalculated.income - independentlyCalculated.expense);

  assert.equal(db.getEmployeeActivityIds('2026-10-01', '2026-10-31').length, 5);
  const binRows = db.getDeletedTransactions();
  assert.ok(binRows.length > 0);
  assert.ok(binRows.every((item: any) => Boolean(item.deletedAt)));
  const binPage1 = db.getDeletedTransactionsPage({ limit: 3 });
  const binPage2 = db.getDeletedTransactionsPage({ limit: 3, cursor: binPage1.nextCursor || undefined });
  assert.equal(binPage1.items.length, 3);
  assert.equal(binPage1.totalCount, binRows.length);
  assert.equal(binPage1.hasMore, true);
  assert.ok(binPage1.items.every((item: any) => Boolean(item.deletedAt)));
  assert.equal(binPage2.items.some((item: any) => binPage1.items.some((prior: any) => prior.id === item.id)), false);
  const firstDeletedAt = binPage1.items.at(0)?.deletedAt;
  const lastDeletedAt = binPage1.items.at(-1)?.deletedAt;
  assert.ok(firstDeletedAt && lastDeletedAt && firstDeletedAt >= lastDeletedAt);
  assert.throws(() => db.getDeletedTransactionsPage({ cursor: 'invalid-cursor' }), /cursor/i);

  const updateId = 'scale-0001';
  raw.prepare('UPDATE transactions SET notes = ? WHERE id = ?').run('UPDATED_SEARCH_TOKEN', updateId);
  const updatedSearch = db.getTransactionsPage({ limit: 10, search: 'updated_search_token' });
  assert.equal(updatedSearch.totalCount, 1);
  assert.equal(updatedSearch.items[0].id, updateId);

  const plan = raw.prepare(`
    EXPLAIN QUERY PLAN
    SELECT t.* FROM transactions t INDEXED BY idx_tx_active_date_created_id
    WHERE t.deleted_at = ''
    ORDER BY t.tx_date DESC, t.created_at DESC, t.id DESC LIMIT 51
  `).all().map((row: any) => String(row.detail));
  assert.ok(plan.some((detail: string) => detail.includes('idx_tx_active_date_created_id')));
  assert.equal(plan.some((detail: string) => detail.includes('TEMP B-TREE')), false);

  const migrationVersions = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row: any) => Number(row.version));
  assert.ok(migrationVersions.includes(1));
  assert.ok(migrationVersions.includes(2));
  assert.ok(migrationVersions.includes(3));
  assert.ok(migrationVersions.includes(4));
  assert.ok(migrationVersions.includes(5));
  assert.ok(migrationVersions.includes(6));
  const headTotalsPlan = raw.prepare(`
    EXPLAIN QUERY PLAN SELECT COUNT(*), SUM(amount_paisa) FROM transactions
    WHERE deleted_at = '' AND head = ?
  `).all('OTHERS-COMPANY').map((row: any) => String(row.detail));
  assert.ok(headTotalsPlan.some((detail: string) => detail.includes('COVERING INDEX idx_tx_active_head_totals')));
  const dateSummaryPlan = raw.prepare(`
    EXPLAIN QUERY PLAN SELECT SUM(amount_paisa) FROM transactions INDEXED BY idx_tx_active_date_summary
    WHERE deleted_at = '' AND tx_date >= ? AND tx_date <= ?
  `).all('2026-10-01', '2026-10-31').map((row: any) => String(row.detail));
  assert.ok(dateSummaryPlan.some((detail: string) => detail.includes('COVERING INDEX idx_tx_active_date_summary')));
  const deletedPagePlan = raw.prepare(`
    EXPLAIN QUERY PLAN SELECT id FROM transactions INDEXED BY idx_tx_deleted_date_created_id
    WHERE deleted_at != '' ORDER BY deleted_at DESC, tx_date DESC, created_at DESC, id DESC LIMIT 51
  `).all().map((row: any) => String(row.detail));
  assert.ok(deletedPagePlan.some((detail: string) => detail.includes('idx_tx_deleted_date_created_id')));
  assert.equal(deletedPagePlan.some((detail: string) => detail.includes('TEMP B-TREE')), false);
  const searchPlan = raw.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM transactions_fts WHERE search_text LIKE ?').all('%SEARCHABLELEDGERPHRASE%').map((row: any) => String(row.detail));
  assert.ok(searchPlan.some((detail: string) => detail.includes('VIRTUAL TABLE INDEX')));
  raw.prepare("INSERT INTO transactions_fts(transactions_fts, rank) VALUES ('integrity-check', 1)").run();
  assert.equal(raw.prepare('PRAGMA quick_check').get().quick_check, 'ok');
});
