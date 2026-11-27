import React, { useRef, useState } from 'react';
import { Database, Download, Upload, X } from 'lucide-react';
import { downloadFullBackup, downloadSqliteBackup, restoreFullBackup, restoreSqliteBackup } from '../utils/cloud';
import { DatabaseWipeCard } from './DatabaseWipeCard';
import { ScrollLock } from './ScrollLock';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  isAdmin: boolean;
  onRestored: () => void;
  onFactoryReset?: () => void;
  onToast: (msg: string) => void;
}

export const BackupModal: React.FC<Props> = ({ isOpen, onClose, isAdmin, onRestored, onFactoryReset, onToast }) => {
  const [parsedBackup, setParsedBackup] = useState<any>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleDownload = async () => {
    setBusy(true);
    setError('');
    try {
      await downloadFullBackup();
      onToast('JSON backup download started');
    } catch (err: any) {
      setError(err?.message || 'Backup export failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    fileReaderRef.current?.abort();
    fileReaderRef.current = null;
    setError('');
    setFileName(file.name);
    setRestoreFile(file);
    setParsedBackup(null);
    if (/\.(sqlite|sqlite3|db)$/i.test(file.name) || file.type === 'application/vnd.sqlite3') return;
    const reader = new FileReader();
    fileReaderRef.current = reader;
    reader.onload = () => {
      if (fileReaderRef.current !== reader) return;
      fileReaderRef.current = null;
      try {
        const json = JSON.parse(String(reader.result || ''));
        if (!json || json.format !== 'pace-it-ledger-backup' || !json.tables) {
          setError('Selected file is not a valid Pace IT Ledger full backup.');
          setParsedBackup(null);
          setRestoreFile(null);
          return;
        }
        setParsedBackup(json);
      } catch {
        setError('Could not parse JSON backup file.');
        setParsedBackup(null);
        setRestoreFile(null);
      }
    };
    reader.onerror = () => {
      if (fileReaderRef.current === reader) {
        fileReaderRef.current = null;
        setError('Could not read the selected backup file.');
        setParsedBackup(null);
        setRestoreFile(null);
      }
    };
    reader.readAsText(file);
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    const sqliteFile = Boolean(restoreFile && (/\.(sqlite|sqlite3|db)$/i.test(restoreFile.name) || restoreFile.type === 'application/vnd.sqlite3'));
    if (!sqliteFile && !parsedBackup) return;
    setBusy(true);
    setError('');
    try {
      if (sqliteFile && restoreFile) {
        const result = await restoreSqliteBackup(restoreFile, password);
        onToast(`SQLite backup restored — ${result.transactionCount.toLocaleString()} transactions`);
      } else if (parsedBackup) {
        await restoreFullBackup(parsedBackup, password);
        onToast('JSON backup restored — reloading data');
      } else {
        throw new Error('Select a valid SQLite or JSON backup file.');
      }
      onRestored();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Restore failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Database Backup and Restore"
        className="bg-white w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl shadow-2xl border border-slate-100 p-6 space-y-4"
      >
        <div className="flex items-center gap-3">
          <span className="grid place-items-center w-10 h-10 rounded-2xl bg-brand-50 text-brand-700">
            <Database className="w-5 h-5" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[#1b2a4e]">Database &amp; Backup</h2>
            <p className="text-xs text-slate-500">Export, restore, or reset the ledger, staff, receipts, and hash chain.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700">{error}</div>}

        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-[#1b2a4e]">Download Full SQLite Backup</div>
            <div className="text-xs text-slate-600">Recommended for large ledgers. Snapshot is made by SQLite and downloaded as a file without buffering it in the browser.</div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true); setError('');
              try { await downloadSqliteBackup(); onToast('SQLite ledger backup download started'); }
              catch (err: any) { setError(err?.message || 'SQLite backup export failed.'); }
              finally { setBusy(false); }
            }}
            className="shrink-0 h-10 px-4 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> Download
          </button>
        </div>

        <div className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-bold text-[#1b2a4e]">Download Full JSON Backup (legacy)</div>
            <div className="text-xs text-slate-500">Compatible with earlier backup files; large databases should use SQLite format.</div>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={handleDownload}
            className="shrink-0 h-10 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> JSON
          </button>
        </div>

        {isAdmin && (
          <>
            <form onSubmit={handleRestore} className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 space-y-3">
              <div>
                <div className="text-sm font-bold text-[#1b2a4e]">Restore from Full Backup (Admin Only)</div>
                <div className="text-xs text-slate-600">SQLite restores are streamed to disk, integrity-checked, and keep the current database as a pre-restore file. They require the same installation's audit-signing key. Legacy JSON restores remain available for smaller backups.</div>
              </div>
              <label className="h-10 px-3.5 rounded-xl border border-dashed border-amber-300 bg-white flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <Upload className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="truncate">{fileName || 'Choose a .sqlite or legacy .json backup'}</span>
                <input type="file" accept="application/json,.json,.sqlite,.sqlite3,.db,application/vnd.sqlite3" onChange={handleFile} className="hidden" />
              </label>
              {(parsedBackup || (restoreFile && (/\.(sqlite|sqlite3|db)$/i.test(restoreFile.name) || restoreFile.type === 'application/vnd.sqlite3'))) && (
                <>
                  <input
                    type="password"
                    required
                    placeholder="Confirm your Admin password to restore"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full h-10 px-3 text-xs bg-white border border-amber-300 rounded-xl"
                  />
                  <button disabled={busy || (!parsedBackup && !(restoreFile && (/\.(sqlite|sqlite3|db)$/i.test(restoreFile.name) || restoreFile.type === 'application/vnd.sqlite3')))} className="w-full h-10 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50">
                    {busy ? 'Restoring...' : 'Restore Database Snapshot'}
                  </button>
                </>
              )}
            </form>

            <DatabaseWipeCard
              onWiped={() => { onRestored(); onClose(); }}
              onFactoryReset={() => { onClose(); onFactoryReset?.(); }}
              onToast={onToast}
            />
          </>
        )}
      </div>
    </div>
  );
};
