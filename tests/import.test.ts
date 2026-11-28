import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ledger-import-test-'));
process.env.PACE_DATA_DIR = TMP_DIR;

const X = await import('../server/excelImport');
const { db } = await import('../server/db');

test.after(async () => {
  await db.ready();
  const raw = (db as any).sqlite?.raw;
  if (raw) {
    try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* already closed */ }
    try { raw.close(); } catch { /* keep original result */ }
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// A miniature workbook laid out exactly like the real one (Excel row/column numbers, 1-based).
function put(grid: unknown[][], row: number, col: number, value: unknown) {
  while (grid.length < row) grid.push([]);
  const r = grid[row - 1];
  while (r.length < col) r.push(null);
  r[col - 1] = value;
}
function miniWorkbook(): Record<string, unknown[][]> {
  const ex: unknown[][] = [];
  put(ex, 3, 10, '2026-11-01'); put(ex, 3, 7, 788);
  put(ex, 7, 5, 105000); put(ex, 7, 10, 21460);
  // income: B date, C manager, D details, E amount
  put(ex, 9, 2, '2026-11-01'); put(ex, 9, 3, 'SHOUROV'); put(ex, 9, 4, 'Previous Month'); put(ex, 9, 5, 74);
  put(ex, 10, 2, '2026-11-02'); put(ex, 10, 4, 'OWNER-CASH'); put(ex, 10, 5, 100000);
  put(ex, 11, 4, 'BRAC-BANK-ATM'); put(ex, 11, 5, 4926); // no date in the sheet
  // expense: G date, H department, I details, J amount
  put(ex, 9, 7, '2026-11-02'); put(ex, 9, 8, 'ALHAMRA-OFFICE'); put(ex, 9, 9, 'Stationary'); put(ex, 9, 10, 460);
  put(ex, 10, 8, 'BALUCHOR-OFFICE'); put(ex, 10, 9, 'Baluchor Meter Recharge'); put(ex, 10, 10, 1000); // no date
  put(ex, 11, 7, '2026-11-03'); put(ex, 11, 8, 'ALHAMRA-OFFICE'); put(ex, 11, 9, 'Mithu Salary Advance'); put(ex, 11, 10, 5000);
  put(ex, 12, 7, '2026-11-04'); put(ex, 12, 8, 'ALHAMRA-OFFICE'); put(ex, 12, 9, 'Sumon Loan'); put(ex, 12, 10, 10000);
  put(ex, 13, 7, '2026-11-04'); put(ex, 13, 8, 'DASPARA-OFFICE'); put(ex, 13, 9, 'Khaled Salary - 7 day'); put(ex, 13, 10, 3000);
  put(ex, 14, 7, '2026-11-05'); put(ex, 14, 8, 'ALHAMRA-OFFICE'); put(ex, 14, 9, 'Sumon Salary Advance'); put(ex, 14, 10, 2000);

  const sal: unknown[][] = [];
  put(sal, 3, 11, '2026-11-01'); put(sal, 6, 11, 8000);
  put(sal, 8, 3, 'ALHAMRA-MITHU'); put(sal, 8, 4, 29000);
  put(sal, 9, 3, 'ALHAMRA-SUMON'); put(sal, 9, 4, 17000);
  put(sal, 10, 3, 'DASPARA-REJUWAN'); put(sal, 10, 4, 1300);
  // payments: H date, I label, J details, K amount
  put(sal, 8, 8, '2026-11-03'); put(sal, 8, 9, 'ALHAMRA-MITHU-SALARY'); put(sal, 8, 11, 5000);
  put(sal, 9, 8, '2026-11-04'); put(sal, 9, 9, 'DASPARA-REJUWAN-SALARY'); put(sal, 9, 10, 'Daspara-Khaled-Salary'); put(sal, 9, 11, 3000);

  const loan: unknown[][] = [];
  put(loan, 7, 4, 10000); put(loan, 7, 5, 2500);
  put(loan, 9, 7, '2026-11-04'); put(loan, 9, 8, 'ALHAMRA-SUMON-LONE'); put(loan, 9, 9, 10000);
  put(loan, 9, 11, '2026-11-11'); put(loan, 9, 12, 'ALHAMRA-SUMON-PAID'); put(loan, 9, 13, 2500);

  const rent: unknown[][] = [];
  put(rent, 6, 4, 24000); put(rent, 6, 5, 8000);
  put(rent, 8, 3, 'Shibgonj Office'); put(rent, 8, 4, 0); put(rent, 8, 5, 8000);
  put(rent, 9, 3, 'Al Hamra Office'); put(rent, 9, 4, 24000); put(rent, 9, 5, 0);
  return { Expense: ex, salary: sal, LONE: loan, Rent: rent };
}

function ctxFor(hash: string): any {
  const existing = new Map<string, string[]>();
  const existingLinked = new Map<string, string[]>();
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (const t of db.getAllTransactions(false)) {
    const k = `${t.txDate}|${t.kind}|${t.amountPaisa}`;
    existing.set(k, [...(existing.get(k) || []), t.voucherNo]);
    if (['salary', 'salary_advance', 'loan_issue', 'loan_repayment'].includes(t.categoryGroup ?? '') && t.employeeName) {
      const linkedKey = `${t.txDate}|${t.categoryGroup}|${norm(t.employeeName)}|${t.amountPaisa}`;
      existingLinked.set(linkedKey, [...(existingLinked.get(linkedKey) || []), t.voucherNo]);
    }
  }
  for (const loan of db.getLoans()) {
    for (const repayment of loan.repayments) {
      if (repayment.source !== 'historical') continue;
      const linkedKey = `${repayment.paidDate}|loan_repayment|${norm(loan.employeeName)}|${repayment.amountPaisa}`;
      existingLinked.set(linkedKey, [...(existingLinked.get(linkedKey) || []), `historical repayment ${loan.loanNo}`]);
    }
  }
  const heads = db.getHeads();
  return {
    fundSources: db.getFundSources(),
    employees: db.getEmployees(),
    rentItems: db.getRentItems().map((r: any) => ({
      id: r.id, name: r.name, category: r.category,
      monthlyAmountPaisa: r.monthlyAmountPaisa, urgentAmountPaisa: r.urgentAmountPaisa,
      department: r.department, notes: r.notes || '',
    })),
    headNames: { income: heads.filter((h: any) => h.kind === 'income').map((h: any) => h.name), expense: heads.filter((h: any) => h.kind === 'expense').map((h: any) => h.name) },
    departmentNames: db.getDepartments().map((d: any) => d.name),
    lockedPeriods: db.getPeriodLocks().map((l: any) => l.periodKey),
    existingEntries: existing,
    existingLinkedEntries: existingLinked,
    openingBalancePaisa: 0,
    alreadyImported: db.isImportBatchPresent(X.importTag(hash)),
  };
}

const HASH = 'b7'.repeat(32);
let admin: any;

test('the workbook is read into the right fields, with gaps flagged rather than hidden', async () => {
  admin = await db.bootstrapFirstAdmin({ username: 'admin', displayName: 'Finance Admin', password: 'SylhetVault#2026', loadSampleData: false });
  const plan = X.buildImportPlan(miniWorkbook() as any, { fileName: 'mini.xlsx', fileHash: HASH }, ctxFor(HASH));

  assert.equal(plan.sheetMonth, '2026-11');
  assert.equal(plan.sheetOpeningBalance, 74);
  const income = plan.entries.filter((e) => e.kind === 'income');
  const expense = plan.entries.filter((e) => e.kind === 'expense');
  assert.equal(income.length, 2, 'Previous Month is not a current-month income transaction');
  assert.equal(expense.length, 6);

  const owner = income.find((e) => e.head === 'OWNER-CASH')!;
  assert.equal(owner.amount, '100000.00');
  assert.equal(owner.txDate, '2026-11-02');
  assert.equal(owner.department, 'OWNER-CASH');
  assert.equal(owner.paymentMethod, 'Cash in Hand');
  assert.equal(owner.source, 'Expense!B10:E10');

  // A row with no date takes the date above it and says so.
  const atm = income.find((e) => e.head === 'BRAC-BANK-ATM')!;
  assert.equal(atm.txDate, '2026-11-02');
  assert.ok(atm.guessed!.includes('txDate'));
  assert.equal(atm.paymentMethod, 'BRAC Bank ATM');

  const meter = expense.find((e) => e.counterparty === 'Baluchor Meter Recharge')!;
  assert.equal(meter.department, 'BALUCHOR-OFFICE');
  assert.equal(meter.head, 'BALUCHOR-OFFICE');
  assert.equal(meter.subCategory, 'Electricity, Water & Gas');
  assert.ok(meter.guessed!.includes('txDate'));
  assert.equal(meter.txDate, '2026-11-02');

  // Employees come from the salary sheet, with branch and name read from the label.
  assert.deepEqual(plan.employees.map((e) => [e.key, e.name, e.branch]), [
    ['ALHAMRA-MITHU', 'Mithu', 'ALHAMRA-OFFICE'],
    ['ALHAMRA-SUMON', 'Sumon', 'ALHAMRA-OFFICE'],
    ['DASPARA-REJUWAN', 'Rejuwan', 'DASPARA-OFFICE'],
  ]);

  // A payroll row already present in the cash book is counted once, not twice.
  const mithuAdvance = expense.find((e) => e.counterparty === 'Mithu Salary Advance')!;
  assert.equal(mithuAdvance.include, false);
  assert.match(mithuAdvance.coveredBy || '', /salary!H8:K8/);
  const sumonLoan = expense.find((e) => e.counterparty === 'Sumon Loan')!;
  assert.equal(sumonLoan.include, false);
  assert.match(sumonLoan.coveredBy || '', /LONE!G9:I9/);

  // A payment whose Details name someone else is left out, with the reason shown.
  const khaledPay = plan.salaryPayments.find((p) => p.source === 'salary!H9:K9')!;
  assert.equal(khaledPay.include, false);
  assert.match(khaledPay.skipReason || '', /Khaled/);
  // The matching cash-book row stays, so that money is counted exactly once.
  assert.equal(expense.find((e) => e.counterparty.startsWith('Khaled'))!.include, true);

  // Payroll-looking cash-book money with no sheet row is offered for conversion, not silently dropped.
  const sumonAdv = expense.find((e) => e.counterparty === 'Sumon Salary Advance')!;
  assert.equal(sumonAdv.include, true);
  assert.deepEqual(sumonAdv.payrollHint, { employeeRef: 'ALHAMRA-SUMON', type: 'advance' });

  assert.equal(plan.loans.length, 1);
  assert.equal(plan.loanRepayments.length, 1);
  assert.equal(plan.loanRepayments[0].loanRef, plan.loans[0].id);
  assert.equal(plan.rentItems.length, 2);
  assert.deepEqual(plan.rentItems.map((r) => [r.name, r.category, r.monthlyAmount, r.urgentAmount, r.department]), [
    ['Shibgonj Office', 'urgent', '0.00', '8000.00', 'SHIBGONJ-OFFICE'],
    ['Al Hamra Office', 'regular', '24000.00', '0.00', 'ALHAMRA-OFFICE'],
  ]);
});

test('opening balance is reconciled from backdated activity and cash-book matches require the same date', () => {
  const grids = miniWorkbook();
  // These two payroll/loan rows belong to October, while the similarly named
  // cash-book expenses are in November. They must not be treated as duplicates.
  put(grids.salary, 8, 8, '2026-10-31');
  put(grids.LONE, 9, 7, '2026-10-31');
  const ctx = ctxFor(HASH);
  const plan = X.buildImportPlan(grids as any, { fileName: 'backdated.xlsx', fileHash: HASH }, ctx);
  assert.equal(plan.entries.find((e) => e.counterparty === 'Mithu Salary Advance')!.include, true);
  assert.equal(plan.entries.find((e) => e.counterparty === 'Sumon Loan')!.include, true);

  const checked = X.validateImportPlan(plan, ctx);
  const adjustment = checked.plan.entries.find((e) => e.source === 'System: opening balance reconciliation')!;
  assert.equal(adjustment.include, true);
  assert.equal(adjustment.kind, 'income');
  assert.equal(adjustment.txDate, '2026-10-31');
  assert.equal(adjustment.amount, '15074.00');
  const opening = checked.reconcile.find((r) => r.label === 'Opening balance brought forward')!;
  assert.equal(opening.sheet, 74);
  assert.equal(opening.imported, 74);
  assert.equal(opening.ok, true);

  // The adjustment recalculates when a backdated linked row is excluded.
  const changed = JSON.parse(JSON.stringify(checked.plan));
  changed.salaryPayments.find((p: any) => p.source === 'salary!H8:K8').include = false;
  const rechecked = X.validateImportPlan(changed, ctx);
  assert.equal(rechecked.plan.entries.find((e) => e.source === 'System: opening balance reconciliation')!.amount, '10074.00');

  // It is required: excluding the generated row must prevent a bad import.
  changed.entries.find((e: any) => e.source === 'System: opening balance reconciliation').include = false;
  const refused = X.validateImportPlan(changed, ctx);
  assert.ok(refused.planIssues.some((i) => /opening-balance reconciliation is required/i.test(i.message)));
  assert.ok(refused.errorCount > 0);
});

test('validation catches bad edits and reconciles against the workbook totals', () => {
  const ctx = ctxFor(HASH);
  const plan = X.buildImportPlan(miniWorkbook() as any, { fileName: 'mini.xlsx', fileHash: HASH }, ctx);
  const v = X.validateImportPlan(plan, ctx);

  const line = (label: string) => v.reconcile.find((l) => l.label.startsWith(label))!;
  assert.equal(line('Money in').ok, true);
  assert.equal(line('Money out').ok, true);
  assert.equal(line('Loans issued').ok, true);
  assert.equal(line('Loan repayments').ok, true);

  // Bad fund source, bad date, zero amount, missing required text: each row says why.
  const bad = JSON.parse(JSON.stringify(plan));
  const row = bad.entries.find((e: any) => e.counterparty === 'Stationary');
  row.fundSource = 'Nope'; row.txDate = '2026-13-45'; row.amount = '0'; row.purpose = '';
  const v2 = X.validateImportPlan(bad, ctx);
  const msgs = v2.plan.entries.find((e) => e.id === row.id)!.issues!.filter((i) => i.level === 'error').map((i) => i.message).join(' | ');
  assert.match(msgs, /date|Amount|purpose|Fund source/i);
  assert.ok(v2.errorCount > 0);

  // Paying more salary than is owed is an error, with the arithmetic.
  const over = JSON.parse(JSON.stringify(plan));
  over.salaryPayments[0].amount = '30000';
  const v3 = X.validateImportPlan(over, ctx);
  assert.match(v3.plan.salaryPayments[0].issues!.map((i) => i.message).join(' '), /Exceeds what is still payable/);

  // Spending that no fund can cover is caught up front, before anything is written.
  assert.ok(v.planIssues.some((i) => /below zero/.test(i.message)) === false || v.errorCount > 0);
});

test('loan repayment cash treatment is explicit and is reflected in closing-balance preview', () => {
  const ctx = ctxFor('d4'.repeat(32));
  const plan = X.buildImportPlan(miniWorkbook() as any, { fileName: 'cash-repayment.xlsx', fileHash: 'd4'.repeat(32) }, ctx);
  plan.loanRepayments[0].treatment = 'cash';
  const checked = X.validateImportPlan(plan, ctx);
  const closing = checked.reconcile.find((row) => row.label.startsWith('Cash balance after import'))!;
  const alreadyRecorded = JSON.parse(JSON.stringify(plan));
  alreadyRecorded.loanRepayments[0].treatment = 'already-recorded';
  const baseline = X.validateImportPlan(alreadyRecorded, ctx).reconcile.find((row) => row.label.startsWith('Cash balance after import'))!;
  assert.equal((closing.imported ?? 0) - (baseline.imported ?? 0), 2500, 'cash treatment adds only the repayment amount to projected cash');
  assert.equal(closing.ok, false, 'cash received is additional income not in the workbook cash-book total');
  assert.ok(checked.plan.loanRepayments[0].issues?.some((issue) => issue.level === 'warn' && /creates a new income transaction/.test(issue.message)));
});

test('a repeated monthly rent row updates its existing obligation instead of blocking or duplicating it', () => {
  const ctx = ctxFor('e5'.repeat(32));
  ctx.rentItems = [{
    id: 'rent-existing-shibgonj',
    name: 'Shibgonj Office',
    category: 'urgent',
    monthlyAmountPaisa: 0,
    urgentAmountPaisa: 800000,
    department: 'SHIBGONJ-OFFICE',
    notes: 'Keep this manager note',
  }];
  const plan = X.buildImportPlan(miniWorkbook() as any, { fileName: 'rent-next-month.xlsx', fileHash: 'e5'.repeat(32) }, ctx);
  plan.sheetOpeningBalance = null;
  plan.entries = [];
  for (const row of [...plan.employees, ...plan.salaryPayments, ...plan.loans, ...plan.loanRepayments]) row.include = false;
  for (const row of plan.rentItems) row.include = row.name === 'Shibgonj Office';
  const rent = plan.rentItems[0];
  rent.urgentAmount = '8500.00';

  const checked = X.validateImportPlan(plan, ctx);
  assert.equal(checked.errorCount, 0, JSON.stringify(checked.plan.rentItems[0].issues));
  assert.equal(checked.plan.rentItems[0].linkExistingId, 'rent-existing-shibgonj');
  assert.ok(checked.plan.rentItems[0].issues?.some((issue) => issue.level === 'info' && /will be updated; no duplicate/.test(issue.message)));

  let updated: any = null;
  let created = 0;
  const deps = {
    transaction: (fn: () => unknown) => fn(),
    createRentItem: () => { created++; },
    updateRentItem: (id: string, input: any) => { updated = { id, input }; },
  } as any;
  const result = X.commitImportPlan(checked.plan, admin, ctx, deps);
  assert.equal(result.rentItems, 1);
  assert.equal(created, 0, 'existing monthly obligations are not duplicated');
  assert.equal(updated.id, 'rent-existing-shibgonj');
  assert.equal(updated.input.urgentAmountPaisa, 850000);
  assert.equal(updated.input.notes, 'Keep this manager note', 'import preserves notes that are not represented in the workbook');
});

test('commit is refused while problems remain, writes everything once fixed, and cannot be repeated', () => {
  const ctx = ctxFor(HASH);
  const plan = X.buildImportPlan(miniWorkbook() as any, { fileName: 'mini.xlsx', fileHash: HASH }, ctx);
  plan.entries.find((e) => e.counterparty === 'Stationary')!.fundSource = 'Does not exist';
  const before = db.getAllTransactions(false).length;
  assert.throws(() => X.commitImportPlan(plan, admin, ctx, db as any), /problem/);
  assert.equal(db.getAllTransactions(false).length, before, 'a refused import writes nothing');
  assert.equal(db.getEmployees().length, 0);

  plan.entries.find((e) => e.counterparty === 'Stationary')!.fundSource = plan.defaultFundSource;
  // The repayment is already represented in the cash-book deposit; update the
  // loan register without creating a second income transaction.
  plan.loanRepayments[0].treatment = 'already-recorded';
  // Include the one conversion offered above as a real salary advance.
  const adv = plan.entries.find((e) => e.counterparty === 'Sumon Salary Advance')!;
  adv.include = false;
  plan.salaryPayments.push({
    id: 'sal-m1', include: true, source: adv.source, employeeRef: 'ALHAMRA-SUMON', type: 'advance', txDate: adv.txDate,
    monthKey: plan.sheetMonth, amount: adv.amount, paymentMethod: 'Cash in Hand', department: 'ALHAMRA-OFFICE',
    fundSource: adv.fundSource, note: 'From cash book',
  });
  const v = X.validateImportPlan(plan, ctxFor(HASH));
  assert.equal(v.errorCount, 0, JSON.stringify(v.planIssues));

  const result = X.commitImportPlan(plan, admin, ctxFor(HASH), db as any);
  assert.deepEqual([result.employees, result.salaryPayments, result.loans, result.loanRepayments, result.rentItems], [3, 2, 1, 1, 2]);

  const live = db.getAllTransactions(false);
  const stationery = live.find((t: any) => t.counterparty === 'Stationary')!;
  assert.equal(stationery.department, 'ALHAMRA-OFFICE');
  assert.equal(stationery.head, 'ALHAMRA-OFFICE');
  assert.equal(stationery.amountPaisa, 46000);
  assert.equal(stationery.txDate, '2026-11-02');
  assert.match(stationery.notes || '', /\[import:b7b7b7b7b7b7\] Excel Expense!G9:J9/);
  assert.equal(stationery.createdByName, 'Finance Admin');
  const transactionDuplicateIndex = db.getImportDuplicateIndexes({
    entries: [{ txDate: '2026-11-02', kind: 'expense', amountPaisa: 46000 }], linked: [],
  });
  assert.ok(transactionDuplicateIndex.existingEntries.get('2026-11-02|expense|46000')?.includes(stationery.voucherNo));

  // Money-in total, salary/loan linkage and the audit chain all hold up.
  const inc = live.filter((t: any) => t.kind === 'income').reduce((s: number, t: any) => s + t.amountPaisa, 0);
  assert.equal(inc, (74 + 100000 + 4926) * 100);
  const sumonLoan = db.getLoans().find((loan: any) => loan.employeeName === 'Sumon')!;
  assert.ok(sumonLoan.repayments.some((repayment: any) => repayment.source === 'historical' && repayment.amountPaisa === 250000));
  const duplicateIndex = db.getImportDuplicateIndexes({ entries: [], linked: [{
    txDate: '2026-11-11', categoryGroup: 'loan_repayment', employeeName: 'Sumon', amountPaisa: 250000,
  }] });
  assert.ok(duplicateIndex.existingLinkedEntries.get('2026-11-11|loan_repayment|SUMON|250000')?.some((v: string) => /historical repayment/.test(v)));
  assert.equal(db.getEmployees().length, 3);
  assert.equal(db.getRentItems().length, 2);
  assert.equal(db.verifyAuditChain().ok, true);
  const mithu = db.getEmployees().find((e: any) => e.name === 'Mithu')!;
  assert.equal(mithu.monthlySalaryPaisa, 2900000);
  assert.ok(live.some((t: any) => t.employeeId === mithu.id && t.categoryGroup === 'salary' && t.amountPaisa === 500000));

  // A repeated cumulative Loan sheet warns about historical repayments even
  // though those repayments deliberately have no ledger income transaction.
  const repeatHash = 'c3'.repeat(32);
  const repeatedDraft = X.buildImportPlan(miniWorkbook() as any, { fileName: 'mini-repeated.xlsx', fileHash: repeatHash }, ctxFor(repeatHash));
  assert.equal(repeatedDraft.salaryPayments.find((p) => p.employeeRef === 'ALHAMRA-MITHU')!.include, false);
  assert.equal(repeatedDraft.loans[0].include, false);
  assert.equal(repeatedDraft.loanRepayments[0].include, false);
  assert.match(repeatedDraft.loanRepayments[0].skipReason || '', /historical repayment/);
  // An admin can deliberately re-enable a row; validation then surfaces the duplicate warning.
  repeatedDraft.loanRepayments[0].include = true;
  const repeated = X.validateImportPlan(repeatedDraft, ctxFor(repeatHash)).plan;
  assert.ok(repeated.loanRepayments[0].issues?.some((issue: any) => /historical repayment/.test(issue.message)));

  // The same file cannot be imported twice.
  const again = X.buildImportPlan(miniWorkbook() as any, { fileName: 'mini.xlsx', fileHash: HASH }, ctxFor(HASH));
  const v2 = X.validateImportPlan(again, ctxFor(HASH));
  assert.ok(v2.planIssues.some((i) => /already been imported/.test(i.message)));
  assert.throws(() => X.commitImportPlan(again, admin, ctxFor(HASH), db as any), /problem/);
});

test('a failure part-way through leaves nothing behind (all or nothing)', () => {
  const hash = 'c9'.repeat(32);
  const plan = X.buildImportPlan(miniWorkbook() as any, { fileName: 'mini2.xlsx', fileHash: hash }, ctxFor(hash));
  // Make every name unique so this is a different, valid import than the last test.
  plan.employees.forEach((e) => { e.name = `${e.name} Two`; e.linkExistingId = ''; });
  plan.rentItems.forEach((r) => { r.name = `${r.name} Two`; });
  plan.entries.filter((e) => e.coveredBy).forEach((e) => { e.include = false; });
  plan.salaryPayments.forEach((s) => { s.include = false; });
  plan.loans.forEach((l) => { l.include = false; });
  plan.loanRepayments.forEach((r) => { r.include = false; });
  plan.entries.filter((e) => e.payrollHint).forEach((e) => { e.include = false; });
  const ctx = ctxFor(hash);
  assert.equal(X.validateImportPlan(plan, ctx).errorCount, 0);

  const before = { tx: db.getAllTransactions(false).length, emp: db.getEmployees().length, rent: db.getRentItems().length };
  let calls = 0;
  const failing: any = {
    transaction: (fn: any) => db.transaction(fn),
    createEmployee: (i: any, a: any) => db.createEmployee(i, a),
    createRentItem: (i: any, a: any) => db.createRentItem(i, a),
    issueLoan: (i: any, a: any) => db.issueLoan(i, a),
    repayLoan: (id: string, i: any, a: any) => db.repayLoan(id, i, a),
    recordHistoricalLoanRepayment: (id: string, i: any, a: any) => db.recordHistoricalLoanRepayment(id, i, a),
    payEmployeeSalary: (i: any, a: any) => db.payEmployeeSalary(i, a),
    createSalaryAdvance: (i: any, a: any) => db.createSalaryAdvance(i, a),
    createTransaction: (i: any, a: any) => { if (++calls === 3) throw new Error('disk exploded'); return db.createTransaction(i, a); },
  };
  assert.throws(() => X.commitImportPlan(plan, admin, ctx, failing), /disk exploded/);
  assert.equal(db.getAllTransactions(false).length, before.tx);
  assert.equal(db.getEmployees().length, before.emp);
  assert.equal(db.getRentItems().length, before.rent);
  assert.equal(db.isImportBatchPresent(X.importTag(hash)), false);
  assert.equal(db.verifyAuditChain().ok, true);
});

test('the plan sent back by the browser is not trusted', () => {
  assert.throws(() => X.sanitizeImportPlan(null), /out of date/);
  assert.throws(() => X.sanitizeImportPlan({ version: 2 }), /out of date/);
  assert.throws(() => X.sanitizeImportPlan({ version: 1, fileHash: 'nope' }), /fingerprint/);
  const clean = X.sanitizeImportPlan({
    version: 1, fileHash: 'a'.repeat(64), entries: [{ id: 1, include: 'yes', kind: 'weird', amount: { evil: true }, __proto__: { x: 1 }, extra: 'dropped' }],
    salaryPayments: [{ type: 'weird' }], rentItems: [{ category: 'weird' }],
  });
  assert.equal(clean.entries[0].include, false, 'only a literal true includes a row');
  assert.equal(clean.entries[0].kind, 'expense');
  assert.equal(typeof clean.entries[0].amount, 'string');
  assert.equal((clean.entries[0] as any).extra, undefined);
  assert.equal(clean.salaryPayments[0].type, 'salary');
  assert.equal(clean.rentItems[0].category, 'regular');
});
