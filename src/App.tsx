import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityEvent,
  AppUser,
  AuditChainEntry,
  ChainVerificationResult,
  DepartmentRecord,
  Employee,
  EmployeeLoan,
  EmployeeSpendStat,
  EmployeeAdvance,
  FundSource,
  LedgerHead,
  LedgerKind,
  LedgerTransaction,
  PeriodLock,
  RentItem,
  RentPayment,
  SalaryPayment,
} from './types';
import { type LedgerView } from './components/Sidebar';
import { AppShell } from './components/AppShell';
import { Dashboard } from './components/Dashboard';
import { StatementSheet } from './components/StatementSheet';
import { TransactionsLedger } from './components/TransactionsLedger';
import { RentTab } from './components/RentTab';
import { EmployeesTab } from './components/EmployeesTab';
import { EmployeeProfileModal } from './components/EmployeeProfileModal';
import { SalaryTab } from './components/SalaryTab';
import { LoansTab } from './components/LoansTab';
import { AuditIntegrityTab } from './components/AuditIntegrityTab';
import { TransactionModal } from './components/TransactionModal';
import { FundsTab } from './components/FundsTab';
import { TransactionDetailModal } from './components/TransactionDetailModal';
import { MaintenanceOverlay } from './components/MaintenanceOverlay';
import {
  loadActivity,
  loadAuditChain,
  loadDepartments,
  loadEmployees,
  loadFundSources,
  loadAdvances,
  loadHeads,
  loadLoans,
  loadEmployeeSpendStats,
  loadTransaction,
  loadPeriodLocks,
  loadRentItems,
  loadRentPayments,
  loadSalaries,
  loadTransactions,
  loadUserAvatars,
  subscribeToCloud,
  verifyAuditChain,
} from './utils/cloud';
import { changePassword, getCurrentUser, updatePreferences } from './utils/auth';
import { canEditRole } from './utils/roles';
import { hideSplash } from './utils/splash';
import { applyTheme, getTheme, type Theme } from './utils/theme';
import { createLatestSaver } from './utils/latestSaver';
import { lazyNamed } from './utils/lazyNamed';

const ActivityModal = lazyNamed(() => import('./components/ActivityModal'), 'ActivityModal');
const AdminPanel = lazyNamed(() => import('./components/AdminPanel'), 'AdminPanel');
const BackupModal = lazyNamed(() => import('./components/BackupModal'), 'BackupModal');
const ChangePasswordModal = lazyNamed(() => import('./components/ChangePasswordModal'), 'ChangePasswordModal');
const HeadsModal = lazyNamed(() => import('./components/HeadsModal'), 'HeadsModal');
const ProfileModal = lazyNamed(() => import('./components/ProfileModal'), 'ProfileModal');

const VIEWS: LedgerView[] = ['home', 'ledger', 'sheet', 'rent', 'employees', 'salary', 'loans', 'funds', 'audit'];

// The current page lives in the URL hash (#ledger, #salary, ...) so a browser refresh, or the back/forward
// buttons, keep you on the same page instead of dropping you on the dashboard.
function viewFromHash(): LedgerView {
  const h = window.location.hash.replace(/^#\/?/, '');
  return (VIEWS as string[]).includes(h) ? (h as LedgerView) : 'home';
}

interface AppProps {
  currentUser: AppUser;
  onLock: () => void;
}

export default function App({ currentUser, onLock }: AppProps) {
  const [user, setUser] = useState<AppUser>(currentUser);
  useEffect(() => setUser(currentUser), [currentUser]);

  const isAdmin = user.role === 'admin';
  // Admin and accountant may enter, edit and void. Every other role is read-only.
  const canEdit = canEditRole(user.role);

  const [currentView, setCurrentView] = useState<LedgerView>(viewFromHash);
  const activeView: LedgerView = VIEWS.includes(currentView) ? currentView : 'home';

  useEffect(() => {
    if (viewFromHash() !== activeView) window.history.pushState(null, '', `#${activeView}`);
  }, [activeView]);
  useEffect(() => {
    const onHash = () => setCurrentView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  const lastUserIdRef = useRef(user.id);
  useEffect(() => {
    if (lastUserIdRef.current === user.id) return;
    lastUserIdRef.current = user.id;
    setCurrentView('home');
  }, [user.id]);

  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [employeeStats, setEmployeeStats] = useState<EmployeeSpendStat[]>([]);
  const [flaggedCount, setFlaggedCount] = useState(0);
  const [loadedDetailTx, setLoadedDetailTx] = useState<LedgerTransaction | null>(null);
  const [heads, setHeads] = useState<LedgerHead[]>([]);
  const [departments, setDepartments] = useState<DepartmentRecord[]>([]);
  const [locks, setLocks] = useState<PeriodLock[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [salaries, setSalaries] = useState<SalaryPayment[]>([]);
  const [loans, setLoans] = useState<EmployeeLoan[]>([]);
  const [advances, setAdvances] = useState<EmployeeAdvance[]>([]);
  const [rentItems, setRentItems] = useState<RentItem[]>([]);
  const [rentPayments, setRentPayments] = useState<RentPayment[]>([]);
  const [fundSources, setFundSources] = useState<FundSource[]>([]);
  const [audit, setAudit] = useState<AuditChainEntry[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const [verification, setVerification] = useState<ChainVerificationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [maintenance, setMaintenance] = useState<{ on: boolean; since?: number }>({ on: false });

  useEffect(() => {
    if (!loading) hideSplash();
  }, [loading]);

  const [txModal, setTxModal] = useState<{
    open: boolean;
    kind: LedgerKind;
    head?: string;
    editing: LedgerTransaction | null;
    duplicating: LedgerTransaction | null;
  }>({
    open: false,
    kind: 'expense',
    editing: null,
    duplicating: null,
  });
  const [detailTxId, setDetailTxId] = useState<string | null>(null);
  const [profileEmpId, setProfileEmpId] = useState<string | null>(null);
  const [editingEmp, setEditingEmp] = useState<Employee | null>(null);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [isHeadsOpen, setIsHeadsOpen] = useState(false);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isBackupOpen, setIsBackupOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 2800);
  }, []);

  useEffect(() => {
    if (user.theme) applyTheme(user.theme);
  }, [user.theme]);

  const saveTheme = useMemo(
    () => createLatestSaver<Theme>(updatePreferences, (e) => showToast((e as Error)?.message || 'Could not save theme preference')),
    [showToast],
  );
  const handleToggleTheme = useCallback((e?: React.MouseEvent<HTMLElement>) => {
    const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
    // The new theme grows out of the button that was clicked.
    const rect = e?.currentTarget?.getBoundingClientRect?.();
    applyTheme(next, rect ? { origin: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } } : undefined);
    saveTheme(next);
  }, [saveTheme]);

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const refreshTransactions = useCallback(async () => {
    try {
      const d = await loadTransactions({ limit: 50 });
      setTransactions((prev) => (same(prev, d.items) ? prev : d.items));
    } catch {   }
  }, []);

  const refreshHeads = useCallback(async () => {
    try {
      const d = await loadHeads();
      setHeads((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshDepartments = useCallback(async () => {
    try {
      const d = await loadDepartments();
      setDepartments((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshLocks = useCallback(async () => {
    try {
      const d = await loadPeriodLocks();
      setLocks((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshEmployees = useCallback(async () => {
    try {
      const d = await loadEmployees();
      setEmployees((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshEmployeeStats = useCallback(async () => {
    try {
      const d = await loadEmployeeSpendStats();
      setEmployeeStats((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshFlaggedCount = useCallback(async () => {
    try {
      const d = await loadTransactions({ limit: 1, auditFilter: 'flagged_or_changed' });
      setFlaggedCount(d.totalCount);
    } catch {   }
  }, []);

  const refreshSalaries = useCallback(async () => {
    try {
      const d = await loadSalaries();
      setSalaries((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshLoans = useCallback(async () => {
    try {
      const d = await loadLoans();
      setLoans((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshAdvances = useCallback(async () => {
    try {
      const d = await loadAdvances();
      setAdvances((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshRentItems = useCallback(async () => {
    try {
      const d = await loadRentItems();
      setRentItems((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshRentPayments = useCallback(async () => {
    try {
      const d = await loadRentPayments();
      setRentPayments((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshFundSources = useCallback(async () => {
    try {
      const d = await loadFundSources();
      setFundSources((prev) => (same(prev, d) ? prev : d));
    } catch {   }
  }, []);

  const refreshAuditList = useCallback(async () => {
    try {
      const chain = await loadAuditChain();
      setAudit((prev) => (same(prev, chain) ? prev : chain));
      setVerification(null);
    } catch {   }
  }, []);

  const refreshAudit = useCallback(async () => {
    try {
      const [chain, check] = await Promise.all([loadAuditChain(), verifyAuditChain()]);
      setAudit((prev) => (same(prev, chain) ? prev : chain));
      setVerification((prev) => (same(prev, check) ? prev : check));
    } catch {   }
  }, []);

  const refreshActivity = useCallback(async () => {
    try {
      const [act, av] = await Promise.all([loadActivity(), loadUserAvatars().catch(() => ({}))]);
      setActivity((prev) => (same(prev, act) ? prev : act));
      setAvatars((prev) => (same(prev, av) ? prev : av));
    } catch {   }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshTransactions(),
      refreshHeads(),
      refreshDepartments(),
      refreshLocks(),
      refreshEmployees(),
      refreshEmployeeStats(),
      refreshFlaggedCount(),
      refreshSalaries(),
      refreshLoans(),
      refreshAdvances(),
      refreshRentItems(),
      refreshRentPayments(),
      refreshFundSources(),
      refreshActivity(),
    ]);
  }, [
    refreshTransactions,
    refreshHeads,
    refreshDepartments,
    refreshLocks,
    refreshEmployees,
    refreshEmployeeStats,
    refreshFlaggedCount,
    refreshSalaries,
    refreshLoans,
    refreshAdvances,
    refreshRentItems,
    refreshRentPayments,
    refreshFundSources,
    refreshActivity,
  ]);

  useEffect(() => {
    let alive = true;
    refreshAll()
      .catch((e: any) => {
        if (alive) showToast(e?.message || 'Could not load ledger data');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    const onMaintenance = (m: { on: boolean; since?: number }) => {
      if (!alive) return;
      setMaintenance((prev) => {
        if (prev.on && !m.on) void refreshAll();
        return m.on ? { on: true, since: m.since ?? prev.since ?? Date.now() } : { on: false };
      });
    };
    const onBlocked = () => onMaintenance({ on: true, since: Date.now() });
    window.addEventListener('pace-maintenance', onBlocked);

    const unsubscribe = subscribeToCloud({
      transactions: async () => { await Promise.all([refreshTransactions(), refreshEmployeeStats(), refreshFlaggedCount()]); },
      heads: refreshHeads,
      departments: refreshDepartments,
      locks: refreshLocks,
      employees: async () => { await Promise.all([refreshEmployees(), refreshEmployeeStats()]); },
      salaries: refreshSalaries,
      loans: refreshLoans,
      advances: refreshAdvances,
      rentItems: refreshRentItems,
      rentPayments: refreshRentPayments,
      fundSources: refreshFundSources,
      audit: refreshAuditList,
      activity: refreshActivity,
      me: async () => {
        const me = await getCurrentUser();
        if (!me) return;
        setUser((prev) => (prev.id === me.id && prev.role === me.role && prev.displayName === me.displayName ? prev : me));
      },
      maintenance: onMaintenance,
    });

    return () => {
      alive = false;
      window.removeEventListener('pace-maintenance', onBlocked);
      unsubscribe();
    };
  }, [
    refreshAll,
    refreshTransactions,
    refreshHeads,
    refreshDepartments,
    refreshLocks,
    refreshEmployees,
    refreshEmployeeStats,
    refreshFlaggedCount,
    refreshSalaries,
    refreshLoans,
    refreshAdvances,
    refreshRentItems,
    refreshRentPayments,
    refreshFundSources,
    refreshAuditList,
    refreshActivity,
    showToast,
  ]);

  useEffect(() => {
    if (activeView === 'audit') void refreshAudit();
  }, [activeView, refreshAudit]);

  useEffect(() => {
    let active = true;
    if (!detailTxId) { setLoadedDetailTx(null); return; }
    const cached = transactions.find((tx) => tx.id === detailTxId);
    if (cached) { setLoadedDetailTx(cached); return; }
    setLoadedDetailTx(null);
    loadTransaction(detailTxId).then((tx) => { if (active) setLoadedDetailTx(tx); }).catch(() => { if (active) setLoadedDetailTx(null); });
    return () => { active = false; };
  }, [detailTxId, transactions]);

  const detailTx = useMemo(
    () => (detailTxId ? transactions.find((t) => t.id === detailTxId) || loadedDetailTx : null),
    [detailTxId, transactions, loadedDetailTx],
  );

  const profileEmp = useMemo(
    () => (profileEmpId ? employees.find((e) => e.id === profileEmpId) || null : null),
    [profileEmpId, employees],
  );

  const employeeStatsMap = useMemo(
    () => new Map(employeeStats.map((stat) => [stat.employee.id, stat])),
    [employeeStats],
  );
  const activeLoansCount = useMemo(
    () => loans.filter((l) => l.status === 'active').length,
    [loans],
  );

  const openNewTx = (kind: LedgerKind, head?: string) => {
    setTxModal({ open: true, kind, head, editing: null, duplicating: null });
  };

  const openEditTx = (tx: LedgerTransaction) => {
    setTxModal({ open: true, kind: tx.kind, editing: tx, duplicating: null });
  };

  const openDuplicateTx = (tx: LedgerTransaction) => {
    setTxModal({ open: true, kind: tx.kind, editing: null, duplicating: tx });
  };

  if (loading) return null;

  return (
    <div className="min-h-screen bg-[#eef8f1] text-[#1b2a4e] flex flex-col">
      {maintenance.on && <MaintenanceOverlay since={maintenance.since} />}

      <AppShell
        onGoHome={() => setCurrentView('home')}
        currentView={activeView}
        onNavigate={(v) => setCurrentView(v)}
        userName={user.displayName}
        userRole={user.role}
        userPhotoUrl={user.photoUrl}
        onOpenProfile={() => setIsProfileOpen(true)}
        onLogout={onLock}
        onOpenBackup={() => setIsBackupOpen(true)}
        onOpenActivity={() => setIsActivityOpen(true)}
        onChangePassword={() => setIsPasswordOpen(true)}
        onOpenHeads={() => setIsHeadsOpen(true)}
        onOpenAdmin={isAdmin ? () => setIsAdminOpen(true) : undefined}
        flaggedCount={flaggedCount}
        activeLoansCount={activeLoansCount}
        onToggleDark={handleToggleTheme}
      >
          <main key={activeView} className="flex-1 min-w-0 page-switch-in">
            {activeView === 'home' && (
              <Dashboard
                loans={loans}
                verification={verification}
                userName={user.displayName}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onOpenEmployee={(emp) => setProfileEmpId(emp.id)}
                onGoSheet={() => setCurrentView('sheet')}
                onGoLedger={() => setCurrentView('ledger')}
                onGoEmployees={() => setCurrentView('employees')}
                onGoLoans={() => setCurrentView('loans')}
                onGoAudit={() => setCurrentView('audit')}
              />
            )}

            {activeView === 'ledger' && (
              <TransactionsLedger
                transactions={transactions}
                heads={heads}
                departments={departments}
                employees={employees}
                fundSources={fundSources}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onEditTx={canEdit ? openEditTx : undefined}
                onDuplicateTx={canEdit ? openDuplicateTx : undefined}
                canEdit={canEdit}
                onOpenEmployee={(emp) => setProfileEmpId(emp.id)}
                onQuickSaved={() => void refreshAll()}
                onToast={showToast}
              />
            )}

            {activeView === 'sheet' && (
              <StatementSheet
                transactions={transactions}
                heads={heads}
                locks={locks}
                isAdmin={isAdmin}
                userName={user.displayName}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onAddTx={canEdit ? (kind, head) => openNewTx(kind, head) : undefined}
                onEditTx={canEdit ? openEditTx : undefined}
                onDuplicateTx={canEdit ? openDuplicateTx : undefined}
                onLocksChanged={() => { void refreshLocks(); void refreshAuditList(); void refreshActivity(); }}
                onToast={showToast}
              />
            )}

            {activeView === 'rent' && (
              <RentTab
                rentItems={rentItems}
                rentPayments={rentPayments}
                departments={departments}
                fundSources={fundSources}
                transactions={transactions}
                isAdmin={isAdmin}
                canEdit={canEdit}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onOpenTxId={(id) => setDetailTxId(id)}
                onChanged={() => void refreshAll()}
                onToast={showToast}
              />
            )}

            {activeView === 'employees' && (
              <EmployeesTab
                employees={employees}
                employeeStats={employeeStats}
                heads={heads}
                departments={departments}
                isAdmin={isAdmin}
                onOpenEmployee={(emp) => setProfileEmpId(emp.id)}
                onChanged={() => void refreshAll()}
                onToast={showToast}
                editingEmployee={editingEmp}
                onClearEditingEmployee={() => setEditingEmp(null)}
              />
            )}

            {activeView === 'salary' && (
              <SalaryTab
                employees={employees}
                salaries={salaries}
                loans={loans}
                advances={advances}
                fundSources={fundSources}
                heads={heads}
                departments={departments}
                transactions={transactions}
                isAdmin={isAdmin}
                canEdit={canEdit}
                onOpenEmployee={(emp) => setProfileEmpId(emp.id)}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onOpenTxId={(id) => setDetailTxId(id)}
                onChanged={() => void refreshAll()}
                onToast={showToast}
              />
            )}

            {activeView === 'loans' && (
              <LoansTab
                employees={employees}
                loans={loans}
                fundSources={fundSources}
                heads={heads}
                departments={departments}
                transactions={transactions}
                isAdmin={isAdmin}
                canEdit={canEdit}
                onOpenEmployee={(emp) => setProfileEmpId(emp.id)}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onOpenTxId={(id) => setDetailTxId(id)}
                onChanged={() => void refreshAll()}
                onToast={showToast}
              />
            )}

            {activeView === 'funds' && (
              <FundsTab
                sources={fundSources}
                transactions={transactions}
                isAdmin={isAdmin}
                onChanged={() => void refreshAll()}
                onToast={showToast}
              />
            )}

            {activeView === 'audit' && (
              <AuditIntegrityTab
                audit={audit}
                verification={verification}
                locks={locks}
                transactions={transactions}
                isAdmin={isAdmin}
                onVerifyNow={refreshAudit}
                onLocksChanged={() => { void refreshLocks(); void refreshAuditList(); void refreshActivity(); }}
                onOpenTx={(tx) => setDetailTxId(tx.id)}
                onOpenTxId={(id) => setDetailTxId(id)}
                onToast={showToast}
              />
            )}
          </main>
      </AppShell>

      <TransactionModal
        isOpen={txModal.open}
        onClose={() => setTxModal((m) => ({ ...m, open: false, editing: null, duplicating: null }))}
        initialKind={txModal.kind}
        initialHead={txModal.head}
        editingTx={txModal.editing}
        duplicatingTx={txModal.duplicating}
        heads={heads}
        departments={departments}
        employees={employees}
        fundSources={fundSources}
        recentTransactions={transactions}
        isAdmin={isAdmin}
        onSaved={(saved, isEdit) => {
          showToast(isEdit ? `${saved.voucherNo} updated (edit logged)` : `${saved.voucherNo} saved`);
          void refreshAll();
        }}
      />

      <TransactionDetailModal
        tx={detailTx}
        isAdmin={isAdmin}
        canEdit={canEdit}
        onClose={() => setDetailTxId(null)}
        onEdit={(tx) => openEditTx(tx)}
        onDuplicate={canEdit ? (tx) => openDuplicateTx(tx) : undefined}
        onChanged={() => void refreshAll()}
        onToast={showToast}
      />

      <EmployeeProfileModal
        employee={profileEmp}
        stat={profileEmp ? employeeStatsMap.get(profileEmp.id) : undefined}
        salaries={salaries}
        loans={loans}
        advances={advances}
        isAdmin={isAdmin}
        onClose={() => setProfileEmpId(null)}
        onEditEmployee={(emp) => {
          setProfileEmpId(null);
          setEditingEmp(emp);
          setCurrentView('employees');
        }}
        onOpenTx={(tx) => setDetailTxId(tx.id)}
        onOpenTxId={(id) => setDetailTxId(id)}
      />

      <AdminPanel
        isOpen={isAdminOpen}
        onClose={() => setIsAdminOpen(false)}
        currentUser={user}
        onToast={showToast}
        onBinChanged={() => void refreshAll()}
        onUsersChanged={async () => {
          const me = await getCurrentUser();
          if (me) setUser(me);
          void refreshActivity();
        }}
        onFactoryReset={onLock}
      />

      <HeadsModal
        isOpen={isHeadsOpen}
        onClose={() => setIsHeadsOpen(false)}
        heads={heads}
        departments={departments}
        isAdmin={isAdmin}
        onChanged={() => { void refreshHeads(); void refreshActivity(); }}
        onDepartmentsChanged={() => { void refreshDepartments(); void refreshActivity(); }}
        onToast={showToast}
      />

      <ActivityModal
        isOpen={isActivityOpen}
        onClose={() => setIsActivityOpen(false)}
        events={activity}
        avatars={avatars}
      />

      <BackupModal
        isOpen={isBackupOpen}
        onClose={() => setIsBackupOpen(false)}
        isAdmin={isAdmin}
        onRestored={() => void refreshAll()}
        onFactoryReset={onLock}
        onToast={showToast}
      />

      <ProfileModal
        isOpen={isProfileOpen}
        user={user}
        onClose={() => setIsProfileOpen(false)}
        onUpdateUser={(u) => { setUser(u); void refreshActivity(); }}
        onLogout={onLock}
        onChangePassword={() => setIsPasswordOpen(true)}
      />

      <ChangePasswordModal
        isOpen={isPasswordOpen}
        onClose={() => setIsPasswordOpen(false)}
        onSave={async (cur, next) => {
          await changePassword(cur, next);
          setIsPasswordOpen(false);
          showToast('Password updated');
        }}
      />

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="no-print fixed bottom-5 right-5 z-[110] rounded-2xl bg-[#1b2a4e] text-white px-4 py-3 text-xs font-semibold shadow-xl border border-white/10"
        >
          {toast}
        </div>
      )}
    </div>
  );
}