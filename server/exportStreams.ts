import { fromPaisa } from '../src/utils/money';
import type { LedgerTransaction } from '../src/types';
import type { TransactionExportSnapshot } from './db';
import type { XlsxRow } from './xlsxStream';

function csvCell(value: unknown): string {
  let text = String(value ?? '');
  // CSV opens in spreadsheet applications: never allow imported/user-entered text
  // to become a formula. Numeric fields stay numeric because they are passed as numbers.
  if (typeof value === 'string' && /^[\u0000-\u0020]*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const TRANSACTION_EXPORT_HEADERS = [
  'Voucher', 'Date', 'Type', 'Department', 'Channel / Office', 'Sub-Category', 'Amount (BDT)',
  'Method', 'Ref / Cheque / ATM #', 'From / Where Spent', 'Why / Purpose', 'Status', 'Edits',
  'Amount Changed', 'Last Edit Reason', 'Created By',
];

export function transactionExportValues(tx: LedgerTransaction): (string | number)[] {
  return [
    tx.voucherNo, tx.txDate, tx.kind.toUpperCase(), tx.department || '', tx.head, tx.subCategory,
    Number(fromPaisa(tx.amountPaisa)), tx.paymentMethod, tx.referenceNo, tx.counterparty, tx.purpose,
    tx.status, tx.editCount, tx.amountChanged ? 'YES' : 'NO', tx.lastEditReason || '', tx.createdByName,
  ];
}

export async function* transactionCsv(snapshot: TransactionExportSnapshot): AsyncGenerator<Buffer> {
  try {
    yield Buffer.from(`\uFEFF${TRANSACTION_EXPORT_HEADERS.map(csvCell).join(',')}\r\n`, 'utf8');
    for await (const tx of snapshot.rows) {
      yield Buffer.from(`${transactionExportValues(tx).map(csvCell).join(',')}\r\n`, 'utf8');
    }
  } finally {
    snapshot.close();
  }
}

export async function* transactionWorksheet(rows: AsyncIterable<LedgerTransaction>): AsyncGenerator<XlsxRow> {
  yield TRANSACTION_EXPORT_HEADERS;
  for await (const tx of rows) {
    const values = transactionExportValues(tx);
    values[6] = { value: Number(fromPaisa(tx.amountPaisa)), style: 2 } as any;
    yield values as XlsxRow;
  }
}
