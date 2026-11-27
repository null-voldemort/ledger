import React, { useState } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { wipeDatabase } from '../utils/cloud';

interface Props {
  onWiped: () => void;
  onFactoryReset?: () => void;
  onToast: (msg: string) => void;
}

export const DatabaseWipeCard: React.FC<Props> = ({ onWiped, onFactoryReset, onToast }) => {
  const [armed, setArmed] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [includeUsers, setIncludeUsers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = confirmText.trim().toUpperCase() === 'WIPE' && password.length > 0 && !busy;

  const handleReset = () => {
    setArmed(false);
    setConfirmText('');
    setPassword('');
    setIncludeUsers(false);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const res = await wipeDatabase(password, confirmText, includeUsers);
      handleReset();
      if (res.factoryReset) {
        onToast('Database & accounts wiped — starting fresh');
        onFactoryReset?.();
      } else {
        onWiped();
        onToast('Database wiped — ready for fresh entries');
      }
    } catch (err: any) {
      setError(err?.message || 'Could not wipe database.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-rose-200 bg-rose-50/50 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-rose-900 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            Wipe Database &amp; Start Fresh (Admin Only)
          </div>
          <p className="text-xs text-rose-800/80 mt-0.5">
            Deletes all transactions, staff profiles, salaries, loans, locks, voucher photos, and audit logs.
          </p>
        </div>
        {!armed && (
          <button
            type="button"
            onClick={() => { setArmed(true); setError(''); }}
            className="shrink-0 h-9 px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Wipe Database
          </button>
        )}
      </div>

      {armed && (
        <form onSubmit={handleSubmit} className="pt-3 border-t border-rose-200/80 space-y-3">
          {error && (
            <div role="alert" className="rounded-xl bg-white border border-rose-300 px-3 py-2 text-xs text-rose-700 font-medium">
              {error}
            </div>
          )}

          <label className="flex items-center gap-2 text-xs text-rose-900 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeUsers}
              onChange={(e) => setIncludeUsers(e.target.checked)}
              className="rounded border-rose-300 text-rose-600 focus:ring-rose-500"
            />
            <span>Also erase all user accounts &amp; return to First-Time Setup screen</span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <input
              type="text"
              required
              autoComplete="off"
              placeholder="Type WIPE to confirm"
              aria-label="Type WIPE to confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full h-10 px-3 text-xs font-mono bg-white border border-rose-200 rounded-xl focus:outline-none focus:border-rose-500"
            />
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="Confirm your Admin password"
              aria-label="Confirm your Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 text-xs bg-white border border-rose-200 rounded-xl focus:outline-none focus:border-rose-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={handleReset}
              className="h-9 rounded-xl bg-white border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="h-9 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {busy ? 'Wiping...' : 'Wipe Everything Now'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
};
