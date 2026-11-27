import React, { useMemo, useState } from 'react';
import {
  Building2,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Paperclip,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type {
  DepartmentRecord,
  FundSource,
  LedgerTransaction,
  RentCategory,
  RentItem,
  RentPayment,
} from '../types';
import {
  PAYMENT_METHODS,
  dhakaMonth,
  dhakaToday,
  formatMonthLabel,
  formatShortDate,
  shiftMonthKey,
} from '../utils/ledger';
import { formatBDT, fromPaisa, toPaisa } from '../utils/money';
import {
  createRentItem,
  deleteRentItem,
  deleteRentPayment,
  recordRentPayment,
  updateRentItem,
} from '../utils/cloud';
import { CameraCaptureModal } from './CameraCaptureModal';
import { ComboInput } from './ComboInput';
import { ScrollLock } from './ScrollLock';

interface Props {
  rentItems: RentItem[];
  rentPayments: RentPayment[];
  departments: DepartmentRecord[];
  fundSources: FundSource[];
  transactions: LedgerTransaction[];
  isAdmin: boolean;
  /** Admin or accountant: may record payments and entries. */
  canEdit: boolean;
  onOpenTx: (tx: LedgerTransaction) => void;
  onOpenTxId: (id: string) => void;
  onChanged: () => void;
  onToast: (msg: string) => void;
}

const INK = 'text-[#1b2a4e]';
const SURFACE = 'bg-white rounded-3xl border border-slate-100 shadow-[0_12px_32px_-16px_rgba(30,50,110,0.22)]';
const fieldCls =
  'w-full h-10 px-3 text-sm text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl hover:bg-white focus:outline-none focus:bg-white focus:border-brand-500';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';

export const RentTab: React.FC<Props> = ({
  rentItems,
  rentPayments,
  departments,
  fundSources,
  transactions,
  isAdmin,
  canEdit,
  onOpenTx,
  onOpenTxId,
  onChanged,
  onToast,
}) => {
  const [monthKey, setMonthKey] = useState(dhakaMonth);
  const [categoryFilter, setCategoryFilter] = useState<'all' | RentCategory>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'unpaid'>('all');
  const [search, setSearch] = useState('');

  const [payingItem, setPayingItem] = useState<RentItem | null>(null);
  const [payDate, setPayDate] = useState(dhakaToday);
  const [payAmount, setPayAmount] = useState('');
  const [payDepartment, setPayDepartment] = useState('');
  const [payFundSourceId, setPayFundSourceId] = useState('');
  const [payMethod, setPayMethod] = useState('');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payReceipt, setPayReceipt] = useState<{ name: string; data: string } | undefined>(undefined);
  const [payCameraOpen, setPayCameraOpen] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState('');

  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<RentItem | null>(null);
  const [itemSl, setItemSl] = useState('');
  const [itemName, setItemName] = useState('');
  const [itemCategory, setItemCategory] = useState<RentCategory>('regular');
  const [itemMonthlyAmount, setItemMonthlyAmount] = useState('');
  const [itemUrgentAmount, setItemUrgentAmount] = useState('');
  const [itemDepartment, setItemDepartment] = useState('');
  const [itemNotes, setItemNotes] = useState('');
  const [itemActive, setItemActive] = useState(true);
  const [itemBusy, setItemBusy] = useState(false);
  const [itemError, setItemError] = useState('');
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(false);
  const [confirmDeletePayId, setConfirmDeletePayId] = useState<string | null>(null);

  const activeDepartments = useMemo(() => departments.filter((d) => d.active), [departments]);
  const activeSources = useMemo(() => fundSources.filter((f) => f.active), [fundSources]);

  const monthPayments = useMemo(
    () => rentPayments.filter((p) => p.monthKey === monthKey),
    [rentPayments, monthKey],
  );

  const paymentsByItem = useMemo(() => {
    const map = new Map<string, RentPayment[]>();
    for (const p of monthPayments) {
      const list = map.get(p.rentItemId) || [];
      list.push(p);
      map.set(p.rentItemId, list);
    }
    return map;
  }, [monthPayments]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rentItems
      .filter((item) => item.active || (paymentsByItem.get(item.id)?.length || 0) > 0)
      .filter((item) => {
        if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
        const paidList = paymentsByItem.get(item.id) || [];
        const paidPaisa = paidList.reduce((s, p) => s + p.amountPaisa, 0);
        const scheduled = item.monthlyAmountPaisa + item.urgentAmountPaisa;
        const isPaid = paidPaisa > 0 && (scheduled === 0 || paidPaisa >= scheduled);
        if (statusFilter === 'paid' && !isPaid) return false;
        if (statusFilter === 'unpaid' && isPaid) return false;
        if (!q) return true;
        return [item.name, item.department, item.notes, String(item.sl)].filter(Boolean).join(' ').toLowerCase().includes(q);
      });
  }, [rentItems, paymentsByItem, categoryFilter, statusFilter, search]);

  const metrics = useMemo(() => {
    let regularPaisa = 0;
    let urgentPaisa = 0;
    let paidPaisa = 0;
    let pendingPaisa = 0;
    for (const item of rentItems) {
      if (!item.active) continue;
      regularPaisa += item.monthlyAmountPaisa;
      urgentPaisa += item.urgentAmountPaisa;
      const paidList = paymentsByItem.get(item.id) || [];
      const paid = paidList.reduce((s, p) => s + p.amountPaisa, 0);
      const due = item.monthlyAmountPaisa + item.urgentAmountPaisa;
      pendingPaisa += Math.max(0, due - paid);
    }
    for (const p of monthPayments) {
      paidPaisa += p.amountPaisa;
    }
    return { regularPaisa, urgentPaisa, paidPaisa, pendingPaisa };
  }, [rentItems, paymentsByItem, monthPayments]);

  const openPayModal = (item: RentItem) => {
    const paid = (paymentsByItem.get(item.id) || []).reduce((s, p) => s + p.amountPaisa, 0);
    const remaining = Math.max(0, item.monthlyAmountPaisa + item.urgentAmountPaisa - paid);
    setPayingItem(item);
    setPayDate(dhakaToday());
    setPayAmount(remaining > 0 ? fromPaisa(remaining) : '');
    setPayDepartment('');
    setPayFundSourceId('');
    setPayMethod('');
    setPayRef('');
    setPayNotes('');
    setPayReceipt(undefined);
    setPayError('');
  };

  const openItemModal = (item: RentItem | null) => {
    setEditingItem(item);
    setItemSl(item ? String(item.sl) : '');
    setItemName(item?.name || '');
    setItemCategory(item?.category || 'regular');
    setItemMonthlyAmount(item && item.monthlyAmountPaisa > 0 ? fromPaisa(item.monthlyAmountPaisa) : '');
    setItemUrgentAmount(item && item.urgentAmountPaisa > 0 ? fromPaisa(item.urgentAmountPaisa) : '');
    setItemDepartment(item?.department || '');
    setItemNotes(item?.notes || '');
    setItemActive(item ? item.active : true);
    setItemError('');
    setConfirmDeleteItem(false);
    setItemModalOpen(true);
  };

  const handlePayFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setPayError('Receipt file must be under 10 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setPayReceipt({ name: file.name, data: reader.result });
    };
    reader.readAsDataURL(file);
  };

  const handlePaySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingItem) return;
    setPayError('');
    const paisa = toPaisa(payAmount);
    if (!paisa || paisa <= 0) {
      setPayError('Enter a valid amount greater than ৳0.00.');
      return;
    }
    if (!payDepartment.trim()) {
      setPayError('Select the Department for this payment.');
      return;
    }
    if (!payFundSourceId) {
      setPayError('Select the Funding Source.');
      return;
    }
    if (!payMethod.trim()) {
      setPayError('Select or type a payment method.');
      return;
    }
    setPayBusy(true);
    try {
      const payment = await recordRentPayment({
        rentItemId: payingItem.id,
        monthKey,
        paidDate: payDate,
        amount: payAmount,
        department: payDepartment.trim(),
        fundSourceId: payFundSourceId,
        paymentMethod: payMethod.trim(),
        referenceNo: payRef.trim(),
        notes: payNotes.trim(),
        receipt: payReceipt,
      });
      setPayingItem(null);
      onChanged();
      onToast(`Recorded ${formatBDT(payment.amountPaisa)} for ${payment.rentItemName} (${payment.linkedVoucherNo || payment.monthKey})`);
    } catch (err: any) {
      setPayError(err?.message || 'Could not record rent payment.');
    } finally {
      setPayBusy(false);
    }
  };

  const handleSaveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setItemError('');
    if (!itemName.trim()) {
      setItemError('Enter the premises / utility name.');
      return;
    }
    if (!itemDepartment.trim()) {
      setItemError('Select the Department for this rent obligation.');
      return;
    }
    const monthlyPaisa = toPaisa(itemMonthlyAmount || '0');
    const urgentPaisa = toPaisa(itemUrgentAmount || '0');
    if (monthlyPaisa === null || urgentPaisa === null || (monthlyPaisa <= 0 && urgentPaisa <= 0)) {
      setItemError('Enter a monthly or urgent scheduled amount greater than ৳0.00.');
      return;
    }
    const parsedSl = Number.parseInt(itemSl, 10);
    setItemBusy(true);
    try {
      if (editingItem) {
        await updateRentItem(editingItem.id, {
          ...(Number.isFinite(parsedSl) && parsedSl > 0 ? { sl: parsedSl } : {}),
          name: itemName.trim(),
          category: itemCategory,
          monthlyAmount: itemMonthlyAmount || '0',
          urgentAmount: itemUrgentAmount || '0',
          department: itemDepartment.trim(),
          notes: itemNotes.trim(),
          active: itemActive,
        });
        onToast('Updated rent item');
      } else {
        await createRentItem({
          ...(Number.isFinite(parsedSl) && parsedSl > 0 ? { sl: parsedSl } : {}),
          name: itemName.trim(),
          category: itemCategory,
          monthlyAmount: itemMonthlyAmount || '0',
          urgentAmount: itemUrgentAmount || '0',
          department: itemDepartment.trim(),
          notes: itemNotes.trim(),
          active: itemActive,
        });
        onToast('Added rent obligation');
      }
      setItemModalOpen(false);
      onChanged();
    } catch (err: any) {
      setItemError(err?.message || 'Could not save rent item.');
    } finally {
      setItemBusy(false);
    }
  };

  const handleDeleteItem = async () => {
    if (!editingItem) return;
    setItemBusy(true);
    try {
      await deleteRentItem(editingItem.id);
      setItemModalOpen(false);
      onChanged();
      onToast('Removed rent item');
    } catch (err: any) {
      setItemError(err?.message || 'Could not remove rent item.');
    } finally {
      setItemBusy(false);
    }
  };

  const handleDeletePayment = async (payment: RentPayment) => {
    try {
      await deleteRentPayment(payment.id);
      setConfirmDeletePayId(null);
      onChanged();
      onToast(`Removed rent payment ${payment.linkedVoucherNo || payment.monthKey}`);
    } catch (err: any) {
      onToast(err?.message || 'Could not remove rent payment.');
    }
  };

  return (
    <div className="max-w-[1800px] mx-auto px-4 @md:px-6 @5xl:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className={`font-display text-2xl font-extrabold tracking-tight ${INK}`}>Office Rent &amp; Utilities</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Track monthly office rents, POP/router utilities, urgent rent bills, and auto-linked Daily Ledger vouchers.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl px-1.5 h-9 shadow-xs">
            <button
              type="button"
              onClick={() => setMonthKey((m) => shiftMonthKey(m, -1))}
              className="w-7 h-7 rounded-lg hover:bg-slate-100 grid place-items-center text-slate-600"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input
              type="month"
              value={monthKey}
              onChange={(e) => e.target.value && setMonthKey(e.target.value)}
              className="h-7 px-1 text-xs font-bold text-[#1b2a4e] bg-transparent focus:outline-none tabular-nums"
              aria-label="Rent month"
            />
            <button
              type="button"
              onClick={() => setMonthKey((m) => shiftMonthKey(m, 1))}
              className="w-7 h-7 rounded-lg hover:bg-slate-100 grid place-items-center text-slate-600"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={() => openItemModal(null)}
              className="h-9 px-3.5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" /> Add Rent Item
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 @4xl:grid-cols-4 gap-4">
        <div className={`${SURFACE} p-4`}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Regular Monthly Rent</div>
          <div className={`text-xl font-extrabold tabular-nums mt-1 ${INK}`}>{formatBDT(metrics.regularPaisa)}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{rentItems.filter((i) => i.active && i.category === 'regular').length} recurring obligations</div>
        </div>
        <div className={`${SURFACE} p-4`}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Urgent / Ad-hoc Rent</div>
          <div className="text-xl font-extrabold tabular-nums mt-1 text-amber-700">{formatBDT(metrics.urgentPaisa)}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{rentItems.filter((i) => i.active && i.category === 'urgent').length} urgent items</div>
        </div>
        <div className={`${SURFACE} p-4`}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Paid ({formatMonthLabel(monthKey)})</div>
          <div className="text-xl font-extrabold tabular-nums mt-1 text-brand-700">{formatBDT(metrics.paidPaisa)}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">{monthPayments.length} payment vouchers</div>
        </div>
        <div className={`${SURFACE} p-4`}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Remaining Pending</div>
          <div className={`text-xl font-extrabold tabular-nums mt-1 ${metrics.pendingPaisa > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
            {formatBDT(metrics.pendingPaisa)}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">Scheduled minus paid this month</div>
        </div>
      </div>

      <div className={`${SURFACE} p-4 flex flex-wrap items-center gap-2.5`}>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search office, POP, utility, department..."
            className="w-full h-9 pl-9 pr-3 text-xs text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:bg-white focus:border-brand-500"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as 'all' | RentCategory)}
          className="h-9 px-3 text-xs font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-brand-500"
        >
          <option value="all">All Categories</option>
          <option value="regular">Regular Rent Only</option>
          <option value="urgent">Urgent Rent Only</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'paid' | 'unpaid')}
          className="h-9 px-3 text-xs font-semibold text-[#1b2a4e] bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-brand-500"
        >
          <option value="all">All Statuses</option>
          <option value="unpaid">Unpaid / Partial</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      <section className={`${SURFACE} overflow-hidden`}>
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">
            No rent items match the selected filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 w-14">SL</th>
                  <th className="px-4 py-3">Premises / Obligation</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Department</th>
                  <th className="px-4 py-3 text-right">Scheduled</th>
                  <th className="px-4 py-3">Paid ({formatMonthLabel(monthKey)})</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((item) => {
                  const paidList = paymentsByItem.get(item.id) || [];
                  const paidTotal = paidList.reduce((s, p) => s + p.amountPaisa, 0);
                  const scheduledTotal = item.monthlyAmountPaisa + item.urgentAmountPaisa;
                  const remaining = Math.max(0, scheduledTotal - paidTotal);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3 font-mono font-bold text-slate-400 tabular-nums">{item.sl}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Building2 className="w-3.5 h-3.5 text-brand-600 shrink-0" />
                          <span className={`font-bold ${INK}`}>{item.name}</span>
                          {!item.active && <span className="text-[10px] font-semibold text-slate-400">(Inactive)</span>}
                        </div>
                        {item.notes && <div className="text-[11px] text-slate-500 mt-0.5 pl-5">{item.notes}</div>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`font-semibold ${item.category === 'urgent' ? 'text-amber-700' : 'text-slate-600'}`}>
                          {item.category === 'urgent' ? 'Urgent' : 'Regular'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{item.department || '—'}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold tabular-nums">
                        <div className={INK}>{formatBDT(scheduledTotal)}</div>
                        {item.monthlyAmountPaisa > 0 && item.urgentAmountPaisa > 0 && (
                          <div className="text-[10px] text-slate-400 font-sans">
                            Reg {formatBDT(item.monthlyAmountPaisa)} + Urg {formatBDT(item.urgentAmountPaisa)}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {paidList.length === 0 ? (
                          <span className="text-slate-400">Unpaid · {formatBDT(scheduledTotal)} due</span>
                        ) : (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5 font-bold text-emerald-700 tabular-nums">
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              {formatBDT(paidTotal)}
                              {remaining > 0 && (
                                <span className="text-amber-700 font-semibold text-[11px]">
                                  (Due {formatBDT(remaining)})
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {paidList.map((p) => {
                                const linkedTx = transactions.find((t) => t.id === p.linkedTxId);
                                return (
                                  <span key={p.id} className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                                    <button
                                      type="button"
                                      onClick={() => linkedTx ? onOpenTx(linkedTx) : p.linkedTxId ? onOpenTxId(p.linkedTxId) : undefined}
                                      className="font-mono font-semibold text-brand-700 hover:underline"
                                      title={`${formatShortDate(p.paidDate)} · ${p.department}`}
                                    >
                                      {p.linkedVoucherNo || p.referenceNo || 'Voucher'}
                                    </button>
                                    <span>({formatBDT(p.amountPaisa)})</span>
                                    {isAdmin && (
                                      confirmDeletePayId === p.id ? (
                                        <span className="inline-flex items-center gap-1 ml-0.5">
                                          <button
                                            type="button"
                                            onClick={() => void handleDeletePayment(p)}
                                            className="text-rose-600 font-bold hover:underline"
                                          >
                                            Confirm
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => setConfirmDeletePayId(null)}
                                            className="text-slate-400 hover:text-slate-700"
                                          >
                                            Cancel
                                          </button>
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          onClick={() => setConfirmDeletePayId(p.id)}
                                          className="text-slate-400 hover:text-rose-600"
                                          title="Delete rent payment"
                                          aria-label={`Delete payment ${p.linkedVoucherNo || p.id}`}
                                        >
                                          <Trash2 className="w-3 h-3" />
                                        </button>
                                      )
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          {canEdit && (
                          <button
                            type="button"
                            onClick={() => openPayModal(item)}
                            className="h-8 px-3 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-[11px] font-semibold transition-colors"
                          >
                            {paidList.length > 0 ? 'Add Payment' : 'Pay Rent'}
                          </button>
                          )}
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => openItemModal(item)}
                              title="Edit rent item"
                              aria-label={`Edit ${item.name}`}
                              className="w-8 h-8 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 inline-grid place-items-center"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {payingItem && (
        <div className="no-print fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div role="dialog" aria-modal="true" aria-label="Record rent payment" className="bg-white w-full max-w-xl rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className={`text-base font-bold truncate ${INK}`}>Pay Rent · {payingItem.name}</h2>
                <p className="text-xs text-slate-500">Month: {formatMonthLabel(monthKey)} · Creates a verified Daily Ledger expense</p>
              </div>
              <button type="button" onClick={() => setPayingItem(null)} aria-label="Close" className="w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100 grid place-items-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handlePaySubmit} className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
              {payError && <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-700 font-medium">{payError}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Amount Paid (BDT ৳) *</label>
                  <input type="text" inputMode="decimal" required value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono font-bold`} />
                </div>
                <div>
                  <label className={labelCls}>Paid Date *</label>
                  <input type="date" required value={payDate} onChange={(e) => setPayDate(e.target.value)} className={fieldCls} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Department *</label>
                  <select required value={payDepartment} onChange={(e) => setPayDepartment(e.target.value)} className={fieldCls}>
                    <option value="">Select department</option>
                    {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Funding Source *</label>
                  <select required value={payFundSourceId} onChange={(e) => setPayFundSourceId(e.target.value)} className={fieldCls}>
                    <option value="">Select fund source</option>
                    {activeSources.map((s) => <option key={s.id} value={s.id}>{s.name} ({formatBDT(s.balancePaisa)})</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Payment Method *</label>
                  <ComboInput
                    value={payMethod}
                    onChange={setPayMethod}
                    options={[...PAYMENT_METHODS]}
                    required
                    ariaLabel="Payment Method"
                    placeholder="Select or type method"
                    className={fieldCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Reference / Slip #</label>
                  <input type="text" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="Optional reference" className={`${fieldCls} font-mono`} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Notes (Optional)</label>
                <input type="text" value={payNotes} onChange={(e) => setPayNotes(e.target.value)} placeholder="Meter reading, landlord remark..." className={fieldCls} />
              </div>
              <div>
                <label className={labelCls}>Receipt / Voucher Photo (Optional)</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPayCameraOpen(true)}
                    className="h-10 px-3 rounded-xl border border-brand-200 bg-brand-50 hover:bg-brand-100 text-xs font-semibold text-brand-900 inline-flex items-center gap-1.5 shrink-0"
                  >
                    <Camera className="w-4 h-4" /> Camera
                  </button>
                  <label className="flex-1 h-10 px-3 flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-white cursor-pointer text-xs text-slate-600 min-w-0">
                    <Paperclip className="w-4 h-4 text-brand-600 shrink-0" />
                    <span className="truncate">{payReceipt ? payReceipt.name : 'Attach JPG/PNG/PDF'}</span>
                    <input type="file" accept="image/jpeg,image/png,application/pdf" onChange={handlePayFile} className="hidden" />
                  </label>
                </div>
              </div>
              <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-100">
                <button type="button" onClick={() => setPayingItem(null)} className="h-10 px-4 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
                <button type="submit" disabled={payBusy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-60">
                  {payBusy ? 'Saving...' : 'Confirm Payment'}
                </button>
              </div>
            </form>
          </div>
          <CameraCaptureModal isOpen={payCameraOpen} onClose={() => setPayCameraOpen(false)} onCapture={(file) => setPayReceipt(file)} />
        </div>
      )}

      {itemModalOpen && isAdmin && (
        <div className="no-print fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-6 bg-slate-950/60 backdrop-blur-sm">
          <ScrollLock />
          <div role="dialog" aria-modal="true" aria-label={editingItem ? 'Edit rent item' : 'Add rent item'} className="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-slate-100 overflow-hidden max-h-[92vh] flex flex-col">
            <div className="shrink-0 px-6 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
              <h2 className={`text-base font-bold ${INK}`}>{editingItem ? 'Edit Rent Obligation' : 'New Rent Obligation'}</h2>
              <button type="button" onClick={() => setItemModalOpen(false)} aria-label="Close" className="w-9 h-9 rounded-full text-slate-400 hover:bg-slate-100 grid place-items-center">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveItem} className="flex-1 min-h-0 overflow-y-auto p-6 space-y-4">
              {itemError && <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 text-xs text-rose-700 font-medium">{itemError}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-[5.5rem_1fr] gap-3">
                <div>
                  <label className={labelCls}>SL #</label>
                  <input type="number" min={1} value={itemSl} onChange={(e) => setItemSl(e.target.value)} placeholder="Auto" className={fieldCls} />
                </div>
                <div>
                  <label className={labelCls}>Premises / Utility Name *</label>
                  <input type="text" required value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Uttara Main Office Rent" className={fieldCls} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Category *</label>
                  <select value={itemCategory} onChange={(e) => setItemCategory(e.target.value as RentCategory)} className={fieldCls}>
                    <option value="regular">Regular Monthly Rent</option>
                    <option value="urgent">Urgent / Ad-hoc Rent</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Department *</label>
                  <select required value={itemDepartment} onChange={(e) => setItemDepartment(e.target.value)} className={fieldCls}>
                    <option value="">Select department</option>
                    {activeDepartments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Regular Monthly Amount (BDT)</label>
                  <input type="text" inputMode="decimal" value={itemMonthlyAmount} onChange={(e) => setItemMonthlyAmount(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono font-bold`} />
                </div>
                <div>
                  <label className={labelCls}>Urgent Amount (BDT)</label>
                  <input type="text" inputMode="decimal" value={itemUrgentAmount} onChange={(e) => setItemUrgentAmount(e.target.value)} placeholder="0.00" className={`${fieldCls} font-mono font-bold`} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Notes (Optional)</label>
                <input type="text" value={itemNotes} onChange={(e) => setItemNotes(e.target.value)} placeholder="Landlord, meter ID, building floor..." className={fieldCls} />
              </div>
              {editingItem && (
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={itemActive} onChange={(e) => setItemActive(e.target.checked)} className="w-4 h-4 accent-brand-700" />
                  Active obligation
                </label>
              )}
              <div className="pt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100">
                <div>
                  {editingItem && (
                    confirmDeleteItem ? (
                      <div className="inline-flex items-center gap-2">
                        <button type="button" disabled={itemBusy} onClick={() => void handleDeleteItem()} className="h-9 px-3 rounded-xl bg-rose-600 text-white text-xs font-semibold">
                          Confirm Delete
                        </button>
                        <button type="button" onClick={() => setConfirmDeleteItem(false)} className="h-9 px-3 rounded-xl text-xs font-semibold text-slate-500">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setConfirmDeleteItem(true)} className="h-9 px-3 rounded-xl text-xs font-semibold text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1">
                        <Trash2 className="w-3.5 h-3.5" /> Remove Item
                      </button>
                    )
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setItemModalOpen(false)} className="h-10 px-4 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
                  <button type="submit" disabled={itemBusy} className="h-10 px-5 rounded-xl bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold disabled:opacity-60">
                    {itemBusy ? 'Saving...' : editingItem ? 'Save Changes' : 'Add Rent Item'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
