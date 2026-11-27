import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Camera,
  CheckCircle2,
  Paperclip,
  RotateCcw,
  X,
} from 'lucide-react';
import type { DepartmentRecord, Employee, FundSource, LedgerHead, LedgerKind, LedgerTransaction } from '../types';
import { EXPENSE_PURPOSES, INCOME_PURPOSES, PAYMENT_METHODS, addDays, dhakaToday } from '../utils/ledger';
import { formatBDT, fromPaisa, toPaisa } from '../utils/money';
import { createTransaction, editTransaction } from '../utils/cloud';
import { CameraCaptureModal } from './CameraCaptureModal';
import { ComboInput } from './ComboInput';
import { ScrollLock } from './ScrollLock';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  initialKind?: LedgerKind;
  initialHead?: string;
  editingTx?: LedgerTransaction | null;
  duplicatingTx?: LedgerTransaction | null;
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  employees: Employee[];
  fundSources: FundSource[];
  recentTransactions?: LedgerTransaction[];
  isAdmin: boolean;
  onSaved: (tx: LedgerTransaction, isEdit: boolean) => void;
}

const EDIT_REASON_CHIPS = [
  'Typo / amount correction',
  'Updated receipt / ref #',
  'Corrected channel / office',
  'Assigned department',
];

const QUICK_EXPENSE_PURPOSES = [
  { label: 'Salary & Allowance', sub: 'Salary & Staff Allowance', text: 'Staff salary and allowance' },
  { label: 'Office Rent', sub: 'Office Rent & Service Charge', text: 'Office rent & service charge' },
  { label: 'Electricity / Utility', sub: 'Electricity, Water & Gas', text: 'Electricity & utility bill' },
  { label: 'Fiber / Hardware', sub: 'Fiber, ONU & Router Hardware', text: 'Fiber, ONU & router hardware purchase' },
  { label: 'Field Work', sub: 'Field Work & Installations', text: 'Field installation & maintenance expense' },
  { label: 'Transport', sub: 'Transport & Conveyance', text: 'Field transport & conveyance' },
];

const QUICK_INCOME_PURPOSES = [
  { label: 'Operational Float', sub: 'Operating Budget Top-up', text: 'Operating budget fund transfer' },
  { label: 'Salary Allocation', sub: 'Company Fund Transfer', text: 'Staff salary & office expense allocation' },
  { label: 'Field Project', sub: 'Field Project Advance', text: 'Field installation & hardware advance' },
  { label: 'Client / Partner', sub: 'Client / Partner Collection', text: 'Payment collection received' },
];

export const TransactionModal: React.FC<Props> = ({
  isOpen,
  onClose,
  initialKind = 'expense',
  initialHead = '',
  editingTx,
  duplicatingTx,
  heads,
  departments,
  employees,
  fundSources,
  recentTransactions = [],
  isAdmin,
  onSaved,
}) => {
  const isEdit = Boolean(editingTx);
  const [kind, setKind] = useState<LedgerKind>(initialKind);
  const [txDate, setTxDate] = useState(dhakaToday());
  const [amount, setAmount] = useState('');
  const [department, setDepartment] = useState('');
  const [head, setHead] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [subCategory, setSubCategory] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>('');
  const [fundSourceId, setFundSourceId] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [counterpartyPhone, setCounterpartyPhone] = useState('');
  const [purpose, setPurpose] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [receipt, setReceipt] = useState<{ name: string; data: string } | undefined>(undefined);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flashSaved, setFlashSaved] = useState('');

  const activeHeads = useMemo(
    () => heads.filter((h) => h.kind === kind && h.active),
    [heads, kind],
  );
  const departmentOptions = useMemo(() => {
    const set = new Set<string>(departments.filter((d) => d.active).map((d) => d.name));
    if (editingTx?.department) set.add(editingTx.department);
    if (duplicatingTx?.department) set.add(duplicatingTx.department);
    return Array.from(set);
  }, [departments, editingTx, duplicatingTx]);

  const headOptions = useMemo(() => {
    const set = new Set<string>(activeHeads.map((h) => h.name));
    recentTransactions.forEach((t) => {
      if (t.kind === kind && t.head) set.add(t.head);
    });
    return Array.from(set);
  }, [activeHeads, recentTransactions, kind]);
  const methodOptions = useMemo(() => {
    const set = new Set<string>(PAYMENT_METHODS);
    recentTransactions.forEach((t) => t.paymentMethod && set.add(t.paymentMethod));
    return Array.from(set);
  }, [recentTransactions]);
  const subCategoryOptions = useMemo(() => {
    const defaults = kind === 'income' ? INCOME_PURPOSES : EXPENSE_PURPOSES;
    const set = new Set<string>(defaults);
    recentTransactions.forEach((t) => {
      if (t.kind === kind && t.subCategory) set.add(t.subCategory);
    });
    return Array.from(set);
  }, [recentTransactions, kind]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);

  const counterpartyHints = useMemo(() => {
    const seen = new Set<string>();
    for (const t of recentTransactions) {
      if (t.kind === kind && t.counterparty) seen.add(t.counterparty);
      if (seen.size >= 16) break;
    }
    return Array.from(seen);
  }, [recentTransactions, kind]);

  const recentTemplates = useMemo(() => {
    const out: LedgerTransaction[] = [];
    const seen = new Set<string>();
    for (const t of recentTransactions) {
      if (t.deletedAt || t.kind !== kind) continue;
      if (head && t.head !== head) continue;
      const key = `${t.head}|${t.counterparty}|${t.purpose}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 3) break;
    }
    return out;
  }, [recentTransactions, kind, head]);

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setFlashSaved('');
    setReceipt(undefined);
    setReason('');

    const source = editingTx || duplicatingTx;
    if (source) {
      setKind(source.kind);
      setTxDate(editingTx ? source.txDate : dhakaToday());
      setAmount(fromPaisa(source.amountPaisa));
      setDepartment(source.department || '');
      setHead(source.head);
      setEmployeeId(source.employeeId || '');
      setSubCategory(source.subCategory);
      setPaymentMethod(source.paymentMethod);
      setFundSourceId(editingTx ? source.fundSourceId : '');
      setReferenceNo(editingTx ? source.referenceNo : '');
      setCounterparty(source.counterparty);
      setCounterpartyPhone(source.counterpartyPhone || '');
      setPurpose(source.purpose);
      setNotes(source.notes || '');
    } else {
      setKind(initialKind);
      setTxDate(dhakaToday());
      setAmount('');
      setDepartment('');
      setHead(initialHead || '');
      setEmployeeId('');
      setSubCategory('');
      setPaymentMethod('');
      setFundSourceId('');
      setReferenceNo('');
      setCounterparty('');
      setCounterpartyPhone('');
      setPurpose('');
      setNotes('');
    }
  }, [isOpen, editingTx, duplicatingTx, initialKind, initialHead, heads]);

  const handleKindSwitch = (nextKind: LedgerKind) => {
    if (isEdit) return;
    setKind(nextKind);
    setDepartment('');
    setHead('');
    setSubCategory('');
    setPaymentMethod('');
    setFundSourceId('');
    if (!employeeId) setCounterparty('');
  };

  const handleHeadChange = (nextHead: string) => setHead(nextHead);

  const handleEmployeeChange = (nextEmpId: string) => {
    setEmployeeId(nextEmpId);
    const emp = employees.find((e) => e.id === nextEmpId);
    if (emp) {
      setCounterparty(emp.name);
      if (emp.phone) setCounterpartyPhone(emp.phone);
    }
  };

  const applyTemplate = (tpl: LedgerTransaction) => {
    setSubCategory(tpl.subCategory);
    setPaymentMethod(tpl.paymentMethod);
    setEmployeeId(tpl.employeeId || '');
    setCounterparty(tpl.counterparty);
    setCounterpartyPhone(tpl.counterpartyPhone || '');
    setPurpose(tpl.purpose);
    if (!amount) setAmount(fromPaisa(tpl.amountPaisa));
  };

  if (!isOpen) return null;

  const handleReceipt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError('Receipt file must be under 10 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setReceipt({ name: file.name, data: reader.result });
      }
    };
    reader.readAsDataURL(file);
  };

  const saveEntry = async (addAnother: boolean) => {
    const paisa = toPaisa(amount);
    if (!paisa || paisa <= 0) {
      setError('Enter a valid amount greater than ৳0.00.');
      return;
    }
    if (!department.trim()) {
      setError('Select the Department / Office.');
      return;
    }
    if (!fundSourceId) {
      setError('Select the funding source.');
      return;
    }
    if (!head.trim() || !subCategory.trim() || !paymentMethod.trim() || !counterparty.trim() || purpose.trim().length < 2) {
      setError('Complete all required transaction fields.');
      return;
    }
    const selectedEmp = employees.find((e) => e.id === employeeId);
    const resolvedCounterparty = counterparty.trim();
    const resolvedPurpose = purpose.trim();

    if (isEdit && reason.trim().length < 3) {
      setError('Select or type a short edit reason (at least 3 characters).');
      return;
    }

    setBusy(true);
    setError('');
    setFlashSaved('');
    try {
      const payload = {
        kind,
        txDate,
        amount,
        department: department.trim(),
        head: head.trim(),
        subCategory: subCategory.trim(),
        paymentMethod: paymentMethod.trim(),
        referenceNo: referenceNo.trim(),
        counterparty: resolvedCounterparty,
        counterpartyPhone: counterpartyPhone.trim(),
        purpose: resolvedPurpose,
        notes: notes.trim(),
        employeeId: employeeId || undefined,
        employeeName: selectedEmp?.name,
        categoryGroup: editingTx?.categoryGroup || 'general',
        fundSourceId,
        reason: isEdit ? reason.trim() : undefined,
        receipt,
      };
      const saved = isEdit && editingTx
        ? await editTransaction(editingTx.id, payload)
        : await createTransaction(payload);
      onSaved(saved, isEdit);
      if (addAnother && !isEdit) {
        setAmount('');
        setDepartment('');
        setReferenceNo('');
        setReceipt(undefined);
        setFlashSaved(`Saved ${saved.voucherNo} (${formatBDT(saved.amountPaisa)}). Ready for next entry.`);
      } else {
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || 'Could not save transaction.');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveEntry(false);
  };

  const fieldCls =
    'w-full h-10 px-3 text-sm text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl hover:bg-white focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-colors';
  const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';
  const quickPurposes = kind === 'income' ? QUICK_INCOME_PURPOSES : QUICK_EXPENSE_PURPOSES;
  const amountChangedNow = isEdit && editingTx && toPaisa(amount) !== editingTx.amountPaisa;
  const today = dhakaToday();

  return (
    <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit entry' : 'Quick ledger entry'}
        className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col"
      >
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <span
            className={`grid place-items-center w-10 h-10 rounded-2xl text-white shadow-lg ${
              kind === 'income'
                ? 'bg-gradient-to-br from-emerald-400 to-brand-700 shadow-brand-600/30'
                : 'bg-gradient-to-br from-amber-400 to-rose-600 shadow-rose-500/30'
            }`}
          >
            {kind === 'income' ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#1b2a4e]">
              {isEdit
                ? `Edit Voucher · ${editingTx?.voucherNo}`
                : duplicatingTx
                  ? `Repeat Entry (${duplicatingTx.head})`
                  : kind === 'income'
                    ? 'Record Income (Money In)'
                    : 'Record Expense (Money Out)'}
            </h2>
            <p className="text-xs text-slate-500">
              {isEdit
                ? 'Changes are automatically logged to the edit history.'
                : 'Enter amount, department, channel/office, linked staff, and attach a voucher photo.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
          {!isEdit && (
            <div className="grid grid-cols-2 gap-2 p-1 rounded-2xl bg-slate-100">
              <button
                type="button"
                onClick={() => handleKindSwitch('income')}
                className={`h-9 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                  kind === 'income' ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ArrowDownLeft className="w-4 h-4 text-emerald-600" />
                Income (In)
              </button>
              <button
                type="button"
                onClick={() => handleKindSwitch('expense')}
                className={`h-9 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                  kind === 'expense' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <ArrowUpRight className="w-4 h-4 text-rose-600" />
                Expense (Out)
              </button>
            </div>
          )}

          {flashSaved && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2 text-xs text-emerald-800 font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              {flashSaved}
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-700 font-medium">
              {error}
            </div>
          )}

          {isEdit && editingTx?.departmentReview && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-900 font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              This imported entry is pending department assignment. Select the verified department below.
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Amount (BDT ৳) *</label>
              <input
                type="text"
                inputMode="decimal"
                autoFocus
                required
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${fieldCls} font-mono font-extrabold text-base tabular-nums`}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-600">Date *</label>
                <span className="flex items-center gap-2 text-[11px] font-semibold">
                  <button type="button" onClick={() => setTxDate(today)} className="text-brand-700 hover:underline">Today</button>
                  <button type="button" onClick={() => setTxDate(addDays(today, -1))} className="text-slate-400 hover:text-slate-700">Yest.</button>
                </span>
              </div>
              <input
                type="date"
                required
                value={txDate}
                onChange={(e) => setTxDate(e.target.value)}
                className={`${fieldCls} tabular-nums`}
              />
            </div>

            <div>
              <label className={labelCls}>{kind === 'income' ? 'Income Channel *' : 'Office / Head *'}</label>
              <ComboInput
                value={head}
                onChange={handleHeadChange}
                options={headOptions}
                required
                ariaLabel={kind === 'income' ? 'Income Channel' : 'Office / Head'}
                placeholder={kind === 'income' ? 'Select or type channel' : 'Select or type office/field'}
                className={fieldCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Department *</label>
              <select required value={department} onChange={(e) => setDepartment(e.target.value)} className={fieldCls}>
                <option value="">Select department</option>
                {departmentOptions.map((dept) => <option key={dept} value={dept}>{dept}</option>)}
              </select>
            </div>

            <div>
              <label className={labelCls}>Funding Source *</label>
              <select required value={fundSourceId} onChange={(e) => setFundSourceId(e.target.value)} className={fieldCls}>
                <option value="">Select fund source</option>
                {fundSources.filter((source) => source.active).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
              </select>
            </div>
          </div>

          {!isEdit && recentTemplates.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="inline-flex items-center gap-1 text-slate-400 font-semibold mr-1">
                <RotateCcw className="w-3 h-3 text-brand-600" /> Repeat recent:
              </span>
              {recentTemplates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className="px-2.5 py-1 rounded-lg bg-slate-50 hover:bg-brand-50 border border-slate-200 hover:border-brand-200 text-slate-700 hover:text-brand-900 font-medium transition-colors truncate max-w-[210px]"
                  title={`${tpl.counterparty} — ${tpl.purpose}`}
                >
                  {tpl.counterparty} ({formatBDT(tpl.amountPaisa)})
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Link Employee (Optional)</label>
              <select value={employeeId} onChange={(e) => handleEmployeeChange(e.target.value)} className={fieldCls}>
                <option value="">None / External Party</option>
                {activeEmployees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name} ({emp.code} · {emp.branch})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{kind === 'income' ? 'Received From *' : 'Paid To / Where Spent *'}</label>
              <input
                type="text"
                list="tx-counterparty-list"
                required
                placeholder={kind === 'income' ? 'e.g. Company A/C, Mithu' : 'e.g. Vendor, Staff, Landlord'}
                value={counterparty}
                onChange={(e) => setCounterparty(e.target.value)}
                className={fieldCls}
              />
              <datalist id="tx-counterparty-list">
                {counterpartyHints.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>{kind === 'income' ? 'How Received *' : 'How Paid *'}</label>
              <ComboInput
                value={paymentMethod}
                onChange={setPaymentMethod}
                options={methodOptions}
                required
                ariaLabel={kind === 'income' ? 'How Received' : 'How Paid'}
                placeholder="Cash, ATM, bKash, custom..."
                className={fieldCls}
              />
            </div>

            <div>
              <label className={labelCls}>Slip / Cheque / Ref #</label>
              <input
                type="text"
                placeholder="ATM / Cheque / Memo #"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                className={`${fieldCls} font-mono`}
              />
            </div>

            <div>
              <label className={labelCls}>Phone (Optional)</label>
              <input
                type="text"
                placeholder="01XXXXXXXXX"
                value={counterpartyPhone}
                onChange={(e) => setCounterpartyPhone(e.target.value)}
                className={fieldCls}
              />
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label className="text-xs font-semibold text-slate-600">
                {kind === 'income' ? 'Why Received / Allocation *' : 'Why Spent (Details) *'}
              </label>
              <div className="w-full sm:w-64">
                <ComboInput
                  value={subCategory}
                  onChange={setSubCategory}
                  options={subCategoryOptions}
                  required
                  ariaLabel="Field Category"
                  placeholder="Field / Category name"
                  className="w-full h-8 px-2.5 text-xs font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-2">
              {quickPurposes.map((qp) => (
                <button
                  key={qp.label}
                  type="button"
                  onClick={() => {
                    setSubCategory(qp.sub);
                    setPurpose((cur) => (cur.trim() ? cur : qp.text));
                  }}
                  className="px-2.5 py-1 rounded-lg bg-slate-50 hover:bg-brand-50 border border-slate-200 hover:border-brand-200 text-[11px] font-semibold text-slate-600 hover:text-brand-800 transition-colors"
                >
                  + {qp.label}
                </button>
              ))}
            </div>

            <textarea
              rows={2}
              required
              placeholder={kind === 'income' ? 'Purpose or allocation of funds...' : 'Item, month covered, site/branch, quantity...'}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              className="w-full px-3.5 py-2 text-sm text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl hover:bg-white focus:outline-none focus:bg-white focus:border-brand-500 focus:ring-2 focus:ring-brand-100 transition-colors"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div>
              <label className={labelCls}>Notes (Optional)</label>
              <input
                type="text"
                placeholder="Extra remark"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={fieldCls}
              />
            </div>
            <div>
              <label className={labelCls}>Voucher Photo / Slip (Stored in Database)</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCameraOpen(true)}
                  className="h-10 px-3 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-xs font-semibold text-brand-900 inline-flex items-center gap-1.5 shrink-0"
                >
                  <Camera className="w-4 h-4" /> Camera
                </button>
                <label className="flex-1 h-10 px-3 flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-white cursor-pointer text-xs text-slate-600 transition-colors min-w-0">
                  <Paperclip className="w-4 h-4 text-brand-600 shrink-0" />
                  <span className="truncate">{receipt ? receipt.name : editingTx?.receiptName ? `Replace (${editingTx.receiptName})` : 'Attach JPG/PNG/PDF'}</span>
                  <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleReceipt} className="hidden" />
                </label>
              </div>
            </div>
          </div>

          {isEdit && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 space-y-2.5">
              <div className="flex items-start gap-2 text-xs text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">Audit Reason (Recorded Automatically)</div>
                  <div className="text-amber-800/90 mt-0.5">
                    {amountChangedNow && !isAdmin
                      ? 'Amount changes are automatically flagged for verification review with exact Taka delta.'
                      : 'Old vs. new values, timestamp, and your name are appended to the edit history.'}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EDIT_REASON_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => setReason(chip)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors ${
                      reason === chip
                        ? 'bg-amber-600 border-amber-600 text-white'
                        : 'bg-white border-amber-200 text-amber-900 hover:bg-amber-100'
                    }`}
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <input
                type="text"
                required
                placeholder="Pick a quick reason above or type custom reason..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full h-10 px-3.5 text-sm text-[#1b2a4e] bg-white border border-amber-300 rounded-xl focus:outline-none focus:border-amber-500"
              />
            </div>
          )}

          <div className="pt-2 flex flex-wrap items-center justify-end gap-2.5 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            {!isEdit && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveEntry(true)}
                className="h-10 px-4 rounded-xl text-xs font-semibold text-brand-800 bg-brand-50 hover:bg-brand-100 border border-brand-200 inline-flex items-center gap-1.5 disabled:opacity-60 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Save &amp; Add Another
              </button>
            )}
            <button
              type="submit"
              disabled={busy}
              className="h-10 px-5 rounded-xl text-sm font-semibold text-white bg-gradient-to-br from-brand-500 to-brand-700 hover:from-brand-600 hover:to-brand-800 shadow-md shadow-brand-600/25 disabled:opacity-60 transition-all"
            >
              {busy ? 'Saving...' : isEdit ? 'Save Edit' : 'Save Entry'}
            </button>
          </div>
        </form>
      </div>

      <CameraCaptureModal
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => setReceipt(file)}
      />
    </div>
  );
};
