import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Clock,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import type {
  ChainVerificationResult,
  Employee,
  EmployeeSpendStat,
  EmployeeLoan,
  LedgerTransaction,
} from '../types';
import {
  addDays,
  dhakaMonth,
  dhakaToday,
  formatShortDate,
  monthRangeOf,
  weekRangeOf,
  yearRangeOf,
} from '../utils/ledger';
import { formatBDT } from '../utils/money';
import { loadEmployeeSpendStats, loadPeriodSummary, loadTransactions, type PeriodSummaryResponse } from '../utils/cloud';
import { DateRangeButton, dateRangeLabel } from './DateRangeButton';

interface Props {
  loans: EmployeeLoan[];
  verification: ChainVerificationResult | null;
  userName: string;
  onOpenTx: (tx: LedgerTransaction) => void;
  onOpenEmployee: (emp: Employee) => void;
  onGoSheet: () => void;
  onGoLedger: () => void;
  onGoEmployees: () => void;
  onGoLoans: () => void;
  onGoAudit: () => void;
}

type Tone = 'plain' | 'good' | 'warn' | 'bad';

const TONE: Record<Tone, { icon: string; halo: string; value: string; bar: string }> = {
  plain: { icon: 'from-brand-400 to-brand-700 shadow-brand-600/30', halo: 'from-brand-50', value: 'text-brand-700', bar: 'from-brand-400 to-brand-600' },
  good: { icon: 'from-teal-400 to-emerald-600 shadow-emerald-600/30', halo: 'from-emerald-50', value: 'text-emerald-600', bar: 'from-teal-400 to-emerald-500' },
  warn: { icon: 'from-amber-300 to-orange-500 shadow-orange-500/30', halo: 'from-amber-50', value: 'text-amber-600', bar: 'from-amber-300 to-orange-500' },
  bad: { icon: 'from-orange-400 to-rose-600 shadow-rose-600/30', halo: 'from-rose-50', value: 'text-rose-600', bar: 'from-orange-400 to-rose-500' },
};

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';
const NUM = 'tabular-nums';
const PANEL_H = 'h-[26rem] @6xl:h-[calc(50vh-4rem)] @6xl:min-h-[22rem]';

const Card: React.FC<{
  label: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  tone?: Tone;
  progress?: number;
  onClick?: () => void;
}> = ({ label, value, sub, icon: Icon, tone = 'plain', progress, onClick }) => {
  const t = TONE[tone];
  const pct = progress === undefined ? undefined : Math.max(0, Math.min(100, progress));
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`@container group relative overflow-hidden text-left ${SURFACE} p-4 flex flex-col h-full min-h-[8.5rem] transition-[transform,box-shadow] duration-200 ${
        onClick ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-14px_rgba(30,50,110,0.3)]' : 'cursor-default'
      }`}
    >
      <span className={`absolute inset-x-0 top-0 h-28 bg-gradient-to-b ${t.halo} to-transparent`} aria-hidden />
      <span className="relative flex items-start justify-between gap-3">
        <span className={`min-w-0 pt-0.5 text-[14px] leading-snug font-semibold ${INK}`}>{label}</span>
        <span className={`grid place-items-center w-10 h-10 rounded-2xl bg-gradient-to-br ${t.icon} text-white shadow-lg shrink-0`}>
          <Icon className="w-[18px] h-[18px]" />
        </span>
      </span>
      {/* The amount gets the full card width on its own line and scales with the card, so it can never be clipped. */}
      <span
        className={`relative mt-2 block whitespace-nowrap leading-none font-extrabold font-display proportional-nums ${t.value}`}
        style={{ fontSize: 'clamp(1.25rem, 11cqw, 1.875rem)' }}
      >
        {value}
      </span>
      <span className="relative mt-2 block min-h-4 text-[11.5px] text-slate-400 truncate">{sub}</span>
      <span className="relative mt-auto pt-3 block">
        <span className={`block h-1.5 rounded-full overflow-hidden ${pct === undefined ? 'bg-transparent' : 'bg-slate-100'}`}>
          {pct !== undefined && <span className={`block h-full rounded-full bg-gradient-to-r ${t.bar}`} style={{ width: `${pct}%` }} />}
        </span>
      </span>
    </button>
  );
};

const PanelHead: React.FC<{ title: string; icon: React.ElementType; right?: React.ReactNode; onRightClick?: () => void }> = ({
  title,
  icon: Icon,
  right,
  onRightClick,
}) => (
  <h2 className={`shrink-0 px-4 pt-3 pb-2.5 flex items-center gap-2.5 text-[15px] font-bold border-b border-slate-100 mb-1 ${INK}`}>
    <span className="grid place-items-center w-8 h-8 rounded-xl bg-brand-50 text-brand-700 shrink-0"><Icon className="w-4 h-4" /></span>
    <span className="truncate">{title}</span>
    {right !== undefined && (
      onRightClick ? (
        <button type="button" onClick={onRightClick} className={`ml-auto shrink-0 text-xs font-semibold text-brand-700 hover:underline ${NUM}`}>
          {right}
        </button>
      ) : (
        <span className={`ml-auto shrink-0 text-xs font-semibold text-brand-700 ${NUM}`}>{right}</span>
      )
    )}
  </h2>
);

export const Dashboard: React.FC<Props> = ({
  loans,
  verification,
  userName,
  onOpenTx,
  onOpenEmployee,
  onGoSheet,
  onGoLedger,
  onGoEmployees,
  onGoLoans,
  onGoAudit,
}) => {
  const [period, setPeriod] = useState<{ from: string; to: string }>(() => {
    const r = monthRangeOf(dhakaMonth());
    return { from: r.from, to: r.to };
  });

  const range = useMemo(() => {
    const y = period.from.slice(0, 4);
    const wholeYear = period.from === `${y}-01-01` && period.to === `${y}-12-31`;
    return { from: period.from, to: period.to, label: wholeYear ? `Year ${y}` : dateRangeLabel(period.from, period.to) };
  }, [period]);

  // Quick periods shown beside the welcome message; the calendar button covers any other day, range or month.
  const presets = useMemo(() => {
    const today = dhakaToday();
    const thisMonth = today.slice(0, 7);
    const [y, m] = thisMonth.split('-').map(Number);
    const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const yesterday = addDays(today, -1);
    const week = weekRangeOf(today);
    const month = monthRangeOf(thisMonth);
    const prev = monthRangeOf(lastMonth);
    const year = yearRangeOf(String(y));
    return [
      { id: 'today', label: 'Today', from: today, to: today, wideOnly: false },
      { id: 'yesterday', label: 'Yesterday', from: yesterday, to: yesterday, wideOnly: true },
      { id: 'week', label: 'This week', from: week.from, to: week.to, wideOnly: false },
      { id: 'month', label: 'This month', from: month.from, to: month.to, wideOnly: false },
      { id: 'last', label: 'Last month', from: prev.from, to: prev.to, wideOnly: false },
      { id: 'year', label: 'This year', from: year.from, to: year.to, wideOnly: true },
    ];
  }, []);

  const [summaryData, setSummaryData] = useState<PeriodSummaryResponse | null>(null);
  const [empStats, setEmpStats] = useState<EmployeeSpendStat[]>([]);
  const [editedOrFlagged, setEditedOrFlagged] = useState<LedgerTransaction[]>([]);

  useEffect(() => {
    let active = true;
    Promise.all([
      loadPeriodSummary(range.from, range.to, range.label),
      loadEmployeeSpendStats(range.from, range.to),
      loadTransactions({ limit: 6, auditFilter: 'flagged_or_changed' }),
    ]).then(([summaryResult, statsResult, flaggedResult]) => {
      if (!active) return;
      setSummaryData(summaryResult);
      setEmpStats(statsResult);
      setEditedOrFlagged(flaggedResult.items);
    }).catch(() => {
      if (!active) return;
      setSummaryData(null);
      setEmpStats([]);
      setEditedOrFlagged([]);
    });
    return () => { active = false; };
  }, [range.from, range.to, range.label]);

  const summary = useMemo<PeriodSummaryResponse>(() => summaryData || ({
    from: range.from, to: range.to, label: range.label,
    openingBalancePaisa: 0, periodIncomePaisa: 0, totalAvailablePaisa: 0,
    periodExpensePaisa: 0, closingBalancePaisa: 0, incomeByHead: [], expenseByHead: [],
    periodTransactions: [], periodTransactionCount: 0, periodExpenseCount: 0, incomeCount: 0, expenseCount: 0,
  }), [summaryData, range]);

  const activeLoans = useMemo(() => loans.filter((l) => l.status === 'active'), [loans]);

  const topExpenses = useMemo(
    () => [...summary.expenseByHead].filter((e) => e.totalPaisa > 0).sort((a, b) => b.totalPaisa - a.totalPaisa).slice(0, 8),
    [summary.expenseByHead],
  );

  const spendRatio = summary.totalAvailablePaisa > 0
    ? Math.round((summary.periodExpensePaisa / summary.totalAvailablePaisa) * 100)
    : 0;

  return (
    <div className="w-full px-2 @md:px-3 py-3 space-y-3">
      <div className="flex flex-wrap @5xl:flex-nowrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 @5xl:flex-1">
          <h1 className={`font-display text-2xl @7xl:text-[28px] font-extrabold tracking-tight whitespace-nowrap ${INK}`}>
            Welcome back, {userName}
          </h1>
          <p className="text-sm text-slate-500 @5xl:truncate">
            Pace IT income, expenses, employee payroll, loans, and ledger audit in one place.
          </p>
        </div>

        <div className="flex flex-wrap @5xl:flex-nowrap items-center gap-1.5 shrink-0">
          {presets.map((p) => {
            const on = period.from === p.from && period.to === p.to;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod({ from: p.from, to: p.to })}
                aria-pressed={on}
                className={`h-8 px-2.5 rounded-lg border text-xs font-semibold whitespace-nowrap transition-colors ${p.wideOnly ? 'hidden @7xl:inline-block' : ''} ${
                  on
                    ? 'border-brand-200 bg-brand-50 text-brand-900'
                    : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-600 hover:text-slate-900'
                }`}
              >
                {p.label}
              </button>
            );
          })}
          <DateRangeButton
            from={period.from}
            to={period.to}
            hideAllDates
            onChange={(f, t) => { if (f && t) setPeriod({ from: f, to: t }); }}
            className="h-8 w-full min-w-0 px-2.5 text-xs font-semibold text-[#1b2a4e] bg-white border border-slate-200 rounded-lg focus:outline-none"
            wrapperClassName="w-44 shrink-0"
          />
          <button
            type="button"
            onClick={onGoLedger}
            className="h-8 px-3 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap shadow-sm transition-colors"
          >
            Open Daily Ledger <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      
      <div className="grid grid-cols-1 @md:grid-cols-2 @5xl:grid-cols-4 gap-3">
        <Card
          label="Previous Balance (Opening)"
          value={formatBDT(summary.openingBalancePaisa)}
          sub={`Carried forward before ${range.from}`}
          icon={Wallet}
          tone="plain"
          onClick={onGoSheet}
        />
        <Card
          label="Money Received (Income)"
          value={formatBDT(summary.periodIncomePaisa)}
          sub={`Total available: ${formatBDT(summary.totalAvailablePaisa)}`}
          icon={ArrowDownLeft}
          tone="good"
          progress={summary.totalAvailablePaisa > 0 ? 100 : 0}
          onClick={onGoSheet}
        />
        <Card
          label="Money Spent (Expense)"
          value={formatBDT(summary.periodExpensePaisa)}
          sub={`${spendRatio}% of available funds spent`}
          icon={ArrowUpRight}
          tone="warn"
          progress={Math.min(100, spendRatio)}
          onClick={onGoSheet}
        />
        <Card
          label="Cash in Hand (Closing)"
          value={formatBDT(summary.closingBalancePaisa)}
          sub={summary.closingBalancePaisa < 0 ? 'Deficit — check inflows & edits' : 'Verified closing balance'}
          icon={ShieldCheck}
          tone={summary.closingBalancePaisa < 0 ? 'bad' : 'good'}
          onClick={onGoSheet}
        />
      </div>

      
      <div className="grid grid-cols-1 @4xl:grid-cols-2 gap-3">
        
        <section className={`${SURFACE} overflow-hidden flex flex-col ${PANEL_H}`}>
          <PanelHead
            title={`Employee Money Watch (${range.label})`}
            icon={Users}
            right="View All Staff →"
            onRightClick={onGoEmployees}
          />
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
            {empStats.length === 0 ? (
              <div className="h-full grid place-items-center text-xs text-slate-400 px-4 text-center">
                No employees added yet. Add employees to track salaries, advances, and spend comparisons.
              </div>
            ) : (
              empStats.slice(0, 8).map((s) => {
                const tagColor =
                  s.spendLevel === 'high'
                    ? 'text-rose-600'
                    : s.spendLevel === 'low'
                      ? 'text-emerald-600'
                      : 'text-slate-400';
                const tagText =
                  s.spendLevel === 'high'
                    ? 'High Spend'
                    : s.spendLevel === 'low'
                      ? 'Low Spend'
                      : 'Normal';
                return (
                  <button
                    key={s.employee.id}
                    type="button"
                    onClick={() => onOpenEmployee(s.employee)}
                    className="w-full text-left px-2.5 py-2 rounded-2xl hover:bg-slate-50 transition-colors flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[13px]">
                        <span className={`font-bold truncate ${INK}`}>{s.employee.name}</span>
                        <span className={`text-[11px] font-bold ${tagColor}`}>· {tagText}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {s.employee.branch} · Salary {formatBDT(s.salaryPaisa)}
                        {s.activeLoanPaisa > 0 ? ` · Loan ${formatBDT(s.activeLoanPaisa)}` : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`text-[13px] font-extrabold ${NUM} ${INK}`}>{formatBDT(s.operationalTakenPaisa)}</div>
                      <div className="text-[10.5px] text-slate-400">Operational Spend</div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        
        <section className={`${SURFACE} overflow-hidden flex flex-col ${PANEL_H}`}>
          <PanelHead
            title={`Expenses by Office / Head (${range.label})`}
            icon={ArrowUpRight}
            right={`${summary.periodExpenseCount} tx · Sheet →`}
            onRightClick={onGoSheet}
          />
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
            {topExpenses.length === 0 ? (
              <div className="h-full grid place-items-center text-xs text-slate-400 px-4 text-center">
                No expenses recorded for {range.label}.
              </div>
            ) : (
              topExpenses.map((e) => {
                const pct = summary.periodExpensePaisa > 0 ? Math.round((e.totalPaisa / summary.periodExpensePaisa) * 100) : 0;
                return (
                  <button
                    key={e.head}
                    type="button"
                    onClick={onGoSheet}
                    className="w-full text-left px-2.5 py-1.5 rounded-2xl hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 text-[13px]">
                      <span className={`font-semibold truncate ${INK}`}>{e.head}</span>
                      <span className={`font-bold ${NUM} text-[#1b2a4e]`}>{formatBDT(e.totalPaisa)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600" style={{ width: `${pct}%` }} />
                      </div>
                      <span className={`w-9 text-right text-[11px] text-slate-400 ${NUM}`}>{pct}%</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>
      </div>

      
      <div className="grid grid-cols-1 @4xl:grid-cols-2 gap-3">
        
        <section className={`${SURFACE} overflow-hidden flex flex-col ${PANEL_H}`}>
          <PanelHead
            title="Active Loans & Audit"
            icon={AlertTriangle}
            right={verification?.ok === false ? 'Integrity Alert' : verification?.ok === true ? `${verification.totalEntries} blocks verified` : 'Not verified'}
            onRightClick={onGoAudit}
          />
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
            {activeLoans.slice(0, 4).map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={onGoLoans}
                className="w-full text-left rounded-2xl bg-slate-50/80 border border-slate-100 px-3.5 py-2.5 flex items-center gap-3 hover:bg-slate-50 transition-colors"
              >
                <Wallet className="w-4 h-4 text-brand-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-bold truncate ${INK}`}>
                    {l.loanNo} · {l.employeeName} · Remaining {formatBDT(l.remainingPaisa)}
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">{l.purpose}</div>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>
            ))}

            {editedOrFlagged.map((tx) => (
              <button
                key={tx.id}
                type="button"
                onClick={() => onOpenTx(tx)}
                className="w-full text-left rounded-2xl bg-rose-50/60 border border-rose-100 px-3.5 py-2.5 flex items-center gap-3 hover:bg-rose-50 transition-colors"
              >
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-bold truncate ${INK}`}>
                    {tx.voucherNo} · {formatBDT(tx.amountPaisa)} ({tx.status === 'flagged' ? 'Flagged' : 'Edited'})
                  </div>
                  <div className="text-[11px] text-slate-500 truncate">{tx.lastEditReason || tx.flagNote || tx.purpose}</div>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>
            ))}

            {activeLoans.length === 0 && editedOrFlagged.length === 0 && (
              <div className="h-full grid place-items-center text-xs text-slate-400 px-4 text-center">
                No active loans or flagged entries.
              </div>
            )}
          </div>
        </section>

        
        <section className={`${SURFACE} overflow-hidden flex flex-col ${PANEL_H}`}>
          <PanelHead
            title="Recent Daily Entries"
            icon={Clock}
            right="Daily Ledger →"
            onRightClick={onGoLedger}
          />
          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
            {summary.periodTransactions.length === 0 ? (
              <div className="h-full grid place-items-center text-xs text-slate-400 px-4 text-center">
                No vouchers recorded for {range.label}.
              </div>
            ) : (
              summary.periodTransactions.slice(0, 10).map((tx) => (
                <button
                  key={tx.id}
                  type="button"
                  onClick={() => onOpenTx(tx)}
                  className="w-full text-left px-2.5 py-1.5 rounded-2xl hover:bg-slate-50 transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-mono font-bold ${INK}`}>{tx.voucherNo}</span>
                      <span className="text-slate-300">·</span>
                      <span className="font-semibold text-slate-600 truncate">{tx.counterparty}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 truncate mt-0.5">
                      {formatShortDate(tx.txDate)} · {tx.head} · {tx.purpose}
                    </div>
                  </div>
                  <div className={`text-xs font-extrabold ${NUM} shrink-0 ${tx.kind === 'income' ? 'text-brand-700' : 'text-rose-600'}`}>
                    {tx.kind === 'income' ? '+' : '-'}{formatBDT(tx.amountPaisa)}
                  </div>
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
