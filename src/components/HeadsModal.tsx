import React, { useState } from 'react';
import { Check, Edit3, Plus, SlidersHorizontal, X } from 'lucide-react';
import type { DepartmentRecord, LedgerHead, LedgerKind } from '../types';
import { renameDepartment, renameHead, saveDepartment, saveHead } from '../utils/cloud';
import { ScrollLock } from './ScrollLock';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  isAdmin: boolean;
  onChanged: () => void;
  onDepartmentsChanged: () => void;
  onToast: (msg: string) => void;
}

export const HeadsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  heads,
  departments,
  isAdmin,
  onChanged,
  onDepartmentsChanged,
  onToast,
}) => {
  const [kind, setKind] = useState<LedgerKind | 'department' | ''>('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKind, setEditingKind] = useState<'head' | 'department'>('head');
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const incomeHeads = heads.filter((h) => h.kind === 'income');
  const expenseHeads = heads.filter((h) => h.kind === 'expense');

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !kind || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'department') {
        await saveDepartment({ name: name.trim(), description: description.trim(), active: true });
        onDepartmentsChanged();
      } else {
        await saveHead({ kind, name: name.trim(), description: description.trim(), active: true });
        onChanged();
      }
      setName('');
      setDescription('');
      onToast(`${name.trim()} saved`);
    } catch (err: any) {
      setError(err?.message || 'Could not save entry.');
    } finally {
      setBusy(false);
    }
  };

  const toggleHeadActive = async (h: LedgerHead) => {
    if (!isAdmin) return;
    setBusy(true);
    try {
      await saveHead({ kind: h.kind, name: h.name, description: h.description || '', active: !h.active });
      onChanged();
      onToast(`${h.name} ${!h.active ? 'activated' : 'archived'}`);
    } catch (err: any) {
      setError(err?.message || 'Could not update.');
    } finally {
      setBusy(false);
    }
  };

  const toggleDeptActive = async (d: DepartmentRecord) => {
    if (!isAdmin) return;
    setBusy(true);
    try {
      await saveDepartment({ name: d.name, description: d.description || '', active: !d.active });
      onDepartmentsChanged();
      onToast(`${d.name} ${!d.active ? 'activated' : 'archived'}`);
    } catch (err: any) {
      setError(err?.message || 'Could not update department.');
    } finally {
      setBusy(false);
    }
  };

  const startEditHead = (h: LedgerHead) => {
    setEditingKind('head');
    setEditingId(h.id);
    setEditName(h.name);
    setEditDesc(h.description || '');
    setError('');
  };

  const startEditDept = (d: DepartmentRecord) => {
    setEditingKind('department');
    setEditingId(d.id);
    setEditName(d.name);
    setEditDesc(d.description || '');
    setError('');
  };

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !editingId || !editName.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (editingKind === 'department') {
        await renameDepartment(editingId, { name: editName.trim(), description: editDesc.trim() });
        onDepartmentsChanged();
      } else {
        await renameHead(editingId, { name: editName.trim(), description: editDesc.trim() });
        onChanged();
      }
      setEditingId(null);
      onToast(`${editName.trim()} updated`);
    } catch (err: any) {
      setError(err?.message || 'Could not rename.');
    } finally {
      setBusy(false);
    }
  };

  const renderHeadList = (items: LedgerHead[], title: string, titleCls: string) => (
    <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
      <h3 className={`text-xs font-bold uppercase tracking-wider ${titleCls}`}>{title} ({items.length})</h3>
      {items.map((h) => (
        <div key={h.id} className="py-1.5 border-b border-slate-100 last:border-b-0 text-xs">
          {editingKind === 'head' && editingId === h.id ? (
            <form onSubmit={handleRename} className="space-y-1.5 py-1">
              <input
                type="text"
                required
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Channel or field name"
                className="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500"
              />
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="flex-1 h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="h-8 px-2.5 rounded-lg bg-brand-700 text-white text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <Check className="w-3 h-3" /> Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="h-8 px-2 text-[11px] text-slate-500 hover:text-slate-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className={`font-semibold truncate ${h.active ? 'text-[#1b2a4e]' : 'text-slate-400 line-through'}`}>{h.name}</div>
                {h.description && <div className="text-[11px] text-slate-400 truncate">{h.description}</div>}
              </div>
              {isAdmin && (
                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startEditHead(h)}
                    title="Rename"
                    aria-label={`Rename ${h.name}`}
                    className="text-[11px] font-semibold text-brand-700 hover:underline inline-flex items-center gap-0.5"
                  >
                    <Edit3 className="w-3 h-3" /> Edit
                  </button>
                  <button type="button" disabled={busy} onClick={() => toggleHeadActive(h)} className="text-[11px] font-semibold text-slate-500 hover:text-[#1b2a4e]">
                    {h.active ? 'Archive' : 'Enable'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
      <ScrollLock />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Channels, Offices, and Departments"
        className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[90vh] flex flex-col"
      >
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <span className="grid place-items-center w-10 h-10 rounded-2xl bg-brand-50 text-brand-700">
            <SlidersHorizontal className="w-5 h-5" />
          </span>
          <div>
            <h2 className="text-base font-bold text-[#1b2a4e]">Channels, Offices &amp; Departments</h2>
            <p className="text-xs text-slate-500">
              {isAdmin
                ? 'Manage income channels, expense offices, and mandatory transaction departments.'
                : 'Directory of active income channels, expense offices, and departments.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto grid place-items-center w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">
          {error && <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700">{error}</div>}

          {isAdmin && (
            <form onSubmit={handleAdd} className="rounded-2xl bg-slate-50 border border-slate-100 p-4 grid grid-cols-1 sm:grid-cols-[150px_1fr_1fr_auto] gap-2.5">
              <select value={kind} onChange={(e) => setKind(e.target.value as LedgerKind | 'department' | '')} required className="h-10 px-3 text-xs font-semibold bg-white border border-slate-200 rounded-xl">
                <option value="">Select type</option>
                <option value="department">Department</option>
                <option value="income">Income Channel</option>
                <option value="expense">Expense Office</option>
              </select>
              <input type="text" required placeholder="Custom name" value={name} onChange={(e) => setName(e.target.value)} className="h-10 px-3 text-xs bg-white border border-slate-200 rounded-xl" />
              <input type="text" placeholder="Short description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} className="h-10 px-3 text-xs bg-white border border-slate-200 rounded-xl" />
              <button disabled={busy || !kind || !name.trim()} className="h-10 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1 disabled:opacity-50">
                <Plus className="w-4 h-4" /> Add
              </button>
            </form>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-slate-100 p-4 space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-brand-700">Departments ({departments.length})</h3>
              {departments.map((d) => (
                <div key={d.id} className="py-1.5 border-b border-slate-100 last:border-b-0 text-xs">
                  {editingKind === 'department' && editingId === d.id ? (
                    <form onSubmit={handleRename} className="space-y-1.5 py-1">
                      <input
                        type="text"
                        required
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Department name"
                        className="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500"
                      />
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          placeholder="Description (optional)"
                          className="flex-1 h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-brand-500"
                        />
                        <button
                          type="submit"
                          disabled={busy}
                          className="h-8 px-2.5 rounded-lg bg-brand-700 text-white text-[11px] font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          <Check className="w-3 h-3" /> Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="h-8 px-2 text-[11px] text-slate-500 hover:text-slate-800"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className={`font-semibold truncate ${d.active ? 'text-[#1b2a4e]' : 'text-slate-400 line-through'}`}>{d.name}</div>
                        {d.description && <div className="text-[11px] text-slate-400 truncate">{d.description}</div>}
                      </div>
                      {isAdmin && (
                        <div className="flex items-center gap-2.5 shrink-0">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEditDept(d)}
                            title="Rename"
                            aria-label={`Rename ${d.name}`}
                            className="text-[11px] font-semibold text-brand-700 hover:underline inline-flex items-center gap-0.5"
                          >
                            <Edit3 className="w-3 h-3" /> Edit
                          </button>
                          <button type="button" disabled={busy} onClick={() => toggleDeptActive(d)} className="text-[11px] font-semibold text-slate-500 hover:text-[#1b2a4e]">
                            {d.active ? 'Archive' : 'Enable'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {renderHeadList(incomeHeads, 'Income Channels', 'text-emerald-700')}
            {renderHeadList(expenseHeads, 'Expense Offices & Projects', 'text-[#1b2a4e]')}
          </div>
        </div>
      </div>
    </div>
  );
};
