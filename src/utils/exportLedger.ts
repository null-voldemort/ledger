import jsPDF from 'jspdf';
import autoTable, { type CellHookData, type RowInput } from 'jspdf-autotable';
import type { LedgerTransaction } from '../types';
import logoUrl from '../logo/logo-statement.png';
import { loadTransactions, type PeriodSummaryResponse } from './cloud';

/**
 * Bank-style statement PDF (A4 portrait).
 *   Page 1     letterhead, statement details, account summary, income and expense side by side.
 *   Page 2+    every transaction oldest to newest with debit, credit and a running balance,
 *              then the closing balance, a reconciliation line and signature lines.
 *   Every page a running header and a "Page x of y" footer.
 */

type RGB = [number, number, number];
const INK: RGB = [27, 42, 78];
const MUTED: RGB = [107, 122, 144];
const LINE: RGB = [213, 220, 230];
const GREEN: RGB = [47, 143, 58];
const GREEN_D: RGB = [29, 90, 42];
const AMBER_D: RGB = [154, 75, 0];
const RED: RGB = [176, 58, 46];
const BAND: RGB = [238, 242, 248];
const ZEBRA: RGB = [247, 249, 252];
const WHITE: RGB = [255, 255, 255];

const PAGE_W = 210;
const PAGE_H = 297;
const MX = 14; // side margin
const CONTENT_W = PAGE_W - MX * 2;
const FOOTER_Y = PAGE_H - 9;

export interface StatementPdfOptions {
  generatedBy?: string;
  lock?: { lockedByName: string } | null;
  onProgress?: (loaded: number) => void;
}

// The built-in PDF fonts only cover Western characters. Anything else would print as garbage, so show a "?".
const WIN_ANSI_EXTRA = new Set('–—‘’‚“”„•…€™'.split(''));
const clean = (value: unknown): string =>
  String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .split('')
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_ANSI_EXTRA.has(ch) ? ch : '?';
    })
    .join('')
    .replace(/\s{2,}/g, ' ')
    .trim();

const money = (paisa: number): string => {
  const n = Math.round(paisa || 0);
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
};

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

const stamp = (d: Date) =>
  `${d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} (Asia/Dhaka)`;

export const statementReference = (from: string, to: string) => `STM-${from.replace(/-/g, '')}-${to.replace(/-/g, '')}`;

let logoDataUrl: Promise<string | null> | null = null;
function loadLogo(): Promise<string | null> {
  if (!logoDataUrl) {
    logoDataUrl = fetch(logoUrl)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('logo'))))
      .then((blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }))
      .catch(() => null);
  }
  return logoDataUrl;
}

async function loadAllTransactions(from: string, to: string, onProgress?: (n: number) => void): Promise<LedgerTransaction[]> {
  const all: LedgerTransaction[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 2000; guard += 1) {
    const page = await loadTransactions({ from, to, sort: 'oldest', limit: 100, cursor });
    all.push(...page.items);
    onProgress?.(all.length);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return all;
}

const setText = (doc: jsPDF, color: RGB) => doc.setTextColor(color[0], color[1], color[2]);
const setFill = (doc: jsPDF, color: RGB) => doc.setFillColor(color[0], color[1], color[2]);
const setDraw = (doc: jsPDF, color: RGB) => doc.setDrawColor(color[0], color[1], color[2]);

function band(doc: jsPDF, x: number, y: number, w: number, title: string) {
  setFill(doc, INK);
  doc.rect(x, y, w, 6.4, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  setText(doc, WHITE);
  doc.text(title, x + 3, y + 4.35);
}

function letterhead(doc: jsPDF, logo: string | null, label: string) {
  if (logo) doc.addImage(logo, 'PNG', MX, 11, 13.5, 14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  setText(doc, INK);
  doc.text('PACE IT', MX + 16.5, 21.5);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11.5);
  setText(doc, INK);
  doc.text('INCOME & EXPENSE STATEMENT', PAGE_W - MX, 17.5, { align: 'right' });
  doc.setFontSize(9.5);
  setText(doc, GREEN_D);
  doc.text(clean(label), PAGE_W - MX, 23.5, { align: 'right' });

  setFill(doc, GREEN);
  doc.rect(MX, 28, CONTENT_W, 0.9, 'F');
}

function runningHeader(doc: jsPDF, logo: string | null, label: string) {
  if (logo) doc.addImage(logo, 'PNG', MX, 8.5, 7, 7.3);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  setText(doc, INK);
  doc.text('PACE IT', MX + 9, 13.6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setText(doc, MUTED);
  doc.text(`Income & Expense Statement  |  ${clean(label)}`, PAGE_W - MX, 13.4, { align: 'right' });
  setFill(doc, GREEN);
  doc.rect(MX, 17.2, CONTENT_W, 0.5, 'F');
}

function detailsBlock(doc: jsPDF, y: number, rows: [string, string, string, string][]): number {
  const colW = (CONTENT_W - 6) / 2;
  let cursor = y;
  for (const [l1, v1, l2, v2] of rows) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.3);
    setText(doc, MUTED);
    doc.text(l1, MX, cursor);
    doc.text(l2, MX + colW + 6, cursor);
    doc.setFontSize(9);
    setText(doc, INK);
    doc.text(clean(v1), MX, cursor + 4.6, { maxWidth: colW });
    doc.text(clean(v2), MX + colW + 6, cursor + 4.6, { maxWidth: colW });
    setDraw(doc, LINE);
    doc.setLineWidth(0.2);
    doc.line(MX, cursor + 6.4, MX + colW, cursor + 6.4);
    doc.line(MX + colW + 6, cursor + 6.4, MX + CONTENT_W, cursor + 6.4);
    cursor += 10.4;
  }
  return cursor;
}

type Cell = { content: string; styles?: Record<string, unknown> };

export async function exportStatementPdf(summary: PeriodSummaryResponse, options: StatementPdfOptions = {}): Promise<void> {
  const [logo, txs] = await Promise.all([loadLogo(), loadAllTransactions(summary.from, summary.to, options.onProgress)]);
  const generatedAt = new Date();
  const ref = statementReference(summary.from, summary.to);
  const period = summary.from === summary.to ? longDate(summary.from) : `${longDate(summary.from)} - ${longDate(summary.to)}`;
  const status = options.lock ? `Signed off and locked by ${options.lock.lockedByName}` : 'Open - period not yet signed off';

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  doc.setProperties({
    title: `Income & Expense Statement - ${clean(summary.label)}`,
    subject: `${ref} (${summary.from} to ${summary.to})`,
    author: 'Pace IT Ledger',
    creator: 'Pace IT Ledger',
  });

  // ---------------------------------------------------------------- page 1
  letterhead(doc, logo, summary.label);
  let y = detailsBlock(doc, 36, [
    ['STATEMENT PERIOD', period, 'GENERATED ON', stamp(generatedAt)],
    ['CURRENCY', 'BDT - Bangladeshi Taka', 'GENERATED BY', options.generatedBy || 'Pace IT Ledger'],
    ['STATEMENT REFERENCE', ref, 'STATUS', status],
  ]) + 3;

  const half = (CONTENT_W - 6) / 2;
  const xr = MX + half + 6;
  const sideTable = (x: number, startY: number, head: RowInput[], body: RowInput[], foot: RowInput[] | undefined, columnStyles: Record<number, object>) => {
    autoTable(doc, {
      startY,
      margin: { left: x, right: PAGE_W - x - half },
      tableWidth: half,
      head,
      body,
      foot,
      theme: 'plain',
      showFoot: 'lastPage',
      styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 1.9, bottom: 1.9, left: 2.5, right: 2.5 }, textColor: INK, lineColor: LINE, lineWidth: 0, overflow: 'ellipsize' },
      headStyles: { fillColor: BAND, textColor: MUTED, fontStyle: 'bold', fontSize: 6.6, lineWidth: 0 },
      footStyles: { fillColor: BAND, textColor: INK, fontStyle: 'bold', fontSize: 8.2 },
      columnStyles,
      didDrawCell: (d: CellHookData) => {
        // thin rule under every body row, a heavier one above the totals
        if (d.section === 'body' || d.section === 'head') {
          setDraw(doc, d.section === 'head' ? INK : LINE);
          doc.setLineWidth(d.section === 'head' ? 0.3 : 0.15);
          doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
        }
        if (d.section === 'foot') {
          setDraw(doc, INK);
          doc.setLineWidth(0.5);
          doc.line(d.cell.x, d.cell.y, d.cell.x + d.cell.width, d.cell.y);
          doc.setLineWidth(0.25);
          doc.line(d.cell.x, d.cell.y + d.cell.height - 0.5, d.cell.x + d.cell.width, d.cell.y + d.cell.height - 0.5);
          doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
        }
      },
    });
  };
  const endY = () => (doc as any).lastAutoTable.finalY as number;

  // Account summary
  band(doc, MX, y, CONTENT_W, 'ACCOUNT SUMMARY');
  y += 6.4;
  const net = summary.periodIncomePaisa - summary.periodExpensePaisa;
  const L = (text: string, bold = false): Cell => ({ content: text, styles: bold ? { fontStyle: 'bold' } : {} });
  const R = (text: string, color?: RGB, bold = true): Cell => ({ content: text, styles: { halign: 'right', fontStyle: bold ? 'bold' : 'normal', ...(color ? { textColor: color } : {}) } });
  const sumCols = { 0: { cellWidth: half - 30 }, 1: { cellWidth: 30, halign: 'right' } };
  sideTable(MX, y, [], [
    [L('Opening Balance (Brought Forward)'), R(money(summary.openingBalancePaisa))],
    [L('Total Credits (Income)'), R(money(summary.periodIncomePaisa), GREEN_D)],
    [L('Total Debits (Expense)'), R(money(summary.periodExpensePaisa), AMBER_D)],
    [
      { content: 'Closing Balance (Carried Forward)', styles: { fontStyle: 'bold', fillColor: BAND, fontSize: 8.6 } },
      { content: money(summary.closingBalancePaisa), styles: { fontStyle: 'bold', halign: 'right', fillColor: BAND, fontSize: 8.6 } },
    ],
  ], undefined, sumCols);
  const sumEnd = endY();
  sideTable(xr, y, [], [
    [L('Income Entries'), R(String(summary.incomeCount))],
    [L('Expense Entries'), R(String(summary.expenseCount))],
    [L('Total Entries'), R(String(summary.incomeCount + summary.expenseCount))],
    [L('Net Movement (Credits - Debits)'), R(money(net), net < 0 ? RED : INK)],
  ], undefined, sumCols);
  y = Math.max(sumEnd, endY()) + 7;

  // Income | Expense, padded to the same number of rows so the totals line up
  const income = summary.incomeByHead;
  const expense = summary.expenseByHead;
  const bodyRows = Math.max(income.length + 1, expense.length + 1);
  const estimated = 6.4 + 6.5 + bodyRows * 6.4 + 8 + 12;
  if (y + estimated > PAGE_H - 24) { doc.addPage(); runningHeader(doc, logo, summary.label); y = 24; }

  band(doc, MX, y, half, 'INCOME - CREDITS');
  band(doc, xr, y, half, 'EXPENSE - DEBITS');
  y += 6.4;
  const incomeBody: RowInput[] = [];
  const expenseBody: RowInput[] = [];
  const carry = (label: string, paisa: number): RowInput => [
    { content: label, styles: { fontStyle: 'bold', fillColor: ZEBRA } },
    { content: 'Carry-fwd', styles: { halign: 'center', fontStyle: 'italic', textColor: MUTED, fillColor: ZEBRA, fontSize: 7 } },
    { content: money(paisa), styles: { halign: 'right', fontStyle: 'bold', fillColor: ZEBRA } },
  ];
  const blank = (): RowInput => ['', '', ''];
  for (let i = 0; i < bodyRows; i += 1) {
    if (i === 0) incomeBody.push(carry('Previous Period (Opening)', summary.openingBalancePaisa));
    else if (i - 1 < income.length) {
      const r = income[i - 1];
      incomeBody.push([r.head, { content: String(r.count), styles: { halign: 'center', textColor: MUTED } }, { content: money(r.totalPaisa), styles: { halign: 'right', fontStyle: 'bold', textColor: r.totalPaisa ? GREEN_D : MUTED } }]);
    } else incomeBody.push(blank());

    if (i === bodyRows - 1) expenseBody.push(carry('Closing Balance', summary.closingBalancePaisa));
    else if (i < expense.length) {
      const r = expense[i];
      expenseBody.push([r.head, { content: String(r.count), styles: { halign: 'center', textColor: MUTED } }, { content: money(r.totalPaisa), styles: { halign: 'right', fontStyle: 'bold', textColor: r.totalPaisa ? INK : MUTED } }]);
    } else expenseBody.push(blank());
  }
  const incomeTotal = summary.openingBalancePaisa + income.reduce((a, r) => a + r.totalPaisa, 0);
  const expenseTotal = expense.reduce((a, r) => a + r.totalPaisa, 0) + summary.closingBalancePaisa;
  const chanCols = { 0: { cellWidth: half - 44 }, 1: { cellWidth: 17, halign: 'center' }, 2: { cellWidth: 27, halign: 'right' } };
  const head = (a: string): RowInput[] => [[a, { content: 'ENTRIES', styles: { halign: 'center' } }, { content: 'AMOUNT (BDT)', styles: { halign: 'right' } }]];
  const foot = (label: string, count: number, paisa: number): RowInput[] => [[label, { content: String(count), styles: { halign: 'center' } }, { content: money(paisa), styles: { halign: 'right' } }]];
  sideTable(MX, y, head('CHANNEL / DETAILS'), incomeBody, foot('TOTAL AVAILABLE INCOME', income.reduce((a, r) => a + r.count, 0), incomeTotal), chanCols);
  const incEnd = endY();
  sideTable(xr, y, head('OFFICE / DETAILS'), expenseBody, foot('EXPENSE + CLOSING', expense.reduce((a, r) => a + r.count, 0), expenseTotal), chanCols);
  y = Math.max(incEnd, endY()) + 4.5;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.6);
  const balanced = incomeTotal === expenseTotal;
  setText(doc, balanced ? GREEN_D : RED);
  doc.text(
    balanced ? 'Balanced: total available income equals total expense plus closing balance.' : 'Out of balance: the two totals above differ. Review the transaction details.',
    MX, y,
  );

  // ---------------------------------------------------------------- transactions
  doc.addPage();
  runningHeader(doc, logo, summary.label);
  band(doc, MX, 22, CONTENT_W, `TRANSACTION DETAILS  (${txs.length} ${txs.length === 1 ? 'entry' : 'entries'}, oldest first)`);

  let balance = summary.openingBalancePaisa;
  let credit = 0;
  let debit = 0;
  type Rich = { lines: { text: string; bold?: boolean; color?: RGB; single?: boolean; tail?: string }[] };
  const body: RowInput[] = [];
  body.push([
    { content: 'Opening balance brought forward', colSpan: 3, styles: { fontStyle: 'bold', fillColor: BAND } },
    { content: '', styles: { fillColor: BAND } },
    { content: '', styles: { fillColor: BAND } },
    { content: money(balance), styles: { halign: 'right', fontStyle: 'bold', fillColor: BAND, textColor: balance < 0 ? RED : INK } },
  ]);
  txs.forEach((tx, i) => {
    const income = tx.kind === 'income';
    if (income) { balance += tx.amountPaisa; credit += tx.amountPaisa; } else { balance -= tx.amountPaisa; debit += tx.amountPaisa; }
    const zebra = i % 2 === 1 ? { fillColor: ZEBRA } : {};
    body.push([
      { content: '', styles: { ...zebra }, _rich: { lines: [{ text: longDate(tx.txDate), bold: true }, { text: tx.voucherNo, color: MUTED }] } } as any,
      { content: '', styles: { ...zebra }, _rich: { lines: [{ text: clean(tx.counterparty) || '-', bold: true }, ...(tx.purpose ? [{ text: clean(tx.purpose), color: MUTED }] : [])] } } as any,
      { content: '', styles: { ...zebra }, _rich: { lines: [{ text: clean(tx.head), bold: true }, { text: clean(tx.paymentMethod || ''), tail: tx.referenceNo ? clean(tx.referenceNo) : '', color: MUTED, single: true }] } } as any,
      { content: income ? '' : money(tx.amountPaisa), styles: { halign: 'right', textColor: RED, ...zebra } },
      { content: income ? money(tx.amountPaisa) : '', styles: { halign: 'right', textColor: GREEN_D, ...zebra } },
      { content: money(balance), styles: { halign: 'right', fontStyle: 'bold', textColor: balance < 0 ? RED : INK, ...zebra } },
    ]);
  });
  // Layout: Date/Voucher | Particulars | Channel/Method | Debit | Credit | Balance (the opening row spans the first three)
  const widths = [24, 48, 50, 20, 20, 20];
  const txStartPage = doc.getNumberOfPages();

  autoTable(doc, {
    startY: 30.5,
    margin: { left: MX, right: MX, top: 22, bottom: 16 },
    tableWidth: CONTENT_W,
    head: [[
      'DATE / VOUCHER',
      'PARTICULARS',
      'CHANNEL / METHOD',
      { content: 'DEBIT', styles: { halign: 'right' } },
      { content: 'CREDIT', styles: { halign: 'right' } },
      { content: 'BALANCE', styles: { halign: 'right' } },
    ]],
    body,
    theme: 'plain',
    showHead: 'everyPage',
    styles: { font: 'helvetica', fontSize: 7.4, cellPadding: { top: 1.7, bottom: 1.7, left: 2, right: 2 }, textColor: INK, valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: INK, textColor: WHITE, fontStyle: 'bold', fontSize: 6.8, valign: 'middle', cellPadding: { top: 2.4, bottom: 2.4, left: 2, right: 2 } },
    columnStyles: Object.fromEntries(widths.map((w, i) => [i, { cellWidth: w }])),
    didParseCell: (d: CellHookData) => {
      const rich = (d.cell.raw as any)?._rich as Rich | undefined;
      if (d.section !== 'body' || !rich) return;
      doc.setFontSize(7.4);
      const width = (widths[d.column.index] ?? 30) - 4;
      const wrapped: { text: string; bold?: boolean; color?: RGB }[] = [];
      const fit = (text: string, w: number) => {
        if (doc.getTextWidth(text) <= w) return text;
        let t = text;
        while (t.length > 1 && doc.getTextWidth(`${t}...`) > w) t = t.slice(0, -1);
        return `${t.trimEnd()}...`;
      };
      for (const line of rich.lines) {
        doc.setFont('helvetica', line.bold ? 'bold' : 'normal');
        if (line.tail) {
          // The reference number is what people search for, so it is never shortened; the method gives way instead.
          const tail = ` / ${line.tail}`;
          wrapped.push({ text: `${fit(line.text, Math.max(8, width - doc.getTextWidth(tail)))}${tail}`, bold: line.bold, color: line.color });
          continue;
        }
        const maxLines = line.bold || line.single ? 1 : 2;
        const parts = doc.splitTextToSize(line.text, width) as string[];
        const kept = parts.slice(0, maxLines);
        if (parts.length > maxLines) kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${parts.slice(maxLines).join(' ')}`, width);
        else if (kept.length === 1) kept[0] = fit(kept[0], width);
        kept.forEach((text) => wrapped.push({ text, bold: line.bold, color: line.color }));
      }
      (d.cell as any)._lines = wrapped;
      d.cell.text = [''];
      d.cell.styles.minCellHeight = wrapped.length * 3.3 + 4.2;
    },
    didDrawCell: (d: CellHookData) => {
      const lines = (d.cell as any)._lines as { text: string; bold?: boolean; color?: RGB }[] | undefined;
      if (d.section === 'body') {
        setDraw(doc, LINE);
        doc.setLineWidth(0.12);
        doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
      }
      if (!lines) return;
      doc.setFontSize(7.4);
      const top = d.cell.y + (d.cell.height - lines.length * 3.3) / 2 + 2.45;
      lines.forEach((ln, k) => {
        doc.setFont('helvetica', ln.bold ? 'bold' : 'normal');
        setText(doc, ln.color ?? INK);
        doc.text(ln.text, d.cell.x + 2, top + k * 3.3);
      });
    },
    didDrawPage: (d) => {
      if (d.pageNumber !== txStartPage) runningHeader(doc, logo, summary.label);
    },
  });

  // Totals, closing balance, reconciliation
  y = endY() + 0;
  if (y > PAGE_H - 58) { doc.addPage(); runningHeader(doc, logo, summary.label); y = 24; }
  autoTable(doc, {
    startY: y,
    margin: { left: MX, right: MX },
    tableWidth: CONTENT_W,
    theme: 'plain',
    body: [
      [
        { content: 'TOTAL FOR THE PERIOD', colSpan: 3, styles: { halign: 'right' } },
        { content: money(debit), styles: { halign: 'right', textColor: RED } },
        { content: money(credit), styles: { halign: 'right', textColor: GREEN_D } },
        '',
      ],
      [
        { content: 'CLOSING BALANCE CARRIED FORWARD', colSpan: 5, styles: { halign: 'right', fontSize: 8.4 } },
        { content: money(balance), styles: { halign: 'right', fontSize: 8.4, textColor: balance < 0 ? RED : INK } },
      ],
    ],
    styles: { font: 'helvetica', fontSize: 7.8, fontStyle: 'bold', fillColor: BAND, textColor: INK, cellPadding: { top: 2.3, bottom: 2.3, left: 2, right: 2 } },
    columnStyles: Object.fromEntries(widths.map((w, i) => [i, { cellWidth: w }])),
    didDrawCell: (d: CellHookData) => {
      setDraw(doc, INK);
      if (d.row.index === 0) { doc.setLineWidth(0.5); doc.line(d.cell.x, d.cell.y, d.cell.x + d.cell.width, d.cell.y); }
      if (d.row.index === 1) {
        doc.setLineWidth(0.25);
        doc.line(d.cell.x, d.cell.y + d.cell.height - 0.5, d.cell.x + d.cell.width, d.cell.y + d.cell.height - 0.5);
        doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
      }
    },
  });
  y = endY() + 5;

  const reconciled = balance === summary.closingBalancePaisa;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.6);
  setText(doc, reconciled ? GREEN_D : RED);
  doc.text(
    reconciled
      ? 'Reconciled: the running balance agrees with the closing balance on the account summary.'
      : `Difference: the running balance does not match the account summary closing balance (${money(summary.closingBalancePaisa)}).`,
    MX, y,
  );
  y += 16;
  if (y > PAGE_H - 24) { doc.addPage(); runningHeader(doc, logo, summary.label); y = 40; }
  setDraw(doc, INK);
  doc.setLineWidth(0.25);
  doc.line(MX, y, MX + 70, y);
  doc.line(PAGE_W - MX - 70, y, PAGE_W - MX, y);
  doc.setFontSize(7.4);
  doc.text('Prepared by', MX, y + 4);
  doc.text('Verified and approved by', PAGE_W - MX - 70, y + 4);

  // ---------------------------------------------------------------- footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    setDraw(doc, LINE);
    doc.setLineWidth(0.2);
    doc.line(MX, FOOTER_Y - 3.8, PAGE_W - MX, FOOTER_Y - 3.8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setText(doc, MUTED);
    doc.text('Pace IT Ledger  |  Confidential', MX, FOOTER_Y);
    doc.text(ref, PAGE_W / 2, FOOTER_Y, { align: 'center' });
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MX, FOOTER_Y, { align: 'right' });
  }

  doc.save(`Pace-IT-Statement-${summary.from}-to-${summary.to}.pdf`);
}
