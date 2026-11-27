// Shape of an Excel import "plan": what the preview screen shows, the admin edits,
// and the server re-validates and commits. Amounts are plain taka strings ("1200.00")
// so they can be edited in place; the server converts them with the same validators
// the normal entry forms use.

export type IssueLevel = 'error' | 'warn' | 'info';

export interface RowIssue {
  level: IssueLevel;
  message: string;
}

interface RowBase {
  id: string;
  /** Unticked rows are skipped entirely. */
  include: boolean;
  /** Where the row came from, e.g. "Expense!G12". */
  source: string;
  /** Why the importer left this row unticked, if it did. */
  skipReason?: string;
  issues?: RowIssue[];
}

export interface PlanEntry extends RowBase {
  kind: 'income' | 'expense';
  txDate: string;
  amount: string;
  department: string;
  head: string;
  subCategory: string;
  paymentMethod: string;
  counterparty: string;
  purpose: string;
  referenceNo: string;
  notes: string;
  /** Fund source NAME (resolved to an id on commit). */
  fundSource: string;
  /** Fields the importer had to infer because the sheet does not have them. */
  guessed?: string[];
  /** Set when this cash-book row is already represented by a payroll/loan row. */
  coveredBy?: string;
  /** Looks like payroll/loan money for this employee but matches nothing on the Salary/Loan sheets. */
  payrollHint?: { employeeRef: string; type: 'salary' | 'advance' | 'loan' };
}

export interface PlanEmployee extends RowBase {
  /** Name exactly as written in the Excel sheet, e.g. ALHAMRA-MITHU. */
  key: string;
  name: string;
  role: string;
  branch: string;
  department: string;
  monthlySalary: string;
  /** Existing employee id to link to instead of creating a new one. */
  linkExistingId: string;
}

export interface PlanSalaryPayment extends RowBase {
  /** Plan employee key, or "db:<employeeId>" for an existing employee. */
  employeeRef: string;
  type: 'salary' | 'advance';
  txDate: string;
  monthKey: string;
  amount: string;
  paymentMethod: string;
  department: string;
  fundSource: string;
  note: string;
}

export interface PlanLoan extends RowBase {
  employeeRef: string;
  txDate: string;
  amount: string;
  paymentMethod: string;
  department: string;
  fundSource: string;
  purpose: string;
  referenceNo: string;
}

export interface PlanLoanRepayment extends RowBase {
  employeeRef: string;
  /** id of the PlanLoan this repayment reduces. */
  loanRef: string;
  txDate: string;
  amount: string;
  paymentMethod: string;
  department: string;
  fundSource: string;
  /** review = must choose; cash = create an income transaction; already-recorded = only update the loan balance. */
  treatment: 'review' | 'cash' | 'already-recorded';
  note: string;
}

export interface PlanRentItem extends RowBase {
  name: string;
  category: 'regular' | 'urgent';
  monthlyAmount: string;
  urgentAmount: string;
  department: string;
  notes: string;
  /** Existing recurring rent item to update instead of creating a duplicate. */
  linkExistingId: string;
}

export interface SheetTotals {
  income: number;
  expense: number;
  balance: number;
  salaryPaid: number;
  salaryPending: number;
  loanIssued: number;
  loanPaid: number;
  rentRegular: number;
  rentUrgent: number;
}

export interface ImportPlan {
  version: 1;
  fileName: string;
  fileHash: string;
  /** YYYY-MM the workbook covers. */
  sheetMonth: string;
  /** Previous Month value from the workbook, in taka; null when the row is absent. */
  sheetOpeningBalance: number | null;
  defaultFundSource: string;
  entries: PlanEntry[];
  employees: PlanEmployee[];
  salaryPayments: PlanSalaryPayment[];
  loans: PlanLoan[];
  loanRepayments: PlanLoanRepayment[];
  rentItems: PlanRentItem[];
  /** Totals printed in the workbook itself (taka), for the reconciliation. */
  sheetTotals: SheetTotals;
  /** Plain-language notes about how the workbook was read. */
  notes: string[];
}

export interface ReconcileLine {
  label: string;
  /** Taka. */
  sheet?: number;
  imported?: number;
  ok?: boolean;
  detail?: string;
}

export interface FundProjection {
  fundSource: string;
  existingBalance: number;
  incoming: number;
  outgoing: number;
  closing: number;
}

export interface ImportValidation {
  plan: ImportPlan;
  errorCount: number;
  warnCount: number;
  /** Plan-level problems that are not tied to one row. */
  planIssues: RowIssue[];
  reconcile: ReconcileLine[];
  funds: FundProjection[];
  counts: {
    entries: number;
    employees: number;
    salaryPayments: number;
    loans: number;
    loanRepayments: number;
    rentItems: number;
    skipped: number;
  };
  newHeads: string[];
  newDepartments: string[];
  /** Active fund source names the admin can choose from. */
  fundSources: string[];
  /** Employees that already exist, so imported people can be linked instead of duplicated. */
  existingEmployees: { id: string; name: string; code: string }[];
}
