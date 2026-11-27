import React, { useEffect, useMemo, useState } from 'react';
import {
  Banknote,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Paperclip,
  Plus,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type {
  DepartmentRecord,
  Employee,
  EmployeeAdvance,
  EmployeeLoan,
  FundSource,
  LedgerHead,
  LedgerTransaction,
  SalaryPayment,
} from '../types';
import { PAYMENT_METHODS, dhakaMonth, dhakaToday, formatShortDate, monthRangeOf } from '../utils/ledger';
import { formatBDT, fromPaisa, toPaisa } from '../utils/money';
import {
  loadEmployeeActivityIds,
  createSalaryAdvance,
  deleteSalaryAdvance,
  deleteSalaryPayment,
  paySalary,
} from '../utils/cloud';
import { CameraCaptureModal } from './CameraCaptureModal';
import { ComboInput } from './ComboInput';
import { ScrollLock } from './ScrollLock';

interface Props {
  employees: Employee[];
  salaries: SalaryPayment[];
  loans: EmployeeLoan[];
  advances: EmployeeAdvance[];
  fundSources: FundSource[];
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  transactions: LedgerTransaction[];
  isAdmin: boolean;
  /** Admin or accountant: may record payments and entries. */
  canEdit: boolean;
  onOpenEmployee: (emp: Employee) => void;
  onOpenTx: (tx: LedgerTransaction) => void;
  onOpenTxId: (id: string) => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const SalaryTab: React.FC<Props> = ({
  employees,
  salaries,
  loans,
  advances,
  fundSources,
  heads,
  departments,
  transactions,
  isAdmin,
  canEdit,
  onOpenEmployee,
  onOpenTx,
  onOpenTxId,
  onChanged,
  onToast,
}) => {
  const [monthKey, setMonthKey] = useState(dhakaMonth);
  const [branchFilter, setBranchFilter] = useState('all');
  const [batchBusy, setBatchBusy] = useState(false);

  const [payTarget, setPayTarget] = useState<Employee | null>(null);
  const [paidDate, setPaidDate] = useState(dhakaToday());
  const [baseSalary, setBaseSalary] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [bonus, setBonus] = useState('');
  const [otherDeduction, setOtherDeduction] = useState('');
  const [department, setDepartment] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [fundSourceId, setFundSourceId] = useState('');
  const [batchDepartment, setBatchDepartment] = useState('');
  const [batchFundSourceId, setBatchFundSourceId] = useState('');
  const [batchPaymentMethod, setBatchPaymentMethod] = useState('');
  const [batchHead, setBatchHead] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [head, setHead] = useState('');
  const [notes, setNotes] = useState('');
  const [receipt, setReceipt] = useState<{ name: string; data: string } | undefined>(undefined);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteAdvId, setConfirmDeleteAdvId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [advOpen, setAdvOpen] = useState(false);
  const [advEmpId, setAdvEmpId] = useState('');
  const [advMonthKey, setAdvMonthKey] = useState(dhakaMonth);
  const [advDate, setAdvDate] = useState(dhakaToday);
  const [advAmount, setAdvAmount] = useState('');
  const [advDepartment, setAdvDepartment] = useState('');
  const [advFundSourceId, setAdvFundSourceId] = useState('');
  const [advMethod, setAdvMethod] = useState('');
  const [advPurpose, setAdvPurpose] = useState('');
  const [advBusy, setAdvBusy] = useState(false);
  const [advError, setAdvError] = useState('');

  const monthLabel = useMemo(() => monthRangeOf(monthKey).label, [monthKey]);
  const activeDepartments = useMemo(() => departments.filter((d) => d.active), [departments]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);
  const expenseHeads = useMemo(() => heads.filter((h) => h.kind === 'expense' && h.active), [heads]);
  const expenseHeadOptions = useMemo(() => {
    const set = new Set<string>(expenseHeads.map((h) => h.name));
    salaries.forEach((s) => s.head && set.add(s.head));
    return Array.from(set);
  }, [expenseHeads, salaries]);
  const methodOptions = useMemo(() => {
    const set = new Set<string>(PAYMENT_METHODS);
    salaries.forEach((s) => s.paymentMethod && set.add(s.paymentMethod));
    return Array.from(set);
  }, [salaries]);
  const branchOptions = useMemo(() => {
    const set = new Set<string>(expenseHeads.map((h) => h.name));
    employees.forEach((e) => e.branch && set.add(e.branch));
    return Array.from(set);
  }, [expenseHeads, employees]);

  const paymentsByEmp = useMemo(() => {
    const map = new Map<string, SalaryPayment[]>();
    for (const s of salaries) {
      if (s.monthKey === monthKey) {
        const list = map.get(s.employeeId) || [];
        list.push(s);
        map.set(s.employeeId, list);
      }
    }
    return map;
  }, [salaries, monthKey]);

  const advancesByEmp = useMemo(() => {
    const map = new Map<string, EmployeeAdvance[]>();
    for (const a of advances) {
      const mk = a.monthKey || a.issuedDate.slice(0, 7);
      if (mk === monthKey) {
        const list = map.get(a.employeeId) || [];
        list.push(a);
        map.set(a.employeeId, list);
      }
    }
    return map;
  }, [advances, monthKey]);

  const activeLoanInfo = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of loans) {
      if (l.status === 'active') map.set(l.employeeId, (map.get(l.employeeId) || 0) + l.remainingPaisa);
    }
    return map;
  }, [loans]);

  const [ledgerActivityEmployeeIds, setLedgerActivityEmployeeIds] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const monthRange = monthRangeOf(monthKey);
    const { from, to } = monthRange;
    loadEmployeeActivityIds(from, to)
      .then((ids) => { if (active) setLedgerActivityEmployeeIds(ids); })
      .catch(() => { if (active) setLedgerActivityEmployeeIds([]); });
    return () => { active = false; };
  }, [monthKey, transactions]);

  const monthlyActivityEmployeeIds = useMemo(() => {
    const ids = new Set<string>(ledgerActivityEmployeeIds);
    for (const payment of salaries) if (payment.monthKey === monthKey) ids.add(payment.employeeId);
    for (const advance of advances) {
      const mk = advance.monthKey || advance.issuedDate.slice(0, 7);
      if (mk === monthKey) ids.add(advance.employeeId);
    }
    return ids;
  }, [salaries, advances, ledgerActivityEmployeeIds, monthKey]);

  const rows = useMemo(() => {
    return employees
      .filter((employee) => (employee.active && employee.monthlySalaryPaisa > 0 && (!employee.joinedDate || employee.joinedDate.slice(0, 7) <= monthKey)) || monthlyActivityEmployeeIds.has(employee.id))
      .filter((employee) => branchFilter === 'all' || employee.branch === branchFilter)
      .map((emp) => {
        const empPayments = paymentsByEmp.get(emp.id) || [];
        const empAdvances = advancesByEmp.get(emp.id) || [];
        const effectiveBasePaisa = emp.monthlySalaryPaisa > 0 ? emp.monthlySalaryPaisa : (empPayments[0]?.baseSalaryPaisa || 0);
        const totalAdvancesPaisa = empAdvances.reduce((s, a) => s + a.principalPaisa, 0);
        const paidPaisa = empPayments.reduce((s, p) => s + p.netPaidPaisa, 0);
        const bonusPaisa = empPayments.reduce((s, p) => s + p.bonusPaisa, 0);
        const otherDedPaisa = empPayments.reduce((s, p) => s + p.otherDeductionPaisa, 0);
        const loanDedPaisa = empPayments.reduce((s, p) => s + p.loanDeductionPaisa, 0);
        const remainingPaisa = Math.max(0, effectiveBasePaisa + bonusPaisa - otherDedPaisa - loanDedPaisa - totalAdvancesPaisa - paidPaisa);
        const loanRemaining = activeLoanInfo.get(emp.id) || 0;
        const status: 'paid' | 'partial' | 'pending' =
          remainingPaisa === 0 && (empPayments.length > 0 || (effectiveBasePaisa > 0 && totalAdvancesPaisa >= effectiveBasePaisa))
            ? 'paid'
            : paidPaisa > 0 || totalAdvancesPaisa > 0
              ? 'partial'
              : 'pending';
        return {
          emp,
          empPayments,
          empAdvances,
          effectiveBasePaisa,
          totalAdvancesPaisa,
          paidPaisa,
          bonusPaisa,
          otherDedPaisa,
          remainingPaisa,
          loanRemaining,
          status,
        };
      });
  }, [employees, branchFilter, monthKey, monthlyActivityEmployeeIds, paymentsByEmp, advancesByEmp, activeLoanInfo]);

  const summary = useMemo(() => {
    let totalScheduled = 0;
    let totalPaid = 0;
    let settledCount = 0;
    let pendingAmount = 0;
    for (const r of rows) {
      totalScheduled += r.effectiveBasePaisa;
      totalPaid += r.paidPaisa;
      pendingAmount += r.remainingPaisa;
      if (r.status === 'paid') settledCount += 1;
    }
    return { totalStaff: rows.length, settledCount, totalScheduled, totalPaid, pendingAmount };
  }, [rows]);

  const openPayModal = (emp: Employee) => {
    const row = rows.find((r) => r.emp.id === emp.id);
    setPayTarget(emp);
    setPaidDate(dhakaToday());
    setBaseSalary(row && row.effectiveBasePaisa > 0 ? fromPaisa(row.effectiveBasePaisa) : '');
    setPayAmount('');
    setBonus('');
    setOtherDeduction('');
    setDepartment('');
    setPaymentMethod('');
    setFundSourceId('');
    setReferenceNo('');
    setHead('');
    setNotes('');
    setReceipt(undefined);
    setError('');
  };

  const payTargetRow = useMemo(() => (payTarget ? rows.find((r) => r.emp.id === payTarget.id) : undefined), [payTarget, rows]);
  const modalBasePaisa = useMemo(() => {
    if (!payTarget) return 0;
    const configured = payTarget.monthlySalaryPaisa;
    const typed = toPaisa(baseSalary) || 0;
    if (!isAdmin) return configured;
    if (configured > 0) return typed > 0 ? typed : configured;
    return typed;
  }, [payTarget, baseSalary, isAdmin]);

  const modalRemainingBeforeThis = useMemo(() => {
    if (!payTargetRow) return 0;
    const bonusP = toPaisa(bonus) || 0;
    const otherDedP = toPaisa(otherDeduction) || 0;
    return Math.max(
      0,
      modalBasePaisa + payTargetRow.bonusPaisa + bonusP - payTargetRow.otherDedPaisa - otherDedP - payTargetRow.totalAdvancesPaisa - payTargetRow.paidPaisa,
    );
  }, [payTargetRow, modalBasePaisa, bonus, otherDeduction]);

  const openAdvModal = () => {
    setAdvEmpId('');
    setAdvMonthKey(monthKey);
    setAdvDate(dhakaToday());
    setAdvAmount('');
    setAdvDepartment('');
    setAdvFundSourceId('');
    setAdvMethod('');
    setAdvPurpose('');
    setAdvError('');
    setAdvOpen(true);
  };

  const handleCreateAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdvError('');
    const amtP = toPaisa(advAmount);
    if (!advEmpId) return setAdvError('Select an employee.');
    if (!amtP || amtP <= 0) return setAdvError('Enter a valid amount greater than ৳0.00.');
    if (!advDepartment.trim()) return setAdvError('Select the Department.');
    if (!advFundSourceId) return setAdvError('Select the Funding Source.');
    if (!advMethod.trim()) return setAdvError('Select or type a payment method.');
    if (advPurpose.trim().length < 3) return setAdvError('Enter the reason for this advance.');
    setAdvBusy(true);
    try {
      await createSalaryAdvance({
        employeeId: advEmpId,
        monthKey: advMonthKey,
        issuedDate: advDate,
        amount: advAmount,
        department: advDepartment.trim(),
        fundSourceId: advFundSourceId,
        paymentMethod: advMethod.trim(),
        purpose: advPurpose.trim(),
      });
      setAdvOpen(false);
      onChanged();
      onToast(`Salary advance recorded for ${advMonthKey}`);
    } catch (err: any) {
      setAdvError(err?.message || 'Could not record salary advance.');
    } finally {
      setAdvBusy(false);
    }
  };

  const handleConfirmPay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    if (!department.trim() || !fundSourceId || !paymentMethod.trim()) {
      setError('Select the department, funding source, and payment method.');
      return;
    }
    const payP = toPaisa(payAmount);
    if (!payP || payP <= 0) {
      setError('Enter the payout amount greater than ৳0.00.');
      return;
    }
    if (payP > modalRemainingBeforeThis) {
      setError(`Payout exceeds remaining payable balance (${formatBDT(modalRemainingBeforeThis)}).`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await paySalary({
        employeeId: payTarget.id,
        monthKey,
        paidDate,
        baseSalary: fromPaisa(modalBasePaisa),
        payAmount,
        bonus,
        otherDeduction,
        paymentMethod: paymentMethod.trim(),
        referenceNo: referenceNo.trim(),
        department: department.trim(),
        head: (head.trim() || department.trim()),
        fundSourceId,
        notes: notes.trim(),
        receipt,
      });
      onToast(`Salary recorded for ${payTarget.name} (${res.payment.referenceNo || res.payment.monthKey})`);
      setPayTarget(null);
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not process salary.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSalary = async (payment: SalaryPayment) => {
    setDeletingId(payment.id);
    try {
      await deleteSalaryPayment(payment.id);
      setConfirmDeleteId(null);
      onToast(`Deleted ${payment.monthKey} salary payment for ${payment.employeeName}`);
      onChanged();
    } catch (err: any) {
      onToast(err?.message || 'Could not delete salary record.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteAdvance = async (adv: EmployeeAdvance) => {
    setDeletingId(adv.id);
    try {
      await deleteSalaryAdvance(adv.id);
      setConfirmDeleteAdvId(null);
      onToast(`Deleted advance ${adv.advanceNo} for ${adv.employeeName}`);
      onChanged();
    } catch (err: any) {
      onToast(err?.message || 'Could not delete advance.');
    } finally {
      setDeletingId(null);
    }
  };

  const handlePayAllPending = async () => {
    const pending = rows.filter((row) => row.remainingPaisa > 0 && row.effectiveBasePaisa > 0);
    if (pending.length === 0) return;
    if (!batchDepartment || !batchFundSourceId || !batchPaymentMethod) {
      onToast('Select a department, funding source, and payment method before batch payroll.');
      return;
    }
    setBatchBusy(true);
    let done = 0;
    try {
      for (const row of pending) {
        await paySalary({
          employeeId: row.emp.id,
          monthKey,
          paidDate: dhakaToday(),
          baseSalary: fromPaisa(row.effectiveBasePaisa),
          payAmount: fromPaisa(row.remainingPaisa),
          bonus: '',
          otherDeduction: '',
          paymentMethod: batchPaymentMethod,
          department: batchDepartment,
          head: batchHead || batchDepartment,
          fundSourceId: batchFundSourceId,
          notes: `${monthLabel} batch payroll`,
        });
        done += 1;
      }
      onToast(`Processed remaining salary for ${done} employee${done === 1 ? '' : 's'}.`);
      onChanged();
    } catch (err: any) {
      onToast(err?.message || `Processed ${done} salaries before stopping.`);
      onChanged();
    } finally {
      setBatchBusy(false);
    }
  };

  const handleFileReceipt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setReceipt({ name: file.name, data: reader.result });
    };
    reader.readAsDataURL(file);
  };

  const fieldCls = 'w-full h-10 px-3 text-sm text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500';
  const payableCount = rows.filter((r) => r.remainingPaisa > 0 && r.effectiveBasePaisa > 0).length;

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className={`font-display text-2xl font-extrabold tracking-tight ${INK}`}>Employee Salary Payroll</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Cycle payroll supporting advances and partial payouts (loans remain standalone and are never auto-deducted).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setMonthKey((m) => shiftMonth(m, -1))}
              className="w-7 h-7 rounded-lg grid place-items-center text-slate-600 hover:bg-slate-100"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="month"
              value={monthKey}
              onChange={(e) => e.target.value && setMonthKey(e.target.value)}
              className="h-7 px-2 text-xs font-bold text-[#1b2a4e] bg-transparent focus:outline-none tabular-nums"
            />
            <button
              type="button"
              onClick={() => setMonthKey((m) => shiftMonth(m, 1))}
              className="w-7 h-7 rounded-lg grid place-items-center text-slate-600 hover:bg-slate-100"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <select
            value={branchFilter}
            onChange={(e) => setBranchFilter(e.target.value)}
            className="h-9 px-3 text-xs font-semibold text-[#1b2a4e] bg-white border border-slate-200 rounded-xl focus:outline-none"
          >
            <option value="all">All Offices</option>
            {branchOptions.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>

          {canEdit && (
          <button
            type="button"
            onClick={openAdvModal}
            className="h-9 px-3.5 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-brand-900 text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Record Advance
          </button>
          )}

          {canEdit && payableCount > 0 && (
            <>
              <select value={batchDepartment} onChange={(e) => setBatchDepartment(e.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
                <option value="">Batch department *</option>
                {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
              <select value={batchFundSourceId} onChange={(e) => setBatchFundSourceId(e.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
                <option value="">Batch funding source *</option>
                {fundSources.filter((source) => source.active).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
              </select>
              <select value={batchPaymentMethod} onChange={(e) => setBatchPaymentMethod(e.target.value)} className="h-9 rounded-xl border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
                <option value="">Payment method *</option>
                {PAYMENT_METHODS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <select value={batchHead} onChange={(e) => setBatchHead(e.target.value)} className="h-9 max-w-40 rounded-xl border border-slate-200 bg-white px-2.5 text-xs text-slate-700">
                <option value="">Office head (opt.)</option>
                {expenseHeadOptions.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <button
                type="button"
                disabled={batchBusy}
                onClick={handlePayAllPending}
                className="h-9 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                <Banknote className="w-4 h-4" />
                {batchBusy ? 'Paying...' : `Pay Remaining (${payableCount})`}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 @md:grid-cols-2 @5xl:grid-cols-4 gap-4">
        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Payroll Progress</span>
            <Users className="w-4 h-4 text-brand-600" />
          </div>
          <div className={`text-2xl font-extrabold tabular-nums mt-2 ${INK}`}>
            {summary.settledCount} / {summary.totalStaff}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">{monthLabel} settled</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Scheduled Base</span>
            <Wallet className="w-4 h-4 text-slate-500" />
          </div>
          <div className={`text-2xl font-extrabold tabular-nums mt-2 ${INK}`}>{formatBDT(summary.totalScheduled)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Active employee salaries</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Disbursed This Month</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-emerald-600 mt-2">{formatBDT(summary.totalPaid)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Ledger-linked payroll payouts</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Remaining Payable</span>
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-amber-600 mt-2">{formatBDT(summary.pendingAmount)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">After cycle advances &amp; partial payouts</div>
        </div>
      </div>

      <section className={`${SURFACE} overflow-hidden`}>
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">No active employees for this cycle filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3 text-right">Base Salary</th>
                  <th className="px-4 py-3">Cycle Advances</th>
                  <th className="px-4 py-3 text-right">Paid This Cycle</th>
                  <th className="px-4 py-3 text-right">Remaining Payable</th>
                  <th className="px-4 py-3">Status &amp; Vouchers</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const { emp, empPayments, empAdvances, effectiveBasePaisa, totalAdvancesPaisa, paidPaisa, remainingPaisa, loanRemaining, status } = r;
                  return (
                    <tr key={emp.id} className="hover:bg-slate-50/70 align-top">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => onOpenEmployee(emp)}
                          className="text-left hover:underline"
                        >
                          <div className={`font-bold ${INK}`}>{emp.name}</div>
                          <div className="text-[11px] text-slate-500 font-mono">{emp.code} · {emp.role}</div>
                          {loanRemaining > 0 && (
                            <div className="text-[10.5px] text-slate-400 mt-0.5">Separate Loan Bal: {formatBDT(loanRemaining)}</div>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums text-[#1b2a4e]">
                        {formatBDT(effectiveBasePaisa)}
                      </td>
                      <td className="px-4 py-3">
                        {empAdvances.length === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <div className="space-y-1">
                            <div className="font-bold text-amber-700 tabular-nums">-{formatBDT(totalAdvancesPaisa)}</div>
                            {empAdvances.map((adv) => {
                              const advTx = adv.linkedTxId ? transactions.find((t) => t.id === adv.linkedTxId) : undefined;
                              return (
                                <div key={adv.id} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                                  <span>{formatShortDate(adv.issuedDate)}</span>
                                  <span>({formatBDT(adv.principalPaisa)})</span>
                                  {adv.linkedTxId && (
                                    <button type="button" onClick={() => advTx ? onOpenTx(advTx) : onOpenTxId(adv.linkedTxId!)} className="font-mono text-brand-700 hover:underline">
                                      {advTx?.voucherNo || adv.linkedVoucherNo || 'Open ledger entry'}
                                    </button>
                                  )}
                                  {isAdmin && (
                                    confirmDeleteAdvId === adv.id ? (
                                      <span className="inline-flex items-center gap-1">
                                        <button
                                          type="button"
                                          disabled={deletingId === adv.id}
                                          onClick={() => void handleDeleteAdvance(adv)}
                                          className="text-rose-600 font-bold hover:underline"
                                        >
                                          Confirm
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setConfirmDeleteAdvId(null)}
                                          className="text-slate-400 hover:text-slate-700"
                                        >
                                          Cancel
                                        </button>
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteAdvId(adv.id)}
                                        className="text-slate-400 hover:text-rose-600"
                                        title={`Delete advance ${adv.advanceNo}`}
                                        aria-label={`Delete advance ${adv.advanceNo}`}
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    )
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-extrabold tabular-nums text-brand-700">
                        {formatBDT(paidPaisa)}
                      </td>
                      <td className={`px-4 py-3 text-right font-extrabold tabular-nums ${remainingPaisa > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {formatBDT(remainingPaisa)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          <div>
                            {status === 'paid' ? (
                              <span className="font-bold text-emerald-600 inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Settled
                              </span>
                            ) : status === 'partial' ? (
                              <span className="font-semibold text-amber-600">Partial</span>
                            ) : (
                              <span className="font-semibold text-slate-400">Pending</span>
                            )}
                          </div>
                          {empPayments.map((payment) => {
                            const linkedTx = payment.linkedTxId ? transactions.find((t) => t.id === payment.linkedTxId) : undefined;
                            return (
                              <div key={payment.id} className="text-[11px] text-slate-500 flex flex-wrap items-center gap-1.5">
                                <span className="tabular-nums font-semibold text-[#1b2a4e]">{formatBDT(payment.netPaidPaisa)}</span>
                                <span>· {formatShortDate(payment.paidDate)}</span>
                                {payment.linkedTxId ? (
                                  <button type="button" onClick={() => linkedTx ? onOpenTx(linkedTx) : onOpenTxId(payment.linkedTxId!)} className="font-mono text-brand-700 hover:underline">
                                    {linkedTx?.voucherNo || payment.linkedVoucherNo || payment.referenceNo || 'Open ledger entry'}
                                  </button>
                                ) : (
                                  <span className="font-mono text-slate-400">{payment.referenceNo}</span>
                                )}
                                {payment.department && <span className="text-slate-400">({payment.department})</span>}
                                {payment.receiptSha && (
                                  <a
                                    href={`/api/receipts/${payment.receiptSha}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-brand-700 hover:underline inline-flex items-center gap-0.5"
                                  >
                                    <Paperclip className="w-3 h-3" /> Slip
                                  </a>
                                )}
                                {isAdmin && (
                                  confirmDeleteId === payment.id ? (
                                    <span className="inline-flex items-center gap-1">
                                      <button
                                        type="button"
                                        disabled={deletingId === payment.id}
                                        onClick={() => void handleDeleteSalary(payment)}
                                        className="text-rose-600 font-bold hover:underline"
                                      >
                                        Confirm
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setConfirmDeleteId(null)}
                                        className="text-slate-400 hover:text-slate-700"
                                      >
                                        Cancel
                                      </button>
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setConfirmDeleteId(payment.id)}
                                      className="text-slate-400 hover:text-rose-600"
                                      title="Delete salary payout"
                                      aria-label={`Delete salary payout for ${emp.name}`}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {remainingPaisa > 0 ? (canEdit ? (
                          <button
                            type="button"
                            onClick={() => openPayModal(emp)}
                            className="h-8 px-3 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold"
                          >
                            {paidPaisa > 0 ? 'Pay Remaining' : 'Pay Salary'}
                          </button>
                        ) : (
                          <span className="text-[11px] text-slate-400">Pending</span>
                        )) : (
                          <span className="text-[11px] text-slate-400">Settled</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {payTarget && payTargetRow && (
        <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className={`text-base font-bold ${INK}`}>Pay Salary · {payTarget.name}</h2>
                <p className="text-xs text-slate-500">{monthLabel} · Partial or full disbursement</p>
              </div>
              <button type="button" onClick={() => setPayTarget(null)} className="w-8 h-8 rounded-full grid place-items-center text-slate-400 hover:bg-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleConfirmPay} className="p-6 space-y-4 overflow-y-auto">
              {error && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700 font-medium">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Base Salary (৳) *</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    readOnly={!isAdmin}
                    value={baseSalary}
                    onChange={(e) => setBaseSalary(e.target.value)}
                    className={`${fieldCls} font-mono tabular-nums`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Bonus / Overtime (৳)</label>
                  <input type="text" inputMode="decimal" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono tabular-nums`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Other Deduction (৳)</label>
                  <input type="text" inputMode="decimal" value={otherDeduction} onChange={(e) => setOtherDeduction(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono tabular-nums`} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-semibold text-slate-600">Pay Amount (৳) *</label>
                    <button
                      type="button"
                      onClick={() => setPayAmount(fromPaisa(modalRemainingBeforeThis))}
                      className="text-[11px] font-semibold text-brand-700 hover:underline"
                    >
                      Full ({formatBDT(modalRemainingBeforeThis)})
                    </button>
                  </div>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    placeholder="Enter payout amount"
                    className={`${fieldCls} font-mono font-bold tabular-nums`}
                  />
                </div>
              </div>

              <div className="rounded-2xl bg-slate-50 border border-slate-100 px-4 py-3 space-y-1 text-xs">
                <div className="flex justify-between text-slate-500">
                  <span>Cycle Advances ({payTargetRow.empAdvances.length})</span>
                  <span className="tabular-nums text-amber-700">-{formatBDT(payTargetRow.totalAdvancesPaisa)}</span>
                </div>
                <div className="flex justify-between text-slate-500">
                  <span>Previously Disbursed ({payTargetRow.empPayments.length})</span>
                  <span className="tabular-nums">-{formatBDT(payTargetRow.paidPaisa)}</span>
                </div>
                <div className="flex justify-between font-extrabold text-[#1b2a4e] pt-1 border-t border-slate-200">
                  <span>Remaining Payable Before This</span>
                  <span className="text-brand-700 tabular-nums">{formatBDT(modalRemainingBeforeThis)}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Department *</label>
                  <select required value={department} onChange={(e) => setDepartment(e.target.value)} className={fieldCls}>
                    <option value="">Select department</option>
                    {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Funding Source *</label>
                  <select required value={fundSourceId} onChange={(e) => setFundSourceId(e.target.value)} className={fieldCls}>
                    <option value="">Select fund source</option>
                    {fundSources.filter((source) => source.active).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Payment Date *</label>
                  <input type="date" required value={paidDate} onChange={(e) => setPaidDate(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Payment Method *</label>
                  <ComboInput
                    value={paymentMethod}
                    onChange={setPaymentMethod}
                    options={methodOptions}
                    required
                    ariaLabel="Payment Method"
                    placeholder="Cash, bKash, Bank..."
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Office / Head (Optional)</label>
                  <ComboInput
                    value={head}
                    onChange={setHead}
                    options={expenseHeadOptions}
                    ariaLabel="Office or Field"
                    placeholder="Defaults to department"
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Ref / Slip #</label>
                  <input type="text" value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} placeholder="Optional ref" className={`${fieldCls} font-mono`} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Voucher Photo (Optional)</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCameraOpen(true)}
                    className="h-9 px-3 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-xs font-semibold text-brand-900 inline-flex items-center gap-1.5"
                  >
                    <Camera className="w-3.5 h-3.5" /> Camera
                  </button>
                  <label className="flex-1 h-9 px-3 flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-white cursor-pointer text-xs text-slate-600">
                    <Paperclip className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                    <span className="truncate">{receipt ? receipt.name : 'Upload JPG / PNG / PDF'}</span>
                    <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleFileReceipt} className="hidden" />
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Notes</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={fieldCls} />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setPayTarget(null)} className="h-10 px-4 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
                  Cancel
                </button>
                <button type="submit" disabled={busy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-60">
                  {busy ? 'Saving...' : 'Confirm & Record Salary'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {advOpen && (
        <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className={`text-base font-bold ${INK}`}>Record Salary Advance</h2>
                <p className="text-xs text-slate-500">Linked to the selected payroll cycle and Daily Ledger</p>
              </div>
              <button type="button" onClick={() => setAdvOpen(false)} className="w-8 h-8 rounded-full grid place-items-center text-slate-400 hover:bg-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateAdvance} className="p-6 space-y-4 overflow-y-auto">
              {advError && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700 font-medium">
                  {advError}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Employee *</label>
                  <select required value={advEmpId} onChange={(e) => setAdvEmpId(e.target.value)} className={fieldCls}>
                    <option value="">Select employee</option>
                    {activeEmployees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name} ({emp.code})</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Payroll Month *</label>
                  <input type="month" required value={advMonthKey} onChange={(e) => setAdvMonthKey(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Amount (BDT ৳) *</label>
                  <input type="text" inputMode="decimal" required value={advAmount} onChange={(e) => setAdvAmount(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono font-bold`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Issued Date *</label>
                  <input type="date" required value={advDate} onChange={(e) => setAdvDate(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Department *</label>
                  <select required value={advDepartment} onChange={(e) => setAdvDepartment(e.target.value)} className={fieldCls}>
                    <option value="">Select department</option>
                    {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Funding Source *</label>
                  <select required value={advFundSourceId} onChange={(e) => setAdvFundSourceId(e.target.value)} className={fieldCls}>
                    <option value="">Select fund source</option>
                    {fundSources.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Payment Method *</label>
                <ComboInput
                  value={advMethod}
                  onChange={setAdvMethod}
                  options={methodOptions}
                  required
                  ariaLabel="Payment Method"
                  placeholder="Cash, bKash, Bank..."
                  className={fieldCls}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Reason / Purpose *</label>
                <input type="text" required value={advPurpose} onChange={(e) => setAdvPurpose(e.target.value)} placeholder="Reason for salary advance" className={fieldCls} />
              </div>
              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setAdvOpen(false)} className="h-10 px-4 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
                  Cancel
                </button>
                <button type="submit" disabled={advBusy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-60">
                  {advBusy ? 'Saving...' : 'Record Advance'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CameraCaptureModal
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => setReceipt(file)}
      />
    </div>
  );
};
