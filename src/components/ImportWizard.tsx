import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Info, Plus, ShieldCheck, Upload, X } from 'lucide-react';
import type {
  ImportPlan,
  ImportValidation,
  IssueLevel,
  PlanEntry,
  PlanLoan,
  PlanSalaryPayment,
  RowIssue,
} from '../utils/importPlan';
import { commitExcelImport, previewExcelImport, validateExcelImport } from '../utils/cloud';
import { DEFAULT_DEPARTMENTS, EXPENSE_PURPOSES, INCOME_PURPOSES, PAYMENT_METHODS } from '../utils/ledger';
import { ScrollLock } from './ScrollLock';

type ListKey = 'entries' | 'employees' | 'salaryPayments' | 'loans' | 'loanRepayments' | 'rentItems';
type TabId = 'checks' | 'in' | 'out' | 'people' | 'salary' | 'loans' | 'rent';

interface Col {
  key: string;
  label: string;
  width: string;
  type?: 'text' | 'date' | 'amount' | 'select' | 'readonly';
  options?: { value: string; label: string }[];
  list?: string;
}

const taka = (n: number | undefined) =>
  n === undefined ? '' : `৳${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LEVEL_STYLE: Record<IssueLevel, string> = {
  error: 'text-rose-700',
  warn: 'text-amber-700',
  info: 'text-slate-500',
};

const inputCls = 'w-full h-7 px-1.5 rounded border border-slate-200 bg-white text-[12px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-brand-500';

interface Props {
  onClose: () => void;
  onDone: () => void;
}

export const ImportWizard: React.FC<Props> = ({ onClose, onDone }) => {
  const [stage, setStage] = useState<'pick' | 'review' | 'done'>('pick');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [check, setCheck] = useState<ImportValidation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>('checks');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showSkipped, setShowSkipped] = useState(true);
  const [password, setPassword] = useState('');
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<Record<string, number | string> | null>(null);
  const [edits, setEdits] = useState(0);
  const reqId = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  // Re-check after every edit (the server is the single source of truth for what is valid).
  useEffect(() => {
    if (!plan || !edits) return;
    const id = ++reqId.current;
    const t = window.setTimeout(async () => {
      try {
        const v = await validateExcelImport(plan);
        if (id === reqId.current) setCheck(v);
      } catch (e: any) {
        if (id === reqId.current) setError(e?.message || 'Could not re-check the import.');
      }
    }, 450);
    return () => window.clearTimeout(t);
  }, [plan, edits]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      const v = await previewExcelImport(file);
      setPlan(v.plan);
      setCheck(v);
      setEdits(0);
      setAck(false);
      setTab('checks');
      setStage('review');
    } catch (e: any) {
      setError(e?.message || 'Could not read that file.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const patch = (list: ListKey, id: string, change: Record<string, unknown>) => {
    setPlan((p) => {
      if (!p) return p;
      return {
        ...p,
        [list]: (p[list] as any[]).map((r) => {
          if (r.id !== id) return r;
          const next: any = { ...r, ...change };
          if (Array.isArray(r.guessed)) next.guessed = r.guessed.filter((f: string) => !(f in change));
          // Income channel and department are the same thing in this ledger; keep them together.
          if (list === 'entries' && 'head' in change && r.kind === 'income') next.department = change.head;
          if (list === 'entries' && 'department' in change && r.kind === 'expense') next.head = change.department;
          if (list === 'salaryPayments' && 'department' in change) next.department = change.department;
          return next;
        }),
      };
    });
    setEdits((n) => n + 1);
  };

  const setAllFunds = (fundSource: string) => {
    setPlan((p) => p && ({
      ...p,
      defaultFundSource: fundSource,
      entries: p.entries.map((r) => ({ ...r, fundSource })),
      salaryPayments: p.salaryPayments.map((r) => ({ ...r, fundSource })),
      loans: p.loans.map((r) => ({ ...r, fundSource })),
      loanRepayments: p.loanRepayments.map((r) => ({ ...r, fundSource })),
    }));
    setEdits((n) => n + 1);
  };

  const addOpeningBalance = (fundSource: string, amount: number) => {
    setPlan((p) => {
      if (!p) return p;
      const row: PlanEntry = {
        id: `manual-${Date.now()}`,
        include: true,
        source: 'Added manually',
        kind: 'income',
        txDate: `${p.sheetMonth}-01`,
        amount: amount.toFixed(2),
        department: 'OPENING-BALANCE',
        head: 'OPENING-BALANCE',
        subCategory: 'Opening Balance',
        paymentMethod: 'Cash in Hand',
        counterparty: 'Earlier months',
        purpose: 'Cash that covered payments made before this sheet month',
        referenceNo: '',
        notes: '',
        fundSource,
        guessed: [],
      };
      return { ...p, entries: [row, ...p.entries] };
    });
    setEdits((n) => n + 1);
    setTab('in');
  };

  const makePayroll = (entry: PlanEntry) => {
    if (!entry.payrollHint) return;
    const hint = entry.payrollHint;
    setPlan((p) => {
      if (!p) return p;
      const emp = p.employees.find((e) => e.key === hint.employeeRef);
      const base = {
        include: true,
        source: entry.source,
        employeeRef: hint.employeeRef,
        txDate: entry.txDate,
        amount: entry.amount,
        paymentMethod: entry.paymentMethod || 'Cash in Hand',
        department: emp?.department || entry.department,
        fundSource: entry.fundSource,
      };
      const entries = p.entries.map((e) => (e.id === entry.id
        ? { ...e, include: false, payrollHint: undefined, coveredBy: `payroll row created from ${entry.source}` }
        : e));
      if (hint.type === 'loan') {
        const loan: PlanLoan = { ...base, id: `loan-m${Date.now()}`, purpose: `Employee loan (${entry.counterparty})`, referenceNo: '' };
        return { ...p, entries, loans: [...p.loans, loan] };
      }
      const pay: PlanSalaryPayment = {
        ...base, id: `sal-m${Date.now()}`, type: hint.type === 'advance' ? 'advance' : 'salary',
        monthKey: p.sheetMonth, note: `From cash book: ${entry.counterparty}`,
      };
      return { ...p, entries, salaryPayments: [...p.salaryPayments, pay] };
    });
    setEdits((n) => n + 1);
  };

  const commit = async () => {
    if (!plan) return;
    setError('');
    setBusy(true);
    try {
      const r = await commitExcelImport(plan, password);
      setResult(r);
      setStage('done');
      setPassword('');
      onDone();
    } catch (e: any) {
      setError(e?.message || 'The import could not be completed. Nothing was imported.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (stage === 'review' && edits > 0 && !window.confirm('Close without importing? Your corrections will be lost.')) return;
    onClose();
  };

  // Issues come from the latest server check, matched back to rows by id.
  const issueMap = useMemo(() => {
    const m = new Map<string, RowIssue[]>();
    if (!check) return m;
    for (const list of ['entries', 'employees', 'salaryPayments', 'loans', 'loanRepayments', 'rentItems'] as ListKey[]) {
      for (const r of (check.plan[list] as any[])) m.set(`${list}:${r.id}`, r.issues || []);
    }
    return m;
  }, [check]);

  const fundNames = check?.fundSources || [];
  const employeeOptions = useMemo(() => {
    const opts = [{ value: '', label: '— choose —' }];
    for (const e of plan?.employees || []) opts.push({ value: e.key, label: `${e.name} (${e.key})` });
    for (const e of check?.existingEmployees || []) opts.push({ value: `db:${e.id}`, label: `${e.name} · existing ${e.code}` });
    return opts;
  }, [plan, check]);
  const fundOptions = fundNames.map((n) => ({ value: n, label: n }));
  const payOptions = PAYMENT_METHODS.map((m) => ({ value: m, label: m }));
  const deptNames = useMemo(() => {
    const set = new Set<string>(DEFAULT_DEPARTMENTS.map((d) => d.name));
    for (const r of plan?.entries || []) { if (r.department) set.add(r.department); }
    for (const r of plan?.employees || []) { if (r.department) set.add(r.department); }
    return [...set];
  }, [plan]);

  const counts = useMemo(() => {
    const e = plan?.entries || [];
    return {
      in: e.filter((r) => r.kind === 'income').length,
      out: e.filter((r) => r.kind === 'expense').length,
      people: plan?.employees.length || 0,
      salary: plan?.salaryPayments.length || 0,
      loans: (plan?.loans.length || 0) + (plan?.loanRepayments.length || 0),
      rent: plan?.rentItems.length || 0,
    };
  }, [plan]);

  const tabErrors = (list: ListKey[], kind?: 'income' | 'expense') => {
    let errs = 0;
    for (const l of list) {
      for (const r of (plan?.[l] as any[]) || []) {
        if (!r.include || (kind && r.kind !== kind)) continue;
        for (const i of issueMap.get(`${l}:${r.id}`) || []) if (i.level === 'error') errs++;
      }
    }
    return errs;
  };

  // ---------------------------------------------------------------------------------
  const renderGrid = (list: ListKey, rows: any[], cols: Col[], opts: { action?: (row: any) => React.ReactNode } = {}) => {
    const visible = rows.filter((r) => {
      if (!showSkipped && !r.include) return false;
      if (!attentionOnly) return true;
      return (issueMap.get(`${list}:${r.id}`) || []).some((i) => i.level !== 'info');
    });
    return (
      <div className="border border-slate-200 rounded-xl overflow-auto max-h-[calc(100vh-22rem)] bg-white">
        <table className="text-[12px] border-separate border-spacing-0 min-w-full">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              <th className="px-2 py-2 text-left font-semibold text-slate-500 border-b border-slate-200 w-10">Use</th>
              <th className="px-2 py-2 text-left font-semibold text-slate-500 border-b border-slate-200 w-28">From</th>
              {cols.map((c) => (
                <th key={c.key} style={{ minWidth: c.width }} className="px-1.5 py-2 text-left font-semibold text-slate-500 border-b border-slate-200 whitespace-nowrap">{c.label}</th>
              ))}
              {opts.action && <th className="px-2 py-2 border-b border-slate-200" />}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={cols.length + 3} className="px-3 py-6 text-center text-slate-400">Nothing to show here.</td></tr>
            )}
            {visible.map((r) => {
              const issues = issueMap.get(`${list}:${r.id}`) || [];
              const worst: IssueLevel | '' = !r.include ? '' : issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warn') ? 'warn' : '';
              const bg = !r.include ? 'bg-slate-50 opacity-60' : worst === 'error' ? 'bg-rose-50/60' : '';
              const shown = issues.filter((i) => r.include || i.level === 'info');
              return (
                <React.Fragment key={r.id}>
                  <tr className={bg}>
                    <td className="px-2 pt-1.5 align-top">
                      <input type="checkbox" checked={!!r.include} onChange={(e) => patch(list, r.id, { include: e.target.checked })} aria-label="Import this row" />
                    </td>
                    <td className="px-2 pt-2 align-top font-mono text-[10px] text-slate-400 whitespace-nowrap">{r.source}</td>
                    {cols.map((c) => {
                      const guessed = Array.isArray(r.guessed) && r.guessed.includes(c.key);
                      const cls = `${inputCls} ${guessed ? 'bg-amber-50 border-amber-300' : ''} ${c.type === 'amount' ? 'text-right tabular-nums' : ''}`;
                      return (
                        <td key={c.key} className="px-1 pt-1 align-top">
                          {c.type === 'readonly' ? (
                            <span className="block px-1.5 pt-1 text-slate-600">{String(r[c.key] ?? '')}</span>
                          ) : c.type === 'select' ? (
                            <select className={cls} value={r[c.key] ?? ''} onChange={(e) => patch(list, r.id, { [c.key]: e.target.value })}>
                              {(c.options || []).some((o) => o.value === (r[c.key] ?? '')) ? null : <option value={r[c.key] ?? ''}>{r[c.key] || '—'}</option>}
                              {(c.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          ) : (
                            <input
                              className={cls}
                              type={c.type === 'date' ? 'date' : 'text'}
                              inputMode={c.type === 'amount' ? 'decimal' : undefined}
                              list={c.list}
                              value={r[c.key] ?? ''}
                              onChange={(e) => patch(list, r.id, { [c.key]: e.target.value })}
                            />
                          )}
                        </td>
                      );
                    })}
                    {opts.action && <td className="px-2 pt-1 align-top whitespace-nowrap">{opts.action(r)}</td>}
                  </tr>
                  {(shown.length > 0 || r.skipReason) && (
                    <tr className={bg}>
                      <td />
                      <td colSpan={cols.length + 2} className="px-2 pb-1.5 text-[11px] leading-snug">
                        {!r.include && r.skipReason && <div className="text-slate-500">• {r.skipReason}</div>}
                        {shown.map((i, n) => <div key={n} className={LEVEL_STYLE[i.level]}>• {i.message}</div>)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const entryCols = (kind: 'income' | 'expense'): Col[] => kind === 'income'
    ? [
      { key: 'txDate', label: 'Date', width: '120px', type: 'date' },
      { key: 'amount', label: 'Amount ৳', width: '95px', type: 'amount' },
      { key: 'head', label: 'Channel', width: '150px', list: 'imp-heads-in' },
      { key: 'subCategory', label: 'Category', width: '170px', list: 'imp-cat-in' },
      { key: 'paymentMethod', label: 'Payment', width: '130px', list: 'imp-pay' },
      { key: 'counterparty', label: 'Received from', width: '150px' },
      { key: 'purpose', label: 'Reason', width: '220px' },
      { key: 'fundSource', label: 'Fund source', width: '140px', type: 'select', options: fundOptions },
      { key: 'notes', label: 'Notes', width: '170px' },
    ]
    : [
      { key: 'txDate', label: 'Date', width: '120px', type: 'date' },
      { key: 'amount', label: 'Amount ৳', width: '95px', type: 'amount' },
      { key: 'department', label: 'Office', width: '160px', list: 'imp-depts' },
      { key: 'subCategory', label: 'Category', width: '190px', list: 'imp-cat-out' },
      { key: 'counterparty', label: 'Paid to / for', width: '210px' },
      { key: 'purpose', label: 'Reason', width: '200px' },
      { key: 'paymentMethod', label: 'Payment', width: '130px', list: 'imp-pay' },
      { key: 'fundSource', label: 'Fund source', width: '140px', type: 'select', options: fundOptions },
    ];

  const sheetOk = check ? check.reconcile.filter((l) => l.ok === false).length : 0;
  const blocked = !check || check.errorCount > 0;
  const total = check ? check.counts.entries + check.counts.employees + check.counts.salaryPayments + check.counts.loans + check.counts.loanRepayments + check.counts.rentItems : 0;

  const TABS: { id: TabId; label: string; count?: number; errors?: number }[] = [
    { id: 'checks', label: 'Checks', errors: (check?.planIssues.filter((i) => i.level === 'error').length || 0) },
    { id: 'in', label: 'Money in', count: counts.in, errors: tabErrors(['entries'], 'income') },
    { id: 'out', label: 'Money out', count: counts.out, errors: tabErrors(['entries'], 'expense') },
    { id: 'people', label: 'Employees', count: counts.people, errors: tabErrors(['employees']) },
    { id: 'salary', label: 'Salaries', count: counts.salary, errors: tabErrors(['salaryPayments']) },
    { id: 'loans', label: 'Loans', count: counts.loans, errors: tabErrors(['loans', 'loanRepayments']) },
    { id: 'rent', label: 'Rent', count: counts.rent, errors: tabErrors(['rentItems']) },
  ];

  return (
    <div className="no-print fixed inset-0 z-[80] bg-slate-950/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <ScrollLock />
      <div role="dialog" aria-modal="true" aria-label="Import from Excel" className="bg-white w-full max-w-[96rem] sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden h-full sm:h-[min(60rem,94vh)]">
        <div className="shrink-0 px-5 py-3.5 border-b border-slate-100 flex items-center gap-3">
          <span className="grid place-items-center w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-700 text-white shadow-lg shadow-emerald-600/30"><FileSpreadsheet className="w-5 h-5" /></span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#1b2a4e]">Import from Excel</h2>
            <p className="text-xs text-slate-500 truncate">{plan ? `${plan.fileName} · ${plan.sheetMonth}` : 'Preview first, correct anything that is wrong, then confirm. Nothing is saved until you confirm.'}</p>
          </div>
          <button onClick={close} aria-label="Close" className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100"><X className="w-4 h-4" /></button>
        </div>

        {error && (
          <div role="alert" className="shrink-0 mx-5 mt-3 flex items-start gap-2 text-[13px] text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3.5 py-2.5">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError('')} aria-label="Dismiss" className="text-rose-400 hover:text-rose-700"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {stage === 'pick' && (
          <div className="flex-1 overflow-y-auto p-6 sm:p-10">
            <div className="max-w-2xl mx-auto space-y-5">
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-8 text-center">
                <Upload className="w-8 h-8 mx-auto text-slate-400" />
                <p className="mt-3 text-sm font-semibold text-[#1b2a4e]">Choose your Income &amp; Expense workbook (.xlsx)</p>
                <p className="mt-1 text-xs text-slate-500">The file is only read to build a preview. Nothing is written to the ledger yet.</p>
                <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
                <button onClick={() => fileRef.current?.click()} disabled={busy}
                  className="mt-4 inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-50">
                  {busy ? 'Reading…' : 'Choose file'}
                </button>
              </div>
              <ol className="text-[13px] text-slate-600 space-y-2 list-decimal pl-5">
                <li>The preview shows every row exactly as it would be saved, with anything the sheet did not say highlighted in yellow.</li>
                <li>Fix any field right in the table, tick or untick rows, and watch the checks update.</li>
                <li>When there are no red problems, enter your admin password to import. Everything is saved together or not at all.</li>
              </ol>
              <p className="text-xs text-slate-500 flex gap-2"><ShieldCheck className="w-4 h-4 shrink-0 text-emerald-600" /> Download a backup from the Backup menu before importing, so you can always go back.</p>
            </div>
          </div>
        )}

        {stage === 'review' && plan && check && (
          <>
            <datalist id="imp-depts">{deptNames.map((d) => <option key={d} value={d} />)}</datalist>
            <datalist id="imp-heads-in">{['OWNER-CASH', 'BRAC-BANK-ATM', 'BRAC-BANK-TRANSFER', 'BRAC-BANK-Cheque', 'NETWORK-BAZAR', 'MITHU-CASH', 'SUMON-CASH', 'OTHER-INCOME', 'OPENING-BALANCE'].map((d) => <option key={d} value={d} />)}</datalist>
            <datalist id="imp-pay">{PAYMENT_METHODS.map((d) => <option key={d} value={d} />)}</datalist>
            <datalist id="imp-cat-in">{INCOME_PURPOSES.map((d) => <option key={d} value={d} />)}</datalist>
            <datalist id="imp-cat-out">{EXPENSE_PURPOSES.map((d) => <option key={d} value={d} />)}</datalist>

            <div className="shrink-0 px-5 pt-3 flex flex-wrap items-center gap-1.5 border-b border-slate-100">
              {TABS.map((t) => (
                <button key={t.id} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
                  className={`px-3 py-2 text-[13px] rounded-t-lg border-b-2 -mb-px flex items-center gap-1.5 ${tab === t.id ? 'border-brand-700 text-brand-800 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
                  {t.label}
                  {t.count !== undefined && <span className="text-[11px] tabular-nums px-1.5 rounded-full bg-slate-100 text-slate-600">{t.count}</span>}
                  {!!t.errors && <span className="text-[11px] tabular-nums px-1.5 rounded-full bg-rose-100 text-rose-700">{t.errors}</span>}
                </button>
              ))}
              {tab !== 'checks' && (
                <div className="ml-auto flex items-center gap-4 pb-1 text-[12px] text-slate-600">
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} /> Only rows needing attention</label>
                  <label className="flex items-center gap-1.5"><input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} /> Show unticked rows</label>
                </div>
              )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              {tab === 'checks' && (
                <div className="space-y-5 max-w-5xl">
                  <div className="flex flex-wrap gap-3">
                    {[
                      ['Entries', check.counts.entries], ['Employees', check.counts.employees], ['Salary payments', check.counts.salaryPayments],
                      ['Loans', check.counts.loans + check.counts.loanRepayments], ['Rent items', check.counts.rentItems], ['Unticked (skipped)', check.counts.skipped],
                    ].map(([label, n]) => (
                      <div key={label as string} className="rounded-xl border border-slate-200 px-4 py-2.5 min-w-[7.5rem]">
                        <div className="text-lg font-bold tabular-nums text-[#1b2a4e]">{n as number}</div>
                        <div className="text-[11px] text-slate-500">{label as string}</div>
                      </div>
                    ))}
                  </div>

                  {check.planIssues.length > 0 && (
                    <div className="space-y-2">
                      {check.planIssues.map((i, n) => (
                        <div key={n} className={`flex gap-2 text-[13px] rounded-xl border px-3.5 py-2.5 ${i.level === 'error' ? 'bg-rose-50 border-rose-100 text-rose-800' : 'bg-amber-50 border-amber-100 text-amber-800'}`}>
                          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> <span>{i.message}</span>
                        </div>
                      ))}
                      {check.funds.filter((f) => f.closing < 0).map((f) => {
                        const amount = Math.max(-f.closing, plan.sheetTotals.balance - f.closing);
                        return (
                          <button key={f.fundSource} onClick={() => addOpeningBalance(f.fundSource, amount)}
                            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-brand-900 text-[13px] font-semibold">
                            <Plus className="w-4 h-4" /> Add an opening-balance income of {taka(amount)} to {f.fundSource}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <section>
                    <h3 className="text-sm font-bold text-[#1b2a4e] mb-2">Does it match the workbook?</h3>
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-[13px]">
                        <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr><th className="text-left px-3 py-2">What</th><th className="text-right px-3 py-2">Workbook says</th><th className="text-right px-3 py-2">Import will have</th><th className="px-3 py-2 w-10" /></tr>
                        </thead>
                        <tbody>
                          {check.reconcile.map((l) => (
                            <React.Fragment key={l.label}>
                              <tr className="border-t border-slate-100">
                                <td className="px-3 py-2">{l.label}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{taka(l.sheet)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{taka(l.imported)}</td>
                                <td className="px-3 py-2 text-center">
                                  {l.ok === true && <CheckCircle2 className="w-4 h-4 text-emerald-600 inline" aria-label="Matches" />}
                                  {l.ok === false && <AlertTriangle className="w-4 h-4 text-amber-600 inline" aria-label="Differs" />}
                                </td>
                              </tr>
                              {l.ok === false && l.detail && (
                                <tr><td colSpan={4} className="px-3 pb-2.5 text-[12px] text-slate-500">{l.detail}</td></tr>
                              )}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {sheetOk > 0 && <p className="mt-1.5 text-[12px] text-slate-500">A difference is fine when it is explained above or you changed something on purpose.</p>}
                  </section>

                  <section>
                    <h3 className="text-sm font-bold text-[#1b2a4e] mb-2">Fund sources</h3>
                    <div className="flex flex-wrap items-center gap-2 mb-2 text-[13px]">
                      <span className="text-slate-600">Put every row in</span>
                      <select className="h-8 px-2 rounded-lg border border-slate-200 text-[13px]" value={plan.defaultFundSource} onChange={(e) => setAllFunds(e.target.value)}>
                        {fundNames.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                      <span className="text-slate-400 text-[12px]">(your sheet keeps one cash pool, so everything starts in one fund; change single rows in the tables)</span>
                    </div>
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <table className="w-full text-[13px]">
                        <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wide">
                          <tr><th className="text-left px-3 py-2">Fund</th><th className="text-right px-3 py-2">Now</th><th className="text-right px-3 py-2">In</th><th className="text-right px-3 py-2">Out</th><th className="text-right px-3 py-2">After import</th></tr>
                        </thead>
                        <tbody>
                          {check.funds.map((f) => (
                            <tr key={f.fundSource} className="border-t border-slate-100">
                              <td className="px-3 py-2">{f.fundSource}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{taka(f.existingBalance)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{taka(f.incoming)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{taka(f.outgoing)}</td>
                              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${f.closing < 0 ? 'text-rose-700' : ''}`}>{taka(f.closing)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  {(check.newHeads.length > 0 || check.newDepartments.length > 0) && (
                    <section className="text-[13px] text-slate-600 flex gap-2">
                      <Info className="w-4 h-4 mt-0.5 shrink-0 text-slate-400" />
                      <div>
                        These will be created because they do not exist yet. Check the spelling, because a typo here creates a duplicate.
                        {check.newHeads.length > 0 && <div className="mt-1"><b>Heads:</b> {check.newHeads.join(', ')}</div>}
                        {check.newDepartments.length > 0 && <div className="mt-1"><b>Departments:</b> {check.newDepartments.join(', ')}</div>}
                      </div>
                    </section>
                  )}

                  {plan.notes.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-[#1b2a4e] mb-1">Things noticed in the workbook</h3>
                      <ul className="text-[13px] text-slate-600 list-disc pl-5 space-y-0.5">{plan.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                    </section>
                  )}
                </div>
              )}

              {tab === 'in' && renderGrid('entries', plan.entries.filter((r) => r.kind === 'income'), entryCols('income'))}
              {tab === 'out' && renderGrid('entries', plan.entries.filter((r) => r.kind === 'expense'), entryCols('expense'), {
                action: (r: PlanEntry) => (r.payrollHint && r.include ? (
                  <button onClick={() => makePayroll(r)} className="h-7 px-2 rounded border border-brand-200 bg-brand-50 hover:bg-brand-100 text-[11px] font-semibold text-brand-900">
                    Make it {r.payrollHint.type === 'loan' ? 'a loan' : r.payrollHint.type === 'advance' ? 'an advance' : 'payroll'}
                  </button>
                ) : null),
              })}
              {tab === 'people' && renderGrid('employees', plan.employees, [
                { key: 'key', label: 'Name in sheet', width: '170px', type: 'readonly' },
                { key: 'name', label: 'Name', width: '150px' },
                { key: 'role', label: 'Role', width: '120px' },
                { key: 'branch', label: 'Branch', width: '170px', list: 'imp-depts' },
                { key: 'department', label: 'Department', width: '170px', list: 'imp-depts' },
                { key: 'monthlySalary', label: 'Monthly salary ৳', width: '120px', type: 'amount' },
                { key: 'linkExistingId', label: 'Link to existing', width: '200px', type: 'select', options: [{ value: '', label: 'Create new' }, ...(check.existingEmployees || []).map((e) => ({ value: e.id, label: `${e.name} (${e.code})` }))] },
              ])}
              {tab === 'salary' && renderGrid('salaryPayments', plan.salaryPayments, [
                { key: 'employeeRef', label: 'Employee', width: '210px', type: 'select', options: employeeOptions },
                { key: 'type', label: 'Type', width: '110px', type: 'select', options: [{ value: 'salary', label: 'Salary' }, { value: 'advance', label: 'Advance' }] },
                { key: 'txDate', label: 'Paid on', width: '120px', type: 'date' },
                { key: 'monthKey', label: 'For month', width: '90px' },
                { key: 'amount', label: 'Amount ৳', width: '95px', type: 'amount' },
                { key: 'department', label: 'Department', width: '160px', list: 'imp-depts' },
                { key: 'paymentMethod', label: 'Payment', width: '130px', list: 'imp-pay' },
                { key: 'fundSource', label: 'Fund source', width: '140px', type: 'select', options: fundOptions },
                { key: 'note', label: 'Note', width: '220px' },
              ])}
              {tab === 'loans' && (
                <div className="space-y-5">
                  <div>
                    <h3 className="text-sm font-bold text-[#1b2a4e] mb-2">Loans given</h3>
                    {renderGrid('loans', plan.loans, [
                      { key: 'employeeRef', label: 'Employee', width: '210px', type: 'select', options: employeeOptions },
                      { key: 'txDate', label: 'Issued on', width: '120px', type: 'date' },
                      { key: 'amount', label: 'Amount ৳', width: '95px', type: 'amount' },
                      { key: 'department', label: 'Department', width: '160px', list: 'imp-depts' },
                      { key: 'paymentMethod', label: 'Payment', width: '130px', list: 'imp-pay' },
                      { key: 'fundSource', label: 'Fund source', width: '140px', type: 'select', options: fundOptions },
                      { key: 'purpose', label: 'Purpose', width: '240px' },
                    ])}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-[#1b2a4e] mb-1">Repayments</h3>
                    <p className="text-xs text-slate-500 mb-2">Choose whether each receipt is new cash or is already included in the cash-book income. “Already in cash book” updates the loan balance without creating duplicate income; “Cash received” adds income and increases the projected closing balance.</p>
                    {renderGrid('loanRepayments', plan.loanRepayments, [
                      { key: 'employeeRef', label: 'Employee', width: '210px', type: 'select', options: employeeOptions },
                      { key: 'loanRef', label: 'Loan', width: '230px', type: 'select', options: [{ value: '', label: '— choose —' }, ...plan.loans.map((l) => ({ value: l.id, label: `${l.employeeRef || '?'} · ${l.txDate} · ৳${l.amount}` }))] },
                      { key: 'txDate', label: 'Paid on', width: '120px', type: 'date' },
                      { key: 'amount', label: 'Amount ৳', width: '95px', type: 'amount' },
                      { key: 'treatment', label: 'Cash treatment', width: '190px', type: 'select', options: [
                        { value: 'review', label: 'Choose treatment…' },
                        { value: 'cash', label: 'Cash received (add income)' },
                        { value: 'already-recorded', label: 'Already in cash book' },
                      ] },
                      { key: 'paymentMethod', label: 'Payment', width: '130px', list: 'imp-pay' },
                      { key: 'fundSource', label: 'Fund source', width: '140px', type: 'select', options: fundOptions },
                      { key: 'note', label: 'Note', width: '200px' },
                    ])}
                  </div>
                </div>
              )}
              {tab === 'rent' && renderGrid('rentItems', plan.rentItems, [
                { key: 'name', label: 'Rent item', width: '210px' },
                { key: 'category', label: 'Kind', width: '100px', type: 'select', options: [{ value: 'regular', label: 'Regular' }, { value: 'urgent', label: 'Urgent' }] },
                { key: 'monthlyAmount', label: 'Regular ৳', width: '100px', type: 'amount' },
                { key: 'urgentAmount', label: 'Urgent ৳', width: '100px', type: 'amount' },
                { key: 'department', label: 'Department', width: '170px', list: 'imp-depts' },
                { key: 'notes', label: 'Notes', width: '200px' },
              ])}
            </div>

            <div className="shrink-0 border-t border-slate-100 bg-slate-50/70 px-5 py-3 flex flex-wrap items-center gap-3">
              <div className="text-[13px]">
                {check.errorCount > 0
                  ? <span className="text-rose-700 font-semibold">{check.errorCount} problem{check.errorCount === 1 ? '' : 's'} to fix before you can import</span>
                  : <span className="text-emerald-700 font-semibold">No problems. {total} records ready.</span>}
                {check.warnCount > 0 && <span className="text-amber-700 ml-2">{check.warnCount} to double-check</span>}
              </div>
              <label className="flex items-center gap-1.5 text-[12px] text-slate-600 ml-auto">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed this preview
              </label>
              <input type="password" autoComplete="current-password" placeholder="Admin password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="h-9 w-44 px-3 rounded-lg border border-slate-200 text-[13px]" />
              <button onClick={commit} disabled={busy || blocked || !ack || !password}
                className="h-9 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-[13px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
                {busy ? 'Importing…' : 'Import now'}
              </button>
            </div>
          </>
        )}

        {stage === 'done' && result && (
          <div className="flex-1 overflow-y-auto p-8 sm:p-12">
            <div className="max-w-xl mx-auto text-center space-y-4">
              <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-600" />
              <h3 className="text-lg font-bold text-[#1b2a4e]">Import complete</h3>
              <p className="text-sm text-slate-600">
                {String(result.entries)} entries, {String(result.employees)} employees, {String(result.salaryPayments)} salary payments, {String(result.loans)} loans,
                {' '}{String(result.loanRepayments)} repayments and {String(result.rentItems)} rent items were saved. Every record is in the audit trail
                and tagged <span className="font-mono text-xs">{String(result.batch)}</span>.
              </p>
              <button onClick={onClose} className="h-10 px-6 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
