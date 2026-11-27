import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpDown,
  ArrowUpRight,
  Copy,
  Download,
  Edit3,
  FilterX,
  Paperclip,
  Search,
  Zap,
} from 'lucide-react';
import type { DepartmentRecord, Employee, FundSource, LedgerHead, LedgerKind, LedgerTransaction } from '../types';
import {
  PAYMENT_METHODS,
  formatShortDate,
} from '../utils/ledger';
import { formatBDT } from '../utils/money';
import { downloadTransactionExcel, loadTransactionFacets, loadTransactions, type TransactionListQuery, type TransactionPage, type TransactionSort } from '../utils/cloud';
import { DateRangeButton, dateRangeLabel } from './DateRangeButton';
import { FilterSelect, type FilterOption } from './FilterSelect';
import { QuickEntryForm } from './QuickEntryForm';

interface Props {
  transactions: LedgerTransaction[];
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  employees: Employee[];
  fundSources: FundSource[];
  onOpenTx: (tx: LedgerTransaction) => void;
  onEditTx?: (tx: LedgerTransaction) => void;
  onDuplicateTx?: (tx: LedgerTransaction) => void;
  onOpenEmployee?: (emp: Employee) => void;
  /** Accountants and admins only; everyone else sees a read-only ledger. */
  canEdit?: boolean;
  onQuickSaved: (tx: LedgerTransaction) => void;
  onToast: (msg: string) => void;
}

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';
/** Rows rendered at a time. Thousands of table rows is what made this page lag. */
const PAGE_SIZE = 50;

const AUDIT_OPTIONS: FilterOption[] = [
  { value: 'all', label: 'All Audit States' },
  { value: 'unclassified_dept', label: 'Needs Department Review' },
  { value: 'edited', label: 'Edited Entries' },
  { value: 'amount_changed', label: 'Amount Altered' },
  { value: 'flagged', label: 'Flagged for Review' },
  { value: 'receipt', label: 'Has Voucher Photo' },
];
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
const KIND_OPTIONS_BASE: FilterOption[] = [
  { value: 'all', label: 'All Types' },
  { value: 'income', label: 'Income Only' },
  { value: 'expense', label: 'Expense Only' },
];

interface RowProps {
  tx: LedgerTransaction;
  linkedEmp?: Employee;
  onOpen: (tx: LedgerTransaction) => void;
  onEdit?: (tx: LedgerTransaction) => void;
  onDuplicate?: (tx: LedgerTransaction) => void;
  onOpenEmployee?: (emp: Employee) => void;
}

/** One table row. Memoized: it only re-renders when its own transaction changes. */
const LedgerRow = memo(function LedgerRow({ tx, linkedEmp, onOpen, onEdit: onEditTx, onDuplicate: onDuplicateTx, onOpenEmployee }: RowProps) {
  const needsDept = tx.departmentReview || !tx.department?.trim();
  const onOpenTx = onOpen;
  return (
                    <tr
                      key={tx.id}
                      onClick={() => onOpenTx(tx)}
                      className="cursor-pointer hover:bg-slate-50/90 transition-colors"
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {tx.kind === 'income' ? (
                            <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          ) : (
                            <ArrowUpRight className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                          )}
                          <span className={`font-mono font-bold ${INK}`}>{tx.voucherNo}</span>
                        </div>
                        <div className="text-[11px] text-slate-400 tabular-nums pl-5">{formatShortDate(tx.txDate)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className={`font-semibold ${INK}`}>{tx.head}</div>
                        <div className="text-[11px] text-slate-500">
                          {tx.subCategory}
                          {needsDept ? (
                            <span className="ml-1.5 text-amber-700 font-semibold">· Dept pending</span>
                          ) : (
                            <span className="ml-1.5 text-slate-400">· {tx.department}</span>
                          )}
                        </div>
                        <div className="text-[10px] text-brand-700">Fund: {tx.fundSourceName || 'Unassigned'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-700">{tx.paymentMethod}</div>
                        <div className="text-[11px] text-slate-400 font-mono">
                          {tx.referenceNo || '—'}
                          {tx.receiptSha && (
                            <span className="ml-2 text-brand-700 inline-flex items-center gap-0.5 font-sans">
                              <Paperclip className="w-3 h-3" /> Photo
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-md">
                        <div className="flex items-center gap-1.5">
                          <span className={`font-semibold truncate ${INK}`}>{tx.counterparty}</span>
                          {linkedEmp && onOpenEmployee && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); onOpenEmployee(linkedEmp); }}
                              className="text-[11px] font-semibold text-brand-700 hover:underline shrink-0"
                            >
                              · {linkedEmp.code}
                            </button>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 line-clamp-2">{tx.purpose}</div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="text-slate-600">{tx.createdByName}</div>
                        {tx.status === 'flagged' ? (
                          <div className="text-[11px] font-bold text-rose-600 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> Flagged
                          </div>
                        ) : tx.editCount > 0 ? (
                          <div className="text-[11px] font-semibold text-amber-700">
                            {tx.editCount} edit{tx.editCount === 1 ? '' : 's'}{tx.amountChanged ? ' · amount changed' : ''}
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-400">Original</div>
                        )}
                      </td>
                      <td className={`px-4 py-3 text-right font-extrabold tabular-nums whitespace-nowrap ${tx.kind === 'income' ? 'text-brand-700' : 'text-rose-600'}`}>
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
  );
});

export const TransactionsLedger: React.FC<Props> = ({
  transactions,
  heads,
  departments,
  employees,
  fundSources,
  onOpenTx,
  onEditTx,
  onDuplicateTx,
  onOpenEmployee,
  canEdit = false,
  onQuickSaved,
  onToast,
}) => {
  const [quickOpen, setQuickOpen] = useState(false);
  // Selected date range (inclusive). Both undefined means "all dates".
  const [dates, setDates] = useState<{ from?: string; to?: string }>({});

  const [kindFilter, setKindFilter] = useState<'all' | LedgerKind>('all');
  const [headFilter, setHeadFilter] = useState('all');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [methodFilter, setMethodFilter] = useState('all');
  const [auditFilter, setAuditFilter] = useState<'all' | 'edited' | 'amount_changed' | 'flagged' | 'receipt' | 'unclassified_dept'>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<TransactionSort>('newest');

  const [pageData, setPageData] = useState<TransactionPage | null>(null);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unclassifiedDept, setUnclassifiedDept] = useState({ count: 0, totalPaisa: 0 });
  const [transactionFacets, setTransactionFacets] = useState({ departments: [] as string[], paymentMethods: [] as string[] });
  // Keep typing instant: the heavy filtering runs on a deferred copy of the search text.
  const deferredSearch = useDeferredValue(search);

  // Parents pass fresh inline callbacks every render; route them through a ref so rows stay memoized.
  const cb = useRef({ onOpenTx, onEditTx, onDuplicateTx, onOpenEmployee });
  cb.current = { onOpenTx, onEditTx, onDuplicateTx, onOpenEmployee };
  const stableOpen = useCallback((tx: LedgerTransaction) => cb.current.onOpenTx(tx), []);
  const stableEdit = useCallback((tx: LedgerTransaction) => cb.current.onEditTx?.(tx), []);
  const stableDup = useCallback((tx: LedgerTransaction) => cb.current.onDuplicateTx?.(tx), []);
  const stableEmp = useCallback((emp: Employee) => cb.current.onOpenEmployee?.(emp), []);

  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const pageQuery = useMemo<TransactionListQuery>(() => ({
    limit: PAGE_SIZE,
    from: dates.from,
    to: dates.to,
    kind: kindFilter,
    head: headFilter === 'all' ? undefined : headFilter,
    department: departmentFilter === 'all' ? undefined : departmentFilter,
    paymentMethod: methodFilter === 'all' ? undefined : methodFilter,
    auditFilter,
    search: deferredSearch.trim(),
    sort: sortKey,
  }), [dates.from, dates.to, kindFilter, headFilter, departmentFilter, methodFilter, auditFilter, deferredSearch, sortKey]);

  useEffect(() => {
    let active = true;
    setLoadingRows(true);
    loadTransactions(pageQuery)
      .then((page) => { if (active) setPageData(page); })
      .catch((error: any) => {
        if (!active) return;
        setPageData(null);
        onToast(error?.message || 'Could not load transactions');
      })
      .finally(() => { if (active) setLoadingRows(false); });
    return () => { active = false; };
  }, [pageQuery, onToast]);

  useEffect(() => {
    let active = true;
    loadTransactionFacets().then((facets) => { if (active) setTransactionFacets(facets); }).catch(() => {});
    return () => { active = false; };
  }, [transactions]);

  useEffect(() => {
    let active = true;
    loadTransactions({ limit: 1, auditFilter: 'unclassified_dept' })
      .then((page) => {
        if (active) setUnclassifiedDept({ count: page.totalCount, totalPaisa: page.incomePaisa + page.expensePaisa });
      })
      .catch(() => { if (active) setUnclassifiedDept({ count: 0, totalPaisa: 0 }); });
    return () => { active = false; };
  }, [transactions]);

  const filtered = pageData?.items || [];
  const visible = filtered;
  const totals = {
    inc: pageData?.incomePaisa || 0,
    exp: pageData?.expensePaisa || 0,
    net: pageData?.netPaisa || 0,
  };

  const loadMore = async () => {
    if (!pageData?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await loadTransactions({ ...pageQuery, cursor: pageData.nextCursor });
      setPageData((current) => current ? ({ ...next, items: [...current.items, ...next.items] }) : next);
    } catch (error: any) {
      onToast(error?.message || 'Could not load more transactions');
    } finally {
      setLoadingMore(false);
    }
  };

  const exportAllFiltered = () => {
    try {
      downloadTransactionExcel(pageQuery, dates.from && dates.to ? dateRangeLabel(dates.from, dates.to) : 'Daily-Ledger');
    } catch (error: any) {
      onToast(error?.message || 'Could not start the transaction export');
    }
  };

  const uniqueHeadNames = useMemo(() => Array.from(new Set(heads.map((head) => head.name))), [heads]);

  const uniqueDepartmentNames = useMemo(() => {
    const set = new Set<string>([...departments.map((d) => d.name), ...transactionFacets.departments]);
    return Array.from(set);
  }, [departments, transactionFacets.departments]);

  const uniqueMethodNames = useMemo(() => {
    const set = new Set<string>([...PAYMENT_METHODS, ...transactionFacets.paymentMethods]);
    return Array.from(set);
  }, [transactionFacets.paymentMethods]);

  const kindOptions = KIND_OPTIONS_BASE;
  const departmentOptions = useMemo<FilterOption[]>(() => [
    { value: 'all', label: 'All Departments' },
    { value: '__none__', label: 'Unclassified Department' },
    ...uniqueDepartmentNames.map((d) => ({ value: d, label: d })),
  ], [uniqueDepartmentNames]);
  const headOptions = useMemo<FilterOption[]>(() => [
    { value: 'all', label: 'All Channels & Offices' },
    ...uniqueHeadNames.map((n) => ({ value: n, label: n })),
  ], [uniqueHeadNames]);
  const methodOptions = useMemo<FilterOption[]>(() => [
    { value: 'all', label: 'All Methods' },
    ...uniqueMethodNames.map((m) => ({ value: m, label: m })),
  ], [uniqueMethodNames]);

  const filtersActive =
    kindFilter !== 'all' || headFilter !== 'all' || departmentFilter !== 'all' || methodFilter !== 'all' ||
    auditFilter !== 'all' || search.trim() !== '' || Boolean(dates.from);
  const clearFilters = () => {
    setKindFilter('all');
    setHeadFilter('all');
    setDepartmentFilter('all');
    setMethodFilter('all');
    setAuditFilter('all');
    setSearch('');
    setDates({});
  };

  // One shared size for every filter control (search, dropdowns, buttons) so the panel is a tidy, even grid.
  const ctl =
    'h-8 w-full min-w-0 px-2.5 text-[11px] font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500';
  const selectCls = `${ctl} truncate`;

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-4 space-y-4">
      <div className="flex flex-wrap @3xl:flex-nowrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 @3xl:flex-1">
          <h1 className={`font-display text-2xl font-extrabold tracking-tight leading-tight ${INK}`}>Daily Ledger</h1>
          <p className="text-xs text-slate-500 mt-0.5 @3xl:truncate">
            Record transactions with mandatory department, channel/office, funding source, and voucher photos.
          </p>
        </div>

        <div className="flex flex-wrap @3xl:flex-nowrap items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void exportAllFiltered()}
            className="h-8 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5 text-brand-600" /> Export Excel ({pageData?.totalCount ?? 0})
          </button>
          {canEdit && (
          <button
            type="button"
            onClick={() => setQuickOpen((v) => !v)}
            aria-expanded={quickOpen}
            className={`h-8 px-3 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 transition-colors ${
              quickOpen
                ? 'border-brand-500 bg-brand-50 text-brand-900'
                : 'border-slate-200 bg-white hover:bg-slate-50 text-[#1b2a4e]'
            }`}
          >
            <Zap className="w-3.5 h-3.5 text-brand-600" /> {quickOpen ? 'Close Entry Form' : 'New Entry'}
          </button>
          )}
        </div>
      </div>

      {unclassifiedDept.count > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-amber-900">
              <span className="font-bold">Department Reconciliation Needed:</span>{' '}
              {unclassifiedDept.count} entries totaling <b className="tabular-nums">{formatBDT(unclassifiedDept.totalPaisa)}</b> do not have a department assigned yet.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAuditFilter((cur) => (cur === 'unclassified_dept' ? 'all' : 'unclassified_dept'))}
            className={`h-8 px-3 rounded-xl text-xs font-bold border transition-colors shrink-0 ${
              auditFilter === 'unclassified_dept'
                ? 'bg-amber-600 border-amber-600 text-white'
                : 'bg-white border-amber-300 text-amber-900 hover:bg-amber-100'
            }`}
          >
            {auditFilter === 'unclassified_dept' ? 'Show All Entries' : `Review ${unclassifiedDept.count} Unclassified`}
          </button>
        </div>
      )}

      {/* Kept mounted (just hidden) so a half-typed entry isn't lost when the panel is collapsed. */}
      {canEdit && (
      <div hidden={!quickOpen}>
        <QuickEntryForm
          transactions={transactions}
          heads={heads}
          departments={departments}
          employees={employees}
          fundSources={fundSources}
          onQuickSaved={onQuickSaved}
          onToast={onToast}
        />
      </div>
      )}

      <div className={`${SURFACE} px-3 py-2`}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-[2_1_10rem] min-w-[9rem]">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search voucher, department, employee, payee, ref #..."
              className={`${ctl} pl-8 font-medium`}
            />
          </div>

          <DateRangeButton
            from={dates.from}
            to={dates.to}
            onChange={(from, to) => setDates({ from, to })}
            className={ctl}
            wrapperClassName="flex-[1_1_9rem] min-w-[8rem]"
          />

          <FilterSelect
            ariaLabel="Type"
            value={kindFilter}
            onChange={(v) => setKindFilter(v as any)}
            options={kindOptions}
            className={ctl}
            wrapperClassName="flex-[1_1_6.5rem] min-w-[6rem]"
          />

          <FilterSelect
            ariaLabel="Department"
            value={departmentFilter}
            onChange={setDepartmentFilter}
            options={departmentOptions}
            className={ctl}
            wrapperClassName="flex-[1_1_8rem] min-w-[7rem]"
          />

          <FilterSelect
            ariaLabel="Channel or office"
            value={headFilter}
            onChange={setHeadFilter}
            options={headOptions}
            className={ctl}
            wrapperClassName="flex-[1_1_10rem] min-w-[8rem]"
          />

          <FilterSelect
            ariaLabel="Payment method"
            value={methodFilter}
            onChange={setMethodFilter}
            options={methodOptions}
            className={ctl}
            wrapperClassName="flex-[1_1_7rem] min-w-[6.5rem]"
          />

          <FilterSelect
            ariaLabel="Audit state"
            value={auditFilter}
            onChange={(v) => setAuditFilter(v as any)}
            options={AUDIT_OPTIONS}
            className={ctl}
            wrapperClassName="flex-[1_1_8rem] min-w-[7rem]"
          />

          <FilterSelect
            ariaLabel="Sort by"
            value={sortKey}
            onChange={(v) => setSortKey(v as TransactionSort)}
            options={SORT_OPTIONS}
            defaultValue="newest"
            highlight={false}
            icon={<ArrowUpDown className="w-3 h-3 shrink-0 text-slate-400" />}
            className={ctl}
            wrapperClassName="flex-[1_1_8.5rem] min-w-[7.5rem]"
          />

          <button
            type="button"
            onClick={clearFilters}
            disabled={!filtersActive}
            title="Clear all filters"
            aria-label="Clear all filters"
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

      <section className={`${SURFACE} overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-4 py-1.5 border-b border-slate-100 text-[11px]">
          <span className="text-slate-500">
            Showing <b className={INK}>{filtered.length}</b> of <b className={INK}>{pageData?.totalCount ?? 0}</b>
          </span>
          <span className="text-emerald-700 font-semibold tabular-nums">Income: {formatBDT(totals.inc)}</span>
          <span className="text-rose-600 font-semibold tabular-nums">Expense: {formatBDT(totals.exp)}</span>
          <span className={`font-bold tabular-nums ${totals.net < 0 ? 'text-rose-600' : INK}`}>Net: {formatBDT(totals.net)}</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-slate-400">
            {loadingRows ? 'Loading transactions…' : 'No transactions match your current filters.'}
          </div>
        ) : (
          <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Voucher &amp; Date</th>
                  <th className="px-4 py-3">Dept / Head</th>
                  <th className="px-4 py-3">Method &amp; Ref #</th>
                  <th className="px-4 py-3">Party / Staff &amp; Why</th>
                  <th className="px-4 py-3">Entered By / Trail</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  {(onEditTx || onDuplicateTx) && <th className="px-3 py-3 text-right no-print">Quick</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map((tx) => (
                  <LedgerRow
                    key={tx.id}
                    tx={tx}
                    linkedEmp={tx.employeeId ? employeeById.get(tx.employeeId) : undefined}
                    onOpen={stableOpen}
                    onEdit={onEditTx ? stableEdit : undefined}
                    onDuplicate={onDuplicateTx ? stableDup : undefined}
                    onOpenEmployee={onOpenEmployee ? stableEmp : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {pageData?.hasMore && (
            <div className="no-print flex flex-wrap items-center justify-center gap-3 px-4 py-3 border-t border-slate-100 text-xs">
              <span className="text-slate-500">
                Showing <b className={INK}>{visible.length}</b> of <b className={INK}>{pageData.totalCount}</b>
              </span>
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className="h-8 px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 font-semibold text-[#1b2a4e] disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : `Show ${Math.min(PAGE_SIZE, pageData.totalCount - visible.length)} more`}
              </button>
            </div>
          )}
          </>
        )}
      </section>
    </div>
  );
};
