import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight } from 'lucide-react';
import { dhakaToday, formatShortDate, monthRangeOf } from '../utils/ledger';

interface Props {
  /** Selected range (inclusive, YYYY-MM-DD). Both undefined means "all dates". */
  from?: string;
  to?: string;
  onChange: (from?: string, to?: string) => void;
  /** Sizing/skin for the trigger button, so it can match the other filter controls. */
  className?: string;
  /** Sizing for the wrapper (e.g. flex basis). */
  wrapperClassName?: string;
  /** Single-date mode (for forms): one day only, no range button, no "all dates". The date is `from`. */
  single?: boolean;
  /** Hide the "All dates" shortcut, for screens that always need a concrete period (e.g. the Dashboard). */
  hideAllDates?: boolean;
}

const WEEKDAYS = ['Sa', 'Su', 'Mo', 'Tu', 'We', 'Th', 'Fr']; // Saturday-first, as used elsewhere in this app
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`;
}

/** 42 cells (6 weeks) so the popover never changes height between months. */
function monthCells(ym: string): (string | null)[] {
  const [y, m] = ym.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 1) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) cells.push(`${y}-${pad(m)}-${pad(d)}`);
  while (cells.length < 42) cells.push(null);
  return cells;
}

export function dateRangeLabel(from?: string, to?: string): string {
  if (!from || !to) return 'All dates';
  if (from === to) return formatShortDate(from);
  const whole = monthRangeOf(from.slice(0, 7));
  if (whole.from === from && whole.to === to) return whole.label; // e.g. "November 2026"
  return `${formatShortDate(from)} – ${formatShortDate(to)}`;
}

export const DateRangeButton: React.FC<Props> = ({ from, to, onChange, className = '', wrapperClassName = '', single = false, hideAllDates = false }) => {
  const today = dhakaToday();
  const active = Boolean(from && to) && !single;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'days' | 'months'>('days');
  const [viewMonth, setViewMonth] = useState(() => (from || today).slice(0, 7));
  const [pickMode, setPickMode] = useState<'day' | 'range'>('day'); // one day (default) or a date range
  const [pending, setPending] = useState<string | null>(null); // first click while choosing a range
  const [hover, setHover] = useState<string | null>(null); // day under the mouse, for the live range preview
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = () => { setOpen(false); setPending(null); setHover(null); setView('days'); setPickMode('day'); };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    if (open) return close();
    setViewMonth((from || today).slice(0, 7));
    setView('days');
    setPending(null);
    setPickMode('day');
    const r = wrapRef.current?.getBoundingClientRect();
    setAlignRight(Boolean(r && r.left + 288 > window.innerWidth - 8));
    setOpen(true);
  };

  // "One day": a click picks that day and closes. "Date range": first click = start, second click = end.
  const pickDay = (d: string) => {
    if (single || pickMode === 'day') {
      onChange(d, d);
      close();
      return;
    }
    if (!pending) {
      setPending(d);
      return;
    }
    const [a, b] = pending <= d ? [pending, d] : [d, pending];
    onChange(a, b);
    close();
  };

  const pickMonth = (ym: string) => {
    if (single) { setViewMonth(ym); setView('days'); return; } // forms: just jump to that month
    const r = monthRangeOf(ym);
    onChange(r.from, r.to);
    close();
  };

  const quick = (f?: string, t?: string) => { onChange(f, t); close(); };

  const thisMonth = today.slice(0, 7);
  const viewYear = Number(viewMonth.slice(0, 4));
  const monthTitle = monthRangeOf(viewMonth).label;
  const navBtn = 'w-7 h-7 grid place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors';
  const linkBtn = 'px-2 py-1 rounded-md text-[11px] font-semibold text-brand-700 hover:bg-brand-50 transition-colors';

  return (
    <div ref={wrapRef} className={`relative ${wrapperClassName}`}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={single ? 'Choose a date' : 'Choose a date, a range, or a whole month'}
        className={`${className} flex items-center gap-1.5 text-left transition-colors ${
          active ? '!bg-brand-50 !border-brand-200 text-brand-900' : 'hover:bg-white'
        }`}
      >
        <CalendarDays className="w-3.5 h-3.5 shrink-0 text-brand-600" />
        <span className="truncate tabular-nums">{single ? (from ? formatShortDate(from) : 'Select date') : dateRangeLabel(from, to)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose dates"
          className={`absolute top-full mt-1.5 z-[90] w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl ${
            alignRight ? 'right-0' : 'left-0'
          }`}
        >
          {view === 'days' ? (
            <>
              {!single && <div className="mb-2">
                <button
                  type="button"
                  onClick={() => { setPickMode(pickMode === 'range' ? 'day' : 'range'); setPending(null); setHover(null); }}
                  aria-pressed={pickMode === 'range'}
                  title={pickMode === 'range' ? 'Back to picking one day' : 'Pick a start day and an end day'}
                  className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11px] font-semibold transition-colors ${
                    pickMode === 'range'
                      ? 'bg-brand-600 border-brand-600 text-white'
                      : 'bg-white border-slate-200 text-brand-700 hover:bg-brand-50'
                  }`}
                >
                  <CalendarRange className="w-3.5 h-3.5" />
                  Date range
                </button>
              </div>}
              <div className="flex items-center justify-between mb-1.5">
                <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))} aria-label="Previous month" className={navBtn}>
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setView('months')}
                  title="Pick a month or year"
                  className="px-2 py-1 rounded-lg text-xs font-bold text-[#1b2a4e] hover:bg-slate-100 transition-colors"
                >
                  {monthTitle}
                </button>
                <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, 1))} aria-label="Next month" className={navBtn}>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-7 text-center text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-0.5">
                {WEEKDAYS.map((w) => <span key={w} className="py-1">{w}</span>)}
              </div>
              <div className="grid grid-cols-7 gap-y-0.5" onMouseLeave={() => setHover(null)}>
                {monthCells(viewMonth).map((d, i) => {
                  if (!d) return <span key={`e${i}`} className="h-8" />;
                  // While a range is being chosen, show only the first click; otherwise show the applied selection.
                  const previewEnd = pending ? (hover ?? pending) : null;
                  const shownFrom = pending && previewEnd ? (pending <= previewEnd ? pending : previewEnd) : from;
                  const shownTo = pending && previewEnd ? (pending <= previewEnd ? previewEnd : pending) : to;
                  const inRange = Boolean(shownFrom && shownTo && d >= shownFrom && d <= shownTo);
                  const edge = d === shownFrom || d === shownTo;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => pickDay(d)}
                      onMouseEnter={() => pending && setHover(d)}
                      className={`h-8 text-[11px] font-semibold tabular-nums transition-colors ${
                        edge
                          ? 'bg-brand-600 text-white rounded-lg'
                          : inRange
                            ? 'bg-brand-50 text-brand-900'
                            : `rounded-lg text-[#1b2a4e] hover:bg-slate-100 ${d === today ? 'ring-1 ring-inset ring-brand-300' : ''}`
                      }`}
                    >
                      {Number(d.slice(8))}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-400 text-center">
                {single ? 'Click a day to choose it.' : pickMode === 'day' ? 'Click a day to show only that day.' : pending ? 'Now click the last day of the range.' : 'Click the first day of the range.'}
              </p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-2">
                <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, -12))} aria-label="Previous year" className={navBtn}>
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setView('days')}
                  title="Back to days"
                  className="px-2 py-1 rounded-lg text-xs font-bold text-[#1b2a4e] hover:bg-slate-100 transition-colors"
                >
                  {viewYear}
                </button>
                <button type="button" onClick={() => setViewMonth(shiftMonth(viewMonth, 12))} aria-label="Next year" className={navBtn}>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {MONTHS.map((name, i) => {
                  const ym = `${viewYear}-${pad(i + 1)}`;
                  const r = monthRangeOf(ym);
                  const selected = single ? ym === viewMonth : from === r.from && to === r.to;
                  return (
                    <button
                      key={ym}
                      type="button"
                      onClick={() => pickMonth(ym)}
                      className={`h-9 rounded-lg text-xs font-semibold transition-colors ${
                        selected
                          ? 'bg-brand-600 text-white'
                          : `text-[#1b2a4e] hover:bg-slate-100 ${ym === thisMonth ? 'ring-1 ring-inset ring-brand-300' : ''}`
                      }`}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-slate-400 text-center">{single ? 'Click a month to jump to it.' : 'Click a month to see the whole month.'}</p>
            </>
          )}

          <div className={`mt-2 pt-2 border-t border-slate-100 flex items-center ${single ? 'justify-center' : 'justify-between'}`}>
            <button type="button" onClick={() => quick(today, today)} className={linkBtn}>Today</button>
            {!single && (
              <>
                <button type="button" onClick={() => { const r = monthRangeOf(thisMonth); quick(r.from, r.to); }} className={linkBtn}>This month</button>
                <button type="button" onClick={() => { const r = monthRangeOf(shiftMonth(thisMonth, -1)); quick(r.from, r.to); }} className={linkBtn}>Last month</button>
                {!hideAllDates && <button type="button" onClick={() => quick(undefined, undefined)} className={linkBtn}>All dates</button>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
