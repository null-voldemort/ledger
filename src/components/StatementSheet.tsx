import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowUpDown,
  Copy,
  Download,
  Edit3,
  FilterX,
  Lock,
  Plus,
  Printer,
  Search,
  Wallet,
  Landmark,
  ShieldCheck,
} from 'lucide-react';
import type { LedgerHead, LedgerKind, LedgerTransaction, PeriodLock } from '../types';
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
import { exportStatementPdf } from '../utils/exportLedger';
import { downloadStatementExcel, downloadTransactionCsv, lockPeriod, loadPeriodSummary, loadTransactions, type PeriodSummaryResponse, type TransactionPage, type TransactionSort } from '../utils/cloud';
import { DateRangeButton, dateRangeLabel } from './DateRangeButton';
import { FilterSelect, type FilterOption } from './FilterSelect';

interface Props {
  transactions: LedgerTransaction[];
  heads: LedgerHead[];
  locks: PeriodLock[];
  isAdmin: boolean;
  userName?: string;
  onOpenTx: (tx: LedgerTransaction) => void;
  onAddTx?: (kind: LedgerKind, head?: string) => void;
  onEditTx?: (tx: LedgerTransaction) => void;
  onDuplicateTx?: (tx: LedgerTransaction) => void;
  onLocksChanged: () => void;
  onToast: (msg: string) => void;
}

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';

const SORT_OPTIONS: FilterOption[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'amount_desc', label: 'Amount: high → low' },
  { value: 'amount_asc', label: 'Amount: low → high' },
  { value: 'party_asc', label: 'Party: A → Z' },
  { value: 'party_desc', label: 'Party: Z → A' },
  { value: 'department_asc', label: 'Department: A → Z' },
  { value: 'voucher_desc', label: 'Voucher #: high → low' },
  { value: 'voucher_asc', label: 'Voucher #: low → high' },
];

// Both statement panels share these columns, so every row, header and total lines up across the two sides.
const COLS = 'grid grid-cols-[minmax(0,1fr)_4rem_8.5rem] items-center gap-3 px-4';

// One shared control size for the whole filter panel, identical to the Daily Ledger's.
const CTL =
  'h-8 w-full min-w-0 px-2.5 text-[11px] font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500';

export const StatementSheet: React.FC<Props> = ({
  transactions,
  heads,
  locks,
  isAdmin,
  userName,
  onOpenTx,
  onAddTx,
  onEditTx,
  onDuplicateTx,
  onLocksChanged,
  onToast,
}) => {
  const [period, setPeriod] = useState<{ from: string; to: string }>(() => {
    const r = monthRangeOf(dhakaMonth());
    return { from: r.from, to: r.to };
  });
  const [selectedBucket, setSelectedBucket] = useState<{ kind: LedgerKind; head: string } | null>(null);
  const [drillSearch, setDrillSearch] = useState('');
  const [sortKey, setSortKey] = useState<TransactionSort>('newest');
  const [locking, setLocking] = useState(false);

  // A period that is exactly one calendar month can be signed off and locked.
  const monthKey = useMemo(() => {
    const ym = period.from.slice(0, 7);
    const r = monthRangeOf(ym);
    return r.from === period.from && r.to === period.to ? ym : '';
  }, [period]);

  const range = useMemo(() => {
    const y = period.from.slice(0, 4);
    const label = monthKey
      ? monthRangeOf(monthKey).label
      : period.from === `${y}-01-01` && period.to === `${y}-12-31`
        ? yearRangeOf(y).label
        : dateRangeLabel(period.from, period.to);
    return { from: period.from, to: period.to, label };
  }, [period, monthKey]);

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
      { id: 'today', label: 'Today', from: today, to: today },
      { id: 'yesterday', label: 'Yesterday', from: yesterday, to: yesterday },
      { id: 'week', label: 'This week', from: week.from, to: week.to },
      { id: 'month', label: 'This month', from: month.from, to: month.to },
      { id: 'last', label: 'Last month', from: prev.from, to: prev.to },
      { id: 'year', label: 'This year', from: year.from, to: year.to },
    ];
  }, []);

  const filtersActive = selectedBucket !== null || drillSearch.trim() !== '' || sortKey !== 'newest';
  const clearFilters = () => { setSelectedBucket(null); setDrillSearch(''); setSortKey('newest'); };

  const [summaryData, setSummaryData] = useState<PeriodSummaryResponse | null>(null);
  const [transactionPage, setTransactionPage] = useState<TransactionPage | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    loadPeriodSummary(range.from, range.to, range.label)
      .then((summaryResult) => { if (active) setSummaryData(summaryResult); })
      .catch(() => { if (active) setSummaryData(null); });
    return () => { active = false; };
  }, [range.from, range.to, range.label]);

  useEffect(() => {
    let active = true;
    setLoadingRows(true);
    loadTransactions({
      from: range.from,
      to: range.to,
      limit: 50,
      kind: selectedBucket?.kind || 'all',
      head: selectedBucket?.head,
      search: drillSearch.trim(),
      sort: sortKey,
    }).then((page) => { if (active) setTransactionPage(page); })
      .catch(() => { if (active) setTransactionPage(null); })
      .finally(() => { if (active) setLoadingRows(false); });
    return () => { active = false; };
  }, [range.from, range.to, selectedBucket, drillSearch, sortKey]);

  const summary = useMemo<PeriodSummaryResponse>(() => summaryData || ({
    from: range.from, to: range.to, label: range.label,
    openingBalancePaisa: 0, periodIncomePaisa: 0, totalAvailablePaisa: 0,
    periodExpensePaisa: 0, closingBalancePaisa: 0, incomeByHead: [], expenseByHead: [],
    periodTransactions: [], periodTransactionCount: 0, periodExpenseCount: 0, incomeCount: 0, expenseCount: 0,
  }), [summaryData, range]);

  const activeLock = useMemo(
    () => (monthKey ? locks.find((l) => l.periodKey === monthKey) : undefined),
    [locks, monthKey],
  );

  const drillTransactions = transactionPage?.items || [];

  const loadMoreRows = async () => {
    if (!transactionPage?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await loadTransactions({
        from: range.from, to: range.to, limit: 50,
        kind: selectedBucket?.kind || 'all', head: selectedBucket?.head,
        search: drillSearch.trim(), sort: sortKey, cursor: transactionPage.nextCursor,
      });
      setTransactionPage((current) => current ? ({ ...next, items: [...current.items, ...next.items] }) : next);
    } catch (error: any) {
      onToast(error?.message || 'Could not load more transactions');
    } finally {
      setLoadingMore(false);
    }
  };

  const [exportingPdf, setExportingPdf] = useState(false);

  const exportFullSummary = async (format: 'excel' | 'pdf') => {
    try {
      if (format === 'excel') {
        downloadStatementExcel(range.from, range.to, range.label);
        return;
      }
      setExportingPdf(true);
      await exportStatementPdf(summary, { generatedBy: userName, lock: activeLock });
    } catch (error: any) {
      onToast(error?.message || 'Could not prepare the statement export');
    } finally {
      setExportingPdf(false);
    }
  };

  const exportItemizedCsv = () => {
    try {
      downloadTransactionCsv({ from: range.from, to: range.to }, `Statement-${range.from}-to-${range.to}`);
    } catch (error: any) {
      onToast(error?.message || 'Could not start the itemized export');
    }
  };

  const handleLockMonth = async () => {
    if (!monthKey) return;
    setLocking(true);
    try {
      await lockPeriod(monthKey, `Signed off monthly statement for ${summary.label}`);
      onLocksChanged();
      onToast(`${summary.label} signed off & locked`);
    } catch (e: any) {
      onToast(e?.message || 'Could not lock period');
    } finally {
      setLocking(false);
    }
  };

  const kpis: { label: string; value: number; Icon: React.ElementType; tone: string; icon: string }[] = [
    { label: 'Previous Balance', value: summary.openingBalancePaisa, Icon: Wallet, tone: 'text-brand-700', icon: 'from-brand-400 to-brand-700 shadow-brand-600/30' },
    { label: 'Period Income', value: summary.periodIncomePaisa, Icon: ArrowDownLeft, tone: 'text-emerald-600', icon: 'from-teal-400 to-emerald-600 shadow-emerald-600/30' },
    { label: 'Total Available', value: summary.totalAvailablePaisa, Icon: Landmark, tone: 'text-brand-700', icon: 'from-brand-400 to-brand-700 shadow-brand-600/30' },
    { label: 'Total Expense', value: summary.periodExpensePaisa, Icon: ArrowUpRight, tone: 'text-amber-600', icon: 'from-amber-300 to-orange-500 shadow-orange-500/30' },
    { label: 'Closing Balance', value: summary.closingBalancePaisa, Icon: ShieldCheck, tone: summary.closingBalancePaisa < 0 ? 'text-rose-600' : 'text-emerald-600', icon: summary.closingBalancePaisa < 0 ? 'from-orange-400 to-rose-600 shadow-rose-600/30' : 'from-teal-400 to-emerald-600 shadow-emerald-600/30' },
  ];

  const actionBtn = 'h-8 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5 transition-colors';

  // One side of the statement. Both sides use the same component, so they are always identical in structure.
  const StatementPanel = ({ side }: { side: 'income' | 'expense' }) => {
    const income = side === 'income';
    const rows = income ? summary.incomeByHead : summary.expenseByHead;
    const subtotal = income ? summary.totalAvailablePaisa : summary.periodExpensePaisa + summary.closingBalancePaisa;
    const count = income ? summary.incomeCount : summary.expenseCount;
    return (
      <section className={`${SURFACE} overflow-hidden flex flex-col`}>
        <div className="flex items-center gap-2.5 px-4 pt-3 pb-2.5 border-b border-slate-100">
          <span className={`grid place-items-center w-8 h-8 rounded-xl shrink-0 ${income ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {income ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
          </span>
          <h2 className={`text-[15px] font-bold ${INK}`}>{income ? 'Income' : 'Expense'}</h2>
          {onAddTx && (
            <button
              type="button"
              onClick={() => onAddTx(side)}
              className="no-print ml-auto h-8 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1 transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-brand-600" /> Add
            </button>
          )}
        </div>

        <div className={`${COLS} py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-bold uppercase tracking-wider text-slate-500`}>
          <span>{income ? 'Channel / Details' : 'Office / Details'}</span>
          <span className="text-center">Entries</span>
          <span className="text-right">Amount</span>
        </div>

        <div className="flex-1 divide-y divide-slate-100">
          {income && (
            <div className={`${COLS} min-h-[2.75rem] bg-slate-50/50`}>
              <span className={`text-sm font-semibold ${INK}`}>Previous Period (Opening)</span>
              <span className="text-center text-xs text-slate-400">Carry-fwd</span>
              <span className={`text-right text-sm font-bold tabular-nums ${INK}`}>{formatBDT(summary.openingBalancePaisa)}</span>
            </div>
          )}
          {rows.map((row) => {
            const selected = selectedBucket?.kind === side && selectedBucket.head === row.head;
            return (
              <button
                key={row.head}
                type="button"
                onClick={() => setSelectedBucket(selected ? null : { kind: side, head: row.head })}
                aria-pressed={selected}
                className={`${COLS} w-full min-h-[2.75rem] text-left transition-colors ${selected ? 'bg-brand-50' : 'hover:bg-slate-50/80'}`}
              >
                <span className="min-w-0 flex items-center gap-2">
                  <span className={`text-sm font-semibold truncate ${INK}`}>{row.head}</span>
                  {row.editedCount > 0 && (
                    <span className="text-[11px] font-semibold text-amber-600 shrink-0">· {row.editedCount} edited</span>
                  )}
                </span>
                <span className="text-center text-xs text-slate-500 tabular-nums">{row.count}</span>
                <span className={`text-right text-sm font-bold tabular-nums ${row.totalPaisa > 0 ? (income ? 'text-brand-700' : INK) : 'text-slate-400'}`}>
                  {formatBDT(row.totalPaisa)}
                </span>
              </button>
            );
          })}
          {!income && (
            <div className={`${COLS} min-h-[2.75rem] bg-slate-50/50`}>
              <span className={`text-sm font-semibold ${INK}`}>Closing Balance (Carry-forward)</span>
              <span className="text-center text-xs text-slate-400">Carry-fwd</span>
              <span className={`text-right text-sm font-bold tabular-nums ${summary.closingBalancePaisa < 0 ? 'text-rose-600' : INK}`}>
                {formatBDT(summary.closingBalancePaisa)}
              </span>
            </div>
          )}
        </div>

        <div className={`${COLS} py-3 border-t-2 ${income ? 'bg-emerald-50/60 border-emerald-200' : 'bg-amber-50/60 border-amber-200'}`}>
          <span className={`text-sm font-extrabold ${income ? 'text-emerald-900' : 'text-amber-900'}`}>
            {income ? 'TOTAL AVAILABLE INCOME' : 'TOTAL EXPENSE + CLOSING'}
          </span>
          <span className={`text-center text-xs font-bold tabular-nums ${income ? 'text-emerald-800' : 'text-amber-800'}`}>{count}</span>
          <span className={`text-right text-sm font-extrabold tabular-nums ${income ? 'text-emerald-800' : 'text-amber-900'}`}>{formatBDT(subtotal)}</span>
        </div>
      </section>
    );
  };

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-4 space-y-4">
      <div className="flex flex-wrap @3xl:flex-nowrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 @3xl:flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className={`font-display text-2xl font-extrabold tracking-tight leading-tight ${INK}`}>Monthly Sheet</h1>
            {activeLock && (
              <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
                <Lock className="w-3.5 h-3.5" /> Locked by {activeLock.lockedByName}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5 @3xl:truncate">
            Income &amp; expense statement — <b className={INK}>{summary.label}</b>. Click a row to inspect its entries.
          </p>
        </div>

        <div className="flex flex-wrap @3xl:flex-nowrap items-center gap-1.5 shrink-0 no-print">
          {isAdmin && monthKey && !activeLock && (
            <button
              type="button"
              disabled={locking}
              onClick={handleLockMonth}
              className="h-8 px-3 rounded-lg border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-semibold inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Lock className="w-3.5 h-3.5" /> Sign Off &amp; Lock
            </button>
          )}
          <button type="button" onClick={() => void exportFullSummary('excel')} className={actionBtn}>
            <Download className="w-3.5 h-3.5 text-brand-600" /> Excel
          </button>
          <button type="button" disabled={exportingPdf} onClick={() => void exportFullSummary('pdf')} className={`${actionBtn} disabled:opacity-60`}>
            <Download className="w-3.5 h-3.5 text-rose-600" /> {exportingPdf ? 'Preparing…' : 'PDF'}
          </button>
          <button type="button" onClick={exportItemizedCsv} className={actionBtn}>
            <Download className="w-3.5 h-3.5 text-brand-600" /> CSV
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="h-8 px-3 rounded-lg bg-[#1b2a4e] hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
          >
            <Printer className="w-3.5 h-3.5" /> Print
          </button>
        </div>
      </div>

      {/* Same panel as the Daily Ledger: one row of equal-height controls. */}
      <div className={`${SURFACE} px-3 py-2 no-print`}>
        <div className="flex flex-wrap items-center gap-2">
          {presets.map((p) => {
            const on = period.from === p.from && period.to === p.to;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod({ from: p.from, to: p.to })}
                aria-pressed={on}
                className={`h-8 px-2.5 rounded-lg border text-[11px] font-semibold whitespace-nowrap transition-colors ${
                  on
                    ? 'border-brand-200 bg-brand-50 text-brand-900'
                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-white hover:text-slate-900'
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
            className={CTL}
            wrapperClassName="flex-[1_1_10rem] min-w-[9rem]"
          />

          <div className="relative flex-[2_1_10rem] min-w-[9rem]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={drillSearch}
              onChange={(e) => setDrillSearch(e.target.value)}
              placeholder="Search voucher, payee, ref..."
              className={`${CTL} pl-8 font-medium`}
            />
          </div>

          <FilterSelect
            ariaLabel="Sort by"
            value={sortKey}
            onChange={(v) => setSortKey(v as TransactionSort)}
            options={SORT_OPTIONS}
            defaultValue="newest"
            highlight={false}
            icon={<ArrowUpDown className="w-3 h-3 shrink-0 text-slate-400" />}
            className={CTL}
            wrapperClassName="flex-[1_1_8.5rem] min-w-[7.5rem]"
          />

          <button
            type="button"
            onClick={clearFilters}
            disabled={!filtersActive}
            title="Clear search, sort and row selection"
            aria-label="Clear filters"
            className={`h-8 shrink-0 inline-flex items-center gap-1 px-2.5 rounded-lg border text-[11px] font-semibold transition-colors ${
              filtersActive
                ? 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
                : 'border-slate-200 bg-slate-50 text-slate-300 cursor-default'
            }`}
          >
            <FilterX className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 @5xl:grid-cols-5 gap-3">
        {kpis.map((k, i) => (
          <div key={k.label} className={`${SURFACE} px-4 py-3 min-w-0 ${i === kpis.length - 1 ? 'col-span-2 @5xl:col-span-1' : ''}`}>
            <span className="flex items-center justify-between gap-2">
              <span className={`text-[12.5px] font-semibold truncate ${INK}`}>{k.label}</span>
              <span className={`grid place-items-center w-8 h-8 rounded-xl bg-gradient-to-br ${k.icon} text-white shadow-md shrink-0`}>
                <k.Icon className="w-4 h-4" />
              </span>
            </span>
            <span className={`block mt-1.5 text-lg font-extrabold font-display tabular-nums whitespace-nowrap ${k.tone}`}>{formatBDT(k.value)}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 @4xl:grid-cols-2 gap-4 items-stretch">
        {StatementPanel({ side: 'income' })}
        {StatementPanel({ side: 'expense' })}
      </div>

      <section className={`${SURFACE} overflow-hidden`}>
        <div className="px-4 py-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className={`text-[15px] font-bold ${INK}`}>
              {selectedBucket
                ? `${selectedBucket.head} — ${selectedBucket.kind === 'income' ? 'Income' : 'Expense'} Breakdown (${transactionPage?.totalCount ?? 0})`
                : `Every Entry in ${summary.label} (${transactionPage?.totalCount ?? 0})`}
            </h2>
            <p className="text-xs text-slate-500">
              {selectedBucket
                ? 'Showing itemized vouchers inside this head. Click Show All to view the full period.'
                : 'Select any channel or office row above to isolate its transactions, or click a voucher for full edit history.'}
            </p>
          </div>

          {selectedBucket && (
            <div className="flex flex-wrap items-center gap-1.5 no-print">
              {onAddTx && (
                <button
                  type="button"
                  onClick={() => onAddTx(selectedBucket.kind, selectedBucket.head)}
                  className="h-8 px-3 rounded-lg bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Add to {selectedBucket.head}
                </button>
              )}
              <button type="button" onClick={() => setSelectedBucket(null)} className={actionBtn}>
                Show All
              </button>
            </div>
          )}
        </div>

        {drillTransactions.length === 0 && !loadingRows ? (
          <div className="px-6 py-10 text-center text-xs text-slate-400">
            No transactions match this selection in {summary.label}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2.5">Voucher / Date</th>
                  <th className="px-4 py-2.5">Head &amp; Category</th>
                  <th className="px-4 py-2.5">How (Method &amp; Ref)</th>
                  <th className="px-4 py-2.5">From / Where &amp; Why</th>
                  <th className="px-4 py-2.5">Audit</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  {(onEditTx || onDuplicateTx) && <th className="px-3 py-2.5 text-right no-print">Quick</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {drillTransactions.map((tx) => (
                  <tr
                    key={tx.id}
                    onClick={() => onOpenTx(tx)}
                    className="cursor-pointer hover:bg-slate-50/90 transition-colors"
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className={`font-mono font-bold ${INK}`}>{tx.voucherNo}</div>
                      <div className="text-[11px] text-slate-400 tabular-nums">{formatShortDate(tx.txDate)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className={`font-semibold ${INK}`}>{tx.head}</div>
                      <div className="text-[11px] text-slate-500">
                        {tx.subCategory}
                        {tx.department ? <span className="ml-1.5 text-slate-400">· {tx.department}</span> : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-700">{tx.paymentMethod}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{tx.referenceNo || 'No ref'}</div>
                    </td>
                    <td className="px-4 py-3 max-w-md">
                      <div className={`font-semibold truncate ${INK}`}>{tx.counterparty}</div>
                      <div className="text-[11px] text-slate-500 line-clamp-2">{tx.purpose}</div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {tx.status === 'flagged' ? (
                        <span className="font-bold text-rose-600 inline-flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5" /> Flagged
                        </span>
                      ) : tx.editCount > 0 ? (
                        <span className="font-semibold text-amber-700">
                          {tx.editCount} edit{tx.editCount === 1 ? '' : 's'}
                          {tx.amountChanged ? ' (amount)' : ''}
                        </span>
                      ) : (
                        <span className="text-slate-400">Original</span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right font-bold tabular-nums whitespace-nowrap ${tx.kind === 'income' ? 'text-brand-700' : 'text-rose-600'}`}>
                      {tx.kind === 'income' ? '+' : '-'}{formatBDT(tx.amountPaisa)}
                    </td>
                    {(onEditTx || onDuplicateTx) && (
                      <td className="px-3 py-3 text-right whitespace-nowrap no-print" onClick={(e) => e.stopPropagation()}>
                        <div className="inline-flex items-center gap-1">
                          {onEditTx && (
                            <button
                              type="button"
                              onClick={() => onEditTx(tx)}
                              title="Edit voucher"
                              aria-label={`Edit ${tx.voucherNo}`}
                              className="w-7 h-7 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 hover:text-[#1b2a4e] inline-grid place-items-center transition-colors"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {onDuplicateTx && (
                            <button
                              type="button"
                              onClick={() => onDuplicateTx(tx)}
                              title="Repeat / clone entry"
                              aria-label={`Repeat ${tx.voucherNo}`}
                              className="w-7 h-7 rounded-lg border border-slate-200 bg-white hover:bg-brand-50 text-slate-600 hover:text-brand-700 inline-grid place-items-center transition-colors"
                            >
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {(transactionPage?.hasMore || loadingRows || loadingMore) && (
              <div className="flex items-center justify-center gap-3 border-t border-slate-100 px-4 py-3 text-xs">
                <span className="text-slate-500">Showing {drillTransactions.length} of {transactionPage?.totalCount ?? 0}</span>
                {transactionPage?.hasMore && (
                  <button type="button" disabled={loadingMore} onClick={() => void loadMoreRows()} className="h-8 rounded-xl border border-slate-200 bg-white px-3 font-semibold text-[#1b2a4e] disabled:opacity-50">
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
