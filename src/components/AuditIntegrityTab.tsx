import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import type {
  AuditChainEntry,
  ChainVerificationResult,
  LedgerTransaction,
  PeriodLock,
} from '../types';
import { dhakaMonth } from '../utils/ledger';
import { formatBDT, formatDeltaBDT } from '../utils/money';
import { formatStamp } from '../utils/activity';
import { lockPeriod, unlockPeriod } from '../utils/cloud';
import { roleLabel } from '../utils/roles';

interface Props {
  audit: AuditChainEntry[];
  verification: ChainVerificationResult | null;
  locks: PeriodLock[];
  transactions: LedgerTransaction[];
  isAdmin: boolean;
  onVerifyNow: () => Promise<void>;
  onLocksChanged: () => void;
  onOpenTx: (tx: LedgerTransaction) => void;
  onOpenTxId: (id: string) => void;
  onToast: (msg: string) => void;
}

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';

export const AuditIntegrityTab: React.FC<Props> = ({
  audit,
  verification,
  locks,
  transactions,
  isAdmin,
  onVerifyNow,
  onLocksChanged,
  onOpenTx,
  onOpenTxId,
  onToast,
}) => {
  const [verifying, setVerifying] = useState(false);
  const [lockMonth, setLockMonth] = useState(dhakaMonth);
  const [lockNote, setLockNote] = useState('');
  const [unlockingKey, setUnlockingKey] = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const numericEdits = useMemo(
    () =>
      audit.filter(
        (a) => a.eventType === 'tx_edited' || a.eventType === 'tx_voided' || a.eventType === 'tx_restored',
      ),
    [audit],
  );

  const runVerify = async () => {
    setVerifying(true);
    try {
      await onVerifyNow();
      onToast('Cryptographic audit chain verified');
    } finally {
      setVerifying(false);
    }
  };

  const handleLock = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await lockPeriod(lockMonth, lockNote.trim() || 'Signed off by Finance Admin');
      setLockNote('');
      onLocksChanged();
      onToast(`Month ${lockMonth} locked`);
    } catch (err: any) {
      setError(err?.message || 'Could not lock period.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockingKey) return;
    setBusy(true);
    setError('');
    try {
      await unlockPeriod(unlockingKey, unlockReason.trim(), unlockPassword);
      setUnlockingKey(null);
      setUnlockReason('');
      setUnlockPassword('');
      onLocksChanged();
      onToast(`Month ${unlockingKey} unlocked`);
    } catch (err: any) {
      setError(err?.message || 'Could not unlock period.');
    } finally {
      setBusy(false);
    }
  };

  const openById = (txId: string) => {
    const found = transactions.find((t) => t.id === txId);
    if (found) onOpenTx(found);
    else onOpenTxId(txId);
  };

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className={`font-display text-2xl font-extrabold tracking-tight ${INK}`}>
            Audit Trail &amp; Anti-Falsification Integrity
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Every transaction creation, edit, amount change, void, and lock is sealed in a SHA-256 hash chain that detects any silent alteration.
          </p>
        </div>

        <button
          type="button"
          disabled={verifying}
          onClick={runVerify}
          className="h-10 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-2 shadow-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${verifying ? 'animate-spin' : ''}`} />
          Verify Cryptographic Chain Now
        </button>
      </div>

      
      <section
        className={`rounded-3xl border p-5 flex flex-wrap items-center justify-between gap-4 ${
          verification?.ok === false
            ? 'bg-rose-50 border-rose-200 text-rose-950'
            : 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
        }`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`grid place-items-center w-11 h-11 rounded-2xl shrink-0 ${
              verification?.ok === false ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'
            }`}
          >
            {verification?.ok === false ? <ShieldAlert className="w-6 h-6" /> : <ShieldCheck className="w-6 h-6" />}
          </span>
          <div>
            <h2 className="text-base font-bold">
              {verification?.ok === false
                ? 'TAMPER ALERT: Database state or hash chain mismatch detected'
                : verification?.ok === true
                  ? 'Ledger Hash Chain Verified — Zero Unrecorded Edits'
                  : 'Audit verification has not completed yet'}
            </h2>
            <p className="text-xs opacity-80 mt-0.5">
              {verification
                ? `${verification.totalEntries} immutable audit blocks verified · Checked ${formatStamp(verification.checkedAt)}`
                : 'The cryptographic hash-chain check runs when this page opens or when you select Verify.'}
            </p>
            {verification && verification.brokenLinks.length > 0 && (
              <ul className="mt-2 text-xs text-rose-700 font-mono space-y-1">
                {verification.brokenLinks.map((b, i) => (
                  <li key={i}>Block #{b.seq} ({b.voucherNo}): {b.issue}</li>
                ))}
              </ul>
            )}
            {verification && verification.stateMismatches.length > 0 && (
              <ul className="mt-2 text-xs text-rose-700 font-mono space-y-1">
                {verification.stateMismatches.map((m, i) => (
                  <li key={i}>Voucher {m.voucherNo}: {m.issue}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {error && (
        <div role="alert" className="rounded-2xl bg-rose-50 border border-rose-200 px-4 py-3 text-xs text-rose-700 font-medium">
          {error}
        </div>
      )}

      
      <div className="grid grid-cols-1 @5xl:grid-cols-3 gap-5 items-start">
        <section className={`${SURFACE} @5xl:col-span-2 overflow-hidden`}>
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className={`text-sm font-bold ${INK} flex items-center gap-2`}>
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                Edited &amp; Voided Entries Watchlist ({numericEdits.length})
              </h2>
              <p className="text-xs text-slate-500">Shows exact before/after field values, Taka delta, actor, and stated reason.</p>
            </div>
          </div>
          {numericEdits.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              No entries have been edited or voided yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 max-h-[28rem] overflow-y-auto">
              {numericEdits.map((ev) => (
                <div key={ev.seq} className="p-4 space-y-1.5 hover:bg-slate-50/70">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openById(ev.entryId)}
                        className={`font-mono font-bold hover:underline ${INK}`}
                      >
                        {ev.voucherNo}
                      </button>
                      <span className="text-slate-400">·</span>
                      <span className="font-semibold text-slate-700">{ev.eventType.replace('tx_', '').toUpperCase()}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-600">{ev.actorName} ({roleLabel(ev.actorRole)})</span>
                    </div>
                    <span className="text-[11px] text-slate-400">{formatStamp(ev.at)}</span>
                  </div>
                  <div className="text-xs text-slate-700">
                    <b>Reason:</b> {ev.reason || '—'}
                  </div>
                  {ev.amountDeltaPaisa ? (
                    <div className="text-xs font-mono font-bold text-amber-700">
                      Amount changed by {formatDeltaBDT(ev.amountDeltaPaisa)}
                    </div>
                  ) : null}
                  {ev.diff.length > 0 && (
                    <div className="pt-1 space-y-0.5 font-mono text-[11px]">
                      {ev.diff.map((d, idx) => (
                        <div key={idx} className="flex flex-wrap items-baseline gap-1.5">
                          <span className="text-slate-500 font-semibold">{d.field}:</span>
                          <span className="text-rose-600 line-through">{d.from || '(empty)'}</span>
                          <span className="text-slate-400">→</span>
                          <span className="text-emerald-700 font-semibold">{d.to || '(empty)'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        
        <section className={`${SURFACE} p-5 space-y-4`}>
          <div>
            <h2 className={`text-sm font-bold ${INK} flex items-center gap-2`}>
              <Lock className="w-4 h-4 text-brand-600" />
              Monthly Period Locks ({locks.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Once Finance Admin locks a month, nobody can add, alter, or void entries inside that closed statement.
            </p>
          </div>

          {isAdmin && (
            <form onSubmit={handleLock} className="space-y-2 rounded-2xl bg-slate-50 p-3.5 border border-slate-100">
              <div className="text-xs font-bold text-[#1b2a4e]">Lock &amp; Sign Off a Month</div>
              <input
                type="month"
                required
                value={lockMonth}
                onChange={(e) => setLockMonth(e.target.value)}
                className="w-full h-9 px-3 text-xs bg-white border border-slate-200 rounded-xl"
              />
              <input
                type="text"
                placeholder="Sign-off note (optional)"
                value={lockNote}
                onChange={(e) => setLockNote(e.target.value)}
                className="w-full h-9 px-3 text-xs bg-white border border-slate-200 rounded-xl"
              />
              <button
                disabled={busy}
                className="w-full h-9 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-50"
              >
                Lock {lockMonth}
              </button>
            </form>
          )}

          <div className="space-y-2">
            {locks.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-4">No months locked yet.</p>
            ) : (
              locks.map((l) => (
                <div key={l.id} className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-bold ${INK} flex items-center gap-1`}>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> {l.label} ({l.periodKey})
                    </span>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => setUnlockingKey(unlockingKey === l.periodKey ? null : l.periodKey)}
                        className="text-[11px] font-semibold text-rose-700 hover:underline inline-flex items-center gap-1"
                      >
                        <Unlock className="w-3 h-3" /> Unlock
                      </button>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-600 tabular-nums">
                    Income: {formatBDT(l.incomePaisa)} · Expense: {formatBDT(l.expensePaisa)} · Closing: <b>{formatBDT(l.closingPaisa)}</b>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Locked by {l.lockedByName} on {formatStamp(l.lockedAt)}
                  </div>
                  {unlockingKey === l.periodKey && (
                    <form onSubmit={handleUnlock} className="pt-2 border-t border-emerald-200 space-y-1.5">
                      <input
                        type="text"
                        required
                        placeholder="Mandatory unlock reason..."
                        value={unlockReason}
                        onChange={(e) => setUnlockReason(e.target.value)}
                        className="w-full h-8 px-2.5 text-xs bg-white border border-rose-200 rounded-lg"
                      />
                      <input
                        type="password"
                        required
                        placeholder="Confirm Admin password"
                        value={unlockPassword}
                        onChange={(e) => setUnlockPassword(e.target.value)}
                        className="w-full h-8 px-2.5 text-xs bg-white border border-rose-200 rounded-lg"
                      />
                      <button disabled={busy} className="w-full h-8 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold">
                        Confirm Unlock
                      </button>
                    </form>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      
      <section className={`${SURFACE} overflow-hidden`}>
        <div className="px-5 py-4 border-b border-slate-100">
          <h2 className={`text-sm font-bold ${INK}`}>Immutable SHA-256 Audit Chain ({audit.length} blocks)</h2>
        </div>
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Block</th>
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">Event &amp; Voucher</th>
                <th className="px-4 py-2.5">Actor</th>
                <th className="px-4 py-2.5">Reason / Detail</th>
                <th className="px-4 py-2.5">SHA-256 Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {audit.map((b) => (
                <tr key={b.seq} className="hover:bg-slate-50/70">
                  <td className="px-4 py-2.5 font-mono font-bold text-slate-500 tabular-nums">#{b.seq}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-500">{formatStamp(b.at)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <span className="font-semibold text-[#1b2a4e]">{b.eventType}</span>
                    {b.voucherNo && <span className="ml-2 font-mono text-brand-700">{b.voucherNo}</span>}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-700">{b.actorName}</td>
                  <td className="px-4 py-2.5 text-slate-600 max-w-md truncate">{b.reason || '—'}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{b.entryHash.slice(0, 16)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
