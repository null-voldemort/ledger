import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import XLSX from 'xlsx';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../server/db';
import { DEFAULT_DEPARTMENTS, DEFAULT_EXPENSE_HEADS, DEFAULT_INCOME_HEADS } from '../src/utils/ledger';

const EXCEL_PATH = process.argv[2] || '/tmp/temp-repo/Income&Expense(P).xlsx';
const DB_DIR = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const SQLITE_FILE = path.join(DB_DIR, 'pace_it_ledger.sqlite');

function fmtDate(v: unknown): string {
  if (v instanceof Date) {
    return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  }
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

function computeAuditHash(payload: {
  seq: number;
  at: string;
  actorId: string;
  eventType: string;
  entryId: string;
  voucherNo: string;
  reason: string;
  diffJson: string;
  amountDeltaPaisa: number;
  afterSnapshotJson: string;
  prevHash: string;
}): string {
  const canonical = [
    payload.seq,
    payload.at,
    payload.actorId,
    payload.eventType,
    payload.entryId,
    payload.voucherNo,
    payload.reason,
    payload.diffJson,
    payload.amountDeltaPaisa,
    payload.afterSnapshotJson,
    payload.prevHash,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function empBranchFromCodeName(raw: string): { branch: string; department: string; displayName: string; role: string } {
  const s = raw.trim();
  let branch = 'ALHAMRA-OFFICE';
  let department = 'Operations';
  let short = s;
  if (s.startsWith('ALHAMRA-')) {
    branch = 'ALHAMRA-OFFICE';
    short = s.slice('ALHAMRA-'.length);
  } else if (s.startsWith('BALUCHOR-')) {
    branch = 'BALUCHOR-OFFICE';
    short = s.slice('BALUCHOR-'.length);
  } else if (s.startsWith('SHIBGONJ-')) {
    branch = 'SHIBGONJ-OFFICE';
    short = s.slice('SHIBGONJ-'.length);
  } else if (s.startsWith('DASPARA-')) {
    branch = 'DASPARA-OFFICE';
    short = s.slice('DASPARA-'.length);
  } else if (s.startsWith('SUBID-BZR-')) {
    branch = 'SUBID-BAZAR-OFFICE';
    short = s.slice('SUBID-BZR-'.length);
  }
  const pretty = short
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  let role = 'Field Technician';
  if (short === 'MITHU') { role = 'Operations Lead'; department = 'Management'; }
  else if (short === 'SHOURAV') { role = 'Accounts Manager'; department = 'Accounts & Billing'; }
  else if (['ANHAR', 'SUMON', 'SHIMUL', 'SHIBLU', 'ANIK'].includes(short)) { role = 'Office & Field Staff'; department = 'Head Office'; }
  else if (['RAZON', 'JOSHIM', 'LITON', 'JUKKEL'].includes(short)) { role = 'Branch Supervisor'; department = 'Branch Operations'; }
  return { branch, department, displayName: `${pretty} (${s})`, role };
}

function matchEmployeeKey(rawName: string): string {
  const low = rawName.toLowerCase();
  if (low.includes('mithu')) return 'ALHAMRA-MITHU';
  if (low.includes('shourav') || low.includes('shawrav') || low.includes('shwrav')) return 'ALHAMRA-SHOURAV';
  if (low.includes('shimul')) return 'ALHAMRA-SHIMUL';
  if (low.includes('anhar')) return 'ALHAMRA-ANHAR';
  if (low.includes('shiblu')) return 'ALHAMRA-SHIBLU';
  if (low.includes('anik')) return 'ALHAMRA-ANIK';
  if (low.includes('sumon')) return 'ALHAMRA-SUMON';
  if (low.includes('razon') || low.includes('rajon')) return 'BALUCHOR-RAZON';
  if (low.includes('javed') || low.includes('jabed')) return 'BALUCHOR-JAVED';
  if (low.includes('helal')) return 'BALUCHOR-HELAL';
  if (low.includes('sakib')) return 'BALUCHOR-SAKIB';
  if (low.includes('joshim')) return 'SHIBGONJ-JOSHIM';
  if (low.includes('hassan') || low.includes('hasan')) return 'SHIBGONJ-HASSAN';
  if (low.includes('shahed')) return 'SHIBGONJ-SHAHED';
  if (low.includes('rahman')) return 'SHIBGONJ-RAHMAN';
  if (low.includes('liton')) return 'DASPARA-LITON';
  if (low.includes('rahat')) return 'DASPARA-RAHAT';
  if (low.includes('nikul')) return 'DASPARA-NIKUL';
  if (low.includes('rejuwan') || low.includes('rejwan') || low.includes('khaled')) return 'DASPARA-REJUWAN';
  if (low.includes('jukkel')) return 'SUBID-BZR-JUKKEL';
  if (low.includes('samraj')) return 'SUBID-BZR-SAMRAJ';
  if (low.includes('munna')) return 'SUBID-BZR-MUNNA';
  if (low.includes('nur')) return 'SUBID-BZR-NUR-HUSSAIN';
  if (low.includes('jayed')) return 'SUBID-BZR-JAYED';
  if (low.includes('limon')) return 'SUBID-BZR-LIMON';
  if (low.includes('hridoy')) return 'SUBID-BZR-HRIDOY';
  return '';
}

function rentDepartmentForName(name: string): string {
  const low = name.toLowerCase();
  if (low.includes('shibgonj')) return 'SHIBGONJ-OFFICE';
  if (low.includes('bottessor')) return 'BOTESSOR-OFFICE';
  if (low.includes('baluchor')) return 'BALUCHOR-OFFICE';
  if (low.includes('daspara') || low.includes('nipubon')) return 'DASPARA-OFFICE';
  if (low.includes('subid')) return 'SUBID-BAZAR-OFFICE';
  if (low.includes('al hamra') || low.includes('vat') || low.includes('bick') || low.includes('sms')) return 'ALHAMRA-OFFICE';
  if (low.includes('home') || low.includes('tution')) return 'OWNER';
  return 'OTHERS-COMPANY';
}

type ColRow = Record<string, any> & { __rowNum__?: number };

async function run() {
  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`Workbook not found at ${EXCEL_PATH}`);
  }
  await db.ready();

  const wb = XLSX.read(fs.readFileSync(EXCEL_PATH), { type: 'buffer', cellDates: true });
  const expSheet = XLSX.utils.sheet_to_json<ColRow>(wb.Sheets['Expense'], { header: 'A', blankrows: false });
  const salSheet = XLSX.utils.sheet_to_json<ColRow>(wb.Sheets['salary'], { header: 'A', blankrows: false });
  const rentSheet = XLSX.utils.sheet_to_json<ColRow>(wb.Sheets['Rent'], { header: 'A', blankrows: false });

  interface ExcelIncome {
    rowNum: number;
    txDate: string;
    manager: string;
    details: string;
    amountPaisa: number;
  }
  interface ExcelExpense {
    rowNum: number;
    txDate: string;
    department: string;
    details: string;
    amountPaisa: number;
    fundSourceKey: 'Boss' | 'Company Revenue';
  }

  const incomes: ExcelIncome[] = [];
  const expenses: ExcelExpense[] = [];
  let lastIncDate = '2026-11-01';
  let lastExpDate = '2026-11-01';

  for (const r of expSheet) {
    const rowNum = Number(r.__rowNum__ ?? 0) + 1;
    if (rowNum < 9) continue;
    const iDt = fmtDate(r.B);
    if (iDt) lastIncDate = iDt;
    if (r.B || r.D || r.E) {
      const details = String(r.D || '').trim();
      const amountPaisa = Math.round(Number(r.E || 0) * 100);
      if (amountPaisa > 0) {
        incomes.push({
          rowNum,
          txDate: details === 'Previous Month' ? '2026-10-31' : lastIncDate,
          manager: String(r.C || 'SHOUROV').trim() || 'SHOUROV',
          details,
          amountPaisa,
        });
      }
    }
    const eDt = fmtDate(r.G);
    if (eDt) lastExpDate = eDt;
    if (r.G || r.H || r.I || r.J) {
      const details = String(r.I || '').trim();
      const amountPaisa = Math.round(Number(r.J || 0) * 100);
      if (amountPaisa > 0) {
        expenses.push({
          rowNum,
          txDate: lastExpDate,
          department: String(r.H || '').trim(),
          details,
          amountPaisa,
          fundSourceKey: 'Company Revenue',
        });
      }
    }
  }

  const bossIncomeTotal = incomes
    .filter((i) => i.details === 'OWNER-CASH')
    .reduce((s, i) => s + i.amountPaisa, 0);
  const coIncomeTotal = incomes
    .filter((i) => i.details !== 'OWNER-CASH')
    .reduce((s, i) => s + i.amountPaisa, 0);

  let bossRemainingCap = bossIncomeTotal - 105800;
  for (const e of expenses) {
    if (e.department === 'OWNER' && e.amountPaisa <= bossRemainingCap) {
      e.fundSourceKey = 'Boss';
      bossRemainingCap -= e.amountPaisa;
    } else {
      e.fundSourceKey = 'Company Revenue';
    }
  }
  const nonOwnerExpenses = expenses.filter((e) => e.fundSourceKey !== 'Boss');
  let coUsed = nonOwnerExpenses.reduce((s, e) => s + e.amountPaisa, 0);
  for (const e of nonOwnerExpenses) {
    if (coUsed <= coIncomeTotal) break;
    if (e.amountPaisa <= bossRemainingCap) {
      e.fundSourceKey = 'Boss';
      bossRemainingCap -= e.amountPaisa;
      coUsed -= e.amountPaisa;
    }
  }
  if (coUsed > coIncomeTotal) {
    throw new Error(`Unable to balance Company Revenue fund source within income limit (${coUsed} > ${coIncomeTotal})`);
  }

  const sqlite = new DatabaseSync(SQLITE_FILE);
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA synchronous = FULL');
  sqlite.exec('PRAGMA foreign_keys = OFF');

  const now = new Date().toISOString();
  const actorId = 'excel-shourov';
  const actorName = 'SHOUROV';
  const actorRole = 'user';

  const adminRow = sqlite.prepare("SELECT id, display_name FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get() as { id: string; display_name: string } | undefined;
  const adminName = adminRow?.display_name || 'Admin';

  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const tablesToReset = [
      'departments',
      'ledger_heads',
      'fund_sources',
      'employees',
      'transactions',
      'salary_payments',
      'employee_advances',
      'salary_advance_repayments',
      'employee_loans',
      'loan_repayments',
      'rent_items',
      'rent_payments',
      'period_locks',
      'ledger_audit',
      'receipt_files',
      'activity',
    ];
    for (const t of tablesToReset) {
      sqlite.exec(`DELETE FROM ${t}`);
    }
    sqlite.exec("DELETE FROM sqlite_sequence WHERE name = 'ledger_audit'");

    const insDept = sqlite.prepare('INSERT INTO departments (id, name, description, active, sort_order) VALUES (?, ?, ?, 1, ?)');
    for (const d of DEFAULT_DEPARTMENTS) {
      insDept.run(crypto.randomUUID(), d.name, d.description, d.sortOrder);
    }

    const extraIncomeHeads = [
      { kind: 'income', name: 'PREVIOUS-MONTH', description: 'Opening cash carry-forward from prior period', active: 1, sortOrder: 10 },
      { kind: 'income', name: 'NETWORK-BAZAR', description: 'Network Bazar direct cash collection', active: 1, sortOrder: 11 },
    ];
    const insHead = sqlite.prepare('INSERT OR IGNORE INTO ledger_heads (id, kind, name, description, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    for (const h of [...DEFAULT_INCOME_HEADS, ...extraIncomeHeads, ...DEFAULT_EXPENSE_HEADS]) {
      insHead.run(crypto.randomUUID(), h.kind, h.name, h.description || '', h.active ? 1 : 0, h.sortOrder);
    }

    const bossId = crypto.randomUUID();
    const companyRevenueId = crypto.randomUUID();
    const otherIncomeId = crypto.randomUUID();
    const insSource = sqlite.prepare('INSERT INTO fund_sources (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)');
    insSource.run(bossId, 'Boss', now, now);
    insSource.run(companyRevenueId, 'Company Revenue', now, now);
    insSource.run(otherIncomeId, 'Other Income', now, now);

    const empMap = new Map<string, { id: string; code: string; name: string; branch: string; salaryPaisa: number }>();
    const insEmp = sqlite.prepare(
      `INSERT INTO employees (id, code, name, role, department, branch, phone, email, photo_url, monthly_salary_paisa, joined_date, active, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', '', ?, '2026-10-01', 1, '', ?, ?)`,
    );
    let empSeq = 1;
    for (const r of salSheet) {
      const rowNum = Number(r.__rowNum__ ?? 0) + 1;
      if (rowNum < 8 || rowNum > 33) continue;
      if (!r.C) continue;
      const codeKey = String(r.C).trim();
      const salaryPaisa = Math.round(Number(r.D || 0) * 100);
      const id = crypto.randomUUID();
      const code = `EMP-${String(empSeq++).padStart(3, '0')}`;
      const info = empBranchFromCodeName(codeKey);
      insEmp.run(id, code, info.displayName, info.role, info.department, info.branch, salaryPaisa, now, now);
      empMap.set(codeKey, { id, code, name: info.displayName, branch: info.branch, salaryPaisa });
    }

    let prevHash = 'GENESIS_PACE_IT_LEDGER';
    let auditSeq = 0;
    const insAudit = sqlite.prepare(
      `INSERT INTO ledger_audit (seq, at, actor_id, actor_name, actor_role, event_type, entry_id, voucher_no, reason, diff_json, amount_delta_paisa, after_snapshot_json, prev_hash, entry_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insTx = sqlite.prepare(
      `INSERT INTO transactions (
        id, voucher_no, kind, tx_date, amount_paisa, department, department_review, head, sub_category, payment_method, reference_no,
        counterparty, counterparty_phone, purpose, notes, funded_by_tx_id, employee_id, employee_name, category_group, fund_source_id,
        receipt_sha, receipt_name, receipt_type, status, verified_by_name, verified_at, flag_note,
        edit_count, amount_changed, last_edited_at, last_edited_by, last_edit_reason, edit_history_json,
        created_at, created_by_id, created_by_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '', ?, ?, ?, ?, '', '', '', 'verified', ?, ?, '', 0, 0, '', '', '', '[]', ?, ?, ?, ?)`,
    );

    const insertTxWithAudit = (p: {
      kind: 'income' | 'expense';
      voucherNo: string;
      txDate: string;
      amountPaisa: number;
      department: string;
      departmentReview: boolean;
      head: string;
      subCategory: string;
      paymentMethod: string;
      referenceNo: string;
      counterparty: string;
      purpose: string;
      notes: string;
      employeeId: string;
      employeeName: string;
      categoryGroup: string;
      fundSourceId: string;
      createdAt: string;
    }): string => {
      const id = crypto.randomUUID();
      insTx.run(
        id,
        p.voucherNo,
        p.kind,
        p.txDate,
        p.amountPaisa,
        p.department,
        p.departmentReview ? 1 : 0,
        p.head,
        p.subCategory,
        p.paymentMethod,
        p.referenceNo,
        p.counterparty,
        p.purpose,
        p.notes,
        p.employeeId,
        p.employeeName,
        p.categoryGroup,
        p.fundSourceId,
        adminName,
        now,
        p.createdAt,
        actorId,
        actorName,
        now,
      );
      auditSeq += 1;
      const snap = JSON.stringify({
        id,
        voucherNo: p.voucherNo,
        kind: p.kind,
        txDate: p.txDate,
        amountPaisa: p.amountPaisa,
        department: p.department || '',
        head: p.head,
        subCategory: p.subCategory,
        paymentMethod: p.paymentMethod,
        referenceNo: p.referenceNo,
        counterparty: p.counterparty,
        purpose: p.purpose,
        fundSourceId: p.fundSourceId,
        status: 'verified',
        deletedAt: '',
      });
      const delta = p.kind === 'income' ? p.amountPaisa : -p.amountPaisa;
      const entryHash = computeAuditHash({
        seq: auditSeq,
        at: p.createdAt,
        actorId,
        eventType: 'tx_created',
        entryId: id,
        voucherNo: p.voucherNo,
        reason: p.purpose,
        diffJson: '[]',
        amountDeltaPaisa: delta,
        afterSnapshotJson: snap,
        prevHash,
      });
      insAudit.run(auditSeq, p.createdAt, actorId, actorName, actorRole, 'tx_created', id, p.voucherNo, p.purpose, '[]', delta, snap, prevHash, entryHash);
      prevHash = entryHash;
      return id;
    };

    let incCounter = 0;
    for (const row of incomes) {
      incCounter += 1;
      const voucherNo = `INC-2026-${String(incCounter).padStart(4, '0')}`;
      const isBoss = row.details === 'OWNER-CASH';
      const isPrev = row.details === 'Previous Month';
      const isAtm = row.details === 'BRAC-BANK-ATM';
      const isTransfer = row.details === 'BRAC-BANK-TRANSFER';
      const head = isPrev ? 'PREVIOUS-MONTH' : isBoss ? 'OWNER-CASH' : isAtm ? 'BRAC-BANK-ATM' : isTransfer ? 'BRAC-BANK-TRANSFER' : 'NETWORK-BAZAR';
      const department = isBoss ? 'OWNER' : 'ALHAMRA-OFFICE';
      const paymentMethod = isBoss || isPrev || row.details === 'NETWORK-BAZAR' ? 'Cash in Hand' : isAtm ? 'BRAC Bank ATM' : 'BRAC Bank Transfer';
      const counterparty = isPrev ? 'Opening Cash Balance' : isBoss ? 'Owner / Managing Director' : isAtm ? 'BRAC Bank Corporate ATM' : isTransfer ? 'BRAC Bank Transfer' : 'Network Bazar Desk';
      const purpose = isPrev ? 'Opening cash carry-forward from October 2026' : `Excel Income Entry (${row.details}) — Manager: ${row.manager}`;
      insertTxWithAudit({
        kind: 'income',
        voucherNo,
        txDate: row.txDate,
        amountPaisa: row.amountPaisa,
        department,
        departmentReview: false,
        head,
        subCategory: isPrev ? 'Opening Carry Forward' : isBoss ? 'Owner Capital Deposit' : 'Bank / Collection Transfer',
        paymentMethod,
        referenceNo: `XLS-INC-R${row.rowNum}`,
        counterparty,
        purpose,
        notes: `Imported from Expense!B${row.rowNum}:E${row.rowNum}`,
        employeeId: '',
        employeeName: '',
        categoryGroup: 'general',
        fundSourceId: isBoss ? bossId : companyRevenueId,
        createdAt: `${row.txDate}T08:${String(incCounter % 60).padStart(2, '0')}:00.000Z`,
      });
    }

    const insAdvance = sqlite.prepare(
      `INSERT INTO employee_advances (id, advance_no, employee_id, employee_name, month_key, issued_date, principal_paisa, remaining_paisa, department, purpose, fund_source_id, linked_tx_id, linked_voucher_no, status, created_by_id, created_by_name, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insAdvRepay = sqlite.prepare(
      'INSERT INTO salary_advance_repayments (id, advance_id, salary_payment_id, paid_date, amount_paisa, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insSalary = sqlite.prepare(
      `INSERT INTO salary_payments (
        id, employee_id, employee_name, month_key, paid_date, base_salary_paisa, bonus_paisa, loan_deduction_paisa, advance_deduction_paisa, other_deduction_paisa,
        net_paid_paisa, payment_method, reference_no, department, head, fund_source_id, notes, receipt_sha, receipt_name, receipt_type, linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?)`,
    );
    const insLoan = sqlite.prepare(
      `INSERT INTO employee_loans (
        id, loan_no, employee_id, employee_name, issued_date, principal_paisa, remaining_paisa, monthly_installment_paisa,
        payment_method, reference_no, department, head, fund_source_id, purpose, status, receipt_sha, receipt_name, receipt_type, linked_tx_id, linked_voucher_no, issued_by_id, issued_by_name, created_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?, '')`,
    );
    const insLoanRepay = sqlite.prepare(
      `INSERT INTO loan_repayments (
        id, loan_id, paid_date, amount_paisa, source, fund_source_id, department, payment_method, reference_no, note, salary_payment_id, receipt_sha, receipt_name, receipt_type, linked_tx_id, linked_voucher_no, recorded_by_id, recorded_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', '', '', '', ?, ?, ?)`,
    );
    const insRentItem = sqlite.prepare(
      `INSERT INTO rent_items (id, sl, name, category, monthly_amount_paisa, urgent_amount_paisa, department, notes, active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?, ?)`,
    );
    const insRentPay = sqlite.prepare(
      `INSERT INTO rent_payments (
        id, rent_item_id, rent_item_name, month_key, paid_date, amount_paisa, department, fund_source_id, payment_method, reference_no, notes, receipt_sha, receipt_name, receipt_type, linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, ?, ?, ?)`,
    );

    const rentItemsBySl = new Map<number, { id: string; name: string; department: string }>();
    for (const r of rentSheet) {
      const rowNum = Number(r.__rowNum__ ?? 0) + 1;
      if (rowNum < 8 || !r.C) continue;
      const slNum = Number(r.B);
      if (!Number.isFinite(slNum) || slNum <= 0) continue;
      const sl = Math.round(slNum);
      const name = String(r.C).trim();
      const monthlyPaisa = Math.round(Number(r.D || 0) * 100);
      const urgentPaisa = Math.round(Number(r.E || 0) * 100);
      const category = urgentPaisa > 0 && monthlyPaisa === 0 ? 'urgent' : 'regular';
      const department = rentDepartmentForName(name);
      const id = crypto.randomUUID();
      insRentItem.run(id, sl, name, category, monthlyPaisa, urgentPaisa, department, sl, now, now);
      rentItemsBySl.set(sl, { id, name, department });
    }

    const rowRentSlMap: Record<number, number> = {
      87: 11,
      109: 12,
      110: 5,
      159: 1,
      160: 3,
      161: 4,
      162: 2,
      163: 6,
      168: 15,
    };

    const octAdvanceRows: { id: string; empKey: string; amountPaisa: number; issuedDate: string }[] = [];
    let advSeq = 0;
    for (const r of salSheet) {
      const rowNum = Number(r.__rowNum__ ?? 0) + 1;
      if (rowNum < 8 || rowNum > 31) continue;
      if (!r.H || !r.I || !r.K) continue;
      const issuedDate = fmtDate(r.H);
      const rawTag = String(r.I).trim();
      const amountPaisa = Math.round(Number(r.K || 0) * 100);
      const empKey = matchEmployeeKey(rawTag);
      const emp = empMap.get(empKey);
      if (!emp || amountPaisa <= 0 || !issuedDate) continue;
      advSeq += 1;
      const advId = crypto.randomUUID();
      const advNo = `ADV-2026-${String(advSeq).padStart(4, '0')}`;
      insAdvance.run(
        advId,
        advNo,
        emp.id,
        emp.name,
        '2026-10',
        issuedDate,
        amountPaisa,
        amountPaisa,
        emp.branch,
        `October cycle historical advance (${rawTag})`,
        '',
        '',
        '',
        'active',
        actorId,
        actorName,
        `${issuedDate}T10:00:00.000Z`,
        '',
      );
      octAdvanceRows.push({ id: advId, empKey, amountPaisa, issuedDate });
    }

    const expAdvRows = new Set([47, 56, 57, 83, 102, 177, 187, 243, 255, 256, 258, 286, 306]);
    const expSalRows = new Set<number>([170]);
    for (let n = 113; n <= 123; n++) expSalRows.add(n);
    for (let n = 132; n <= 145; n++) expSalRows.add(n);
    const expLoanRows = new Set([53, 176, 189, 257]);

    const loansByEmpKey = new Map<string, string>();
    const preNovLoans = [
      { empKey: 'ALHAMRA-SUMON', date: '2026-10-01', principalPaisa: 800000, remainingPaisa: 600000, purpose: 'Personal loan (pre-November Excel LONE sheet)' },
      { empKey: 'ALHAMRA-ANHAR', date: '2026-10-14', principalPaisa: 500000, remainingPaisa: 500000, purpose: 'Personal loan (pre-November Excel LONE sheet)' },
    ];
    let loanSeq = 0;
    for (const pl of preNovLoans) {
      const emp = empMap.get(pl.empKey)!;
      loanSeq += 1;
      const loanId = crypto.randomUUID();
      const loanNo = `LN-2026-${String(loanSeq).padStart(4, '0')}`;
      insLoan.run(
        loanId,
        loanNo,
        emp.id,
        emp.name,
        pl.date,
        pl.principalPaisa,
        pl.remainingPaisa,
        'Cash in Hand',
        loanNo,
        emp.branch,
        emp.branch,
        '',
        pl.purpose,
        'active',
        '',
        '',
        actorId,
        actorName,
        `${pl.date}T11:00:00.000Z`,
      );
      loansByEmpKey.set(`${pl.empKey}:${pl.date}`, loanId);
    }

    const salPayIdsByEmpKey = new Map<string, string>();
    let expCounter = 0;
    for (const row of expenses) {
      expCounter += 1;
      const voucherNo = `EXP-2026-${String(expCounter).padStart(4, '0')}`;
      const fsId = row.fundSourceKey === 'Boss' ? bossId : companyRevenueId;
      const isAdv = expAdvRows.has(row.rowNum);
      const isSal = expSalRows.has(row.rowNum);
      const isLoan = expLoanRows.has(row.rowNum);
      const rentSl = rowRentSlMap[row.rowNum];
      const rentItem = rentSl ? rentItemsBySl.get(rentSl) : undefined;
      const isRent = Boolean(rentItem);

      let categoryGroup = 'general';
      let empId = '';
      let empName = '';
      let subCategory = 'General Expense';
      let head = row.department || 'OTHER-EXPENSE';

      if (isAdv || isSal || isLoan) {
        const empKey = matchEmployeeKey(row.details);
        const emp = empMap.get(empKey);
        if (emp) {
          empId = emp.id;
          empName = emp.name;
        }
        if (isAdv) {
          categoryGroup = 'salary_advance';
          subCategory = 'Salary Advance';
          head = row.department || 'SALARY-ADVANCE';
        } else if (isSal) {
          categoryGroup = 'salary';
          subCategory = 'Employee Salary';
          head = row.department || 'SALARY-PAYROLL';
        } else if (isLoan) {
          categoryGroup = 'loan_issue';
          subCategory = 'Employee Loan';
          head = row.department || 'EMPLOYEE-LOAN';
        }
      } else if (isRent) {
        categoryGroup = 'rent';
        subCategory = 'Office Rent & Utility';
      } else if (/meter|recharge|electric/i.test(row.details)) {
        subCategory = 'Electricity & Utility';
      } else if (/bhara|fuel|bike|petrol|travel|road/i.test(row.details)) {
        subCategory = 'Transport & Conveyance';
      } else if (/onu|router|fiber|cable|switch|tj|patch|splitter|adapter|spool/i.test(row.details)) {
        subCategory = 'Hardware & Network Materials';
      } else if (/khoros|nasta|tea|food|lunch/i.test(row.details)) {
        subCategory = 'Field & Office Khoros';
      }

      const counterparty = empName || (rentItem ? rentItem.name : row.details.split(/[(\n]/)[0].trim().slice(0, 80) || 'Vendor / Expense');
      const createdAt = `${row.txDate}T12:${String(expCounter % 60).padStart(2, '0')}:00.000Z`;
      const txId = insertTxWithAudit({
        kind: 'expense',
        voucherNo,
        txDate: row.txDate,
        amountPaisa: row.amountPaisa,
        department: row.department,
        departmentReview: !row.department,
        head,
        subCategory,
        paymentMethod: 'Cash in Hand',
        referenceNo: `XLS-EXP-R${row.rowNum}`,
        counterparty,
        purpose: row.details,
        notes: row.department ? `Imported from Expense!G${row.rowNum}:J${row.rowNum}` : `Imported uncategorized Excel expense (Expense!G${row.rowNum}:J${row.rowNum}) — assign Department`,
        employeeId: empId,
        employeeName: empName,
        categoryGroup,
        fundSourceId: fsId,
        createdAt,
      });

      if (isAdv && empId) {
        const empKey = matchEmployeeKey(row.details);
        const monthKey = row.rowNum <= 102 ? '2026-10' : '2026-11';
        advSeq += 1;
        const advId = crypto.randomUUID();
        const advNo = `ADV-2026-${String(advSeq).padStart(4, '0')}`;
        insAdvance.run(
          advId,
          advNo,
          empId,
          empName,
          monthKey,
          row.txDate,
          row.amountPaisa,
          row.amountPaisa,
          row.department,
          row.details,
          fsId,
          txId,
          voucherNo,
          'active',
          actorId,
          actorName,
          createdAt,
          '',
        );
        if (monthKey === '2026-10') {
          octAdvanceRows.push({ id: advId, empKey, amountPaisa: row.amountPaisa, issuedDate: row.txDate });
        }
      } else if (isSal && empId) {
        const empKey = matchEmployeeKey(row.details);
        const emp = empMap.get(empKey)!;
        const isKhaledReplacement = row.rowNum === 144;
        const salId = crypto.randomUUID();
        insSalary.run(
          salId,
          empId,
          empName,
          '2026-10',
          row.txDate,
          emp.salaryPaisa,
          isKhaledReplacement ? row.amountPaisa : 0,
          0,
          row.amountPaisa,
          'Cash in Hand',
          `XLS-EXP-R${row.rowNum}`,
          row.department,
          row.department,
          fsId,
          isKhaledReplacement ? 'Khaled Salary - 7 day (Daspara replacement)' : row.details,
          txId,
          voucherNo,
          actorId,
          actorName,
          createdAt,
        );
        if (!isKhaledReplacement) {
          salPayIdsByEmpKey.set(empKey, salId);
        }
      } else if (isLoan && empId) {
        const empKey = matchEmployeeKey(row.details);
        loanSeq += 1;
        const loanId = crypto.randomUUID();
        const loanNo = `LN-2026-${String(loanSeq).padStart(4, '0')}`;
        const isHelal = row.rowNum === 53;
        const remainingPaisa = isHelal ? row.amountPaisa - 250000 : row.amountPaisa;
        insLoan.run(
          loanId,
          loanNo,
          empId,
          empName,
          row.txDate,
          row.amountPaisa,
          remainingPaisa,
          'Cash in Hand',
          `XLS-EXP-R${row.rowNum}`,
          row.department,
          row.department,
          fsId,
          row.details,
          'active',
          txId,
          voucherNo,
          actorId,
          actorName,
          createdAt,
        );
        loansByEmpKey.set(`${empKey}:${row.txDate}`, loanId);
      } else if (rentItem) {
        insRentPay.run(
          crypto.randomUUID(),
          rentItem.id,
          rentItem.name,
          '2026-11',
          row.txDate,
          row.amountPaisa,
          row.department,
          fsId,
          'Cash in Hand',
          `XLS-EXP-R${row.rowNum}`,
          row.details,
          txId,
          voucherNo,
          actorId,
          actorName,
          createdAt,
        );
      }
    }

    const unsettledOctEmpKeys = new Set(['SHIBGONJ-RAHMAN', 'ALHAMRA-SUMON', 'BALUCHOR-HELAL', 'DASPARA-NIKUL']);
    const updAdvSettled = sqlite.prepare("UPDATE employee_advances SET remaining_paisa = 0, status = 'settled', settled_at = ? WHERE id = ?");
    const updSalAdvDed = sqlite.prepare('UPDATE salary_payments SET advance_deduction_paisa = advance_deduction_paisa + ? WHERE id = ?');
    for (const adv of octAdvanceRows) {
      if (unsettledOctEmpKeys.has(adv.empKey)) continue;
      const salId = salPayIdsByEmpKey.get(adv.empKey);
      if (!salId) continue;
      const paidDate = String((sqlite.prepare('SELECT paid_date FROM salary_payments WHERE id = ?').get(salId) as any)?.paid_date || '2026-11-11');
      updAdvSettled.run(`${paidDate}T14:00:00.000Z`, adv.id);
      insAdvRepay.run(crypto.randomUUID(), adv.id, salId, paidDate, adv.amountPaisa, now);
      updSalAdvDed.run(adv.amountPaisa, salId);
    }

    const helalLoanId = loansByEmpKey.get('BALUCHOR-HELAL:2026-11-04');
    if (helalLoanId) {
      insLoanRepay.run(
        crypto.randomUUID(),
        helalLoanId,
        '2026-11-11',
        250000,
        'historical',
        '',
        'BALUCHOR-OFFICE',
        'Historical Sheet Adjustment',
        'XLS-LONE-HELAL',
        'Excel LONE sheet repayment (BALUCHOR-HELAL-PAID)',
        actorId,
        actorName,
        '2026-11-11T15:00:00.000Z',
      );
    }
    const sumonLoanId = loansByEmpKey.get('ALHAMRA-SUMON:2026-10-01');
    if (sumonLoanId) {
      insLoanRepay.run(
        crypto.randomUUID(),
        sumonLoanId,
        '2026-11-11',
        200000,
        'historical',
        '',
        'ALHAMRA-OFFICE',
        'Historical Sheet Adjustment',
        'XLS-LONE-SUMON',
        'Excel LONE sheet repayment (ALHAMRA-SUMON-PAID)',
        actorId,
        actorName,
        '2026-11-11T15:05:00.000Z',
      );
    }

    sqlite.exec('COMMIT');
  } catch (err) {
    try { sqlite.exec('ROLLBACK'); } catch { }
    throw err;
  } finally {
    sqlite.close();
  }
}

run()
  .then(() => {
    console.log('Migration complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
