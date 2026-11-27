import { performance } from 'node:perf_hooks';
import { db } from '../server/db';
import { transactionCsv, transactionWorksheet } from '../server/exportStreams';
import { streamXlsxWorkbook } from '../server/xlsxStream';

await db.ready();
const query = { from: '2023-01-01', to: '2026-12-31', sort: 'newest' as const };
const expectedRows = db.getTransactionsPage({ limit: 1 }).totalCount;

const csvSnapshot = db.openTransactionExportSnapshot(query);
const csvStarted = performance.now();
let csvBytes = 0;
let csvChunks = 0;
for await (const chunk of transactionCsv(csvSnapshot)) {
  csvBytes += chunk.length;
  csvChunks += 1;
}
const csvElapsedMs = performance.now() - csvStarted;
const csvRows = Math.max(0, csvChunks - 1); // one header chunk, then one row per chunk
if (csvRows !== expectedRows) throw new Error(`CSV export row count mismatch: expected ${expectedRows}, received ${csvRows}.`);

const xlsxSnapshot = db.openTransactionExportSnapshot(query);
const xlsxStarted = performance.now();
let xlsxBytes = 0;
let xlsxChunks = 0;
let xlsxRows = 0;
async function* countedRows() {
  for await (const transaction of xlsxSnapshot.rows) {
    xlsxRows += 1;
    yield transaction;
  }
}
try {
  for await (const chunk of streamXlsxWorkbook([{ name: 'Transactions', rows: transactionWorksheet(countedRows()) }])) {
    xlsxBytes += chunk.length;
    xlsxChunks += 1;
  }
} finally {
  xlsxSnapshot.close();
}
const xlsxElapsedMs = performance.now() - xlsxStarted;
if (xlsxRows !== expectedRows) throw new Error(`XLSX export row count mismatch: expected ${expectedRows}, received ${xlsxRows}.`);

const memory = process.memoryUsage();
process.stdout.write(`PACE_EXPORT_RESULT=${JSON.stringify({
  expectedRows,
  csv: {
    elapsedMs: Number(csvElapsedMs.toFixed(2)),
    bytes: csvBytes,
    chunks: csvChunks,
    rows: csvRows,
    throughputRowsPerSec: Number((csvRows / Math.max(csvElapsedMs / 1000, 0.001)).toFixed(1)),
  },
  xlsx: {
    elapsedMs: Number(xlsxElapsedMs.toFixed(2)),
    bytes: xlsxBytes,
    chunks: xlsxChunks,
    rows: xlsxRows,
    throughputRowsPerSec: Number((xlsxRows / Math.max(xlsxElapsedMs / 1000, 0.001)).toFixed(1)),
  },
  memoryMb: {
    rss: Number((memory.rss / 1024 / 1024).toFixed(1)),
    heapUsed: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
  },
})}\n`);
