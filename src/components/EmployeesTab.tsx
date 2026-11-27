import React, { useMemo, useState } from 'react';
import {
  Building2,
  Camera,
  Edit3,
  Phone,
  Plus,
  Search,
  TrendingDown,
  TrendingUp,
  Upload,
  User,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import type {
  DepartmentRecord,
  Employee,
  EmployeeSpendStat,
  LedgerHead,
} from '../types';
import { dhakaToday } from '../utils/ledger';
import { formatBDT, fromPaisa } from '../utils/money';
import { createEmployee, updateEmployee } from '../utils/cloud';
import { CameraCaptureModal } from './CameraCaptureModal';
import { ComboInput } from './ComboInput';
import { ScrollLock } from './ScrollLock';

interface Props {
  employees: Employee[];
  employeeStats: EmployeeSpendStat[];
  heads: LedgerHead[];
  departments: DepartmentRecord[];
  isAdmin: boolean;
  onOpenEmployee: (emp: Employee) => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
  editingEmployee?: Employee | null;
  onClearEditingEmployee?: () => void;
}

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';

function resizeAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas error'));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Invalid image file.'));
    };
    img.src = url;
  });
}

export const EmployeesTab: React.FC<Props> = ({
  employees,
  employeeStats,
  heads,
  departments,
  isAdmin,
  onOpenEmployee,
  onChanged,
  onToast,
  editingEmployee,
  onClearEditingEmployee,
}) => {
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'all' | 'inactive'>('active');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [role, setRole] = useState('');
  const [department, setDepartment] = useState('');
  const [branch, setBranch] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [monthlySalary, setMonthlySalary] = useState('');
  const [joinedDate, setJoinedDate] = useState(dhakaToday());
  const [active, setActive] = useState(true);
  const [notes, setNotes] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    if (editingEmployee) {
      openEditModal(editingEmployee);
      onClearEditingEmployee?.();
    }
  }, [editingEmployee]);

  const expenseHeads = useMemo(
    () => heads.filter((h) => h.kind === 'expense' && h.active),
    [heads],
  );

  const departmentOptions = useMemo(() => {
    const set = new Set<string>(departments.filter((d) => d.active).map((d) => d.name));
    employees.forEach((e) => e.department && set.add(e.department));
    return Array.from(set);
  }, [departments, employees]);

  const branchOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of expenseHeads) {
      if (!seen.has(h.name)) {
        seen.add(h.name);
        out.push(h.name);
      }
    }
    for (const e of employees) {
      if (e.branch && !seen.has(e.branch)) {
        seen.add(e.branch);
        out.push(e.branch);
      }
    }
    return out;
  }, [expenseHeads, employees]);

  const stats = employeeStats;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stats.filter((s) => {
      if (statusFilter === 'active' && !s.employee.active) return false;
      if (statusFilter === 'inactive' && s.employee.active) return false;
      if (branchFilter !== 'all' && s.employee.branch !== branchFilter) return false;
      if (!q) return true;
      return [s.employee.code, s.employee.name, s.employee.role, s.employee.department, s.employee.branch, s.employee.phone]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [stats, search, branchFilter, statusFilter]);

  const totals = useMemo(() => {
    const activeList = stats.filter((s) => s.employee.active);
    const payrollBase = activeList.reduce((sum, s) => sum + s.employee.monthlySalaryPaisa, 0);
    const totalOp = activeList.reduce((sum, s) => sum + s.operationalTakenPaisa, 0);
    const totalLoan = activeList.reduce((sum, s) => sum + s.activeLoanPaisa, 0);
    const avgOp = activeList[0]?.avgOperationalPaisa || 0;
    const highSpenders = activeList.filter((s) => s.spendLevel === 'high');
    const lowSpenders = [...activeList].sort((a, b) => a.operationalTakenPaisa - b.operationalTakenPaisa).slice(0, 3);
    return { activeCount: activeList.length, payrollBase, totalOp, totalLoan, avgOp, highSpenders, lowSpenders };
  }, [stats]);

  const openAddModal = () => {
    setEditing(null);
    setName('');
    setCode('');
    setRole('');
    setDepartment('');
    setBranch('');
    setPhone('');
    setEmail('');
    setMonthlySalary('');
    setJoinedDate(dhakaToday());
    setActive(true);
    setNotes('');
    setPhotoUrl('');
    setError('');
    setModalOpen(true);
  };

  function openEditModal(emp: Employee) {
    setEditing(emp);
    setName(emp.name);
    setCode(emp.code);
    setRole(emp.role);
    setDepartment(emp.department);
    setBranch(emp.branch || '');
    setPhone(emp.phone);
    setEmail(emp.email || '');
    setMonthlySalary(fromPaisa(emp.monthlySalaryPaisa));
    setJoinedDate(emp.joinedDate || dhakaToday());
    setActive(emp.active);
    setNotes(emp.notes || '');
    setPhotoUrl(emp.photoUrl || '');
    setError('');
    setModalOpen(true);
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Employee name is required.'); return; }
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await updateEmployee(editing.id, {
          name: name.trim(),
          role: role.trim(),
          department: department.trim(),
          branch,
          phone: phone.trim(),
          email: email.trim(),
          monthlySalary: monthlySalary || undefined,
          joinedDate,
          active,
          notes: notes.trim(),
          photoUrl,
        });
        onToast(`${name.trim()} updated`);
      } else {
        await createEmployee({
          code: code.trim() || undefined,
          name: name.trim(),
          role: role.trim(),
          department: department.trim(),
          branch,
          phone: phone.trim(),
          email: email.trim(),
          monthlySalary: monthlySalary || undefined,
          joinedDate,
          notes: notes.trim(),
          photoUrl,
        });
        onToast(`${name.trim()} added to staff directory`);
      }
      onChanged();
      setModalOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Could not save employee.');
    } finally {
      setBusy(false);
    }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const resized = await resizeAvatarDataUrl(file);
      setPhotoUrl(resized);
    } catch (err: any) {
      setError(err?.message || 'Could not process photo.');
    }
  };

  const selectCls = 'h-9 px-3 text-xs font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-brand-500';
  const fieldCls = 'w-full h-10 px-3 text-sm text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500';

  const spendBadge = (s: EmployeeSpendStat) => {
    if (s.spendLevel === 'high') return <span className="text-[11px] font-bold text-rose-600">High Spend</span>;
    if (s.spendLevel === 'low') return <span className="text-[11px] font-bold text-emerald-600">Low Spend</span>;
    return <span className="text-[11px] font-semibold text-slate-500">Normal</span>;
  };

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className={`font-display text-2xl font-extrabold tracking-tight ${INK}`}>Employees &amp; Spend Watch</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Staff profiles, monthly salary bases, operational expenses taken, and active loan balances.
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={openAddModal}
            className="h-9 px-4 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Add Employee
          </button>
        )}
      </div>

      
      <div className="grid grid-cols-1 @md:grid-cols-2 @5xl:grid-cols-4 gap-4">
        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Active Staff</span>
            <Users className="w-4 h-4 text-brand-600" />
          </div>
          <div className={`text-2xl font-extrabold tabular-nums mt-2 ${INK}`}>{totals.activeCount}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{employees.length} total records</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Monthly Payroll Base</span>
            <Wallet className="w-4 h-4 text-brand-600" />
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-brand-700 mt-2">{formatBDT(totals.payrollBase)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Scheduled active salaries</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Expenses / Advances Taken</span>
            <TrendingUp className="w-4 h-4 text-rose-500" />
          </div>
          <div className={`text-2xl font-extrabold tabular-nums mt-2 ${INK}`}>{formatBDT(totals.totalOp)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">Team average: {formatBDT(totals.avgOp)}</div>
        </div>

        <div className={`${SURFACE} p-4`}>
          <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
            <span>Active Loan Balance</span>
            <Building2 className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-amber-600 mt-2">{formatBDT(totals.totalLoan)}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">Deductible via payroll or cash</div>
        </div>
      </div>

      
      <div className="grid grid-cols-1 @4xl:grid-cols-2 gap-5">
        <section className={`${SURFACE} p-5 space-y-3`}>
          <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-2 text-sm font-bold text-[#1b2a4e]">
              <TrendingUp className="w-4 h-4 text-rose-600" />
              Taking More Than Team Average
            </div>
            <span className="text-xs text-slate-400 tabular-nums">Avg {formatBDT(totals.avgOp)}</span>
          </div>
          {totals.highSpenders.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">All staff are within normal spend range.</div>
          ) : (
            <div className="space-y-2">
              {totals.highSpenders.map((s) => (
                <button
                  key={s.employee.id}
                  type="button"
                  onClick={() => onOpenEmployee(s.employee)}
                  className="w-full text-left px-3.5 py-2.5 rounded-2xl bg-slate-50/70 hover:bg-slate-50 border border-slate-100 flex items-center justify-between gap-3 transition-colors"
                >
                  <div className="min-w-0">
                    <div className={`text-xs font-bold truncate ${INK}`}>{s.employee.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{s.employee.role} · {s.employee.branch}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-extrabold text-rose-600 tabular-nums">
                      {formatBDT(s.operationalTakenPaisa)}
                    </div>
                    <div className="text-[10.5px] text-slate-400 tabular-nums">{s.txCount} linked vouchers</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className={`${SURFACE} p-5 space-y-3`}>
          <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
            <div className="flex items-center gap-2 text-sm font-bold text-[#1b2a4e]">
              <TrendingDown className="w-4 h-4 text-emerald-600" />
              Taking Least Expenses / Advances
            </div>
            <span className="text-xs text-slate-400">Non-salary funds</span>
          </div>
          {totals.lowSpenders.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">No active staff found.</div>
          ) : (
            <div className="space-y-2">
              {totals.lowSpenders.map((s) => (
                <button
                  key={s.employee.id}
                  type="button"
                  onClick={() => onOpenEmployee(s.employee)}
                  className="w-full text-left px-3.5 py-2.5 rounded-2xl bg-slate-50/70 hover:bg-slate-50 border border-slate-100 flex items-center justify-between gap-3 transition-colors"
                >
                  <div className="min-w-0">
                    <div className={`text-xs font-bold truncate ${INK}`}>{s.employee.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{s.employee.role} · {s.employee.branch}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-extrabold text-emerald-600 tabular-nums">
                      {formatBDT(s.operationalTakenPaisa)}
                    </div>
                    <div className="text-[10.5px] text-slate-400 tabular-nums">{s.txCount} linked vouchers</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      
      <section className={`${SURFACE} overflow-hidden`}>
        <div className="p-4 border-b border-slate-100 flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search code, name, role, phone..."
              className="w-full h-9 pl-9 pr-3 text-xs text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500"
            />
          </div>
          <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} className={selectCls}>
            <option value="all">All Offices &amp; Projects</option>
            {branchOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className={selectCls}>
            <option value="active">Active Only</option>
            <option value="all">All Staff</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">No employees match your filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Role &amp; Office</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3 text-right">Base Salary</th>
                  <th className="px-4 py-3 text-right">Expenses Taken</th>
                  <th className="px-4 py-3 text-right">Active Loan</th>
                  <th className="px-4 py-3">Spend Level</th>
                  {isAdmin && <th className="px-4 py-3 text-right">Action</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((s) => {
                  const emp = s.employee;
                  const initials = emp.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
                  return (
                    <tr
                      key={emp.id}
                      onClick={() => onOpenEmployee(emp)}
                      className="cursor-pointer hover:bg-slate-50/90 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {emp.photoUrl ? (
                            <img src={emp.photoUrl} alt={emp.name} className="w-8 h-8 rounded-full object-cover border border-slate-200 shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-brand-700 text-white grid place-items-center text-[11px] font-bold shrink-0">
                              {initials || <User className="w-3.5 h-3.5" />}
                            </div>
                          )}
                          <div>
                            <div className={`font-bold ${INK}`}>{emp.name}</div>
                            <div className="text-[11px] font-mono text-slate-400">{emp.code}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[#1b2a4e]">{emp.role}</div>
                        <div className="text-[11px] text-slate-500">{emp.branch}</div>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-slate-600">
                        {emp.phone ? (
                          <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3 text-slate-400" /> {emp.phone}</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums text-[#1b2a4e]">
                        {formatBDT(emp.monthlySalaryPaisa)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums text-rose-600">
                        {formatBDT(s.operationalTakenPaisa)}
                      </td>
                      <td className={`px-4 py-3 text-right font-bold tabular-nums ${s.activeLoanPaisa > 0 ? 'text-amber-600' : 'text-slate-400'}`}>
                        {formatBDT(s.activeLoanPaisa)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{spendBadge(s)}</td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            onClick={() => openEditModal(emp)}
                            className="w-7 h-7 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 hover:text-[#1b2a4e] inline-grid place-items-center"
                            title="Edit employee"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      
      {modalOpen && (
        <div className="no-print fixed inset-0 z-[75] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div className="bg-white w-full max-w-xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className={`text-base font-bold ${INK}`}>
                {editing ? `Edit Employee · ${editing.code}` : 'Add Employee Profile'}
              </h2>
              <button type="button" onClick={() => setModalOpen(false)} className="w-8 h-8 rounded-full grid place-items-center text-slate-400 hover:bg-slate-100">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-6 space-y-4 overflow-y-auto">
              {error && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs text-rose-700 font-medium">
                  {error}
                </div>
              )}

              
              <div className="flex items-center gap-4">
                {photoUrl ? (
                  <img src={photoUrl} alt="Avatar" className="w-16 h-16 rounded-2xl object-cover border border-slate-200 shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-2xl bg-slate-100 text-slate-400 grid place-items-center shrink-0">
                    <User className="w-6 h-6" />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCameraOpen(true)}
                    className="h-9 px-3 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-xs font-semibold text-brand-900 inline-flex items-center gap-1.5"
                  >
                    <Camera className="w-3.5 h-3.5" /> Take Photo
                  </button>
                  <label className="h-9 px-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white text-xs font-semibold text-[#1b2a4e] inline-flex items-center gap-1.5 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" /> Upload
                    <input type="file" accept="image/*" onChange={handlePhotoUpload} className="hidden" />
                  </label>
                  {photoUrl && (
                    <button type="button" onClick={() => setPhotoUrl('')} className="text-xs text-rose-600 hover:underline px-2">
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Full Name *</label>
                  <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Employee full name" className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Staff Code (Auto if blank)</label>
                  <input type="text" disabled={Boolean(editing)} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Staff code" className={`${fieldCls} font-mono`} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Role / Designation *</label>
                  <input type="text" required value={role} onChange={(e) => setRole(e.target.value)} className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Department</label>
                  <ComboInput
                    value={department}
                    onChange={setDepartment}
                    options={departmentOptions}
                    placeholder="Type or select department..."
                    ariaLabel="Department"
                    className={fieldCls}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Assigned Office / Head</label>
                  <ComboInput
                    value={branch}
                    onChange={setBranch}
                    options={branchOptions}
                    placeholder="Type or select office/project..."
                    ariaLabel="Assigned Office or Head"
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Monthly Base Salary (BDT ৳)</label>
                  <input type="text" inputMode="decimal" value={monthlySalary} onChange={(e) => setMonthlySalary(e.target.value)} placeholder="Enter monthly salary" className={`${fieldCls} font-mono tabular-nums`} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Phone</label>
                  <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Enter phone number" className={fieldCls} />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Joined Date</label>
                  <input type="date" value={joinedDate} onChange={(e) => setJoinedDate(e.target.value)} className={fieldCls} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Email (Optional)</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter email address" className={fieldCls} />
                </div>
                {editing && (
                  <div className="flex items-end pb-2">
                    <label className="inline-flex items-center gap-2 text-xs font-semibold text-[#1b2a4e] cursor-pointer">
                      <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-brand-700" />
                      Active Staff Member
                    </label>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Notes</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remark..." className={fieldCls} />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setModalOpen(false)} className="h-10 px-4 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
                  Cancel
                </button>
                <button type="submit" disabled={busy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold disabled:opacity-60">
                  {busy ? 'Saving...' : editing ? 'Save Changes' : 'Add Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CameraCaptureModal
        isOpen={cameraOpen}
        title="Take Employee Photo"
        maxWidth={280}
        quality={0.85}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => setPhotoUrl(file.data)}
      />
    </div>
  );
};
