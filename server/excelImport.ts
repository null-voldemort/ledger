// Excel import: read the "Income & Expense" workbook into an editable PLAN, re-validate
// that plan as often as the admin edits it, and only then write it, all-or-nothing,
// through the same audited code paths the normal entry screens use.
//
// Nothing in this file writes to the database except commitImportPlan().

import crypto from 'node:crypto';
import type { AppUser, Employee, FundSource, RentItem } from '../src/types';
import type {
  FundProjection,
  ImportPlan,
  ImportValidation,
  PlanEmployee,
  PlanEntry,
  PlanLoan,
  PlanLoanRepayment,
  PlanRentItem,
  PlanSalaryPayment,
  ReconcileLine,
  RowIssue,
} from '../src/utils/importPlan';
import { fromPaisa, toPaisa } from '../src/utils/money';
import { DEFAULT_DEPARTMENTS, DEFAULT_EXPENSE_HEADS, DEFAULT_INCOME_HEADS, dhakaMonth } from '../src/utils/ledger';
import {
  validateEmployeeInput,
  validateLoanIssueInput,
  validateLoanRepayInput,
  validateRentItemInput,
  validateSalaryAdvanceInput,
  validateSalaryPayInput,
  validateTransactionInput,
  isIsoDate,
} from './validation';

export type Grid = unknown[][];
export type Grids = Record<string, Grid>;

// ---------------------------------------------------------------------------------------
// Reading the workbook
// ---------------------------------------------------------------------------------------

export async function readWorkbookGrids(buf: Buffer): Promise<Grids> {
  if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error('This does not look like an Excel .xlsx file.');
  }
  const XLSX: any = await import('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellFormula: false });
  const grids: Grids = {};
  for (const name of wb.SheetNames as string[]) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    // sheet_to_json starts at the first row/column of the used range; restore real positions.
    const padded: unknown[][] = [];
    for (let i = 0; i < range.s.r; i++) padded.push([]);
    for (const row of rows) padded.push([...new Array(range.s.c).fill(null), ...row]);
    grids[name] = padded;
  }
  return grids;
}

function sheet(grids: Grids, name: string): Grid | null {
  const key = Object.keys(grids).find((k) => k.trim().toLowerCase() === name.toLowerCase());
  return key ? grids[key] : null;
}

/** 1-based row, 1-based column (A=1), like Excel. */
function at(grid: Grid, row: number, col: number): unknown {
  const r = grid[row - 1];
  if (!r) return null;
  const v = r[col - 1];
  return v === undefined ? null : v;
}

function colLetter(col: number): string {
  let s = '';
  let n = col;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[৳,\s]/g, '');
    if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
  }
  return null;
}

/** Excel serial, Date, or text date -> YYYY-MM-DD ('' if it is not a date). */
export function toIsoDate(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const ms = Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return isIsoDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : '';
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (m) {
      const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return isIsoDate(iso) ? iso : '';
    }
  }
  return '';
}

function taka(n: number): string {
  return fromPaisa(Math.round(n * 100));
}

function paisaOf(s: string): number | null {
  return toPaisa(s);
}

// ---------------------------------------------------------------------------------------
// Names, aliases, classification
// ---------------------------------------------------------------------------------------

const BRANCH_PREFIXES: [string, string][] = [
  ['SUBID-BZR', 'SUBID-BAZAR-OFFICE'],
  ['SUBID-BAZAR', 'SUBID-BAZAR-OFFICE'],
  ['ALHAMRA', 'ALHAMRA-OFFICE'],
  ['BALUCHOR', 'BALUCHOR-OFFICE'],
  ['SHIBGONJ', 'SHIBGONJ-OFFICE'],
  ['DASPARA', 'DASPARA-OFFICE'],
  ['SHAPORAN', 'SHAPORAN-OFFICE'],
  ['BOTESSOR', 'BOTESSOR-OFFICE'],
  ['BOTTESSOR', 'BOTESSOR-OFFICE'],
  ['AMBORKHANA', 'AMBORKHANA-OFFICE'],
  ['EDC', 'EDC-PROJECT'],
];

// Spelling variants of the same first name that appear across the sheets.
const NAME_ALIASES: Record<string, string> = {
  shawrav: 'shourav', shourov: 'shourav', sourov: 'shourav', shourav: 'shourav',
  rajon: 'razon', razon: 'razon',
  jabed: 'javed', javed: 'javed',
  hasan: 'hassan', hassan: 'hassan',
  rejwan: 'rejuwan', rejuwan: 'rejuwan',
  jukkel: 'jukkel', jukel: 'jukkel',
};

function canonToken(t: string): string {
  const k = t.toLowerCase().replace(/[^a-z]/g, '');
  return NAME_ALIASES[k] || k;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function splitEmployeeKey(key: string): { branch: string; rest: string } {
  const up = key.trim().toUpperCase().replace(/\s+/g, '-');
  for (const [prefix, dept] of BRANCH_PREFIXES) {
    if (up === prefix) return { branch: dept, rest: '' };
    if (up.startsWith(prefix + '-')) return { branch: dept, rest: up.slice(prefix.length + 1) };
  }
  return { branch: '', rest: up };
}

function normKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stripLabelSuffix(label: string): string {
  return label.replace(/[\s-]*(SALARY|LONE|LOAN|PAID|ADVANCE|ADV)\s*$/i, '').trim();
}

function employeeTokens(key: string): string[] {
  return splitEmployeeKey(key).rest.split('-').map(canonToken).filter((t) => t.length >= 3);
}

/** Resolve a free-text label ("SHIBGONJ-RAHMAN-SALARY") to one employee key, or '' if unsure. */
function resolveEmployeeKey(label: string, keys: string[]): string {
  const stripped = normKey(stripLabelSuffix(label));
  if (!stripped) return '';
  const exact = keys.find((k) => normKey(k) === stripped);
  if (exact) return exact;
  const want = employeeTokens(stripped);
  if (!want.length) return '';
  const hits = keys.filter((k) => {
    const have = employeeTokens(k);
    return want.every((w) => have.includes(w));
  });
  return hits.length === 1 ? hits[0] : '';
}

/** Find the one employee named inside a cash-book description such as "Jukkel Salary Advance". */
function employeeInText(details: string, keys: string[]): string {
  const words = details.split(/[^A-Za-z]+/).map(canonToken).filter((w) => w.length >= 3);
  const hits = keys.filter((k) => employeeTokens(k).some((t) => words.includes(t)));
  return hits.length === 1 ? hits[0] : '';
}

const PAYMENT_BY_HEAD: Record<string, string> = {
  'BRAC-BANK-ATM': 'BRAC Bank ATM',
  'BRAC-BANK-CHEQUE': 'Bank Cheque',
  'BRAC-BANK-TRANSFER': 'BRAC Bank Transfer',
};

function canonicalHead(raw: string, list: { name: string }[]): string {
  const hit = list.find((h) => normKey(h.name) === normKey(raw));
  return hit ? hit.name : raw.trim();
}

function canonicalDepartment(raw: string): string {
  const hit = DEFAULT_DEPARTMENTS.find((d) => normKey(d.name) === normKey(raw));
  return hit ? hit.name : raw.trim();
}

function classifyExpense(details: string, dept: string): string {
  const d = details.toLowerCase();
  const u = dept.toUpperCase();
  if (/\b(salary|adv|advance|loan|lone|bonus)\b/.test(d)) return 'Salary & Staff Allowance';
  if (u === 'OWNER') return 'Owner Settlement';
  if (u === 'UPSTREAM') return 'Internet & Upstream Bill';
  if (/\brent\b|service charge/.test(d)) return 'Office Rent & Service Charge';
  if (/recharge|electric|\bgas\b|water|\bcurrent\b/.test(d)) return 'Electricity, Water & Gas';
  if (/\b(bhara|fare|conveyance|transport|fuel|petrol|cng|rickshaw|road|bus|truck|van)\b/.test(d)) return 'Transport & Conveyance';
  if (/fiber|fibre|\bonu\b|router|cable|splitter|patch|connector|\bsfp\b|pigtail/.test(d)) return 'Fiber, ONU & Router Hardware';
  if (/internet|bandwidth|upstream|\bip\b/.test(d)) return 'Internet & Upstream Bill';
  if (/food|lunch|tea|snack|biscuit|refresh|\bwater bottle\b/.test(d)) return 'Food & Refreshment';
  if (/repair|maintenance|service|fix/.test(d)) return 'Maintenance & Repair';
  if (u === 'EDC-PROJECT') return 'Field Work & Installations';
  if (u === 'OTHERS-COMPANY') return 'Vendor / Company Payment';
  return 'Miscellaneous';
}

function classifyIncome(head: string): { subCategory: string; payment: string; counterparty: string; purpose: string } {
  const key = normKey(head);
  const payment = PAYMENT_BY_HEAD[key] || 'Cash in Hand';
  if (key === 'PREVIOUS-MONTH') {
    return { subCategory: 'Opening Balance', payment, counterparty: 'Previous month', purpose: 'Balance carried forward from the previous month' };
  }
  if (key === 'OWNER-CASH') {
    return { subCategory: 'Company Fund Transfer', payment, counterparty: 'Owner', purpose: 'Cash capital from the owner' };
  }
  if (/-CASH$/.test(key)) {
    const who = titleCase(key.replace(/-CASH$/, ''));
    return { subCategory: 'Operating Budget Top-up', payment, counterparty: who, purpose: `Cash received through ${who}` };
  }
  const label = titleCase(key);
  return { subCategory: 'Operating Budget Top-up', payment, counterparty: label, purpose: `Funds received via ${label}` };
}

function rentDepartment(name: string): string {
  const n = name.toLowerCase();
  if (/home|tution|tuition/.test(n)) return 'OWNER';
  if (/shibgonj/.test(n)) return 'SHIBGONJ-OFFICE';
  if (/botessor|bottessor/.test(n)) return 'BOTESSOR-OFFICE';
  if (/baluchor/.test(n)) return 'BALUCHOR-OFFICE';
  if (/daspara/.test(n)) return 'DASPARA-OFFICE';
  if (/shaporan/.test(n)) return 'SHAPORAN-OFFICE';
  if (/subid/.test(n)) return 'SUBID-BAZAR-OFFICE';
  if (/amborkhana/.test(n)) return 'AMBORKHANA-OFFICE';
  return 'ALHAMRA-OFFICE';
}

// ---------------------------------------------------------------------------------------
// Building the plan
// ---------------------------------------------------------------------------------------

export interface PlanContext {
  fundSources: Pick<FundSource, 'id' | 'name' | 'active' | 'balancePaisa'>[];
  employees: Pick<Employee, 'id' | 'name' | 'code' | 'monthlySalaryPaisa'>[];
  rentItems: Pick<RentItem, 'id' | 'name' | 'category' | 'monthlyAmountPaisa' | 'urgentAmountPaisa' | 'department' | 'notes'>[];
  headNames: { income: string[]; expense: string[] };
  departmentNames: string[];
  lockedPeriods: string[];
  /** date|kind|paisa -> voucher numbers of live ledger entries */
  existingEntries: Map<string, string[]>;
  /** date|categoryGroup|normalized employee name|paisa -> voucher numbers */
  existingLinkedEntries?: Map<string, string[]>;
  /** Ledger balance before the selected workbook month begins, in paisa. */
  openingBalancePaisa?: number;
  alreadyImported: boolean;
}

export function importTag(fileHash: string): string {
  return `[import:${fileHash.slice(0, 12)}]`;
}

export function hashFile(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function defaultFund(ctx: PlanContext): string {
  const active = ctx.fundSources.filter((f) => f.active);
  const preferred = active.find((f) => /company revenue/i.test(f.name));
  return (preferred || active[0] || ctx.fundSources[0])?.name || '';
}

export function buildImportPlan(grids: Grids, meta: { fileName: string; fileHash: string }, ctx: PlanContext): ImportPlan {
  const notes: string[] = [];
  const ex = sheet(grids, 'Expense');
  const sal = sheet(grids, 'salary');
  const loan = sheet(grids, 'LONE');
  const rent = sheet(grids, 'Rent');
  if (!ex) throw new Error('The workbook has no "Expense" sheet, so this is not the expected income & expense file.');

  const fund = defaultFund(ctx);
  const sheetMonthRaw = toIsoDate(at(ex, 3, 10)) || toIsoDate(sal ? at(sal, 3, 11) : null);
  const incomeDates: string[] = [];
  let sheetOpeningBalance: number | null = null;

  // ---- Income block: B date, C manager, D details, E amount (rows 9+) -----------------
  const entries: PlanEntry[] = [];
  let lastDate = sheetMonthRaw || `${dhakaMonth()}-01`;
  let n = 0;
  for (let r = 9; r <= ex.length; r++) {
    const amount = num(at(ex, r, 5));
    const details = text(at(ex, r, 4));
    // Recognize this before filtering non-positive amounts: a zero or negative
    // brought-forward balance is still valid opening-balance information.
    if (normKey(details) === 'PREVIOUS-MONTH') {
      if (amount === null) notes.push(`Income row ${r} ("${details}") has no amount and was skipped.`);
      else sheetOpeningBalance = (sheetOpeningBalance ?? 0) + amount;
      continue;
    }
    if (amount === null || amount <= 0) {
      if (details && amount === null) notes.push(`Income row ${r} ("${details}") has no amount and was skipped.`);
      continue;
    }
    let date = toIsoDate(at(ex, r, 2));
    const guessed: string[] = [];
    if (!date) { date = lastDate; guessed.push('txDate'); } else { lastDate = date; incomeDates.push(date); }
    const manager = text(at(ex, r, 3));
    const head = canonicalHead(details || 'OTHER-INCOME', DEFAULT_INCOME_HEADS);
    const c = classifyIncome(head);
    guessed.push('subCategory', 'paymentMethod', 'counterparty', 'purpose');
    entries.push({
      id: `ent-${++n}`,
      include: true,
      source: `Expense!B${r}:E${r}`,
      kind: 'income',
      txDate: date,
      amount: taka(amount),
      department: head,
      head,
      subCategory: c.subCategory,
      paymentMethod: c.payment,
      counterparty: c.counterparty,
      purpose: c.purpose,
      referenceNo: '',
      notes: manager ? `Manager: ${manager}` : '',
      fundSource: fund,
      guessed,
    });
  }

  // ---- Expense block: G date, H department, I details, J amount (rows 9+) -------------
  lastDate = sheetMonthRaw || lastDate;
  for (let r = 9; r <= ex.length; r++) {
    const amount = num(at(ex, r, 10));
    const details = text(at(ex, r, 9));
    if (amount === null || amount <= 0) {
      if (details && amount === null) notes.push(`Expense row ${r} ("${details}") has no amount and was skipped.`);
      continue;
    }
    let date = toIsoDate(at(ex, r, 7));
    const guessed: string[] = [];
    if (!date) { date = lastDate; guessed.push('txDate'); } else { lastDate = date; }
    const dept = canonicalDepartment(text(at(ex, r, 8)) || 'OTHERS-COMPANY');
    if (!text(at(ex, r, 8))) guessed.push('department');
    const label = details || 'Expense';
    guessed.push('subCategory', 'paymentMethod', 'counterparty');
    entries.push({
      id: `ent-${++n}`,
      include: true,
      source: `Expense!G${r}:J${r}`,
      kind: 'expense',
      txDate: date,
      amount: taka(amount),
      department: dept,
      head: dept,
      subCategory: classifyExpense(label, dept),
      paymentMethod: 'Cash in Hand',
      counterparty: label,
      purpose: label,
      referenceNo: '',
      notes: '',
      fundSource: fund,
      guessed,
    });
  }

  // ---- Employees: salary sheet C name, D monthly salary (rows 8+) ---------------------
  const employees: PlanEmployee[] = [];
  const empRows = new Map<string, { sheetPaid: number }>();
  if (sal) {
    for (let r = 8; r <= sal.length; r++) {
      const key = text(at(sal, r, 3));
      const salary = num(at(sal, r, 4));
      if (!key || salary === null) continue;
      const { branch, rest } = splitEmployeeKey(key);
      const name = titleCase(rest || key);
      const existing = ctx.employees.find((e) => e.name.trim().toLowerCase() === name.toLowerCase()
        || normKey(e.name) === normKey(key));
      empRows.set(key, { sheetPaid: num(at(sal, r, 5)) ?? 0 });
      employees.push({
        id: `emp-${employees.length + 1}`,
        include: true,
        source: `salary!C${r}:D${r}`,
        key,
        name,
        role: 'Staff',
        branch,
        department: branch,
        monthlySalary: taka(salary),
        linkExistingId: existing ? existing.id : '',
      });
    }
  }
  const employeeKeys = employees.map((e) => e.key);

  // ---- Salary payments: H date, I label, J details, K amount (rows 8+) ----------------
  const salaryPayments: PlanSalaryPayment[] = [];
  let lastPayDate = sheetMonthRaw || lastDate;
  if (sal) {
    for (let r = 8; r <= sal.length; r++) {
      const amount = num(at(sal, r, 11));
      const label = text(at(sal, r, 9));
      if (amount === null || amount <= 0) continue;
      let date = toIsoDate(at(sal, r, 8));
      const noteBits: string[] = [];
      if (!date) { date = lastPayDate; noteBits.push('Date not in sheet; assumed from the row above.'); } else lastPayDate = date;
      const key = resolveEmployeeKey(label, employeeKeys);
      const emp = employees.find((e) => e.key === key);
      const extra = text(at(sal, r, 10));
      const stop = new Set(['salary', 'loan', 'paid', 'advance', 'adv', 'sal', 'lone']);
      const branchWords = new Set(BRANCH_PREFIXES.flatMap(([p]) => p.toLowerCase().split('-')));
      const named = extra.split(/[^A-Za-z]+/).map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && !stop.has(w) && !branchWords.has(w)).map(canonToken);
      const mismatch = !!key && named.length > 0 && !named.some((w) => employeeTokens(key).includes(w));
      salaryPayments.push({
        id: `sal-${salaryPayments.length + 1}`,
        include: !mismatch,
        skipReason: mismatch ? `The Details column says "${extra}", not ${emp?.name || key}. That payment is most likely already in the cash book as a plain expense, so it is unticked to avoid counting it twice.` : undefined,
        source: `salary!H${r}:K${r}`,
        employeeRef: key,
        type: 'salary',
        txDate: date,
        monthKey: sheetMonthRaw ? sheetMonthRaw.slice(0, 7) : date.slice(0, 7),
        amount: taka(amount),
        paymentMethod: 'Cash in Hand',
        department: emp?.department || '',
        fundSource: fund,
        note: [label ? `Sheet label: ${label}` : '', extra ? `Details: ${extra}` : '', ...noteBits].filter(Boolean).join(' · '),
      });
    }
  }

  // ---- Loans: LONE G date, H label, I amount; repayments K date, L label, M amount ----
  const loans: PlanLoan[] = [];
  const loanRepayments: PlanLoanRepayment[] = [];
  if (loan) {
    for (let r = 9; r <= loan.length; r++) {
      const amount = num(at(loan, r, 9));
      if (amount === null || amount <= 0) continue;
      const label = text(at(loan, r, 8));
      const key = resolveEmployeeKey(label, employeeKeys);
      const emp = employees.find((e) => e.key === key);
      loans.push({
        id: `loan-${loans.length + 1}`,
        include: true,
        source: `LONE!G${r}:I${r}`,
        employeeRef: key,
        txDate: toIsoDate(at(loan, r, 7)) || sheetMonthRaw || `${dhakaMonth()}-01`,
        amount: taka(amount),
        paymentMethod: 'Cash in Hand',
        department: emp?.department || '',
        fundSource: fund,
        purpose: `Employee loan${label ? ` (${label})` : ''}`,
        referenceNo: '',
      });
    }
    const remaining = new Map<string, number>();
    for (const l of loans) remaining.set(l.id, paisaOf(l.amount) ?? 0);
    for (let r = 9; r <= loan.length; r++) {
      const amount = num(at(loan, r, 13));
      if (amount === null || amount <= 0) continue;
      const label = text(at(loan, r, 12));
      const key = resolveEmployeeKey(label, employeeKeys);
      const emp = employees.find((e) => e.key === key);
      const paisa = Math.round(amount * 100);
      const target = loans
        .filter((l) => l.employeeRef === key && key)
        .sort((a, b) => a.txDate.localeCompare(b.txDate))
        .find((l) => (remaining.get(l.id) ?? 0) >= paisa);
      if (target) remaining.set(target.id, (remaining.get(target.id) ?? 0) - paisa);
      loanRepayments.push({
        id: `rep-${loanRepayments.length + 1}`,
        include: true,
        source: `LONE!K${r}:M${r}`,
        employeeRef: key,
        loanRef: target ? target.id : '',
        txDate: toIsoDate(at(loan, r, 11)) || sheetMonthRaw || `${dhakaMonth()}-01`,
        amount: taka(amount),
        paymentMethod: 'Adjustment',
        department: emp?.department || '',
        fundSource: fund,
        treatment: 'review',
        note: label ? `Sheet label: ${label}` : '',
      });
    }
  }

  // ---- Rent: Rent sheet C name, D regular amount, E urgent amount (rows 8+) -----------
  const rentItems: PlanRentItem[] = [];
  if (rent) {
    for (let r = 8; r <= rent.length; r++) {
      const name = text(at(rent, r, 3));
      const regular = num(at(rent, r, 4)) ?? 0;
      const urgent = num(at(rent, r, 5)) ?? 0;
      if (!name || (regular <= 0 && urgent <= 0)) continue;
      const existingRent = ctx.rentItems.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase());
      rentItems.push({
        id: `rent-${rentItems.length + 1}`,
        include: true,
        source: `Rent!C${r}:E${r}`,
        name,
        category: regular > 0 ? 'regular' : 'urgent',
        monthlyAmount: taka(regular),
        urgentAmount: taka(urgent),
        department: rentDepartment(name),
        notes: '',
        linkExistingId: existingRent?.id || '',
      });
    }
  }

  // ---- Cash-book rows that are really payroll / loan rows (avoid counting twice) ------
  const taken = new Set<string>();
  const claim = (
    row: { txDate: string; amount: string; employeeRef: string; id: string; source: string },
    pattern: RegExp,
    label: string,
  ) => {
    if (!row.employeeRef) return;
    const paisa = paisaOf(row.amount);
    const candidates = entries.filter((e) => e.kind === 'expense' && !taken.has(e.id) && paisaOf(e.amount) === paisa
      && pattern.test(e.counterparty) && employeeInText(e.counterparty, employeeKeys) === row.employeeRef);
    if (!candidates.length) return;
    const sameDay = candidates.find((e) => e.txDate === row.txDate && !(e.guessed || []).includes('txDate'));
    // Amount + employee alone is not enough: two legitimate payments can be
    // identical but occur on different dates. Only suppress a cash-book row
    // when we can match its actual date as well.
    const pick = sameDay || candidates.find((e) => e.txDate === row.txDate);
    if (!pick) return;
    taken.add(pick.id);
    pick.include = false;
    pick.coveredBy = `${label} (${row.source})`;
  };
  for (const p of salaryPayments) claim(p, /\b(salary|adv|advance|bonus|sal)\b/i, 'Salary sheet payment');
  for (const l of loans) claim(l, /\b(loan|lone)\b/i, 'Loan sheet issue');
  for (const e of entries) {
    if (e.kind !== 'expense' || !e.include || e.coveredBy) continue;
    const who = employeeInText(e.counterparty, employeeKeys);
    if (!who) continue;
    if (/\b(loan|lone)\b/i.test(e.counterparty)) e.payrollHint = { employeeRef: who, type: 'loan' };
    else if (/\b(adv|advance)\b/i.test(e.counterparty)) e.payrollHint = { employeeRef: who, type: 'advance' };
    else if (/\b(salary|bonus)\b/i.test(e.counterparty)) e.payrollHint = { employeeRef: who, type: 'salary' };
  }

  const sheetTotals = {
    income: num(at(ex, 7, 5)) ?? 0,
    expense: num(at(ex, 7, 10)) ?? 0,
    balance: num(at(ex, 3, 7)) ?? 0,
    salaryPaid: sal ? (num(at(sal, 6, 11)) ?? num(at(sal, 6, 5)) ?? 0) : 0,
    salaryPending: sal ? (num(at(sal, 6, 6)) ?? 0) : 0,
    loanIssued: loan ? (num(at(loan, 7, 4)) ?? 0) : 0,
    loanPaid: loan ? (num(at(loan, 7, 5)) ?? 0) : 0,
    rentRegular: rent ? (num(at(rent, 6, 4)) ?? 0) : 0,
    rentUrgent: rent ? (num(at(rent, 6, 5)) ?? 0) : 0,
  };

  // Cumulative Salary/Loan sheets often repeat records from earlier workbooks.
  // Exact date + employee + amount matches are strong duplicates, so leave them
  // unticked by default; admins can still re-enable one after reviewing the warning.
  const employeeNameFor = (ref: string) => employees.find((e) => e.key === ref)?.name
    || ctx.employees.find((e) => `db:${e.id}` === ref)?.name || ref;
  let repeatedLinkedRows = 0;
  const skipIfAlreadyLinked = (row: { include: boolean; skipReason?: string; txDate: string; employeeRef: string; amount: string }, group: string) => {
    if (!row.include) return;
    const duplicate = ctx.existingLinkedEntries?.get(linkedDuplicateKey(row.txDate, group, employeeNameFor(row.employeeRef), paisaOf(row.amount) ?? 0));
    if (!duplicate?.length) return;
    row.include = false;
    row.skipReason = `Matching ${group.replace('_', ' ')} already exists in the ledger (${duplicate[0]}). Tick only if this is a separate payment.`;
    repeatedLinkedRows++;
  };
  for (const row of salaryPayments) skipIfAlreadyLinked(row, row.type === 'advance' ? 'salary_advance' : 'salary');
  for (const row of loans) skipIfAlreadyLinked(row, 'loan_issue');
  for (const row of loanRepayments) skipIfAlreadyLinked(row, 'loan_repayment');

  if (!sheetMonthRaw) notes.push('The workbook month could not be read from the sheet header; it was taken from the dates.');
  if (sheetOpeningBalance !== null) notes.push(`The workbook's Previous Month amount (৳${taka(sheetOpeningBalance)}) is treated as the opening balance, not current-month income.`);
  if (repeatedLinkedRows) notes.push(`${repeatedLinkedRows} payroll/loan row(s) exactly match records already in the ledger and are unticked by default. Re-enable one only after checking it is a separate payment.`);
  if (loanRepayments.some((r) => r.include)) notes.push('Choose how each included loan repayment affects cash: "Cash received" creates an income entry; "Already in cash book" updates the loan only and avoids counting the same receipt twice.');
  for (const [key, info] of empRows) {
    const paid = salaryPayments.filter((p) => p.employeeRef === key).reduce((s, p) => s + (paisaOf(p.amount) ?? 0), 0);
    if (Math.abs(paid - Math.round(info.sheetPaid * 100)) > 50) {
      notes.push(`${key}: the sheet says ৳${taka(info.sheetPaid)} was paid, but the payment rows add up to ৳${fromPaisa(paid)}.`);
    }
  }

  return {
    version: 1,
    fileName: meta.fileName,
    fileHash: meta.fileHash,
    sheetMonth: sheetMonthRaw ? sheetMonthRaw.slice(0, 7) : (incomeDates[0] || dhakaMonth()).slice(0, 7),
    sheetOpeningBalance,
    defaultFundSource: fund,
    entries,
    employees,
    salaryPayments,
    loans,
    loanRepayments,
    rentItems,
    sheetTotals,
    notes,
  };
}

// ---------------------------------------------------------------------------------------
// Validating a plan (run on every edit; never writes)
// ---------------------------------------------------------------------------------------

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tryValidate(fn: () => unknown): RowIssue | null {
  try { fn(); return null; } catch (e) { return { level: 'error', message: msg(e) }; }
}

function dedupe(issues: RowIssue[]): RowIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.level + i.message) ? false : (seen.add(i.level + i.message), true)));
}

const OPENING_RECONCILIATION_SOURCE = 'System: opening balance reconciliation';

function previousMonthEnd(month: string): string {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  start.setUTCDate(0);
  return start.toISOString().slice(0, 10);
}

function openingAdjustmentPaisa(plan: ImportPlan, ctx: PlanContext): number | null {
  if (plan.sheetOpeningBalance === null || !Number.isFinite(plan.sheetOpeningBalance)) return null;
  const monthStart = `${plan.sheetMonth}-01`;
  let backdatedNet = 0;
  for (const e of plan.entries) {
    if (!e.include || e.source === OPENING_RECONCILIATION_SOURCE || !isIsoDate(e.txDate) || e.txDate >= monthStart) continue;
    const amount = paisaOf(e.amount) ?? 0;
    backdatedNet += e.kind === 'income' ? amount : -amount;
  }
  for (const p of plan.salaryPayments) {
    if (p.include && isIsoDate(p.txDate) && p.txDate < monthStart) backdatedNet -= paisaOf(p.amount) ?? 0;
  }
  for (const l of plan.loans) {
    if (l.include && isIsoDate(l.txDate) && l.txDate < monthStart) backdatedNet -= paisaOf(l.amount) ?? 0;
  }
  for (const r of plan.loanRepayments) {
    if (r.include && r.treatment === 'cash' && isIsoDate(r.txDate) && r.txDate < monthStart) backdatedNet += paisaOf(r.amount) ?? 0;
  }
  const openingBeforeImport = ctx.openingBalancePaisa ?? 0;
  return Math.round(plan.sheetOpeningBalance * 100) - (openingBeforeImport + backdatedNet);
}

function linkedDuplicateKey(date: string, group: string, employeeName: string, paisa: number): string {
  return `${date}|${group}|${normKey(employeeName)}|${paisa}`;
}

export function validateImportPlan(inputPlan: ImportPlan, ctx: PlanContext): ImportValidation {
  const plan: ImportPlan = JSON.parse(JSON.stringify(inputPlan));
  const planIssues: RowIssue[] = [];
  const previousAdjustment = plan.entries.find((e) => e.source === OPENING_RECONCILIATION_SOURCE);
  plan.entries = plan.entries.filter((e) => e.source !== OPENING_RECONCILIATION_SOURCE);
  const adjustmentPaisa = openingAdjustmentPaisa(plan, ctx);
  if (adjustmentPaisa !== null && adjustmentPaisa !== 0) {
    const fund = plan.defaultFundSource || ctx.fundSources.find((f) => f.active)?.name || '';
    const amount = Math.abs(adjustmentPaisa);
    const kind = adjustmentPaisa > 0 ? 'income' : 'expense';
    plan.entries.unshift({
      id: 'system-opening-balance-reconciliation',
      include: previousAdjustment ? previousAdjustment.include : true,
      source: OPENING_RECONCILIATION_SOURCE,
      kind,
      txDate: previousMonthEnd(plan.sheetMonth),
      amount: fromPaisa(amount),
      department: 'OWNER',
      head: 'OPENING-BALANCE',
      subCategory: 'Opening Balance Reconciliation',
      paymentMethod: 'Adjustment',
      counterparty: 'Previous month balance',
      purpose: `Reconcile imported prior-period activity to the workbook opening balance of ৳${fromPaisa(Math.round((plan.sheetOpeningBalance ?? 0) * 100))}`,
      referenceNo: '',
      notes: `Workbook opening balance ৳${fromPaisa(Math.round((plan.sheetOpeningBalance ?? 0) * 100))}; existing ledger opening ৳${fromPaisa(ctx.openingBalancePaisa ?? 0)}.`,
      fundSource: fund,
      guessed: [],
    });
  }
  const fundByName = new Map(ctx.fundSources.map((f) => [f.name.trim().toLowerCase(), f]));
  const headSet = new Set([...ctx.headNames.income, ...ctx.headNames.expense].map((h) => normKey(h)));
  const deptSet = new Set(ctx.departmentNames.map((d) => normKey(d)));
  const locked = new Set(ctx.lockedPeriods);
  const newHeads = new Set<string>();
  const newDepartments = new Set<string>();

  if (ctx.alreadyImported) {
    planIssues.push({ level: 'error', message: 'This file has already been imported. Importing it again would create duplicates.' });
  }
  if (!ctx.fundSources.length) planIssues.push({ level: 'error', message: 'No fund sources exist yet. Create one before importing.' });

  const fundIssue = (name: string): RowIssue | null => {
    const f = fundByName.get((name || '').trim().toLowerCase());
    if (!f) return { level: 'error', message: name ? `Fund source "${name}" does not exist.` : 'Choose a fund source.' };
    if (!f.active) return { level: 'error', message: `Fund source "${f.name}" is inactive.` };
    return null;
  };
  const lockIssue = (date: string): RowIssue | null =>
    isIsoDate(date) && locked.has(date.slice(0, 7))
      ? { level: 'error', message: `${date.slice(0, 7)} is a locked period. Unlock it in Audit & Locks first.` }
      : null;

  const push = (row: { issues?: RowIssue[] }, ...items: (RowIssue | null)[]) => {
    row.issues = dedupe([...(row.issues || []), ...(items.filter(Boolean) as RowIssue[])]);
  };
  for (const list of [plan.entries, plan.employees, plan.salaryPayments, plan.loans, plan.loanRepayments, plan.rentItems]) {
    for (const row of list as { issues?: RowIssue[] }[]) row.issues = [];
  }

  // ---- Employees ----------------------------------------------------------------------
  const empByKey = new Map(plan.employees.map((e) => [e.key, e]));
  const seenKeys = new Set<string>();
  for (const e of plan.employees) {
    if (!e.include) continue;
    if (seenKeys.has(e.key)) push(e, { level: 'error', message: `Duplicate employee "${e.key}".` });
    seenKeys.add(e.key);
    if (e.linkExistingId) {
      const ex = ctx.employees.find((x) => x.id === e.linkExistingId);
      if (!ex) push(e, { level: 'error', message: 'The employee you linked to no longer exists.' });
      else push(e, { level: 'info', message: `Linked to existing employee ${ex.name} (${ex.code}); no duplicate will be created.` });
    } else {
      push(e, tryValidate(() => validateEmployeeInput({
        name: e.name, role: e.role, department: e.department, branch: e.branch, monthlySalary: e.monthlySalary,
      })));
      const same = ctx.employees.find((x) => x.name.trim().toLowerCase() === e.name.trim().toLowerCase());
      if (same) push(e, { level: 'warn', message: `An employee named ${same.name} already exists. Link to it or rename this one.` });
      if (!e.branch) push(e, { level: 'warn', message: 'Branch/department could not be read from the name; please fill it in.' });
    }
  }

  const empBase = (ref: string): { name: string; salaryPaisa: number } | null => {
    if (ref.startsWith('db:')) {
      const ex = ctx.employees.find((x) => x.id === ref.slice(3));
      return ex ? { name: ex.name, salaryPaisa: ex.monthlySalaryPaisa } : null;
    }
    const e = empByKey.get(ref);
    if (!e || !e.include) return null;
    if (e.linkExistingId) {
      const ex = ctx.employees.find((x) => x.id === e.linkExistingId);
      return ex ? { name: ex.name, salaryPaisa: paisaOf(e.monthlySalary) ?? ex.monthlySalaryPaisa } : null;
    }
    return { name: e.name, salaryPaisa: paisaOf(e.monthlySalary) ?? 0 };
  };
  const refIssue = (ref: string): RowIssue | null => {
    if (!ref) return { level: 'error', message: 'Choose which employee this belongs to.' };
    return empBase(ref) ? null : { level: 'error', message: 'This employee is not included in the import. Include the employee or choose another.' };
  };

  // ---- Ledger entries -----------------------------------------------------------------
  const guessNote = (row: PlanEntry): RowIssue[] => {
    const g = row.guessed || [];
    const out: RowIssue[] = [];
    if (g.includes('txDate')) out.push({ level: 'warn', message: 'The sheet has no date on this row; the date from the row above was used. Please confirm.' });
    const others = g.filter((f) => f !== 'txDate');
    if (others.length) out.push({ level: 'info', message: `Not in the sheet, so suggested by the importer: ${others.join(', ')}.` });
    return out;
  };
  for (const list of [plan.salaryPayments, plan.loans, plan.loanRepayments, plan.rentItems, plan.employees] as { include: boolean; skipReason?: string; issues?: RowIssue[] }[][]) {
    for (const row of list) if (!row.include && row.skipReason) push(row, { level: 'info', message: row.skipReason });
  }
  for (const e of plan.entries) {
    if (e.coveredBy) push(e, { level: 'info', message: `Skipped by default: already counted as ${e.coveredBy}. Tick it only if that is wrong.` });
    if (!e.include) continue;
    if (e.payrollHint) {
      const who = empBase(e.payrollHint.employeeRef)?.name || e.payrollHint.employeeRef;
      push(e, { level: 'warn', message: `Looks like ${e.payrollHint.type === 'loan' ? 'a loan' : e.payrollHint.type === 'advance' ? 'a salary advance' : 'a salary payment'} for ${who}, but nothing on the ${e.payrollHint.type === 'loan' ? 'Loan' : 'Salary'} sheet matches it. As a plain expense it will not show in ${who}'s ${e.payrollHint.type === 'loan' ? 'loan balance' : 'salary record'}. Use "Make it payroll" if it should.` });
    }
    push(e, ...guessNote(e));
    push(e, tryValidate(() => validateTransactionInput({
      kind: e.kind, txDate: e.txDate, amount: e.amount, department: e.department, head: e.head,
      subCategory: e.subCategory, paymentMethod: e.paymentMethod, referenceNo: e.referenceNo,
      counterparty: e.counterparty, purpose: e.purpose, notes: e.notes, fundSourceId: 'x',
    }, false)), fundIssue(e.fundSource), lockIssue(e.txDate));
    const pool = e.kind === 'income' ? ctx.headNames.income : ctx.headNames.expense;
    if (e.head && !pool.some((h) => normKey(h) === normKey(e.head)) && !headSet.has(normKey(e.head))) newHeads.add(e.head);
    if (e.department && !deptSet.has(normKey(e.department))) newDepartments.add(e.department);
    const paisa = paisaOf(e.amount);
    if (paisa && isIsoDate(e.txDate)) {
      const dup = ctx.existingEntries.get(`${e.txDate}|${e.kind}|${paisa}`);
      if (dup?.length) push(e, { level: 'warn', message: `Looks like an entry already in the ledger (${dup[0]}).` });
    }
    if (e.kind === 'expense' && /\b(salary|adv|advance|loan|lone)\b/i.test(e.counterparty) && !e.coveredBy && !e.payrollHint) {
      push(e, { level: 'info', message: 'Looks like payroll/loan money but matches no row on the Salary or Loan sheet; it will be imported as a plain expense.' });
    }
  }

  const openingAdjustment = plan.entries.find((e) => e.source === OPENING_RECONCILIATION_SOURCE);
  if (openingAdjustment && !openingAdjustment.include) {
    planIssues.push({ level: 'error', message: 'The opening-balance reconciliation is required to make the imported opening balance match the workbook. Include that row or correct the source rows.' });
  }

  // ---- Salary payments / advances -----------------------------------------------------
  const sortedPay = [...plan.salaryPayments].filter((p) => p.include)
    .sort((a, b) => a.txDate.localeCompare(b.txDate) || a.id.localeCompare(b.id));
  const paidSoFar = new Map<string, number>();
  const advTotals = new Map<string, number>();
  for (const p of sortedPay) {
    if (p.type === 'advance') advTotals.set(`${p.employeeRef}|${p.monthKey}`, (advTotals.get(`${p.employeeRef}|${p.monthKey}`) || 0) + (paisaOf(p.amount) ?? 0));
  }
  for (const p of plan.salaryPayments) {
    if (!p.include) continue;
    const base = empBase(p.employeeRef);
    push(p, refIssue(p.employeeRef), fundIssue(p.fundSource), lockIssue(p.txDate));
    const bodyBase = {
      employeeId: 'x', monthKey: p.monthKey, paidDate: p.txDate, issuedDate: p.txDate,
      baseSalary: base ? fromPaisa(base.salaryPaisa) : '0', payAmount: p.amount, amount: p.amount,
      paymentMethod: p.paymentMethod, department: p.department, fundSourceId: 'x',
      purpose: p.note || 'Salary advance (Excel import)',
    };
    push(p, tryValidate(() => (p.type === 'advance' ? validateSalaryAdvanceInput(bodyBase) : validateSalaryPayInput(bodyBase))));
    if (isIsoDate(p.txDate) && /^\d{4}-\d{2}$/.test(p.monthKey) && p.txDate.slice(0, 7) < p.monthKey) {
      push(p, { level: 'warn', message: `Dated ${p.txDate}, before ${p.monthKey}. It will create a ledger entry in ${p.txDate.slice(0, 7)} that is not in this month's cash book.` });
    }
    if (p.type === 'salary' && base) {
      const k = `${p.employeeRef}|${p.monthKey}`;
      const paisa = paisaOf(p.amount) ?? 0;
      const prior = paidSoFar.get(k) || 0;
      const adv = advTotals.get(k) || 0;
      const remaining = Math.max(0, base.salaryPaisa - adv - prior);
      if (base.salaryPaisa <= 0) {
        push(p, { level: 'error', message: `${base.name} has no monthly salary set, so a salary payment cannot be checked. Set the salary on the Employees tab.` });
      } else if (paisa > remaining) {
        push(p, { level: 'error', message: `Exceeds what is still payable: salary ৳${fromPaisa(base.salaryPaisa)}, already paid ৳${fromPaisa(prior)}${adv ? `, advances ৳${fromPaisa(adv)}` : ''}, left ৳${fromPaisa(remaining)}. Fix the amount, raise the salary, or untick this row.` });
      }
      paidSoFar.set(k, prior + paisa);
    }
    const employeeName = empBase(p.employeeRef)?.name || '';
    const linkedDupes = ctx.existingLinkedEntries?.get(linkedDuplicateKey(p.txDate, p.type === 'advance' ? 'salary_advance' : 'salary', employeeName, paisaOf(p.amount) ?? 0));
    if (linkedDupes?.length) push(p, { level: 'warn', message: `A matching ${p.type === 'advance' ? 'salary advance' : 'salary payment'} already exists (${linkedDupes[0]}). Check that this row is not being imported from another month's workbook.` });
    const extra = (p.note.match(/Details: ([^·]+)/) || [])[1]?.trim();
    if (extra && base) {
      const words = extra.split(/[^A-Za-z]+/).map(canonToken).filter((w) => w.length >= 3);
      const mine = base.name.split(/\s+/).map(canonToken);
      if (words.length && !words.some((w) => mine.includes(w)) && /^[A-Za-z .]+$/.test(extra)) {
        push(p, { level: 'warn', message: `The Details column says "${extra}" but this row is assigned to ${base.name}. Check it is the right person.` });
      }
    }
    if (!p.department) push(p, { level: 'error', message: 'Department is required.' });
  }

  // ---- Loans and repayments -----------------------------------------------------------
  const loanById = new Map(plan.loans.map((l) => [l.id, l]));
  for (const l of plan.loans) {
    if (!l.include) continue;
    push(l, refIssue(l.employeeRef), fundIssue(l.fundSource), lockIssue(l.txDate), tryValidate(() => validateLoanIssueInput({
      employeeId: 'x', issuedDate: l.txDate, amount: l.amount, paymentMethod: l.paymentMethod, department: l.department,
      purpose: l.purpose, fundSourceId: 'x', referenceNo: l.referenceNo,
    })));
    const linkedLoanDupes = ctx.existingLinkedEntries?.get(linkedDuplicateKey(l.txDate, 'loan_issue', empBase(l.employeeRef)?.name || '', paisaOf(l.amount) ?? 0));
    if (linkedLoanDupes?.length) push(l, { level: 'warn', message: `A matching employee loan already exists (${linkedLoanDupes[0]}). Check that this row is not repeated from another month's workbook.` });
    if (isIsoDate(l.txDate) && /^\d{4}-\d{2}$/.test(plan.sheetMonth) && l.txDate.slice(0, 7) < plan.sheetMonth) {
      push(l, { level: 'warn', message: `Issued ${l.txDate}, before the sheet month. It will create a ledger entry in ${l.txDate.slice(0, 7)} that is not in this month's cash book.` });
    }
  }
  const repaidByLoan = new Map<string, number>();
  for (const r of plan.loanRepayments) {
    if (!r.include) continue;
    push(r, refIssue(r.employeeRef), fundIssue(r.fundSource), lockIssue(r.txDate), tryValidate(() => validateLoanRepayInput({
      paidDate: r.txDate, amount: r.amount, paymentMethod: r.paymentMethod, department: r.department,
      fundSourceId: 'x', note: r.note,
    })));
    const linkedRepayDupes = ctx.existingLinkedEntries?.get(linkedDuplicateKey(r.txDate, 'loan_repayment', empBase(r.employeeRef)?.name || '', paisaOf(r.amount) ?? 0));
    if (linkedRepayDupes?.length) push(r, { level: 'warn', message: `A matching loan repayment already exists (${linkedRepayDupes[0]}). Check that this row is not repeated from another month's workbook.` });
    if (r.treatment === 'review') {
      push(r, { level: 'error', message: 'Choose whether this repayment is new cash income or is already included in the cash-book income. The workbook does not show this clearly.' });
    } else if (r.treatment === 'cash') {
      push(r, { level: 'warn', message: 'This creates a new income transaction. Use this only when the repayment was received as additional cash and is not already included in the cash-book income.' });
    } else {
      push(r, { level: 'info', message: 'The repayment will reduce the employee loan balance without creating another income transaction; use this when the cash-book already records the receipt.' });
    }
    const target = loanById.get(r.loanRef);
    if (!target || !target.include) {
      push(r, { level: 'error', message: 'Choose which loan this repayment belongs to (that loan must be included).' });
    } else {
      if (target.employeeRef !== r.employeeRef) push(r, { level: 'error', message: 'This repayment is assigned to a different employee than the loan.' });
      const total = (repaidByLoan.get(target.id) || 0) + (paisaOf(r.amount) ?? 0);
      repaidByLoan.set(target.id, total);
      if (total > (paisaOf(target.amount) ?? 0)) push(r, { level: 'error', message: 'Repayments add up to more than the loan amount.' });
    }
  }

  // ---- Rent items ---------------------------------------------------------------------
  const seenRent = new Set<string>();
  for (const r of plan.rentItems) {
    if (!r.include) continue;
    push(r, tryValidate(() => validateRentItemInput({
      name: r.name, category: r.category, monthlyAmount: r.monthlyAmount, urgentAmount: r.urgentAmount,
      department: r.department, notes: r.notes,
    })));
    const lower = r.name.trim().toLowerCase();
    const existingRent = ctx.rentItems.find((item) => item.name.trim().toLowerCase() === lower);
    if (existingRent) {
      // Resolve against fresh server state on every validation. This prevents a
      // modified browser plan from turning an existing rent item into a duplicate.
      r.linkExistingId = existingRent.id;
      const sameValues = existingRent.category === r.category
        && existingRent.monthlyAmountPaisa === (paisaOf(r.monthlyAmount) ?? 0)
        && existingRent.urgentAmountPaisa === (paisaOf(r.urgentAmount) ?? 0)
        && existingRent.department.trim().toLowerCase() === r.department.trim().toLowerCase();
      push(r, {
        level: 'info',
        message: sameValues
          ? 'This recurring rent item already exists and will be reused; no duplicate will be created.'
          : 'This recurring rent item already exists. Its monthly amounts and department will be updated; no duplicate will be created.',
      });
    } else {
      r.linkExistingId = '';
    }
    if (seenRent.has(lower)) push(r, { level: 'error', message: 'Two rent rows have the same name.' });
    seenRent.add(lower);
    if (r.department && !deptSet.has(normKey(r.department))) newDepartments.add(r.department);
    push(r, { level: 'info', message: 'Rent obligations are imported as the monthly list; the sheet records no payments, so none are created.' });
  }

  // ---- Fund projection ----------------------------------------------------------------
  const fundTotals = new Map<string, { incoming: number; outgoing: number }>();
  const bump = (name: string, key: 'incoming' | 'outgoing', paisa: number | null) => {
    const f = fundByName.get((name || '').trim().toLowerCase());
    if (!f || !paisa) return;
    const cur = fundTotals.get(f.name) || { incoming: 0, outgoing: 0 };
    cur[key] += paisa;
    fundTotals.set(f.name, cur);
  };
  for (const e of plan.entries) if (e.include) bump(e.fundSource, e.kind === 'income' ? 'incoming' : 'outgoing', paisaOf(e.amount));
  for (const p of plan.salaryPayments) if (p.include) bump(p.fundSource, 'outgoing', paisaOf(p.amount));
  for (const l of plan.loans) if (l.include) bump(l.fundSource, 'outgoing', paisaOf(l.amount));
  for (const r of plan.loanRepayments) if (r.include && r.treatment === 'cash') bump(r.fundSource, 'incoming', paisaOf(r.amount));
  const funds: FundProjection[] = [];
  for (const f of ctx.fundSources) {
    const t = fundTotals.get(f.name);
    if (!t) continue;
    const closing = f.balancePaisa + t.incoming - t.outgoing;
    funds.push({
      fundSource: f.name,
      existingBalance: f.balancePaisa / 100,
      incoming: t.incoming / 100,
      outgoing: t.outgoing / 100,
      closing: closing / 100,
    });
    if (closing < 0) {
      planIssues.push({
        level: 'error',
        message: `${f.name} would end ৳${fromPaisa(-closing)} below zero, so the import would be refused. Add the missing opening balance as an income row, move rows to another fund source, or untick rows that belong to an earlier month.`,
      });
    }
  }

  // ---- Reconciliation against the workbook's own totals -------------------------------
  const sum = (rows: { amount: string }[]) => rows.reduce((s, r) => s + (paisaOf(r.amount) ?? 0), 0) / 100;
  const fromSheet = (e: PlanEntry) => e.source.startsWith('Expense!');
  const incomeRows = plan.entries.filter((e) => fromSheet(e) && e.kind === 'income');
  const expenseRows = plan.entries.filter((e) => fromSheet(e) && e.kind === 'expense');
  const t = plan.sheetTotals;
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const cashBookIncomeTarget = t.income - (plan.sheetOpeningBalance ?? 0);
  const reconcile: ReconcileLine[] = [
    { label: 'Money in (cash-book rows, excluding brought-forward balance)', sheet: cashBookIncomeTarget, imported: sum(incomeRows), ok: eq(sum(incomeRows), cashBookIncomeTarget) },
    { label: 'Money out (cash-book rows)', sheet: t.expense, imported: sum(expenseRows), ok: eq(sum(expenseRows), t.expense) },
    { label: 'Salaries set up (monthly salary total)', sheet: undefined, imported: plan.employees.reduce((s, e) => s + (paisaOf(e.monthlySalary) ?? 0), 0) / 100 },
    { label: 'Salary payments', sheet: t.salaryPaid, imported: sum(plan.salaryPayments), ok: eq(sum(plan.salaryPayments), t.salaryPaid) },
    { label: 'Loans issued', sheet: t.loanIssued, imported: sum(plan.loans), ok: eq(sum(plan.loans), t.loanIssued) },
    { label: 'Loan repayments', sheet: t.loanPaid, imported: sum(plan.loanRepayments), ok: eq(sum(plan.loanRepayments), t.loanPaid) },
    { label: 'Rent: regular amounts', sheet: t.rentRegular, imported: plan.rentItems.reduce((s, r) => s + (paisaOf(r.monthlyAmount) ?? 0), 0) / 100, ok: eq(plan.rentItems.reduce((s, r) => s + (paisaOf(r.monthlyAmount) ?? 0), 0) / 100, t.rentRegular) },
    { label: 'Rent: urgent amounts', sheet: t.rentUrgent, imported: plan.rentItems.reduce((s, r) => s + (paisaOf(r.urgentAmount) ?? 0), 0) / 100, ok: eq(plan.rentItems.reduce((s, r) => s + (paisaOf(r.urgentAmount) ?? 0), 0) / 100, t.rentUrgent) },
  ];
  if (plan.sheetOpeningBalance !== null) {
    const projectedOpening = (ctx.openingBalancePaisa ?? 0)
      + (openingAdjustmentPaisa(plan, ctx) === null ? 0 : (openingAdjustment?.include ? adjustmentPaisa ?? 0 : 0))
      + (() => {
        let net = 0;
        const monthStart = `${plan.sheetMonth}-01`;
        for (const e of plan.entries) if (e.include && e.source !== OPENING_RECONCILIATION_SOURCE && isIsoDate(e.txDate) && e.txDate < monthStart) net += (e.kind === 'income' ? 1 : -1) * (paisaOf(e.amount) ?? 0);
        for (const p of plan.salaryPayments) if (p.include && isIsoDate(p.txDate) && p.txDate < monthStart) net -= paisaOf(p.amount) ?? 0;
        for (const l of plan.loans) if (l.include && isIsoDate(l.txDate) && l.txDate < monthStart) net -= paisaOf(l.amount) ?? 0;
        for (const r of plan.loanRepayments) if (r.include && r.treatment === 'cash' && isIsoDate(r.txDate) && r.txDate < monthStart) net += paisaOf(r.amount) ?? 0;
        return net;
      })();
    reconcile.push({
      label: 'Opening balance brought forward',
      sheet: plan.sheetOpeningBalance,
      imported: projectedOpening / 100,
      ok: eq(projectedOpening / 100, plan.sheetOpeningBalance),
      detail: `Opening before this import: ৳${fromPaisa(ctx.openingBalancePaisa ?? 0)}. Backdated payroll, loans and other rows are included; the visible reconciliation row bridges any difference.`,
    });
  }
  const inc = plan.entries.filter((e) => e.include && e.kind === 'income').reduce((s, e) => s + (paisaOf(e.amount) ?? 0), 0)
    + plan.loanRepayments.filter((r) => r.include && r.treatment === 'cash').reduce((s, r) => s + (paisaOf(r.amount) ?? 0), 0);
  const out = plan.entries.filter((e) => e.include && e.kind === 'expense').reduce((s, e) => s + (paisaOf(e.amount) ?? 0), 0)
    + plan.salaryPayments.filter((p) => p.include).reduce((s, p) => s + (paisaOf(p.amount) ?? 0), 0)
    + plan.loans.filter((l) => l.include).reduce((s, l) => s + (paisaOf(l.amount) ?? 0), 0);
  const covered = plan.entries.filter((e) => e.coveredBy && !e.include).reduce((s, e) => s + (paisaOf(e.amount) ?? 0), 0);
  const payrollTotal = plan.salaryPayments.filter((p) => p.include).reduce((s, p) => s + (paisaOf(p.amount) ?? 0), 0)
    + plan.loans.filter((l) => l.include).reduce((s, l) => s + (paisaOf(l.amount) ?? 0), 0);
  const repayTotal = plan.loanRepayments.filter((r) => r.include).reduce((s, r) => s + (paisaOf(r.amount) ?? 0), 0);
  reconcile.push({
    label: 'Cash balance after import vs the sheet balance',
    sheet: t.balance,
    imported: ((ctx.openingBalancePaisa ?? 0) + inc - out) / 100,
    ok: eq(((ctx.openingBalancePaisa ?? 0) + inc - out) / 100, t.balance),
    detail: `Includes the existing ledger opening balance, all included cash-book rows, salary/loan outflows (৳${fromPaisa(payrollTotal)}), and loan repayments (৳${fromPaisa(repayTotal)}). Cash-book rows already covered by payroll/loan rows are skipped. Any remaining difference needs review; a matching closing balance alone does not prove the transaction classifications are correct.`,
  });

  // ---- Counts -------------------------------------------------------------------------
  const all = [plan.entries, plan.employees, plan.salaryPayments, plan.loans, plan.loanRepayments, plan.rentItems] as { include: boolean; issues?: RowIssue[] }[][];
  let errorCount = planIssues.filter((i) => i.level === 'error').length;
  let warnCount = planIssues.filter((i) => i.level === 'warn').length;
  let skipped = 0;
  for (const list of all) for (const row of list) {
    if (!row.include) { skipped++; continue; }
    for (const i of row.issues || []) { if (i.level === 'error') errorCount++; else if (i.level === 'warn') warnCount++; }
  }
  const used = (l: { include: boolean }[]) => l.filter((r) => r.include).length;
  return {
    plan,
    errorCount,
    warnCount,
    planIssues,
    reconcile,
    funds,
    counts: {
      entries: used(plan.entries), employees: used(plan.employees), salaryPayments: used(plan.salaryPayments),
      loans: used(plan.loans), loanRepayments: used(plan.loanRepayments), rentItems: used(plan.rentItems), skipped,
    },
    newHeads: [...newHeads].sort(),
    newDepartments: [...newDepartments].sort(),
    fundSources: ctx.fundSources.filter((f) => f.active).map((f) => f.name),
    existingEmployees: ctx.employees.map((e) => ({ id: e.id, name: e.name, code: e.code })),
  };
}

// ---------------------------------------------------------------------------------------
// Committing (the only part that writes)
// ---------------------------------------------------------------------------------------

export interface CommitResult {
  entries: number;
  employees: number;
  salaryPayments: number;
  loans: number;
  loanRepayments: number;
  rentItems: number;
  batch: string;
}

export interface CommitDeps {
  transaction<T>(fn: () => T): T;
  createEmployee(input: any, actor: AppUser): Employee;
  createRentItem(input: any, actor: AppUser): unknown;
  updateRentItem(id: string, input: any, actor: AppUser): unknown;
  createTransaction(input: any, actor: AppUser): unknown;
  issueLoan(input: any, actor: AppUser): { loan: { id: string } };
  repayLoan(loanId: string, input: any, actor: AppUser): unknown;
  recordHistoricalLoanRepayment(loanId: string, input: any, actor: AppUser): unknown;
  payEmployeeSalary(input: any, actor: AppUser): unknown;
  createSalaryAdvance(input: any, actor: AppUser): unknown;
}

export function commitImportPlan(plan: ImportPlan, actor: AppUser, ctx: PlanContext, deps: CommitDeps): CommitResult {
  const check = validateImportPlan(plan, ctx);
  if (check.errorCount > 0) throw new Error(`The import still has ${check.errorCount} problem${check.errorCount === 1 ? '' : 's'} to fix. Nothing was imported.`);
  const p = check.plan;
  const tag = importTag(p.fileHash);
  const fundId = (name: string) => ctx.fundSources.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase())!.id;
  const result: CommitResult = { entries: 0, employees: 0, salaryPayments: 0, loans: 0, loanRepayments: 0, rentItems: 0, batch: tag };
  const where = (source: string, e: unknown) => new Error(`${source}: ${msg(e)}`);

  return deps.transaction(() => {
    // 1. Employees (new ones are created; linked ones are reused)
    const empId = new Map<string, string>();
    const salaryOf = new Map<string, number>();
    for (const e of p.employees) {
      if (!e.include) continue;
      if (e.linkExistingId) {
        empId.set(e.key, e.linkExistingId);
        salaryOf.set(e.key, paisaOf(e.monthlySalary) ?? 0);
        continue;
      }
      try {
        const v = validateEmployeeInput({
          name: e.name, role: e.role, department: e.department, branch: e.branch, monthlySalary: e.monthlySalary,
          notes: `${tag} Imported from Excel (${e.source}), sheet name: ${e.key}`,
        });
        const created = deps.createEmployee({ ...v, monthlySalaryPaisa: v.monthlySalaryPaisa ?? 0 }, actor);
        empId.set(e.key, created.id);
        salaryOf.set(e.key, v.monthlySalaryPaisa ?? 0);
        result.employees++;
      } catch (err) { throw where(e.source, err); }
    }
    const resolve = (ref: string): string => (ref.startsWith('db:') ? ref.slice(3) : empId.get(ref) || '');
    const baseFor = (ref: string): number => (ref.startsWith('db:')
      ? (ctx.employees.find((x) => x.id === ref.slice(3))?.monthlySalaryPaisa ?? 0)
      : salaryOf.get(ref) ?? 0);

    // 2. Rent obligations
    for (const r of p.rentItems) {
      if (!r.include) continue;
      try {
        const v = validateRentItemInput({
          name: r.name, category: r.category, monthlyAmount: r.monthlyAmount, urgentAmount: r.urgentAmount,
          department: r.department,
          notes: r.notes
            ? `${tag} ${r.source} · ${r.notes}`
            : (r.linkExistingId
              ? (ctx.rentItems.find((item) => item.id === r.linkExistingId)?.notes || '')
              : `${tag} ${r.source}`),
        });
        if (r.linkExistingId) deps.updateRentItem(r.linkExistingId, v, actor);
        else deps.createRentItem(v, actor);
        result.rentItems++;
      } catch (err) { throw where(r.source, err); }
    }

    const byDate = <T extends { txDate: string; id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => a.txDate.localeCompare(b.txDate) || a.id.localeCompare(b.id));
    const entryInput = (e: PlanEntry) => validateTransactionInput({
      kind: e.kind, txDate: e.txDate, amount: e.amount, department: e.department, head: e.head,
      subCategory: e.subCategory, paymentMethod: e.paymentMethod, referenceNo: e.referenceNo,
      counterparty: e.counterparty, purpose: e.purpose,
      notes: `${tag} Excel ${e.source}${e.notes ? ' · ' + e.notes : ''}`,
      fundSourceId: fundId(e.fundSource),
    }, false);

    // 3. Money in first, so later spending never trips the fund-balance check
    for (const e of byDate(p.entries.filter((x) => x.include && x.kind === 'income'))) {
      try { deps.createTransaction(entryInput(e), actor); result.entries++; } catch (err) { throw where(e.source, err); }
    }

    // 4. Loans, then their repayments
    const loanId = new Map<string, string>();
    for (const l of byDate(p.loans.filter((x) => x.include))) {
      try {
        const v = validateLoanIssueInput({
          employeeId: resolve(l.employeeRef), issuedDate: l.txDate, amount: l.amount, paymentMethod: l.paymentMethod,
          department: l.department, purpose: `${tag} ${l.purpose}`, fundSourceId: fundId(l.fundSource), referenceNo: l.referenceNo,
        });
        loanId.set(l.id, deps.issueLoan(v, actor).loan.id);
        result.loans++;
      } catch (err) { throw where(l.source, err); }
    }
    for (const r of byDate(p.loanRepayments.filter((x) => x.include))) {
      try {
        const v = validateLoanRepayInput({
          paidDate: r.txDate, amount: r.amount, paymentMethod: r.paymentMethod, department: r.department,
          fundSourceId: fundId(r.fundSource), note: `${tag} ${r.note}`.trim(),
        });
        if (r.treatment === 'already-recorded') {
          deps.recordHistoricalLoanRepayment(loanId.get(r.loanRef)!, v, actor);
        } else {
          deps.repayLoan(loanId.get(r.loanRef)!, v, actor);
        }
        result.loanRepayments++;
      } catch (err) { throw where(r.source, err); }
    }

    // 5. Salary payments and advances
    for (const s of byDate(p.salaryPayments.filter((x) => x.include))) {
      try {
        const employeeId = resolve(s.employeeRef);
        if (s.type === 'advance') {
          const v = validateSalaryAdvanceInput({
            employeeId, issuedDate: s.txDate, monthKey: s.monthKey, amount: s.amount, department: s.department,
            fundSourceId: fundId(s.fundSource), paymentMethod: s.paymentMethod, purpose: `${tag} ${s.note || 'Salary advance (Excel import)'}`,
          });
          deps.createSalaryAdvance(v, actor);
        } else {
          const v = validateSalaryPayInput({
            employeeId, monthKey: s.monthKey, paidDate: s.txDate, baseSalaryPaisa: baseFor(s.employeeRef),
            payAmount: s.amount, paymentMethod: s.paymentMethod, department: s.department,
            fundSourceId: fundId(s.fundSource), notes: `${tag} ${s.note}`.trim(),
          });
          deps.payEmployeeSalary(v, actor);
        }
        result.salaryPayments++;
      } catch (err) { throw where(s.source, err); }
    }

    // 6. Money out (cash-book expenses not already counted as payroll/loans)
    for (const e of byDate(p.entries.filter((x) => x.include && x.kind === 'expense'))) {
      try { deps.createTransaction(entryInput(e), actor); result.entries++; } catch (err) { throw where(e.source, err); }
    }
    return result;
  });
}

// ---------------------------------------------------------------------------------------
// Never trust the plan that comes back from the browser
// ---------------------------------------------------------------------------------------

const ROW_STRINGS: Record<string, string[]> = {
  entries: ['id', 'source', 'kind', 'txDate', 'amount', 'department', 'head', 'subCategory', 'paymentMethod', 'counterparty', 'purpose', 'referenceNo', 'notes', 'fundSource', 'coveredBy'],
  employees: ['id', 'source', 'key', 'name', 'role', 'branch', 'department', 'monthlySalary', 'linkExistingId'],
  salaryPayments: ['id', 'source', 'employeeRef', 'type', 'txDate', 'monthKey', 'amount', 'paymentMethod', 'department', 'fundSource', 'note'],
  loans: ['id', 'source', 'employeeRef', 'txDate', 'amount', 'paymentMethod', 'department', 'fundSource', 'purpose', 'referenceNo'],
  loanRepayments: ['id', 'source', 'employeeRef', 'loanRef', 'txDate', 'amount', 'paymentMethod', 'department', 'fundSource', 'treatment', 'note'],
  rentItems: ['id', 'source', 'name', 'category', 'monthlyAmount', 'urgentAmount', 'department', 'notes', 'linkExistingId'],
};

export function sanitizeImportPlan(raw: any): ImportPlan {
  if (!raw || typeof raw !== 'object' || raw.version !== 1) throw new Error('This import preview is out of date. Upload the file again.');
  const out: any = {
    version: 1,
    fileName: String(raw.fileName || '').slice(0, 200),
    fileHash: /^[0-9a-f]{64}$/.test(String(raw.fileHash || '')) ? String(raw.fileHash) : '',
    sheetMonth: /^\d{4}-\d{2}$/.test(String(raw.sheetMonth || '')) ? String(raw.sheetMonth) : dhakaMonth(),
    sheetOpeningBalance: raw.sheetOpeningBalance === null || raw.sheetOpeningBalance === undefined ? null : (Number.isFinite(Number(raw.sheetOpeningBalance)) ? Number(raw.sheetOpeningBalance) : null),
    defaultFundSource: String(raw.defaultFundSource || '').slice(0, 80),
    notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 200).map((n: unknown) => String(n).slice(0, 400)) : [],
    sheetTotals: {},
  };
  if (!out.fileHash) throw new Error('This import preview is missing its file fingerprint. Upload the file again.');
  for (const k of ['income', 'expense', 'balance', 'salaryPaid', 'salaryPending', 'loanIssued', 'loanPaid', 'rentRegular', 'rentUrgent']) {
    const v = Number(raw.sheetTotals?.[k]);
    out.sheetTotals[k] = Number.isFinite(v) ? v : 0;
  }
  let total = 0;
  for (const [list, fields] of Object.entries(ROW_STRINGS)) {
    const rows = Array.isArray(raw[list]) ? raw[list] : [];
    total += rows.length;
    if (total > 20000) throw new Error('The import is too large (more than 20,000 rows).');
    out[list] = rows.map((r: any) => {
      const row: any = { include: r?.include === true };
      for (const f of fields) row[f] = String(r?.[f] ?? '').slice(0, 1000);
      if (Array.isArray(r?.guessed)) row.guessed = r.guessed.slice(0, 12).map((g: unknown) => String(g).slice(0, 30));
      if (r?.skipReason) row.skipReason = String(r.skipReason).slice(0, 600);
      if (r?.payrollHint && typeof r.payrollHint === 'object') {
        const type = String(r.payrollHint.type);
        if (type === 'salary' || type === 'advance' || type === 'loan') {
          row.payrollHint = { employeeRef: String(r.payrollHint.employeeRef || '').slice(0, 200), type };
        }
      }
      if (!row.coveredBy) delete row.coveredBy;
      return row;
    });
  }
  for (const e of out.entries) if (e.kind !== 'income' && e.kind !== 'expense') e.kind = 'expense';
  for (const s of out.salaryPayments) if (s.type !== 'advance') s.type = 'salary';
  for (const r of out.loanRepayments) if (!['cash', 'already-recorded', 'review'].includes(r.treatment)) r.treatment = 'review';
  for (const r of out.rentItems) if (r.category !== 'urgent') r.category = 'regular';
  return out as ImportPlan;
}
