import type {
  Employee,
  EmployeeLoan,
  EmployeeSpendStat,
  LedgerHead,
  LedgerTransaction,
  SalaryPayment,
} from '../types';

export type TimeframeMode = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

export const DEFAULT_INCOME_HEADS: Omit<LedgerHead, 'id'>[] = [
  { kind: 'income', name: 'BRAC-BANK-ATM', description: 'ATM cash deposit or withdrawal from BRAC Bank', active: true, sortOrder: 1 },
  { kind: 'income', name: 'BRAC-BANK-Cheque', description: 'Company cheque issued via BRAC Bank', active: true, sortOrder: 2 },
  { kind: 'income', name: 'OWNER-CASH', description: 'Direct cash capital from Ownership / Treasury', active: true, sortOrder: 3 },
  { kind: 'income', name: 'MITHU-CASH', description: 'Cash received through Mithu', active: true, sortOrder: 4 },
  { kind: 'income', name: 'SUMON-CASH', description: 'Cash received through Sumon', active: true, sortOrder: 5 },
  { kind: 'income', name: 'BRAC-BANK-TRANSFER', description: 'Online / EFTN / NPSB transfer to BRAC Bank account', active: true, sortOrder: 6 },
  { kind: 'income', name: 'NETWORK-BAZAR', description: 'Funds received from Network Bazar', active: true, sortOrder: 7 },
  { kind: 'income', name: 'OTHER-INCOME', description: 'Miscellaneous verified inflows', active: true, sortOrder: 8 },
];

export const DEFAULT_EXPENSE_HEADS: Omit<LedgerHead, 'id'>[] = [
  { kind: 'expense', name: 'ALHAMRA-OFFICE', description: 'Head office operations, rent, bills & staff', active: true, sortOrder: 1 },
  { kind: 'expense', name: 'BALUCHOR-OFFICE', description: 'Branch office operations', active: true, sortOrder: 2 },
  { kind: 'expense', name: 'SHIBGONJ-OFFICE', description: 'Branch office operations', active: true, sortOrder: 3 },
  { kind: 'expense', name: 'DASPARA-OFFICE', description: 'Branch office operations', active: true, sortOrder: 4 },
  { kind: 'expense', name: 'SHAPORAN-OFFICE', description: 'Branch office operations', active: true, sortOrder: 5 },
  { kind: 'expense', name: 'BOTESSOR-OFFICE', description: 'Branch office operations', active: true, sortOrder: 6 },
  { kind: 'expense', name: 'SUBID-BAZAR-OFFICE', description: 'Branch office operations', active: true, sortOrder: 7 },
  { kind: 'expense', name: 'AMBORKHANA-OFFICE', description: 'Branch office operations', active: true, sortOrder: 8 },
  { kind: 'expense', name: 'EDC-PROJECT', description: 'Field fiber installations & project expenses', active: true, sortOrder: 9 },
  { kind: 'expense', name: 'OTHERS-COMPANY', description: 'Third-party vendors & partner company payments', active: true, sortOrder: 10 },
  { kind: 'expense', name: 'UPSTREAM', description: 'Upstream bandwidth & transit provider bills', active: true, sortOrder: 11 },
  { kind: 'expense', name: 'OWNER', description: 'Owner drawings, capital settlements & returns', active: true, sortOrder: 12 },
];

export const DEFAULT_DEPARTMENTS: { name: string; description: string; sortOrder: number }[] = [
  { name: 'ALHAMRA-OFFICE', description: 'Head office operations, rent, utilities & central staff', sortOrder: 1 },
  { name: 'BALUCHOR-OFFICE', description: 'Baluchor branch office operations', sortOrder: 2 },
  { name: 'SHIBGONJ-OFFICE', description: 'Shibgonj branch office operations', sortOrder: 3 },
  { name: 'DASPARA-OFFICE', description: 'Daspara branch office operations', sortOrder: 4 },
  { name: 'SHAPORAN-OFFICE', description: 'Shaporan branch office operations', sortOrder: 5 },
  { name: 'BOTESSOR-OFFICE', description: 'Botessor branch office operations', sortOrder: 6 },
  { name: 'SUBID-BAZAR-OFFICE', description: 'Subid Bazar branch office operations', sortOrder: 7 },
  { name: 'AMBORKHANA-OFFICE', description: 'Amborkhana branch office operations', sortOrder: 8 },
  { name: 'EDC-PROJECT', description: 'EDC fiber project & infrastructure work', sortOrder: 9 },
  { name: 'OTHERS-COMPANY', description: 'Third-party vendors, partners & company settlements', sortOrder: 10 },
  { name: 'UPSTREAM', description: 'Upstream bandwidth & transit providers', sortOrder: 11 },
  { name: 'OWNER', description: 'Owner capital, drawings & direct owner items', sortOrder: 12 },
];

export const PAYMENT_METHODS = [
  'Cash in Hand',
  'BRAC Bank ATM',
  'BRAC Bank Transfer',
  'Bank Cheque',
  'bKash / Nagad',
  'Card / POS',
  'Adjustment',
] as const;

export const EXPENSE_PURPOSES = [
  'Salary & Staff Allowance',
  'Office Rent & Service Charge',
  'Electricity, Water & Gas',
  'Internet & Upstream Bill',
  'Fiber, ONU & Router Hardware',
  'Field Work & Installations',
  'Employee Loan / Advance',
  'Transport & Conveyance',
  'Vendor / Company Payment',
  'Maintenance & Repair',
  'Food & Refreshment',
  'Owner Settlement',
  'Miscellaneous',
] as const;

export const INCOME_PURPOSES = [
  'Company Fund Transfer',
  'Operating Budget Top-up',
  'Field Operations Advance',
  'Field Project Advance',
  'Loan Cash Return',
  'Upstream Bill Coverage',
  'Client / Partner Collection',
  'Cash Float Return',
  'Other Receipt',
] as const;

export function dhakaToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value || '2026';
  const m = parts.find((p) => p.type === 'month')?.value || '01';
  const d = parts.find((p) => p.type === 'day')?.value || '01';
  return `${y}-${m}-${d}`;
}

export function dhakaMonth(): string {
  return dhakaToday().slice(0, 7);
}

export function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export function weekRangeOf(isoDate: string): { from: string; to: string; label: string } {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const daysSinceSat = (dow + 1) % 7;
  const from = addDays(isoDate, -daysSinceSat);
  const to = addDays(from, 6);
  return { from, to, label: `${formatShortDate(from)} – ${formatShortDate(to)}` };
}

export function monthRangeOf(ym: string): { from: string; to: string; label: string } {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from, to, label };
}

export function shiftMonthKey(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y || 2026, (m || 1) - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatMonthLabel(ym: string): string {
  if (!/^\d{4}-\d{2}$/.test(ym)) return ym;
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function yearRangeOf(year: string): { from: string; to: string; label: string } {
  const y = Number(year) || 2026;
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: `Year ${y}` };
}

export function formatShortDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function computeRange(
  mode: TimeframeMode,
  anchorDate: string,
  anchorMonth: string,
  anchorYear: string,
  customFrom: string,
  customTo: string,
): { from: string; to: string; label: string } {
  if (mode === 'daily') return { from: anchorDate, to: anchorDate, label: formatShortDate(anchorDate) };
  if (mode === 'weekly') return weekRangeOf(anchorDate);
  if (mode === 'monthly') return monthRangeOf(anchorMonth);
  if (mode === 'yearly') return yearRangeOf(anchorYear);
  const from = customFrom || anchorDate;
  const to = customTo && customTo >= from ? customTo : from;
  return { from, to, label: `${formatShortDate(from)} – ${formatShortDate(to)}` };
}

export interface PeriodSummary {
  from: string;
  to: string;
  label: string;
  openingBalancePaisa: number;
  periodIncomePaisa: number;
  totalAvailablePaisa: number;
  periodExpensePaisa: number;
  closingBalancePaisa: number;
  incomeByHead: { head: string; totalPaisa: number; count: number; editedCount: number }[];
  expenseByHead: { head: string; totalPaisa: number; count: number; editedCount: number }[];
  periodTransactions: LedgerTransaction[];
}

export function summarizePeriod(
  allTransactions: LedgerTransaction[],
  heads: LedgerHead[],
  from: string,
  to: string,
  label: string,
): PeriodSummary {
  const active = allTransactions.filter((t) => !t.deletedAt);
  let openingIncome = 0;
  let openingExpense = 0;
  const periodTxs: LedgerTransaction[] = [];

  for (const t of active) {
    if (t.txDate < from) {
      if (t.kind === 'income') openingIncome += t.amountPaisa;
      else openingExpense += t.amountPaisa;
    } else if (t.txDate >= from && t.txDate <= to) {
      periodTxs.push(t);
    }
  }

  const openingBalancePaisa = openingIncome - openingExpense;
  let periodIncomePaisa = 0;
  let periodExpensePaisa = 0;

  const incMap = new Map<string, { totalPaisa: number; count: number; editedCount: number }>();
  const expMap = new Map<string, { totalPaisa: number; count: number; editedCount: number }>();

  for (const h of heads) {
    if (!h.active) continue;
    const map = h.kind === 'income' ? incMap : expMap;
    if (!map.has(h.name)) map.set(h.name, { totalPaisa: 0, count: 0, editedCount: 0 });
  }

  for (const t of periodTxs) {
    const map = t.kind === 'income' ? incMap : expMap;
    if (t.kind === 'income') periodIncomePaisa += t.amountPaisa;
    else periodExpensePaisa += t.amountPaisa;
    const cur = map.get(t.head) || { totalPaisa: 0, count: 0, editedCount: 0 };
    cur.totalPaisa += t.amountPaisa;
    cur.count += 1;
    if (t.editCount > 0) cur.editedCount += 1;
    map.set(t.head, cur);
  }

  const orderIndex = new Map<string, number>();
  heads.forEach((h, i) => orderIndex.set(`${h.kind}:${h.name}`, h.sortOrder ?? i));

  const toRows = (kind: 'income' | 'expense', map: Map<string, { totalPaisa: number; count: number; editedCount: number }>) =>
    Array.from(map.entries())
      .map(([head, stats]) => ({ head, ...stats }))
      .sort((a, b) => (orderIndex.get(`${kind}:${a.head}`) ?? 999) - (orderIndex.get(`${kind}:${b.head}`) ?? 999) || a.head.localeCompare(b.head));

  const totalAvailablePaisa = openingBalancePaisa + periodIncomePaisa;
  const closingBalancePaisa = totalAvailablePaisa - periodExpensePaisa;

  return {
    from,
    to,
    label,
    openingBalancePaisa,
    periodIncomePaisa,
    totalAvailablePaisa,
    periodExpensePaisa,
    closingBalancePaisa,
    incomeByHead: toRows('income', incMap),
    expenseByHead: toRows('expense', expMap),
    periodTransactions: periodTxs.sort((a, b) => b.txDate.localeCompare(a.txDate) || b.createdAt.localeCompare(a.createdAt)),
  };
}

export function computeEmployeeSpendStats(
  employees: Employee[],
  transactions: LedgerTransaction[],
  loans: EmployeeLoan[],
  salaries: SalaryPayment[] = [],
  from?: string,
  to?: string,
): EmployeeSpendStat[] {
  const activeTx = transactions.filter((t) => {
    if (t.deletedAt || !t.employeeId) return false;
    if (t.categoryGroup === 'salary' || t.categoryGroup === 'salary_advance' || t.categoryGroup === 'loan_issue' || t.categoryGroup === 'loan_repayment') return false;
    if (from && t.txDate < from) return false;
    if (to && t.txDate > to) return false;
    return true;
  });

  const periodSalaries = salaries.filter((s) => {
    if (from && s.paidDate < from) return false;
    if (to && s.paidDate > to) return false;
    return true;
  });

  const periodLoans = loans.filter((l) => {
    if (from && l.issuedDate < from) return false;
    if (to && l.issuedDate > to) return false;
    return true;
  });

  const loanByEmp = new Map<string, number>();
  for (const l of loans) {
    if (l.status === 'active') {
      loanByEmp.set(l.employeeId, (loanByEmp.get(l.employeeId) || 0) + l.remainingPaisa);
    }
  }

  const rawStats = employees.map((emp) => {
    let salaryPaisa = 0;
    let operationalTakenPaisa = 0;
    let loanIssuedPaisa = 0;
    let txCount = 0;

    for (const s of periodSalaries) {
      if (s.employeeId === emp.id) salaryPaisa += s.netPaidPaisa;
    }

    for (const l of periodLoans) {
      if (l.employeeId === emp.id) loanIssuedPaisa += l.principalPaisa;
    }

    for (const t of activeTx) {
      if (t.employeeId !== emp.id) continue;
      txCount += 1;
      if (t.kind === 'expense') {
        operationalTakenPaisa += t.amountPaisa;
      }
    }

    const activeLoanPaisa = loanByEmp.get(emp.id) || 0;
    const totalTakenPaisa = operationalTakenPaisa;

    return {
      employee: emp,
      salaryPaisa,
      operationalTakenPaisa,
      loanIssuedPaisa,
      activeLoanPaisa,
      totalTakenPaisa,
      txCount,
    };
  });

  const activePool = rawStats.filter((s) => s.employee.active);
  const denom = activePool.length || rawStats.length;
  const sumOp = (activePool.length ? activePool : rawStats).reduce(
    (sum, s) => sum + s.operationalTakenPaisa,
    0,
  );
  const avgOperationalPaisa = denom > 0 ? Math.round(sumOp / denom) : 0;

  return rawStats
    .map((s) => {
      const opMetric = s.operationalTakenPaisa;
      let spendLevel: 'high' | 'normal' | 'low' = 'normal';
      if (avgOperationalPaisa > 0) {
        if (opMetric >= avgOperationalPaisa * 1.35) spendLevel = 'high';
        else if (opMetric <= avgOperationalPaisa * 0.5) spendLevel = 'low';
      }
      return { ...s, avgOperationalPaisa, spendLevel };
    })
    .sort((a, b) => b.operationalTakenPaisa - a.operationalTakenPaisa || b.txCount - a.txCount);
}
