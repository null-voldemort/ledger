import React, { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Wallet, X } from 'lucide-react';
import type { FundSource, LedgerTransaction } from '../types';
import { createFundSource, updateFundSource, loadTransactions, type TransactionPage } from '../utils/cloud';
import { formatBDT } from '../utils/money';
import { formatShortDate } from '../utils/ledger';

interface Props {
  sources: FundSource[];
  transactions: LedgerTransaction[];
  isAdmin: boolean;
  onChanged: () => void;
  onToast: (message: string) => void;
}

export const FundsTab: React.FC<Props> = ({ sources, transactions, isAdmin, onChanged, onToast }) => {
  const [newName, setNewName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const [historyPage, setHistoryPage] = useState<TransactionPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyMoreLoading, setHistoryMoreLoading] = useState(false);
  const selected = sources.find((source) => source.id === selectedId);
  const history = historyPage?.items || [];

  useEffect(() => {
    let active = true;
    if (!selectedId) { setHistoryPage(null); return; }
    setHistoryLoading(true);
    loadTransactions({ fundSourceId: selectedId, limit: 50 })
      .then((page) => { if (active) setHistoryPage(page); })
      .catch(() => { if (active) setHistoryPage(null); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [selectedId, transactions]);

  const loadMoreHistory = async () => {
    if (!historyPage?.nextCursor || historyMoreLoading) return;
    setHistoryMoreLoading(true);
    try {
      const next = await loadTransactions({ fundSourceId: selectedId, limit: 50, cursor: historyPage.nextCursor });
      setHistoryPage((current) => current ? ({ ...next, items: [...current.items, ...next.items] }) : next);
    } finally {
      setHistoryMoreLoading(false);
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const source = await createFundSource(newName);
      setNewName('');
      setSelectedId(source.id);
      onChanged();
      onToast('Fund source created.');
    } catch (error: any) {
      onToast(error?.message || 'Could not create fund source.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (source: FundSource) => {
    if (!editName.trim()) return;
    setBusy(true);
    try {
      await updateFundSource(source.id, { name: editName.trim() });
      setEditingId('');
      onChanged();
      onToast('Fund source updated.');
    } catch (error: any) {
      onToast(error?.message || 'Could not update fund source.');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (source: FundSource) => {
    setBusy(true);
    try {
      await updateFundSource(source.id, { active: !source.active });
      onChanged();
    } catch (error: any) {
      onToast(error?.message || 'Could not update fund source.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-[#1b2a4e]">Fund Sources</h1>
          <p className="mt-1 text-xs text-slate-500">Track receipts, spending, and the remaining balance for each source.</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-900">
          <Wallet className="h-4 w-4" /> {sources.length} sources
        </div>
      </div>

      {isAdmin && (
        <form onSubmit={create} className="rounded-2xl border border-slate-200 bg-white p-4 flex flex-wrap items-end gap-2">
          <label className="min-w-[220px] flex-1 space-y-1 text-xs font-semibold text-slate-600">
            New income source
            <input value={newName} onChange={(event) => setNewName(event.target.value)} required maxLength={80} placeholder="Enter source name" className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-normal text-slate-800 outline-none focus:border-brand-500" />
          </label>
          <button type="submit" disabled={busy || !newName.trim()} className="h-10 rounded-xl bg-brand-700 px-4 text-xs font-semibold text-white inline-flex items-center gap-2 disabled:opacity-50"><Plus className="h-4 w-4" /> Add source</button>
        </form>
      )}

      <div className="grid grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3 gap-3">
        {sources.map((source) => (
          <section key={source.id} className={`rounded-2xl border bg-white p-4 shadow-sm ${selectedId === source.id ? 'border-brand-300 ring-1 ring-brand-100' : 'border-slate-200'}`}>
            <div className="flex items-start justify-between gap-2">
              <button type="button" onClick={() => setSelectedId(source.id)} className="min-w-0 flex-1 text-left">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{source.active ? 'Active fund' : 'Inactive fund'}</span>
                <span className="mt-1 block truncate text-base font-bold text-[#1b2a4e]">{source.name}</span>
              </button>
              {isAdmin && (
                <button type="button" onClick={() => { setEditingId(source.id); setEditName(source.name); }} className="rounded-lg p-2 text-slate-400 hover:bg-slate-50 hover:text-brand-700" aria-label={`Edit ${source.name}`}><Pencil className="h-4 w-4" /></button>
              )}
            </div>
            {editingId === source.id ? (
              <div className="mt-3 space-y-2">
                <input value={editName} onChange={(event) => setEditName(event.target.value)} className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => void saveEdit(source)} disabled={busy || !editName.trim()} className="h-8 rounded-lg bg-brand-700 px-3 text-xs font-semibold text-white inline-flex items-center gap-1 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> Save</button>
                  <button type="button" onClick={() => setEditingId('')} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 inline-flex items-center gap-1"><X className="h-3.5 w-3.5" /> Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-4 text-2xl font-extrabold tabular-nums text-[#1b2a4e]">{formatBDT(source.balancePaisa)}</div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div><div className="text-slate-400">Received</div><div className="mt-1 font-semibold tabular-nums text-emerald-700">{formatBDT(source.incomePaisa)}</div></div>
                  <div><div className="text-slate-400">Spent</div><div className="mt-1 font-semibold tabular-nums text-rose-600">{formatBDT(source.spentPaisa)}</div></div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-400">
                  <span>{source.transactionCount} ledger transactions</span>
                  {isAdmin && <button type="button" disabled={busy} onClick={() => void toggleActive(source)} className="font-semibold text-slate-500 hover:text-brand-700">{source.active ? 'Deactivate' : 'Activate'}</button>}
                </div>
              </>
            )}
          </section>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-[#1b2a4e]">Source transaction history</h2>
            <p className="text-xs text-slate-400">{selected ? selected.name : 'Select a source above to view its transactions.'}</p>
          </div>
          {selected && <div className="text-sm font-bold tabular-nums text-[#1b2a4e]">Remaining: {formatBDT(selected.balancePaisa)}</div>}
        </div>
        {!selected ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">Choose an income source to inspect its history.</div>
        ) : history.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">{historyLoading ? 'Loading source history…' : 'No transactions have been recorded for this source.'}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400"><tr><th className="px-4 py-3">Date / Voucher</th><th className="px-4 py-3">Details</th><th className="px-4 py-3">Employee / Party</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-right">Balance effect</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((tx) => <tr key={tx.id}><td className="px-4 py-3 whitespace-nowrap"><div className="font-mono font-semibold text-slate-700">{tx.voucherNo}</div><div className="mt-1 text-slate-400">{formatShortDate(tx.txDate)}</div></td><td className="px-4 py-3"><div className="font-semibold text-slate-700">{tx.subCategory}</div><div className="mt-1 text-slate-400">{tx.purpose}</div></td><td className="px-4 py-3"><div className="text-slate-700">{tx.employeeName || tx.counterparty}</div><div className="mt-1 text-slate-400">{tx.head}</div></td><td className={`px-4 py-3 text-right font-semibold tabular-nums ${tx.kind === 'income' ? 'text-emerald-700' : 'text-rose-600'}`}>{tx.kind === 'income' ? '+' : '−'}{formatBDT(tx.amountPaisa)}</td><td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-600">{tx.kind === 'income' ? 'Increase' : 'Decrease'}</td></tr>)}
              </tbody>
            </table>
            {historyPage?.hasMore && (
              <div className="flex items-center justify-center gap-3 border-t border-slate-100 px-4 py-3 text-xs">
                <span className="text-slate-500">Showing {history.length} of {historyPage.totalCount}</span>
                <button type="button" onClick={() => void loadMoreHistory()} disabled={historyMoreLoading} className="h-8 rounded-xl border border-slate-200 bg-white px-3 font-semibold text-[#1b2a4e] disabled:opacity-50">
                  {historyMoreLoading ? 'Loading…' : 'Show more'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
};
