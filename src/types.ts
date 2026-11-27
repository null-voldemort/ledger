import type { UserRole } from './utils/roles';
export type { UserRole };
export type ThemeMode = 'light' | 'dark';

export interface AppUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  theme?: ThemeMode;
  phoneNumber?: string;
  email?: string;
  photoUrl?: string;
  disabled?: boolean;
  createdAt?: string;
}

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  role: string;
  theme?: ThemeMode;
  phoneNumber?: string;
  email?: string;
  photoUrl?: string;
  disabled: boolean;
  createdAt: string;
  txCount?: number;
}

export interface SecurityEvent {
  id: string;
  at: string;
  type: string;
  username: string;
  ip: string;
  detail: string;
  meta?: {
    browser?: string;
    os?: string;
    device?: string;
    ua?: string;
    deviceId?: string;
    screen?: string;
    tz?: string;
    lang?: string;
    host?: string;
    mac?: string;
    newDevice?: boolean;
  } | null;
}

export type LedgerKind = 'income' | 'expense';
export type TxStatus = 'verified' | 'pending_review' | 'flagged';
export type TxCategoryGroup = 'general' | 'salary' | 'salary_advance' | 'loan_issue' | 'loan_repayment' | 'rent';

export interface DepartmentRecord {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  sortOrder: number;
}

export interface FundSource {
  id: string;
  name: string;
  active: boolean;
  incomePaisa: number;
  spentPaisa: number;
  balancePaisa: number;
  transactionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeAdvanceRepayment {
  id: string;
  advanceId: string;
  salaryPaymentId: string;
  paidDate: string;
  amountPaisa: number;
  createdAt: string;
}

export interface EmployeeAdvance {
  id: string;
  advanceNo: string;
  employeeId: string;
  employeeName: string;
  monthKey: string;
  issuedDate: string;
  principalPaisa: number;
  remainingPaisa: number;
  department: string;
  purpose: string;
  fundSourceId: string;
  fundSourceName: string;
  linkedTxId: string;
  linkedVoucherNo: string;
  status: 'active' | 'settled';
  createdAt: string;
  repayments: EmployeeAdvanceRepayment[];
}

export interface FieldDiff {
  field: string;
  from: string;
  to: string;
}

export interface TxEditEntry {
  at: string;
  byId: string;
  byName: string;
  byRole: UserRole;
  reason: string;
  amountDeltaPaisa?: number;
  changes: FieldDiff[];
}

export interface LedgerTransaction {
  id: string;
  voucherNo: string;
  kind: LedgerKind;
  txDate: string;
  amountPaisa: number;
  department: string;
  departmentReview?: boolean;
  head: string;
  subCategory: string;
  paymentMethod: string;
  referenceNo: string;
  counterparty: string;
  counterpartyPhone?: string;
  purpose: string;
  notes?: string;
  fundedByTxId?: string;
  employeeId?: string;
  employeeName?: string;
  categoryGroup?: TxCategoryGroup;
  fundSourceId: string;
  fundSourceName?: string;
  receiptSha?: string;
  receiptName?: string;
  receiptType?: string;
  status: TxStatus;
  verifiedByName?: string;
  verifiedAt?: string;
  flagNote?: string;
  editCount: number;
  amountChanged: boolean;
  lastEditedAt?: string;
  lastEditedBy?: string;
  lastEditReason?: string;
  editHistory: TxEditEntry[];
  createdAt: string;
  createdById: string;
  createdByName: string;
  updatedAt: string;
  deletedAt?: string;
  deletedBy?: string;
  deleteReason?: string;
}

export interface Employee {
  id: string;
  code: string;
  name: string;
  role: string;
  department: string;
  branch: string;
  phone: string;
  email?: string;
  photoUrl?: string;
  monthlySalaryPaisa: number;
  joinedDate: string;
  active: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SalaryPayment {
  id: string;
  employeeId: string;
  employeeName: string;
  monthKey: string;
  paidDate: string;
  baseSalaryPaisa: number;
  bonusPaisa: number;
  loanDeductionPaisa: number;
  advanceDeductionPaisa: number;
  otherDeductionPaisa: number;
  netPaidPaisa: number;
  paymentMethod: string;
  referenceNo: string;
  department: string;
  head: string;
  fundSourceId: string;
  notes?: string;
  receiptSha?: string;
  receiptName?: string;
  receiptType?: string;
  linkedTxId?: string;
  linkedVoucherNo?: string;
  paidById: string;
  paidByName: string;
  createdAt: string;
}

export interface LoanRepayment {
  id: string;
  loanId: string;
  paidDate: string;
  amountPaisa: number;
  source: 'cash' | 'salary_deduction' | 'historical';
  fundSourceId?: string;
  fundSourceName?: string;
  department?: string;
  paymentMethod: string;
  referenceNo?: string;
  note?: string;
  salaryPaymentId?: string;
  receiptSha?: string;
  receiptName?: string;
  receiptType?: string;
  linkedTxId?: string;
  linkedVoucherNo?: string;
  recordedById: string;
  recordedByName: string;
  createdAt: string;
}

export interface EmployeeLoan {
  id: string;
  loanNo: string;
  employeeId: string;
  employeeName: string;
  issuedDate: string;
  principalPaisa: number;
  remainingPaisa: number;
  monthlyInstallmentPaisa: number;
  paymentMethod: string;
  referenceNo?: string;
  department: string;
  head: string;
  fundSourceId: string;
  purpose: string;
  status: 'active' | 'settled';
  receiptSha?: string;
  receiptName?: string;
  receiptType?: string;
  linkedTxId?: string;
  linkedVoucherNo?: string;
  issuedById: string;
  issuedByName: string;
  createdAt: string;
  settledAt?: string;
  repayments: LoanRepayment[];
}

export type RentCategory = 'regular' | 'urgent';

export interface RentItem {
  id: string;
  sl: number;
  name: string;
  category: RentCategory;
  monthlyAmountPaisa: number;
  urgentAmountPaisa: number;
  department: string;
  notes?: string;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface RentPayment {
  id: string;
  rentItemId: string;
  rentItemName: string;
  monthKey: string;
  paidDate: string;
  amountPaisa: number;
  department: string;
  fundSourceId: string;
  fundSourceName?: string;
  paymentMethod: string;
  referenceNo?: string;
  notes?: string;
  receiptSha?: string;
  receiptName?: string;
  receiptType?: string;
  linkedTxId?: string;
  linkedVoucherNo?: string;
  paidById: string;
  paidByName: string;
  createdAt: string;
}

export interface EmployeeSpendStat {
  employee: Employee;
  salaryPaisa: number;
  operationalTakenPaisa: number;
  loanIssuedPaisa: number;
  activeLoanPaisa: number;
  totalTakenPaisa: number;
  txCount: number;
  avgOperationalPaisa: number;
  spendLevel: 'high' | 'normal' | 'low';
}

export interface LedgerHead {
  id: string;
  kind: LedgerKind;
  name: string;
  description?: string;
  active: boolean;
  sortOrder: number;
}

export interface PeriodLock {
  id: string;
  periodKey: string;
  label: string;
  openingPaisa: number;
  incomePaisa: number;
  expensePaisa: number;
  closingPaisa: number;
  lockedAt: string;
  lockedById: string;
  lockedByName: string;
  note?: string;
}

export interface AuditChainEntry {
  seq: number;
  at: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  eventType: string;
  entryId: string;
  voucherNo: string;
  reason: string;
  diff: FieldDiff[];
  amountDeltaPaisa: number;
  prevHash: string;
  entryHash: string;
}

export interface ChainVerificationResult {
  ok: boolean;
  totalEntries: number;
  checkedAt: string;
  brokenLinks: { seq: number; voucherNo: string; issue: string }[];
  stateMismatches: { txId: string; voucherNo: string; issue: string }[];
}

export interface ActivityEvent {
  id: string;
  at: string;
  by: string;
  action: string;
  voucherNo?: string;
  head?: string;
  amountPaisa?: number;
  detail?: string;
}
