import React, { useEffect, useState } from 'react';
import { X, UserPlus, Shield, KeyRound, UserX, UserCheck, RefreshCw, RotateCcw, Shuffle, Users, Archive, Lock, Eye, EyeOff, Edit3, FileSpreadsheet } from 'lucide-react';
import { AppUser, AdminUserSummary, LedgerTransaction, SecurityEvent, UserRole } from '../types';
import { USER_ROLES, ROLE_DESCRIPTIONS, normalizeRole, roleLabel, roleOptionLabel } from '../utils/roles';
import { changePassword } from '../utils/auth';
import {
  adminUpdateUser,
  createUserAccount,
  disableUserAccount,
  listUsers,
  resetUserPassword,
  loadBin,
  restoreTransaction,
  loadSecurityLog,
} from '../utils/cloud';
import { formatStamp } from '../utils/activity';
import { formatBDT } from '../utils/money';
import { DatabaseWipeCard } from './DatabaseWipeCard';
import { ScrollLock } from './ScrollLock';
import { ImportWizard } from './ImportWizard';

const makePassword = () => {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
};

const EVENT_LABELS: Record<string, string> = {
  setup_admin: 'Initial Admin setup',
  login_ok: 'Signed in',
  login_failed: 'Wrong password',
  login_locked: 'Locked out',
  login_disabled: 'Disabled account tried',
  logout: 'Signed out',
  password_changed: 'Password changed',
  password_change_failed: 'Password change refused',
  password_reset: 'Password reset by admin',
  admin_confirm_failed: 'Wrong admin password',
  user_created: 'Account created',
  user_updated: 'Account updated by admin',
  username_changed: 'Username changed',
  user_disabled: 'Account disabled',
  user_enabled: 'Account enabled',
  restore: 'Backup restored',
  import_previewed: 'Excel import previewed',
  import_committed: 'Excel import completed',
  database_wiped: 'Database wiped (fresh start)',
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AppUser;
  onToast: (message: string) => void;
  onBinChanged: () => void;
  onUsersChanged?: () => void;
  onFactoryReset?: () => void;
}

export const AdminPanel: React.FC<Props> = ({ isOpen, onClose, currentUser, onToast, onBinChanged, onUsersChanged, onFactoryReset }) => {
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showCreatePwd, setShowCreatePwd] = useState(false);
  const [role, setRole] = useState<UserRole>('user');
  const [currentAdminPassword, setCurrentAdminPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPwd, setResetPwd] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('user');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [bin, setBin] = useState<LedgerTransaction[]>([]);
  const [binTotalCount, setBinTotalCount] = useState(0);
  const [binNextCursor, setBinNextCursor] = useState<string | null>(null);
  const [binMoreLoading, setBinMoreLoading] = useState(false);
  const [tab, setTab] = useState<'accounts' | 'bin' | 'security' | 'import'>('accounts');
  const [importOpen, setImportOpen] = useState(false);

  const load = async () => {
    try { setUsers(await listUsers()); } catch (e: any) { setError(e?.message || 'Could not load users.'); }
  };
  const loadTheBin = async () => {
    try {
      const page = await loadBin({ limit: 50 });
      setBin(page.items || []);
      setBinTotalCount(page.totalCount || 0);
      setBinNextCursor(page.nextCursor || null);
    } catch (e: any) { setError(e?.message || 'Could not load the bin.'); }
  };
  const loadMoreBin = async () => {
    if (!binNextCursor || binMoreLoading) return;
    setBinMoreLoading(true);
    try {
      const page = await loadBin({ limit: 50, cursor: binNextCursor });
      setBin((current) => [...current, ...page.items]);
      setBinTotalCount(page.totalCount || 0);
      setBinNextCursor(page.nextCursor || null);
    } catch (e: any) { setError(e?.message || 'Could not load more voided entries.'); }
    finally { setBinMoreLoading(false); }
  };
  const loadEvents = async () => {
    try { setEvents(await loadSecurityLog()); } catch (e: any) { setError(e?.message || 'Could not load security log.'); }
  };

  useEffect(() => {
    if (isOpen && currentUser.role === 'admin') { load(); loadTheBin(); }
  }, [isOpen, currentUser.role]);

  useEffect(() => {
    if (isOpen && currentUser.role === 'admin' && tab === 'security') loadEvents();
  }, [isOpen, currentUser.role, tab]);

  if (!isOpen || currentUser.role !== 'admin') return null;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return setError('Enter a username for the new account.');
    if (password.length < 10) return setError('Password must be at least 10 characters with letters and numbers.');
    setBusy(true); setError('');
    try {
      await createUserAccount('', username.trim(), password, (displayName || username).trim(), role);
      setUsername(''); setDisplayName(''); setPassword(''); setShowCreatePwd(false); setRole('user');
      await load();
      onToast('Account created');
    } catch (e: any) { setError(e?.message || 'Could not create user.'); }
    finally { setBusy(false); }
  };

  const toggle = async (u: AdminUserSummary) => {
    setBusy(true); setError('');
    try {
      await disableUserAccount('', u.id, !u.disabled);
      await load();
      onToast(u.disabled ? `${u.username} enabled` : `${u.username} disabled`);
    } catch (e: any) { setError(e?.message || 'Could not update account.'); }
    finally { setBusy(false); }
  };

  const doReset = async (u: AdminUserSummary) => {
    if (resetPwd.length < 10) return setError('New password must be at least 10 characters.');
    setBusy(true); setError('');
    try {
      await resetUserPassword(u.id, resetPwd);
      setResetId(null); setResetPwd('');
      await load();
      onToast(`Password reset for ${u.username}`);
    } catch (e: any) { setError(e?.message || 'Could not reset password.'); }
    finally { setBusy(false); }
  };

  const startEditUser = (u: AdminUserSummary) => {
    setResetId(null);
    setEditId(editId === u.id ? null : u.id);
    setEditUsername(u.username);
    setEditDisplayName(u.displayName);
    setEditRole(normalizeRole(u.role));
    setEditPhone(u.phoneNumber || '');
    setEditEmail(u.email || '');
    setError('');
  };

  const doEditUser = async (u: AdminUserSummary) => {
    if (editUsername.trim().length < 3) return setError('Username must be at least 3 characters.');
    if (!editDisplayName.trim()) return setError('Display name is required.');
    setBusy(true); setError('');
    try {
      await adminUpdateUser(u.id, {
        username: editUsername.trim(),
        displayName: editDisplayName.trim(),
        role: editRole,
        phoneNumber: editPhone.trim(),
        email: editEmail.trim(),
      });
      setEditId(null);
      await load();
      onUsersChanged?.();
      onToast(`Updated account ${editUsername.trim()}`);
    } catch (e: any) { setError(e?.message || 'Could not update account.'); }
    finally { setBusy(false); }
  };

  const doRestore = async (tx: LedgerTransaction) => {
    setBusy(true); setError('');
    try {
      await restoreTransaction(tx.id);
      await loadTheBin();
      onBinChanged();
      onToast(`${tx.voucherNo} restored`);
    } catch (e: any) { setError(e?.message || 'Restore failed.'); }
    finally { setBusy(false); }
  };

  const changeAdminPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentAdminPassword) return setError('Enter your current password.');
    if (adminPassword.length < 10) return setError('Admin password must be at least 10 characters.');
    if (adminPassword !== confirm) return setError('Passwords do not match.');
    setBusy(true); setError('');
    try {
      await changePassword(currentAdminPassword, adminPassword);
      setCurrentAdminPassword(''); setAdminPassword(''); setConfirm('');
      loadEvents();
      onToast('Admin password changed');
    } catch (e: any) { setError(e?.message || 'Could not change admin password.'); }
    finally { setBusy(false); }
  };

  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
  const field = 'h-10 px-3.5 text-sm text-slate-900 bg-white border border-slate-200 rounded-xl focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100 placeholder:text-slate-400';
  const ghostBtn = 'inline-flex items-center gap-1.5 h-8 px-3 text-xs font-semibold rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const dangerBtn = 'inline-flex items-center gap-1.5 h-8 px-3 text-xs font-semibold rounded-lg border border-rose-200 text-rose-700 bg-white hover:bg-rose-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const TABS = [
    { id: 'accounts' as const, label: 'Accounts', icon: Users, count: users.length },
    { id: 'bin' as const, label: 'Voided Bin', icon: Archive, count: binTotalCount },
    { id: 'import' as const, label: 'Excel Import', icon: FileSpreadsheet, count: undefined },
    { id: 'security' as const, label: 'Security Log', icon: Lock, count: undefined },
  ];

  return (
    <div className="no-print fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div role="dialog" aria-modal="true" aria-label="Administrator"
        className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden h-[min(44rem,90vh)] flex flex-col">
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <span className="grid place-items-center w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-700 text-white shadow-lg shadow-brand-600/30"><Shield className="w-5 h-5" /></span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-[#1b2a4e]">Administrator</h2>
            <p className="text-xs text-slate-500">User accounts and roles, voided entries, and security log</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <nav aria-label="Admin sections" className="shrink-0 md:w-56 border-b md:border-b-0 md:border-r border-slate-100 bg-slate-50/60 p-3 flex md:flex-col gap-1.5 overflow-x-auto">
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] whitespace-nowrap transition-colors ${active ? 'bg-brand-700 text-white font-semibold shadow-sm' : 'text-slate-600 hover:bg-white'}`}>
                  <t.icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1 text-left">{t.label}</span>
                  {t.count !== undefined && <span className={`text-[11px] tabular-nums px-1.5 rounded-full ${active ? 'bg-white/20 text-white' : 'bg-white text-slate-500 border border-slate-100'}`}>{t.count}</span>}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-5 sm:p-6 space-y-5">
            {error && (
              <div role="alert" className="flex items-start gap-2 text-[13px] text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-3.5 py-2.5">
                <span className="flex-1">{error}</span>
                <button onClick={() => setError('')} aria-label="Dismiss" className="text-rose-400 hover:text-rose-700"><X className="w-3.5 h-3.5" /></button>
              </div>
            )}

            {tab === 'accounts' && (
              <>
                <section className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 sm:p-5">
                  <h3 className="text-sm font-bold text-[#1b2a4e]">Create account</h3>
                  <p className="text-xs text-slate-500 mt-0.5 mb-3.5">Set the username, role, and initial sign-in password directly when creating the account.</p>
                  <form onSubmit={create} className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">Username *</label>
                        <input value={username} onChange={e => setUsername(e.target.value)} required placeholder="e.g. accounts" aria-label="Username" className={`${field} w-full`} />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">Display Name</label>
                        <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Rahim Uddin" aria-label="Display name" className={`${field} w-full`} />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">Role *</label>
                        <select value={role} onChange={e => setRole(e.target.value as UserRole)} aria-label="Role" className={`${field} w-full`}>
                          {USER_ROLES.map((r) => <option key={r} value={r}>{roleOptionLabel(r)}</option>)}
                        </select>
                        <p className="mt-1 text-[11px] text-slate-500">{ROLE_DESCRIPTIONS[role]}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2.5 items-end">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Initial Password * <span className="font-normal text-slate-400">(min 10 chars, letters + numbers)</span>
                        </label>
                        <div className="flex gap-1.5">
                          <div className="relative flex-1 min-w-0">
                            <input
                              type={showCreatePwd ? 'text' : 'password'}
                              value={password}
                              onChange={e => setPassword(e.target.value)}
                              required
                              autoComplete="new-password"
                              placeholder="Set sign-in password"
                              aria-label="Initial password"
                              className={`${field} w-full pr-10 font-mono`}
                            />
                            <button
                              type="button"
                              onClick={() => setShowCreatePwd(v => !v)}
                              aria-label={showCreatePwd ? 'Hide password' : 'Show password'}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg grid place-items-center text-slate-400 hover:text-slate-700"
                            >
                              {showCreatePwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => { setPassword(makePassword()); setShowCreatePwd(true); }}
                            title="Generate password"
                            className="shrink-0 h-10 px-3 inline-flex items-center gap-1.5 border border-slate-200 bg-white rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            <Shuffle className="w-3.5 h-3.5" /> Generate
                          </button>
                        </div>
                      </div>
                      <button
                        type="submit"
                        disabled={busy}
                        className="h-10 px-5 inline-flex items-center justify-center gap-2 bg-brand-700 hover:bg-brand-800 text-white rounded-xl text-sm font-semibold disabled:opacity-60 transition-colors"
                      >
                        <UserPlus className="w-4 h-4" /> Create Account
                      </button>
                    </div>
                  </form>
                </section>

                <section>
                  <h3 className="text-sm font-bold text-[#1b2a4e] mb-3">Accounts <span className="font-medium text-slate-400 tabular-nums">({users.length})</span></h3>
                  <ul className="space-y-2.5">
                    {users.map(u => {
                      const me = u.id === currentUser.id;
                      return (
                        <li key={u.id} className="rounded-2xl border border-slate-100 bg-white shadow-[0_8px_24px_-18px_rgba(30,50,110,0.3)]">
                          <div className="p-3.5 flex flex-wrap items-center gap-x-4 gap-y-3">
                            <span className={`grid place-items-center w-11 h-11 rounded-full text-sm font-bold shrink-0 ${u.disabled ? 'bg-slate-100 text-slate-400' : 'bg-brand-50 text-brand-700'}`}>{initials(u.displayName)}</span>
                            <div className="min-w-0 flex-1 basis-40">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-[#1b2a4e] truncate">{u.displayName}</span>
                                <span className="text-[11px] font-semibold text-slate-500">{roleLabel(u.role)}</span>
                                <span className="text-[11px] text-slate-400">· {u.disabled ? 'Disabled' : 'Active'}</span>
                              </div>
                              <div className="text-xs text-slate-500 font-mono truncate">{u.username} · {u.txCount || 0} entries</div>
                            </div>
                            <div className="flex flex-wrap gap-1.5 ml-auto">
                              <button disabled={busy} onClick={() => startEditUser(u)} className={ghostBtn}><Edit3 className="w-3.5 h-3.5" />Edit</button>
                              <button disabled={busy || me} onClick={() => { setEditId(null); setResetId(resetId === u.id ? null : u.id); setResetPwd(''); }} className={ghostBtn}><KeyRound className="w-3.5 h-3.5" />Reset</button>
                              <button disabled={busy || me} onClick={() => toggle(u)} className={u.disabled ? ghostBtn : dangerBtn}>
                                {u.disabled ? <UserCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}{u.disabled ? 'Enable' : 'Disable'}
                              </button>
                            </div>
                          </div>
                          {editId === u.id && (
                            <div className="px-3.5 pb-3.5 pt-3 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl space-y-2.5">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <input value={editUsername} onChange={(e) => setEditUsername(e.target.value)} placeholder="Username" aria-label="Edit username" className={`${field} h-9 font-mono w-full`} />
                                <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} placeholder="Display name" aria-label="Edit display name" className={`${field} h-9 w-full`} />
                                <select value={editRole} disabled={me} onChange={(e) => setEditRole(e.target.value as UserRole)} aria-label="Edit role" className={`${field} h-9 w-full disabled:opacity-60`}>
                                  {USER_ROLES.map((r) => <option key={r} value={r}>{roleOptionLabel(r)}</option>)}
                                </select>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="Phone (optional)" aria-label="Edit phone" className={`${field} h-9 flex-1 min-w-[140px]`} />
                                <input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="Email (optional)" aria-label="Edit email" className={`${field} h-9 flex-1 min-w-[160px]`} />
                                <button type="button" disabled={busy} onClick={() => doEditUser(u)} className="h-9 px-3.5 bg-brand-700 hover:bg-brand-800 text-white rounded-lg text-xs font-semibold disabled:opacity-50">Save</button>
                                <button type="button" onClick={() => setEditId(null)} className="h-9 px-3 text-xs text-slate-500 hover:text-slate-800">Cancel</button>
                              </div>
                            </div>
                          )}
                          {resetId === u.id && (
                            <div className="px-3.5 pb-3.5 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2 bg-slate-50/60 rounded-b-2xl">
                              <input value={resetPwd} onChange={e => setResetPwd(e.target.value)} placeholder="New password (10+ characters)" aria-label="New password" className={`${field} h-9 w-64 font-mono`} />
                              <button type="button" onClick={() => setResetPwd(makePassword())} className={ghostBtn}><Shuffle className="w-3.5 h-3.5" />Generate</button>
                              <button type="button" disabled={busy} onClick={() => doReset(u)} className="h-8 px-3.5 bg-brand-700 hover:bg-brand-800 text-white rounded-lg text-xs font-semibold disabled:opacity-50">Set password</button>
                              <button type="button" onClick={() => setResetId(null)} className="h-8 px-3 text-xs text-slate-500 hover:text-slate-800">Cancel</button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </>
            )}

            {tab === 'bin' && (
              <section>
                <div className="flex items-center justify-between mb-1 gap-3">
                  <h3 className="text-sm font-bold text-[#1b2a4e]">Voided Transactions Bin <span className="font-medium text-slate-400 tabular-nums">({binTotalCount})</span></h3>
                  <button type="button" onClick={loadTheBin} className={ghostBtn}><RefreshCw className="w-3.5 h-3.5" />Refresh</button>
                </div>
                <p className="text-xs text-slate-500 mb-3.5">For audit integrity, entries are never permanently erased. Voided transactions stay here with their reason and remain in the cryptographic audit trail.</p>
                {bin.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 px-4 py-14 text-center">
                    <span className="mx-auto mb-2 grid place-items-center w-11 h-11 rounded-full bg-white text-slate-300 border border-slate-100"><Archive className="w-5 h-5" /></span>
                    <p className="text-sm font-semibold text-slate-600">No voided entries</p>
                  </div>
                ) : (
                  <>
                  <ul className="space-y-2">
                    {bin.map(tx => (
                      <li key={tx.id} className="rounded-2xl border border-slate-100 bg-white p-3.5 flex flex-wrap items-center gap-3">
                        <div className="flex-1 basis-64 min-w-0">
                          <div className="text-[13px] font-semibold text-[#1b2a4e] truncate">{tx.voucherNo} · {tx.head} · {formatBDT(tx.amountPaisa)}</div>
                          <div className="text-xs text-slate-500 truncate">Voided by {tx.deletedBy} ({formatStamp(tx.deletedAt)}) — Reason: {tx.deleteReason}</div>
                        </div>
                        <button disabled={busy} onClick={() => doRestore(tx)} className={ghostBtn}><RotateCcw className="w-3.5 h-3.5" />Restore</button>
                      </li>
                    ))}
                  </ul>
                  {binNextCursor && (
                    <div className="flex items-center justify-between gap-3 mt-3 text-xs">
                      <span className="text-slate-500">Showing {bin.length} of {binTotalCount}</span>
                      <button type="button" disabled={binMoreLoading} onClick={() => void loadMoreBin()} className={ghostBtn}>
                        {binMoreLoading ? 'Loading…' : 'Load more'}
                      </button>
                    </div>
                  )}
                  </>
                )}
              </section>
            )}

            {tab === 'import' && (
              <section className="max-w-2xl space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-[#1b2a4e]">Import existing records from Excel</h3>
                  <p className="mt-1 text-[13px] text-slate-600">
                    Upload your Income &amp; Expense workbook. You first get a full preview of exactly what would be saved: money in and out,
                    employees, salary payments, loans and rent. Correct anything in place, then confirm with your admin password.
                    Nothing is saved before that, and a confirmed import is saved all together or not at all.
                  </p>
                </div>
                <ul className="text-[13px] text-slate-600 list-disc pl-5 space-y-1">
                  <li>Salary, advance and loan payments that also appear in the cash book are counted once, not twice.</li>
                  <li>Anything the sheet does not say (category, payment method, who it was paid to) is suggested and highlighted for you to confirm.</li>
                  <li>Every record goes through the normal audit trail, and the same file cannot be imported twice.</li>
                </ul>
                <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold">
                  <FileSpreadsheet className="w-4 h-4" /> Start an import
                </button>
              </section>
            )}

            {tab === 'security' && (
              <div className="space-y-4">
                <form onSubmit={changeAdminPassword} className="rounded-2xl border border-slate-100 bg-white shadow-[0_8px_24px_-18px_rgba(30,50,110,0.3)] p-5">
                  <h3 className="text-sm font-bold text-[#1b2a4e] flex items-center gap-2"><span className="grid place-items-center w-8 h-8 rounded-xl bg-brand-50 text-brand-700"><KeyRound className="w-4 h-4" /></span>Change admin password</h3>
                  <p className="text-xs text-slate-500 mt-2 mb-4">After changing, all other sessions for this account are signed out.</p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    <input value={currentAdminPassword} onChange={e => setCurrentAdminPassword(e.target.value)} type="password" autoComplete="current-password" required placeholder="Current password" className={`${field} w-full`} />
                    <input value={adminPassword} onChange={e => setAdminPassword(e.target.value)} type="password" minLength={10} required placeholder="New password" className={`${field} w-full`} />
                    <input value={confirm} onChange={e => setConfirm(e.target.value)} type="password" minLength={10} required placeholder="Repeat new password" className={`${field} w-full`} />
                    <button disabled={busy} className="w-full h-10 bg-brand-700 hover:bg-brand-800 text-white rounded-xl text-sm font-semibold disabled:opacity-60 transition-colors">Change password</button>
                  </div>
                </form>

                <section className="rounded-2xl border border-slate-100 bg-white shadow-[0_8px_24px_-18px_rgba(30,50,110,0.3)] p-5">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <h3 className="text-sm font-bold text-[#1b2a4e] flex items-center gap-2"><span className="grid place-items-center w-8 h-8 rounded-xl bg-brand-50 text-brand-700"><Shield className="w-4 h-4" /></span>Security log</h3>
                    <button type="button" onClick={loadEvents} className={ghostBtn}><RefreshCw className="w-3.5 h-3.5" />Refresh</button>
                  </div>
                  {events.length === 0 ? (
                    <p className="text-sm text-slate-500 py-4 text-center">Nothing recorded yet.</p>
                  ) : (
                    <div className="max-h-72 overflow-auto rounded-xl border border-slate-100">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                          <tr><th className="px-3 py-2 font-semibold">When</th><th className="px-3 py-2 font-semibold">Event</th><th className="px-3 py-2 font-semibold">Account</th><th className="px-3 py-2 font-semibold">IP</th><th className="px-3 py-2 font-semibold">Detail</th></tr>
                        </thead>
                        <tbody>
                          {events.map((ev) => (
                            <tr key={ev.id} className="border-t border-slate-100 align-top">
                              <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatStamp(ev.at)}</td>
                              <td className={`px-3 py-2 whitespace-nowrap font-semibold ${/failed|locked|disabled/.test(ev.type) ? 'text-rose-700' : 'text-slate-800'}`}>{EVENT_LABELS[ev.type] || ev.type}</td>
                              <td className="px-3 py-2 text-slate-700">{ev.username || '-'}</td>
                              <td className="px-3 py-2 text-slate-600 whitespace-nowrap font-mono">{ev.ip || '-'}</td>
                              <td className="px-3 py-2 text-slate-500">{ev.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <DatabaseWipeCard
                  onWiped={() => {
                    loadTheBin();
                    loadEvents();
                    onBinChanged();
                  }}
                  onFactoryReset={() => {
                    onClose();
                    onFactoryReset?.();
                  }}
                  onToast={onToast}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {importOpen && <ImportWizard onClose={() => setImportOpen(false)} onDone={() => { onToast('Excel import complete.'); onBinChanged(); }} />}
    </div>
  );
};
