import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Edit3,
  FileText,
  History,
  Paperclip,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type { LedgerTransaction } from '../types';
import { formatBDT, formatDeltaBDT } from '../utils/money';
import { formatShortDate } from '../utils/ledger';
import { formatStamp } from '../utils/activity';
import { verifyOrFlagTransaction, voidTransaction } from '../utils/cloud';
import { ScrollLock } from './ScrollLock';
import { roleLabel } from '../utils/roles';

interface Props {
  tx: LedgerTransaction | null;
  isAdmin: boolean;
  /** Admin or accountant: may edit and void. Verify/flag stay admin-only. */
  canEdit: boolean;
  onClose: () => void;
  onEdit: (tx: LedgerTransaction) => void;
  onDuplicate?: (tx: LedgerTransaction) => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

export const TransactionDetailModal: React.FC<Props> = ({
  tx,
  isAdmin,
  canEdit,
  onClose,
  onEdit,
  onDuplicate,
  onChanged,
  onToast,
}) => {
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [flagging, setFlagging] = useState(false);
  const [flagNote, setFlagNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!tx) return null;

  const canVoid = canEdit && (tx.categoryGroup || 'general') === 'general';

  const handleVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (voidReason.trim().length < 4) {
      setError('Please enter a reason (at least 4 characters) to void this entry.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await voidTransaction(tx.id, voidReason.trim());
      onToast(`${tx.voucherNo} moved to Voided Bin`);
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not void transaction.');
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (status: 'verified' | 'flagged', note = '') => {
    setBusy(true);
    setError('');
    try {
      await verifyOrFlagTransaction(tx.id, status, note);
      onToast(status === 'verified' ? `${tx.voucherNo} marked verified` : `${tx.voucherNo} flagged for review`);
      setFlagging(false);
      setFlagNote('');
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not update verification status.');
    } finally {
      setBusy(false);
    }
  };

  const detailRow = (label: string, value: React.ReactNode) => (
    <div className="py-2.5 border-b border-slate-100 last:border-b-0 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
      <span className="sm:w-40 shrink-0 text-xs font-semibold text-slate-400">{label}</span>
      <span className="text-sm text-[#1b2a4e] font-medium break-words">{value || '—'}</span>
    </div>
  );

  return (
    <div className="no-print fixed inset-0 z-[72] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Transaction ${tx.voucherNo}`}
        className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col"
      >
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <span
            className={`grid place-items-center w-10 h-10 rounded-2xl text-white shadow-lg ${
              tx.kind === 'income'
                ? 'bg-gradient-to-br from-emerald-400 to-brand-700 shadow-brand-600/30'
                : 'bg-gradient-to-br from-amber-400 to-rose-600 shadow-rose-500/30'
            }`}
          >
            {tx.kind === 'income' ? <ArrowDownLeft className="w-5 h-5" /> : <ArrowUpRight className="w-5 h-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[#1b2a4e] font-mono">{tx.voucherNo}</h2>
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs font-semibold text-slate-600">{tx.head}</span>
              {tx.status === 'flagged' && (
                <span className="text-xs font-bold text-rose-600 flex items-center gap-1">
                  · <AlertTriangle className="w-3.5 h-3.5" /> Flagged for Verification
                </span>
              )}
              {tx.amountChanged && (
                <span className="text-xs font-bold text-amber-600">· Amount Edited</span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Recorded by {tx.createdByName} on {formatStamp(tx.createdAt)}
            </p>
          </div>
          <div className={`text-right font-display font-extrabold text-xl tabular-nums ${tx.kind === 'income' ? 'text-brand-700' : 'text-rose-600'}`}>
            {tx.kind === 'income' ? '+' : '-'}{formatBDT(tx.amountPaisa)}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-2 grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
          {error && (
            <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-700 font-medium">
              {error}
            </div>
          )}

          {tx.status === 'flagged' && tx.flagNote && (
            <div className="rounded-2xl bg-rose-50 border border-rose-200 p-3.5 flex items-start gap-2.5 text-xs text-rose-900">
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold">Flagged Notice</div>
                <div className="mt-0.5">{tx.flagNote}</div>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-slate-100 bg-slate-50/50 px-5 py-2">
            {detailRow('Transaction Date', formatShortDate(tx.txDate))}
            {detailRow('Department', tx.department || (tx.departmentReview ? 'Pending Department Classification' : '—'))}
            {detailRow(tx.kind === 'income' ? 'Income Source' : 'Office / Cost Center', tx.head)}
            {detailRow('Funding Source', tx.fundSourceName || 'Legacy Unassigned')}
            {detailRow('Category / Type', tx.subCategory)}
            {tx.employeeName ? detailRow('Linked Employee', tx.employeeName) : null}
            {detailRow(tx.kind === 'income' ? 'How Received' : 'How Spent', `${tx.paymentMethod}${tx.referenceNo ? ` · Ref: ${tx.referenceNo}` : ''}`)}
            {detailRow(tx.kind === 'income' ? 'Received From' : 'Paid To / Where Spent', `${tx.counterparty}${tx.counterpartyPhone ? ` (${tx.counterpartyPhone})` : ''}`)}
            {detailRow('Why / Purpose', tx.purpose)}
            {tx.notes ? detailRow('Notes', tx.notes) : null}
            {tx.verifiedByName ? detailRow('Verification', `Verified by ${tx.verifiedByName} (${formatStamp(tx.verifiedAt)})`) : null}
          </div>

          {tx.receiptSha && (
            <div className="rounded-2xl border border-slate-100 p-4">
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="text-xs font-bold text-[#1b2a4e] flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5 text-brand-600" />
                  Attached Proof: {tx.receiptName}
                </span>
                <a
                  href={`/api/receipts/${tx.receiptSha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-brand-700 hover:underline inline-flex items-center gap-1"
                >
                  <FileText className="w-3.5 h-3.5" /> Open Full File
                </a>
              </div>
              {tx.receiptType?.startsWith('image/') && (
                <img
                  src={`/api/receipts/${tx.receiptSha}`}
                  alt={tx.receiptName || 'Receipt'}
                  className="max-h-72 rounded-xl border border-slate-100 object-contain bg-slate-50"
                />
              )}
            </div>
          )}

          
          <section className="rounded-2xl border border-slate-100 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-[#1b2a4e] flex items-center gap-2">
                <History className="w-4 h-4 text-brand-600" />
                Edit History &amp; Number Trail
              </h3>
              <span className="text-xs text-slate-400 tabular-nums">
                {tx.editCount === 0 ? 'Never edited (original)' : `${tx.editCount} edit${tx.editCount === 1 ? '' : 's'}`}
              </span>
            </div>

            {tx.editHistory.length === 0 ? (
              <p className="text-xs text-slate-500">Original figures intact since creation on {formatStamp(tx.createdAt)}.</p>
            ) : (
              <ol className="space-y-2.5">
                {tx.editHistory.map((h, idx) => (
                  <li key={idx} className="rounded-xl bg-slate-50 border border-slate-100 p-3 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-bold text-[#1b2a4e]">
                        {h.byName} ({roleLabel(h.byRole)})
                      </span>
                      <span className="text-slate-400">{formatStamp(h.at)}</span>
                    </div>
                    <div className="text-slate-600">
                      <span className="font-semibold">Reason:</span> {h.reason}
                    </div>
                    {h.amountDeltaPaisa ? (
                      <div className="font-mono font-bold text-amber-700">
                        Amount delta: {formatDeltaBDT(h.amountDeltaPaisa)}
                      </div>
                    ) : null}
                    <div className="space-y-1 pt-1 border-t border-slate-200/70">
                      {h.changes.map((c, ci) => (
                        <div key={ci} className="flex flex-wrap items-baseline gap-1.5 font-mono text-[11px]">
                          <span className="font-semibold text-slate-500">{c.field}:</span>
                          <span className="text-rose-600 line-through">{c.from || '(empty)'}</span>
                          <span className="text-slate-400">→</span>
                          <span className="text-emerald-700 font-semibold">{c.to || '(empty)'}</span>
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {canVoid && voiding && (
            <form onSubmit={handleVoid} className="rounded-2xl border border-rose-200 bg-rose-50/70 p-4 space-y-2.5">
              <div className="text-xs font-bold text-rose-900">Void Entry to Admin Bin (Remains in Audit Log)</div>
              <input
                type="text"
                required
                placeholder="Mandatory reason for voiding this transaction..."
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                className="w-full h-10 px-3.5 text-sm bg-white border border-rose-300 rounded-xl focus:outline-none"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setVoiding(false)} className="h-8 px-3 text-xs text-slate-600">Cancel</button>
                <button disabled={busy} className="h-8 px-3.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold">Confirm Void</button>
              </div>
            </form>
          )}

          {flagging && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 space-y-2.5">
              <div className="text-xs font-bold text-amber-900">Flag Entry for Investigation</div>
              <input
                type="text"
                placeholder="What looks wrong or needs clarification?"
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                className="w-full h-10 px-3.5 text-sm bg-white border border-amber-300 rounded-xl focus:outline-none"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setFlagging(false)} className="h-8 px-3 text-xs text-slate-600">Cancel</button>
                <button disabled={busy} onClick={() => handleStatus('flagged', flagNote)} className="h-8 px-3.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold">Flag Entry</button>
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 py-3.5 border-t border-slate-100 bg-slate-50/50 flex flex-wrap items-center gap-2">
          {canEdit && (
            <button
              type="button"
              onClick={() => { onClose(); onEdit(tx); }}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-[#1b2a4e] hover:bg-slate-50 transition-colors"
            >
              <Edit3 className="w-3.5 h-3.5 text-brand-600" /> Edit
            </button>
          )}

          {canEdit && onDuplicate && (
            <button
              type="button"
              onClick={() => { onClose(); onDuplicate(tx); }}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-[#1b2a4e] hover:bg-slate-50 transition-colors"
            >
              <Copy className="w-3.5 h-3.5 text-slate-500" /> Repeat / Clone
            </button>
          )}

          {isAdmin && tx.status !== 'verified' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => handleStatus('verified', 'Approved & verified by Finance Admin')}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold transition-colors"
            >
              <CheckCircle2 className="w-3.5 h-3.5" /> Verify
            </button>
          )}

          {isAdmin && tx.status !== 'flagged' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setFlagging((v) => !v)}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-white border border-amber-200 text-amber-700 hover:bg-amber-50 text-xs font-semibold transition-colors"
            >
              <AlertTriangle className="w-3.5 h-3.5" /> Flag
            </button>
          )}

          {canVoid && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setVoiding((v) => !v)}
              className="ml-auto inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" /> Void
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
