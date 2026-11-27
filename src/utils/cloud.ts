import type {
  ActivityEvent,
  AdminUserSummary,
  AuditChainEntry,
  ChainVerificationResult,
  DepartmentRecord,
  Employee,
  EmployeeLoan,
  EmployeeSpendStat,
  EmployeeAdvance,
  FundSource,
  LedgerHead,
  LedgerTransaction,
  LoanRepayment,
  PeriodLock,
  RentCategory,
  RentItem,
  RentPayment,
  SalaryPayment,
  SecurityEvent,
  TxCategoryGroup,
  UserRole,
} from '../types';
import { getDeviceId, signOut } from './auth';
import type { ImportPlan, ImportValidation } from './importPlan';
import { createCloudSyncRefreshers, type CloudRefreshCallback } from './cloudSync';
import type { PeriodSummary } from './ledger';

async function authFetch(path: string, options: RequestInit = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Id': getDeviceId(),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers, credentials: 'include' });
  if (!res.ok) {
    if (res.status === 503) {
      try {
        const body = await res.clone().json();
        if (body?.maintenance) window.dispatchEvent(new CustomEvent('pace-maintenance', { detail: { on: true } }));
      } catch {}
    }
    if (res.status === 401) {
      try { await signOut(); } catch {}
    }
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export type TransactionSort = 'newest' | 'oldest' | 'amount_desc' | 'amount_asc' | 'party_asc' | 'party_desc' | 'department_asc' | 'voucher_desc' | 'voucher_asc';

export interface TransactionListQuery {
  limit?: number;
  cursor?: string;
  from?: string;
  to?: string;
  kind?: 'all' | 'income' | 'expense';
  head?: string;
  department?: string;
  paymentMethod?: string;
  employeeId?: string;
  fundSourceId?: string;
  auditFilter?: 'all' | 'edited' | 'amount_changed' | 'flagged' | 'receipt' | 'unclassified_dept' | 'flagged_or_changed';
  search?: string;
  sort?: TransactionSort;
}

export interface TransactionPage {
  items: LedgerTransaction[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  totalCount: number;
  incomePaisa: number;
  expensePaisa: number;
  netPaisa: number;
}

export interface PeriodSummaryResponse extends PeriodSummary {
  periodTransactionCount: number;
  periodExpenseCount: number;
  incomeCount: number;
  expenseCount: number;
}

function transactionQueryString(query: TransactionListQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export async function loadTransactions(query: TransactionListQuery = {}): Promise<TransactionPage> {
  return authFetch(`/api/transactions${transactionQueryString({ limit: 50, ...query })}`);
}

export async function loadTransaction(id: string): Promise<LedgerTransaction> {
  return authFetch(`/api/transactions/${encodeURIComponent(id)}`);
}

export async function loadPeriodSummary(from: string, to: string, label: string): Promise<PeriodSummaryResponse> {
  const params = new URLSearchParams({ from, to, label });
  return authFetch(`/api/transactions/summary?${params.toString()}`);
}

export async function loadEmployeeSpendStats(from?: string, to?: string): Promise<EmployeeSpendStat[]> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  return authFetch(`/api/transactions/employee-stats${query ? `?${query}` : ''}`);
}

export interface TransactionFacets {
  departments: string[];
  paymentMethods: string[];
}

export async function loadTransactionFacets(): Promise<TransactionFacets> {
  return authFetch('/api/transactions/facets');
}

export async function loadEmployeeActivityIds(from: string, to: string): Promise<string[]> {
  const params = new URLSearchParams({ from, to });
  return authFetch(`/api/transactions/employee-activity?${params.toString()}`);
}

function startFileDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function downloadTransactionExcel(query: TransactionListQuery = {}, label = 'Daily-Ledger'): void {
  const params = new URLSearchParams(transactionQueryString(query).replace(/^\?/, ''));
  params.set('label', label.slice(0, 80));
  startFileDownload(`/api/transactions/export.xlsx?${params.toString()}`);
}

export function downloadTransactionCsv(query: TransactionListQuery = {}, label = 'Ledger-Transactions'): void {
  const params = new URLSearchParams(transactionQueryString(query).replace(/^\?/, ''));
  params.set('label', label.slice(0, 80));
  startFileDownload(`/api/transactions/export.csv?${params.toString()}`);
}

export function downloadStatementExcel(from: string, to: string, label: string): void {
  const params = new URLSearchParams({ report: 'statement', from, to, label: label.slice(0, 80) });
  startFileDownload(`/api/transactions/export.xlsx?${params.toString()}`);
}

export async function loadFundSources(): Promise<FundSource[]> {
  return authFetch('/api/fund-sources');
}

export async function createFundSource(name: string): Promise<FundSource> {
  return authFetch('/api/fund-sources', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function updateFundSource(id: string, payload: { name?: string; active?: boolean }): Promise<FundSource> {
  return authFetch(`/api/fund-sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export interface SaveTxPayload {
  kind: 'income' | 'expense';
  txDate: string;
  amount: string;
  department: string;
  head: string;
  subCategory: string;
  paymentMethod: string;
  referenceNo: string;
  counterparty: string;
  counterpartyPhone?: string;
  purpose: string;
  notes?: string;
  employeeId?: string;
  employeeName?: string;
  categoryGroup?: TxCategoryGroup;
  fundSourceId: string;
  reason?: string;
  receipt?: { name: string; data: string };
}

export async function createTransaction(payload: SaveTxPayload): Promise<LedgerTransaction> {
  return authFetch('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
}

export async function editTransaction(id: string, payload: SaveTxPayload): Promise<LedgerTransaction> {
  return authFetch(`/api/transactions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function verifyOrFlagTransaction(
  id: string,
  status: 'verified' | 'flagged',
  note: string,
): Promise<LedgerTransaction> {
  return authFetch(`/api/transactions/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
    body: JSON.stringify({ status, note }),
  });
}

export async function voidTransaction(id: string, reason: string): Promise<void> {
  await authFetch(`/api/transactions/${encodeURIComponent(id)}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function restoreTransaction(id: string): Promise<void> {
  await authFetch(`/api/transactions/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}

export async function loadEmployees(): Promise<Employee[]> {
  return authFetch('/api/employees');
}

export async function createEmployee(payload: {
  code?: string;
  name: string;
  role: string;
  department: string;
  branch: string;
  phone: string;
  email?: string;
  monthlySalary?: string;
  joinedDate?: string;
  notes?: string;
  photoUrl?: string;
}): Promise<Employee> {
  return authFetch('/api/employees', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateEmployee(
  id: string,
  payload: {
    name?: string;
    role?: string;
    department?: string;
    branch?: string;
    phone?: string;
    email?: string;
    monthlySalary?: string;
    joinedDate?: string;
    active?: boolean;
    notes?: string;
    photoUrl?: string;
  },
): Promise<Employee> {
  return authFetch(`/api/employees/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function loadAdvances(): Promise<EmployeeAdvance[]> {
  return authFetch('/api/advances');
}

export async function createSalaryAdvance(payload: {
  employeeId: string;
  monthKey?: string;
  issuedDate: string;
  amount: string;
  department: string;
  fundSourceId: string;
  paymentMethod: string;
  purpose: string;
}): Promise<EmployeeAdvance> {
  return authFetch('/api/advances', { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteSalaryAdvance(id: string): Promise<void> {
  await authFetch(`/api/advances/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function loadSalaries(monthKey?: string): Promise<SalaryPayment[]> {
  const qs = monthKey ? `?monthKey=${encodeURIComponent(monthKey)}` : '';
  return authFetch(`/api/salaries${qs}`);
}

export async function paySalary(payload: {
  employeeId: string;
  monthKey: string;
  paidDate: string;
  baseSalary: string;
  payAmount?: string;
  bonus?: string;
  otherDeduction?: string;
  paymentMethod: string;
  referenceNo?: string;
  department: string;
  head?: string;
  fundSourceId: string;
  notes?: string;
  receipt?: { name: string; data: string };
}): Promise<{ payment: SalaryPayment }> {
  return authFetch('/api/salaries/pay', { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteSalaryPayment(id: string): Promise<void> {
  await authFetch(`/api/salaries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function loadLoans(): Promise<EmployeeLoan[]> {
  return authFetch('/api/loans');
}

export async function issueLoan(payload: {
  employeeId: string;
  issuedDate: string;
  amount: string;
  monthlyInstallment?: string;
  paymentMethod: string;
  referenceNo?: string;
  department: string;
  head?: string;
  fundSourceId: string;
  purpose: string;
  receipt?: { name: string; data: string };
}): Promise<{ loan: EmployeeLoan }> {
  return authFetch('/api/loans', { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteLoan(id: string): Promise<void> {
  await authFetch(`/api/loans/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function repayLoan(
  id: string,
  payload: {
    paidDate: string;
    amount: string;
    paymentMethod: string;
    referenceNo?: string;
    department: string;
    head?: string;
    fundSourceId: string;
    note?: string;
    receipt?: { name: string; data: string };
  },
): Promise<{ loan: EmployeeLoan; repayment: LoanRepayment }> {
  return authFetch(`/api/loans/${encodeURIComponent(id)}/repay`, { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteLoanRepayment(loanId: string, repaymentId: string): Promise<{ ok: boolean; loan: EmployeeLoan }> {
  return authFetch(`/api/loans/${encodeURIComponent(loanId)}/repayments/${encodeURIComponent(repaymentId)}`, {
    method: 'DELETE',
  });
}

export async function loadHeads(): Promise<LedgerHead[]> {
  return authFetch('/api/heads');
}

export async function saveHead(payload: {
  kind: 'income' | 'expense';
  name: string;
  description?: string;
  active?: boolean;
}): Promise<LedgerHead> {
  return authFetch('/api/heads', { method: 'POST', body: JSON.stringify(payload) });
}

export async function renameHead(
  id: string,
  payload: { name: string; description?: string },
): Promise<LedgerHead> {
  return authFetch(`/api/heads/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function loadDepartments(): Promise<DepartmentRecord[]> {
  return authFetch('/api/departments');
}

export async function saveDepartment(payload: {
  name: string;
  description?: string;
  active?: boolean;
}): Promise<DepartmentRecord> {
  return authFetch('/api/departments', { method: 'POST', body: JSON.stringify(payload) });
}

export async function renameDepartment(
  id: string,
  payload: { name: string; description?: string },
): Promise<DepartmentRecord> {
  return authFetch(`/api/departments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function loadRentItems(): Promise<RentItem[]> {
  return authFetch('/api/rent-items');
}

export async function createRentItem(payload: {
  sl?: number;
  name: string;
  category: RentCategory;
  monthlyAmount: string;
  urgentAmount?: string;
  department: string;
  notes?: string;
  active?: boolean;
}): Promise<RentItem> {
  return authFetch('/api/rent-items', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateRentItem(
  id: string,
  payload: {
    sl?: number;
    name?: string;
    category?: RentCategory;
    monthlyAmount?: string;
    urgentAmount?: string;
    department?: string;
    notes?: string;
    active?: boolean;
  },
): Promise<RentItem> {
  return authFetch(`/api/rent-items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function deleteRentItem(id: string): Promise<void> {
  await authFetch(`/api/rent-items/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function loadRentPayments(monthKey?: string): Promise<RentPayment[]> {
  const qs = monthKey ? `?monthKey=${encodeURIComponent(monthKey)}` : '';
  return authFetch(`/api/rent-payments${qs}`);
}

export async function recordRentPayment(payload: {
  rentItemId: string;
  monthKey: string;
  paidDate: string;
  amount: string;
  department: string;
  fundSourceId: string;
  paymentMethod: string;
  referenceNo?: string;
  notes?: string;
  receipt?: { name: string; data: string };
}): Promise<RentPayment> {
  return authFetch('/api/rent-payments', { method: 'POST', body: JSON.stringify(payload) });
}

export async function deleteRentPayment(id: string): Promise<void> {
  await authFetch(`/api/rent-payments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function loadPeriodLocks(): Promise<PeriodLock[]> {
  return authFetch('/api/locks');
}

export async function lockPeriod(periodKey: string, note: string): Promise<PeriodLock> {
  return authFetch('/api/locks', { method: 'POST', body: JSON.stringify({ periodKey, note }) });
}

export async function unlockPeriod(periodKey: string, reason: string, password: string): Promise<void> {
  await authFetch(`/api/locks/${encodeURIComponent(periodKey)}/unlock`, {
    method: 'POST',
    body: JSON.stringify({ reason, password }),
  });
}

export async function loadAuditChain(): Promise<AuditChainEntry[]> {
  return authFetch('/api/audit');
}

export async function verifyAuditChain(): Promise<ChainVerificationResult> {
  return authFetch('/api/audit/verify');
}

export async function loadActivity(): Promise<ActivityEvent[]> {
  return authFetch('/api/activity');
}

export async function loadUserAvatars(): Promise<Record<string, string>> {
  return authFetch('/api/auth/avatars');
}

export async function listUsers(): Promise<AdminUserSummary[]> {
  return authFetch('/api/admin/users');
}

export async function createUserAccount(
  _token: string,
  username: string,
  password: string,
  displayName: string,
  role: UserRole = 'user',
): Promise<AdminUserSummary> {
  return authFetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, displayName, role }) });
}

export async function adminUpdateUser(
  id: string,
  payload: { username?: string; displayName?: string; role?: UserRole; phoneNumber?: string; email?: string },
): Promise<AdminUserSummary> {
  return authFetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function disableUserAccount(_token: string, id: string, disabled: boolean): Promise<void> {
  await authFetch(`/api/admin/users/${encodeURIComponent(id)}/disabled`, { method: 'PATCH', body: JSON.stringify({ disabled }) });
}

export async function resetUserPassword(id: string, password: string): Promise<void> {
  await authFetch(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
}

export interface DeletedTransactionPage {
  items: LedgerTransaction[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  totalCount: number;
}

export async function loadBin(query: { limit?: number; cursor?: string } = {}): Promise<DeletedTransactionPage> {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit || 50));
  if (query.cursor) params.set('cursor', query.cursor);
  return authFetch(`/api/admin/bin?${params.toString()}`);
}

export async function loadSecurityLog(): Promise<SecurityEvent[]> {
  return authFetch('/api/admin/security-events');
}

export async function downloadFullBackup(): Promise<void> {
  startFileDownload('/api/admin/backup');
}

export async function downloadSqliteBackup(): Promise<void> {
  startFileDownload('/api/admin/backup/sqlite');
}

export async function restoreSqliteBackup(file: File, password: string): Promise<{ transactionCount: number }> {
  const response = await fetch('/api/admin/restore-sqlite', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/vnd.sqlite3',
      'X-Admin-Password': password,
      'X-Device-Id': getDeviceId(),
    },
    body: file,
  });
  if (!response.ok) {
    let message = `Restore failed (${response.status}).`;
    try { const body = await response.json(); if (body?.error) message = body.error; } catch { }
    throw new Error(message);
  }
  return response.json();
}

export async function previewExcelImport(file: File): Promise<ImportValidation> {
  const response = await fetch('/api/admin/import/preview', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-Device-Id': getDeviceId(),
    },
    body: file,
  });
  if (!response.ok) {
    let message = `Could not read that file (${response.status}).`;
    try { const body = await response.json(); if (body?.error) message = body.error; } catch { }
    throw new Error(message);
  }
  return (await response.json()).validation;
}

export async function validateExcelImport(plan: ImportPlan): Promise<ImportValidation> {
  return (await authFetch('/api/admin/import/validate', { method: 'POST', body: JSON.stringify({ plan }) })).validation;
}

export async function commitExcelImport(plan: ImportPlan, password: string): Promise<Record<string, number | string>> {
  return (await authFetch('/api/admin/import/commit', { method: 'POST', body: JSON.stringify({ plan, password }) })).result;
}

export async function restoreFullBackup(backup: unknown, password: string): Promise<void> {
  await authFetch('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup, password }) });
}

export async function wipeDatabase(
  password: string,
  confirmText: string,
  includeUsers: boolean,
): Promise<{ ok: boolean; factoryReset: boolean }> {
  return authFetch('/api/admin/wipe', {
    method: 'POST',
    body: JSON.stringify({ password, confirmText, includeUsers }),
  });
}

export function subscribeToCloud(callbacks: {
  transactions?: CloudRefreshCallback;
  heads?: CloudRefreshCallback;
  departments?: CloudRefreshCallback;
  locks?: CloudRefreshCallback;
  audit?: CloudRefreshCallback;
  activity?: CloudRefreshCallback;
  employees?: CloudRefreshCallback;
  salaries?: CloudRefreshCallback;
  loans?: CloudRefreshCallback;
  advances?: CloudRefreshCallback;
  fundSources?: CloudRefreshCallback;
  rentItems?: CloudRefreshCallback;
  rentPayments?: CloudRefreshCallback;
  me?: CloudRefreshCallback;
  maintenance?: (state: { on: boolean; since?: number }) => void;
}) {
  const sync = createCloudSyncRefreshers({
    ...callbacks,
    fetchStatus: () => authFetch('/api/status'),
  });

  let closed = false;
  let es: EventSource | null = null;
  let reconnectTimer: number | null = null;
  let debounceTimer: number | null = null;

  const scheduleRefresh = () => {
    if (debounceTimer) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => { void sync.refreshAll(); }, 250);
  };

  const connect = () => {
    if (closed) return;
    try {
      es = new EventSource('/api/events', { withCredentials: true });
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'maintenance' && msg?.payload) {
            callbacks.maintenance?.({ on: Boolean(msg.payload.on), since: msg.payload.since });
            return;
          }
          scheduleRefresh();
        } catch {
          scheduleRefresh();
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (!closed && !reconnectTimer) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 4000);
        }
      };
    } catch {}
  };

  connect();
  const poll = window.setInterval(() => {
    if (!document.hidden) void sync.refreshAll();
  }, 30000);

  return () => {
    closed = true;
    sync.dispose();
    if (es) es.close();
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (debounceTimer) window.clearTimeout(debounceTimer);
    window.clearInterval(poll);
  };
}
