import React, { useMemo, useState } from 'react';
import { X, Check, Wallet } from 'lucide-react';
import type { DepartmentRecord, Employee, EmployeeLoan, FundSource, LedgerHead, LedgerKind } from '../types';
import { PAYMENT_METHODS, dhakaMonth, dhakaToday } from '../utils/ledger';
import { formatBDT, toPaisa } from '../utils/money';
import { createTransaction, createSalaryAdvance, issueLoan, repayLoan } from '../utils/cloud';

export type FinancialEntryType = '' | 'income' | 'expense' | 'salary_advance' | 'employee_loan' | 'loan_repayment';

interface Props {
  isOpen: boolean;
  initialType?: FinancialEntryType;
  onClose: () => void;
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  employees: Employee[];
  loans: EmployeeLoan[];
  fundSources: FundSource[];
  onSaved: () => void;
  onToast: (message: string) => void;
}

const fieldClass = 'h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800 outline-none focus:border-brand-500 focus:bg-white';
const labelClass = 'mb-1.5 block text-xs font-semibold text-slate-600';

export const FinancialEntryModal: React.FC<Props> = ({
  isOpen,
  initialType = '',
  onClose,
  heads,
  departments,
  employees,
  loans,
  fundSources,
  onSaved,
  onToast,
}) => {
  const [type, setType] = useState<FinancialEntryType>(initialType);
  const [date, setDate] = useState(dhakaToday());
  const [monthKey, setMonthKey] = useState(dhakaMonth());
  const [amount, setAmount] = useState('');
  const [department, setDepartment] = useState('');
  const [fundSourceId, setFundSourceId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [loanId, setLoanId] = useState('');
  const [head, setHead] = useState('');
  const [category, setCategory] = useState('');
  const [method, setMethod] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [purpose, setPurpose] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [installment, setInstallment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const activeSources = useMemo(() => fundSources.filter((source) => source.active), [fundSources]);
  const activeDepartments = useMemo(() => departments.filter((d) => d.active), [departments]);
  const activeEmployees = useMemo(() => employees.filter((employee) => employee.active), [employees]);
  const headOptions = useMemo(() => {
    const kind: LedgerKind = type === 'income' || type === 'loan_repayment' ? 'income' : 'expense';
    return heads.filter((item) => item.kind === kind && item.active);
  }, [heads, type]);

  React.useEffect(() => {
    if (!isOpen) return;
    setType(initialType);
    setDate(dhakaToday());
    setMonthKey(dhakaMonth());
    setAmount('');
    setDepartment('');
    setFundSourceId('');
    setEmployeeId('');
    setLoanId('');
    setHead('');
    setCategory('');
    setMethod('');
    setCounterparty('');
    setPurpose('');
    setReferenceNo('');
    setInstallment('');
    setError('');
  }, [isOpen, initialType]);

  if (!isOpen) return null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const amountPaisa = toPaisa(amount);
    if (!type) return setError('Select a transaction type.');
    if (!amountPaisa || amountPaisa <= 0) return setError('Enter a valid amount greater than ৳0.00.');
    if (!department.trim()) return setError('Select a department.');
    if (!fundSourceId) return setError('Select the funding source.');
    if (!method) return setError('Select a payment method.');
    setBusy(true);
    try {
      if (type === 'income' || type === 'expense') {
        if (!head || !category || !counterparty.trim() || purpose.trim().length < 2) throw new Error('Complete the category, party, and description fields.');
        await createTransaction({
          kind: type,
          txDate: date,
          amount,
          department: department.trim(),
          head,
          subCategory: category,
          paymentMethod: method,
          referenceNo,
          counterparty: counterparty.trim(),
          purpose: purpose.trim(),
          employeeId: employeeId || undefined,
          employeeName: employees.find((employee) => employee.id === employeeId)?.name,
          categoryGroup: 'general',
          fundSourceId,
        });
      } else if (type === 'salary_advance') {
        if (!employeeId || purpose.trim().length < 3) throw new Error('Select an employee and enter the reason for the advance.');
        await createSalaryAdvance({
          employeeId,
          monthKey: monthKey || date.slice(0, 7),
          issuedDate: date,
          amount,
          department: department.trim(),
          fundSourceId,
          paymentMethod: method,
          purpose: purpose.trim(),
        });
      } else if (type === 'employee_loan') {
        if (!employeeId || !head || purpose.trim().length < 3) throw new Error('Select an employee, expense head, and loan purpose.');
        await issueLoan({
          employeeId,
          issuedDate: date,
          amount,
          monthlyInstallment: installment,
          paymentMethod: method,
          referenceNo,
          department: department.trim(),
          head,
          fundSourceId,
          purpose: purpose.trim(),
        });
      } else if (type === 'loan_repayment') {
        if (!loanId || !head) throw new Error('Select a loan and an income category.');
        await repayLoan(loanId, {
          paidDate: date,
          amount,
          paymentMethod: method,
          referenceNo,
          department: department.trim(),
          head,
          fundSourceId,
          note: purpose.trim(),
        });
      }
      onSaved();
      onClose();
      onToast('Transaction recorded in the Daily Ledger.');
    } catch (saveError: any) {
      setError(saveError?.message || 'Could not save this transaction.');
    } finally {
      setBusy(false);
    }
  };

  const isIncome = type === 'income' || type === 'loan_repayment';
  const needsEmployee = type === 'salary_advance' || type === 'employee_loan';
  const needsHead = type === 'income' || type === 'expense' || type === 'employee_loan' || type === 'loan_repayment';

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form onSubmit={save} className="flex max-h-[94vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-700"><Wallet className="h-5 w-5" /></span>
          <div className="min-w-0"><h2 className="text-base font-bold text-[#1b2a4e]">New Financial Transaction</h2><p className="mt-0.5 text-xs text-slate-500">Record incoming or outgoing funds and link the department, employee, or loan.</p></div>
          <button type="button" onClick={onClose} disabled={busy} className="ml-auto grid h-9 w-9 place-items-center rounded-full text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs font-medium text-rose-700">{error}</div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label><span className={labelClass}>Transaction type *</span><select required value={type} onChange={(event) => { setType(event.target.value as FinancialEntryType); setAmount(''); setDepartment(''); setFundSourceId(''); setEmployeeId(''); setLoanId(''); setHead(''); setCategory(''); setMethod(''); setCounterparty(''); setPurpose(''); setReferenceNo(''); setInstallment(''); }} className={fieldClass}><option value="">Select type</option><option value="income">Income</option><option value="expense">Expense</option><option value="salary_advance">Salary advance</option><option value="employee_loan">Employee loan</option><option value="loan_repayment">Loan repayment</option></select></label>
            <label><span className={labelClass}>Date *</span><input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className={fieldClass} /></label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label><span className={labelClass}>Amount (BDT) *</span><input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Enter amount" className={`${fieldClass} font-mono font-bold`} /></label>
            <label><span className={labelClass}>Department *</span><select required value={department} onChange={(event) => setDepartment(event.target.value)} className={fieldClass}><option value="">Select department</option>{activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}</select></label>
            <label><span className={labelClass}>Funding source *</span><select required value={fundSourceId} onChange={(event) => setFundSourceId(event.target.value)} className={fieldClass}><option value="">Select fund source</option>{activeSources.map((source) => <option key={source.id} value={source.id}>{source.name} · Available {formatBDT(source.balancePaisa)}</option>)}</select></label>
          </div>
          {needsEmployee && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block"><span className={labelClass}>Employee *</span><select required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className={fieldClass}><option value="">Select employee</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.code})</option>)}</select></label>
              {type === 'salary_advance' && (
                <label className="block"><span className={labelClass}>Payroll Month *</span><input required type="month" value={monthKey} onChange={(event) => setMonthKey(event.target.value)} className={fieldClass} /></label>
              )}
            </div>
          )}
          {type === 'loan_repayment' && <label className="block"><span className={labelClass}>Employee loan *</span><select required value={loanId} onChange={(event) => setLoanId(event.target.value)} className={fieldClass}><option value="">Select outstanding loan</option>{loans.filter((loan) => loan.status === 'active' && loan.remainingPaisa > 0).map((loan) => <option key={loan.id} value={loan.id}>{loan.loanNo} · {loan.employeeName} · Due {formatBDT(loan.remainingPaisa)}</option>)}</select></label>}
          {needsHead && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label><span className={labelClass}>{isIncome ? 'Income category *' : 'Expense head *'}</span><select required value={head} onChange={(event) => setHead(event.target.value)} className={fieldClass}><option value="">Select category</option>{headOptions.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>{(type === 'income' || type === 'expense') && <label><span className={labelClass}>Transaction category *</span><input required value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Enter transaction category" className={fieldClass} /></label>}</div>}
          {type === 'employee_loan' && <label className="block"><span className={labelClass}>Monthly salary installment note (optional)</span><input inputMode="decimal" value={installment} onChange={(event) => setInstallment(event.target.value)} placeholder="Reference installment amount" className={fieldClass} /></label>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label><span className={labelClass}>Payment method *</span><select required value={method} onChange={(event) => setMethod(event.target.value)} className={fieldClass}><option value="">Select payment method</option>{PAYMENT_METHODS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label><span className={labelClass}>Reference number</span><input value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} placeholder="Optional reference" className={fieldClass} /></label>
          </div>
          {(type === 'income' || type === 'expense') && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label><span className={labelClass}>Employee (optional)</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className={fieldClass}><option value="">No employee linked</option>{activeEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.code})</option>)}</select></label><label><span className={labelClass}>{isIncome ? 'Received from *' : 'Paid to / vendor *'}</span><input required value={counterparty} onChange={(event) => setCounterparty(event.target.value)} placeholder="Enter person or organization" className={fieldClass} /></label></div>}
          <label className="block"><span className={labelClass}>{type === 'salary_advance' ? 'Reason for advance *' : type === 'employee_loan' ? 'Loan purpose *' : type === 'loan_repayment' ? 'Repayment description' : 'Description *'}</span><textarea required={type !== 'loan_repayment'} value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={3} placeholder="Describe this transaction" className={`${fieldClass} h-auto min-h-20 py-2.5`} /></label>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/70 px-5 py-4">
          <div className="min-w-0 text-[11px] text-slate-500">The selected fund will be updated when this record is saved.</div>
          <div className="flex shrink-0 gap-2"><button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600">Cancel</button><button type="submit" disabled={busy || !activeSources.length} className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 text-xs font-semibold text-white disabled:opacity-50"><Check className="h-4 w-4" /> {busy ? 'Saving...' : 'Save transaction'}</button></div>
        </div>
      </form>
    </div>
  );
};
