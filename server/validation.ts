import { toPaisa } from '../src/utils/money';
import type { RentCategory, TxCategoryGroup } from '../src/types';

export function decodeBase64Payload(raw: string): Buffer {
  const s = String(raw || '').trim().replace(/^data:[^;]+;base64,/, '');
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw new Error('Invalid base64 payload.');
  }
  const buf = Buffer.from(s, 'base64');
  if (!buf.length) throw new Error('Empty file payload.');
  return buf;
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export interface ValidatedTxInput {
  kind: 'income' | 'expense';
  txDate: string;
  amountPaisa: number;
  department: string;
  departmentReview?: boolean;
  head: string;
  subCategory: string;
  paymentMethod: string;
  referenceNo: string;
  counterparty: string;
  counterpartyPhone: string;
  purpose: string;
  notes: string;
  fundedByTxId?: string;
  employeeId?: string;
  employeeName?: string;
  categoryGroup?: TxCategoryGroup;
  fundSourceId: string;
  reason?: string;
}

function cleanStr(v: unknown, max: number): string {
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function parsePaisaField(paisaVal: unknown, strVal: unknown, allowZero = false): number | null {
  let out: number | null = null;
  if (typeof paisaVal === 'number' && Number.isSafeInteger(paisaVal)) {
    out = paisaVal;
  } else if (strVal !== undefined && strVal !== '') {
    out = toPaisa(strVal as string | number);
  } else if (allowZero) {
    out = 0;
  }
  if (out === null) return null;
  if (allowZero ? out < 0 : out <= 0) return null;
  if (out > 10_000_000_000) return null;
  return out;
}

export function validateTransactionInput(body: any, isEdit: boolean): ValidatedTxInput {
  if (!body || typeof body !== 'object') throw new Error('Invalid transaction payload.');
  const kind = body.kind;
  if (kind !== 'income' && kind !== 'expense') throw new Error('Transaction type must be income or expense.');
  if (!isIsoDate(body.txDate)) throw new Error('Valid transaction date (YYYY-MM-DD) is required.');

  const amountPaisa = parsePaisaField(body.amountPaisa, body.amount, false);
  if (!amountPaisa) {
    throw new Error('Amount must be greater than ৳0.00 and within valid limits.');
  }

  const department = cleanStr(body.department, 80);
  if (!department) throw new Error('Department is required.');

  const head = cleanStr(body.head, 80) || department;
  if (!head) throw new Error(kind === 'income' ? 'Income source channel is required.' : 'Expense office/head is required.');

  const subCategory = cleanStr(body.subCategory, 80);
  if (!subCategory) throw new Error('Transaction category is required.');
  const paymentMethod = cleanStr(body.paymentMethod, 60);
  if (!paymentMethod) throw new Error('Payment method is required.');
  const referenceNo = cleanStr(body.referenceNo, 80);
  const counterparty = cleanStr(body.counterparty, 120);
  if (!counterparty) {
    throw new Error(kind === 'income' ? 'Sender / source person is required.' : 'Payee / vendor / where spent is required.');
  }
  const counterpartyPhone = cleanStr(body.counterpartyPhone, 40);
  const purpose = cleanStr(body.purpose, 400);
  if (!purpose || purpose.length < 2) {
    throw new Error(kind === 'income' ? 'Reason / purpose for receiving funds is required.' : 'Reason / purpose for spending is required.');
  }
  const notes = cleanStr(body.notes, 1000);
  const fundedByTxId = cleanStr(body.fundedByTxId, 64) || undefined;
  const employeeId = cleanStr(body.employeeId, 64) || undefined;
  const employeeName = cleanStr(body.employeeName, 120) || undefined;
  const validGroups: TxCategoryGroup[] = ['general', 'salary', 'salary_advance', 'loan_issue', 'loan_repayment', 'rent'];
  const categoryGroup = validGroups.includes(body.categoryGroup) ? (body.categoryGroup as TxCategoryGroup) : 'general';
  const fundSourceId = cleanStr(body.fundSourceId, 64);
  if (!fundSourceId) throw new Error('Select the fund source for this transaction.');

  let reason: string | undefined;
  if (isEdit) {
    reason = cleanStr(body.reason, 300);
    if (!reason || reason.length < 3) {
      throw new Error('Every edit requires a short reason (at least 3 characters) for the audit log.');
    }
  }

  return {
    kind,
    txDate: body.txDate,
    amountPaisa,
    department,
    departmentReview: false,
    head,
    subCategory,
    paymentMethod,
    referenceNo,
    counterparty,
    counterpartyPhone,
    purpose,
    notes,
    fundedByTxId,
    employeeId,
    employeeName,
    categoryGroup,
    fundSourceId,
    reason,
  };
}

export function validateEmployeeInput(body: any, isEdit = false) {
  if (!body || typeof body !== 'object') throw new Error('Invalid employee payload.');
  const name = cleanStr(body.name, 100);
  if (!isEdit && (!name || name.length < 2)) throw new Error('Employee full name is required.');
  const role = cleanStr(body.role, 80);
  const department = cleanStr(body.department, 80);
  const branch = cleanStr(body.branch, 80);
  if (!isEdit && !role) throw new Error('Employee role or designation is required.');
  const phone = cleanStr(body.phone, 40);
  const email = cleanStr(body.email, 120);
  const joinedDate = body.joinedDate && isIsoDate(body.joinedDate) ? body.joinedDate : '';
  const notes = cleanStr(body.notes, 500);
  const code = cleanStr(body.code, 32);

  let monthlySalaryPaisa: number | undefined;
  if (body.monthlySalaryPaisa !== undefined || body.monthlySalary !== undefined) {
    const parsed = parsePaisaField(body.monthlySalaryPaisa, body.monthlySalary, true);
    if (parsed === null) throw new Error('Invalid monthly salary amount.');
    monthlySalaryPaisa = parsed;
  }

  return {
    name,
    role: role || '',
    department: department || '',
    branch: branch || '',
    phone,
    email,
    joinedDate: String(joinedDate),
    notes,
    code,
    monthlySalaryPaisa,
    active: body.active !== undefined ? Boolean(body.active) : undefined,
    photoUrl: body.photoUrl !== undefined ? String(body.photoUrl || '') : undefined,
  };
}

export function validateSalaryPayInput(body: any) {
  if (!body || typeof body !== 'object') throw new Error('Invalid salary payment payload.');
  const employeeId = cleanStr(body.employeeId, 64);
  if (!employeeId) throw new Error('Employee is required.');
  const monthKey = cleanStr(body.monthKey, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('Valid salary month (YYYY-MM) is required.');
  if (!isIsoDate(body.paidDate)) throw new Error('Valid payment date (YYYY-MM-DD) is required.');

  const baseSalaryPaisa = parsePaisaField(body.baseSalaryPaisa, body.baseSalary, true) ?? 0;
  const bonusPaisa = parsePaisaField(body.bonusPaisa, body.bonus, true) ?? 0;
  const otherDeductionPaisa = parsePaisaField(body.otherDeductionPaisa, body.otherDeduction, true) ?? 0;
  const payAmountPaisa = body.payAmountPaisa !== undefined || body.payAmount !== undefined
    ? parsePaisaField(body.payAmountPaisa, body.payAmount, true)
    : undefined;

  if (payAmountPaisa === null) throw new Error('Invalid salary payment amount.');

  const paymentMethod = cleanStr(body.paymentMethod, 60);
  if (!paymentMethod) throw new Error('Payment method is required.');
  const referenceNo = cleanStr(body.referenceNo, 80);
  const department = cleanStr(body.department, 80);
  if (!department) throw new Error('Department is required.');
  const head = cleanStr(body.head, 80) || department;
  const fundSourceId = cleanStr(body.fundSourceId, 64);
  if (!fundSourceId) throw new Error('Select the funding source for salary payment.');
  const notes = cleanStr(body.notes, 400);

  return {
    employeeId,
    monthKey,
    paidDate: body.paidDate,
    baseSalaryPaisa,
    bonusPaisa,
    otherDeductionPaisa,
    payAmountPaisa,
    paymentMethod,
    referenceNo,
    department,
    head,
    fundSourceId,
    notes,
  };
}

export function validateSalaryAdvanceInput(body: any) {
  if (!body || typeof body !== 'object') throw new Error('Invalid salary advance payload.');
  const employeeId = cleanStr(body.employeeId, 64);
  if (!employeeId) throw new Error('Employee is required.');
  if (!isIsoDate(body.issuedDate)) throw new Error('Valid advance date (YYYY-MM-DD) is required.');
  const monthKey = cleanStr(body.monthKey, 7) || body.issuedDate.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('Valid payroll month (YYYY-MM) is required.');
  const amountPaisa = parsePaisaField(body.amountPaisa, body.amount, false);
  if (!amountPaisa) throw new Error('Advance amount must be greater than ৳0.00.');
  const department = cleanStr(body.department, 80);
  if (!department) throw new Error('Department is required.');
  const fundSourceId = cleanStr(body.fundSourceId, 64);
  if (!fundSourceId) throw new Error('Select the funding source for this advance.');
  const paymentMethod = cleanStr(body.paymentMethod, 60);
  if (!paymentMethod) throw new Error('Payment method is required.');
  const purpose = cleanStr(body.purpose, 400);
  if (!purpose || purpose.length < 3) throw new Error('Reason for the salary advance is required.');
  return { employeeId, issuedDate: body.issuedDate, monthKey, amountPaisa, department, fundSourceId, paymentMethod, purpose };
}

export function validateLoanIssueInput(body: any) {
  if (!body || typeof body !== 'object') throw new Error('Invalid loan payload.');
  const employeeId = cleanStr(body.employeeId, 64);
  if (!employeeId) throw new Error('Employee is required.');
  if (!isIsoDate(body.issuedDate)) throw new Error('Valid issue date (YYYY-MM-DD) is required.');
  const principalPaisa = parsePaisaField(body.principalPaisa, body.amount, false);
  if (!principalPaisa) throw new Error('Loan amount must be greater than ৳0.00.');
  const monthlyInstallmentPaisa = parsePaisaField(body.monthlyInstallmentPaisa, body.monthlyInstallment, true) ?? 0;
  const paymentMethod = cleanStr(body.paymentMethod, 60);
  if (!paymentMethod) throw new Error('Payment method is required.');
  const referenceNo = cleanStr(body.referenceNo, 80);
  const department = cleanStr(body.department, 80);
  if (!department) throw new Error('Department is required.');
  const head = cleanStr(body.head, 80) || department;
  const purpose = cleanStr(body.purpose, 400);
  if (!purpose || purpose.length < 3) throw new Error('Purpose of loan is required.');
  const fundSourceId = cleanStr(body.fundSourceId, 64);
  if (!fundSourceId) throw new Error('Select the funding source for this loan.');

  return {
    employeeId,
    issuedDate: body.issuedDate,
    principalPaisa,
    monthlyInstallmentPaisa,
    paymentMethod,
    referenceNo,
    department,
    head,
    fundSourceId,
    purpose,
  };
}

export function validateLoanRepayInput(body: any) {
  if (!body || typeof body !== 'object') throw new Error('Invalid repayment payload.');
  if (!isIsoDate(body.paidDate)) throw new Error('Valid repayment date (YYYY-MM-DD) is required.');
  const amountPaisa = parsePaisaField(body.amountPaisa, body.amount, false);
  if (!amountPaisa) throw new Error('Repayment amount must be greater than ৳0.00.');
  const paymentMethod = cleanStr(body.paymentMethod, 60);
  if (!paymentMethod) throw new Error('Payment method is required.');
  const referenceNo = cleanStr(body.referenceNo, 80);
  const department = cleanStr(body.department, 80);
  if (!department) throw new Error('Department is required.');
  const head = cleanStr(body.head, 80) || 'OTHER-INCOME';
  const fundSourceId = cleanStr(body.fundSourceId, 64);
  if (!fundSourceId) throw new Error('Select the fund source receiving the repayment.');
  const note = cleanStr(body.note, 300);

  return {
    paidDate: body.paidDate,
    amountPaisa,
    paymentMethod,
    referenceNo,
    department,
    head,
    fundSourceId,
    note,
  };
}

export function validateRentItemInput(body: any, isEdit = false) {
  if (!body || typeof body !== 'object') throw new Error('Invalid rent item payload.');
  const name = cleanStr(body.name, 120);
  if (!isEdit && (!name || name.length < 2)) throw new Error('Rent item name is required.');
  const category: RentCategory = body.category === 'urgent' ? 'urgent' : 'regular';
  const monthlyAmountPaisa = body.monthlyAmountPaisa !== undefined || body.monthlyAmount !== undefined
    ? parsePaisaField(body.monthlyAmountPaisa, body.monthlyAmount, true)
    : undefined;
  const urgentAmountPaisa = body.urgentAmountPaisa !== undefined || body.urgentAmount !== undefined
    ? parsePaisaField(body.urgentAmountPaisa, body.urgentAmount, true)
    : undefined;
  if (monthlyAmountPaisa === null) throw new Error('Invalid monthly rent amount.');
  if (urgentAmountPaisa === null) throw new Error('Invalid urgent rent amount.');
  if (!isEdit && (monthlyAmountPaisa ?? 0) === 0 && (urgentAmountPaisa ?? 0) === 0) {
    throw new Error('Enter a regular monthly amount or urgent amount greater than ৳0.00.');
  }
  const department = cleanStr(body.department, 80);
  if (!isEdit && !department) throw new Error('Department is required.');
  const notes = cleanStr(body.notes, 300);
  const sl = body.sl !== undefined ? Math.max(0, Math.round(Number(body.sl) || 0)) : undefined;

  return {
    name: name || undefined,
    category: body.category !== undefined ? category : undefined,
    monthlyAmountPaisa,
    urgentAmountPaisa,
    department: department || undefined,
    notes: body.notes !== undefined ? notes : undefined,
    sl,
    active: body.active !== undefined ? Boolean(body.active) : undefined,
  };
}

export function validateRentPaymentInput(body: any) {
  if (!body || typeof body !== 'object') throw new Error('Invalid rent payment payload.');
  const rentItemId = cleanStr(body.rentItemId, 64);
  if (!rentItemId) throw new Error('Select a rent obligation item.');
  const monthKey = cleanStr(body.monthKey, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('Valid month (YYYY-MM) is required.');
  if (!isIsoDate(body.paidDate)) throw new Error('Valid payment date (YYYY-MM-DD) is required.');
  const amountPaisa = parsePaisaField(body.amountPaisa, body.amount, false);
  if (!amountPaisa) throw new Error('Rent payment amount must be greater than ৳0.00.');
  const department = cleanStr(body.department, 80);
  if (!department) throw new Error('Department is required.');
  const fundSourceId = cleanStr(body.fundSourceId, 64);
  if (!fundSourceId) throw new Error('Select the funding source for rent payment.');
  const paymentMethod = cleanStr(body.paymentMethod, 60);
  if (!paymentMethod) throw new Error('Payment method is required.');
  const referenceNo = cleanStr(body.referenceNo, 80);
  const notes = cleanStr(body.notes, 400);

  return {
    rentItemId,
    monthKey,
    paidDate: body.paidDate,
    amountPaisa,
    department,
    fundSourceId,
    paymentMethod,
    referenceNo,
    notes,
  };
}

export function validateFullBackupShape(raw: any): void {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid backup file.');
  if (raw.format !== 'pace-it-ledger-backup') throw new Error('Unsupported backup format.');
  if (!raw.tables || typeof raw.tables !== 'object') throw new Error('Backup is missing tables.');
  const required = ['ledger_heads', 'transactions', 'period_locks', 'ledger_audit'];
  for (const t of required) {
    const tbl = raw.tables[t];
    if (!tbl || !Array.isArray(tbl.columns) || !Array.isArray(tbl.rows)) {
      throw new Error(`Backup table "${t}" is missing or malformed.`);
    }
  }
}
