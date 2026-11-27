import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ledger-test-'));
process.env.PACE_DATA_DIR = TMP_DIR;

const { toPaisa, fromPaisa, formatBDT, formatDeltaBDT } = await import('../src/utils/money');
const { summarizePeriod, monthRangeOf, computeEmployeeSpendStats } = await import('../src/utils/ledger');
const { verifyPasswordAsync } = await import('../server/passwords');
const {
  validateTransactionInput,
  validateEmployeeInput,
  validateSalaryPayInput,
  validateSalaryAdvanceInput,
  validateLoanIssueInput,
  validateLoanRepayInput,
  validateRentItemInput,
  validateRentPaymentInput,
} = await import('../server/validation');
const { db, SQLITE_DATABASE_FILE } = await import('../server/db');
const { createSqliteSnapshot } = await import('../server/sqliteSnapshot');

test.after(async () => {
  // Close the application's long-lived SQLite handle before deleting the
  // temporary database. Windows does not allow deleting open SQLite files.
  await db.ready();
  const raw = (db as any).sqlite?.raw;
  if (raw) {
    try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* database may already be closed */ }
    try { raw.close(); } catch { /* preserve the original test result */ }
  }
  fs.rmSync(TMP_DIR, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
});

test('money helpers preserve exact integer paisa precision', () => {
  assert.equal(toPaisa('1,625,574.00'), 162_557_400);
  assert.equal(toPaisa('৳178.00'), 17_800);
  assert.equal(toPaisa('১২৫.৫০'), 12_550);
  assert.equal(toPaisa('0.10')! + toPaisa('0.20')!, 30);
  assert.equal(toPaisa('12.345'), null);
  assert.equal(fromPaisa(17_800), '178.00');
  assert.equal(formatBDT(162_557_400), '৳1,625,574.00');
  assert.equal(formatDeltaBDT(-50_000), '-৳500.00');
});

test('validation enforces accountability fields, mandatory department, and edit reasons', () => {
  assert.throws(() =>
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: '2026-11-10',
        amount: '500',
        department: '',
        head: 'ALHAMRA-OFFICE',
        subCategory: 'Electricity / Utility',
        paymentMethod: 'Cash in Hand',
        fundSourceId: 'source-for-validation',
        counterparty: 'PDB',
        purpose: 'Electricity bill',
      },
      false,
    ),
    /Department/i,
  );

  assert.throws(() =>
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: '2026-11-10',
        amount: '500',
        department: 'ALHAMRA-OFFICE',
        head: 'ALHAMRA-OFFICE',
        subCategory: 'Electricity / Utility',
        paymentMethod: 'Cash in Hand',
        fundSourceId: 'source-for-validation',
        counterparty: '',
        purpose: 'Electricity bill',
      },
      false,
    ),
  );

  assert.throws(() =>
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: '2026-11-10',
        amount: '500',
        department: 'ALHAMRA-OFFICE',
        head: 'ALHAMRA-OFFICE',
        subCategory: 'Electricity / Utility',
        paymentMethod: 'Cash in Hand',
        fundSourceId: 'source-for-validation',
        counterparty: 'PDB',
        purpose: 'Electricity bill for office',
        reason: 'no',
      },
      true,
    ),
  );

  const ok = validateTransactionInput(
    {
      kind: 'income',
      txDate: '2026-11-10',
      amount: '15000.25',
      department: 'BRAC-BANK-ATM',
      head: 'BRAC-BANK-ATM',
      subCategory: 'Owner / Capital Funding',
      paymentMethod: 'BRAC Bank ATM',
      referenceNo: 'ATM-101',
      counterparty: 'Pace IT Treasury',
      purpose: 'Weekly operational float',
      fundSourceId: 'source-for-validation',
    },
    false,
  );
  assert.equal(ok.amountPaisa, 1_500_025);
  assert.equal(ok.department, 'BRAC-BANK-ATM');
  assert.equal(ok.departmentReview, false);
});

test('ledger bootstrap, sample statement math, direct income entry, edit flagging & tamper detection', async () => {
  assert.equal(db.needsSetup(), true);
  const admin = await db.bootstrapFirstAdmin({
    username: 'admin',
    displayName: 'Finance Admin',
    password: 'SylhetVault#2026',
    loadSampleData: true,
  });
  assert.equal(admin.role, 'admin');
  assert.equal(db.needsSetup(), false);

  const createdAcct = await db.createUser({
    username: 'accounts',
    displayName: 'Accounts Manager',
    password: 'LedgerPass#2026',
    role: 'user',
  });
  const acctRow = db.getUserByUsername('accounts')!;
  assert.equal(await verifyPasswordAsync('LedgerPass#2026', acctRow.password), true);
  const acct = { ...createdAcct, role: 'user' as const };

  const prefDark = db.updateUserPreferences(acct.id, { theme: 'dark' });
  assert.equal(prefDark.theme, 'dark');
  const prefLight = db.updateUserPreferences(acct.id, { theme: 'light' });
  assert.equal(prefLight.theme, 'light');

  const updatedProfile = db.updateUserProfile(acct.id, { username: 'accounts_sylhet', displayName: 'Sylhet Accounts' });
  assert.equal(updatedProfile.username, 'accounts_sylhet');
  assert.equal(updatedProfile.displayName, 'Sylhet Accounts');

  const adminEditedUser = db.adminUpdateUser(acct.id, { username: 'accounts', displayName: 'Accounts Officer', role: 'user', phoneNumber: '01700-112233' }, admin.id);
  assert.equal(adminEditedUser.username, 'accounts');
  assert.equal(adminEditedUser.displayName, 'Accounts Officer');
  assert.equal(adminEditedUser.phoneNumber, '01700-112233');

  const fundSources = db.getFundSources();
  const bossFundSourceId = fundSources.find((source: any) => source.name === 'Boss')!.id;
  const companyFundSourceId = fundSources.find((source: any) => source.name === 'Company Revenue')!.id;
  assert.equal(fundSources.find((source: any) => source.name === 'Boss')!.balancePaisa, 12_900);
  assert.equal(fundSources.find((source: any) => source.name === 'Company Revenue')!.balancePaisa, 4_900);
  assert.throws(
    () => db.createTransaction(
      validateTransactionInput({
        kind: 'expense',
        txDate: '2026-11-25',
        amount: '5000',
        department: 'ALHAMRA-OFFICE',
        head: 'ALHAMRA-OFFICE',
        subCategory: 'Office Supplies',
        paymentMethod: 'Cash in Hand',
        counterparty: 'Stationery shop',
        purpose: 'Expense greater than Boss fund balance',
        fundSourceId: bossFundSourceId,
      }, false),
      admin,
    ),
    /insufficient/i,
  );
  const allTx = db.getAllTransactions(false);
  const heads = db.getHeads();
  const nov = monthRangeOf('2026-11');
  const summary = summarizePeriod(allTx, heads, nov.from, nov.to, nov.label);
  assert.equal(summary.openingBalancePaisa, 7_400);
  assert.equal(summary.totalAvailablePaisa, 162_557_400);
  assert.equal(summary.periodExpensePaisa, 162_539_600);
  assert.equal(summary.closingBalancePaisa, 17_800);

  const received = db.createTransaction(
    validateTransactionInput(
      {
        kind: 'income',
        txDate: '2026-12-01',
        amount: '50000',
        department: 'BRAC-BANK-TRANSFER',
        head: 'BRAC-BANK-TRANSFER',
        subCategory: 'Company Fund Transfer',
        paymentMethod: 'BRAC Bank Transfer',
        referenceNo: 'EFTN-DEC-001',
        counterparty: 'Pace IT Corporate Treasury',
        purpose: 'December office rent and staff salaries',
        fundSourceId: companyFundSourceId,
      },
      false,
    ),
    admin,
  );
  assert.equal(received.amountPaisa, 5_000_000);
  assert.equal(received.status, 'verified');
  assert.equal(received.fundSourceId, companyFundSourceId);

  const exp = db.createTransaction(
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: '2026-12-02',
        amount: '1200.00',
        department: 'BALUCHOR-OFFICE',
        head: 'BALUCHOR-OFFICE',
        subCategory: 'Fiber, ONU & Router Hardware',
        paymentMethod: 'Cash in Hand',
        referenceNo: 'MEMO-99',
        counterparty: 'Sylhet Fiber Mart',
        purpose: 'Purchased patch cords for Baluchor POP',
        fundSourceId: companyFundSourceId,
      },
      false,
    ),
    acct,
  );

  const edited = db.editTransaction(
    exp.id,
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: '2026-12-02',
        amount: '1450.00',
        department: 'BALUCHOR-OFFICE',
        head: 'BALUCHOR-OFFICE',
        subCategory: 'Fiber, ONU & Router Hardware',
        paymentMethod: 'Cash in Hand',
        referenceNo: 'MEMO-99',
        counterparty: 'Sylhet Fiber Mart',
        purpose: 'Purchased patch cords and splitters for Baluchor POP',
        fundSourceId: companyFundSourceId,
        reason: 'Added two extra optical splitters on the same cash memo',
      },
      true,
    ),
    acct,
  );
  assert.equal(edited.amountChanged, true);
  assert.equal(edited.status, 'flagged');
  assert.equal(edited.editCount, 1);
  assert.equal(edited.editHistory[0].amountDeltaPaisa, 25_000);

  db.lockPeriod('2026-12', 'Close December books', admin);
  assert.throws(
    () =>
      db.createTransaction(
        validateTransactionInput(
          {
            kind: 'expense',
            txDate: '2026-12-05',
            amount: '100',
            department: 'ALHAMRA-OFFICE',
            head: 'ALHAMRA-OFFICE',
            subCategory: 'Office Refreshments',
            paymentMethod: 'Cash in Hand',
            counterparty: 'Tea stall',
            purpose: 'Office tea snacks',
            fundSourceId: companyFundSourceId,
          },
          false,
        ),
        acct,
      ),
    /locked/i,
  );
  db.unlockPeriod('2026-12', 'Need to post late bill', admin);

  const cleanCheck = db.verifyAuditChain();
  assert.equal(cleanCheck.ok, true);
  assert.equal(cleanCheck.brokenLinks.length, 0);
  assert.equal(cleanCheck.stateMismatches.length, 0);

  const rawSql = new DatabaseSync(path.join(TMP_DIR, 'pace_it_ledger.sqlite'));
  rawSql.prepare('UPDATE transactions SET amount_paisa = amount_paisa + 99900 WHERE id = ?').run(exp.id);
  rawSql.close();

  const tamperedCheck = db.verifyAuditChain();
  assert.equal(tamperedCheck.ok, false);
  assert.ok(tamperedCheck.stateMismatches.some((m: { txId: string }) => m.txId === exp.id));
});

test('cycle payroll, standalone loans, rent CRUD/payments, departments, rollback & backup restore', async () => {
  const adminRow = db.getUserByUsername('admin')!;
  const companyFundSourceId = db.getFundSources().find((source: any) => source.name === 'Company Revenue')!.id;
  const admin = {
    id: adminRow.id,
    username: adminRow.username,
    displayName: adminRow.displayName,
    role: adminRow.role,
    phoneNumber: adminRow.phoneNumber,
    email: adminRow.email,
    photoUrl: adminRow.photoUrl,
    theme: adminRow.theme,
    disabled: adminRow.disabled,
    createdAt: adminRow.createdAt,
  };

  const txs = db.getAllTransactions(false);
  const baluchorExp = txs.find((t) => t.head === 'BALUCHOR-OFFICE' && t.referenceNo === 'MEMO-99');
  if (baluchorExp) {
    const rawSql = new DatabaseSync(path.join(TMP_DIR, 'pace_it_ledger.sqlite'));
    rawSql.prepare('UPDATE transactions SET amount_paisa = 145000 WHERE id = ?').run(baluchorExp.id);
    rawSql.close();
  }

  const tinyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]).toString('base64');
  const stored = db.storeReceipt(tinyPng, 'camera-voucher.png');
  assert.equal(stored.type, 'image/png');
  const readBack = db.readReceipt(stored.sha256);
  assert.ok(readBack);
  assert.equal(readBack.mimeType, 'image/png');
  assert.equal(readBack.bytes[0], 0x89);

  assert.throws(() => db.storeReceipt(Buffer.from('not-an-image').toString('base64'), 'bad.txt'), /JPG, PNG, or PDF/i);

  const savedDept = db.upsertDepartment({ name: 'Sylhet North POP', description: 'North zone fiber' }, admin);
  assert.equal(savedDept.name, 'Sylhet North POP');
  const renamedDept = db.renameDepartment(savedDept.id, { name: 'Sylhet North Zone', description: 'Renamed north zone' }, admin);
  assert.equal(renamedDept.name, 'Sylhet North Zone');
  assert.ok(db.getDepartments().some((d) => d.id === savedDept.id && d.name === 'Sylhet North Zone'));

  const customTx = db.createTransaction(
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: '2026-12-02',
        amount: '350',
        department: 'Sylhet North Zone',
        head: 'Custom Sylhet Zone',
        paymentMethod: 'bKash Business',
        subCategory: 'Custom Cable Haul',
        counterparty: 'Local Courier',
        purpose: 'Custom field & channel verification',
        fundSourceId: companyFundSourceId,
      },
      false,
    ),
    admin,
  );
  const customHead = db.getHeads().find((h) => h.kind === 'expense' && h.name === 'Custom Sylhet Zone');
  assert.ok(customHead);
  const renamedHead = db.renameHead(customHead.id, { name: 'Sylhet North POP' }, admin);
  assert.equal(renamedHead.name, 'Sylhet North POP');
  assert.equal(db.getHeads().find((h) => h.id === customHead.id)?.name, 'Sylhet North POP');
  assert.equal(db.getTransactionById(customTx.id)?.head, 'Custom Sylhet Zone');
  assert.equal(db.verifyAuditChain().ok, true);

  const emp = db.createEmployee(
    validateEmployeeInput({
      name: 'Mahmudul Hasan',
      role: 'Senior Splicer',
      department: 'Field Operations',
      branch: 'EDC-PROJECT',
      phone: '01711-000111',
      monthlySalary: '25000',
      joinedDate: '2026-10-01',
    }),
    admin,
  );
  assert.equal(emp.monthlySalaryPaisa, 2_500_000);
  const updatedEmp = db.updateEmployee(emp.id, { role: 'Field Lead', monthlySalaryPaisa: 2_600_000 }, admin);
  assert.equal(updatedEmp.role, 'Field Lead');
  assert.equal(updatedEmp.monthlySalaryPaisa, 2_600_000);

  const advance = db.createSalaryAdvance(
    validateSalaryAdvanceInput({
      employeeId: emp.id,
      monthKey: '2026-12',
      issuedDate: '2026-12-03',
      amount: '5000',
      department: 'Sylhet North Zone',
      fundSourceId: companyFundSourceId,
      paymentMethod: 'Cash in Hand',
      purpose: 'Medical emergency',
    }),
    admin,
  );
  assert.equal(advance.remainingPaisa, 500_000);
  assert.equal(advance.monthKey, '2026-12');
  assert.ok(advance.linkedTxId);
  const advanceTx = db.getTransactionById(advance.linkedTxId)!;
  db.editTransaction(
    advanceTx.id,
    validateTransactionInput(
      {
        kind: 'expense',
        txDate: advanceTx.txDate,
        amount: '5000',
        department: advanceTx.department || 'Sylhet North Zone',
        head: advanceTx.head,
        subCategory: advanceTx.subCategory,
        paymentMethod: advanceTx.paymentMethod,
        referenceNo: advanceTx.referenceNo,
        counterparty: advanceTx.counterparty,
        purpose: 'Updated medical emergency reason',
        employeeId: emp.id,
        employeeName: emp.name,
        categoryGroup: 'salary_advance',
        fundSourceId: companyFundSourceId,
        reason: 'Corrected advance description',
      },
      true,
    ),
    admin,
  );
  assert.equal(db.getSalaryAdvances().find((item: any) => item.id === advance.id)!.purpose, 'Updated medical emergency reason');
  assert.throws(() => db.softDeleteTransaction(advanceTx.id, 'Test direct void', admin), /linked/i);

  const txCountBeforeLoan = db.getAllTransactions(true).length;
  const issued = db.issueLoan(
    validateLoanIssueInput({
      employeeId: emp.id,
      issuedDate: '2026-12-03',
      amount: '10000',
      monthlyInstallment: '4000',
      paymentMethod: 'Cash in Hand',
      department: 'EDC-PROJECT',
      head: 'EDC-PROJECT',
      purpose: 'Motorcycle repair loan',
      fundSourceId: companyFundSourceId,
    }),
    admin,
    stored,
  );
  assert.equal(issued.loan.remainingPaisa, 1_000_000);
  assert.equal(issued.loan.receiptSha, stored.sha256);
  assert.ok(issued.loan.linkedTxId);
  assert.equal(db.getAllTransactions(true).length, txCountBeforeLoan + 1);

  const partialSal = db.payEmployeeSalary(
    validateSalaryPayInput({
      employeeId: emp.id,
      monthKey: '2026-12',
      paidDate: '2026-12-04',
      baseSalary: '26000',
      bonus: '1000',
      otherDeduction: '0',
      payAmount: '12000',
      paymentMethod: 'BRAC Bank Transfer',
      department: 'EDC-PROJECT',
      head: 'EDC-PROJECT',
      fundSourceId: companyFundSourceId,
    }),
    admin,
    stored,
  );
  assert.equal(partialSal.payment.netPaidPaisa, 1_200_000);
  assert.equal(partialSal.payment.advanceDeductionPaisa, 0);
  assert.equal(db.getSalaryAdvances().find((item: any) => item.id === advance.id)!.remainingPaisa, 500_000);

  assert.throws(
    () =>
      db.payEmployeeSalary(
        validateSalaryPayInput({
          employeeId: emp.id,
          monthKey: '2026-12',
          paidDate: '2026-12-05',
          baseSalary: '26000',
          bonus: '0',
          otherDeduction: '0',
          payAmount: '15000',
          paymentMethod: 'BRAC Bank Transfer',
          department: 'EDC-PROJECT',
          head: 'EDC-PROJECT',
          fundSourceId: companyFundSourceId,
        }),
        admin,
      ),
    /exceeds remaining/i,
  );

  const finalSal = db.payEmployeeSalary(
    validateSalaryPayInput({
      employeeId: emp.id,
      monthKey: '2026-12',
      paidDate: '2026-12-05',
      baseSalary: '26000',
      bonus: '0',
      otherDeduction: '0',
      payAmount: '10000',
      paymentMethod: 'BRAC Bank Transfer',
      department: 'EDC-PROJECT',
      head: 'EDC-PROJECT',
      fundSourceId: companyFundSourceId,
    }),
    admin,
    stored,
  );
  assert.equal(finalSal.payment.netPaidPaisa, 1_000_000);
  assert.equal(finalSal.payment.advanceDeductionPaisa, 500_000);
  assert.equal(finalSal.payment.receiptSha, stored.sha256);
  assert.ok(finalSal.payment.linkedTxId);
  assert.equal(db.getAllTransactions(true).length, txCountBeforeLoan + 3);
  assert.equal(db.getSalaryAdvances().find((item: any) => item.id === advance.id)!.remainingPaisa, 0);

  const loanAfterSal = db.getLoans().find((l) => l.id === issued.loan.id)!;
  assert.equal(loanAfterSal.remainingPaisa, 1_000_000);
  assert.equal(loanAfterSal.status, 'active');

  const repaid = db.repayLoan(
    issued.loan.id,
    validateLoanRepayInput({
      paidDate: '2026-12-06',
      amount: '10000',
      paymentMethod: 'Cash in Hand',
      department: 'EDC-PROJECT',
      head: 'OTHER-INCOME',
      note: 'Full cash loan settlement',
      fundSourceId: companyFundSourceId,
    }),
    admin,
    stored,
  );
  assert.equal(repaid.loan.remainingPaisa, 0);
  assert.equal(repaid.loan.status, 'settled');
  assert.equal(repaid.repayment.receiptSha, stored.sha256);
  assert.ok(repaid.repayment.linkedTxId);
  assert.equal(db.getAllTransactions(true).length, txCountBeforeLoan + 4);

  const opStats = computeEmployeeSpendStats(
    db.getEmployees(),
    db.getAllTransactions(false),
    db.getLoans(),
    db.getSalaryPayments(),
  );
  const empStat = opStats.find((s) => s.employee.id === emp.id)!;
  assert.equal(empStat.operationalTakenPaisa, 0);
  assert.equal(empStat.salaryPaisa, 2_200_000);

  const afterDelRepay = db.deleteLoanRepayment(issued.loan.id, repaid.repayment.id, admin);
  assert.equal(afterDelRepay.remainingPaisa, 1_000_000);
  assert.equal(afterDelRepay.status, 'active');

  db.deleteSalaryPayment(finalSal.payment.id, admin);
  db.deleteSalaryPayment(partialSal.payment.id, admin);
  assert.equal(db.getSalaryPayments().some((s) => s.id === finalSal.payment.id || s.id === partialSal.payment.id), false);
  assert.equal(db.getSalaryAdvances().find((item: any) => item.id === advance.id)!.remainingPaisa, 500_000);
  assert.equal(db.getSalaryAdvances().find((item: any) => item.id === advance.id)!.status, 'active');

  db.deleteSalaryAdvance(advance.id, admin);
  assert.equal(db.getSalaryAdvances().some((item: any) => item.id === advance.id), false);
  assert.equal(db.getTransactionById(advanceTx.id)!.deletedAt !== undefined, true);

  const rentItem = db.createRentItem(
    validateRentItemInput({
      name: 'Zindabazar POP Utility',
      category: 'regular',
      monthlyAmount: '6500',
      urgentAmount: '0',
      department: 'ALHAMRA-OFFICE',
      notes: 'Monthly POP electricity',
    }),
    admin,
  );
  assert.equal(rentItem.monthlyAmountPaisa, 650_000);
  const updatedRentItem = db.updateRentItem(
    rentItem.id,
    validateRentItemInput({ monthlyAmount: '7000', notes: 'Revised POP rent' }, true),
    admin,
  );
  assert.equal(updatedRentItem.monthlyAmountPaisa, 700_000);

  const rentPay = db.payRentItem(
    validateRentPaymentInput({
      rentItemId: rentItem.id,
      monthKey: '2026-12',
      paidDate: '2026-12-08',
      amount: '7000',
      department: 'ALHAMRA-OFFICE',
      fundSourceId: companyFundSourceId,
      paymentMethod: 'Cash in Hand',
      referenceNo: 'RENT-DEC-01',
      notes: 'Paid POP rent',
    }),
    admin,
    stored,
  );
  assert.equal(rentPay.amountPaisa, 700_000);
  assert.ok(rentPay.linkedTxId);
  assert.equal(db.getTransactionById(rentPay.linkedTxId)?.categoryGroup, 'rent');
  assert.equal(db.getRentPayments('2026-12').find((r) => r.id === rentPay.id)?.receiptSha, stored.sha256);
  db.deleteRentPayment(rentPay.id, admin);
  assert.equal(db.getRentPayments('2026-12').some((r) => r.id === rentPay.id), false);
  db.deleteRentItem(rentItem.id, admin);
  assert.equal(db.getRentItems().some((r) => r.id === rentItem.id), false);

  const tempLoan = db.issueLoan(
    validateLoanIssueInput({
      employeeId: emp.id,
      issuedDate: '2026-12-07',
      amount: '2000',
      monthlyInstallment: '1000',
      paymentMethod: 'Cash in Hand',
      department: 'EDC-PROJECT',
      head: 'EDC-PROJECT',
      purpose: 'Temp test loan for delete',
      fundSourceId: companyFundSourceId,
    }),
    admin,
  );
  assert.ok(tempLoan.loan.linkedTxId);
  const tempLoanTx = db.getTransactionById(tempLoan.loan.linkedTxId)!;
  db.editTransaction(tempLoanTx.id, validateTransactionInput({
    kind: 'expense',
    txDate: tempLoanTx.txDate,
    amount: '2500',
    department: tempLoanTx.department || 'EDC-PROJECT',
    head: tempLoanTx.head,
    subCategory: tempLoanTx.subCategory,
    paymentMethod: tempLoanTx.paymentMethod,
    referenceNo: tempLoanTx.referenceNo,
    counterparty: tempLoanTx.counterparty,
    purpose: 'Updated test loan purpose',
    employeeId: emp.id,
    employeeName: emp.name,
    categoryGroup: 'loan_issue',
    fundSourceId: companyFundSourceId,
    reason: 'Corrected loan amount and purpose',
  }, true), admin);
  const editedTempLoan = db.getLoans().find((loan) => loan.id === tempLoan.loan.id)!;
  assert.equal(editedTempLoan.principalPaisa, 250_000);
  assert.equal(editedTempLoan.remainingPaisa, 250_000);
  assert.equal(editedTempLoan.purpose, 'Updated test loan purpose');
  assert.throws(() => db.softDeleteTransaction(tempLoanTx.id, 'Test direct void', admin), /linked/i);
  db.deleteLoan(tempLoan.loan.id, admin);
  assert.equal(db.getLoans().some((l) => l.id === tempLoan.loan.id), false);

  const backup = db.exportFullBackup();
  assert.ok(backup.counts.employees >= 7);
  assert.ok(backup.counts.salary_payments >= 6);
  assert.ok(backup.counts.employee_loans >= 3);
  assert.ok(backup.counts.receipt_files >= 1);

  db.restoreFullBackup(backup, admin);
  const restoredReceipt = db.readReceipt(stored.sha256);
  assert.ok(restoredReceipt);
  assert.equal(restoredReceipt.bytes[0], 0x89);
  assert.ok(db.getEmployees().some((e) => e.id === emp.id));
  assert.equal(db.getLoans().find((l) => l.id === issued.loan.id)?.remainingPaisa, 1_000_000);

  const sqliteSnapshot = path.join(TMP_DIR, 'restore-verification.sqlite');
  await createSqliteSnapshot(SQLITE_DATABASE_FILE, sqliteSnapshot);
  const snapshotDb = new DatabaseSync(sqliteSnapshot, { readOnly: true });
  assert.equal(snapshotDb.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
  const snapshotTransactionCount = Number(snapshotDb.prepare('SELECT COUNT(*) AS n FROM transactions').get()?.n || 0);
  snapshotDb.close();
  const sqliteRestore = db.restoreSqliteSnapshot(sqliteSnapshot, admin);
  assert.equal(sqliteRestore.transactionCount, snapshotTransactionCount);
  assert.ok(fs.existsSync(sqliteRestore.previousDatabasePath));
  assert.equal(db.verifyAuditChain().ok, true);
  fs.rmSync(sqliteRestore.previousDatabasePath, { force: true });

  const cleanWipe = db.wipeDatabase(admin, false);
  assert.equal(cleanWipe.factoryReset, false);
  assert.equal(db.needsSetup(), false);
  assert.equal(db.getAllTransactions(true).length, 0);
  assert.equal(db.getEmployees().length, 0);
  assert.equal(db.getSalaryPayments().length, 0);
  assert.equal(db.getLoans().length, 0);
  assert.equal(db.getPeriodLocks().length, 0);
  assert.equal(db.readReceipt(stored.sha256), null);
  assert.ok(db.getHeads().length > 0);
  assert.equal(db.verifyAuditChain().ok, true);

  const fullWipe = db.wipeDatabase(admin, true);
  assert.equal(fullWipe.factoryReset, true);
  assert.equal(db.needsSetup(), true);
  assert.equal(db.listUsers().length, 0);
});

test('latest-wins saver sends the final value last and reports only unsuperseded errors', async () => {
  const { createLatestSaver } = await import('../src/utils/latestSaver');
  const sent: string[] = [];
  const errors: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const save = createLatestSaver<string>(
    async (v) => { sent.push(v); if (sent.length === 1) await gate; if (v === 'bad') throw new Error('x'); },
    (_e, v) => errors.push(v),
  );
  save('dark');
  save('light');
  save('dark');
  save('light');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['dark', 'light']);
  assert.deepEqual(errors, []);
  save('bad');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(errors, ['bad']);
});
