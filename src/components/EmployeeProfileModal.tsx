import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  Calendar,
  Edit3,
  Mail,
  Paperclip,
  Phone,
  User,
  Wallet,
  X,
} from 'lucide-react';
import type {
  Employee,
  EmployeeAdvance,
  EmployeeLoan,
  EmployeeSpendStat,
  LedgerTransaction,
  SalaryPayment,
} from '../types';
import { formatBDT } from '../utils/money';
import { formatShortDate } from '../utils/ledger';
import { ScrollLock } from './ScrollLock';
import { loadTransactions, type TransactionPage } from '../utils/cloud';

interface Props {
  employee: Employee | null;
  stat?: EmployeeSpendStat;
  salaries: SalaryPayment[];
  loans: EmployeeLoan[];
  advances: EmployeeAdvance[];
  isAdmin: boolean;
  onClose: () => void;
  onEditEmployee: (emp: Employee) => void;
  onOpenTx: (tx: LedgerTransaction) => void;
  onOpenTxId: (id: string) => void;
}

export const EmployeeProfileModal: React.FC<Props> = ({
  employee,
  stat,
  salaries,
  loans,
  advances,
  isAdmin,
  onClose,
  onEditEmployee,
  onOpenTx,
  onOpenTxId,
}) => {
  const [tab, setTab] = useState<'vouchers' | 'salaries' | 'loans'>('vouchers');

  const [linkedTxPage, setLinkedTxPage] = useState<TransactionPage | null>(null);
  const [linkedTxLoading, setLinkedTxLoading] = useState(false);

  useEffect(() => {
    let active = true;
    if (!employee) { setLinkedTxPage(null); return; }
    setLinkedTxLoading(true);
    loadTransactions({ employeeId: employee.id, limit: 50 })
      .then((page) => { if (active) setLinkedTxPage(page); })
      .catch(() => { if (active) setLinkedTxPage(null); })
      .finally(() => { if (active) setLinkedTxLoading(false); });
    return () => { active = false; };
  }, [employee?.id]);

  const linkedTx = linkedTxPage?.items || [];
  const loadMoreEmployeeTransactions = async () => {
    if (!employee || !linkedTxPage?.nextCursor || linkedTxLoading) return;
    setLinkedTxLoading(true);
    try {
      const next = await loadTransactions({ employeeId: employee.id, limit: 50, cursor: linkedTxPage.nextCursor });
      setLinkedTxPage((current) => current ? ({ ...next, items: [...current.items, ...next.items] }) : next);
    } finally {
      setLinkedTxLoading(false);
    }
  };

  const empSalaries = useMemo(
    () => (employee ? salaries.filter((s) => s.employeeId === employee.id) : []),
    [employee, salaries],
  );

  const empLoans = useMemo(
    () => (employee ? loans.filter((l) => l.employeeId === employee.id) : []),
    [employee, loans],
  );

  const empAdvances = useMemo(
    () => (employee ? advances.filter((advance) => advance.employeeId === employee.id) : []),
    [employee, advances],
  );

  if (!employee) return null;

  const initials = employee.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');

  const spendLabel =
    stat?.spendLevel === 'high'
      ? 'Above Team Average'
      : stat?.spendLevel === 'low'
        ? 'Below Team Average'
        : 'Within Average';

  const spendColor =
    stat?.spendLevel === 'high'
      ? 'text-rose-600'
      : stat?.spendLevel === 'low'
        ? 'text-emerald-600'
        : 'text-slate-600';

  return (
    <div className="no-print fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Employee profile ${employee.name}`}
        className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col"
      >
        
        <div className="shrink-0 px-6 py-5 border-b border-slate-100 flex flex-wrap items-center gap-4">
          {employee.photoUrl ? (
            <img
              src={employee.photoUrl}
              alt={employee.name}
              className="w-14 h-14 rounded-2xl object-cover border border-brand-200 shrink-0"
            />
          ) : (
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 text-white grid place-items-center font-display text-lg font-extrabold shrink-0">
              {initials || <User className="w-6 h-6" />}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-bold text-brand-700">{employee.code}</span>
              <span className="text-slate-300">·</span>
              <h2 className="text-lg font-extrabold text-[#1b2a4e] truncate">{employee.name}</h2>
              <span className="text-slate-300">·</span>
              <span className={`text-xs font-semibold ${employee.active ? 'text-emerald-600' : 'text-slate-400'}`}>
                {employee.active ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 mt-1">
              <span>{employee.role} · {employee.department}</span>
              <span className="inline-flex items-center gap-1">
                <Building2 className="w-3.5 h-3.5 text-slate-400" /> {employee.branch}
              </span>
              {employee.phone && (
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Phone className="w-3.5 h-3.5 text-slate-400" /> {employee.phone}
                </span>
              )}
              {employee.email && (
                <span className="inline-flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5 text-slate-400" /> {employee.email}
                </span>
              )}
              {employee.joinedDate && (
                <span className="inline-flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" /> Joined {formatShortDate(employee.joinedDate)}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                type="button"
                onClick={() => { onClose(); onEditEmployee(employee); }}
                className="h-9 px-3.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5"
              >
                <Edit3 className="w-3.5 h-3.5 text-brand-600" /> Edit Profile
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
          
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
              <div className="text-[11px] font-semibold text-slate-500">Monthly Base Salary</div>
              <div className="text-lg font-extrabold text-[#1b2a4e] tabular-nums mt-1">
                {formatBDT(employee.monthlySalaryPaisa)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                Paid total: {formatBDT(stat?.salaryPaisa || 0)}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
              <div className="text-[11px] font-semibold text-slate-500">Field / Expense Taken</div>
              <div className="text-lg font-extrabold text-[#1b2a4e] tabular-nums mt-1">
                {formatBDT(stat?.operationalTakenPaisa || 0)}
              </div>
              <div className={`text-[11px] font-semibold mt-0.5 ${spendColor}`}>
                {spendLabel} {stat?.avgOperationalPaisa ? `(Avg ${formatBDT(stat.avgOperationalPaisa)})` : ''}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
              <div className="text-[11px] font-semibold text-slate-500">Active Loan Balance</div>
              <div className={`text-lg font-extrabold tabular-nums mt-1 ${(stat?.activeLoanPaisa || 0) > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                {formatBDT(stat?.activeLoanPaisa || 0)}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                {empLoans.filter((l) => l.status === 'active').length} active · {empLoans.length} total
              </div>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
              <div className="text-[11px] font-semibold text-slate-500">Connected Vouchers</div>
              <div className="text-lg font-extrabold text-[#1b2a4e] tabular-nums mt-1">
                {linkedTx.length}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                {empSalaries.length} salary payouts logged
              </div>
            </div>
          </div>

          {employee.notes && (
            <div className="rounded-2xl border border-slate-100 bg-slate-50/40 px-4 py-3 text-xs text-slate-600">
              <span className="font-semibold text-[#1b2a4e]">Notes:</span> {employee.notes}
            </div>
          )}

          
          <div className="grid grid-cols-3 gap-2 p-1 rounded-2xl bg-slate-100">
            <button
              type="button"
              onClick={() => setTab('vouchers')}
              className={`h-9 rounded-xl text-xs font-bold transition-colors ${
                tab === 'vouchers' ? 'bg-white text-[#1b2a4e] shadow-xs' : 'text-slate-500 hover:text-[#1b2a4e]'
              }`}
            >
              Ledger Vouchers ({linkedTx.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('salaries')}
              className={`h-9 rounded-xl text-xs font-bold transition-colors ${
                tab === 'salaries' ? 'bg-white text-[#1b2a4e] shadow-xs' : 'text-slate-500 hover:text-[#1b2a4e]'
              }`}
            >
              Salary History ({empSalaries.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('loans')}
              className={`h-9 rounded-xl text-xs font-bold transition-colors ${
                tab === 'loans' ? 'bg-white text-[#1b2a4e] shadow-xs' : 'text-slate-500 hover:text-[#1b2a4e]'
              }`}
            >
              Loans &amp; Repayments ({empLoans.length})
            </button>
          </div>

          {tab === 'vouchers' && (
            <div className="rounded-2xl border border-slate-100 overflow-hidden">
              {linkedTx.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">{linkedTxLoading ? 'Loading employee transactions…' : 'No ledger transactions linked to this employee yet.'}</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5">Voucher &amp; Date</th>
                      <th className="px-4 py-2.5">Head &amp; Category</th>
                      <th className="px-4 py-2.5">Purpose</th>
                      <th className="px-4 py-2.5 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {linkedTx.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => onOpenTx(t)}
                        className="cursor-pointer hover:bg-slate-50/90 transition-colors"
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <div className="flex items-center gap-1.5 font-mono font-bold text-[#1b2a4e]">
                            {t.kind === 'income' ? (
                              <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <ArrowUpRight className="w-3.5 h-3.5 text-rose-500" />
                            )}
                            {t.voucherNo}
                          </div>
                          <div className="text-[11px] text-slate-400 pl-5 tabular-nums">{formatShortDate(t.txDate)}</div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="font-semibold text-[#1b2a4e]">{t.head}</div>
                          <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                            <span>{t.subCategory}</span>
                            {t.receiptSha && <Paperclip className="w-3 h-3 text-brand-600" />}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600 max-w-sm truncate">{t.purpose}</td>
                        <td className={`px-4 py-2.5 text-right font-extrabold tabular-nums whitespace-nowrap ${t.kind === 'income' ? 'text-brand-700' : 'text-rose-600'}`}>
                          {t.kind === 'income' ? '+' : '-'}{formatBDT(t.amountPaisa)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {linkedTxPage?.hasMore && (
                <div className="p-3 border-t border-slate-100 text-center">
                  <button type="button" onClick={() => void loadMoreEmployeeTransactions()} disabled={linkedTxLoading} className="text-xs font-semibold text-brand-700 hover:underline disabled:opacity-50">
                    {linkedTxLoading ? 'Loading…' : `Load more transactions (${linkedTx.length} of ${linkedTxPage.totalCount})`}
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'salaries' && (
            <div className="rounded-2xl border border-slate-100 overflow-hidden">
              {empSalaries.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">No salary payments recorded yet.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5">Month</th>
                      <th className="px-4 py-2.5">Paid Date &amp; Voucher</th>
                      <th className="px-4 py-2.5 text-right">Base + Bonus</th>
                      <th className="px-4 py-2.5 text-right">Deductions</th>
                      <th className="px-4 py-2.5 text-right">Net Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {empSalaries.map((s) => (
                      <tr key={s.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-2.5 font-mono font-bold text-[#1b2a4e]">{s.monthKey}</td>
                        <td className="px-4 py-2.5">
                          <div className="text-[#1b2a4e] font-medium tabular-nums">
                            {formatShortDate(s.paidDate)}
                            {s.department ? <span className="text-slate-400 font-normal"> · {s.department}</span> : null}
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono flex items-center gap-2">
                            <span>{s.linkedVoucherNo || s.referenceNo || s.paymentMethod}</span>
                            {s.receiptSha && (
                              <a
                                href={`/api/receipts/${s.receiptSha}`}
                                target="_blank"
                                rel="noreferrer"
                                className="font-sans text-brand-700 hover:underline inline-flex items-center gap-0.5"
                              >
                                <Paperclip className="w-3 h-3" /> Slip
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">
                          {formatBDT(s.baseSalaryPaisa + s.bonusPaisa)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">
                          {formatBDT(s.loanDeductionPaisa + s.advanceDeductionPaisa + s.otherDeductionPaisa)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-extrabold tabular-nums text-brand-700">
                          {formatBDT(s.netPaidPaisa)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'loans' && (
            <div className="space-y-4">
              {empLoans.length === 0 && empAdvances.length === 0 ? (
                <div className="rounded-2xl border border-slate-100 p-8 text-center text-xs text-slate-400">
                  No loans or advances issued to this employee.
                </div>
              ) : (
                <>
                  {empAdvances.map((advance) => {
                    const tx = linkedTx.find((item) => item.id === advance.linkedTxId);
                    return (
                      <div key={advance.id} className="rounded-2xl border border-slate-100 p-4 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Wallet className="w-4 h-4 text-amber-600" />
                            <span className="font-mono font-bold text-xs text-[#1b2a4e]">{advance.advanceNo}</span>
                            <span className="text-slate-300">·</span>
                            <span className="text-xs text-slate-500">{formatShortDate(advance.issuedDate)}</span>
                            <span className="text-slate-300">·</span>
                            <span className={`text-xs font-bold ${advance.status === 'active' ? 'text-amber-600' : 'text-emerald-600'}`}>
                              {advance.status === 'active' ? 'Outstanding' : 'Settled'}
                            </span>
                          </div>
                          <div className="text-xs font-extrabold tabular-nums text-[#1b2a4e]">
                            Remaining: {formatBDT(advance.remainingPaisa)} / {formatBDT(advance.principalPaisa)}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                          <span>{advance.purpose} · Fund: {advance.fundSourceName || 'Legacy Unassigned'}</span>
                          {advance.linkedTxId && <button type="button" onClick={() => tx ? onOpenTx(tx) : onOpenTxId(advance.linkedTxId)} className="font-semibold text-brand-700 hover:underline">Open ledger entry</button>}
                        </div>
                        {advance.repayments.length > 0 && (
                          <div className="space-y-1 border-t border-slate-100 pt-2">
                            {advance.repayments.map((repayment) => (
                              <div key={repayment.id} className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                                <span>{formatShortDate(repayment.paidDate)} · Salary recovery</span>
                                <span className="font-bold tabular-nums text-emerald-700">-{formatBDT(repayment.amountPaisa)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {empLoans.map((l) => (
                    <div key={l.id} className="rounded-2xl border border-slate-100 p-4 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Wallet className="w-4 h-4 text-brand-600" />
                          <span className="font-mono font-bold text-xs text-[#1b2a4e]">{l.loanNo}</span>
                          <span className="text-slate-300">·</span>
                          <span className="text-xs text-slate-500">{formatShortDate(l.issuedDate)}</span>
                          <span className="text-slate-300">·</span>
                          <span className={`text-xs font-bold ${l.status === 'active' ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {l.status === 'active' ? 'Active' : 'Settled'}
                          </span>
                        </div>
                        <div className="text-xs font-extrabold tabular-nums text-[#1b2a4e]">
                          Remaining: {formatBDT(l.remainingPaisa)} / {formatBDT(l.principalPaisa)}
                        </div>
                      </div>
                      <div className="text-xs text-slate-600 flex flex-wrap items-center gap-2">
                        <span>{l.purpose}</span>
                        {l.receiptSha && (
                          <a
                            href={`/api/receipts/${l.receiptSha}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-700 hover:underline inline-flex items-center gap-0.5 font-medium"
                          >
                            <Paperclip className="w-3 h-3" /> Receipt
                          </a>
                        )}
                        {l.linkedTxId && (
                          <button type="button" onClick={() => { const linkedTxId = l.linkedTxId; if (!linkedTxId) return; const linked = linkedTx.find((item) => item.id === linkedTxId); linked ? onOpenTx(linked) : onOpenTxId(linkedTxId); }} className="font-semibold text-brand-700 hover:underline">Open ledger entry</button>
                        )}
                      </div>
                      {l.repayments.length > 0 && (
                        <div className="pt-2 border-t border-slate-100 space-y-1">
                          {l.repayments.map((rp) => (
                            <div key={rp.id} className="flex items-center justify-between text-[11px] text-slate-500 gap-2">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <span>
                                  {formatShortDate(rp.paidDate)} · {rp.source === 'historical' ? 'Historical adjustment' : rp.source === 'salary_deduction' ? 'Salary deduction' : 'Cash return'}
                                  {rp.linkedVoucherNo ? ` (${rp.linkedVoucherNo})` : rp.referenceNo ? ` (${rp.referenceNo})` : ''}
                                </span>
                                {rp.receiptSha && (
                                  <a
                                    href={`/api/receipts/${rp.receiptSha}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-brand-700 hover:underline inline-flex items-center gap-0.5"
                                  >
                                    <Paperclip className="w-3 h-3" /> Slip
                                  </a>
                                )}
                              </span>
                              <span className="font-bold text-emerald-700 tabular-nums">-{formatBDT(rp.amountPaisa)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
