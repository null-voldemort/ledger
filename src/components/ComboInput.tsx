import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  required?: boolean;
  ariaLabel?: string;
  className?: string;
}

export const ComboInput: React.FC<Props> = ({
  value,
  onChange,
  options,
  placeholder,
  required,
  ariaLabel,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const uniqueOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const opt of options) {
      const clean = opt.trim();
      if (!clean) continue;
      const k = clean.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(clean);
    }
    return out;
  }, [options]);

  const filtered = useMemo(() => {
    if (showAll || !value.trim()) return uniqueOptions;
    const q = value.trim().toLowerCase();
    const matches = uniqueOptions.filter((opt) => opt.toLowerCase().includes(q));
    return matches.length > 0 ? matches : uniqueOptions;
  }, [uniqueOptions, value, showAll]);

  return (
    <div ref={wrapRef} className="relative w-full">
      <input
        type="text"
        value={value}
        required={required}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onFocus={() => {
          setShowAll(true);
          setOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setShowAll(false);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className={`${className} pr-8`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={ariaLabel ? `Show ${ariaLabel} suggestions` : 'Show suggestions'}
        onClick={() => {
          setShowAll(true);
          setOpen((v) => !v);
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg grid place-items-center text-slate-400 hover:text-[#1b2a4e]"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {open && filtered.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1.5 z-[90] max-h-60 overflow-y-auto rounded-2xl bg-white border border-slate-200 shadow-xl p-1.5"
        >
          {filtered.map((opt) => {
            const active = opt.toLowerCase() === value.trim().toLowerCase();
            return (
              <li key={opt}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(opt);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-lg text-left text-xs font-semibold transition-colors ${
                    active ? 'bg-brand-50 text-brand-900' : 'text-[#1b2a4e] hover:bg-slate-100'
                  }`}
                >
                  <span className="truncate">{opt}</span>
                  {active && <Check className="w-3.5 h-3.5 shrink-0 text-brand-600" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
