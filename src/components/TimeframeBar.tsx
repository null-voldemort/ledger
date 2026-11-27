import React from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, dhakaMonth, dhakaToday, weekRangeOf, type TimeframeMode } from '../utils/ledger';

interface Props {
  mode: TimeframeMode;
  onModeChange: (m: TimeframeMode) => void;
  anchorDate: string;
  onAnchorDateChange: (d: string) => void;
  anchorMonth: string;
  onAnchorMonthChange: (ym: string) => void;
  anchorYear: string;
  onAnchorYearChange: (y: string) => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (from: string, to: string) => void;
  rangeLabel: string;
  /** Optional "All dates" choice (used by the Daily Ledger, where showing every date is the default). */
  allDates?: { active: boolean; onSelect: () => void };
}

function stepMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

const chipBase = 'px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap';
const chipOn = 'bg-brand-50 border-brand-200 text-brand-900';
const chipOff = 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900';

export const TimeframeBar: React.FC<Props> = ({
  mode,
  onModeChange,
  anchorDate,
  onAnchorDateChange,
  anchorMonth,
  onAnchorMonthChange,
  anchorYear,
  onAnchorYearChange,
  customFrom,
  customTo,
  onCustomChange,
  rangeLabel,
  allDates,
}) => {
  const all = Boolean(allDates?.active);
  const today = dhakaToday();
  const yesterday = addDays(today, -1);
  const thisMonth = dhakaMonth();
  const lastMonth = stepMonth(thisMonth, -1);
  const thisYear = today.slice(0, 4);
  const sameWeek = weekRangeOf(anchorDate).from === weekRangeOf(today).from;

  // Plain-language choices. Each one sets the existing period state, so callers need no changes.
  const chips: { id: string; label: string; active: boolean; apply: () => void }[] = [
    { id: 'today', label: 'Today', active: mode === 'daily' && anchorDate === today,
      apply: () => { onModeChange('daily'); onAnchorDateChange(today); } },
    { id: 'yesterday', label: 'Yesterday', active: mode === 'daily' && anchorDate === yesterday,
      apply: () => { onModeChange('daily'); onAnchorDateChange(yesterday); } },
    { id: 'week', label: 'This week', active: mode === 'weekly' && sameWeek,
      apply: () => { onModeChange('weekly'); onAnchorDateChange(today); } },
    { id: 'month', label: 'This month', active: mode === 'monthly' && anchorMonth === thisMonth,
      apply: () => { onModeChange('monthly'); onAnchorMonthChange(thisMonth); } },
    { id: 'lastMonth', label: 'Last month', active: mode === 'monthly' && anchorMonth === lastMonth,
      apply: () => { onModeChange('monthly'); onAnchorMonthChange(lastMonth); } },
    { id: 'year', label: 'This year', active: mode === 'yearly' && anchorYear === thisYear,
      apply: () => { onModeChange('yearly'); onAnchorYearChange(thisYear); } },
    { id: 'custom', label: 'Choose dates', active: mode === 'custom',
      apply: () => onModeChange('custom') },
  ];

  const step = (dir: -1 | 1) => {
    if (mode === 'daily') onAnchorDateChange(addDays(anchorDate, dir));
    else if (mode === 'weekly') onAnchorDateChange(addDays(anchorDate, dir * 7));
    else if (mode === 'monthly') onAnchorMonthChange(stepMonth(anchorMonth, dir));
    else if (mode === 'yearly') onAnchorYearChange(String((Number(anchorYear) || 2026) + dir));
  };

  const arrowCls = 'w-7 h-7 grid place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors';
  const inputCls = 'text-xs font-semibold text-[#1b2a4e] bg-transparent focus:outline-none tabular-nums';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {allDates && (
          <button
            type="button"
            onClick={allDates.onSelect}
            aria-pressed={all}
            className={`${chipBase} ${all ? chipOn : chipOff}`}
          >
            All dates
          </button>
        )}
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={c.apply}
            aria-pressed={!all && c.active}
            className={`${chipBase} ${!all && c.active ? chipOn : chipOff}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {all ? (
        <p className="text-xs font-medium text-slate-500">Showing entries from every date.</p>
      ) : mode === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 shadow-xs">
            <span className="text-slate-500 font-medium">From</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomChange(e.target.value, customTo)}
              className={inputCls}
            />
          </label>
          <label className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2.5 py-1.5 shadow-xs">
            <span className="text-slate-500 font-medium">To</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomChange(customFrom, e.target.value)}
              className={inputCls}
            />
          </label>
          <span className="font-medium text-slate-500">{rangeLabel}</span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-2 py-1 shadow-xs">
            <button type="button" onClick={() => step(-1)} aria-label="Previous period" className={arrowCls}>
              <ChevronLeft className="w-4 h-4" />
            </button>

            {mode === 'monthly' ? (
              <input
                type="month"
                value={anchorMonth}
                onChange={(e) => e.target.value && onAnchorMonthChange(e.target.value)}
                aria-label="Select month"
                className={`${inputCls} px-1`}
              />
            ) : mode === 'yearly' ? (
              <input
                type="number"
                min={2020}
                max={2099}
                value={anchorYear}
                onChange={(e) => onAnchorYearChange(e.target.value)}
                aria-label="Select year"
                className={`w-20 text-center ${inputCls}`}
              />
            ) : mode === 'daily' ? (
              <label className="inline-flex items-center gap-1.5 px-1 cursor-pointer">
                <Calendar className="w-3.5 h-3.5 text-brand-600" />
                <input
                  type="date"
                  value={anchorDate}
                  onChange={(e) => e.target.value && onAnchorDateChange(e.target.value)}
                  aria-label="Select date"
                  className={inputCls}
                />
              </label>
            ) : (
              <span className="px-2 text-xs font-semibold text-[#1b2a4e] tabular-nums">{rangeLabel}</span>
            )}

            <button type="button" onClick={() => step(1)} aria-label="Next period" className={arrowCls}>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {mode !== 'weekly' && <span className="text-xs font-medium text-slate-500">{rangeLabel}</span>}
        </div>
      )}
    </div>
  );
};
