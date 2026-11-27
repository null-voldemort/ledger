import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface FilterOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** The value that means "nothing chosen / no filter". When the current value differs, the button is highlighted. */
  defaultValue?: string;
  /** Set false for controls like Sort that should never look "filtered". */
  highlight?: boolean;
  /** Form-style: show the default option's text as a muted placeholder instead of highlighting. */
  placeholderStyle?: boolean;
  /** Show a search box in the popover. Defaults to on when there are more than 10 options. */
  searchable?: boolean;
  /** Sizing/skin for the trigger button, so it matches the neighbouring controls. */
  className?: string;
  /** Sizing for the wrapper (e.g. flex basis). */
  wrapperClassName?: string;
  icon?: React.ReactNode;
}

/** A dropdown that looks like the calendar popover, used instead of the browser's native <select>. */
export const FilterSelect: React.FC<Props> = ({
  value,
  options,
  onChange,
  ariaLabel,
  defaultValue = 'all',
  highlight = true,
  placeholderStyle = false,
  searchable,
  className = '',
  wrapperClassName = '',
  icon,
}) => {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [query, setQuery] = useState('');
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const showSearch = searchable ?? options.length > 10;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const label = selectedIdx >= 0 ? options[selectedIdx].label : value;
  const isDefault = value === defaultValue;
  const active = highlight && !placeholderStyle && !isDefault;

  const close = (refocus = false) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };

  const openList = () => {
    setQuery('');
    setHi(Math.max(0, selectedIdx));
    const r = wrapRef.current?.getBoundingClientRect();
    setAlignRight(Boolean(r && r.left + 288 > window.innerWidth - 8));
    setOpen(true);
  };

  const choose = (v: string) => {
    onChange(v);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(visible.length - 1, i + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (visible[hi]) choose(visible[hi].value); }
      else if (e.key === 'Tab') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hi, visible]);

  // Keep the highlighted row visible when navigating a long list with the keyboard.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, hi]);

  return (
    <div ref={wrapRef} className={`relative ${wrapperClassName}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openList())}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${className} flex items-center gap-1.5 text-left transition-colors ${
          active ? '!bg-brand-50 !border-brand-200 text-brand-900' : 'hover:bg-white'
        }`}
      >
        {icon}
        <span className={`flex-1 min-w-0 truncate ${placeholderStyle && isDefault ? 'text-slate-400 font-normal' : ''}`}>{label}</span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1.5 z-[90] min-w-full w-max max-w-[20rem] rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl ${
            alignRight ? 'right-0' : 'left-0'
          }`}
        >
          {showSearch && (
            <div className="relative mb-1.5">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHi(0); }}
                placeholder="Search..."
                aria-label={`Search ${ariaLabel}`}
                className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2 text-xs font-medium text-[#1b2a4e] focus:outline-none focus:bg-white focus:border-brand-500"
              />
            </div>
          )}
          <div ref={listRef} role="listbox" aria-label={ariaLabel} className="max-h-60 overflow-y-auto">
            {visible.length === 0 && <div className="px-2.5 py-2 text-xs text-slate-400">No matches</div>}
            {visible.map((o, i) => {
              const selected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(o.value)}
                  onMouseEnter={() => setHi(i)}
                  className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-lg text-left text-xs font-semibold transition-colors ${
                    selected ? 'bg-brand-50 text-brand-900' : 'text-[#1b2a4e]'
                  } ${i === hi && !selected ? 'bg-slate-100' : ''}`}
                >
                  <span className="truncate">{o.label}</span>
                  {selected && <Check className="w-3.5 h-3.5 shrink-0 text-brand-600" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
