# Pace IT Ledger

Internal finance, employee payroll, loan, and daily expense management application for Pace IT.

## Technology

React 19, Vite, Tailwind CSS 4, Express, TypeScript, and Node.js built-in SQLite (`node:sqlite`). Use Node.js 22 or later.

## Run locally

```bash
npm ci
npm run build
npm start
```

Development mode: `npm run dev`. Type-check: `npm run lint`. Automated tests: `npm test`.

## Upgrade an existing installation

1. Stop the current application and make a separate backup before upgrading.
2. Extract the updated project into a new directory.
3. Copy the existing `data` directory (or your configured `PACE_DATA_DIR`) into the new project. Preserve both `pace_it_ledger.sqlite` and `pace_it_secret.key`.
4. Run `npm ci`, then `npm start`. Startup applies additive, versioned SQLite migrations. It does not recreate the user's database.
5. Verify the audit chain in the Audit screen before resuming normal work.

The source delivery archive intentionally excludes the database, WAL/SHM sidecars, receipts, and audit-signing secret. Never overwrite the real `data` directory with a synthetic test database.

## Roles and permissions

Only two roles can change data. Every other role is strictly read-only, however it is titled.

| Role | Can do |
| --- | --- |
| Finance Admin (`admin`) | Everything: enter, edit and void entries, verify/flag, restore voided entries, master data (heads, departments, funding sources, employees, rent items), period locks, user and role management, backup, restore and wipe. |
| Accountant (`accountant`) | Enter, edit and void ledger entries, and record salary, advance, loan, loan-repayment and rent payments. Cannot touch backups, restore, user management, locks, verification, master data or deletions of payroll/loan/rent records. |
| General Manager, CEO, CTO, Visitor, User | View only. No entry, edit, void or payment buttons, and the server rejects the same calls with 403. |

Notes:

- Enforcement is on the server (`editorMiddleware` / `adminMiddleware` in `server/api.ts`); hiding buttons in the UI is only a convenience. The role is read from the database on every request, so a role change by an administrator applies on the person's very next action. Open browsers also pick it up through the live-update stream.
- An administrator can change anyone's role in **Administrator → Accounts**. An accountant moved to any read-only role immediately loses all write power. You cannot remove your own admin role, and at least one active administrator must remain.
- History is never lost: every accountant entry, edit and void is recorded in the audit chain with the actor and role, edits keep their before/after history, voided entries stay in the Admin Bin, and role changes are written to the security log (old role -> new role).
- Accountants' entries are not stamped as verified by an administrator, and an accountant's amount edit flags the entry for administrator review.
- An unknown or corrupted role value is treated as read-only.
- Accounts that had the old `user` role (labelled "Accounts Manager") are now read-only. Promote the people who do data entry to **Accountant** after upgrading.

## Importing from Excel

**Administrator → Excel Import** (admin only) loads an existing Income & Expense workbook in four steps. Nothing is saved until step 4.

1. **Upload** the .xlsx. The server only reads it and builds a preview.
2. **Review** the preview. Every record appears in an editable table (Money in, Money out, Employees, Salaries, Loans, Rent) exactly as it would be saved. Fields the sheet does not contain (category, payment method, who was paid) are suggested and highlighted yellow. Fix any cell in place and tick or untick rows; the checks re-run after each edit.
3. **Checks** compares the preview with the totals printed in the workbook, projects each fund source's balance, and lists anything that needs a decision.
4. **Confirm** with your admin password. All records are written in one database transaction, so an error anywhere rolls everything back.

How the workbook is read:

| Sheet | Becomes |
| --- | --- |
| Expense, left block (Date, Manager, Details, amount) | Income entries. Details is the channel (OWNER-CASH, BRAC-BANK-ATM ...). |
| Expense, right block (Date, Department, Details, amount) | Expense entries. Department is the office/head. |
| salary, employee list | Employees with their monthly salary. |
| salary, payment log | Salary payments, each creating its linked ledger entry. |
| LONE | Loans given and loan repayments. |
| Rent | Rent obligations (regular / urgent amounts). The sheet records no rent payments, so none are created. |

Safeguards:

- Salary, advance and loan payments appear twice in this kind of workbook (as free text in the cash book and again on the Salary/Loan sheets). A cash-book row is considered covered only when its date, amount and employee match; a similar amount on a different day is not suppressed. Matching cash-book rows are unticked so the money is counted once. Cash-book rows that look like payroll but match nothing are flagged, with a button to convert them.
- A `Previous Month` income row is treated as the opening balance, not as new current-month income. Prior-dated salary/loan activity is reconciled with a visible system adjustment dated at the previous month-end, and the preview shows the opening-balance check.
- Each loan repayment requires a cash-treatment choice. `Cash received` creates a new income transaction; `Already in cash book` reduces the loan balance without recording another income transaction. The preview shows the effect on the closing balance.
- Exact cross-month payroll/loan duplicates (date + employee + amount) are unticked by default, including historical repayments which have no linked cash transaction. Review the skip reason; an admin can re-enable a row when it is genuinely a separate payment.
- Rows with no date take the date above them and are flagged.
- Salary rows whose Details column names a different person are left unticked, with the reason shown.
- Rent rows match existing rent obligations by name (case-insensitive). Existing items are updated in place with the current workbook amounts and department; their IDs and existing notes are preserved, and no duplicate rent item is created. New names are created as new obligations.
- A fund that would go below zero, a locked period, an overpaid salary, or any invalid field blocks the import and names the row.
- Import monthly workbooks in chronological order (oldest first), and review duplicate warnings before each confirmation. The same file cannot be imported twice. Every imported record carries an `[import:...]` tag in its notes and appears in the audit trail under the admin who confirmed.
- Nothing is deleted. Download a backup first anyway.

## Transaction APIs and exports

`GET /api/transactions` uses cursor/keyset pagination (50 rows by default, 100 maximum). It supports `from`, `to`, `kind`, `head`, `department`, `paymentMethod`, `employeeId`, `fundSourceId`, `auditFilter`, `search`, and `sort`. Pass the returned `nextCursor` with the same filters to fetch the next page.

Large exports are generated server-side from a separate, read-only SQLite snapshot. `GET /api/transactions/export.csv` streams UTF-8 CSV and `GET /api/transactions/export.xlsx` streams an XLSX workbook. The statement XLSX contains a summary and itemized ledger worksheets; the Statement screen also offers a separate itemized CSV. Exports preserve stable ordering and selected filters without building a complete transaction array in browser memory. CSV text fields are escaped against spreadsheet formula injection. XLSX uses standard ZIP worksheet limits (1,048,576 rows per sheet and under 4 GiB for the classic ZIP workbook container).

## Backup and restore

Use **Administrator → Backup → Download Full SQLite Backup** for large databases. SQLite creates a consistent `VACUUM INTO` snapshot in a separate child process, verifies it, and streams the resulting file to the browser. This includes the database's tables, indexes, FTS data, and receipt BLOBs.

SQLite restore streams the uploaded file to disk, checks its schema, SQLite integrity, FTS integrity and audit chain, then swaps the database while retaining the previous database as a `.pre-restore-*` file. The audit-signing key is stored separately and is not inside the SQLite file; restore a backup into the same installation (or preserve and securely transfer that installation's `pace_it_secret.key`). Do not delete the pre-restore file until the restored ledger has been checked.

The JSON backup/restore format remains available for compatibility with older backups. JSON restore still parses the payload in memory and is limited to 100 MB; use SQLite backup/restore for large ledgers.

## Disposable scalability test

The synthetic load test refuses to run unless `PACE_LOAD_TEST=1`, `PACE_DATA_DIR` points to a new empty directory, and no database already exists there. Never point it at production data.

PowerShell:

```powershell
$env:PACE_LOAD_TEST = "1"
$env:PACE_DATA_DIR = "$PWD\.ledger-load-test-data"
npm run load-test
# Then, in the same terminal/session and with the same PACE_DATA_DIR:
npm run load-test:exports
```

Bash:

```bash
PACE_LOAD_TEST=1 PACE_DATA_DIR="$PWD/.ledger-load-test-data" npm run load-test
PACE_DATA_DIR="$PWD/.ledger-load-test-data" npm run load-test:exports
```

The default target milestones are 10,000, 100,000, 300,000 and 500,000 synthetic rows. Set `PACE_LOAD_TEST_COUNTS=10000,100000` to run a smaller subset. Each milestone measures first-page and cursor-page queries, date and combined filters, head filter, substring search, date and daily summaries, employee statistics, and transaction CRUD. Query timings include average, median, p95, p99, sample count, throughput and CPU time. The final phase runs four concurrent application-level writers through the normal transaction service (create + edit), verifies their integer-paisa total and audit chain, streams the legacy JSON backup, creates a SQLite-native snapshot, and checks SQLite/FTS integrity. RSS/heap and database/WAL file size are reported. Large CSV/XLSX export measurements run separately to avoid contaminating CRUD timings: after the database load test completes, run `npm run load-test:exports` with the same `PACE_DATA_DIR`. That process opens the completed disposable database read-only and validates exported row counts and bytes.

The synthetic rows are inserted directly to make database-load testing practical; they do not receive individual audit entries. The real audit chain is checked before synthetic insertion and again after the concurrent application-level writes. Synthetic rows themselves deliberately have no audit entries, so the synthetic database is not a valid production ledger and must not be used to exercise restore/audit verification. The resulting data directory is test-only, cannot be used as production ledger data, and should be deleted after testing. `npm run load-test` tests the database service methods directly rather than HTTP/network latency. Small audited SQLite snapshot/restore behavior is covered by the automated test suite; restore of synthetic 500k data is deliberately not attempted because those rows do not have real audit-chain entries.

## Operations notes

- Keep `PACE_DATA_DIR` on reliable local storage with free space for the database, WAL, snapshots, and retained pre-restore files.
- Do not manually copy only the main `.sqlite` file while the app is running; use the SQLite snapshot backup endpoint to capture a consistent database state.
- Normal ledger, dashboard, employee/source history, and deleted-bin requests are bounded. Large CSV/XLSX exports and SQLite backups are streamed with backpressure. Old JSON restore remains a small-backup compatibility path.
- The pinned SheetJS package is still required by the one-time Excel migration utility (`scripts/migrate-excel.ts`); do not remove it without replacing that utility. It is pinned to SheetJS's distribution tarball in the lockfile.
