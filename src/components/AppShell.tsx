import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar, type SidebarProps } from './Sidebar';
import { DevelopedBy } from './DevelopedBy';
import { useSidebarSlide } from '../utils/useSidebarSlide';

const DESKTOP_QUERY = '(min-width: 1024px)';
const SIDEBAR_KEY = 'pace_sidebar_open';

// The desktop sidebar remembers whether it was left open or closed, so a refresh keeps it that way.
function readSidebarOpen(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) !== '0'; } catch { return true; }
}
function saveSidebarOpen(open: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch { /* storage unavailable */ }
}

type ShellSidebarProps = Omit<SidebarProps, 'visible' | 'isDesktop' | 'onClose' | 'onToggle'>;

interface AppShellProps extends ShellSidebarProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children, ...sidebarProps }) => {
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  const [desktopOpen, setDesktopOpen] = useState(readSidebarOpen);
  const [mobileOpen, setMobileOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const { capture } = useSidebarSlide(rowRef, stageRef, desktopOpen);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const toggle = useCallback(() => {
    if (isDesktop) { capture(); setDesktopOpen((v) => { saveSidebarOpen(!v); return !v; }); }
    else setMobileOpen((v) => !v);
  }, [isDesktop, capture]);
  const close = useCallback(() => setMobileOpen(false), []);
  const open = useCallback(() => setMobileOpen(true), []);

  return (
    <div ref={rowRef} className="flex-1 flex min-w-0">
      <Sidebar
        {...sidebarProps}
        visible={isDesktop ? desktopOpen : mobileOpen}
        isDesktop={isDesktop}
        onClose={close}
        onToggle={toggle}
      />

      {/* Column takes whatever width is left; the stage inside it keeps a constant
          width (see .app-stage) so page content never reflows when the sidebar moves. */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={stageRef} data-sidebar={isDesktop ? (desktopOpen ? 'open' : 'closed') : undefined} className="app-stage flex-1 min-w-0 flex flex-col @container/main">
        <header className="lg:hidden no-print sticky top-0 z-30 h-14 px-4 bg-[#eef8f1]/90 backdrop-blur-md border-b border-slate-200/70 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={open}
            aria-label="Open menu"
            className="grid place-items-center w-9 h-9 rounded-xl bg-white border border-slate-200 text-[#1b2a4e]"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-display text-lg font-bold text-brand-700">
            Pace <span className="text-brand-500">IT</span> Ledger
          </span>
          <div className="w-9" aria-hidden="true" />
        </header>

        {children}

        <DevelopedBy />
        </div>
      </div>
    </div>
  );
};
