import React, { memo, useMemo, useState } from 'react';
import { Camera, Check, Paperclip } from 'lucide-react';
import type { DepartmentRecord, Employee, FundSource, LedgerHead, LedgerKind, LedgerTransaction } from '../types';
import { EXPENSE_PURPOSES, INCOME_PURPOSES, PAYMENT_METHODS, dhakaToday } from '../utils/ledger';
import { toPaisa } from '../utils/money';
import { createTransaction } from '../utils/cloud';
import { CameraCaptureModal } from './CameraCaptureModal';
import { ComboInput } from './ComboInput';
import { FilterSelect, type FilterOption } from './FilterSelect';
import { DateRangeButton } from './DateRangeButton';

interface Props {
  transactions: LedgerTransaction[];
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  employees: Employee[];
  fundSources: FundSource[];
  onQuickSaved: (tx: LedgerTransaction) => void;
  onToast: (msg: string) => void;
}

const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';
const qInputCls =
  'h-9 px-2.5 text-xs text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500 w-full';

/**
 * The inline entry form lives in its own memoized component so that typing in it never re-renders the
 * (potentially thousands of rows) ledger table below it, and vice-versa.
 */
export const QuickEntryForm = memo(function QuickEntryForm({
  transactions, heads, departments, employees, fundSources, onQuickSaved, onToast,
}: Props) {
  const activeIncomeHeads = useMemo(() => heads.filter((h) => h.kind === 'income' && h.active), [heads]);
  const activeExpenseHeads = useMemo(() => heads.filter((h) => h.kind === 'expense' && h.active), [heads]);
  const activeDepartments = useMemo(() => departments.filter((d) => d.active), [departments]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);
  const activeFunds = useMemo(() => fundSources.filter((s) => s.active), [fundSources]);

  const [qDate, setQDate] = useState(dhakaToday);
  const [qKind, setQKind] = useState<LedgerKind | ''>('');
  const [qDepartment, setQDepartment] = useState('');
  const [qHead, setQHead] = useState('');
  const [qSubCategory, setQSubCategory] = useState('');
  const [qFundSourceId, setQFundSourceId] = useState('');
  const [qEmpId, setQEmpId] = useState('');
  const [qAmount, setQAmount] = useState('');
  const [qMethod, setQMethod] = useState('');
  const [qRef, setQRef] = useState('');
  const [qCounterparty, setQCounterparty] = useState('');
  const [qPurpose, setQPurpose] = useState('');
  const [qReceipt, setQReceipt] = useState<{ name: string; data: string } | undefined>(undefined);
  const [qCameraOpen, setQCameraOpen] = useState(false);
  const [qBusy, setQBusy] = useState(false);

  const switchQuickKind = (next: LedgerKind | '') => {
    setQKind(next);
    setQHead('');
    setQSubCategory('');
  };

  const handleQuickEmp = (nextId: string) => setQEmpId(nextId);

  const handleQuickSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const paisa = toPaisa(qAmount);
    if (!qKind || !qDepartment.trim() || !qFundSourceId || !qHead.trim() || !qSubCategory.trim() || !qMethod.trim() || !qCounterparty.trim() || qPurpose.trim().length < 2) {
      onToast('Complete all required fields, including type, department, and funding source.');
      return;
    }
    if (!paisa || paisa <= 0) {
      onToast('Enter a valid amount.');
      return;
    }
    const emp = activeEmployees.find((x) => x.id === qEmpId);
    setQBusy(true);
    try {
      const saved = await createTransaction({
        kind: qKind,
        txDate: qDate,
        amount: qAmount,
        department: qDepartment.trim(),
        head: qHead.trim(),
        subCategory: qSubCategory.trim(),
        paymentMethod: qMethod.trim(),
        referenceNo: qRef.trim(),
        counterparty: qCounterparty.trim(),
        counterpartyPhone: emp?.phone || '',
        purpose: qPurpose.trim(),
        employeeId: emp?.id,
        employeeName: emp?.name,
        categoryGroup: 'general',
        fundSourceId: qFundSourceId,
        receipt: qReceipt,
      });
      setQKind('');
      setQDepartment('');
      setQHead('');
      setQSubCategory('');
      setQFundSourceId('');
      setQEmpId('');
      setQAmount('');
      setQMethod('');
      setQRef('');
      setQCounterparty('');
      setQPurpose('');
      setQReceipt(undefined);
      onQuickSaved(saved);
    } catch (err: any) {
      onToast(err?.message || 'Could not save entry.');
    } finally {
      setQBusy(false);
    }
  };

  const handleQuickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setQReceipt({ name: file.name, data: reader.result });
    };
    reader.readAsDataURL(file);
  };

  const uniqueMethodNames = useMemo(() => {
    const set = new Set<string>(PAYMENT_METHODS);
    transactions.forEach((t) => t.paymentMethod && set.add(t.paymentMethod));
    return Array.from(set);
  }, [transactions]);

  const uniqueSubCategoryNames = useMemo(() => {
    const defaults = qKind === 'income' ? INCOME_PURPOSES : qKind === 'expense' ? EXPENSE_PURPOSES : [];
    const set = new Set<string>(defaults);
    transactions.forEach((t) => {
      if (qKind && t.kind === qKind && t.subCategory) set.add(t.subCategory);
    });
    return Array.from(set);
  }, [transactions, qKind]);

  const kindOptions: FilterOption[] = [
    { value: '', label: 'Select transaction type *' },
    { value: 'expense', label: 'Expense (Out)' },
    { value: 'income', label: 'Income (In)' },
  ];
  const departmentOptions = useMemo<FilterOption[]>(
    () => [{ value: '', label: 'Select department *' }, ...activeDepartments.map((d) => ({ value: d.name, label: d.name }))],
    [activeDepartments],
  );
  const fundOptions = useMemo<FilterOption[]>(
    () => [{ value: '', label: 'Select fund source *' }, ...activeFunds.map((f) => ({ value: f.id, label: f.name }))],
    [activeFunds],
  );
  const employeeOptions = useMemo<FilterOption[]>(
    () => [{ value: '', label: 'Staff (Optional)' }, ...activeEmployees.map((emp) => ({ value: emp.id, label: emp.name }))],
    [activeEmployees],
  );

  const qHeadOptions = useMemo(() => {
    const list = (qKind === 'income' ? activeIncomeHeads : qKind === 'expense' ? activeExpenseHeads : []).map((h) => h.name);
    const set = new Set<string>(list);
    transactions.forEach((t) => {
      if (qKind && t.kind === qKind && t.head) set.add(t.head);
    });
    return Array.from(set);
  }, [qKind, activeIncomeHeads, activeExpenseHeads, transactions]);

  return (
    <>
      <form onSubmit={handleQuickSave} className={`${SURFACE} p-4 space-y-2.5`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-bold text-[#1b2a4e]">New Ledger Entry</span>
          <span className="text-[11px] text-slate-400">
            {qReceipt ? `Voucher attached: ${qReceipt.name}` : 'Department, channel/office, method, and funding source are required'}
          </span>
        </div>

        <div className="grid grid-cols-1 @md:grid-cols-2 @3xl:grid-cols-5 gap-2">
          <DateRangeButton single from={qDate} to={qDate} onChange={(d) => d && setQDate(d)} className={qInputCls} />
          <FilterSelect
            ariaLabel="Type"
            value={qKind}
            onChange={(v) => switchQuickKind(v as LedgerKind | '')}
            options={kindOptions}
            className={qInputCls} placeholderStyle defaultValue=""
          />
          <FilterSelect
            ariaLabel="Department"
            value={qDepartment}
            onChange={setQDepartment}
            options={departmentOptions}
            className={qInputCls} placeholderStyle defaultValue=""
          />
          <ComboInput
            value={qHead}
            onChange={setQHead}
            options={qHeadOptions}
            required
            ariaLabel="Channel or Office"
            placeholder={qKind === 'income' ? 'Channel / Source *' : 'Office / Field *'}
            className={qInputCls}
          />
          <ComboInput
            value={qSubCategory}
            onChange={setQSubCategory}
            options={uniqueSubCategoryNames}
            required
            ariaLabel="Field Category"
            placeholder="Category / Field *"
            className={qInputCls}
          />

          <input
            type="text"
            inputMode="decimal"
            required
            value={qAmount}
            onChange={(e) => setQAmount(e.target.value)}
            placeholder="Amount ৳ *"
            className={`${qInputCls} font-mono font-bold tabular-nums`}
          />
          <ComboInput
            value={qMethod}
            onChange={setQMethod}
            options={uniqueMethodNames}
            required
            ariaLabel="Payment Method"
            placeholder="Method (Cash, bKash, ATM...)"
            className={qInputCls}
          />
          <FilterSelect
            ariaLabel="Funding source"
            value={qFundSourceId}
            onChange={setQFundSourceId}
            options={fundOptions}
            className={qInputCls} placeholderStyle defaultValue=""
          />
          <FilterSelect
            ariaLabel="Employee"
            value={qEmpId}
            onChange={handleQuickEmp}
            options={employeeOptions}
            searchable
            className={qInputCls} placeholderStyle defaultValue=""
          />
          <input
            type="text"
            value={qCounterparty}
            onChange={(e) => setQCounterparty(e.target.value)}
            placeholder={qKind === 'income' ? 'Received From *' : 'Paid To / Vendor *'}
            className={qInputCls}
          />
        </div>

        <div className="grid grid-cols-1 @3xl:grid-cols-[1fr_12rem_auto] gap-2 items-center pt-0.5">
          <input
            type="text"
            value={qPurpose}
            onChange={(e) => setQPurpose(e.target.value)}
            placeholder="Why / Details *"
            className={qInputCls}
          />
          <input
            type="text"
            value={qRef}
            onChange={(e) => setQRef(e.target.value)}
            placeholder="Ref / Slip # (Optional)"
            className={`${qInputCls} font-mono`}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setQCameraOpen(true)}
              className="h-9 px-3 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-xs font-semibold text-brand-900 inline-flex items-center gap-1.5"
            >
              <Camera className="w-3.5 h-3.5" /> Photo
            </button>
            <label className="h-9 px-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5 cursor-pointer">
              <Paperclip className="w-3.5 h-3.5 text-brand-600" />
              <span>{qReceipt ? 'Replace' : 'Attach'}</span>
              <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleQuickFile} className="hidden" />
            </label>
            <button
              type="submit"
              disabled={qBusy}
              className="h-9 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              <Check className="w-3.5 h-3.5" /> {qBusy ? 'Saving...' : 'Save Entry'}
            </button>
          </div>
        </div>
      </form>

      <CameraCaptureModal
        isOpen={qCameraOpen}
        onClose={() => setQCameraOpen(false)}
        onCapture={(file) => setQReceipt(file)}
      />
    </>
  );
});
