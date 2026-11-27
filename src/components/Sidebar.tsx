import React, { useState } from 'react';
import {
  LayoutDashboard,
  FileSpreadsheet,
  Table,
  Building2,
  Users,
  Banknote,
  HandCoins,
  Wallet,
  ShieldCheck,
  Settings,
  SlidersHorizontal,
  History,
  Database,
  X,
  PanelLeftClose,
  Menu,
  User,
  ChevronUp,
  Moon,
  Sun,
} from 'lucide-react';
import { BRAND_SLOGAN } from '../brand';
import { AccountMenu } from './AccountMenu';
import { ScrollLock } from './ScrollLock';
import { SIDEBAR_PANEL_ID } from '../utils/useSidebarSlide';
import { useTheme } from '../utils/theme';
import { roleLabel } from '../utils/roles';

export type LedgerView = 'home' | 'ledger' | 'sheet' | 'rent' | 'employees' | 'salary' | 'loans' | 'funds' | 'audit';

// Navigation items are real links (href="#page") so the browser's own right-click menu works on them:
// open in new tab or window, copy link address, bookmark. A plain left click still navigates in-app.
const isPlainLeftClick = (e: React.MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

const SIDEBAR_MS = 200;
const SIDEBAR_MOTION = 'sb-motion duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none';
const RAIL_WIDTH = '64px';
const FULL_WIDTH = '14.5rem';

export interface SidebarProps {
  visible: boolean;
  isDesktop: boolean;
  onClose: () => void;
  onToggle: () => void;
  onGoHome: () => void;
  currentView: LedgerView;
  onNavigate: (view: LedgerView) => void;
  userName: string;
  userRole: string;
  userPhotoUrl?: string;
  onOpenProfile?: () => void;
  onLogout?: () => void;
  onOpenBackup: () => void;
  onOpenActivity: () => void;
  onChangePassword: () => void;
  onOpenHeads?: () => void;
  onOpenAdmin?: () => void;
  flaggedCount?: number;
  activeLoansCount?: number;
  onToggleDark?: (e?: React.MouseEvent<HTMLElement>) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  visible,
  isDesktop,
  onClose,
  onToggle,
  onGoHome,
  currentView,
  onNavigate,
  userName,
  userRole,
  userPhotoUrl,
  onOpenProfile,
  onLogout,
  onOpenBackup,
  onOpenActivity,
  onChangePassword,
  onOpenHeads,
  onOpenAdmin,
  flaggedCount = 0,
  activeLoansCount = 0,
  onToggleDark,
}) => {
  const dark = useTheme() === 'dark';
  const [accountOpen, setAccountOpen] = useState(false);

  const collapsed = isDesktop && !visible;

  const navItems = [
    { id: 'home', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'ledger', label: 'Daily Ledger', icon: Table },
    { id: 'sheet', label: 'Monthly Sheet', icon: FileSpreadsheet },
    { id: 'rent', label: 'Office Rent', icon: Building2 },
    { id: 'employees', label: 'Employees', icon: Users },
    { id: 'salary', label: 'Salary', icon: Banknote },
    { id: 'loans', label: 'Loans', icon: HandCoins, count: activeLoansCount, tone: 'slate' as const },
    { id: 'funds', label: 'Fund Sources', icon: Wallet },
    { id: 'audit', label: 'Audit & Locks', icon: ShieldCheck, count: flaggedCount, tone: 'rose' as const },
  ] as const;

  const userInitials = (userName || 'U')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0].toUpperCase())
    .join('');

  const fade = `whitespace-nowrap transition-opacity duration-200 ease-out ${collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`;
  const rowBase =
    'relative w-full h-9 flex items-center gap-2.5 px-3.5 text-xs font-medium rounded-xl overflow-hidden transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
  const heading = (text: string, divider = false) => (
    <div className="relative h-6 flex items-end">
      {divider && (
        <div className={`absolute inset-x-3 top-0 border-t border-slate-100 transition-opacity duration-150 ${collapsed ? 'opacity-100' : 'opacity-0'}`} />
      )}
      <span className={`px-3.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 ${fade}`}>{text}</span>
    </div>
  );

  const content = (
    <aside className={`app-sidebar bg-white border-r border-brand-100 flex flex-col h-full shadow-xs overflow-hidden ${isDesktop ? 'w-full' : 'w-[14.5rem]'}`}>
      <div className="h-14 shrink-0 px-3 flex items-center border-b border-slate-100">
        <a
          href="#home"
          onClick={(e) => {
            if (!isPlainLeftClick(e)) return;
            e.preventDefault();
            onGoHome();
            if (!isDesktop) onClose();
          }}
          tabIndex={collapsed ? -1 : 0}
          aria-hidden={collapsed}
          className={`flex flex-col items-start justify-center leading-none text-left h-9 rounded-lg overflow-hidden transition-[width,opacity,padding] ${SIDEBAR_MOTION} focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            collapsed ? 'w-0 opacity-0' : 'w-[168px] pl-1 opacity-100'
          }`}
          aria-label="Pace IT Ledger home"
        >
          <span className="font-display text-xl font-bold tracking-tight text-brand-700 leading-none whitespace-nowrap">
            Pace <span className="text-brand-500">IT</span>
          </span>
          <span className="font-display text-[8.5px] font-medium uppercase tracking-[0.07em] text-slate-500 mt-1 whitespace-nowrap">
            {BRAND_SLOGAN}
          </span>
        </a>
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto w-10 h-9 shrink-0 inline-flex items-center justify-center rounded-xl text-slate-500 hover:text-brand-800 hover:bg-brand-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
          aria-expanded={!collapsed}
        >
          {!isDesktop ? <X className="w-[18px] h-[18px]" /> : collapsed ? <Menu className="w-[18px] h-[18px]" /> : <PanelLeftClose className="w-[18px] h-[18px]" />}
        </button>
      </div>

      <nav className="flex-1 px-3 py-3 space-y-1 overflow-y-auto overflow-x-hidden scrollbar-none">
        {heading('Accounts & Staff')}
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                if (!isPlainLeftClick(e)) return;
                e.preventDefault();
                onNavigate(item.id);
                if (!isDesktop) onClose();
              }}
              title={collapsed ? item.label : undefined}
              aria-current={isActive ? 'page' : undefined}
              className={`${rowBase} ${
                isActive ? 'bg-brand-50 text-brand-900 font-semibold' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              {isActive && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-brand-600" />}
              <Icon className={`w-4 h-4 shrink-0 transition-colors ${isActive ? 'text-brand-700' : 'text-slate-400'}`} />
              <span className={`flex-1 text-left ${fade}`}>{item.label}</span>
              {'count' in item && item.count !== undefined && item.count > 0 && (
                <span
                  className={`text-[11px] font-mono font-bold tabular-nums ${fade} ${
                    isActive
                      ? 'text-brand-800'
                      : item.tone === 'rose'
                        ? 'text-rose-600'
                        : 'text-slate-500'
                  }`}
                >
                  {item.count}
                </span>
              )}
            </a>
          );
        })}

        <div className="pt-3">{heading('Management & Tools', true)}</div>

        {onOpenAdmin && (
          <button
            onClick={() => { onOpenAdmin(); if (!isDesktop) onClose(); }}
            title={collapsed ? 'Admin Control Panel' : undefined}
            className={`${rowBase} text-purple-700 hover:bg-purple-50`}
          >
            <Settings className="w-4 h-4 shrink-0 text-purple-600" />
            <span className={`flex-1 text-left ${fade}`}>Admin Control Panel</span>
          </button>
        )}

        {onOpenHeads && (
          <button
            onClick={() => { onOpenHeads(); if (!isDesktop) onClose(); }}
            title={collapsed ? 'Channels & Departments' : undefined}
            className={`${rowBase} text-slate-600 hover:bg-slate-50 hover:text-slate-900`}
          >
            <SlidersHorizontal className="w-4 h-4 shrink-0 text-slate-400" />
            <span className={`flex-1 text-left ${fade}`}>Channels &amp; Offices</span>
          </button>
        )}

        <button
          onClick={() => { onOpenActivity(); if (!isDesktop) onClose(); }}
          title={collapsed ? 'Activity Log' : undefined}
          className={`${rowBase} text-slate-600 hover:bg-slate-50 hover:text-slate-900`}
        >
          <History className="w-4 h-4 shrink-0 text-slate-400" />
          <span className={`flex-1 text-left ${fade}`}>Activity Log</span>
        </button>

        <button
          onClick={() => { onOpenBackup(); if (!isDesktop) onClose(); }}
          title={collapsed ? 'Database & Backup' : undefined}
          className={`${rowBase} text-slate-600 hover:bg-slate-50 hover:text-slate-900`}
        >
          <Database className="w-4 h-4 shrink-0 text-slate-400" />
          <span className={`flex-1 text-left ${fade}`}>Database &amp; Backup</span>
        </button>

        {onToggleDark && (
          <button
            type="button"
            onClick={onToggleDark}
            title={collapsed ? (dark ? 'Switch to light mode' : 'Switch to dark mode') : undefined}
            aria-pressed={dark}
            className={`${rowBase} text-slate-600 hover:bg-slate-50 hover:text-slate-900`}
          >
            {dark ? <Sun key="sun" className="theme-icon w-4 h-4 shrink-0 text-slate-400" /> : <Moon key="moon" className="theme-icon w-4 h-4 shrink-0 text-slate-400" />}
            <span className={`flex-1 text-left ${fade}`}>{dark ? 'Light mode' : 'Dark mode'}</span>
          </button>
        )}
      </nav>

      <div className="p-3 border-t border-slate-100 bg-slate-50/50">
        <AccountMenu
          open={accountOpen}
          collapsed={collapsed}
          onClose={() => setAccountOpen(false)}
          userName={userName}
          userRole={userRole}
          userPhotoUrl={userPhotoUrl}
          onViewProfile={() => { onOpenProfile?.(); if (!isDesktop) onClose(); }}
          onChangePassword={() => { onChangePassword(); if (!isDesktop) onClose(); }}
          onLogout={() => { onLogout?.(); if (!isDesktop) onClose(); }}
        >
          <button
            type="button"
            onClick={() => setAccountOpen((o) => !o)}
            className={`w-full flex items-center gap-2.5 p-1.5 rounded-xl border overflow-hidden transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 group ${
              accountOpen ? 'bg-white shadow-xs border-slate-200' : 'border-transparent hover:bg-white hover:shadow-xs hover:border-slate-200'
            }`}
            title={`Logged in as ${userName}`}
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={accountOpen}
          >
            {userPhotoUrl ? (
              <img src={userPhotoUrl} alt={userName} className="w-8 h-8 rounded-full object-cover border border-brand-200 shadow-xs shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-700 to-brand-900 text-white flex items-center justify-center text-[11px] font-bold shadow-xs shrink-0">
                {userInitials || <User className="w-3.5 h-3.5" />}
              </div>
            )}
            <div className={`flex flex-col min-w-0 leading-tight flex-1 overflow-hidden ${fade}`}>
              <span className="font-semibold text-xs text-slate-800 truncate group-hover:text-brand-900">{userName}</span>
              <span className="text-[10px] text-slate-400 truncate mt-0.5">
                {roleLabel(userRole)}
              </span>
            </div>
            <ChevronUp className={`w-4 h-4 text-slate-400 shrink-0 transition-[opacity,transform] duration-150 ${collapsed ? 'opacity-0' : 'opacity-100'} ${accountOpen ? '' : 'rotate-180'}`} />
          </button>
        </AccountMenu>
      </div>
    </aside>
  );

  if (isDesktop) {
    return (
      <div
        id="app-sidebar"
        className="no-print shrink-0 sticky top-0 z-40 self-start h-screen"
        style={{ width: collapsed ? RAIL_WIDTH : FULL_WIDTH }}
      >
        <div id={SIDEBAR_PANEL_ID} className="absolute inset-y-0 left-0 w-full">{content}</div>
      </div>
    );
  }

  return (
    <div
      id="app-sidebar"
      className={`no-print fixed inset-0 z-50 flex ${visible ? '' : 'pointer-events-none'}`}
      aria-hidden={!visible}
      style={{ visibility: visible ? 'visible' : 'hidden', transition: `visibility 0s linear ${visible ? 0 : SIDEBAR_MS}ms` }}
    >
      {visible && <ScrollLock />}
      <div
        className={`sb-motion fixed inset-0 bg-slate-900/40 transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`sb-motion relative z-10 h-full shadow-2xl transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${visible ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {content}
      </div>
    </div>
  );
};
