import React from 'react';
import { History, X } from 'lucide-react';
import type { ActivityEvent } from '../types';
import { formatStamp } from '../utils/activity';
import { formatBDT } from '../utils/money';
import { initialsOf } from '../utils/image';
import { ScrollLock } from './ScrollLock';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  events: ActivityEvent[];
  avatars: Record<string, string>;
}

export const ActivityModal: React.FC<Props> = ({ isOpen, onClose, events, avatars }) => {
  if (!isOpen) return null;

  return (
    <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Activity log"
        className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[85vh] flex flex-col"
      >
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <span className="grid place-items-center w-10 h-10 rounded-2xl bg-brand-50 text-brand-700">
            <History className="w-5 h-5" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[#1b2a4e]">Team Activity Log</h2>
            <p className="text-xs text-slate-500">Live chronological record of ledger updates, approvals, and locks.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 divide-y divide-slate-100">
          {events.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">No activity recorded yet.</p>
          ) : (
            events.map((ev) => {
              const photo = avatars[ev.by];
              return (
                <div key={ev.id} className="py-3 flex items-start gap-3 text-xs">
                  {photo ? (
                    <img src={photo} alt="" className="w-8 h-8 rounded-full object-cover border border-slate-200 shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-brand-50 text-brand-700 font-bold flex items-center justify-center shrink-0">
                      {initialsOf(ev.by)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[#1b2a4e]">
                        {ev.by} <span className="font-normal text-slate-500">· {ev.action.replace(/_/g, ' ')}</span>
                      </span>
                      <span className="text-[11px] text-slate-400 whitespace-nowrap">{formatStamp(ev.at)}</span>
                    </div>
                    <div className="text-slate-600 mt-0.5">
                      {[ev.voucherNo, ev.head, ev.amountPaisa ? formatBDT(ev.amountPaisa) : '', ev.detail]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
