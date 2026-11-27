import React, { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  HandCoins,
  Paperclip,
  Plus,
  Search,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type {
  DepartmentRecord,
  Employee,
  EmployeeLoan,
  FundSource,
  LedgerHead,
  LedgerTransaction,
} from '../types';
import { PAYMENT_METHODS, dhakaToday, formatShortDate } from '../utils/ledger';
import { formatBDT } from '../utils/money';
import { deleteLoan, deleteLoanRepayment, issueLoan, repayLoan } from '../utils/cloud';
import { CameraCaptureModal } from './CameraCaptureModal';
import { ComboInput } from './ComboInput';
import { ScrollLock } from './ScrollLock';

interface Props {
  employees: Employee[];
  loans: EmployeeLoan[];
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

export const LoansTab: React.FC<Props> = ({
  employees,
  loans,
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'settled'>('all');
  const [search, setSearch] = useState('');
  const [expandedLoanId, setExpandedLoanId] = useState<string | null>(null);
  const [confirmDeleteLoanId, setConfirmDeleteLoanId] = useState<string | null>(null);
  const [confirmDeleteRepayId, setConfirmDeleteRepayId] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const [issueOpen, setIssueOpen] = useState(false);
  const [empId, setEmpId] = useState('');
  const [issuedDate, setIssuedDate] = useState(dhakaToday());
  const [amount, setAmount] = useState('');
  const [installment, setInstallment] = useState('');
  const [method, setMethod] = useState('');
  const [issueDepartment, setIssueDepartment] = useState('');
  const [head, setHead] = useState('');
  const [fundSourceId, setFundSourceId] = useState('');
  const [refNo, setRefNo] = useState('');
  const [purpose, setPurpose] = useState('');
  const [issueReceipt, setIssueReceipt] = useState<{ name: string; data: string } | undefined>(undefined);

  const [repayTarget, setRepayTarget] = useState<EmployeeLoan | null>(null);
  const [repayDate, setRepayDate] = useState(dhakaToday());
  const [repayAmount, setRepayAmount] = useState('');
  const [repayMethod, setRepayMethod] = useState('');
  const [repayDepartment, setRepayDepartment] = useState('');
  const [repayHead, setRepayHead] = useState('');
  const [repayFundSourceId, setRepayFundSourceId] = useState('');
  const [repayRef, setRepayRef] = useState('');
  const [repayNote, setRepayNote] = useState('');
  const [repayReceipt, setRepayReceipt] = useState<{ name: string; data: string } | undefined>(undefined);

  const [cameraTarget, setCameraTarget] = useState<'issue' | 'repay' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const activeDepartments = useMemo(() => departments.filter((d) => d.active), [departments]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.active), [employees]);
  const expenseHeads = useMemo(() => heads.filter((h) => h.kind === 'expense' && h.active), [heads]);
  const incomeHeads = useMemo(() => heads.filter((h) => h.kind === 'income' && h.active), [heads]);
  const expenseHeadOptions = useMemo(() => {
    const set = new Set<string>(expenseHeads.map((h) => h.name));
    loans.forEach((l) => l.head && set.add(l.head));
    return Array.from(set);
  }, [expenseHeads, loans]);
  const incomeHeadOptions = useMemo(() => {
    const set = new Set<string>(incomeHeads.map((h) => h.name));
    return Array.from(set);
  }, [incomeHeads]);
  const methodOptions = useMemo(() => {
    const set = new Set<string>(PAYMENT_METHODS);
    loans.forEach((l) => {
      if (l.paymentMethod) set.add(l.paymentMethod);
      l.repayments.forEach((rp) => rp.paymentMethod && set.add(rp.paymentMethod));
    });
    return Array.from(set);
  }, [loans]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return loans.filter((l) => {
      if (statusFilter !== 'all' && l.status !== statusFilter) return false;
      if (!q) return true;
      return [l.loanNo, l.employeeName, l.purpose, l.head, l.referenceNo, l.linkedVoucherNo]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [loans, statusFilter, search]);

  const totals = useMemo(() => {
    const issued = loans.reduce((s, l) => s + l.principalPaisa, 0);
    const activeOutstanding = loans.reduce((s, l) => s + (l.status === 'active' ? l.remainingPaisa : 0), 0);
    const repaid = issued - activeOutstanding;
    const borrowers = new Set(loans.filter((l) => l.status === 'active').map((l) => l.employeeId)).size;
    return { issued, activeOutstanding, repaid, borrowers };
  }, [loans]);

  const openIssueModal = () => {
    setEmpId('');
    setIssuedDate(dhakaToday());
    setAmount('');
    setInstallment('');
    setMethod('');
    setIssueDepartment('');
    setHead('');
    setFundSourceId('');
    setRefNo('');
    setPurpose('');
    setIssueReceipt(undefined);
    setError('');
    setIssueOpen(true);
  };

  const openRepayModal = (loan: EmployeeLoan) => {
    setRepayTarget(loan);
    setRepayDate(dhakaToday());
    setRepayAmount('');
    setRepayMethod('');
    setRepayDepartment('');
    setRepayHead('');
    setRepayFundSourceId('');
    setRepayRef('');
    setRepayNote('');
    setRepayReceipt(undefined);
    setError('');
  };

  const handleIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issueDepartment.trim()) {
      setError('Select the Department.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await issueLoan({
        employeeId: empId,
        issuedDate,
        amount,
        monthlyInstallment: installment || '0',
        paymentMethod: method.trim(),
        referenceNo: refNo.trim(),
        department: issueDepartment.trim(),
        head: head.trim() || issueDepartment.trim(),
        fundSourceId,
        purpose: purpose.trim(),
        receipt: issueReceipt,
      });
      onToast(`${res.loan.loanNo} issued (standalone loan ledger)`);
      setIssueOpen(false);
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not issue loan.');
    } finally {
      setBusy(false);
    }
  };

  const handleRepay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repayTarget) return;
    if (!repayDepartment.trim()) {
      setError('Select the Department.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await repayLoan(repayTarget.id, {
        paidDate: repayDate,
        amount: repayAmount,
        paymentMethod: repayMethod.trim(),
        referenceNo: repayRef.trim(),
        department: repayDepartment.trim(),
        head: repayHead.trim() || repayDepartment.trim(),
        fundSourceId: repayFundSourceId,
        note: repayNote.trim(),
        receipt: repayReceipt,
      });
      onToast(`Repayment recorded on ${res.loan.loanNo}`);
      setRepayTarget(null);
      setExpandedLoanId(repayTarget.id);
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not record repayment.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteLoan = async (loan: EmployeeLoan) => {
    setDeletingKey(`loan:${loan.id}`);
    try {
      await deleteLoan(loan.id);
      setConfirmDeleteLoanId(null);
      if (expandedLoanId === loan.id) setExpandedLoanId(null);
      onToast(`Deleted loan ${loan.loanNo}`);
      onChanged();
    } catch (err: any) {
      onToast(err?.message || 'Could not delete loan.');
    } finally {
      setDeletingKey(null);
    }
  };

  const handleDeleteRepayment = async (loan: EmployeeLoan, repaymentId: string) => {
    setDeletingKey(`repay:${repaymentId}`);
    try {
      await deleteLoanRepayment(loan.id, repaymentId);
      setConfirmDeleteRepayId(null);
      onToast(`Deleted repayment and restored balance on ${loan.loanNo}`);
      onChanged();
    } catch (err: any) {
      onToast(err?.message || 'Could not delete repayment.');
    } finally {
      setDeletingKey(null);
    }
  };

  const handleFilePick = (target: 'issue' | 'repay') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        if (target === 'issue') setIssueReceipt({ name: file.name, data: reader.result });
        else setRepayReceipt({ name: file.name, data: reader.result });
      }
    };
    reader.readAsDataURL(file);
  };

  const fieldCls = 'w-full h-10 px-3 text-sm text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500';

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className={`font-display text-2xl font-extrabold tracking-tight ${INK}`}>Employee Loans &amp; Advances</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Standalone loan &amp; repayment register (separate from Daily Ledger &amp; Monthly Statement totals).
          </p>
        </div>
        {canEdit && (
        <button
          type="button"
          onClick={openIssueModal}
          disabled={activeEmployees.length === 0}
          className="h-9 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          <Plus className="w-4 h-4" /> Issue Loan / Advance
        </button>
        )}
      </div>

      
      <div className="grid grid-cols-1 @md:grid-cols-2 @5xl:grid-cols-4 gap-4">
        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Total Issued</span>
            <HandCoins className="w-4 h-4 text-brand-600" />
          </div>
          <div className={`text-2xl font-extrabold tabular-nums mt-2 ${INK}`}>{formatBDT(totals.issued)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{loans.length} standalone loan records</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Active Outstanding</span>
            <Wallet className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-amber-600 mt-2">{formatBDT(totals.activeOutstanding)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Recoverable balance</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Repaid So Far</span>
            <ArrowDownLeft className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-emerald-600 mt-2">{formatBDT(totals.repaid)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Total repayments recorded</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Active Borrowers</span>
            <Users className="w-4 h-4 text-slate-500" />
          </div>
          <div className={`text-2xl font-extrabold tabular-nums mt-2 ${INK}`}>{totals.borrowers}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Staff with open balances</div>
        </div>
      </div>

      
      <section className={`${SURFACE} overflow-hidden`}>
        <div className="p-4 border-b border-slate-100 flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search loan #, employee, purpose..."
              className="w-full h-9 pl-9 pr-3 text-xs text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="h-9 px-3 text-xs font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none"
          >
            <option value="all">All Loans</option>
            <option value="active">Active Only</option>
            <option value="settled">Settled</option>
          </select>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">No loans match your filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Loan &amp; Date</th>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Purpose &amp; Details</th>
                  <th className="px-4 py-3 text-right">Principal</th>
                  <th className="px-4 py-3 text-right">Remaining</th>
                  <th className="px-4 py-3">Repayments</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((loan) => {
                  const emp = employees.find((e) => e.id === loan.employeeId);
                  const tx = loan.linkedTxId ? transactions.find((t) => t.id === loan.linkedTxId) : undefined;
                  const expanded = expandedLoanId === loan.id;
                  return (
                    <React.Fragment key={loan.id}>
                      <tr className="hover:bg-slate-50/70">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className={`font-mono font-bold ${INK}`}>{loan.loanNo}</div>
                          <div className="text-[11px] text-slate-400 tabular-nums">{formatShortDate(loan.issuedDate)}</div>
                        </td>
                        <td className="px-4 py-3">
                          {emp ? (
                            <button type="button" onClick={() => onOpenEmployee(emp)} className="text-left hover:underline font-bold text-[#1b2a4e]">
                              {loan.employeeName}
                            </button>
                          ) : (
                            <span className="font-bold text-[#1b2a4e]">{loan.employeeName}</span>
                          )}
                          <div className="text-[11px] text-slate-500">{loan.head} · Fund source linked</div>
                        </td>
                        <td className="px-4 py-3 max-w-sm">
                          <div className="text-[#1b2a4e] truncate">{loan.purpose}</div>
                          <div className="text-[11px] text-slate-400 font-mono flex flex-wrap items-center gap-2">
                            <span>{loan.paymentMethod}</span>
                            {loan.referenceNo && <span>· {loan.referenceNo}</span>}
                            {loan.linkedTxId && (
                              <button type="button" onClick={() => tx ? onOpenTx(tx) : onOpenTxId(loan.linkedTxId!)} className="text-brand-700 hover:underline">
                                · {tx?.voucherNo || loan.linkedVoucherNo || 'Open ledger entry'}
                              </button>
                            )}
                            {loan.receiptSha && (
                              <a
                                href={`/api/receipts/${loan.receiptSha}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-sans text-brand-700 hover:underline inline-flex items-center gap-0.5"
                              >
                                <Paperclip className="w-3 h-3" /> Receipt
                              </a>
                            )}
                            {loan.monthlyInstallmentPaisa > 0 && (
                              <span className="font-sans">· {formatBDT(loan.monthlyInstallmentPaisa)}/mo</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums text-[#1b2a4e]">
                          {formatBDT(loan.principalPaisa)}
                        </td>
                        <td className={`px-4 py-3 text-right font-extrabold tabular-nums ${loan.remainingPaisa > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          {formatBDT(loan.remainingPaisa)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setExpandedLoanId(expanded ? null : loan.id)}
                            className="inline-flex items-center gap-1 font-bold hover:underline text-left"
                          >
                            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                            {loan.status === 'active' ? (
                              <span className="text-amber-600">Active ({loan.repayments.length} paid)</span>
                            ) : (
                              <span className="text-emerald-600 inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Settled ({loan.repayments.length})
                              </span>
                            )}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            {loan.status === 'active' ? (canEdit ? (
                              <button
                                type="button"
                                onClick={() => openRepayModal(loan)}
                                className="h-8 px-3 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-brand-900 text-xs font-semibold"
                              >
                                Repay
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-400 mr-1">Active</span>
                            )) : (
                              <span className="text-[11px] text-slate-400 mr-1">Closed</span>
                            )}
                            {isAdmin && (
                              confirmDeleteLoanId === loan.id ? (
                                <div className="inline-flex items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={deletingKey === `loan:${loan.id}`}
                                    onClick={() => void handleDeleteLoan(loan)}
                                    className="h-7 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold disabled:opacity-50"
                                  >
                                    {deletingKey === `loan:${loan.id}` ? 'Deleting...' : 'Confirm'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteLoanId(null)}
                                    className="h-7 px-2 text-[11px] font-semibold text-slate-500 hover:text-slate-800"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteLoanId(loan.id)}
                                  title={`Delete ${loan.loanNo}`}
                                  aria-label={`Delete ${loan.loanNo}`}
                                  className="h-8 px-2.5 rounded-xl border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 text-xs font-semibold inline-flex items-center gap-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" /> Delete
                                </button>
                              )
                            )}
                          </div>
                        </td>
                      </tr>

                      {expanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={7} className="px-6 py-3">
                            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                              Repayment History for {loan.loanNo} ({loan.repayments.length})
                            </div>
                            {loan.repayments.length === 0 ? (
                              <div className="text-xs text-slate-400 py-1">No repayments recorded yet.</div>
                            ) : (
                              <div className="space-y-1.5">
                                {loan.repayments.map((rp) => (
                                  <div
                                    key={rp.id}
                                    className="rounded-xl bg-white border border-slate-100 px-3.5 py-2 flex flex-wrap items-center justify-between gap-3 text-xs"
                                  >
                                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                                      <span className="font-semibold text-[#1b2a4e] tabular-nums">{formatShortDate(rp.paidDate)}</span>
                                      <span className="text-slate-300">·</span>
                                      <span className="font-medium text-slate-700">
                                        {rp.source === 'historical'
                                          ? 'Historical adjustment'
                                          : rp.source === 'salary_deduction'
                                            ? 'Salary deduction'
                                            : 'Cash return'}
                                      </span>
                                      <span className="text-slate-300">·</span>
                                      <span className="text-slate-500">{rp.paymentMethod}</span>
                                      {rp.referenceNo && (
                                        <span className="font-mono text-slate-400">({rp.referenceNo})</span>
                                      )}
                                      {rp.note && <span className="text-slate-500 truncate">— {rp.note}</span>}
                                      {rp.receiptSha && (
                                        <a
                                          href={`/api/receipts/${rp.receiptSha}`}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-brand-700 hover:underline inline-flex items-center gap-0.5"
                                        >
                                          <Paperclip className="w-3 h-3" /> Receipt
                                        </a>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                      <span className="font-extrabold text-emerald-700 tabular-nums">-{formatBDT(rp.amountPaisa)}</span>
                                      {isAdmin && rp.source !== 'salary_deduction' && (
                                        confirmDeleteRepayId === rp.id ? (
                                          <div className="inline-flex items-center gap-1">
                                            <button
                                              type="button"
                                              disabled={deletingKey === `repay:${rp.id}`}
                                              onClick={() => void handleDeleteRepayment(loan, rp.id)}
                                              className="h-6 px-2 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold disabled:opacity-50"
                                            >
                                              {deletingKey === `repay:${rp.id}` ? '...' : 'Confirm'}
                                            </button>
                                            <button
                                              type="button"
                                              onClick={() => setConfirmDeleteRepayId(null)}
                                              className="h-6 px-1.5 text-[11px] text-slate-500 hover:text-slate-800"
                                            >
                                              Cancel
                                            </button>
                                          </div>
                                        ) : (
                                          <button
                                            type="button"
                                            onClick={() => setConfirmDeleteRepayId(rp.id)}
                                            className="h-6 px-2 rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50 text-[11px] font-semibold inline-flex items-center gap-1"
                                          >
                                            <Trash2 className="w-3 h-3" /> Delete
                                          </button>
                                        )
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      
      {issueOpen && (
        <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className={`text-base font-bold ${INK}`}>Issue Employee Loan / Advance</h2>
                <p className="text-xs text-slate-500">Each issue and cash repayment is linked to the Daily Ledger and its funding source.</p>
              </div>
              <button type="button" onClick={() => setIssueOpen(false)} className="w-8 h-8 rounded-full grid place-items-center text-slate-400 hover:bg-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleIssue} className="p-6 space-y-4 overflow-y-auto">
              {error && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700 font-medium">{error}</div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Employee *</label>
                  <select
                    value={empId}
                    onChange={(e) => setEmpId(e.target.value)}
                    required
                    className={fieldCls}
                  >
                    <option value="">Select employee</option>
                    {activeEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.code})</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Issue Date *</label>
                  <input type="date" required value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Loan Amount (৳) *</label>
                  <input type="text" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono tabular-nums`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Suggested Monthly Repayment (৳) <span className="font-normal text-slate-400">(optional)</span></label>
                  <input type="text" inputMode="decimal" value={installment} onChange={(e) => setInstallment(e.target.value)} placeholder="Optional, voluntary" className={`${fieldCls} font-mono tabular-nums`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Department *</label>
                  <select required value={issueDepartment} onChange={(e) => setIssueDepartment(e.target.value)} className={fieldCls}>
                    <option value="">Select department</option>
                    {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Office / Field (Optional)</label>
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
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Funding Source *</label>
                  <select required value={fundSourceId} onChange={(e) => setFundSourceId(e.target.value)} className={fieldCls}>
                    <option value="">Select fund source</option>
                    {fundSources.filter((source) => source.active).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Payment Method *</label>
                  <ComboInput
                    value={method}
                    onChange={setMethod}
                    options={methodOptions}
                    required
                    ariaLabel="Payment Method"
                    placeholder="Cash, bKash, Bank..."
                    className={fieldCls}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Slip / Ref #</label>
                  <input type="text" value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="Optional" className={`${fieldCls} font-mono`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Voucher Photo (Optional)</label>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setCameraTarget('issue')} className="h-10 px-3 rounded-xl border border-brand-200 bg-brand-50 text-xs font-semibold text-brand-900 inline-flex items-center gap-1">
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                    <label className="flex-1 h-10 px-3 flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 cursor-pointer text-xs text-slate-600">
                      <Paperclip className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                      <span className="truncate">{issueReceipt ? issueReceipt.name : 'Attach slip'}</span>
                      <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleFilePick('issue')} className="hidden" />
                    </label>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Purpose *</label>
                <input type="text" required value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Reason for loan or advance..." className={fieldCls} />
              </div>
              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setIssueOpen(false)} className="h-10 px-4 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
                <button type="submit" disabled={busy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-60">
                  {busy ? 'Issuing...' : 'Issue Loan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      
      {repayTarget && (
        <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h2 className={`text-base font-bold ${INK}`}>Loan Repayment · {repayTarget.loanNo}</h2>
                <p className="text-xs text-slate-500">{repayTarget.employeeName} · Remaining {formatBDT(repayTarget.remainingPaisa)}</p>
              </div>
              <button type="button" onClick={() => setRepayTarget(null)} className="w-8 h-8 rounded-full grid place-items-center text-slate-400 hover:bg-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleRepay} className="p-6 space-y-4 overflow-y-auto">
              {error && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700 font-medium">{error}</div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Return Amount (৳) *</label>
                  <input type="text" inputMode="decimal" required value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} className={`${fieldCls} font-mono tabular-nums`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Date *</label>
                  <input type="date" required value={repayDate} onChange={(e) => setRepayDate(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Department *</label>
                  <select required value={repayDepartment} onChange={(e) => setRepayDepartment(e.target.value)} className={fieldCls}>
                    <option value="">Select department</option>
                    {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Receiving Channel / Field *</label>
                  <ComboInput
                    value={repayHead}
                    onChange={setRepayHead}
                    options={incomeHeadOptions}
                    required
                    ariaLabel="Receiving Channel"
                    placeholder="Select or type channel"
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Receiving Fund Source *</label>
                  <select required value={repayFundSourceId} onChange={(e) => setRepayFundSourceId(e.target.value)} className={fieldCls}>
                    <option value="">Select fund source</option>
                    {fundSources.filter((source) => source.active).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Method *</label>
                  <ComboInput
                    value={repayMethod}
                    onChange={setRepayMethod}
                    options={methodOptions}
                    required
                    ariaLabel="Repayment Method"
                    placeholder="Cash, bKash, Bank..."
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Ref / Slip #</label>
                  <input type="text" value={repayRef} onChange={(e) => setRepayRef(e.target.value)} className={`${fieldCls} font-mono`} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Voucher Photo (Optional)</label>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setCameraTarget('repay')} className="h-10 px-3 rounded-xl border border-brand-200 bg-brand-50 text-xs font-semibold text-brand-900 inline-flex items-center gap-1">
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                    <label className="flex-1 h-10 px-3 flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 cursor-pointer text-xs text-slate-600">
                      <Paperclip className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                      <span className="truncate">{repayReceipt ? repayReceipt.name : 'Attach receipt'}</span>
                      <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handleFilePick('repay')} className="hidden" />
                    </label>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Note</label>
                <input type="text" value={repayNote} onChange={(e) => setRepayNote(e.target.value)} className={fieldCls} />
              </div>
              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setRepayTarget(null)} className="h-10 px-4 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
                <button type="submit" disabled={busy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-60">
                  {busy ? 'Saving...' : 'Confirm Repayment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CameraCaptureModal
        isOpen={cameraTarget !== null}
        onClose={() => setCameraTarget(null)}
        onCapture={(file) => {
          if (cameraTarget === 'issue') setIssueReceipt(file);
          else if (cameraTarget === 'repay') setRepayReceipt(file);
        }}
      />
    </div>
  );
};
