import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerTransaction } from '../src/types';
import type { PeriodSummaryResponse } from './db';
import { StyleBook, type FontSpec, type XlsxCell, type XlsxRow, type XlsxSheet, type XlsxWorkbookOptions } from './xlsxStream';

/**
 * The statement workbook: a printable "Statement Summary" cover sheet (account summary, income and
 * expense side by side) and an "Itemized Ledger" sheet laid out like a bank statement, with debit and
 * credit columns and a running balance. Totals, balances and the reconciliation line are live formulas,
 * and each carries its computed value so previews and phones show the same figures.
 */

export interface StatementMeta {
  generatedBy: string;
  generatedAt: Date;
  lock?: { lockedByName: string; lockedAt: string };
}

const INK = '1B2A4E';
const MUTED = '6B7A90';
const LINE = 'D5DCE6';
const GREEN = '2F8F3A';
const GREEN_D = '1D5A2A';
const AMBER_D = '9A4B00';
const BAND = 'EEF2F8';
const ZEBRA = 'F7F9FC';
const RED = 'B03A2E';

const MONEY = '#,##0.00;[Red]-#,##0.00;"-"';
const MONEY_BLANK0 = '#,##0.00;[Red]-#,##0.00';
const INT = '#,##0';
const DATE = 'dd mmm yyyy';

const styles = new StyleBook();
const font = (o: FontSpec = {}): FontSpec => ({ name: 'Calibri', sz: 10, color: INK, ...o });
const edge = (style: 'thin' | 'medium' | 'thick' | 'double' | 'hair', color: string) => ({ style, color });
const under = { bottom: edge('thin', LINE) };

const S = {
  // header block
  brand: styles.xf({ font: font({ sz: 22, bold: true }), v: 'center' }),
  tagline: styles.xf({ font: font({ sz: 9, italic: true, color: MUTED }), v: 'top' }),
  docTitle: styles.xf({ font: font({ sz: 13, bold: true }), h: 'right', v: 'center' }),
  docPeriod: styles.xf({ font: font({ sz: 11, bold: true, color: GREEN_D }), h: 'right', v: 'top' }),
  rule: styles.xf({ border: { bottom: edge('thick', GREEN) } }),
  lbl: styles.xf({ font: font({ sz: 8, bold: true, color: MUTED }), v: 'bottom' }),
  val: styles.xf({ font: font({ sz: 10.5, bold: true }), border: under, v: 'center' }),
  valBlank: styles.xf({ border: under }),
  // bands and table furniture
  band: styles.xf({ font: font({ sz: 10, bold: true, color: 'FFFFFF' }), fill: INK, h: 'left', indent: 1 }),
  bandBlank: styles.xf({ fill: INK }),
  colHead: styles.xf({ font: font({ sz: 8.5, bold: true, color: MUTED }), fill: BAND, border: { bottom: edge('thin', INK) }, h: 'left', indent: 1 }),
  colHeadC: styles.xf({ font: font({ sz: 8.5, bold: true, color: MUTED }), fill: BAND, border: { bottom: edge('thin', INK) }, h: 'center' }),
  colHeadR: styles.xf({ font: font({ sz: 8.5, bold: true, color: MUTED }), fill: BAND, border: { bottom: edge('thin', INK) }, h: 'right', indent: 1 }),
  // account summary
  sumLbl: styles.xf({ font: font(), border: under, h: 'left', indent: 1 }),
  sumMoney: styles.xf({ font: font({ bold: true }), border: under, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  sumMoneyGreen: styles.xf({ font: font({ bold: true, color: GREEN_D }), border: under, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  sumMoneyAmber: styles.xf({ font: font({ bold: true, color: AMBER_D }), border: under, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  sumInt: styles.xf({ font: font({ bold: true }), border: under, numFmt: INT, h: 'right', indent: 1 }),
  sumTotLbl: styles.xf({ font: font({ sz: 10.5, bold: true }), fill: BAND, border: { top: edge('thin', INK), bottom: edge('double', INK) }, h: 'left', indent: 1 }),
  sumTotMoney: styles.xf({ font: font({ sz: 10.5, bold: true }), fill: BAND, border: { top: edge('thin', INK), bottom: edge('double', INK) }, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  // channel tables
  cText: styles.xf({ font: font(), border: under, h: 'left', indent: 1 }),
  cTextMuted: styles.xf({ font: font({ color: 'AAB4C3' }), border: under, h: 'left', indent: 1 }),
  cCarryLbl: styles.xf({ font: font({ bold: true }), fill: ZEBRA, border: under, h: 'left', indent: 1 }),
  cCarryTag: styles.xf({ font: font({ sz: 9, italic: true, color: MUTED }), fill: ZEBRA, border: under, h: 'center' }),
  cCarryMoney: styles.xf({ font: font({ bold: true }), fill: ZEBRA, border: under, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  cInt: styles.xf({ font: font({ color: MUTED }), border: under, numFmt: INT, h: 'center' }),
  cMoneyIn: styles.xf({ font: font({ bold: true, color: GREEN_D }), border: under, numFmt: MONEY, h: 'right', indent: 1 }),
  cMoneyOut: styles.xf({ font: font({ bold: true }), border: under, numFmt: MONEY, h: 'right', indent: 1 }),
  cBlank: styles.xf({ border: under }),
  totLbl: styles.xf({ font: font({ sz: 10.5, bold: true }), fill: BAND, border: { top: edge('medium', INK), bottom: edge('double', INK) }, h: 'left', indent: 1 }),
  totInt: styles.xf({ font: font({ bold: true }), fill: BAND, border: { top: edge('medium', INK), bottom: edge('double', INK) }, numFmt: INT, h: 'center' }),
  totMoney: styles.xf({ font: font({ sz: 10.5, bold: true }), fill: BAND, border: { top: edge('medium', INK), bottom: edge('double', INK) }, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  check: styles.xf({ font: font({ sz: 9, italic: true, color: GREEN_D }), h: 'left', indent: 1 }),
  note: styles.xf({ font: font({ sz: 8.5, color: MUTED }), h: 'left', v: 'top', wrap: true }),
  noteHead: styles.xf({ font: font({ sz: 8, bold: true, color: MUTED }), v: 'bottom' }),
  sig: styles.xf({ font: font({ sz: 9, color: MUTED }), border: { top: edge('thin', INK) }, h: 'left', v: 'top' }),
  // itemized ledger
  lTitle: styles.xf({ font: font({ sz: 15, bold: true }), v: 'center' }),
  lPeriod: styles.xf({ font: font({ sz: 11, bold: true, color: GREEN_D }), h: 'right', v: 'center' }),
  lSub: styles.xf({ font: font({ sz: 9, color: MUTED }), v: 'center' }),
  lOpenLbl: styles.xf({ font: font({ bold: true }), fill: BAND, border: { top: edge('thin', LINE), bottom: edge('thin', INK) }, h: 'right', indent: 1 }),
  lOpenBlank: styles.xf({ fill: BAND, border: { top: edge('thin', LINE), bottom: edge('thin', INK) } }),
  lOpenMoney: styles.xf({ font: font({ bold: true }), fill: BAND, border: { top: edge('thin', LINE), bottom: edge('thin', INK) }, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  lHead: styles.xf({ font: font({ sz: 9.5, bold: true, color: 'FFFFFF' }), fill: INK, border: { right: edge('thin', '3A4A70') }, h: 'left', wrap: true, indent: 1 }),
  lHeadR: styles.xf({ font: font({ sz: 9.5, bold: true, color: 'FFFFFF' }), fill: INK, border: { right: edge('thin', '3A4A70') }, h: 'right', wrap: true, indent: 1 }),
  lHeadC: styles.xf({ font: font({ sz: 9.5, bold: true, color: 'FFFFFF' }), fill: INK, border: { right: edge('thin', '3A4A70') }, h: 'center', wrap: true }),
  lTotLbl: styles.xf({ font: font({ bold: true }), fill: BAND, border: { top: edge('medium', INK) }, h: 'right', indent: 1 }),
  lTotBlank: styles.xf({ fill: BAND, border: { top: edge('medium', INK) } }),
  lTotMoney: styles.xf({ font: font({ bold: true }), fill: BAND, border: { top: edge('medium', INK) }, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
  lCloseLbl: styles.xf({ font: font({ sz: 10.5, bold: true }), fill: BAND, border: { bottom: edge('double', INK) }, h: 'right', indent: 1 }),
  lCloseBlank: styles.xf({ fill: BAND, border: { bottom: edge('double', INK) } }),
  lCloseMoney: styles.xf({ font: font({ sz: 10.5, bold: true }), fill: BAND, border: { bottom: edge('double', INK) }, numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
};

function ledgerRowStyles(zebra: boolean) {
  const fill = zebra ? ZEBRA : undefined;
  const border = { bottom: edge('hair', 'C7CFDB') };
  const base = { fill, border };
  return {
    text: styles.xf({ ...base, font: font({ sz: 9.5 }), h: 'left', wrap: true, indent: 1 }),
    textNoWrap: styles.xf({ ...base, font: font({ sz: 9.5 }), h: 'left', indent: 1 }),
    mono: styles.xf({ ...base, font: font({ sz: 9.5, name: 'Consolas' }), h: 'left', indent: 1 }),
    date: styles.xf({ ...base, font: font({ sz: 9.5 }), numFmt: DATE, h: 'left', indent: 1 }),
    debit: styles.xf({ ...base, font: font({ sz: 9.5, color: RED }), numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
    credit: styles.xf({ ...base, font: font({ sz: 9.5, color: GREEN_D }), numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
    balance: styles.xf({ ...base, font: font({ sz: 9.5, bold: true }), numFmt: MONEY_BLANK0, h: 'right', indent: 1 }),
    int: styles.xf({ ...base, font: font({ sz: 9.5, color: MUTED }), numFmt: INT, h: 'center' }),
    center: styles.xf({ ...base, font: font({ sz: 9.5 }), h: 'center' }),
    ok: styles.xf({ ...base, font: font({ sz: 9.5, bold: true, color: GREEN_D }), h: 'center' }),
    warn: styles.xf({ ...base, font: font({ sz: 9.5, bold: true, color: RED }), h: 'center' }),
    pending: styles.xf({ ...base, font: font({ sz: 9.5, bold: true, color: AMBER_D }), h: 'center' }),
    blank: styles.xf({ ...base }),
  };
}
const ZEBRA_OFF = ledgerRowStyles(false);
const ZEBRA_ON = ledgerRowStyles(true);

// ---------------------------------------------------------------------------------------------

const num = (paisa: number): number => Math.round(paisa) / 100;

function excelSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

const stamp = (d: Date) =>
  `${d.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} (Asia/Dhaka)`;

const compact = (iso: string) => iso.replace(/-/g, '');
export const statementReference = (from: string, to: string) => `STM-${compact(from)}-${compact(to)}`;

let logoCache: Buffer | null | undefined;
function logo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    logoCache = fs.readFileSync(path.resolve(here, '../src/logo/logo-statement.png'));
  } catch {
    logoCache = null;
  }
  return logoCache;
}

const cols = (n: number): string => String.fromCharCode(64 + n);

// ---------------------------------------------------------------------------------------------
// Sheet 1: Statement Summary
// ---------------------------------------------------------------------------------------------

function summaryRows(summary: PeriodSummaryResponse, meta: StatementMeta): { rows: XlsxRow[]; merges: string[]; lastRow: number } {
  const rows: XlsxRow[] = [];
  const merges: string[] = [];
  // Columns: A margin/logo | B label | C entries | D amount | E gap | F label | G entries | H amount | I margin
  const W = 9;
  const blank = (style = 0): XlsxCell[] => Array.from({ length: W }, () => ({ value: null, style }));
  const push = (cells: XlsxCell[], height?: number) => rows.push(height ? { cells, height } : cells);
  const put = (cells: XlsxCell[], at: Record<number, XlsxCell>) => { for (const [k, v] of Object.entries(at)) cells[Number(k)] = v; return cells; };
  const at = () => rows.length + 1; // the 1-based number of the row about to be pushed

  const ref = statementReference(summary.from, summary.to);
  const period = summary.from === summary.to ? longDate(summary.from) : `${longDate(summary.from)} – ${longDate(summary.to)}`;
  const status = meta.lock ? `Signed off and locked by ${meta.lock.lockedByName}` : 'Open – period not yet signed off';

  push(blank(), 8); // 1
  // 2: brand line
  merges.push(`B${at()}:D${at()}`, `F${at()}:H${at()}`);
  push(put(blank(), { 1: { value: 'PACE IT', style: S.brand }, 5: { value: 'INCOME & EXPENSE STATEMENT', style: S.docTitle } }), 34);
  // 3: period label
  merges.push(`F${at()}:H${at()}`);
  push(put(blank(), { 5: { value: summary.label, style: S.docPeriod } }), 18);
  // 4: green rule
  push(put(blank(), { 1: { value: null, style: S.rule }, 2: { value: null, style: S.rule }, 3: { value: null, style: S.rule }, 4: { value: null, style: S.rule }, 5: { value: null, style: S.rule }, 6: { value: null, style: S.rule }, 7: { value: null, style: S.rule } }), 5);
  push(blank(), 10); // 5

  // 6-11: statement details, two blocks
  const details: [string, string, string, string][] = [
    ['STATEMENT PERIOD', period, 'GENERATED ON', stamp(meta.generatedAt)],
    ['CURRENCY', 'BDT – Bangladeshi Taka', 'GENERATED BY', meta.generatedBy || 'Pace IT Ledger'],
    ['STATEMENT REFERENCE', ref, 'STATUS', status],
  ];
  for (const [l1, v1, l2, v2] of details) {
    merges.push(`B${at()}:D${at()}`, `F${at()}:H${at()}`);
    push(put(blank(), { 1: { value: l1, style: S.lbl }, 5: { value: l2, style: S.lbl } }), 16);
    merges.push(`B${at()}:D${at()}`, `F${at()}:H${at()}`);
    push(put(blank(), {
      1: { value: v1, style: S.val }, 2: { value: null, style: S.valBlank }, 3: { value: null, style: S.valBlank },
      5: { value: v2, style: S.val }, 6: { value: null, style: S.valBlank }, 7: { value: null, style: S.valBlank },
    }), 20);
  }
  push(blank(), 12);

  // Account summary
  merges.push(`B${at()}:H${at()}`);
  push(put(blank(), { 1: { value: 'ACCOUNT SUMMARY', style: S.band }, 2: { value: null, style: S.bandBlank }, 3: { value: null, style: S.bandBlank }, 4: { value: null, style: S.bandBlank }, 5: { value: null, style: S.bandBlank }, 6: { value: null, style: S.bandBlank }, 7: { value: null, style: S.bandBlank } }), 21);

  const s0 = at(); // first summary row
  const incomeEntries = summary.incomeCount;
  const expenseEntries = summary.expenseCount;
  const lines: { l: string; v: number; st: number; r: string; rv: number; rst: number; rf?: string; vf?: string; total?: boolean }[] = [
    { l: 'Opening Balance (Brought Forward)', v: num(summary.openingBalancePaisa), st: S.sumMoney, r: 'Income Entries', rv: incomeEntries, rst: S.sumInt },
    { l: 'Total Credits (Income)', v: num(summary.periodIncomePaisa), st: S.sumMoneyGreen, r: 'Expense Entries', rv: expenseEntries, rst: S.sumInt },
    { l: 'Total Debits (Expense)', v: num(summary.periodExpensePaisa), st: S.sumMoneyAmber, r: 'Total Entries', rv: incomeEntries + expenseEntries, rst: S.sumInt, rf: `H${s0}+H${s0 + 1}` },
    { l: 'Closing Balance (Carried Forward)', v: num(summary.closingBalancePaisa), st: S.sumTotMoney, r: 'Net Movement (Credits − Debits)', rv: num(summary.periodIncomePaisa - summary.periodExpensePaisa), rst: S.sumMoney, rf: `D${s0 + 1}-D${s0 + 2}`, vf: `D${s0}+D${s0 + 1}-D${s0 + 2}`, total: true },
  ];
  lines.forEach((ln, i) => {
    merges.push(`B${at()}:C${at()}`, `F${at()}:G${at()}`);
    const lblStyle = ln.total ? S.sumTotLbl : S.sumLbl;
    const rLblStyle = S.sumLbl;
    push(put(blank(), {
      1: { value: ln.l, style: lblStyle },
      2: { value: null, style: lblStyle },
      3: ln.vf ? { value: ln.v, style: ln.st, formula: ln.vf } : { value: ln.v, style: ln.st },
      5: { value: ln.r, style: rLblStyle },
      6: { value: null, style: rLblStyle },
      7: ln.rf ? { value: ln.rv, style: ln.rst, formula: ln.rf } : { value: ln.rv, style: ln.rst },
    }), 21);
    void i;
  });
  push(blank(), 14);

  // Income | Expense bands
  merges.push(`B${at()}:D${at()}`, `F${at()}:H${at()}`);
  push(put(blank(), {
    1: { value: 'INCOME – CREDITS', style: S.band }, 2: { value: null, style: S.bandBlank }, 3: { value: null, style: S.bandBlank },
    5: { value: 'EXPENSE – DEBITS', style: S.band }, 6: { value: null, style: S.bandBlank }, 7: { value: null, style: S.bandBlank },
  }), 21);
  push(put(blank(), {
    1: { value: 'CHANNEL / DETAILS', style: S.colHead }, 2: { value: 'ENTRIES', style: S.colHeadC }, 3: { value: 'AMOUNT (BDT)', style: S.colHeadR },
    5: { value: 'OFFICE / DETAILS', style: S.colHead }, 6: { value: 'ENTRIES', style: S.colHeadC }, 7: { value: 'AMOUNT (BDT)', style: S.colHeadR },
  }), 20);

  const t0 = at(); // first body row
  const income = summary.incomeByHead;
  const expense = summary.expenseByHead;
  const bodyRows = Math.max(income.length + 1, expense.length + 1);
  for (let i = 0; i < bodyRows; i += 1) {
    const cells = blank();
    // Income side: opening balance first, then each channel, then empty rows so both sides are the same height.
    if (i === 0) {
      put(cells, { 1: { value: 'Previous Period (Opening Balance)', style: S.cCarryLbl }, 2: { value: 'Carry-fwd', style: S.cCarryTag }, 3: { value: num(summary.openingBalancePaisa), style: S.cCarryMoney } });
    } else if (i - 1 < income.length) {
      const r = income[i - 1];
      put(cells, { 1: { value: r.head, style: S.cText }, 2: { value: r.count, style: S.cInt }, 3: { value: num(r.totalPaisa), style: S.cMoneyIn } });
    } else {
      put(cells, { 1: { value: null, style: S.cBlank }, 2: { value: null, style: S.cBlank }, 3: { value: null, style: S.cBlank } });
    }
    // Expense side: each office, then empty rows, with the closing balance on the last row.
    if (i === bodyRows - 1) {
      put(cells, { 5: { value: 'Closing Balance (Carried Forward)', style: S.cCarryLbl }, 6: { value: 'Carry-fwd', style: S.cCarryTag }, 7: { value: num(summary.closingBalancePaisa), style: S.cCarryMoney } });
    } else if (i < expense.length) {
      const r = expense[i];
      put(cells, { 5: { value: r.head, style: S.cText }, 6: { value: r.count, style: S.cInt }, 7: { value: num(r.totalPaisa), style: S.cMoneyOut } });
    } else {
      put(cells, { 5: { value: null, style: S.cBlank }, 6: { value: null, style: S.cBlank }, 7: { value: null, style: S.cBlank } });
    }
    push(cells, 20);
  }
  const t1 = at() - 1; // last body row
  const incomeTotalPaisa = summary.openingBalancePaisa + income.reduce((a, r) => a + r.totalPaisa, 0);
  const expenseTotalPaisa = expense.reduce((a, r) => a + r.totalPaisa, 0) + summary.closingBalancePaisa;
  const totalRow = at();
  push(put(blank(), {
    1: { value: 'TOTAL AVAILABLE INCOME', style: S.totLbl },
    2: { value: income.reduce((a, r) => a + r.count, 0), style: S.totInt, formula: `SUM(C${t0}:C${t1})` },
    3: { value: num(incomeTotalPaisa), style: S.totMoney, formula: `SUM(D${t0}:D${t1})` },
    5: { value: 'TOTAL EXPENSE + CLOSING BALANCE', style: S.totLbl },
    6: { value: expense.reduce((a, r) => a + r.count, 0), style: S.totInt, formula: `SUM(G${t0}:G${t1})` },
    7: { value: num(expenseTotalPaisa), style: S.totMoney, formula: `SUM(H${t0}:H${t1})` },
  }), 24);

  merges.push(`B${at()}:H${at()}`);
  const balanced = incomeTotalPaisa === expenseTotalPaisa;
  push(put(blank(), {
    1: {
      value: balanced ? '✔ Balanced: total available income equals total expense plus closing balance.' : '⚠ Out of balance: the two totals above differ. Review the Itemized Ledger.',
      style: S.check,
      formula: `IF(ROUND(D${totalRow}-H${totalRow},2)=0,"✔ Balanced: total available income equals total expense plus closing balance.","⚠ Out of balance: the two totals above differ. Review the Itemized Ledger.")`,
    },
  }), 20);
  push(blank(), 12);

  push(blank(), 30);
  // Signature lines
  merges.push(`B${at()}:C${at()}`, `F${at()}:G${at()}`);
  push(put(blank(), { 1: { value: 'Prepared by', style: S.sig }, 2: { value: null, style: S.sig }, 5: { value: 'Verified and approved by', style: S.sig }, 6: { value: null, style: S.sig } }), 18);
  push(blank(), 8);

  return { rows, merges, lastRow: rows.length };
}

// ---------------------------------------------------------------------------------------------
// Sheet 2: Itemized Ledger (running balance)
// ---------------------------------------------------------------------------------------------

const LEDGER_HEAD: [string, 'l' | 'r' | 'c'][] = [
  ['Date', 'l'], ['Voucher', 'l'], ['Particulars (From / To)', 'l'], ['Purpose / Narration', 'l'], ['Channel / Office', 'l'],
  ['Method', 'l'], ['Reference', 'l'], ['Debit (Expense)', 'r'], ['Credit (Income)', 'r'], ['Balance', 'r'],
  ['Department', 'l'], ['Sub-Category', 'l'], ['Status', 'c'], ['Edits', 'c'], ['Amount Edited?', 'c'], ['Last Edit Reason', 'l'], ['Recorded By', 'l'],
];
const LEDGER_COLS = LEDGER_HEAD.length; // 17 → A..Q
const LEDGER_LAST_COL = cols(LEDGER_COLS);
const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;

const STATUS_TEXT: Record<string, string> = { verified: 'Verified', pending_review: 'Pending review', flagged: 'Flagged' };

async function* ledgerRows(
  summary: PeriodSummaryResponse,
  txs: AsyncIterable<LedgerTransaction>,
  meta: StatementMeta,
  state: { count: number; closingPaisa: number; creditPaisa: number; debitPaisa: number },
): AsyncGenerator<XlsxRow> {
  const blank = (style = 0): XlsxCell[] => Array.from({ length: LEDGER_COLS }, () => ({ value: null, style }));
  const period = summary.from === summary.to ? longDate(summary.from) : `${longDate(summary.from)} – ${longDate(summary.to)}`;
  const ref = statementReference(summary.from, summary.to);

  const r1 = blank();
  r1[0] = { value: 'PACE IT  ·  ITEMIZED STATEMENT', style: S.lTitle };
  r1[5] = { value: summary.label, style: S.lPeriod };
  yield { cells: r1, height: 28 };
  const r2 = blank();
  r2[0] = { value: `Period ${period}   ·   Currency BDT   ·   Ref ${ref}   ·   Generated ${stamp(meta.generatedAt)} by ${meta.generatedBy || 'Pace IT Ledger'}`, style: S.lSub };
  yield { cells: r2, height: 18 };
  const r3 = blank();
  for (let c = 0; c < 10; c += 1) r3[c] = { value: null, style: S.lOpenBlank };
  r3[0] = { value: 'OPENING BALANCE BROUGHT FORWARD', style: S.lOpenLbl };
  r3[9] = { value: num(summary.openingBalancePaisa), style: S.lOpenMoney };
  yield { cells: r3, height: 22 };
  yield { cells: LEDGER_HEAD.map(([t, a]) => ({ value: t, style: a === 'r' ? S.lHeadR : a === 'c' ? S.lHeadC : S.lHead })), height: 30 };

  let balance = summary.openingBalancePaisa;
  let credit = 0;
  let debit = 0;
  let rowNo = FIRST_DATA_ROW - 1;
  for await (const tx of txs) {
    rowNo += 1;
    const z = (rowNo - FIRST_DATA_ROW) % 2 === 1 ? ZEBRA_ON : ZEBRA_OFF;
    const income = tx.kind === 'income';
    if (income) { balance += tx.amountPaisa; credit += tx.amountPaisa; } else { balance -= tx.amountPaisa; debit += tx.amountPaisa; }
    const prev = rowNo === FIRST_DATA_ROW ? 'J3' : `J${rowNo - 1}`;
    const statusStyle = tx.status === 'flagged' ? z.warn : tx.status === 'verified' ? z.ok : z.pending;
    yield [
      { value: excelSerial(tx.txDate), style: z.date },
      { value: tx.voucherNo, style: z.mono },
      { value: tx.counterparty || '', style: z.text },
      { value: tx.purpose || '', style: z.text },
      { value: tx.head, style: z.text },
      { value: tx.paymentMethod || '', style: z.textNoWrap },
      { value: tx.referenceNo || '', style: z.mono },
      income ? { value: null, style: z.blank } : { value: num(tx.amountPaisa), style: z.debit },
      income ? { value: num(tx.amountPaisa), style: z.credit } : { value: null, style: z.blank },
      { value: num(balance), style: z.balance, formula: `${prev}+I${rowNo}-H${rowNo}` },
      { value: tx.department || '', style: z.textNoWrap },
      { value: tx.subCategory || '', style: z.text },
      { value: STATUS_TEXT[tx.status] ?? tx.status, style: statusStyle },
      { value: tx.editCount, style: z.int },
      { value: tx.amountChanged ? 'Yes' : 'No', style: tx.amountChanged ? z.warn : z.center },
      { value: tx.lastEditReason || '', style: z.text },
      { value: tx.createdByName || '', style: z.textNoWrap },
    ];
  }
  state.count = rowNo - FIRST_DATA_ROW + 1;
  state.closingPaisa = balance;
  state.creditPaisa = credit;
  state.debitPaisa = debit;

  const last = rowNo;
  const hasRows = state.count > 0;
  const totals = blank();
  for (let c = 0; c < 10; c += 1) totals[c] = { value: null, style: S.lTotBlank };
  totals[0] = { value: 'TOTAL FOR THE PERIOD', style: S.lTotLbl };
  totals[7] = hasRows ? { value: num(debit), style: S.lTotMoney, formula: `SUM(H${FIRST_DATA_ROW}:H${last})` } : { value: 0, style: S.lTotMoney };
  totals[8] = hasRows ? { value: num(credit), style: S.lTotMoney, formula: `SUM(I${FIRST_DATA_ROW}:I${last})` } : { value: 0, style: S.lTotMoney };
  yield { cells: totals, height: 22 };
  const totalRow = last + 1;

  const close = blank();
  for (let c = 0; c < 10; c += 1) close[c] = { value: null, style: S.lCloseBlank };
  close[0] = { value: 'CLOSING BALANCE CARRIED FORWARD', style: S.lCloseLbl };
  close[9] = { value: num(balance), style: S.lCloseMoney, formula: `J3+I${totalRow}-H${totalRow}` };
  yield { cells: close, height: 24 };
  const closeRow = totalRow + 1;

  const reconciled = balance === summary.closingBalancePaisa;
  const target = num(summary.closingBalancePaisa);
  const text = reconciled
    ? '✔ Reconciled: the running balance agrees with the closing balance on the Statement Summary.'
    : `⚠ Difference: the running balance does not match the Statement Summary closing balance (${target.toFixed(2)}).`;
  const rec = blank();
  rec[0] = {
    value: text,
    style: S.check,
    formula: `IF(ROUND(J${closeRow}-${target},2)=0,"✔ Reconciled: the running balance agrees with the closing balance on the Statement Summary.","⚠ Difference: the running balance does not match the Statement Summary closing balance (${target.toFixed(2)}).")`,
  };
  yield { cells: rec, height: 20 };
}

export function buildStatementWorkbook(
  summary: PeriodSummaryResponse,
  txs: AsyncIterable<LedgerTransaction>,
  meta: StatementMeta,
): { sheets: XlsxSheet[]; options: XlsxWorkbookOptions } {
  const sum = summaryRows(summary, meta);
  const state = { count: 0, closingPaisa: 0, creditPaisa: 0, debitPaisa: 0 };
  const logoPng = logo();
  const ref = statementReference(summary.from, summary.to);

  const summarySheet: XlsxSheet = {
    name: 'Statement Summary',
    rows: (async function* () { for (const r of sum.rows) yield r; })(),
    widths: [7, 33, 10, 18, 2.5, 33, 10, 18, 2.5],
    showGridlines: false,
    tabColor: GREEN,
    merges: sum.merges,
    page: {
      orientation: 'portrait',
      fitToWidth: 1,
      centerHorizontally: true,
      printColumns: ['A', 'I'],
      footerLeft: 'Pace IT Ledger  ·  Confidential',
      footerCenter: `${ref}`,
      footerRight: 'Page &P of &N',
    },
    image: logoPng ? { data: logoPng, widthPx: 36, heightPx: 37, col: 0, row: 1, offsetXPx: 8, offsetYPx: 4 } : undefined,
  };

  const ledgerSheet: XlsxSheet = {
    name: 'Itemized Ledger',
    rows: ledgerRows(summary, txs, meta, state),
    widths: [13, 17, 27, 36, 22, 19, 16, 16, 16, 17, 18, 22, 14, 7, 11, 28, 18],
    showGridlines: false,
    tabColor: INK,
    freeze: { rows: HEADER_ROW },
    page: {
      orientation: 'landscape',
      fitToWidth: 1,
      titleRows: [HEADER_ROW, HEADER_ROW],
      printColumns: ['A', 'J'],
      footerLeft: 'Pace IT Ledger  ·  Confidential',
      footerCenter: `${ref}  ·  ${summary.label}`,
      footerRight: 'Page &P of &N',
    },
    merges: ['A1:E1', 'F1:J1', 'A2:J2', 'A3:G3'],
    tail: () => {
      const last = FIRST_DATA_ROW + state.count - 1;
      const totalRow = last + 1;
      const closeRow = totalRow + 1;
      const recRow = closeRow + 1;
      return {
        autoFilter: state.count > 0 ? `A${HEADER_ROW}:${LEDGER_LAST_COL}${last}` : undefined,
        merges: [`A${totalRow}:G${totalRow}`, `A${closeRow}:I${closeRow}`, `A${recRow}:J${recRow}`],
      };
    },
  };

  return {
    sheets: [summarySheet, ledgerSheet],
    options: { styles, title: `Income & Expense Statement – ${summary.label}`, creator: 'Pace IT Ledger' },
  };
}
