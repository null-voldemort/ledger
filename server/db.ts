import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { DatabaseSync } from 'node:sqlite';
import { readMaintenance, MaintenanceInfo } from './maintenance';
import {
  SESSION_TTL_MS,
  SESSION_IDLE_MS,
  hashPassword,
  verifyPassword,
  cleanPhotoUrl,
  passwordProblem,
} from './passwords';
import {
  DEFAULT_INCOME_HEADS,
  DEFAULT_EXPENSE_HEADS,
  DEFAULT_DEPARTMENTS,
  summarizePeriod,
  monthRangeOf,
  type PeriodSummary,
} from '../src/utils/ledger';
import { fromPaisa } from '../src/utils/money';
import { isUserRole, normalizeRole } from '../src/utils/roles';
import type {
  AppUser,
  EmployeeSpendStat,
  AdminUserSummary,
  SecurityEvent,
  LedgerTransaction,
  LedgerHead,
  DepartmentRecord,
  PeriodLock,
  AuditChainEntry,
  ChainVerificationResult,
  ActivityEvent,
  FieldDiff,
  TxEditEntry,
  TxCategoryGroup,
  UserRole,
  ThemeMode,
  Employee,
  SalaryPayment,
  EmployeeLoan,
  LoanRepayment,
  FundSource,
  EmployeeAdvance,
  EmployeeAdvanceRepayment,
  RentItem,
  RentPayment,
} from '../src/types';
import { validateFullBackupShape, type ValidatedTxInput } from './validation';

export * from './passwords';

type SqlValue = string | number | null | Uint8Array;

const DB_DIR = path.resolve(process.env.PACE_DATA_DIR || path.join(process.cwd(), 'data'));
const SQLITE_FILE = path.join(DB_DIR, 'pace_it_ledger.sqlite');
export const SQLITE_DATABASE_FILE = SQLITE_FILE;
export const SQLITE_DATABASE_DIR = DB_DIR;
const SECRET_FILE = path.join(DB_DIR, 'pace_it_secret.key');
export const FULL_BACKUP_FORMAT = 'pace-it-ledger-backup';

function isSha(sha: string): boolean {
  return /^[a-f0-9]{64}$/.test(sha);
}

// Extra list orderings. Date sorts keep their dedicated keyset (tx_date, created_at, id). Every other sort pages
// by (sort key, id) with both columns running in the same direction, so one row-value comparison is enough.
// The key is an SQL expression; its value for the last row is read back from SQLite (sort_key) and put in the
// cursor, so text ordering and paging always agree (including non-ASCII names).
const CUSTOM_SORTS: Record<string, { key: string; dir: 'ASC' | 'DESC'; numeric: boolean }> = {
  amount_desc: { key: 't.amount_paisa', dir: 'DESC', numeric: true },
  amount_asc: { key: 't.amount_paisa', dir: 'ASC', numeric: true },
  party_asc: { key: "lower(COALESCE(t.counterparty, ''))", dir: 'ASC', numeric: false },
  party_desc: { key: "lower(COALESCE(t.counterparty, ''))", dir: 'DESC', numeric: false },
  department_asc: { key: "lower(COALESCE(t.department, ''))", dir: 'ASC', numeric: false },
  voucher_desc: { key: "COALESCE(t.voucher_no, '')", dir: 'DESC', numeric: false },
  voucher_asc: { key: "COALESCE(t.voucher_no, '')", dir: 'ASC', numeric: false },
};

function getOrGenerateSecret(): string {
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const s = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      if (s) return s;
    } catch {
    }
  }
  const newSecret = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, newSecret, 'utf-8');
  } catch {
  }
  return newSecret;
}

class NativeDb {
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(public readonly raw: DatabaseSync) {}

  private bind(params?: unknown[]): SqlValue[] {
    return (params || []).map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SqlValue)));
  }

  private statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    let statement = this.statements.get(sql);
    if (statement) {
      // Refresh insertion order for a small LRU cache of hot prepared statements.
      this.statements.delete(sql);
      this.statements.set(sql, statement);
      return statement;
    }
    statement = this.raw.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > 400) {
      const oldest = this.statements.keys().next().value;
      if (oldest) this.statements.delete(oldest);
    }
    return statement;
  }

  run(sql: string, params?: unknown[]): void {
    if (!params || params.length === 0) {
      this.raw.exec(sql);
      return;
    }
    this.statement(sql).run(...this.bind(params));
  }

  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
    return this.statement(sql).all(...this.bind(params)) as unknown as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
    return this.statement(sql).get(...this.bind(params)) as unknown as T | undefined;
  }

  iterate<T = Record<string, unknown>>(sql: string, params?: unknown[]): Iterable<T> {
    return this.statement(sql).iterate(...this.bind(params)) as unknown as Iterable<T>;
  }

  scalar<T = SqlValue>(sql: string, params?: unknown[]): T | undefined {
    const row = this.statement(sql).get(...this.bind(params)) as Record<string, unknown> | undefined;
    return row ? (Object.values(row)[0] as T) : undefined;
  }
}

export interface TransactionListQuery {
  limit?: number;
  cursor?: string;
  from?: string;
  to?: string;
  kind?: 'income' | 'expense' | 'all';
  head?: string;
  department?: string;
  paymentMethod?: string;
  employeeId?: string;
  fundSourceId?: string;
  auditFilter?: 'all' | 'edited' | 'amount_changed' | 'flagged' | 'receipt' | 'unclassified_dept' | 'flagged_or_changed';
  search?: string;
  sort?: 'newest' | 'oldest' | 'amount_desc' | 'amount_asc' | 'party_asc' | 'party_desc' | 'department_asc' | 'voucher_desc' | 'voucher_asc';
  includeDeleted?: boolean;
}

export interface TransactionPage {
  items: LedgerTransaction[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  totalCount: number;
  incomePaisa: number;
  expensePaisa: number;
  netPaisa: number;
}

export interface PeriodSummaryResponse extends PeriodSummary {
  periodTransactionCount: number;
  periodExpenseCount: number;
  incomeCount: number;
  expenseCount: number;
}

export interface TransactionExportSnapshot {
  summary: PeriodSummaryResponse | null;
  rows: AsyncGenerator<LedgerTransaction>;
  close: () => void;
}

export interface StoredUser extends AppUser {
  password: string;
}

function computeAuditHash(payload: {
  seq: number;
  at: string;
  actorId: string;
  eventType: string;
  entryId: string;
  voucherNo: string;
  reason: string;
  diffJson: string;
  amountDeltaPaisa: number;
  afterSnapshotJson: string;
  prevHash: string;
}): string {
  const canonical = [
    payload.seq,
    payload.at,
    payload.actorId,
    payload.eventType,
    payload.entryId,
    payload.voucherNo,
    payload.reason,
    payload.diffJson,
    payload.amountDeltaPaisa,
    payload.afterSnapshotJson,
    payload.prevHash,
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function txSnapshotForAudit(tx: LedgerTransaction): string {
  return JSON.stringify({
    id: tx.id,
    voucherNo: tx.voucherNo,
    kind: tx.kind,
    txDate: tx.txDate,
    amountPaisa: tx.amountPaisa,
    department: tx.department || '',
    head: tx.head,
    subCategory: tx.subCategory,
    paymentMethod: tx.paymentMethod,
    referenceNo: tx.referenceNo,
    counterparty: tx.counterparty,
    purpose: tx.purpose,
    fundSourceId: tx.fundSourceId,
    status: tx.status,
    deletedAt: tx.deletedAt || '',
  });
}

class LedgerDatabase extends EventEmitter {
  private sqlite!: NativeDb;
  private secret: string = getOrGenerateSecret();
  private initPromise: Promise<void>;
  private maintenance: MaintenanceInfo | null = null;
  private maintenanceCheckedAt = 0;

  constructor() {
    super();
    this.setMaxListeners(0);
    this.initPromise = this.init();
    this.initPromise.catch((err) => {
      console.error('[Pace IT Ledger] Failed to start database:', err);
      process.exit(1);
    });
  }

  async ready(): Promise<void> {
    return this.initPromise;
  }

  private openDatabaseConnection(): void {
    const raw = new DatabaseSync(SQLITE_FILE);
    raw.exec('PRAGMA busy_timeout = 10000');
    raw.exec('PRAGMA synchronous = FULL');
    raw.exec('PRAGMA wal_autocheckpoint = 1000');
    raw.exec('PRAGMA temp_store = MEMORY');
    raw.exec('PRAGMA cache_size = -16000');
    raw.exec('PRAGMA foreign_keys = OFF');
    const chk = (raw.prepare('PRAGMA quick_check').get() as Record<string, unknown>)?.quick_check;
    if (chk !== 'ok') {
      raw.close();
      throw new Error(`SQLite quick_check failed: ${chk}`);
    }
    raw.exec('PRAGMA journal_mode = WAL');
    this.sqlite = new NativeDb(raw);
  }

  private async init() {
    fs.mkdirSync(DB_DIR, { recursive: true });
    this.openDatabaseConnection();
    this.createSchema();
    this.seedDefaultHeads();
    this.seedDefaultDepartments();
    this.seedDefaultFundSources();
  }

  private createSchema() {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        theme TEXT NOT NULL DEFAULT 'light',
        disabled INTEGER NOT NULL DEFAULT 0,
        phone_number TEXT DEFAULT '',
        email TEXT DEFAULT '',
        photo_url TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        username TEXT DEFAULT '',
        ip TEXT DEFAULT '',
        detail TEXT DEFAULT '',
        meta_json TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_sec_at ON security_events(at DESC);

      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        by_user TEXT NOT NULL,
        action TEXT NOT NULL,
        voucher_no TEXT DEFAULT '',
        head TEXT DEFAULT '',
        amount_paisa INTEGER DEFAULT 0,
        detail TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_act_at ON activity(at DESC);

      CREATE TABLE IF NOT EXISTS ledger_heads (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        UNIQUE(kind, name)
      );

      CREATE TABLE IF NOT EXISTS fund_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        voucher_no TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        tx_date TEXT NOT NULL,
        amount_paisa INTEGER NOT NULL,
        department TEXT DEFAULT '',
        department_review INTEGER NOT NULL DEFAULT 0,
        head TEXT NOT NULL,
        sub_category TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        reference_no TEXT DEFAULT '',
        counterparty TEXT NOT NULL,
        counterparty_phone TEXT DEFAULT '',
        purpose TEXT NOT NULL,
        notes TEXT DEFAULT '',
        funded_by_tx_id TEXT DEFAULT '',
        employee_id TEXT DEFAULT '',
        employee_name TEXT DEFAULT '',
        category_group TEXT DEFAULT 'general',
        fund_source_id TEXT DEFAULT '',
        receipt_sha TEXT DEFAULT '',
        receipt_name TEXT DEFAULT '',
        receipt_type TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'verified',
        verified_by_name TEXT DEFAULT '',
        verified_at TEXT DEFAULT '',
        flag_note TEXT DEFAULT '',
        edit_count INTEGER NOT NULL DEFAULT 0,
        amount_changed INTEGER NOT NULL DEFAULT 0,
        last_edited_at TEXT DEFAULT '',
        last_edited_by TEXT DEFAULT '',
        last_edit_reason TEXT DEFAULT '',
        edit_history_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT DEFAULT '',
        deleted_by TEXT DEFAULT '',
        delete_reason TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(tx_date DESC);
      CREATE INDEX IF NOT EXISTS idx_tx_kind ON transactions(kind);
      CREATE INDEX IF NOT EXISTS idx_tx_head ON transactions(head);
      CREATE INDEX IF NOT EXISTS idx_tx_deleted ON transactions(deleted_at);

      CREATE TABLE IF NOT EXISTS receipt_files (
        sha TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        department TEXT DEFAULT '',
        branch TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        email TEXT DEFAULT '',
        photo_url TEXT DEFAULT '',
        monthly_salary_paisa INTEGER NOT NULL DEFAULT 0,
        joined_date TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_emp_active ON employees(active);

      CREATE TABLE IF NOT EXISTS salary_payments (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        month_key TEXT NOT NULL,
        paid_date TEXT NOT NULL,
        base_salary_paisa INTEGER NOT NULL,
        bonus_paisa INTEGER NOT NULL DEFAULT 0,
        loan_deduction_paisa INTEGER NOT NULL DEFAULT 0,
        advance_deduction_paisa INTEGER NOT NULL DEFAULT 0,
        other_deduction_paisa INTEGER NOT NULL DEFAULT 0,
        net_paid_paisa INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        reference_no TEXT DEFAULT '',
        department TEXT DEFAULT '',
        head TEXT NOT NULL,
        fund_source_id TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        receipt_sha TEXT DEFAULT '',
        receipt_name TEXT DEFAULT '',
        receipt_type TEXT DEFAULT '',
        linked_tx_id TEXT DEFAULT '',
        linked_voucher_no TEXT DEFAULT '',
        paid_by_id TEXT NOT NULL,
        paid_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sal_month ON salary_payments(month_key DESC);
      CREATE INDEX IF NOT EXISTS idx_sal_emp_month ON salary_payments(employee_id, month_key);

      CREATE TABLE IF NOT EXISTS employee_loans (
        id TEXT PRIMARY KEY,
        loan_no TEXT UNIQUE NOT NULL,
        employee_id TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        issued_date TEXT NOT NULL,
        principal_paisa INTEGER NOT NULL,
        remaining_paisa INTEGER NOT NULL,
        monthly_installment_paisa INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL,
        reference_no TEXT DEFAULT '',
        head TEXT NOT NULL,
        fund_source_id TEXT DEFAULT '',
        purpose TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        receipt_sha TEXT DEFAULT '',
        receipt_name TEXT DEFAULT '',
        receipt_type TEXT DEFAULT '',
        linked_tx_id TEXT DEFAULT '',
        linked_voucher_no TEXT DEFAULT '',
        issued_by_id TEXT NOT NULL,
        issued_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settled_at TEXT DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_loan_emp ON employee_loans(employee_id);
      CREATE INDEX IF NOT EXISTS idx_loan_status ON employee_loans(status);

      CREATE TABLE IF NOT EXISTS loan_repayments (
        id TEXT PRIMARY KEY,
        loan_id TEXT NOT NULL,
        paid_date TEXT NOT NULL,
        amount_paisa INTEGER NOT NULL,
        source TEXT NOT NULL,
        fund_source_id TEXT DEFAULT '',
        payment_method TEXT NOT NULL,
        reference_no TEXT DEFAULT '',
        note TEXT DEFAULT '',
        salary_payment_id TEXT DEFAULT '',
        receipt_sha TEXT DEFAULT '',
        receipt_name TEXT DEFAULT '',
        receipt_type TEXT DEFAULT '',
        linked_tx_id TEXT DEFAULT '',
        linked_voucher_no TEXT DEFAULT '',
        recorded_by_id TEXT NOT NULL,
        recorded_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repay_loan ON loan_repayments(loan_id);

      CREATE TABLE IF NOT EXISTS employee_advances (
        id TEXT PRIMARY KEY,
        advance_no TEXT UNIQUE NOT NULL,
        employee_id TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        month_key TEXT DEFAULT '',
        issued_date TEXT NOT NULL,
        principal_paisa INTEGER NOT NULL,
        remaining_paisa INTEGER NOT NULL,
        department TEXT DEFAULT '',
        purpose TEXT NOT NULL,
        fund_source_id TEXT NOT NULL,
        linked_tx_id TEXT NOT NULL,
        linked_voucher_no TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by_id TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settled_at TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS salary_advance_repayments (
        id TEXT PRIMARY KEY,
        advance_id TEXT NOT NULL,
        salary_payment_id TEXT NOT NULL,
        paid_date TEXT NOT NULL,
        amount_paisa INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_advance_employee ON employee_advances(employee_id);
      CREATE INDEX IF NOT EXISTS idx_advance_status ON employee_advances(status);
      CREATE INDEX IF NOT EXISTS idx_advance_repayment ON salary_advance_repayments(advance_id);

      CREATE TABLE IF NOT EXISTS rent_items (
        id TEXT PRIMARY KEY,
        sl INTEGER NOT NULL DEFAULT 0,
        name TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL DEFAULT 'regular',
        monthly_amount_paisa INTEGER NOT NULL DEFAULT 0,
        urgent_amount_paisa INTEGER NOT NULL DEFAULT 0,
        department TEXT NOT NULL DEFAULT '',
        notes TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rent_payments (
        id TEXT PRIMARY KEY,
        rent_item_id TEXT NOT NULL,
        rent_item_name TEXT NOT NULL,
        month_key TEXT NOT NULL,
        paid_date TEXT NOT NULL,
        amount_paisa INTEGER NOT NULL,
        department TEXT NOT NULL DEFAULT '',
        fund_source_id TEXT NOT NULL DEFAULT '',
        payment_method TEXT NOT NULL,
        reference_no TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        receipt_sha TEXT DEFAULT '',
        receipt_name TEXT DEFAULT '',
        receipt_type TEXT DEFAULT '',
        linked_tx_id TEXT DEFAULT '',
        linked_voucher_no TEXT DEFAULT '',
        paid_by_id TEXT NOT NULL,
        paid_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rent_pay_month ON rent_payments(month_key DESC);
      CREATE INDEX IF NOT EXISTS idx_rent_pay_item ON rent_payments(rent_item_id);

      CREATE TABLE IF NOT EXISTS period_locks (
        id TEXT PRIMARY KEY,
        period_key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        opening_paisa INTEGER NOT NULL,
        income_paisa INTEGER NOT NULL,
        expense_paisa INTEGER NOT NULL,
        closing_paisa INTEGER NOT NULL,
        locked_at TEXT NOT NULL,
        locked_by_id TEXT NOT NULL,
        locked_by_name TEXT NOT NULL,
        note TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS ledger_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        voucher_no TEXT DEFAULT '',
        reason TEXT NOT NULL,
        diff_json TEXT NOT NULL DEFAULT '[]',
        amount_delta_paisa INTEGER NOT NULL DEFAULT 0,
        after_snapshot_json TEXT NOT NULL DEFAULT '{}',
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_entry ON ledger_audit(entry_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    this.sqlite.run('DROP INDEX IF EXISTS idx_fr_status');
    this.sqlite.run('DROP INDEX IF EXISTS idx_fr_date');
    this.sqlite.run('DROP TABLE IF EXISTS fund_requests');
    const userCols = new Set(this.sqlite.all<{ name: string }>('PRAGMA table_info(users)').map((c) => c.name));
    if (!userCols.has('theme')) this.sqlite.run("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");

    const cols = new Set(this.sqlite.all<{ name: string }>('PRAGMA table_info(transactions)').map((c) => c.name));
    if (cols.has('fund_request_id')) {
      try { this.sqlite.run('ALTER TABLE transactions DROP COLUMN fund_request_id'); cols.delete('fund_request_id'); } catch { }
    }
    if (!cols.has('department')) this.sqlite.run("ALTER TABLE transactions ADD COLUMN department TEXT DEFAULT ''");
    if (!cols.has('department_review')) this.sqlite.run('ALTER TABLE transactions ADD COLUMN department_review INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('employee_id')) this.sqlite.run("ALTER TABLE transactions ADD COLUMN employee_id TEXT DEFAULT ''");
    if (!cols.has('employee_name')) this.sqlite.run("ALTER TABLE transactions ADD COLUMN employee_name TEXT DEFAULT ''");
    if (!cols.has('category_group')) this.sqlite.run("ALTER TABLE transactions ADD COLUMN category_group TEXT DEFAULT 'general'");
    if (!cols.has('fund_source_id')) this.sqlite.run("ALTER TABLE transactions ADD COLUMN fund_source_id TEXT DEFAULT ''");
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_tx_employee ON transactions(employee_id)');
    this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_tx_dept ON transactions(department)');

    // Match the default active-ledger filter and stable date ordering in one index.
    // Keep the partial predicate aligned with the application's existing deleted_at = '' rule.
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_date_created_id
      ON transactions(tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_kind_date
      ON transactions(kind, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_head_date
      ON transactions(head, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_dept_date
      ON transactions(department, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_employee_date
      ON transactions(employee_id, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_fund_date
      ON transactions(fund_source_id, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_method_date
      ON transactions(payment_method, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at = ''`);
    // Cover the high-volume dashboard/head aggregates without touching the list-order indexes.
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_head_totals
      ON transactions(head, kind, amount_paisa) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_active_date_summary
      ON transactions(tx_date, kind, head, amount_paisa, edit_count) WHERE deleted_at = ''`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_tx_deleted_date_created_id
      ON transactions(deleted_at DESC, tx_date DESC, created_at DESC, id DESC) WHERE deleted_at != ''`);

    // A single generated search column lets trigram FTS answer substring queries
    // with one indexed lookup while keeping the source transaction fields canonical.
    const ftsV4 = this.sqlite.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = 4');
    const searchTextExpression = `lower(
      COALESCE(voucher_no, '') || char(31) || COALESCE(tx_date, '') || char(31) ||
      COALESCE(department, '') || char(31) || COALESCE(head, '') || char(31) ||
      COALESCE(sub_category, '') || char(31) || COALESCE(payment_method, '') || char(31) ||
      COALESCE(reference_no, '') || char(31) || COALESCE(counterparty, '') || char(31) ||
      COALESCE(employee_name, '') || char(31) || COALESCE(purpose, '') || char(31) ||
      COALESCE(notes, '') || char(31) || COALESCE(created_by_name, '') || char(31) ||
      COALESCE(last_edit_reason, '')
    )`;
    if (!ftsV4) {
      this.sqlite.run('BEGIN IMMEDIATE');
      try {
        const transactionColumns = this.sqlite.all<{ name: string }>('PRAGMA table_xinfo(transactions)');
        if (!transactionColumns.some((column) => column.name === 'search_text')) {
          this.sqlite.run(`ALTER TABLE transactions ADD COLUMN search_text TEXT
            GENERATED ALWAYS AS (${searchTextExpression}) VIRTUAL`);
        }
        this.sqlite.run('DROP TRIGGER IF EXISTS transactions_fts_ai');
        this.sqlite.run('DROP TRIGGER IF EXISTS transactions_fts_ad');
        this.sqlite.run('DROP TRIGGER IF EXISTS transactions_fts_au');
        this.sqlite.run('DROP TABLE IF EXISTS transactions_fts');
        this.sqlite.run(`CREATE VIRTUAL TABLE transactions_fts USING fts5(
          search_text, content='transactions', content_rowid='rowid', tokenize='trigram', detail='none'
        )`);
        this.sqlite.run(`CREATE TRIGGER transactions_fts_ai AFTER INSERT ON transactions BEGIN
          INSERT INTO transactions_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
        END`);
        this.sqlite.run(`CREATE TRIGGER transactions_fts_ad AFTER DELETE ON transactions BEGIN
          INSERT INTO transactions_fts(transactions_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
        END`);
        this.sqlite.run(`CREATE TRIGGER transactions_fts_au AFTER UPDATE ON transactions BEGIN
          INSERT INTO transactions_fts(transactions_fts, rowid, search_text)
          VALUES ('delete', old.rowid, old.search_text);
          INSERT INTO transactions_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
        END`);
        this.sqlite.run("INSERT INTO transactions_fts(transactions_fts) VALUES ('rebuild')");
        const appliedAt = new Date().toISOString();
        this.sqlite.run(
          'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, ?, ?)',
          ['transaction-substring-search-fts5-trigram', appliedAt],
        );
        this.sqlite.run(
          'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, ?, ?)',
          ['compact-trigram-search-index-without-token-positions', appliedAt],
        );
        this.sqlite.run(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, ?, ?)',
          ['single-column-compact-trigram-substring-search', appliedAt],
        );
        this.sqlite.run('COMMIT');
      } catch (error) {
        this.sqlite.run('ROLLBACK');
        throw error;
      }
    } else {
      const transactionColumns = this.sqlite.all<{ name: string }>('PRAGMA table_xinfo(transactions)');
      if (!transactionColumns.some((column) => column.name === 'search_text')) {
        this.sqlite.run(`ALTER TABLE transactions ADD COLUMN search_text TEXT
          GENERATED ALWAYS AS (${searchTextExpression}) VIRTUAL`);
      }
      this.sqlite.run(`CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts USING fts5(
        search_text, content='transactions', content_rowid='rowid', tokenize='trigram', detail='none'
      )`);
      this.sqlite.run(`CREATE TRIGGER IF NOT EXISTS transactions_fts_ai AFTER INSERT ON transactions BEGIN
        INSERT INTO transactions_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
      END`);
      this.sqlite.run(`CREATE TRIGGER IF NOT EXISTS transactions_fts_ad AFTER DELETE ON transactions BEGIN
        INSERT INTO transactions_fts(transactions_fts, rowid, search_text)
        VALUES ('delete', old.rowid, old.search_text);
      END`);
      this.sqlite.run(`CREATE TRIGGER IF NOT EXISTS transactions_fts_au AFTER UPDATE ON transactions BEGIN
        INSERT INTO transactions_fts(transactions_fts, rowid, search_text)
        VALUES ('delete', old.rowid, old.search_text);
        INSERT INTO transactions_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
      END`);
    }
    this.sqlite.run(
      `INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
       VALUES (1, 'transaction-query-indexes', '${new Date().toISOString()}')`,
    );
    this.sqlite.run(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (5, ?, ?)',
      ['covering-ledger-summary-indexes', new Date().toISOString()],
    );
    this.sqlite.run(
      'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (6, ?, ?)',
      ['keyset-paginated-deleted-transaction-bin', new Date().toISOString()],
    );

    const salSql = String(this.sqlite.scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'salary_payments'") || '');
    if (salSql.includes('UNIQUE(employee_id, month_key)')) {
      this.sqlite.run(`
        CREATE TABLE salary_payments_migrated (
          id TEXT PRIMARY KEY,
          employee_id TEXT NOT NULL,
          employee_name TEXT NOT NULL,
          month_key TEXT NOT NULL,
          paid_date TEXT NOT NULL,
          base_salary_paisa INTEGER NOT NULL,
          bonus_paisa INTEGER NOT NULL DEFAULT 0,
          loan_deduction_paisa INTEGER NOT NULL DEFAULT 0,
          advance_deduction_paisa INTEGER NOT NULL DEFAULT 0,
          other_deduction_paisa INTEGER NOT NULL DEFAULT 0,
          net_paid_paisa INTEGER NOT NULL,
          payment_method TEXT NOT NULL,
          reference_no TEXT DEFAULT '',
          department TEXT DEFAULT '',
          head TEXT NOT NULL,
          fund_source_id TEXT DEFAULT '',
          notes TEXT DEFAULT '',
          receipt_sha TEXT DEFAULT '',
          receipt_name TEXT DEFAULT '',
          receipt_type TEXT DEFAULT '',
          linked_tx_id TEXT DEFAULT '',
          linked_voucher_no TEXT DEFAULT '',
          paid_by_id TEXT NOT NULL,
          paid_by_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      this.sqlite.run(`
        INSERT INTO salary_payments_migrated (
          id, employee_id, employee_name, month_key, paid_date, base_salary_paisa, bonus_paisa,
          loan_deduction_paisa, advance_deduction_paisa, other_deduction_paisa, net_paid_paisa,
          payment_method, reference_no, department, head, fund_source_id, notes, receipt_sha,
          receipt_name, receipt_type, linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
        )
        SELECT id, employee_id, employee_name, month_key, paid_date, base_salary_paisa, bonus_paisa,
          loan_deduction_paisa, COALESCE(advance_deduction_paisa, 0), other_deduction_paisa, net_paid_paisa,
          payment_method, reference_no, head, head, COALESCE(fund_source_id, ''), notes, COALESCE(receipt_sha, ''),
          COALESCE(receipt_name, ''), COALESCE(receipt_type, ''), linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
        FROM salary_payments
      `);
      this.sqlite.run('DROP TABLE salary_payments');
      this.sqlite.run('ALTER TABLE salary_payments_migrated RENAME TO salary_payments');
      this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_sal_month ON salary_payments(month_key DESC)');
      this.sqlite.run('CREATE INDEX IF NOT EXISTS idx_sal_emp_month ON salary_payments(employee_id, month_key)');
    }

    const salCols = new Set(this.sqlite.all<{ name: string }>('PRAGMA table_info(salary_payments)').map((c) => c.name));
    if (!salCols.has('advance_deduction_paisa')) this.sqlite.run('ALTER TABLE salary_payments ADD COLUMN advance_deduction_paisa INTEGER NOT NULL DEFAULT 0');
    if (!salCols.has('fund_source_id')) this.sqlite.run("ALTER TABLE salary_payments ADD COLUMN fund_source_id TEXT DEFAULT ''");
    if (!salCols.has('department')) this.sqlite.run("ALTER TABLE salary_payments ADD COLUMN department TEXT DEFAULT ''");
    if (!salCols.has('receipt_sha')) this.sqlite.run("ALTER TABLE salary_payments ADD COLUMN receipt_sha TEXT DEFAULT ''");
    if (!salCols.has('receipt_name')) this.sqlite.run("ALTER TABLE salary_payments ADD COLUMN receipt_name TEXT DEFAULT ''");
    if (!salCols.has('receipt_type')) this.sqlite.run("ALTER TABLE salary_payments ADD COLUMN receipt_type TEXT DEFAULT ''");

    const advCols = new Set(this.sqlite.all<{ name: string }>('PRAGMA table_info(employee_advances)').map((c) => c.name));
    if (!advCols.has('month_key')) this.sqlite.run("ALTER TABLE employee_advances ADD COLUMN month_key TEXT DEFAULT ''");
    if (!advCols.has('department')) this.sqlite.run("ALTER TABLE employee_advances ADD COLUMN department TEXT DEFAULT ''");
    this.sqlite.run("UPDATE employee_advances SET month_key = substr(issued_date, 1, 7) WHERE COALESCE(month_key, '') = '' AND length(issued_date) >= 7");

    const loanCols = new Set(this.sqlite.all<{ name: string }>('PRAGMA table_info(employee_loans)').map((c) => c.name));
    if (!loanCols.has('fund_source_id')) this.sqlite.run("ALTER TABLE employee_loans ADD COLUMN fund_source_id TEXT DEFAULT ''");
    if (!loanCols.has('department')) this.sqlite.run("ALTER TABLE employee_loans ADD COLUMN department TEXT DEFAULT ''");
    if (!loanCols.has('receipt_sha')) this.sqlite.run("ALTER TABLE employee_loans ADD COLUMN receipt_sha TEXT DEFAULT ''");
    if (!loanCols.has('receipt_name')) this.sqlite.run("ALTER TABLE employee_loans ADD COLUMN receipt_name TEXT DEFAULT ''");
    if (!loanCols.has('receipt_type')) this.sqlite.run("ALTER TABLE employee_loans ADD COLUMN receipt_type TEXT DEFAULT ''");

    const repayCols = new Set(this.sqlite.all<{ name: string }>('PRAGMA table_info(loan_repayments)').map((c) => c.name));
    if (!repayCols.has('fund_source_id')) this.sqlite.run("ALTER TABLE loan_repayments ADD COLUMN fund_source_id TEXT DEFAULT ''");
    if (!repayCols.has('department')) this.sqlite.run("ALTER TABLE loan_repayments ADD COLUMN department TEXT DEFAULT ''");
    if (!repayCols.has('salary_payment_id')) this.sqlite.run("ALTER TABLE loan_repayments ADD COLUMN salary_payment_id TEXT DEFAULT ''");
    if (!repayCols.has('receipt_sha')) this.sqlite.run("ALTER TABLE loan_repayments ADD COLUMN receipt_sha TEXT DEFAULT ''");
    if (!repayCols.has('receipt_name')) this.sqlite.run("ALTER TABLE loan_repayments ADD COLUMN receipt_name TEXT DEFAULT ''");
    if (!repayCols.has('receipt_type')) this.sqlite.run("ALTER TABLE loan_repayments ADD COLUMN receipt_type TEXT DEFAULT ''");
  }

  private insertDefaultDepartmentsInsideTx() {
    for (const d of DEFAULT_DEPARTMENTS) {
      this.sqlite.run(
        'INSERT OR IGNORE INTO departments (id, name, description, active, sort_order) VALUES (?, ?, ?, 1, ?)',
        [crypto.randomUUID(), d.name, d.description, d.sortOrder],
      );
    }
  }

  private seedDefaultDepartments() {
    const count = Number(this.sqlite.scalar('SELECT COUNT(*) FROM departments') || 0);
    if (count > 0) return;
    this.transaction(() => {
      this.insertDefaultDepartmentsInsideTx();
    });
  }

  private insertDefaultHeadsInsideTx() {
    for (const h of [...DEFAULT_INCOME_HEADS, ...DEFAULT_EXPENSE_HEADS]) {
      this.sqlite.run(
        'INSERT OR IGNORE INTO ledger_heads (id, kind, name, description, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), h.kind, h.name, h.description || '', h.active ? 1 : 0, h.sortOrder],
      );
    }
  }

  private seedDefaultHeads() {
    const count = Number(this.sqlite.scalar('SELECT COUNT(*) FROM ledger_heads') || 0);
    if (count > 0) return;
    this.transaction(() => {
      this.insertDefaultHeadsInsideTx();
    });
  }

  private seedDefaultFundSources() {
    const now = new Date().toISOString();
    this.transaction(() => {
      for (const name of ['Boss', 'Company Revenue', 'Other Income']) {
        this.sqlite.run(
          'INSERT OR IGNORE INTO fund_sources (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
          [crypto.randomUUID(), name, now, now],
        );
      }
      const hasUnassignedTransactions = Number(this.sqlite.scalar(
        "SELECT COUNT(*) FROM transactions WHERE COALESCE(fund_source_id, '') = ''",
      ) || 0) > 0;
      if (hasUnassignedTransactions) {
        this.sqlite.run(
          "INSERT OR IGNORE INTO fund_sources (id, name, active, created_at, updated_at) VALUES ('legacy-unassigned', 'Legacy Unassigned', 0, ?, ?)",
          [now, now],
        );
        this.sqlite.run(
          "UPDATE transactions SET fund_source_id = 'legacy-unassigned' WHERE COALESCE(fund_source_id, '') = ''",
        );
      }
      this.sqlite.run(
        "UPDATE salary_payments SET fund_source_id = (SELECT fund_source_id FROM transactions WHERE transactions.id = salary_payments.linked_tx_id) WHERE COALESCE(fund_source_id, '') = '' AND COALESCE(linked_tx_id, '') != ''",
      );
      this.sqlite.run(
        "UPDATE employee_loans SET fund_source_id = (SELECT fund_source_id FROM transactions WHERE transactions.id = employee_loans.linked_tx_id) WHERE COALESCE(fund_source_id, '') = '' AND COALESCE(linked_tx_id, '') != ''",
      );
      this.sqlite.run(
        "UPDATE loan_repayments SET fund_source_id = (SELECT fund_source_id FROM transactions WHERE transactions.id = loan_repayments.linked_tx_id) WHERE COALESCE(fund_source_id, '') = '' AND COALESCE(linked_tx_id, '') != ''",
      );
    });
  }

  getFundSources(): FundSource[] {
    return this.sqlite.all<any>(
      `SELECT fs.id, fs.name, fs.active, fs.created_at, fs.updated_at,
        COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount_paisa ELSE 0 END), 0) AS income_paisa,
        COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_paisa ELSE 0 END), 0) AS spent_paisa,
        COUNT(t.id) AS transaction_count
       FROM fund_sources fs
       LEFT JOIN transactions t ON t.fund_source_id = fs.id AND t.deleted_at = ''
       GROUP BY fs.id
       ORDER BY fs.active DESC, fs.name COLLATE NOCASE ASC`,
    ).map((r) => {
      const incomePaisa = Number(r.income_paisa || 0);
      const spentPaisa = Number(r.spent_paisa || 0);
      return {
        id: String(r.id),
        name: String(r.name),
        active: Boolean(r.active),
        incomePaisa,
        spentPaisa,
        balancePaisa: incomePaisa - spentPaisa,
        transactionCount: Number(r.transaction_count || 0),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      };
    });
  }

  private getFundSourceById(id: string): { id: string; name: string; active: boolean } | null {
    const row = this.sqlite.get<any>('SELECT id, name, active FROM fund_sources WHERE id = ?', [id]);
    return row ? { id: String(row.id), name: String(row.name), active: Boolean(row.active) } : null;
  }

  private fundSourceBalance(sourceId: string, excludeTxId = ''): number {
    return Number(this.sqlite.scalar(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_paisa ELSE -amount_paisa END), 0)
       FROM transactions WHERE fund_source_id = ? AND deleted_at = '' AND id != ?`,
      [sourceId, excludeTxId],
    ) || 0);
  }

  private assertFundSource(sourceId: string): { id: string; name: string; active: boolean } {
    const source = this.getFundSourceById(sourceId);
    if (!source || !source.active) throw new Error('Selected fund source is unavailable.');
    return source;
  }

  private assertFundSourceBalance(sourceId: string, amountPaisa: number, excludeTxId = '') {
    const source = this.assertFundSource(sourceId);
    const balance = this.fundSourceBalance(sourceId, excludeTxId);
    if (amountPaisa > balance) {
      throw new Error(`${source.name} has insufficient funds. Available balance: ৳${fromPaisa(balance)}.`);
    }
  }

  createFundSource(nameInput: string): FundSource {
    const name = String(nameInput || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) throw new Error('Fund source name must contain at least 2 characters.');
    const existing = this.sqlite.get<{ id: string }>('SELECT id FROM fund_sources WHERE name = ? COLLATE NOCASE', [name]);
    if (existing) throw new Error('A fund source with this name already exists.');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.sqlite.run(
      'INSERT INTO fund_sources (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      [id, name, now, now],
    );
    this.notify('fundSources');
    return this.getFundSources().find((source) => source.id === id)!;
  }

  updateFundSource(id: string, input: { name?: string; active?: boolean }): FundSource {
    const existing = this.getFundSourceById(id);
    if (!existing) throw new Error('Fund source not found.');
    const name = input.name === undefined ? existing.name : String(input.name).trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) throw new Error('Fund source name must contain at least 2 characters.');
    const duplicate = this.sqlite.get<{ id: string }>(
      'SELECT id FROM fund_sources WHERE name = ? COLLATE NOCASE AND id != ?',
      [name, id],
    );
    if (duplicate) throw new Error('A fund source with this name already exists.');
    const active = input.active === undefined ? existing.active : input.active;
    this.sqlite.run('UPDATE fund_sources SET name = ?, active = ?, updated_at = ? WHERE id = ?', [name, active ? 1 : 0, new Date().toISOString(), id]);
    this.notify('fundSources');
    return this.getFundSources().find((source) => source.id === id)!;
  }

  // Transactions can nest: only the outermost call begins/commits/rolls back, so a caller
  // (such as the Excel import) can wrap many audited operations into one all-or-nothing unit.
  private txDepth = 0;

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try { return fn(); } finally { this.txDepth--; }
    }
    this.sqlite.run('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const res = fn();
      this.sqlite.run('COMMIT');
      return res;
    } catch (err) {
      try { this.sqlite.run('ROLLBACK'); } catch {   }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  /** True when records tagged with this import batch already exist (guards double import). */
  isImportBatchPresent(tag: string): boolean {
    const like = `%${tag}%`;
    for (const table of ['transactions', 'employees', 'rent_items']) {
      const col = table === 'transactions' ? 'notes' : 'notes';
      const hit = this.sqlite.get<any>(`SELECT 1 AS x FROM ${table} WHERE ${col} LIKE ? LIMIT 1`, [like]);
      if (hit) return true;
    }
    return false;
  }

  flush() {
     
  }

  getMaintenance(): MaintenanceInfo | null {
    if (Date.now() - this.maintenanceCheckedAt > 300) {
      this.maintenance = readMaintenance(DB_DIR);
      this.maintenanceCheckedAt = Date.now();
    }
    return this.maintenance;
  }

  private notify(type: string, payload?: unknown) {
    this.emit('change', { type, payload, timestamp: new Date().toISOString() });
  }

   

  needsSetup(): boolean {
    return Number(this.sqlite.scalar('SELECT COUNT(*) FROM users') || 0) === 0;
  }

  bootstrapFirstAdmin(input: {
    username: string;
    displayName: string;
    password: string;
    loadSampleData?: boolean;
  }): AppUser {
    const username = String(input.username || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      throw new Error('Username must be 3–32 characters (letters, numbers, _, ., -).');
    }
    const prob = passwordProblem(input.password, username);
    if (prob) throw new Error(prob);
    const displayName = String(input.displayName || username).trim().slice(0, 80) || username;

    const user = this.transaction(() => {
      const count = Number(this.sqlite.scalar('SELECT COUNT(*) FROM users') || 0);
      if (count > 0) throw new Error('Setup has already been completed.');
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.sqlite.run(
        'INSERT INTO users (id, username, display_name, password, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
        [id, username, displayName, hashPassword(input.password), 'admin', now],
      );
      if (input.loadSampleData) {
        this.seedSampleNovemberData(id, displayName);
      }
      return {
        id,
        username,
        displayName,
        role: 'admin' as const,
        phoneNumber: '',
        email: '',
        photoUrl: '',
        disabled: false,
        createdAt: now,
      };
    });

    this.notify('users');
    if (input.loadSampleData) {
      this.notify('transactions');
        this.notify('employees');
      this.notify('salaries');
      this.notify('loans');
    }
    return user;
  }

  private seedSampleNovemberData(adminId: string, adminName: string) {
    const mgrName = 'Accounts Manager';
    const now = new Date().toISOString();

    const employeesSeed = [
      { code: 'EMP-001', name: 'Tariqul Islam', role: 'Field Installation Lead', department: 'Field Operations', branch: 'EDC-PROJECT', phone: '01711-220101', salary: 3000000, joined: '2024-03-01' },
      { code: 'EMP-002', name: 'Rafiq Ahmed', role: 'Senior Fiber Splicer', department: 'Network Maintenance', branch: 'ALHAMRA-OFFICE', phone: '01712-330202', salary: 2200000, joined: '2024-06-15' },
      { code: 'EMP-003', name: 'Kamrul Hasan', role: 'Support Engineer', department: 'Branch Support', branch: 'BALUCHOR-OFFICE', phone: '01713-440303', salary: 1800000, joined: '2025-01-10' },
      { code: 'EMP-004', name: 'Nayeem Chowdhury', role: 'Line Technician', department: 'Field Operations', branch: 'SHIBGONJ-OFFICE', phone: '01714-550404', salary: 1600000, joined: '2025-04-01' },
      { code: 'EMP-005', name: 'Sohel Rana', role: 'POP Technician', department: 'POP Operations', branch: 'DASPARA-OFFICE', phone: '01715-660505', salary: 1500000, joined: '2025-07-01' },
      { code: 'EMP-006', name: 'Farhana Akter', role: 'Billing & Desk Executive', department: 'Accounts & Billing', branch: 'SUBID-BAZAR-OFFICE', phone: '01716-770606', salary: 1800000, joined: '2024-11-01' },
    ];

    const empIds: Record<string, string> = {};
    for (const emp of employeesSeed) {
      const id = crypto.randomUUID();
      empIds[emp.code] = id;
      this.sqlite.run(
        `INSERT INTO employees (id, code, name, role, department, branch, phone, email, photo_url, monthly_salary_paisa, joined_date, active, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, 1, '', ?, ?)`,
        [id, emp.code, emp.name, emp.role, emp.department, emp.branch, emp.phone, emp.salary, emp.joined, now, now],
      );
    }

    const addTx = (params: {
      voucherNo: string;
      kind: 'income' | 'expense';
      txDate: string;
      amountPaisa: number;
      department: string;
      head: string;
      subCategory: string;
      paymentMethod: string;
      referenceNo: string;
      counterparty: string;
      purpose: string;
      notes?: string;
      createdByName: string;
      employeeId?: string;
      employeeName?: string;
      categoryGroup?: TxCategoryGroup;
      editHistory?: TxEditEntry[];
      editCount?: number;
      amountChanged?: boolean;
      lastEditedAt?: string;
      lastEditedBy?: string;
      lastEditReason?: string;
      status?: 'verified' | 'pending_review' | 'flagged';
      fundSourceId: string;
    }) => {
      const id = crypto.randomUUID();
      const history = params.editHistory || [];
      this.sqlite.run(
        `INSERT INTO transactions (
          id, voucher_no, kind, tx_date, amount_paisa, department, department_review, head, sub_category, payment_method, reference_no,
          counterparty, counterparty_phone, purpose, notes, funded_by_tx_id,
          employee_id, employee_name, category_group, fund_source_id,
          receipt_sha, receipt_name, receipt_type, status, verified_by_name, verified_at, flag_note,
          edit_count, amount_changed, last_edited_at, last_edited_by, last_edit_reason, edit_history_json,
          created_at, created_by_id, created_by_name, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, '', ?, ?, '', ?, ?, ?, ?, '', '', '', ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          params.voucherNo,
          params.kind,
          params.txDate,
          params.amountPaisa,
          params.department,
          params.head,
          params.subCategory,
          params.paymentMethod,
          params.referenceNo,
          params.counterparty,
          params.purpose,
          params.notes || '',
          params.employeeId || '',
          params.employeeName || '',
          params.categoryGroup || 'general',
          params.fundSourceId,
          params.status || 'verified',
          adminName,
          now,
          params.editCount || 0,
          params.amountChanged ? 1 : 0,
          params.lastEditedAt || '',
          params.lastEditedBy || '',
          params.lastEditReason || '',
          JSON.stringify(history),
          `${params.txDate}T09:30:00.000Z`,
          adminId,
          params.createdByName,
          now,
        ],
      );
      const tx = this.getTransactionById(id)!;
      this.appendAudit({
        actorId: adminId,
        actorName: params.createdByName,
        actorRole: 'admin',
        eventType: 'tx_created',
        entryId: id,
        voucherNo: params.voucherNo,
        reason: 'Initial verified ledger entry',
        diff: [],
        amountDeltaPaisa: params.kind === 'income' ? params.amountPaisa : -params.amountPaisa,
        afterSnapshotJson: txSnapshotForAudit(tx),
      });
      if (params.editHistory && params.editHistory.length > 0) {
        const last = params.editHistory[params.editHistory.length - 1];
        this.appendAudit({
          actorId: adminId,
          actorName: last.byName,
          actorRole: last.byRole,
          eventType: 'tx_edited',
          entryId: id,
          voucherNo: params.voucherNo,
          reason: last.reason,
          diff: last.changes,
          amountDeltaPaisa: last.amountDeltaPaisa || 0,
          afterSnapshotJson: txSnapshotForAudit(tx),
        });
      }
      return id;
    };

    addTx({
      voucherNo: 'INC-2026-0001',
      kind: 'income',
      txDate: '2026-10-31',
      amountPaisa: 7400,
      department: 'ALHAMRA-OFFICE',
      head: 'OWNER-CASH',
      subCategory: 'Cash Float Return',
      paymentMethod: 'Cash in Hand',
      referenceNo: 'OCT-CLOSE',
      counterparty: 'Opening Cash Register',
      purpose: 'October 2026 closing cash carry-forward to November 2026',
      createdByName: adminName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Boss')!.id,
    });

    addTx({
      voucherNo: 'INC-2026-0002',
      kind: 'income',
      txDate: '2026-11-02',
      amountPaisa: 16750000,
      department: 'UPSTREAM',
      head: 'BRAC-BANK-TRANSFER',
      subCategory: 'Upstream Bill Coverage',
      paymentMethod: 'BRAC Bank Transfer',
      referenceNo: 'EFT-994821',
      counterparty: 'Pace IT Corporate Treasury',
      purpose: 'Upstream & field contractor advance',
      createdByName: adminName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Company Revenue')!.id,
    });

    addTx({
      voucherNo: 'INC-2026-0003',
      kind: 'income',
      txDate: '2026-11-05',
      amountPaisa: 40000000,
      department: 'ALHAMRA-OFFICE',
      head: 'BRAC-BANK-ATM',
      subCategory: 'Company Fund Transfer',
      paymentMethod: 'BRAC Bank ATM',
      referenceNo: 'ATM-220419',
      counterparty: 'Pace IT Corporate A/C (BRAC ATM)',
      purpose: 'First week ATM withdrawal allocation for field projects & branch offices',
      createdByName: adminName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Company Revenue')!.id,
    });
    addTx({
      voucherNo: 'INC-2026-0004',
      kind: 'income',
      txDate: '2026-11-12',
      amountPaisa: 37200000,
      department: 'EDC-PROJECT',
      head: 'BRAC-BANK-ATM',
      subCategory: 'Field Project Advance',
      paymentMethod: 'BRAC Bank ATM',
      referenceNo: 'ATM-221985',
      counterparty: 'Pace IT Corporate A/C (BRAC ATM)',
      purpose: 'Mid-month ATM replenishment for field teams & router vendor bills',
      createdByName: adminName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Company Revenue')!.id,
    });
    addTx({
      voucherNo: 'INC-2026-0005',
      kind: 'income',
      txDate: '2026-11-08',
      amountPaisa: 35000000,
      department: 'OWNER',
      head: 'OWNER-CASH',
      subCategory: 'Operating Budget Top-up',
      paymentMethod: 'Cash in Hand',
      referenceNo: 'CASH-RCV-018',
      counterparty: 'Owner / Managing Director',
      purpose: 'Direct cash handed to accounts desk for branch salaries & rent',
      createdByName: adminName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Boss')!.id,
    });
    addTx({
      voucherNo: 'INC-2026-0006',
      kind: 'income',
      txDate: '2026-11-18',
      amountPaisa: 33100000,
      department: 'OWNER',
      head: 'OWNER-CASH',
      subCategory: 'Field Project Advance',
      paymentMethod: 'Cash in Hand',
      referenceNo: 'CASH-RCV-027',
      counterparty: 'Owner / Managing Director',
      purpose: 'Second cash tranche for fiber installations & vendor settlements',
      createdByName: adminName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Boss')!.id,
    });
    addTx({
      voucherNo: 'INC-2026-0007',
      kind: 'income',
      txDate: '2026-11-20',
      amountPaisa: 500000,
      department: 'OTHERS-COMPANY',
      head: 'NETWORK-BAZAR',
      subCategory: 'Client / Partner Collection',
      paymentMethod: 'Cash in Hand',
      referenceNo: 'NB-772',
      counterparty: 'Network Bazar',
      purpose: 'Shared equipment settlement received from Network Bazar',
      createdByName: mgrName,
      fundSourceId: this.getFundSources().find((source) => source.name === 'Company Revenue')!.id,
    });

    const sampleExpenses: {
      v: string; date: string; amount: number; head: string; sub: string; method: string; ref: string;
      to: string; why: string; empCode?: string; edited?: boolean;
    }[] = [
      { v: 'EXP-2026-0001', date: '2026-11-03', amount: 18616000, head: 'ALHAMRA-OFFICE', sub: 'Office Rent & Service Charge', method: 'Cash in Hand', ref: 'ALH-1103', to: 'Alhamra HQ Landlord & Admin', why: 'HQ office rent, utility & daily admin expenses' },
      { v: 'EXP-2026-0002', date: '2026-11-04', amount: 4200000, head: 'ALHAMRA-OFFICE', sub: 'Fiber, ONU & Router Hardware', method: 'Cash in Hand', ref: 'ALH-1104', to: 'Rafiq Ahmed', why: 'HQ fiber splice cassettes, patch cords & maintenance tools', empCode: 'EMP-002' },
      { v: 'EXP-2026-0003', date: '2026-11-04', amount: 3662500, head: 'BALUCHOR-OFFICE', sub: 'Office Rent & Service Charge', method: 'Cash in Hand', ref: 'BAL-1104', to: 'Baluchor Branch Caretaker', why: 'Branch monthly rent, electricity & consumables' },
      { v: 'EXP-2026-0004', date: '2026-11-05', amount: 2600000, head: 'BALUCHOR-OFFICE', sub: 'Field Work & Installations', method: 'Cash in Hand', ref: 'BAL-1105', to: 'Kamrul Hasan', why: 'Baluchor branch POP battery & distribution box upgrade', empCode: 'EMP-003' },
      { v: 'EXP-2026-0005', date: '2026-11-06', amount: 2959000, head: 'SHIBGONJ-OFFICE', sub: 'Office Rent & Service Charge', method: 'Cash in Hand', ref: 'SHB-1106', to: 'Shibgonj Branch Landlord', why: 'Branch office rent, utility & support conveyance' },
      { v: 'EXP-2026-0006', date: '2026-11-06', amount: 1600000, head: 'SHIBGONJ-OFFICE', sub: 'Field Work & Installations', method: 'Cash in Hand', ref: 'SHB-1106B', to: 'Nayeem Chowdhury', why: 'Shibgonj drop-fiber & subscriber installation kits', empCode: 'EMP-004' },
      { v: 'EXP-2026-0007', date: '2026-11-07', amount: 4258500, head: 'DASPARA-OFFICE', sub: 'Office Rent & Service Charge', method: 'Cash in Hand', ref: 'DAS-1107', to: 'Daspara Branch Operations', why: 'POP rent, backup battery maintenance & local bills' },
      { v: 'EXP-2026-0008', date: '2026-11-07', amount: 1500000, head: 'DASPARA-OFFICE', sub: 'Maintenance & Repair', method: 'Cash in Hand', ref: 'DAS-1108', to: 'Sohel Rana', why: 'Daspara OLT power backup & inverter maintenance', empCode: 'EMP-005' },
      { v: 'EXP-2026-0009', date: '2026-11-09', amount: 350000, head: 'BOTESSOR-OFFICE', sub: 'Electricity, Water & Gas', method: 'bKash / Nagad', ref: 'BOT-1109', to: 'PDB Botessor Meter', why: 'Botessor POP electricity bill & minor upkeep' },
      { v: 'EXP-2026-0010', date: '2026-11-11', amount: 7496100, head: 'SUBID-BAZAR-OFFICE', sub: 'Office Rent & Service Charge', method: 'Cash in Hand', ref: 'SUB-1111', to: 'Subid Bazar Branch Office', why: 'Branch rent & fiber splice consumables' },
      { v: 'EXP-2026-0011', date: '2026-11-11', amount: 1800000, head: 'SUBID-BAZAR-OFFICE', sub: 'Electricity, Water & Gas', method: 'Cash in Hand', ref: 'SUB-1112', to: 'Farhana Akter', why: 'Subid Bazar branch utility, internet desk & stationery', empCode: 'EMP-006' },
      { v: 'EXP-2026-0012', date: '2026-11-14', amount: 48500000, head: 'EDC-PROJECT', sub: 'Fiber, ONU & Router Hardware', method: 'BRAC Bank Transfer', ref: 'EDC-INV-441', to: 'Dhaka Optical & Router Suppliers', why: 'Bulk ONU, fiber drum & TJ box procurement for regional network' },
      { v: 'EXP-2026-0013', date: '2026-11-16', amount: 25490000, head: 'EDC-PROJECT', sub: 'Field Work & Installations', method: 'Cash in Hand', ref: 'EDC-FLD-458', to: 'Tariqul Islam (Field Team)', why: 'Field fiber installation bills across regional zones', empCode: 'EMP-001', edited: true },
      { v: 'EXP-2026-0014', date: '2026-11-18', amount: 8500000, head: 'EDC-PROJECT', sub: 'Field Work & Installations', method: 'Cash in Hand', ref: 'EDC-FLD-462', to: 'Tariqul Islam', why: 'Field team transport, splicing consumables & regional civil work', empCode: 'EMP-001' },
      { v: 'EXP-2026-0015', date: '2026-11-19', amount: 24672500, head: 'OTHERS-COMPANY', sub: 'Vendor / Company Payment', method: 'BRAC Bank Transfer', ref: 'VND-883', to: 'Partner Supply & Contractor Co.', why: 'Third-party splicing equipment & hardware invoice settlement' },
      { v: 'EXP-2026-0016', date: '2026-11-21', amount: 1306000, head: 'UPSTREAM', sub: 'Internet & Upstream Bill', method: 'BRAC Bank Transfer', ref: 'UPS-9012', to: 'Summit / Fiber@Home Upstream', why: 'Monthly upstream bandwidth & transit settlement' },
      { v: 'EXP-2026-0017', date: '2026-11-23', amount: 5029000, head: 'OWNER', sub: 'Owner Settlement', method: 'Cash in Hand', ref: 'OWN-031', to: 'Owner / MD Capital Account', why: 'Owner expense reimbursement & capital settlement' },
    ];

    const companyExpenseIndexes = new Set([4, 7, 9, 11, 12, 13]);
    const companyFundSourceId = this.getFundSources().find((source) => source.name === 'Company Revenue')!.id;
    const bossFundSourceId = this.getFundSources().find((source) => source.name === 'Boss')!.id;
    for (const [index, e] of sampleExpenses.entries()) {
      const emp = e.empCode ? employeesSeed.find((x) => x.code === e.empCode) : undefined;
      const editHistory: TxEditEntry[] = e.edited
        ? [{
            at: '2026-11-17T11:20:00.000Z',
            byId: adminId,
            byName: mgrName,
            byRole: 'user',
            reason: 'Added 2 extra zone splice bills submitted late by field crew',
            amountDeltaPaisa: 1490000,
            changes: [
              { field: 'amount', from: '৳240,000.00', to: '৳254,900.00' },
              { field: 'referenceNo', from: 'EDC-FLD-450', to: 'EDC-FLD-458' },
            ],
          }]
        : [];
      addTx({
        voucherNo: e.v,
        kind: 'expense',
        txDate: e.date,
        amountPaisa: e.amount,
        department: e.head,
        head: e.head,
        subCategory: e.sub,
        paymentMethod: e.method,
        referenceNo: e.ref,
        counterparty: e.to,
        purpose: e.why,
        createdByName: mgrName,
        employeeId: e.empCode ? empIds[e.empCode] : undefined,
        employeeName: emp?.name,
        categoryGroup: 'general',
        fundSourceId: companyExpenseIndexes.has(index) ? companyFundSourceId : bossFundSourceId,
        editHistory,
        editCount: editHistory.length,
        amountChanged: Boolean(e.edited),
        lastEditedAt: e.edited ? '2026-11-17T11:20:00.000Z' : '',
        lastEditedBy: e.edited ? mgrName : '',
        lastEditReason: e.edited ? editHistory[0].reason : '',
        status: e.edited ? 'flagged' : 'verified',
      });
    }

    const novSalaries = [
      { code: 'EMP-001', date: '2026-11-18', ref: 'SAL-11-001', head: 'EDC-PROJECT', amount: 3000000 },
      { code: 'EMP-002', date: '2026-11-03', ref: 'SAL-11-002', head: 'ALHAMRA-OFFICE', amount: 2200000 },
      { code: 'EMP-003', date: '2026-11-04', ref: 'SAL-11-003', head: 'BALUCHOR-OFFICE', amount: 1800000 },
      { code: 'EMP-004', date: '2026-11-06', ref: 'SAL-11-004', head: 'SHIBGONJ-OFFICE', amount: 1600000 },
      { code: 'EMP-005', date: '2026-11-07', ref: 'SAL-11-005', head: 'DASPARA-OFFICE', amount: 1500000 },
      { code: 'EMP-006', date: '2026-11-11', ref: 'SAL-11-006', head: 'SUBID-BAZAR-OFFICE', amount: 1800000 },
    ];
    for (const s of novSalaries) {
      const emp = employeesSeed.find((x) => x.code === s.code)!;
      this.sqlite.run(
        `INSERT INTO salary_payments (
          id, employee_id, employee_name, month_key, paid_date, base_salary_paisa, bonus_paisa,
          loan_deduction_paisa, other_deduction_paisa, net_paid_paisa, payment_method, reference_no,
          department, head, notes, linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
        ) VALUES (?, ?, ?, '2026-11', ?, ?, 0, 0, 0, ?, 'Cash in Hand', ?, ?, ?, 'November 2026 payroll', '', '', ?, ?, ?)`,
        [crypto.randomUUID(), empIds[s.code], emp.name, s.date, s.amount, s.amount, s.ref, s.head, s.head, adminId, adminName, now],
      );
    }

    this.sqlite.run(
      `INSERT INTO employee_loans (
        id, loan_no, employee_id, employee_name, issued_date, principal_paisa, remaining_paisa,
        monthly_installment_paisa, payment_method, reference_no, department, head, purpose, status,
        linked_tx_id, linked_voucher_no, issued_by_id, issued_by_name, created_at
      ) VALUES (?, 'LN-2026-0001', ?, 'Rafiq Ahmed', '2026-11-04', 2000000, 2000000, 500000, 'Cash in Hand', 'LN-2026-0001',
        'ALHAMRA-OFFICE', 'ALHAMRA-OFFICE', 'Family medical loan (repayable separately)', 'active', '', '', ?, ?, ?)`,
      [crypto.randomUUID(), empIds['EMP-002'], adminId, adminName, now],
    );
    this.sqlite.run(
      `INSERT INTO employee_loans (
        id, loan_no, employee_id, employee_name, issued_date, principal_paisa, remaining_paisa,
        monthly_installment_paisa, payment_method, reference_no, department, head, purpose, status,
        linked_tx_id, linked_voucher_no, issued_by_id, issued_by_name, created_at
      ) VALUES (?, 'LN-2026-0002', ?, 'Kamrul Hasan', '2026-11-05', 800000, 800000, 200000, 'Cash in Hand', 'LN-2026-0002',
        'BALUCHOR-OFFICE', 'BALUCHOR-OFFICE', 'Personal emergency loan', 'active', '', '', ?, ?, ?)`,
      [crypto.randomUUID(), empIds['EMP-003'], adminId, adminName, now],
    );
  }

  private appendAudit(entry: {
    actorId: string;
    actorName: string;
    actorRole: string;
    eventType: string;
    entryId: string;
    voucherNo: string;
    reason: string;
    diff: FieldDiff[];
    amountDeltaPaisa: number;
    afterSnapshotJson: string;
  }) {
    const last = this.sqlite.get<{ seq: number; entry_hash: string }>(
      'SELECT seq, entry_hash FROM ledger_audit ORDER BY seq DESC LIMIT 1',
    );
    const seq = (last?.seq || 0) + 1;
    const prevHash = last?.entry_hash || 'GENESIS_PACE_IT_LEDGER';
    const at = new Date().toISOString();
    const diffJson = JSON.stringify(entry.diff || []);
    const entryHash = computeAuditHash({
      seq,
      at,
      actorId: entry.actorId,
      eventType: entry.eventType,
      entryId: entry.entryId,
      voucherNo: entry.voucherNo,
      reason: entry.reason,
      diffJson,
      amountDeltaPaisa: entry.amountDeltaPaisa,
      afterSnapshotJson: entry.afterSnapshotJson,
      prevHash,
    });
    this.sqlite.run(
      `INSERT INTO ledger_audit (
        seq, at, actor_id, actor_name, actor_role, event_type, entry_id, voucher_no,
        reason, diff_json, amount_delta_paisa, after_snapshot_json, prev_hash, entry_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seq,
        at,
        entry.actorId,
        entry.actorName,
        entry.actorRole,
        entry.eventType,
        entry.entryId,
        entry.voucherNo,
        entry.reason,
        diffJson,
        entry.amountDeltaPaisa,
        entry.afterSnapshotJson,
        prevHash,
        entryHash,
      ],
    );
  }

  private logActivity(by: string, action: string, voucherNo = '', head = '', amountPaisa = 0, detail = '') {
    this.sqlite.run(
      'INSERT INTO activity (id, at, by_user, action, voucher_no, head, amount_paisa, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), new Date().toISOString(), by, action, voucherNo, head, amountPaisa, detail],
    );
  }

   

  getUserByUsername(username: string): StoredUser | null {
    const row = this.sqlite.get<any>('SELECT * FROM users WHERE username = ?', [username]);
    return row ? this.mapUserRow(row) : null;
  }

  getUserById(id: string): StoredUser | null {
    const row = this.sqlite.get<any>('SELECT * FROM users WHERE id = ?', [id]);
    return row ? this.mapUserRow(row) : null;
  }

  private mapUserRow(r: any): StoredUser {
    return {
      id: String(r.id),
      username: String(r.username),
      displayName: String(r.display_name),
      password: String(r.password),
      role: normalizeRole(r.role),
      theme: (r.theme === 'dark' ? 'dark' : 'light') as ThemeMode,
      disabled: Boolean(r.disabled),
      phoneNumber: String(r.phone_number || ''),
      email: String(r.email || ''),
      photoUrl: String(r.photo_url || ''),
      createdAt: String(r.created_at),
    };
  }

  private toPublicUser(u: StoredUser): AppUser {
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      theme: u.theme || 'light',
      phoneNumber: u.phoneNumber,
      email: u.email,
      photoUrl: u.photoUrl,
      disabled: u.disabled,
      createdAt: u.createdAt,
    };
  }

  private hashToken(token: string): string {
    return crypto.createHmac('sha256', this.secret).update(token).digest('hex');
  }

  createSession(userId: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.sqlite.run(
      'INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)',
      [this.hashToken(token), userId, now + SESSION_TTL_MS, now],
    );
    return token;
  }

  getUserByToken(token: string): AppUser | null {
    if (!token) return null;
    const h = this.hashToken(token);
    const sess = this.sqlite.get<{ user_id: string; expires_at: number; last_seen_at: number }>(
      'SELECT user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ?',
      [h],
    );
    if (!sess) return null;
    const now = Date.now();
    if (sess.expires_at < now || now - sess.last_seen_at > SESSION_IDLE_MS) {
      this.sqlite.run('DELETE FROM sessions WHERE token_hash = ?', [h]);
      return null;
    }
    if (now - sess.last_seen_at > 60_000) {
      this.sqlite.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', [now, h]);
    }
    const u = this.getUserById(sess.user_id);
    if (!u || u.disabled) return null;
    return this.toPublicUser(u);
  }

  isSessionActive(token: string): boolean {
    return this.getUserByToken(token) !== null;
  }

  destroySession(token: string) {
    if (!token) return;
    this.sqlite.run('DELETE FROM sessions WHERE token_hash = ?', [this.hashToken(token)]);
  }

  destroyUserSessions(userId: string, exceptToken?: string) {
    if (exceptToken) {
      this.sqlite.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', [userId, this.hashToken(exceptToken)]);
    } else {
      this.sqlite.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    }
  }

  replacePasswordHash(userId: string, newHash: string) {
    this.sqlite.run('UPDATE users SET password = ? WHERE id = ?', [newHash, userId]);
  }

  updateUserPreferences(userId: string, patch: { theme?: ThemeMode }): AppUser {
    const u = this.getUserById(userId);
    if (!u) throw new Error('User not found.');
    const theme: ThemeMode = patch.theme === 'dark' ? 'dark' : 'light';
    this.sqlite.run('UPDATE users SET theme = ? WHERE id = ?', [theme, userId]);
    return this.toPublicUser(this.getUserById(userId)!);
  }

  updateUserProfile(
    userId: string,
    patch: { username?: string; displayName?: string; phoneNumber?: string; email?: string; photoUrl?: string; theme?: ThemeMode },
  ): AppUser {
    const u = this.getUserById(userId);
    if (!u) throw new Error('User not found.');
    let username = u.username;
    if (patch.username !== undefined) {
      const candidate = String(patch.username || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!/^[a-z0-9_.-]{3,32}$/.test(candidate)) {
        throw new Error('Username must be 3–32 characters (letters, numbers, _, ., -).');
      }
      if (candidate !== u.username) {
        const dup = this.sqlite.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND id != ?', [candidate, userId]);
        if (dup) throw new Error(`Username "${candidate}" is already taken.`);
        username = candidate;
      }
    }
    const displayName = patch.displayName !== undefined ? String(patch.displayName).trim().slice(0, 80) || u.displayName : u.displayName;
    const phoneNumber = patch.phoneNumber !== undefined ? String(patch.phoneNumber).trim().slice(0, 40) : (u.phoneNumber || '');
    const email = patch.email !== undefined ? String(patch.email).trim().slice(0, 120) : (u.email || '');
    const photoUrl = patch.photoUrl !== undefined ? cleanPhotoUrl(patch.photoUrl) : (u.photoUrl || '');
    const theme: ThemeMode = patch.theme !== undefined ? (patch.theme === 'dark' ? 'dark' : 'light') : (u.theme || 'light');
    this.sqlite.run(
      'UPDATE users SET username = ?, display_name = ?, phone_number = ?, email = ?, photo_url = ?, theme = ? WHERE id = ?',
      [username, displayName, phoneNumber, email, photoUrl, theme, userId],
    );
    this.notify('users');
    if (displayName !== u.displayName) {
      this.notify('transactions');
      this.notify('salaries');
      this.notify('loans');
      this.notify('locks');
      this.notify('rent');
    }
    return this.toPublicUser(this.getUserById(userId)!);
  }

  adminUpdateUser(
    id: string,
    patch: { username?: string; displayName?: string; role?: UserRole; phoneNumber?: string; email?: string },
    actorId: string,
  ): AdminUserSummary {
    const u = this.getUserById(id);
    if (!u) throw new Error('User not found.');
    let username = u.username;
    if (patch.username !== undefined) {
      const candidate = String(patch.username || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!/^[a-z0-9_.-]{3,32}$/.test(candidate)) {
        throw new Error('Username must be 3–32 characters (letters, numbers, _, ., -).');
      }
      if (candidate !== u.username) {
        const dup = this.sqlite.get<{ id: string }>('SELECT id FROM users WHERE username = ? AND id != ?', [candidate, id]);
        if (dup) throw new Error(`Username "${candidate}" already exists.`);
        username = candidate;
      }
    }
    if (patch.role !== undefined && !isUserRole(patch.role)) throw new Error('Unknown role.');
    const nextRole: UserRole = patch.role !== undefined ? patch.role : u.role;
    if (u.role === 'admin' && nextRole !== 'admin') {
      if (id === actorId) throw new Error('You cannot remove your own admin role.');
      const activeAdmins = Number(this.sqlite.scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0") || 0);
      if (activeAdmins <= 1) throw new Error('At least one active administrator is required.');
    }
    const displayName = patch.displayName !== undefined ? String(patch.displayName).trim().slice(0, 80) || u.displayName : u.displayName;
    const phoneNumber = patch.phoneNumber !== undefined ? String(patch.phoneNumber).trim().slice(0, 40) : (u.phoneNumber || '');
    const email = patch.email !== undefined ? String(patch.email).trim().slice(0, 120) : (u.email || '');
    this.sqlite.run(
      'UPDATE users SET username = ?, display_name = ?, role = ?, phone_number = ?, email = ? WHERE id = ?',
      [username, displayName, nextRole, phoneNumber, email, id],
    );
    this.notify('users');
    if (displayName !== u.displayName) {
      this.notify('transactions');
      this.notify('salaries');
      this.notify('loans');
      this.notify('locks');
      this.notify('rent');
    }
    return this.listUsers().find((x) => x.id === id)!;
  }

  listUsers(): AdminUserSummary[] {
    const rows = this.sqlite.all<any>(
      `SELECT u.*, (SELECT COUNT(*) FROM transactions t WHERE t.created_by_id = u.id) AS tx_count
       FROM users u ORDER BY u.role ASC, u.created_at ASC`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      username: String(r.username),
      displayName: String(r.display_name),
      role: String(r.role),
      theme: (r.theme === 'dark' ? 'dark' : 'light') as ThemeMode,
      phoneNumber: String(r.phone_number || ''),
      email: String(r.email || ''),
      photoUrl: String(r.photo_url || ''),
      disabled: Boolean(r.disabled),
      createdAt: String(r.created_at),
      txCount: Number(r.tx_count || 0),
    }));
  }

  getUserAvatars(): Record<string, string> {
    const rows = this.sqlite.all<{ display_name: string; photo_url: string }>(
      "SELECT display_name, photo_url FROM users WHERE photo_url != ''",
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.display_name] = r.photo_url;
    return out;
  }

  createUser(input: { username: string; displayName: string; password: string; role?: UserRole }): AdminUserSummary {
    const username = String(input.username || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw new Error('Username must be 3–32 characters (letters, numbers, _, ., -).');
    const prob = passwordProblem(input.password, username);
    if (prob) throw new Error(prob);
    if (this.getUserByUsername(username)) throw new Error(`Username "${username}" already exists.`);
    if (input.role !== undefined && !isUserRole(input.role)) throw new Error('Unknown role.');
    const role: UserRole = input.role ?? 'user';
    const displayName = String(input.displayName || username).trim().slice(0, 80) || username;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sqlite.run(
      "INSERT INTO users (id, username, display_name, password, role, theme, disabled, created_at) VALUES (?, ?, ?, ?, ?, 'light', 0, ?)",
      [id, username, displayName, hashPassword(input.password), role, now],
    );
    this.notify('users');
    return { id, username, displayName, role, theme: 'light', disabled: false, createdAt: now, txCount: 0 };
  }

  setUserDisabled(id: string, disabled: boolean, actorId: string) {
    if (id === actorId && disabled) throw new Error('You cannot disable your own account.');
    const u = this.getUserById(id);
    if (!u) throw new Error('User not found.');
    this.sqlite.run('UPDATE users SET disabled = ? WHERE id = ?', [disabled ? 1 : 0, id]);
    if (disabled) this.destroyUserSessions(id);
    this.notify('users');
    return u;
  }

  adminResetPassword(id: string, newPassword: string) {
    const u = this.getUserById(id);
    if (!u) throw new Error('User not found.');
    const prob = passwordProblem(newPassword, u.username);
    if (prob) throw new Error(prob);
    this.sqlite.run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(newPassword), id]);
    this.destroyUserSessions(id);
    return u;
  }

   

  hasSeenDevice(username: string, deviceId: string): boolean {
    if (!deviceId) return false;
    const rows = this.sqlite.all<{ meta_json: string }>(
      "SELECT meta_json FROM security_events WHERE type = 'login_ok' AND username = ? ORDER BY at DESC LIMIT 30",
      [username],
    );
    return rows.some((r) => {
      try { return JSON.parse(r.meta_json || '{}').deviceId === deviceId; } catch { return false; }
    });
  }

  logSecurity(type: string, info: { username?: string; ip?: string; detail?: string; meta?: any } = {}): string {
    const id = crypto.randomUUID();
    this.sqlite.run(
      'INSERT INTO security_events (id, at, type, username, ip, detail, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, new Date().toISOString(), type, info.username || '', info.ip || '', info.detail || '', info.meta ? JSON.stringify(info.meta) : ''],
    );
    return id;
  }

  addSecurityMeta(id: string, extra: Record<string, unknown>) {
    const row = this.sqlite.get<{ meta_json: string }>('SELECT meta_json FROM security_events WHERE id = ?', [id]);
    if (!row) return;
    let cur: any = {};
    try { cur = row.meta_json ? JSON.parse(row.meta_json) : {}; } catch {   }
    this.sqlite.run('UPDATE security_events SET meta_json = ? WHERE id = ?', [JSON.stringify({ ...cur, ...extra }), id]);
  }

  getSecurityEvents(limit = 200): SecurityEvent[] {
    const rows = this.sqlite.all<any>('SELECT * FROM security_events ORDER BY at DESC LIMIT ?', [limit]);
    return rows.map((r) => ({
      id: String(r.id),
      at: String(r.at),
      type: String(r.type),
      username: String(r.username || ''),
      ip: String(r.ip || ''),
      detail: String(r.detail || ''),
      meta: r.meta_json ? (() => { try { return JSON.parse(r.meta_json); } catch { return null; } })() : null,
    }));
  }

   

  getHeads(): LedgerHead[] {
    const rows = this.sqlite.all<any>('SELECT * FROM ledger_heads ORDER BY kind ASC, sort_order ASC, name ASC');
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind === 'income' ? 'income' : 'expense',
      name: String(r.name),
      description: String(r.description || ''),
      active: Boolean(r.active),
      sortOrder: Number(r.sort_order || 0),
    }));
  }

  upsertHead(input: { kind: 'income' | 'expense'; name: string; description?: string; active?: boolean }, actor: AppUser): LedgerHead {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name || name.length < 2) throw new Error('Channel/field name must be at least 2 characters.');
    const existing = this.sqlite.get<any>('SELECT * FROM ledger_heads WHERE kind = ? AND LOWER(name) = LOWER(?)', [input.kind, name]);
    if (existing) {
      this.sqlite.run('UPDATE ledger_heads SET description = ?, active = ? WHERE id = ?', [
        String(input.description ?? existing.description ?? '').trim().slice(0, 200),
        input.active === undefined ? existing.active : input.active ? 1 : 0,
        existing.id,
      ]);
      this.notify('heads');
      return {
        id: existing.id,
        kind: input.kind,
        name: String(existing.name),
        description: String(input.description ?? existing.description ?? ''),
        active: input.active === undefined ? Boolean(existing.active) : Boolean(input.active),
        sortOrder: Number(existing.sort_order || 0),
      };
    }
    const maxOrder = Number(this.sqlite.scalar('SELECT COALESCE(MAX(sort_order), 0) FROM ledger_heads WHERE kind = ?', [input.kind]) || 0);
    const id = crypto.randomUUID();
    this.sqlite.run(
      'INSERT INTO ledger_heads (id, kind, name, description, active, sort_order) VALUES (?, ?, ?, ?, 1, ?)',
      [id, input.kind, name, String(input.description || '').trim().slice(0, 200), maxOrder + 1],
    );
    this.logActivity(actor.displayName, 'head_added', '', name, 0, `Added ${input.kind} head ${name}`);
    this.notify('heads');
    return { id, kind: input.kind, name, description: String(input.description || ''), active: true, sortOrder: maxOrder + 1 };
  }

  renameHead(id: string, input: { name: string; description?: string }, actor: AppUser): LedgerHead {
    const newName = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!newName || newName.length < 2) throw new Error('Channel/field name must be at least 2 characters.');
    const updated = this.transaction(() => {
      const existing = this.sqlite.get<any>('SELECT * FROM ledger_heads WHERE id = ?', [id]);
      if (!existing) throw new Error('Channel / office head not found.');
      const dup = this.sqlite.get<any>(
        'SELECT id FROM ledger_heads WHERE kind = ? AND LOWER(name) = LOWER(?) AND id != ?',
        [existing.kind, newName, id],
      );
      if (dup) throw new Error(`"${newName}" already exists under ${existing.kind}.`);
      const nextDesc = input.description !== undefined
        ? String(input.description).trim().slice(0, 200)
        : String(existing.description || '');
      this.sqlite.run('UPDATE ledger_heads SET name = ?, description = ? WHERE id = ?', [newName, nextDesc, id]);
      this.logActivity(actor.displayName, 'head_renamed', '', newName, 0, `${existing.name} -> ${newName}`);
      return {
        id: String(existing.id),
        kind: (existing.kind === 'income' ? 'income' : 'expense') as 'income' | 'expense',
        name: newName,
        description: nextDesc,
        active: Boolean(existing.active),
        sortOrder: Number(existing.sort_order || 0),
      };
    });
    this.notify('heads');
    return updated;
  }

  private ensureHeadInsideTx(kind: 'income' | 'expense', rawName: string): boolean {
    const name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) return false;
    const existing = this.sqlite.get<any>('SELECT id, active FROM ledger_heads WHERE kind = ? AND LOWER(name) = LOWER(?)', [kind, name]);
    if (existing) return false;
    const maxOrder = Number(this.sqlite.scalar('SELECT COALESCE(MAX(sort_order), 0) FROM ledger_heads WHERE kind = ?', [kind]) || 0);
    this.sqlite.run(
      'INSERT INTO ledger_heads (id, kind, name, description, active, sort_order) VALUES (?, ?, ?, ?, 1, ?)',
      [crypto.randomUUID(), kind, name, '', maxOrder + 1],
    );
    return true;
  }

   

  getDepartments(): DepartmentRecord[] {
    const rows = this.sqlite.all<any>('SELECT * FROM departments ORDER BY active DESC, sort_order ASC, name ASC');
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: String(r.description || ''),
      active: Boolean(r.active),
      sortOrder: Number(r.sort_order || 0),
    }));
  }

  upsertDepartment(input: { name: string; description?: string; active?: boolean }, actor: AppUser): DepartmentRecord {
    const name = String(input.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name || name.length < 2) throw new Error('Department name must be at least 2 characters.');
    const existing = this.sqlite.get<any>('SELECT * FROM departments WHERE LOWER(name) = LOWER(?)', [name]);
    if (existing) {
      const nextDesc = String(input.description ?? existing.description ?? '').trim().slice(0, 200);
      const nextActive = input.active === undefined ? Boolean(existing.active) : Boolean(input.active);
      this.sqlite.run('UPDATE departments SET description = ?, active = ? WHERE id = ?', [nextDesc, nextActive ? 1 : 0, existing.id]);
      this.notify('departments');
      return {
        id: String(existing.id),
        name: String(existing.name),
        description: nextDesc,
        active: nextActive,
        sortOrder: Number(existing.sort_order || 0),
      };
    }
    const maxOrder = Number(this.sqlite.scalar('SELECT COALESCE(MAX(sort_order), 0) FROM departments') || 0);
    const id = crypto.randomUUID();
    const desc = String(input.description || '').trim().slice(0, 200);
    this.sqlite.run(
      'INSERT INTO departments (id, name, description, active, sort_order) VALUES (?, ?, ?, 1, ?)',
      [id, name, desc, maxOrder + 1],
    );
    this.logActivity(actor.displayName, 'department_added', '', name, 0, `Added department ${name}`);
    this.notify('departments');
    return { id, name, description: desc, active: true, sortOrder: maxOrder + 1 };
  }

  renameDepartment(id: string, input: { name?: string; description?: string; active?: boolean }, actor: AppUser): DepartmentRecord {
    const updated = this.transaction(() => {
      const existing = this.sqlite.get<any>('SELECT * FROM departments WHERE id = ?', [id]);
      if (!existing) throw new Error('Department not found.');
      const newName = input.name !== undefined
        ? String(input.name).trim().replace(/\s+/g, ' ').slice(0, 80)
        : String(existing.name);
      if (!newName || newName.length < 2) throw new Error('Department name must be at least 2 characters.');
      const dup = this.sqlite.get<any>('SELECT id FROM departments WHERE LOWER(name) = LOWER(?) AND id != ?', [newName, id]);
      if (dup) throw new Error(`Department "${newName}" already exists.`);
      const nextDesc = input.description !== undefined ? String(input.description).trim().slice(0, 200) : String(existing.description || '');
      const nextActive = input.active !== undefined ? (input.active ? 1 : 0) : Number(existing.active || 0);
      this.sqlite.run('UPDATE departments SET name = ?, description = ?, active = ? WHERE id = ?', [newName, nextDesc, nextActive, id]);
      this.logActivity(actor.displayName, 'department_updated', '', newName, 0, `${existing.name} -> ${newName}`);
      return {
        id: String(existing.id),
        name: newName,
        description: nextDesc,
        active: Boolean(nextActive),
        sortOrder: Number(existing.sort_order || 0),
      };
    });
    this.notify('departments');
    return updated;
  }

  private ensureDepartmentInsideTx(rawName: string): boolean {
    const name = String(rawName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) return false;
    const existing = this.sqlite.get<any>('SELECT id FROM departments WHERE LOWER(name) = LOWER(?)', [name]);
    if (existing) return false;
    const maxOrder = Number(this.sqlite.scalar('SELECT COALESCE(MAX(sort_order), 0) FROM departments') || 0);
    this.sqlite.run(
      'INSERT INTO departments (id, name, description, active, sort_order) VALUES (?, ?, ?, 1, ?)',
      [crypto.randomUUID(), name, '', maxOrder + 1],
    );
    return true;
  }

  getPeriodLocks(): PeriodLock[] {
    const rows = this.sqlite.all<any>(
      `SELECT pl.*, COALESCE(u.display_name, pl.locked_by_name) AS resolved_locked_by_name
       FROM period_locks pl LEFT JOIN users u ON u.id = pl.locked_by_id
       ORDER BY pl.period_key DESC`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      periodKey: String(r.period_key),
      label: String(r.label),
      openingPaisa: Number(r.opening_paisa || 0),
      incomePaisa: Number(r.income_paisa || 0),
      expensePaisa: Number(r.expense_paisa || 0),
      closingPaisa: Number(r.closing_paisa || 0),
      lockedAt: String(r.locked_at),
      lockedById: String(r.locked_by_id),
      lockedByName: String(r.resolved_locked_by_name || r.locked_by_name),
      note: String(r.note || ''),
    }));
  }

  private assertPeriodUnlocked(txDate: string) {
    const periodKey = txDate.slice(0, 7);
    const lock = this.sqlite.get<any>('SELECT label, locked_by_name FROM period_locks WHERE period_key = ?', [periodKey]);
    if (lock) {
      throw new Error(`Period "${lock.label}" (${periodKey}) is locked and signed off by ${lock.locked_by_name}. Unlock it in Audit & Locks first.`);
    }
  }

  lockPeriod(periodKey: string, note: string, actor: AppUser): PeriodLock {
    if (!/^\d{4}-\d{2}$/.test(periodKey)) throw new Error('Invalid month format (YYYY-MM).');
    return this.transaction(() => {
      const existing = this.sqlite.get<any>('SELECT id FROM period_locks WHERE period_key = ?', [periodKey]);
      if (existing) throw new Error(`Period ${periodKey} is already locked.`);
      const range = monthRangeOf(periodKey);
      const summary = this.getPeriodSummary(range.from, range.to, range.label);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const cleanNote = String(note || '').trim().slice(0, 300) || `Signed off ${range.label}`;
      this.sqlite.run(
        `INSERT INTO period_locks (id, period_key, label, opening_paisa, income_paisa, expense_paisa, closing_paisa, locked_at, locked_by_id, locked_by_name, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, periodKey, range.label, summary.openingBalancePaisa, summary.periodIncomePaisa, summary.periodExpensePaisa, summary.closingBalancePaisa, now, actor.id, actor.displayName, cleanNote],
      );
      this.appendAudit({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        eventType: 'period_locked',
        entryId: id,
        voucherNo: periodKey,
        reason: cleanNote,
        diff: [{ field: 'closingBalance', from: '', to: fromPaisa(summary.closingBalancePaisa) }],
        amountDeltaPaisa: 0,
        afterSnapshotJson: JSON.stringify({ periodKey, ...summary, periodTransactions: undefined }),
      });
      this.logActivity(actor.displayName, 'period_locked', periodKey, range.label, summary.closingBalancePaisa, cleanNote);
      this.notify('locks');
      return {
        id,
        periodKey,
        label: range.label,
        openingPaisa: summary.openingBalancePaisa,
        incomePaisa: summary.periodIncomePaisa,
        expensePaisa: summary.periodExpensePaisa,
        closingPaisa: summary.closingBalancePaisa,
        lockedAt: now,
        lockedById: actor.id,
        lockedByName: actor.displayName,
        note: cleanNote,
      };
    });
  }

  unlockPeriod(periodKey: string, reason: string, actor: AppUser) {
    const cleanReason = String(reason || '').trim().slice(0, 300);
    if (cleanReason.length < 4) throw new Error('A clear reason (at least 4 characters) is required to unlock a closed period.');
    this.transaction(() => {
      const lock = this.sqlite.get<any>('SELECT * FROM period_locks WHERE period_key = ?', [periodKey]);
      if (!lock) throw new Error('Period lock not found.');
      this.sqlite.run('DELETE FROM period_locks WHERE period_key = ?', [periodKey]);
      this.appendAudit({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        eventType: 'period_unlocked',
        entryId: lock.id,
        voucherNo: periodKey,
        reason: cleanReason,
        diff: [{ field: 'periodLock', from: 'Locked', to: 'Unlocked' }],
        amountDeltaPaisa: 0,
        afterSnapshotJson: JSON.stringify({ periodKey, unlockedBy: actor.displayName }),
      });
      this.logActivity(actor.displayName, 'period_unlocked', periodKey, String(lock.label), 0, cleanReason);
    });
    this.notify('locks');
  }

   

  private mapTxRow(r: any): LedgerTransaction {
    let editHistory: TxEditEntry[] = [];
    try { editHistory = JSON.parse(r.edit_history_json || '[]'); } catch { editHistory = []; }
    const cg = String(r.category_group || 'general');
    const categoryGroup: TxCategoryGroup =
      cg === 'salary' || cg === 'salary_advance' || cg === 'loan_issue' || cg === 'loan_repayment' || cg === 'rent' ? cg : 'general';
    return {
      id: String(r.id),
      voucherNo: String(r.voucher_no),
      kind: r.kind === 'income' ? 'income' : 'expense',
      txDate: String(r.tx_date),
      amountPaisa: Number(r.amount_paisa || 0),
      department: String(r.department || ''),
      departmentReview: Boolean(r.department_review),
      head: String(r.head),
      subCategory: String(r.sub_category),
      paymentMethod: String(r.payment_method),
      referenceNo: String(r.reference_no || ''),
      counterparty: String(r.counterparty),
      counterpartyPhone: String(r.counterparty_phone || ''),
      purpose: String(r.purpose),
      notes: String(r.notes || ''),
      fundedByTxId: String(r.funded_by_tx_id || ''),
      employeeId: String(r.employee_id || ''),
      employeeName: String(r.employee_name || ''),
      categoryGroup,
      fundSourceId: String(r.fund_source_id || ''),
      fundSourceName: String(r.fund_source_name || ''),
      receiptSha: String(r.receipt_sha || ''),
      receiptName: String(r.receipt_name || ''),
      receiptType: String(r.receipt_type || ''),
      status: (r.status === 'pending_review' || r.status === 'flagged' ? r.status : 'verified'),
      verifiedByName: String(r.verified_by_name || ''),
      verifiedAt: String(r.verified_at || ''),
      flagNote: String(r.flag_note || ''),
      editCount: Number(r.edit_count || 0),
      amountChanged: Boolean(r.amount_changed),
      lastEditedAt: String(r.last_edited_at || ''),
      lastEditedBy: String(r.last_edited_by || ''),
      lastEditReason: String(r.last_edit_reason || ''),
      editHistory,
      createdAt: String(r.created_at),
      createdById: String(r.created_by_id),
      createdByName: String(r.resolved_created_by_name || r.created_by_name),
      updatedAt: String(r.updated_at),
      deletedAt: String(r.deleted_at || ''),
      deletedBy: String(r.deleted_by || ''),
      deleteReason: String(r.delete_reason || ''),
    };
  }

  /**
   * Return only duplicate records relevant to the current Excel import preview.
   * Avoids materializing the complete transaction history when the ledger grows
   * to hundreds of thousands of rows.
   */
  getImportDuplicateIndexes(input: {
    entries: { txDate: string; kind: 'income' | 'expense'; amountPaisa: number }[];
    linked: { txDate: string; categoryGroup: string; employeeName: string; amountPaisa: number }[];
  }): { existingEntries: Map<string, string[]>; existingLinkedEntries: Map<string, string[]> } {
    const existingEntries = new Map<string, string[]>();
    const existingLinkedEntries = new Map<string, string[]>();
    const norm = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
    const add = (map: Map<string, string[]>, key: string, label: string) => {
      const list = map.get(key);
      if (list) list.push(label); else map.set(key, [label]);
    };
    const validEntries = input.entries.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.txDate) && Number.isSafeInteger(r.amountPaisa) && r.amountPaisa > 0);
    const validLinked = input.linked.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.txDate) && r.categoryGroup && r.employeeName && Number.isSafeInteger(r.amountPaisa) && r.amountPaisa > 0);
    const uniqueTriples = <T extends { txDate: string; amountPaisa: number }>(rows: T[], third: (row: T) => string) => {
      const byKey = new Map<string, T>();
      for (const row of rows) byKey.set(`${row.txDate}|${third(row)}|${row.amountPaisa}`, row);
      return [...byKey.values()];
    };
    const chunked = <T>(rows: T[], size = 180) => {
      const chunks: T[][] = [];
      for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
      return chunks;
    };

    const cashKeys = uniqueTriples(validEntries, (r) => r.kind);
    for (const chunk of chunked(cashKeys)) {
      const tuples = chunk.map(() => '(?, ?, ?)').join(', ');
      const params = chunk.flatMap((r) => [r.txDate, r.kind, r.amountPaisa]);
      const rows = this.sqlite.all<any>(
        `SELECT tx_date, kind, amount_paisa, voucher_no FROM transactions
         WHERE deleted_at = '' AND (tx_date, kind, amount_paisa) IN (${tuples})`,
        params,
      );
      for (const row of rows) add(existingEntries,
        `${row.tx_date}|${row.kind}|${Number(row.amount_paisa)}`, String(row.voucher_no || row.id || 'existing entry'));
    }

    const candidateLinkedKeys = new Set(validLinked.map((r) =>
      `${r.txDate}|${r.categoryGroup}|${norm(r.employeeName)}|${r.amountPaisa}`));
    const linkedTriples = uniqueTriples(validLinked, (r) => r.categoryGroup);
    for (const chunk of chunked(linkedTriples)) {
      const tuples = chunk.map(() => '(?, ?, ?)').join(', ');
      const params = chunk.flatMap((r) => [r.txDate, r.categoryGroup, r.amountPaisa]);
      const rows = this.sqlite.all<any>(
        `SELECT tx_date, category_group, employee_name, amount_paisa, voucher_no FROM transactions
         WHERE deleted_at = '' AND (tx_date, category_group, amount_paisa) IN (${tuples})`,
        params,
      );
      for (const row of rows) {
        const key = `${row.tx_date}|${row.category_group}|${norm(String(row.employee_name || ''))}|${Number(row.amount_paisa)}`;
        if (candidateLinkedKeys.has(key)) add(existingLinkedEntries, key, String(row.voucher_no || row.id || 'existing entry'));
      }
    }

    // Historical repayments intentionally have no transaction row. Find only
    // dates/amounts relevant to this import and compare the loan owner in memory.
    const repaymentCandidates = validLinked.filter((r) => r.categoryGroup === 'loan_repayment');
    const repaymentTriples = uniqueTriples(repaymentCandidates, () => 'loan_repayment');
    for (const chunk of chunked(repaymentTriples)) {
      const tuples = chunk.map(() => '(?, ?)').join(', ');
      const params = chunk.flatMap((r) => [r.txDate, r.amountPaisa]);
      const rows = this.sqlite.all<any>(
        `SELECT lr.paid_date AS tx_date, el.employee_name, lr.amount_paisa, el.loan_no
         FROM loan_repayments lr JOIN employee_loans el ON el.id = lr.loan_id
         WHERE lr.source = 'historical' AND (lr.paid_date, lr.amount_paisa) IN (${tuples})`,
        params,
      );
      for (const row of rows) {
        const key = `${row.tx_date}|loan_repayment|${norm(String(row.employee_name || ''))}|${Number(row.amount_paisa)}`;
        if (candidateLinkedKeys.has(key)) add(existingLinkedEntries, key, `historical repayment ${row.loan_no}`);
      }
    }
    return { existingEntries, existingLinkedEntries };
  }

  // Retained for explicit test/maintenance callers; normal APIs use bounded pages or
  // getDeletedTransactionsPage() so neither the active history nor the Admin Bin is unbounded.
  getAllTransactions(includeDeleted = false): LedgerTransaction[] {
    const sql = includeDeleted
      ? `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
         FROM transactions t
         LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
         LEFT JOIN users u ON u.id = t.created_by_id
         ORDER BY t.tx_date DESC, t.created_at DESC`
      : `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
         FROM transactions t
         LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
         LEFT JOIN users u ON u.id = t.created_by_id
         WHERE t.deleted_at = ''
         ORDER BY t.tx_date DESC, t.created_at DESC`;
    return this.sqlite.all<any>(sql).map((row) => this.mapTxRow(row));
  }

  getDeletedTransactions(): LedgerTransaction[] {
    const rows = this.sqlite.all<any>(
      `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
       FROM transactions t
       LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE t.deleted_at != ''
       ORDER BY t.deleted_at DESC, t.tx_date DESC, t.created_at DESC`,
    );
    return rows.map((row) => this.mapTxRow(row));
  }

  getDeletedTransactionsPage(options: { limit?: number; cursor?: string } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(options.limit) || 50)));
    const where = ["t.deleted_at != ''"];
    const params: unknown[] = [];
    if (options.cursor) {
      let cursor: { deletedAt: string; txDate: string; createdAt: string; id: string };
      try {
        if (options.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error('Invalid cursor encoding');
        const decoded = Buffer.from(options.cursor, 'base64url');
        if (decoded.toString('base64url') !== options.cursor) throw new Error('Non-canonical cursor');
        const parsed = JSON.parse(decoded.toString('utf8'));
        const validDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
        if (!parsed || Array.isArray(parsed) || typeof parsed.deletedAt !== 'string' || !parsed.deletedAt || parsed.deletedAt.length > 40
            || !validDate(parsed.txDate) || typeof parsed.createdAt !== 'string' || parsed.createdAt.length < 10
            || parsed.createdAt.length > 40 || typeof parsed.id !== 'string' || !parsed.id.trim() || parsed.id.length > 200) {
          throw new Error('Invalid cursor payload');
        }
        cursor = { deletedAt: parsed.deletedAt, txDate: parsed.txDate, createdAt: parsed.createdAt, id: parsed.id };
      } catch {
        throw new Error('Invalid deleted-transaction cursor. Refresh the Bin and try again.');
      }
      where.push('(t.deleted_at, t.tx_date, t.created_at, t.id) < (?, ?, ?, ?)');
      params.push(cursor.deletedAt, cursor.txDate, cursor.createdAt, cursor.id);
    }
    const totalCount = Number(this.sqlite.scalar("SELECT COUNT(*) FROM transactions WHERE deleted_at != ''") || 0);
    const rows = this.sqlite.all<any>(
      `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
       FROM transactions t INDEXED BY idx_tx_deleted_date_created_id
       LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.deleted_at DESC, t.tx_date DESC, t.created_at DESC, t.id DESC
       LIMIT ?`,
      [...params, limit + 1],
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const items = rows.map((row) => this.mapTxRow(row));
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ deletedAt: last.deletedAt, txDate: last.txDate, createdAt: last.createdAt, id: last.id })).toString('base64url')
      : null;
    return { items, nextCursor, hasMore, limit, totalCount };
  }

  getTransactionFacets(): { departments: string[]; paymentMethods: string[] } {
    const departments = this.sqlite.all<{ value: string }>(
      `SELECT DISTINCT department AS value FROM transactions
       WHERE deleted_at = '' AND COALESCE(TRIM(department), '') != ''
       ORDER BY department COLLATE NOCASE`,
    ).map((row) => String(row.value));
    const paymentMethods = this.sqlite.all<{ value: string }>(
      `SELECT DISTINCT payment_method AS value FROM transactions
       WHERE deleted_at = '' AND COALESCE(TRIM(payment_method), '') != ''
       ORDER BY payment_method COLLATE NOCASE`,
    ).map((row) => String(row.value));
    return { departments, paymentMethods };
  }

  private transactionWhere(query: TransactionListQuery): { where: string[]; params: unknown[]; indexedSearch?: string } {
    const where = query.includeDeleted ? ['1 = 1'] : ["t.deleted_at = ''"];
    const params: unknown[] = [];
    let indexedSearch = '';
    if (query.from) { where.push('t.tx_date >= ?'); params.push(query.from); }
    if (query.to) { where.push('t.tx_date <= ?'); params.push(query.to); }
    if (query.kind && query.kind !== 'all') { where.push('t.kind = ?'); params.push(query.kind); }
    if (query.head) { where.push('t.head = ?'); params.push(query.head); }
    if (query.department === '__none__') where.push("(COALESCE(t.department, '') = '' OR t.department_review = 1)");
    else if (query.department) { where.push('t.department = ?'); params.push(query.department); }
    if (query.paymentMethod) { where.push('t.payment_method = ?'); params.push(query.paymentMethod); }
    if (query.employeeId) { where.push('t.employee_id = ?'); params.push(query.employeeId); }
    if (query.fundSourceId) { where.push('t.fund_source_id = ?'); params.push(query.fundSourceId); }
    switch (query.auditFilter) {
      case 'edited': where.push('t.edit_count > 0'); break;
      case 'amount_changed': where.push('t.amount_changed = 1'); break;
      case 'flagged': where.push("t.status = 'flagged'"); break;
      case 'receipt': where.push("COALESCE(t.receipt_sha, '') != ''"); break;
      case 'unclassified_dept': where.push("(t.department_review = 1 OR COALESCE(t.department, '') = '')"); break;
      case 'flagged_or_changed': where.push("(t.status = 'flagged' OR t.amount_changed = 1)"); break;
    }
    const search = String(query.search || '').trim().slice(0, 120);
    if (search.length >= 3 && /[^%_]{3,}/.test(search)) {
      indexedSearch = search;
      where.push(`(t.rowid IN (SELECT rowid FROM transactions_fts
          WHERE search_text LIKE ? AND instr(search_text, lower(?)) > 0)
        OR EXISTS (SELECT 1 FROM fund_sources fs_search WHERE fs_search.id = t.fund_source_id
          AND instr(lower(fs_search.name), lower(?)) > 0))`);
      params.push(`%${search}%`, search, search);
    } else if (search) {
      const fields = [
        't.voucher_no', 't.tx_date', 't.department', 't.head', 't.sub_category', 't.payment_method',
        't.reference_no', 't.counterparty', 't.employee_name', 't.purpose', 't.notes',
        't.created_by_name', 't.last_edit_reason',
      ];
      where.push(`(${fields.map((field) => `instr(lower(COALESCE(${field}, '')), lower(?)) > 0`).join(' OR ')}
        OR EXISTS (SELECT 1 FROM fund_sources fs_search WHERE fs_search.id = t.fund_source_id
          AND instr(lower(fs_search.name), lower(?)) > 0))`);
      for (let i = 0; i < fields.length + 1; i++) params.push(search);
    }
    return { where, params, indexedSearch: indexedSearch || undefined };
  }

  getTransactionsPage(query: TransactionListQuery = {}): TransactionPage {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(query.limit) || 50)));
    const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
    const custom = query.sort ? CUSTOM_SORTS[query.sort] : undefined;
    const { where, params, indexedSearch } = this.transactionWhere(query);

    // The search condition is deliberately separated from the ordinary filters. For
    // long terms, totals and page rows are driven by the indexed FTS row IDs instead
    // of scanning all active transactions and testing an FTS subquery for each row.
    const filterWhere = indexedSearch ? where.slice(0, -1) : [...where];
    const filterParams = indexedSearch ? params.slice(0, -3) : [...params];
    const filterWhereSql = filterWhere.length ? filterWhere.join(' AND ') : '1=1';
    const matchingFundSourceIds = indexedSearch
      ? this.sqlite.all<{ id: string }>(
          'SELECT id FROM fund_sources WHERE instr(lower(name), lower(?)) > 0',
          [indexedSearch],
        ).map((row) => String(row.id))
      : [];
    const fundSourceSearchUnion = matchingFundSourceIds.length
      ? ` UNION SELECT rowid FROM transactions ${query.includeDeleted ? '' : 'INDEXED BY idx_tx_active_fund_date'}
          WHERE ${query.includeDeleted ? '' : "deleted_at = '' AND "}
          fund_source_id IN (${matchingFundSourceIds.map(() => '?').join(',')})`
      : '';
    const searchIdsSql = indexedSearch
      ? `SELECT rowid FROM transactions_fts WHERE search_text LIKE ? AND instr(search_text, lower(?)) > 0${fundSourceSearchUnion}`
      : '';
    const searchIdParams = indexedSearch
      ? [`%${indexedSearch}%`, indexedSearch, ...matchingFundSourceIds]
      : [];

    const totals = indexedSearch
      ? this.sqlite.get<any>(
          `SELECT COUNT(*) AS total_count,
            COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount_paisa ELSE 0 END), 0) AS income_paisa,
            COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_paisa ELSE 0 END), 0) AS expense_paisa
           FROM (${searchIdsSql}) search_ids CROSS JOIN transactions t
           WHERE t.rowid = search_ids.rowid AND ${filterWhereSql}`,
          [...searchIdParams, ...filterParams],
        ) || {}
      : this.sqlite.get<any>(
          `SELECT COUNT(*) AS total_count,
            COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount_paisa ELSE 0 END), 0) AS income_paisa,
            COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_paisa ELSE 0 END), 0) AS expense_paisa
           FROM transactions t WHERE ${filterWhereSql}`,
          filterParams,
        ) || {};

    const pageWhere = [...filterWhere];
    const pageParams = [...filterParams];
    if (query.cursor && custom) {
      let cursor: { k: string | number; id: string };
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('Invalid cursor encoding');
        const decoded = Buffer.from(query.cursor, 'base64url');
        if (decoded.toString('base64url') !== query.cursor) throw new Error('Non-canonical cursor');
        const parsed = JSON.parse(decoded.toString('utf8'));
        const keyOk = custom.numeric
          ? typeof parsed?.k === 'number' && Number.isFinite(parsed.k)
          : typeof parsed?.k === 'string' && parsed.k.length <= 400;
        if (!parsed || Array.isArray(parsed) || !keyOk || typeof parsed.id !== 'string' || !parsed.id.trim() || parsed.id.length > 200) {
          throw new Error('Invalid cursor payload');
        }
        cursor = { k: parsed.k, id: parsed.id };
      } catch {
        throw new Error('Invalid transaction cursor. Refresh the list and try again.');
      }
      pageWhere.push(`(${custom.key}, t.id) ${custom.dir === 'DESC' ? '<' : '>'} (?, ?)`);
      pageParams.push(cursor.k, cursor.id);
    } else if (query.cursor) {
      let cursor: { txDate: string; createdAt: string; id: string };
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('Invalid cursor encoding');
        const decoded = Buffer.from(query.cursor, 'base64url');
        if (decoded.toString('base64url') !== query.cursor) throw new Error('Non-canonical cursor');
        const parsed = JSON.parse(decoded.toString('utf8'));
        const validDate = typeof parsed?.txDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.txDate)
          && new Date(`${parsed.txDate}T00:00:00.000Z`).toISOString().slice(0, 10) === parsed.txDate;
        if (!parsed || Array.isArray(parsed) || !validDate || typeof parsed.createdAt !== 'string'
          || parsed.createdAt.length < 10 || parsed.createdAt.length > 40
          || typeof parsed.id !== 'string' || !parsed.id.trim() || parsed.id.length > 200) throw new Error('Invalid cursor payload');
        cursor = { txDate: parsed.txDate, createdAt: parsed.createdAt, id: parsed.id };
      } catch {
        throw new Error('Invalid transaction cursor. Refresh the list and try again.');
      }
      const op = direction === 'DESC' ? '<' : '>';
      pageWhere.push(`(t.tx_date, t.created_at, t.id) ${op} (?, ?, ?)`);
      pageParams.push(cursor.txDate, cursor.createdAt, cursor.id);
    }
    // SQLite may prefer the legacy deleted_at index and sort every matching row even
    // though this query is explicitly ordered by the date composite indexes. Force the
    // best matching active-ledger index for non-search pages. Search uses a rowid-first
    // FTS subquery, then primary-key lookups for only the matching records.
    const searchText = String(query.search || '').trim();
    const shortSearch = searchText.length > 0 && searchText.length < 3;
    const pageIndex = !custom && !indexedSearch && !query.includeDeleted && (!searchText || shortSearch)
      ? query.employeeId ? 'idx_tx_active_employee_date'
        : query.head ? 'idx_tx_active_head_date'
          : query.fundSourceId ? 'idx_tx_active_fund_date'
            : query.department && query.department !== '__none__' ? 'idx_tx_active_dept_date'
              : query.paymentMethod ? 'idx_tx_active_method_date'
                : query.kind && query.kind !== 'all' ? 'idx_tx_active_kind_date'
                  : 'idx_tx_active_date_created_id'
      : '';
    const fromClause = indexedSearch
      ? `FROM (${searchIdsSql}) search_ids CROSS JOIN transactions t`
      : pageIndex ? `FROM transactions t INDEXED BY ${pageIndex}` : 'FROM transactions t';
    const pageWhereSql = indexedSearch
      ? ['t.rowid = search_ids.rowid', ...pageWhere].join(' AND ')
      : pageWhere.length ? pageWhere.join(' AND ') : '1=1';
    const rows = this.sqlite.all<any>(
      `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name${custom ? `, ${custom.key} AS sort_key` : ''}
       ${fromClause}
       LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE ${pageWhereSql}
       ORDER BY ${custom ? `${custom.key} ${custom.dir}, t.id ${custom.dir}` : `t.tx_date ${direction}, t.created_at ${direction}, t.id ${direction}`}
       LIMIT ?`,
      [...searchIdParams, ...pageParams, limit + 1],
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const items = rows.map((r) => this.mapTxRow(r));
    const last = items[items.length - 1];
    const lastRaw = rows[rows.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify(
          custom
            ? { k: custom.numeric ? Number(lastRaw.sort_key) : String(lastRaw.sort_key ?? ''), id: last.id }
            : { txDate: last.txDate, createdAt: last.createdAt, id: last.id },
        )).toString('base64url')
      : null;
    const incomePaisa = Number(totals.income_paisa || 0);
    const expensePaisa = Number(totals.expense_paisa || 0);
    return {
      items,
      nextCursor,
      hasMore,
      limit,
      totalCount: Number(totals.total_count || 0),
      incomePaisa,
      expensePaisa,
      netPaisa: incomePaisa - expensePaisa,
    };
  }

  getPeriodSummary(from: string, to: string, label: string): PeriodSummaryResponse {
    const sums = this.sqlite.get<any>(
      `SELECT
        COALESCE(SUM(CASE WHEN tx_date < ? AND kind = 'income' THEN amount_paisa ELSE 0 END), 0) AS opening_income,
        COALESCE(SUM(CASE WHEN tx_date < ? AND kind = 'expense' THEN amount_paisa ELSE 0 END), 0) AS opening_expense,
        COALESCE(SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'income' THEN amount_paisa ELSE 0 END), 0) AS period_income,
        COALESCE(SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'expense' THEN amount_paisa ELSE 0 END), 0) AS period_expense,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? THEN 1 ELSE 0 END) AS period_count,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'expense' THEN 1 ELSE 0 END) AS period_expense_count,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'income' THEN 1 ELSE 0 END) AS income_count,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'expense' THEN 1 ELSE 0 END) AS expense_count
       FROM transactions INDEXED BY idx_tx_active_date_summary WHERE deleted_at = ''`,
      [from, from, from, to, from, to, from, to, from, to, from, to, from, to],
    ) || {};
    const groups = this.sqlite.all<any>(
      `SELECT kind, head, SUM(amount_paisa) AS total_paisa, COUNT(*) AS count,
        SUM(CASE WHEN edit_count > 0 THEN 1 ELSE 0 END) AS edited_count
       FROM transactions INDEXED BY idx_tx_active_date_summary WHERE deleted_at = '' AND tx_date >= ? AND tx_date <= ?
       GROUP BY kind, head`,
      [from, to],
    );
    const heads = this.getHeads();
    const maps = {
      income: new Map<string, { totalPaisa: number; count: number; editedCount: number }>(),
      expense: new Map<string, { totalPaisa: number; count: number; editedCount: number }>(),
    };
    for (const head of heads) {
      if (head.active) maps[head.kind].set(head.name, { totalPaisa: 0, count: 0, editedCount: 0 });
    }
    for (const row of groups) {
      const kind = row.kind === 'income' ? 'income' : 'expense';
      maps[kind].set(String(row.head), {
        totalPaisa: Number(row.total_paisa || 0),
        count: Number(row.count || 0),
        editedCount: Number(row.edited_count || 0),
      });
    }
    const order = new Map(heads.map((head, index) => [`${head.kind}:${head.name}`, head.sortOrder ?? index]));
    const toRows = (kind: 'income' | 'expense') => Array.from(maps[kind].entries())
      .map(([head, stats]) => ({ head, ...stats }))
      .sort((a, b) => (order.get(`${kind}:${a.head}`) ?? 999) - (order.get(`${kind}:${b.head}`) ?? 999) || a.head.localeCompare(b.head));
    const recentRows = this.sqlite.all<any>(
      `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
       FROM transactions t LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE t.deleted_at = '' AND t.tx_date >= ? AND t.tx_date <= ?
       ORDER BY t.tx_date DESC, t.created_at DESC, t.id DESC LIMIT 10`,
      [from, to],
    );
    const openingBalancePaisa = Number(sums.opening_income || 0) - Number(sums.opening_expense || 0);
    const periodIncomePaisa = Number(sums.period_income || 0);
    const periodExpensePaisa = Number(sums.period_expense || 0);
    return {
      from, to, label,
      openingBalancePaisa,
      periodIncomePaisa,
      totalAvailablePaisa: openingBalancePaisa + periodIncomePaisa,
      periodExpensePaisa,
      closingBalancePaisa: openingBalancePaisa + periodIncomePaisa - periodExpensePaisa,
      incomeByHead: toRows('income'),
      expenseByHead: toRows('expense'),
      periodTransactions: recentRows.map((row) => this.mapTxRow(row)),
      periodTransactionCount: Number(sums.period_count || 0),
      periodExpenseCount: Number(sums.period_expense_count || 0),
      incomeCount: Number(sums.income_count || 0),
      expenseCount: Number(sums.expense_count || 0),
    };
  }

  getEmployeeActivityIds(from: string, to: string): string[] {
    return this.sqlite.all<{ employee_id: string }>(
      `SELECT DISTINCT employee_id FROM transactions
       WHERE deleted_at = '' AND employee_id != '' AND tx_date >= ? AND tx_date <= ?`,
      [from, to],
    ).map((row) => String(row.employee_id));
  }

  getEmployeeSpendStats(from?: string, to?: string): EmployeeSpendStat[] {
    const txWhere = ["deleted_at = ''", "employee_id != ''", "category_group NOT IN ('salary', 'salary_advance', 'loan_issue', 'loan_repayment')"];
    const txParams: unknown[] = [];
    if (from) { txWhere.push('tx_date >= ?'); txParams.push(from); }
    if (to) { txWhere.push('tx_date <= ?'); txParams.push(to); }
    const txRows = this.sqlite.all<any>(
      `SELECT employee_id, SUM(CASE WHEN kind = 'expense' THEN amount_paisa ELSE 0 END) AS operational_paisa,
        COUNT(*) AS tx_count FROM transactions WHERE ${txWhere.join(' AND ')} GROUP BY employee_id`, txParams,
    );
    const salaryWhere: string[] = [];
    const salaryParams: unknown[] = [];
    if (from) { salaryWhere.push('paid_date >= ?'); salaryParams.push(from); }
    if (to) { salaryWhere.push('paid_date <= ?'); salaryParams.push(to); }
    const salaryRows = this.sqlite.all<any>(
      `SELECT employee_id, SUM(net_paid_paisa) AS salary_paisa FROM salary_payments ${salaryWhere.length ? `WHERE ${salaryWhere.join(' AND ')}` : ''} GROUP BY employee_id`, salaryParams,
    );
    const loanWhere: string[] = [];
    const loanParams: unknown[] = [];
    if (from) { loanWhere.push('issued_date >= ?'); loanParams.push(from); }
    if (to) { loanWhere.push('issued_date <= ?'); loanParams.push(to); }
    const loanRows = this.sqlite.all<any>(
      `SELECT employee_id, SUM(principal_paisa) AS issued_paisa FROM employee_loans ${loanWhere.length ? `WHERE ${loanWhere.join(' AND ')}` : ''} GROUP BY employee_id`, loanParams,
    );
    const activeLoanRows = this.sqlite.all<any>(
      "SELECT employee_id, SUM(remaining_paisa) AS active_paisa FROM employee_loans WHERE status = 'active' GROUP BY employee_id",
    );
    const byId = (rows: any[], key: string) => new Map<string, number>(rows.map((row) => [String(row.employee_id), Number(row[key] || 0)]));
    const txMap = new Map(txRows.map((row) => [String(row.employee_id), { operational: Number(row.operational_paisa || 0), count: Number(row.tx_count || 0) }]));
    const salaryMap = byId(salaryRows, 'salary_paisa');
    const loanMap = byId(loanRows, 'issued_paisa');
    const activeLoanMap = byId(activeLoanRows, 'active_paisa');
    const raw = this.getEmployees().map((employee) => ({
      employee,
      salaryPaisa: salaryMap.get(employee.id) || 0,
      operationalTakenPaisa: txMap.get(employee.id)?.operational || 0,
      loanIssuedPaisa: loanMap.get(employee.id) || 0,
      activeLoanPaisa: activeLoanMap.get(employee.id) || 0,
      totalTakenPaisa: txMap.get(employee.id)?.operational || 0,
      txCount: txMap.get(employee.id)?.count || 0,
    }));
    const activePool = raw.filter((row) => row.employee.active);
    const pool = activePool.length ? activePool : raw;
    const avg = pool.length ? Math.round(pool.reduce((total, row) => total + row.operationalTakenPaisa, 0) / pool.length) : 0;
    return raw.map((row) => {
      const spendLevel: EmployeeSpendStat['spendLevel'] = avg > 0 && row.operationalTakenPaisa >= avg * 1.35
        ? 'high'
        : avg > 0 && row.operationalTakenPaisa <= avg * 0.5 ? 'low' : 'normal';
      return { ...row, avgOperationalPaisa: avg, spendLevel };
    }).sort((a, b) => b.operationalTakenPaisa - a.operationalTakenPaisa || b.txCount - a.txCount);
  }

  private getPeriodSummaryFromConnection(
    reader: DatabaseSync,
    from: string,
    to: string,
    label: string,
  ): PeriodSummaryResponse {
    const sums = reader.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN tx_date < ? AND kind = 'income' THEN amount_paisa ELSE 0 END), 0) AS opening_income,
        COALESCE(SUM(CASE WHEN tx_date < ? AND kind = 'expense' THEN amount_paisa ELSE 0 END), 0) AS opening_expense,
        COALESCE(SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'income' THEN amount_paisa ELSE 0 END), 0) AS period_income,
        COALESCE(SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'expense' THEN amount_paisa ELSE 0 END), 0) AS period_expense,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? THEN 1 ELSE 0 END) AS period_count,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'expense' THEN 1 ELSE 0 END) AS period_expense_count,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'income' THEN 1 ELSE 0 END) AS income_count,
        SUM(CASE WHEN tx_date >= ? AND tx_date <= ? AND kind = 'expense' THEN 1 ELSE 0 END) AS expense_count
       FROM transactions INDEXED BY idx_tx_active_date_summary WHERE deleted_at = ''`,
    ).get(from, from, from, to, from, to, from, to, from, to, from, to, from, to) as any || {};

    const groups = reader.prepare(
      `SELECT kind, head, SUM(amount_paisa) AS total_paisa, COUNT(*) AS count,
        SUM(CASE WHEN edit_count > 0 THEN 1 ELSE 0 END) AS edited_count
       FROM transactions INDEXED BY idx_tx_active_date_summary
       WHERE deleted_at = '' AND tx_date >= ? AND tx_date <= ? GROUP BY kind, head`,
    ).all(from, to) as any[];
    const heads = (reader.prepare('SELECT * FROM ledger_heads ORDER BY kind ASC, sort_order ASC, name ASC').all() as any[])
      .map((row) => ({
        id: String(row.id),
        kind: row.kind === 'income' ? 'income' as const : 'expense' as const,
        name: String(row.name),
        description: String(row.description || ''),
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order || 0),
      }));

    const maps = {
      income: new Map<string, { totalPaisa: number; count: number; editedCount: number }>(),
      expense: new Map<string, { totalPaisa: number; count: number; editedCount: number }>(),
    };
    for (const head of heads) {
      if (head.active) maps[head.kind].set(head.name, { totalPaisa: 0, count: 0, editedCount: 0 });
    }
    for (const row of groups) {
      const kind = row.kind === 'income' ? 'income' : 'expense';
      maps[kind].set(String(row.head), {
        totalPaisa: Number(row.total_paisa || 0),
        count: Number(row.count || 0),
        editedCount: Number(row.edited_count || 0),
      });
    }
    const order = new Map(heads.map((head, index) => [`${head.kind}:${head.name}`, head.sortOrder ?? index]));
    const toRows = (kind: 'income' | 'expense') => Array.from(maps[kind].entries())
      .map(([head, stats]) => ({ head, ...stats }))
      .sort((a, b) => (order.get(`${kind}:${a.head}`) ?? 999) - (order.get(`${kind}:${b.head}`) ?? 999) || a.head.localeCompare(b.head));
    const recentRows = reader.prepare(
      `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
       FROM transactions t LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE t.deleted_at = '' AND t.tx_date >= ? AND t.tx_date <= ?
       ORDER BY t.tx_date DESC, t.created_at DESC, t.id DESC LIMIT 10`,
    ).all(from, to) as any[];
    const openingBalancePaisa = Number(sums.opening_income || 0) - Number(sums.opening_expense || 0);
    const periodIncomePaisa = Number(sums.period_income || 0);
    const periodExpensePaisa = Number(sums.period_expense || 0);
    return {
      from, to, label,
      openingBalancePaisa,
      periodIncomePaisa,
      totalAvailablePaisa: openingBalancePaisa + periodIncomePaisa,
      periodExpensePaisa,
      closingBalancePaisa: openingBalancePaisa + periodIncomePaisa - periodExpensePaisa,
      incomeByHead: toRows('income'),
      expenseByHead: toRows('expense'),
      periodTransactions: recentRows.map((row) => this.mapTxRow(row)),
      periodTransactionCount: Number(sums.period_count || 0),
      periodExpenseCount: Number(sums.period_expense_count || 0),
      incomeCount: Number(sums.income_count || 0),
      expenseCount: Number(sums.expense_count || 0),
    };
  }

  openTransactionExportSnapshot(
    query: TransactionListQuery = {},
    report?: { from: string; to: string; label: string },
  ): TransactionExportSnapshot {
    const reader = new DatabaseSync(SQLITE_FILE);
    reader.exec('PRAGMA busy_timeout = 10000');
    reader.exec('PRAGMA cache_size = -4096');
    reader.exec('PRAGMA query_only = ON');
    reader.exec('BEGIN');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { reader.exec('COMMIT'); } catch { try { reader.exec('ROLLBACK'); } catch { } }
      try { reader.close(); } catch { }
    };

    try {
      // This first read pins a consistent WAL snapshot even for an export without a summary.
      reader.prepare('SELECT COUNT(*) AS n FROM transactions').get();
      const summary = report
        ? this.getPeriodSummaryFromConnection(reader, report.from, report.to, report.label)
        : null;
      const { where, params, indexedSearch } = this.transactionWhere({ ...query, cursor: undefined, limit: undefined });
      const filterWhere = indexedSearch ? where.slice(0, -1) : where;
      const filterParams = indexedSearch ? params.slice(0, -3) : params;
      const filterSql = filterWhere.length ? filterWhere.join(' AND ') : '1=1';
      const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
      let fromClause = 'FROM transactions t';
      let whereSql = filterSql;
      let queryParams = [...filterParams];

      if (indexedSearch) {
        const matchingSources = (reader.prepare('SELECT id FROM fund_sources WHERE instr(lower(name), lower(?)) > 0')
          .all(indexedSearch) as Array<{ id: string }>).map((row) => String(row.id));
        const fundSourceUnion = matchingSources.length
          ? ` UNION SELECT rowid FROM transactions INDEXED BY idx_tx_active_fund_date
              WHERE deleted_at = '' AND fund_source_id IN (${matchingSources.map(() => '?').join(',')})`
          : '';
        const searchIds = `SELECT rowid FROM transactions_fts
          WHERE search_text LIKE ? AND instr(search_text, lower(?)) > 0${fundSourceUnion}`;
        fromClause = `FROM (${searchIds}) search_ids CROSS JOIN transactions t`;
        whereSql = `t.rowid = search_ids.rowid AND ${filterSql}`;
        queryParams = [`%${indexedSearch}%`, indexedSearch, ...matchingSources, ...filterParams];
      } else {
        const shortSearch = String(query.search || '').trim().length > 0;
        const pageIndex = query.employeeId ? 'idx_tx_active_employee_date'
          : query.head ? 'idx_tx_active_head_date'
            : query.fundSourceId ? 'idx_tx_active_fund_date'
              : query.department && query.department !== '__none__' ? 'idx_tx_active_dept_date'
                : query.paymentMethod ? 'idx_tx_active_method_date'
                  : query.kind && query.kind !== 'all' ? 'idx_tx_active_kind_date'
                    : !shortSearch ? 'idx_tx_active_date_created_id' : '';
        if (pageIndex && !query.includeDeleted) fromClause += ` INDEXED BY ${pageIndex}`;
      }

      const sql = `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
        ${fromClause}
        LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
        LEFT JOIN users u ON u.id = t.created_by_id
        WHERE ${whereSql}
        ORDER BY t.tx_date ${direction}, t.created_at ${direction}, t.id ${direction}`;
      const statement = reader.prepare(sql);
      const iterator = statement.iterate(...(queryParams as SqlValue[]));
      const self = this;
      const rows = (async function* (): AsyncGenerator<LedgerTransaction> {
        let count = 0;
        try {
          for (const row of iterator as Iterable<any>) {
            yield self.mapTxRow(row);
            count += 1;
            if (count % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } finally {
          close();
        }
      })();
      return { summary, rows, close };
    } catch (error) {
      close();
      throw error;
    }
  }

  getTransactionById(id: string): LedgerTransaction | null {
    const row = this.sqlite.get<any>(
      `SELECT t.*, fs.name AS fund_source_name, COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name
       FROM transactions t
       LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
       LEFT JOIN users u ON u.id = t.created_by_id
       WHERE t.id = ?`,
      [id],
    );
    return row ? this.mapTxRow(row) : null;
  }

  private nextVoucherNo(kind: 'income' | 'expense', txDate: string): string {
    const prefix = kind === 'income' ? 'INC' : 'EXP';
    const year = txDate.slice(0, 4);
    const stem = `${prefix}-${year}-`;
    const max = Number(this.sqlite.scalar<number>(
      'SELECT COALESCE(MAX(CAST(substr(voucher_no, ?) AS INTEGER)), 0) FROM transactions WHERE voucher_no GLOB ?',
      [stem.length + 1, `${stem}*`],
    ) || 0);
    return `${stem}${String(max + 1).padStart(4, '0')}`;
  }

  private insertLedgerTxInsideTx(
    input: ValidatedTxInput,
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): LedgerTransaction {
    this.assertPeriodUnlocked(input.txDate);
    this.assertFundSource(input.fundSourceId);
    if (input.kind === 'expense') this.assertFundSourceBalance(input.fundSourceId, input.amountPaisa);
    const id = crypto.randomUUID();
    const voucherNo = this.nextVoucherNo(input.kind, input.txDate);
    const now = new Date().toISOString();
    const verifiedBy = actor.role === 'admin' ? actor.displayName : '';
    const verifiedAt = actor.role === 'admin' ? now : '';

    let empId = input.employeeId || '';
    let empName = input.employeeName || '';
    if (empId) {
      const emp = this.getEmployeeById(empId);
      if (emp) empName = emp.name;
      else { empId = ''; empName = ''; }
    }

    this.sqlite.run(
      `INSERT INTO transactions (
        id, voucher_no, kind, tx_date, amount_paisa, department, department_review, head, sub_category, payment_method, reference_no,
        counterparty, counterparty_phone, purpose, notes, funded_by_tx_id,
        employee_id, employee_name, category_group,
        fund_source_id,
        receipt_sha, receipt_name, receipt_type, status, verified_by_name, verified_at, flag_note,
        edit_count, amount_changed, last_edited_at, last_edited_by, last_edit_reason, edit_history_json,
        created_at, created_by_id, created_by_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, '', 0, 0, '', '', '', '[]', ?, ?, ?, ?)`,
      [
        id,
        voucherNo,
        input.kind,
        input.txDate,
        input.amountPaisa,
        input.department,
        input.departmentReview ? 1 : 0,
        input.head,
        input.subCategory,
        input.paymentMethod,
        input.referenceNo,
        input.counterparty,
        input.counterpartyPhone,
        input.purpose,
        input.notes,
        input.fundedByTxId || '',
        empId,
        empName,
        input.categoryGroup || 'general',
        input.fundSourceId,
        receipt?.sha256 || '',
        receipt?.name || '',
        receipt?.type || '',
        verifiedBy,
        verifiedAt,
        now,
        actor.id,
        actor.displayName,
        now,
      ],
    );

    this.ensureHeadInsideTx(input.kind, input.head);
    this.ensureDepartmentInsideTx(input.department);
    const created = this.getTransactionById(id)!;
    this.appendAudit({
      actorId: actor.id,
      actorName: actor.displayName,
      actorRole: actor.role,
      eventType: 'tx_created',
      entryId: id,
      voucherNo,
      reason: input.purpose,
      diff: [],
      amountDeltaPaisa: input.kind === 'income' ? input.amountPaisa : -input.amountPaisa,
      afterSnapshotJson: txSnapshotForAudit(created),
    });
    this.logActivity(
      actor.displayName,
      input.kind === 'income' ? 'income_recorded' : 'expense_recorded',
      voucherNo,
      input.department || input.head,
      input.amountPaisa,
      `${input.counterparty} — ${input.purpose}`,
    );
    return created;
  }

  createTransaction(
    input: ValidatedTxInput,
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): LedgerTransaction {
    let headAdded = false;
    let deptAdded = false;
    const tx = this.transaction(() => {
      headAdded = this.ensureHeadInsideTx(input.kind, input.head);
      deptAdded = this.ensureDepartmentInsideTx(input.department);
      return this.insertLedgerTxInsideTx(input, actor, receipt);
    });
    this.notify('transactions');
    this.notify('fundSources');
    if (headAdded) this.notify('heads');
    if (deptAdded) this.notify('departments');
    return tx;
  }

  editTransaction(
    id: string,
    input: ValidatedTxInput,
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): LedgerTransaction {
    const updated = this.transaction(() => {
      const prev = this.getTransactionById(id);
      if (!prev) throw new Error('Transaction not found.');
      if (prev.deletedAt) throw new Error('Cannot edit a voided transaction. Restore it from Admin Bin first.');

      this.assertPeriodUnlocked(prev.txDate);
      this.assertPeriodUnlocked(input.txDate);
      this.assertFundSource(input.fundSourceId);
      if (input.kind === 'expense') this.assertFundSourceBalance(input.fundSourceId, input.amountPaisa, id);

      const linkedGroup = prev.categoryGroup || 'general';
      if (linkedGroup !== 'general' && (input.kind !== prev.kind || (input.categoryGroup || 'general') !== linkedGroup)) {
        throw new Error('The transaction type of a linked payroll, advance, rent, loan, or repayment entry cannot be changed.');
      }

      let empId = input.employeeId ?? (prev.employeeId || '');
      let empName = input.employeeName ?? (prev.employeeName || '');
      if (input.employeeId !== undefined) {
        if (input.employeeId) {
          const emp = this.getEmployeeById(input.employeeId);
          if (emp) { empId = emp.id; empName = emp.name; }
          else { empId = ''; empName = ''; }
        } else {
          empId = '';
          empName = '';
        }
      }

      const diffs: FieldDiff[] = [];
      const addDiff = (field: string, from: string, to: string) => {
        if (from !== to) diffs.push({ field, from, to });
      };

      addDiff('kind', prev.kind, input.kind);
      addDiff('txDate', prev.txDate, input.txDate);
      if (prev.amountPaisa !== input.amountPaisa) {
        diffs.push({
          field: 'amount',
          from: `৳${fromPaisa(prev.amountPaisa)}`,
          to: `৳${fromPaisa(input.amountPaisa)}`,
        });
      }
      addDiff('department', prev.department || '', input.department);
      addDiff('head', prev.head, input.head);
      const nextSource = this.getFundSourceById(input.fundSourceId);
      addDiff('fundSource', prev.fundSourceName || '', nextSource?.name || '');
      addDiff('subCategory', prev.subCategory, input.subCategory);
      addDiff('paymentMethod', prev.paymentMethod, input.paymentMethod);
      addDiff('referenceNo', prev.referenceNo, input.referenceNo);
      addDiff('counterparty', prev.counterparty, input.counterparty);
      addDiff('counterpartyPhone', prev.counterpartyPhone || '', input.counterpartyPhone);
      addDiff('employee', prev.employeeName || '', empName);
      addDiff('purpose', prev.purpose, input.purpose);
      addDiff('notes', prev.notes || '', input.notes);
      if (receipt) {
        addDiff('receipt', prev.receiptName || 'None', receipt.name);
      }

      if (linkedGroup !== 'general' && linkedGroup !== 'rent' && empId !== (prev.employeeId || '')) {
        throw new Error('The employee on a linked payroll, advance, loan, or repayment entry cannot be changed.');
      }

      if (linkedGroup === 'salary') {
        const salary = this.sqlite.get<any>('SELECT * FROM salary_payments WHERE linked_tx_id = ?', [id]);
        if (!salary) throw new Error('The linked salary payment record could not be found.');
        if (input.amountPaisa !== prev.amountPaisa) throw new Error('Salary amount is calculated from payroll fields. Adjust or reissue the salary through Payroll.');
        this.sqlite.run(
          `UPDATE salary_payments SET paid_date = ?, payment_method = ?, reference_no = ?, department = ?, head = ?, fund_source_id = ?, notes = ?, receipt_sha = ?, receipt_name = ?, receipt_type = ? WHERE id = ?`,
          [input.txDate, input.paymentMethod, input.referenceNo, input.department, input.head, input.fundSourceId, input.notes, receipt?.sha256 || salary.receipt_sha || '', receipt?.name || salary.receipt_name || '', receipt?.type || salary.receipt_type || '', salary.id],
        );
      } else if (linkedGroup === 'salary_advance') {
        const advance = this.sqlite.get<any>('SELECT * FROM employee_advances WHERE linked_tx_id = ?', [id]);
        if (!advance) throw new Error('The linked salary advance record could not be found.');
        const recovered = this.sqlite.get<{ total: number }>(
          'SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM salary_advance_repayments WHERE advance_id = ?',
          [advance.id],
        );
        const recoveredPaisa = Number(recovered?.total || 0);
        if (input.amountPaisa < recoveredPaisa) throw new Error('The advance amount cannot be lower than the amount already recovered through payroll.');
        const remaining = input.amountPaisa - recoveredPaisa;
        this.sqlite.run(
          `UPDATE employee_advances SET issued_date = ?, principal_paisa = ?, remaining_paisa = ?, department = ?, purpose = ?, fund_source_id = ?, status = ?, settled_at = ? WHERE id = ?`,
          [input.txDate, input.amountPaisa, remaining, input.department, input.purpose, input.fundSourceId, remaining > 0 ? 'active' : 'settled', remaining > 0 ? '' : String(advance.settled_at || new Date().toISOString()), advance.id],
        );
      } else if (linkedGroup === 'loan_issue') {
        const loan = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE linked_tx_id = ?', [id]);
        if (!loan) throw new Error('The linked employee loan record could not be found.');
        const recovered = this.sqlite.get<{ total: number }>(
          'SELECT COALESCE(SUM(amount_paisa), 0) AS total FROM loan_repayments WHERE loan_id = ?',
          [loan.id],
        );
        const recoveredPaisa = Number(recovered?.total || 0);
        if (input.amountPaisa < recoveredPaisa) throw new Error('The loan principal cannot be lower than the amount already repaid.');
        const remaining = input.amountPaisa - recoveredPaisa;
        this.sqlite.run(
          `UPDATE employee_loans SET issued_date = ?, principal_paisa = ?, remaining_paisa = ?, payment_method = ?, reference_no = ?, department = ?, head = ?, fund_source_id = ?, purpose = ?, status = ?, settled_at = ?, receipt_sha = ?, receipt_name = ?, receipt_type = ? WHERE id = ?`,
          [input.txDate, input.amountPaisa, remaining, input.paymentMethod, input.referenceNo, input.department, input.head, input.fundSourceId, input.purpose, remaining > 0 ? 'active' : 'settled', remaining > 0 ? '' : String(loan.settled_at || new Date().toISOString()), receipt?.sha256 || loan.receipt_sha || '', receipt?.name || loan.receipt_name || '', receipt?.type || loan.receipt_type || '', loan.id],
        );
      } else if (linkedGroup === 'loan_repayment') {
        const repayment = this.sqlite.get<any>('SELECT * FROM loan_repayments WHERE linked_tx_id = ?', [id]);
        if (!repayment || repayment.source !== 'cash') throw new Error('The linked cash loan repayment record could not be found.');
        const loan = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [repayment.loan_id]);
        if (!loan) throw new Error('The loan associated with this repayment could not be found.');
        const nextRemaining = Number(loan.remaining_paisa || 0) + Number(repayment.amount_paisa || 0) - input.amountPaisa;
        if (nextRemaining < 0) throw new Error('The repayment amount cannot exceed the remaining loan balance plus this repayment.');
        this.sqlite.run(
          `UPDATE loan_repayments SET paid_date = ?, amount_paisa = ?, department = ?, fund_source_id = ?, payment_method = ?, reference_no = ?, note = ?, receipt_sha = ?, receipt_name = ?, receipt_type = ? WHERE id = ?`,
          [input.txDate, input.amountPaisa, input.department, input.fundSourceId, input.paymentMethod, input.referenceNo, input.purpose, receipt?.sha256 || repayment.receipt_sha || '', receipt?.name || repayment.receipt_name || '', receipt?.type || repayment.receipt_type || '', repayment.id],
        );
        this.sqlite.run(
          'UPDATE employee_loans SET remaining_paisa = ?, status = ?, settled_at = ? WHERE id = ?',
          [nextRemaining, nextRemaining > 0 ? 'active' : 'settled', nextRemaining > 0 ? '' : String(loan.settled_at || new Date().toISOString()), loan.id],
        );
      } else if (linkedGroup === 'rent') {
        const rp = this.sqlite.get<any>('SELECT * FROM rent_payments WHERE linked_tx_id = ?', [id]);
        if (rp) {
          this.sqlite.run(
            `UPDATE rent_payments SET paid_date = ?, amount_paisa = ?, department = ?, fund_source_id = ?, payment_method = ?, reference_no = ?, notes = ?, receipt_sha = ?, receipt_name = ?, receipt_type = ? WHERE id = ?`,
            [input.txDate, input.amountPaisa, input.department, input.fundSourceId, input.paymentMethod, input.referenceNo, input.notes, receipt?.sha256 || rp.receipt_sha || '', receipt?.name || rp.receipt_name || '', receipt?.type || rp.receipt_type || '', rp.id],
          );
        }
      }

      if (diffs.length === 0) {
        throw new Error('No changes detected.');
      }

      const prevSigned = prev.kind === 'income' ? prev.amountPaisa : -prev.amountPaisa;
      const nextSigned = input.kind === 'income' ? input.amountPaisa : -input.amountPaisa;
      const signedDelta = nextSigned - prevSigned;
      const rawAmountChanged = prev.amountPaisa !== input.amountPaisa || prev.kind !== input.kind;
      const now = new Date().toISOString();

      const editEntry: TxEditEntry = {
        at: now,
        byId: actor.id,
        byName: actor.displayName,
        byRole: actor.role,
        reason: input.reason!,
        amountDeltaPaisa: rawAmountChanged ? input.amountPaisa - prev.amountPaisa : 0,
        changes: diffs,
      };
      const nextHistory = [...prev.editHistory, editEntry];
      const nextAmountChanged = prev.amountChanged || rawAmountChanged;
      const nextStatus = rawAmountChanged && actor.role !== 'admin' ? 'flagged' : prev.status;
      const flagNote = rawAmountChanged && actor.role !== 'admin'
        ? `Amount edited by ${actor.displayName}: ${input.reason}`
        : prev.flagNote || '';

      this.sqlite.run(
        `UPDATE transactions SET
          kind = ?, tx_date = ?, amount_paisa = ?, department = ?, department_review = 0, head = ?, sub_category = ?, payment_method = ?,
          reference_no = ?, counterparty = ?, counterparty_phone = ?, purpose = ?, notes = ?,
          employee_id = ?, employee_name = ?,
          category_group = ?, fund_source_id = ?,
          receipt_sha = ?, receipt_name = ?, receipt_type = ?,
          status = ?, flag_note = ?, edit_count = ?, amount_changed = ?,
          last_edited_at = ?, last_edited_by = ?, last_edit_reason = ?, edit_history_json = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.kind,
          input.txDate,
          input.amountPaisa,
          input.department,
          input.head,
          input.subCategory,
          input.paymentMethod,
          input.referenceNo,
          input.counterparty,
          input.counterpartyPhone,
          input.purpose,
          input.notes,
          empId,
          empName,
          input.categoryGroup || 'general',
          input.fundSourceId,
          receipt ? receipt.sha256 : prev.receiptSha || '',
          receipt ? receipt.name : prev.receiptName || '',
          receipt ? receipt.type : prev.receiptType || '',
          nextStatus,
          flagNote,
          prev.editCount + 1,
          nextAmountChanged ? 1 : 0,
          now,
          actor.displayName,
          input.reason!,
          JSON.stringify(nextHistory),
          now,
          id,
        ],
      );

      this.ensureHeadInsideTx(input.kind, input.head);
      this.ensureDepartmentInsideTx(input.department);
      const nextTx = this.getTransactionById(id)!;
      this.appendAudit({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        eventType: 'tx_edited',
        entryId: id,
        voucherNo: prev.voucherNo,
        reason: input.reason!,
        diff: diffs,
        amountDeltaPaisa: signedDelta,
        afterSnapshotJson: txSnapshotForAudit(nextTx),
      });
      this.logActivity(
        actor.displayName,
        'tx_edited',
        prev.voucherNo,
        input.department || input.head,
        input.amountPaisa,
        `${diffs.map((d) => d.field).join(', ')} — ${input.reason}`,
      );
      return nextTx;
    });
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('heads');
    this.notify('departments');
    if (updated.categoryGroup === 'salary') this.notify('salaries');
    if (updated.categoryGroup === 'salary_advance') this.notify('advances');
    if (updated.categoryGroup === 'loan_issue' || updated.categoryGroup === 'loan_repayment') this.notify('loans');
    if (updated.categoryGroup === 'rent') this.notify('rent');
    return updated;
  }

  verifyOrFlagTransaction(
    id: string,
    status: 'verified' | 'flagged',
    note: string,
    actor: AppUser,
  ): LedgerTransaction {
    const updated = this.transaction(() => {
      const prev = this.getTransactionById(id);
      if (!prev) throw new Error('Transaction not found.');
      const now = new Date().toISOString();
      const cleanNote = String(note || '').trim().slice(0, 300);
      this.sqlite.run(
        'UPDATE transactions SET status = ?, verified_by_name = ?, verified_at = ?, flag_note = ?, updated_at = ? WHERE id = ?',
        [status, status === 'verified' ? actor.displayName : prev.verifiedByName || '', status === 'verified' ? now : prev.verifiedAt || '', status === 'flagged' ? cleanNote : '', now, id],
      );
      const next = this.getTransactionById(id)!;
      this.appendAudit({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        eventType: status === 'verified' ? 'tx_verified' : 'tx_flagged',
        entryId: id,
        voucherNo: prev.voucherNo,
        reason: cleanNote || (status === 'verified' ? 'Verified by Finance Admin' : 'Flagged for review'),
        diff: [{ field: 'status', from: prev.status, to: status }],
        amountDeltaPaisa: 0,
        afterSnapshotJson: txSnapshotForAudit(next),
      });
      this.logActivity(actor.displayName, status === 'verified' ? 'tx_verified' : 'tx_flagged', prev.voucherNo, prev.head, prev.amountPaisa, cleanNote);
      return next;
    });
    this.notify('transactions');
    return updated;
  }

  private voidLinkedTransactionInsideTx(id: string, reason: string, actor: AppUser) {
    const cleanReason = String(reason || '').trim().slice(0, 300);
    const prev = this.getTransactionById(id);
    if (!prev || prev.deletedAt) return;
    this.assertPeriodUnlocked(prev.txDate);
    if (prev.kind === 'income' && prev.fundSourceId && this.fundSourceBalance(prev.fundSourceId, id) < 0) {
      throw new Error('This linked income cannot be reversed because its fund source balance would become negative.');
    }
    const now = new Date().toISOString();
    this.sqlite.run(
      'UPDATE transactions SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?',
      [now, actor.displayName, cleanReason, now, id],
    );
    const next = this.getTransactionById(id)!;
    this.appendAudit({
      actorId: actor.id,
      actorName: actor.displayName,
      actorRole: actor.role,
      eventType: 'tx_voided',
      entryId: id,
      voucherNo: prev.voucherNo,
      reason: cleanReason,
      diff: [{ field: 'deletedAt', from: '', to: now }],
      amountDeltaPaisa: prev.kind === 'income' ? -prev.amountPaisa : prev.amountPaisa,
      afterSnapshotJson: txSnapshotForAudit(next),
    });
    this.logActivity(actor.displayName, 'tx_voided', prev.voucherNo, prev.head, prev.amountPaisa, cleanReason);
  }

  softDeleteTransaction(id: string, reason: string, actor: AppUser) {
    const cleanReason = String(reason || '').trim().slice(0, 300);
    if (cleanReason.length < 4) throw new Error('Please provide a reason (at least 4 characters) for voiding this entry.');
    this.transaction(() => {
      const prev = this.getTransactionById(id);
      if (!prev) throw new Error('Transaction not found.');
      if (prev.deletedAt) throw new Error('Transaction is already in the Bin.');
      if ((prev.categoryGroup || 'general') !== 'general') {
        throw new Error('This entry is linked to payroll, an advance, a loan, or a repayment. Reverse it from its related management record to keep balances synchronized.');
      }
      this.assertPeriodUnlocked(prev.txDate);
      if (prev.kind === 'income' && prev.fundSourceId) {
        const balanceWithoutEntry = this.fundSourceBalance(prev.fundSourceId, id);
        if (balanceWithoutEntry < 0) throw new Error('This income cannot be voided because the fund source balance would become negative.');
      }
      const now = new Date().toISOString();
      this.sqlite.run(
        'UPDATE transactions SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?',
        [now, actor.displayName, cleanReason, now, id],
      );
      const next = this.getTransactionById(id)!;
      const signedDelta = prev.kind === 'income' ? -prev.amountPaisa : prev.amountPaisa;
      this.appendAudit({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        eventType: 'tx_voided',
        entryId: id,
        voucherNo: prev.voucherNo,
        reason: cleanReason,
        diff: [{ field: 'deletedAt', from: '', to: now }],
        amountDeltaPaisa: signedDelta,
        afterSnapshotJson: txSnapshotForAudit(next),
      });
      this.logActivity(actor.displayName, 'tx_voided', prev.voucherNo, prev.head, prev.amountPaisa, cleanReason);
    });
    this.notify('transactions');
    this.notify('fundSources');
  }

  restoreTransaction(id: string, actor: AppUser) {
    this.transaction(() => {
      const prev = this.getTransactionById(id);
      if (!prev || !prev.deletedAt) throw new Error('Transaction is not in the Bin.');
      if ((prev.categoryGroup || 'general') !== 'general') {
        throw new Error('This linked entry must be restored through its related payroll, advance, loan, or repayment record.');
      }
      this.assertPeriodUnlocked(prev.txDate);
      if (prev.kind === 'expense' && prev.fundSourceId) this.assertFundSourceBalance(prev.fundSourceId, prev.amountPaisa);
      const now = new Date().toISOString();
      this.sqlite.run(
        "UPDATE transactions SET deleted_at = '', deleted_by = '', delete_reason = '', updated_at = ? WHERE id = ?",
        [now, id],
      );
      const next = this.getTransactionById(id)!;
      const signedDelta = prev.kind === 'income' ? prev.amountPaisa : -prev.amountPaisa;
      this.appendAudit({
        actorId: actor.id,
        actorName: actor.displayName,
        actorRole: actor.role,
        eventType: 'tx_restored',
        entryId: id,
        voucherNo: prev.voucherNo,
        reason: 'Restored from Admin Bin',
        diff: [{ field: 'deletedAt', from: prev.deletedAt, to: '' }],
        amountDeltaPaisa: signedDelta,
        afterSnapshotJson: txSnapshotForAudit(next),
      });
      this.logActivity(actor.displayName, 'tx_restored', prev.voucherNo, prev.head, prev.amountPaisa, 'Restored from Bin');
    });
    this.notify('transactions');
    this.notify('fundSources');
  }

   

  private mapEmployeeRow(r: any): Employee {
    return {
      id: String(r.id),
      code: String(r.code),
      name: String(r.name),
      role: String(r.role),
      department: String(r.department || ''),
      branch: String(r.branch || ''),
      phone: String(r.phone || ''),
      email: String(r.email || ''),
      photoUrl: String(r.photo_url || ''),
      monthlySalaryPaisa: Number(r.monthly_salary_paisa || 0),
      joinedDate: String(r.joined_date || ''),
      active: Boolean(r.active),
      notes: String(r.notes || ''),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  getEmployees(): Employee[] {
    return this.sqlite
      .all<any>('SELECT * FROM employees ORDER BY active DESC, code ASC, name ASC')
      .map((r) => this.mapEmployeeRow(r));
  }

  getEmployeeById(id: string): Employee | null {
    const row = this.sqlite.get<any>('SELECT * FROM employees WHERE id = ?', [id]);
    return row ? this.mapEmployeeRow(row) : null;
  }

  private nextAdvanceNo(issuedDate: string): string {
    const year = issuedDate.slice(0, 4);
    const rows = this.sqlite.all<{ advance_no: string }>('SELECT advance_no FROM employee_advances WHERE advance_no LIKE ?', [`ADV-${year}-%`]);
    let max = 0;
    for (const row of rows) {
      const match = row.advance_no.match(/-(\d+)$/);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `ADV-${year}-${String(max + 1).padStart(4, '0')}`;
  }

  private mapAdvanceRow(row: any, repayments: EmployeeAdvanceRepayment[]): EmployeeAdvance {
    const source = this.getFundSourceById(String(row.fund_source_id || ''));
    return {
      id: String(row.id),
      advanceNo: String(row.advance_no),
      employeeId: String(row.employee_id),
      employeeName: String(row.employee_name),
      monthKey: String(row.month_key || String(row.issued_date || '').slice(0, 7)),
      issuedDate: String(row.issued_date),
      principalPaisa: Number(row.principal_paisa || 0),
      remainingPaisa: Number(row.remaining_paisa || 0),
      department: String(row.department || ''),
      purpose: String(row.purpose),
      fundSourceId: String(row.fund_source_id || ''),
      fundSourceName: source?.name || '',
      linkedTxId: String(row.linked_tx_id || ''),
      linkedVoucherNo: String(row.linked_voucher_no || ''),
      status: row.status === 'settled' ? 'settled' : 'active',
      createdAt: String(row.created_at),
      repayments,
    };
  }

  getSalaryAdvances(): EmployeeAdvance[] {
    const rows = this.sqlite.all<any>('SELECT * FROM employee_advances ORDER BY issued_date DESC, created_at DESC');
    const repaymentRows = this.sqlite.all<any>('SELECT * FROM salary_advance_repayments ORDER BY paid_date DESC, created_at DESC');
    const byAdvance = new Map<string, EmployeeAdvanceRepayment[]>();
    for (const row of repaymentRows) {
      const advanceId = String(row.advance_id);
      const list = byAdvance.get(advanceId) || [];
      list.push({
        id: String(row.id),
        advanceId,
        salaryPaymentId: String(row.salary_payment_id),
        paidDate: String(row.paid_date),
        amountPaisa: Number(row.amount_paisa || 0),
        createdAt: String(row.created_at),
      });
      byAdvance.set(advanceId, list);
    }
    return rows.map((row) => this.mapAdvanceRow(row, byAdvance.get(String(row.id)) || []));
  }

  createSalaryAdvance(
    input: {
      employeeId: string;
      monthKey: string;
      issuedDate: string;
      amountPaisa: number;
      department: string;
      fundSourceId: string;
      paymentMethod: string;
      purpose: string;
    },
    actor: AppUser,
  ): EmployeeAdvance {
    const result = this.transaction(() => {
      const employee = this.getEmployeeById(input.employeeId);
      if (!employee) throw new Error('Employee not found.');
      const advanceNo = this.nextAdvanceNo(input.issuedDate);
      const ledgerTx = this.insertLedgerTxInsideTx({
        kind: 'expense',
        txDate: input.issuedDate,
        amountPaisa: input.amountPaisa,
        department: input.department,
        head: 'SALARY-ADVANCE',
        subCategory: 'Salary Advance',
        paymentMethod: input.paymentMethod,
        referenceNo: advanceNo,
        counterparty: employee.name,
        counterpartyPhone: employee.phone,
        purpose: input.purpose,
        notes: `Payroll cycle: ${input.monthKey}`,
        employeeId: employee.id,
        employeeName: employee.name,
        categoryGroup: 'salary_advance',
        fundSourceId: input.fundSourceId,
      }, actor);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      this.sqlite.run(
        `INSERT INTO employee_advances (
          id, advance_no, employee_id, employee_name, month_key, issued_date, principal_paisa, remaining_paisa,
          department, purpose, fund_source_id, linked_tx_id, linked_voucher_no, status, created_by_id, created_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [id, advanceNo, employee.id, employee.name, input.monthKey, input.issuedDate, input.amountPaisa, input.amountPaisa, input.department, input.purpose, input.fundSourceId, ledgerTx.id, ledgerTx.voucherNo, actor.id, actor.displayName, now],
      );
      this.logActivity(actor.displayName, 'salary_advance_issued', advanceNo, employee.name, input.amountPaisa, input.purpose);
      return this.mapAdvanceRow(this.sqlite.get<any>('SELECT * FROM employee_advances WHERE id = ?', [id])!, []);
    });
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('advances');
    this.notify('employees');
    this.notify('activity');
    return result;
  }

  deleteSalaryAdvance(id: string, actor: AppUser): void {
    this.transaction(() => {
      const adv = this.sqlite.get<any>('SELECT * FROM employee_advances WHERE id = ?', [id]);
      if (!adv) throw new Error('Salary advance record not found.');
      this.assertPeriodUnlocked(String(adv.issued_date));
      const linkedTxId = String(adv.linked_tx_id || '');
      if (linkedTxId) {
        this.voidLinkedTransactionInsideTx(linkedTxId, `Salary advance ${adv.advance_no} deleted`, actor);
      }
      this.sqlite.run('DELETE FROM salary_advance_repayments WHERE advance_id = ?', [id]);
      this.sqlite.run('DELETE FROM employee_advances WHERE id = ?', [id]);
      this.logActivity(actor.displayName, 'salary_advance_deleted', String(adv.advance_no), String(adv.employee_name), Number(adv.principal_paisa || 0), `Deleted advance ${adv.advance_no}`);
    });
    this.notify('advances');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
  }

  private nextEmployeeCode(): string {
    const rows = this.sqlite.all<{ code: string }>('SELECT code FROM employees');
    let max = 0;
    for (const r of rows) {
      const m = r.code.match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `EMP-${String(max + 1).padStart(3, '0')}`;
  }

  createEmployee(
    input: {
      name: string;
      role: string;
      department: string;
      branch: string;
      phone: string;
      email: string;
      joinedDate: string;
      notes: string;
      code?: string;
      monthlySalaryPaisa?: number;
      photoUrl?: string;
    },
    actor: AppUser,
  ): Employee {
    const emp = this.transaction(() => {
      const id = crypto.randomUUID();
      const code = input.code || this.nextEmployeeCode();
      const dup = this.sqlite.get<{ id: string }>('SELECT id FROM employees WHERE code = ?', [code]);
      if (dup) throw new Error(`Employee code "${code}" already exists.`);
      const now = new Date().toISOString();
      const photo = input.photoUrl ? cleanPhotoUrl(input.photoUrl) : '';
      this.sqlite.run(
        `INSERT INTO employees (
          id, code, name, role, department, branch, phone, email, photo_url,
          monthly_salary_paisa, joined_date, active, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
          id,
          code,
          input.name,
          input.role,
          input.department,
          input.branch,
          input.phone,
          input.email,
          photo,
          input.monthlySalaryPaisa ?? 0,
          input.joinedDate || now.slice(0, 10),
          input.notes,
          now,
          now,
        ],
      );
      this.logActivity(actor.displayName, 'employee_added', code, input.branch, input.monthlySalaryPaisa ?? 0, input.name);
      return this.getEmployeeById(id)!;
    });
    this.notify('employees');
    return emp;
  }

  updateEmployee(
    id: string,
    patch: {
      name?: string;
      role?: string;
      department?: string;
      branch?: string;
      phone?: string;
      email?: string;
      joinedDate?: string;
      notes?: string;
      monthlySalaryPaisa?: number;
      active?: boolean;
      photoUrl?: string;
    },
    actor: AppUser,
  ): Employee {
    const emp = this.transaction(() => {
      const prev = this.getEmployeeById(id);
      if (!prev) throw new Error('Employee not found.');
      const now = new Date().toISOString();
      const nextName = patch.name && patch.name.length >= 2 ? patch.name : prev.name;
      const photo = patch.photoUrl !== undefined ? cleanPhotoUrl(patch.photoUrl) : (prev.photoUrl || '');
      this.sqlite.run(
        `UPDATE employees SET
          name = ?, role = ?, department = ?, branch = ?, phone = ?, email = ?,
          photo_url = ?, monthly_salary_paisa = ?, joined_date = ?, active = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
        [
          nextName,
          patch.role ?? prev.role,
          patch.department ?? prev.department,
          patch.branch ?? prev.branch,
          patch.phone ?? prev.phone,
          patch.email ?? (prev.email || ''),
          photo,
          patch.monthlySalaryPaisa ?? prev.monthlySalaryPaisa,
          patch.joinedDate || prev.joinedDate,
          patch.active === undefined ? (prev.active ? 1 : 0) : (patch.active ? 1 : 0),
          patch.notes ?? (prev.notes || ''),
          now,
          id,
        ],
      );
      if (nextName !== prev.name) {
        this.sqlite.run('UPDATE transactions SET employee_name = ? WHERE employee_id = ?', [nextName, id]);
        this.sqlite.run('UPDATE salary_payments SET employee_name = ? WHERE employee_id = ?', [nextName, id]);
        this.sqlite.run('UPDATE employee_loans SET employee_name = ? WHERE employee_id = ?', [nextName, id]);
      }
      this.logActivity(actor.displayName, 'employee_updated', prev.code, patch.branch ?? prev.branch, 0, nextName);
      return this.getEmployeeById(id)!;
    });
    this.notify('employees');
    this.notify('transactions');
    return emp;
  }

   

  private mapSalaryRow(r: any): SalaryPayment {
    return {
      id: String(r.id),
      employeeId: String(r.employee_id),
      employeeName: String(r.employee_name),
      monthKey: String(r.month_key),
      paidDate: String(r.paid_date),
      baseSalaryPaisa: Number(r.base_salary_paisa || 0),
      bonusPaisa: Number(r.bonus_paisa || 0),
      loanDeductionPaisa: Number(r.loan_deduction_paisa || 0),
      advanceDeductionPaisa: Number(r.advance_deduction_paisa || 0),
      otherDeductionPaisa: Number(r.other_deduction_paisa || 0),
      netPaidPaisa: Number(r.net_paid_paisa || 0),
      paymentMethod: String(r.payment_method),
      referenceNo: String(r.reference_no || ''),
      department: String(r.department || r.head || ''),
      head: String(r.head),
      fundSourceId: String(r.fund_source_id || ''),
      notes: String(r.notes || ''),
      receiptSha: String(r.receipt_sha || ''),
      receiptName: String(r.receipt_name || ''),
      receiptType: String(r.receipt_type || ''),
      linkedTxId: String(r.linked_tx_id || ''),
      linkedVoucherNo: String(r.linked_voucher_no || ''),
      paidById: String(r.paid_by_id),
      paidByName: String(r.resolved_paid_by_name || r.paid_by_name),
      createdAt: String(r.created_at),
    };
  }

  getSalaryPayments(monthKey?: string): SalaryPayment[] {
    if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) {
      return this.sqlite
        .all<any>(
          `SELECT sp.*, COALESCE(u.display_name, sp.paid_by_name) AS resolved_paid_by_name
           FROM salary_payments sp LEFT JOIN users u ON u.id = sp.paid_by_id
           WHERE sp.month_key = ? ORDER BY sp.paid_date DESC, sp.created_at DESC`,
          [monthKey],
        )
        .map((r) => this.mapSalaryRow(r));
    }
    return this.sqlite
      .all<any>(
        `SELECT sp.*, COALESCE(u.display_name, sp.paid_by_name) AS resolved_paid_by_name
         FROM salary_payments sp LEFT JOIN users u ON u.id = sp.paid_by_id
         ORDER BY sp.month_key DESC, sp.paid_date DESC, sp.created_at DESC`,
      )
      .map((r) => this.mapSalaryRow(r));
  }

  payEmployeeSalary(
    input: {
      employeeId: string;
      monthKey: string;
      paidDate: string;
      baseSalaryPaisa: number;
      bonusPaisa: number;
      otherDeductionPaisa: number;
      payAmountPaisa?: number;
      paymentMethod: string;
      referenceNo: string;
      department: string;
      head: string;
      fundSourceId: string;
      notes: string;
    },
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): { payment: SalaryPayment } {
    const out = this.transaction(() => {
      const emp = this.getEmployeeById(input.employeeId);
      if (!emp) throw new Error('Employee not found.');
      this.assertPeriodUnlocked(input.paidDate);
      this.assertFundSource(input.fundSourceId);

      // Only an administrator may set or override a base salary. Everyone else pays the
      // salary configured on the employee record and cannot supply one of their own.
      const isAdminActor = actor.role === 'admin';
      const configuredBase = emp.monthlySalaryPaisa > 0 ? emp.monthlySalaryPaisa : (isAdminActor ? input.baseSalaryPaisa : 0);
      const effectiveBase = input.baseSalaryPaisa > 0 && isAdminActor ? input.baseSalaryPaisa : configuredBase;
      if (effectiveBase <= 0) {
        throw new Error(isAdminActor
          ? `Set monthly salary for ${emp.name} in Employees before recording payroll.`
          : `Monthly salary for ${emp.name} is not set. Ask an administrator to set it in Employees before recording payroll.`);
      }

      const existingPayments = this.sqlite.all<any>(
        'SELECT * FROM salary_payments WHERE employee_id = ? AND month_key = ?',
        [emp.id, input.monthKey],
      );
      const prevDisbursedPaisa = existingPayments.reduce((s, r) => s + Number(r.net_paid_paisa || 0), 0);
      const prevBonusPaisa = existingPayments.reduce((s, r) => s + Number(r.bonus_paisa || 0), 0);
      const prevOtherDeductionPaisa = existingPayments.reduce((s, r) => s + Number(r.other_deduction_paisa || 0), 0);

      const periodAdvances = this.sqlite.all<any>(
        'SELECT * FROM employee_advances WHERE employee_id = ? AND month_key = ? ORDER BY issued_date ASC, created_at ASC',
        [emp.id, input.monthKey],
      );
      const totalAdvancesForPeriod = periodAdvances.reduce((s, a) => s + Number(a.principal_paisa || 0), 0);
      const remainingBeforeThisPaisa = Math.max(
        0,
        effectiveBase + prevBonusPaisa + input.bonusPaisa - prevOtherDeductionPaisa - input.otherDeductionPaisa - totalAdvancesForPeriod - prevDisbursedPaisa,
      );

      if (remainingBeforeThisPaisa <= 0) {
        throw new Error(`${emp.name}'s salary for ${input.monthKey} is already fully settled.`);
      }

      const netPaidPaisa = input.payAmountPaisa !== undefined ? input.payAmountPaisa : remainingBeforeThisPaisa;
      if (netPaidPaisa <= 0) {
        throw new Error('Salary payment amount must be greater than ৳0.00.');
      }
      if (netPaidPaisa > remainingBeforeThisPaisa) {
        throw new Error(
          `Payment (৳${fromPaisa(netPaidPaisa)}) exceeds remaining payable salary (৳${fromPaisa(remainingBeforeThisPaisa)}) for ${input.monthKey}.`,
        );
      }
      this.assertFundSourceBalance(input.fundSourceId, netPaidPaisa);

      const now = new Date().toISOString();
      const salId = crypto.randomUUID();
      const slipRef = input.referenceNo || `SAL-${input.monthKey}-${emp.code}-${existingPayments.length + 1}`;
      const remainingAfterThis = remainingBeforeThisPaisa - netPaidPaisa;
      let advanceCoveredNow = 0;

      if (remainingAfterThis === 0) {
        for (const advance of periodAdvances) {
          const activeRem = Number(advance.remaining_paisa || 0);
          if (activeRem <= 0) continue;
          advanceCoveredNow += activeRem;
          this.sqlite.run(
            "UPDATE employee_advances SET remaining_paisa = 0, status = 'settled', settled_at = ? WHERE id = ?",
            [now, advance.id],
          );
          this.sqlite.run(
            `INSERT INTO salary_advance_repayments (id, advance_id, salary_payment_id, paid_date, amount_paisa, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), advance.id, salId, input.paidDate, activeRem, now],
          );
        }
      }

      const salaryTx = this.insertLedgerTxInsideTx({
        kind: 'expense',
        txDate: input.paidDate,
        amountPaisa: netPaidPaisa,
        department: input.department,
        head: input.head || input.department,
        subCategory: remainingAfterThis === 0 ? 'Employee Salary' : 'Employee Salary (Partial)',
        paymentMethod: input.paymentMethod,
        referenceNo: slipRef,
        counterparty: emp.name,
        counterpartyPhone: emp.phone,
        purpose: `${input.monthKey} salary payment${remainingAfterThis > 0 ? ' (partial)' : ''}`,
        notes: input.notes,
        employeeId: emp.id,
        employeeName: emp.name,
        categoryGroup: 'salary',
        fundSourceId: input.fundSourceId,
      }, actor, receipt);

      this.sqlite.run(
        `INSERT INTO salary_payments (
          id, employee_id, employee_name, month_key, paid_date, base_salary_paisa, bonus_paisa,
          loan_deduction_paisa, advance_deduction_paisa, other_deduction_paisa, net_paid_paisa,
          payment_method, reference_no, department, head, fund_source_id, notes, receipt_sha, receipt_name, receipt_type,
          linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          salId,
          emp.id,
          emp.name,
          input.monthKey,
          input.paidDate,
          effectiveBase,
          input.bonusPaisa,
          advanceCoveredNow,
          input.otherDeductionPaisa,
          netPaidPaisa,
          input.paymentMethod,
          slipRef,
          input.department,
          input.head || input.department,
          input.fundSourceId,
          input.notes,
          receipt?.sha256 || '',
          receipt?.name || '',
          receipt?.type || '',
          salaryTx.id,
          salaryTx.voucherNo,
          actor.id,
          actor.displayName,
          now,
        ],
      );

      this.logActivity(actor.displayName, 'salary_paid', slipRef, emp.name, netPaidPaisa, `${input.monthKey} salary paid`);
      const payment = this.mapSalaryRow(this.sqlite.get<any>('SELECT * FROM salary_payments WHERE id = ?', [salId])!);
      return { payment };
    });

    this.notify('salaries');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
    this.notify('advances');
    return out;
  }

  deleteSalaryPayment(id: string, actor: AppUser): void {
    let hadLoanRollback = false;
    this.transaction(() => {
      const sal = this.sqlite.get<any>('SELECT * FROM salary_payments WHERE id = ?', [id]);
      if (!sal) throw new Error('Salary payment record not found.');
      this.assertPeriodUnlocked(String(sal.paid_date));
      const linkedTxId = String(sal.linked_tx_id || '');
      if (linkedTxId) this.voidLinkedTransactionInsideTx(linkedTxId, `Salary payment ${sal.reference_no || sal.month_key} deleted`, actor);

      const linkedRepayments = this.sqlite.all<any>(
        'SELECT * FROM loan_repayments WHERE salary_payment_id = ?',
        [id],
      );
      for (const rp of linkedRepayments) {
        hadLoanRollback = true;
        const loan = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [rp.loan_id]);
        if (loan) {
          const nextRem = Math.min(Number(loan.principal_paisa || 0), Number(loan.remaining_paisa || 0) + Number(rp.amount_paisa || 0));
          this.sqlite.run(
            'UPDATE employee_loans SET remaining_paisa = ?, status = ?, settled_at = ? WHERE id = ?',
            [nextRem, nextRem > 0 ? 'active' : 'settled', nextRem > 0 ? '' : String(loan.settled_at || ''), loan.id],
          );
        }
        this.sqlite.run('DELETE FROM loan_repayments WHERE id = ?', [rp.id]);
      }

      const advanceRepayments = this.sqlite.all<any>(
        'SELECT * FROM salary_advance_repayments WHERE salary_payment_id = ?',
        [id],
      );
      for (const repayment of advanceRepayments) {
        const advance = this.sqlite.get<any>('SELECT * FROM employee_advances WHERE id = ?', [repayment.advance_id]);
        if (advance) {
          const nextRemaining = Math.min(Number(advance.principal_paisa || 0), Number(advance.remaining_paisa || 0) + Number(repayment.amount_paisa || 0));
          this.sqlite.run(
            'UPDATE employee_advances SET remaining_paisa = ?, status = ?, settled_at = ? WHERE id = ?',
            [nextRemaining, nextRemaining > 0 ? 'active' : 'settled', nextRemaining > 0 ? '' : String(advance.settled_at || ''), advance.id],
          );
        }
        this.sqlite.run('DELETE FROM salary_advance_repayments WHERE id = ?', [repayment.id]);
      }

      this.sqlite.run('DELETE FROM salary_payments WHERE id = ?', [id]);
      this.logActivity(actor.displayName, 'salary_deleted', String(sal.reference_no || sal.month_key), String(sal.employee_name), Number(sal.net_paid_paisa || 0), `Deleted ${sal.month_key} salary payment`);
    });

    this.notify('salaries');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('advances');
    this.notify('activity');
    if (hadLoanRollback) this.notify('loans');
  }

   

  private mapLoanRow(r: any, repayments: LoanRepayment[]): EmployeeLoan {
    return {
      id: String(r.id),
      loanNo: String(r.loan_no),
      employeeId: String(r.employee_id),
      employeeName: String(r.employee_name),
      issuedDate: String(r.issued_date),
      principalPaisa: Number(r.principal_paisa || 0),
      remainingPaisa: Number(r.remaining_paisa || 0),
      monthlyInstallmentPaisa: Number(r.monthly_installment_paisa || 0),
      paymentMethod: String(r.payment_method),
      referenceNo: String(r.reference_no || ''),
      department: String(r.department || r.head || ''),
      head: String(r.head),
      fundSourceId: String(r.fund_source_id || ''),
      purpose: String(r.purpose),
      status: r.status === 'settled' ? 'settled' : 'active',
      receiptSha: String(r.receipt_sha || ''),
      receiptName: String(r.receipt_name || ''),
      receiptType: String(r.receipt_type || ''),
      linkedTxId: String(r.linked_tx_id || ''),
      linkedVoucherNo: String(r.linked_voucher_no || ''),
      issuedById: String(r.issued_by_id),
      issuedByName: String(r.resolved_issued_by_name || r.issued_by_name),
      createdAt: String(r.created_at),
      settledAt: String(r.settled_at || ''),
      repayments,
    };
  }

  getLoans(): EmployeeLoan[] {
    const loanRows = this.sqlite.all<any>(
      `SELECT el.*, COALESCE(u.display_name, el.issued_by_name) AS resolved_issued_by_name
       FROM employee_loans el LEFT JOIN users u ON u.id = el.issued_by_id
       ORDER BY el.status ASC, el.issued_date DESC, el.created_at DESC`,
    );
    const repayRows = this.sqlite.all<any>(
      `SELECT lr.*, COALESCE(u.display_name, lr.recorded_by_name) AS resolved_recorded_by_name
       FROM loan_repayments lr LEFT JOIN users u ON u.id = lr.recorded_by_id
       ORDER BY lr.paid_date DESC, lr.created_at DESC`,
    );
    const byLoan = new Map<string, LoanRepayment[]>();
    for (const r of repayRows) {
      const lid = String(r.loan_id);
      const list = byLoan.get(lid) || [];
      list.push({
        id: String(r.id),
        loanId: lid,
        paidDate: String(r.paid_date),
        amountPaisa: Number(r.amount_paisa || 0),
        source: r.source === 'salary_deduction' ? 'salary_deduction' : r.source === 'historical' ? 'historical' : 'cash',
        fundSourceId: String(r.fund_source_id || ''),
        fundSourceName: String(this.getFundSourceById(String(r.fund_source_id || ''))?.name || ''),
        department: String(r.department || ''),
        paymentMethod: String(r.payment_method),
        referenceNo: String(r.reference_no || ''),
        note: String(r.note || ''),
        salaryPaymentId: String(r.salary_payment_id || ''),
        receiptSha: String(r.receipt_sha || ''),
        receiptName: String(r.receipt_name || ''),
        receiptType: String(r.receipt_type || ''),
        linkedTxId: String(r.linked_tx_id || ''),
        linkedVoucherNo: String(r.linked_voucher_no || ''),
        recordedById: String(r.recorded_by_id),
        recordedByName: String(r.resolved_recorded_by_name || r.recorded_by_name),
        createdAt: String(r.created_at),
      });
      byLoan.set(lid, list);
    }
    return loanRows.map((r) => this.mapLoanRow(r, byLoan.get(String(r.id)) || []));
  }

  private nextLoanNo(issuedDate: string): string {
    const year = issuedDate.slice(0, 4);
    const rows = this.sqlite.all<{ loan_no: string }>('SELECT loan_no FROM employee_loans WHERE loan_no LIKE ?', [`LN-${year}-%`]);
    let max = 0;
    for (const r of rows) {
      const m = r.loan_no.match(/-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `LN-${year}-${String(max + 1).padStart(4, '0')}`;
  }

  issueLoan(
    input: {
      employeeId: string;
      issuedDate: string;
      principalPaisa: number;
      monthlyInstallmentPaisa: number;
      paymentMethod: string;
      referenceNo: string;
      department: string;
      head: string;
      fundSourceId: string;
      purpose: string;
    },
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): { loan: EmployeeLoan } {
    const out = this.transaction(() => {
      const emp = this.getEmployeeById(input.employeeId);
      if (!emp) throw new Error('Employee not found.');
      const loanId = crypto.randomUUID();
      const loanNo = this.nextLoanNo(input.issuedDate);
      const now = new Date().toISOString();
      const ledgerTx = this.insertLedgerTxInsideTx({
        kind: 'expense',
        txDate: input.issuedDate,
        amountPaisa: input.principalPaisa,
        department: input.department,
        head: input.head || input.department,
        subCategory: 'Employee Loan',
        paymentMethod: input.paymentMethod,
        referenceNo: input.referenceNo || loanNo,
        counterparty: emp.name,
        counterpartyPhone: emp.phone,
        purpose: input.purpose,
        notes: '',
        employeeId: emp.id,
        employeeName: emp.name,
        categoryGroup: 'loan_issue',
        fundSourceId: input.fundSourceId,
      }, actor, receipt);

      this.sqlite.run(
        `INSERT INTO employee_loans (
          id, loan_no, employee_id, employee_name, issued_date, principal_paisa, remaining_paisa,
          monthly_installment_paisa, payment_method, reference_no, department, head, fund_source_id, purpose, status,
          receipt_sha, receipt_name, receipt_type,
          linked_tx_id, linked_voucher_no, issued_by_id, issued_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          loanId,
          loanNo,
          emp.id,
          emp.name,
          input.issuedDate,
          input.principalPaisa,
          input.principalPaisa,
          input.monthlyInstallmentPaisa,
          input.paymentMethod,
          input.referenceNo || loanNo,
          input.department,
          input.head || input.department,
          input.fundSourceId,
          input.purpose,
          receipt?.sha256 || '',
          receipt?.name || '',
          receipt?.type || '',
          ledgerTx.id,
          ledgerTx.voucherNo,
          actor.id,
          actor.displayName,
          now,
        ],
      );

      this.logActivity(actor.displayName, 'loan_issued', loanNo, emp.name, input.principalPaisa, input.purpose);
      const row = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [loanId])!;
      return { loan: this.mapLoanRow(row, []) };
    });

    this.notify('loans');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
    return out;
  }

  repayLoan(
    loanId: string,
    input: {
      paidDate: string;
      amountPaisa: number;
      paymentMethod: string;
      referenceNo: string;
      department: string;
      head: string;
      fundSourceId: string;
      note: string;
    },
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): { loan: EmployeeLoan; repayment: LoanRepayment } {
    const out = this.transaction(() => {
      const row = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [loanId]);
      if (!row) throw new Error('Loan record not found.');
      const rem = Number(row.remaining_paisa || 0);
      if (row.status === 'settled' || rem <= 0) throw new Error('This loan is already settled.');
      if (input.amountPaisa > rem) throw new Error(`Repayment cannot exceed remaining balance (৳${fromPaisa(rem)}).`);
      this.assertPeriodUnlocked(input.paidDate);
      const employee = this.getEmployeeById(String(row.employee_id));
      const now = new Date().toISOString();
      const nextRem = rem - input.amountPaisa;
      const nextStatus = nextRem === 0 ? 'settled' : 'active';
      const repayId = crypto.randomUUID();
      const repaymentRef = input.referenceNo || String(row.loan_no);
      const ledgerTx = this.insertLedgerTxInsideTx({
        kind: 'income',
        txDate: input.paidDate,
        amountPaisa: input.amountPaisa,
        department: input.department,
        head: input.head,
        subCategory: 'Loan Repayment',
        paymentMethod: input.paymentMethod,
        referenceNo: repaymentRef,
        counterparty: String(row.employee_name),
        counterpartyPhone: employee?.phone || '',
        purpose: input.note || `Repayment for ${row.loan_no}`,
        notes: '',
        employeeId: String(row.employee_id),
        employeeName: String(row.employee_name),
        categoryGroup: 'loan_repayment',
        fundSourceId: input.fundSourceId,
      }, actor, receipt);

      this.sqlite.run(
        'UPDATE employee_loans SET remaining_paisa = ?, status = ?, settled_at = ? WHERE id = ?',
        [nextRem, nextStatus, nextRem === 0 ? now : '', loanId],
      );
      this.sqlite.run(
        `INSERT INTO loan_repayments (
          id, loan_id, paid_date, amount_paisa, source, fund_source_id, department, payment_method, reference_no, note,
          salary_payment_id, receipt_sha, receipt_name, receipt_type,
          linked_tx_id, linked_voucher_no, recorded_by_id, recorded_by_name, created_at
        ) VALUES (?, ?, ?, ?, 'cash', ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          repayId, loanId, input.paidDate, input.amountPaisa, input.fundSourceId, input.department, input.paymentMethod,
          repaymentRef, input.note || 'Cash return', receipt?.sha256 || '', receipt?.name || '', receipt?.type || '',
          ledgerTx.id, ledgerTx.voucherNo, actor.id, actor.displayName, now,
        ],
      );
      this.logActivity(actor.displayName, 'loan_repaid', String(row.loan_no), String(row.employee_name), input.amountPaisa, input.note || 'Cash return');
      const updated = this.getLoans().find((loan) => loan.id === loanId)!;
      const repayment = updated.repayments.find((item) => item.id === repayId)!;
      return { loan: updated, repayment };
    });

    this.notify('loans');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
    return out;
  }

  /**
   * Record a repayment that is already represented in a cash-book transaction.
   * This updates the loan register without creating a second ledger income row.
   */
  recordHistoricalLoanRepayment(
    loanId: string,
    input: {
      paidDate: string;
      amountPaisa: number;
      paymentMethod: string;
      referenceNo: string;
      department: string;
      head: string;
      fundSourceId: string;
      note: string;
    },
    actor: AppUser,
  ): { loan: EmployeeLoan; repayment: LoanRepayment } {
    const out = this.transaction(() => {
      const row = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [loanId]);
      if (!row) throw new Error('Loan record not found.');
      const remaining = Number(row.remaining_paisa || 0);
      if (row.status === 'settled' || remaining <= 0) throw new Error('This loan is already settled.');
      if (input.amountPaisa > remaining) throw new Error(`Repayment cannot exceed remaining balance (৳${fromPaisa(remaining)}).`);
      this.assertPeriodUnlocked(input.paidDate);
      this.assertFundSource(input.fundSourceId);
      const now = new Date().toISOString();
      const nextRemaining = remaining - input.amountPaisa;
      const nextStatus = nextRemaining === 0 ? 'settled' : 'active';
      const repaymentId = crypto.randomUUID();
      const repaymentRef = input.referenceNo || String(row.loan_no);

      this.sqlite.run(
        'UPDATE employee_loans SET remaining_paisa = ?, status = ?, settled_at = ? WHERE id = ?',
        [nextRemaining, nextStatus, nextRemaining === 0 ? now : '', loanId],
      );
      this.sqlite.run(
        `INSERT INTO loan_repayments (
          id, loan_id, paid_date, amount_paisa, source, fund_source_id, department, payment_method, reference_no, note,
          salary_payment_id, receipt_sha, receipt_name, receipt_type, linked_tx_id, linked_voucher_no,
          recorded_by_id, recorded_by_name, created_at
        ) VALUES (?, ?, ?, ?, 'historical', ?, ?, ?, ?, ?, '', '', '', '', '', '', ?, ?, ?)`,
        [
          repaymentId, loanId, input.paidDate, input.amountPaisa, input.fundSourceId, input.department,
          input.paymentMethod, repaymentRef, input.note || 'Already represented in cash book',
          actor.id, actor.displayName, now,
        ],
      );
      this.logActivity(actor.displayName, 'loan_repaid', String(row.loan_no), String(row.employee_name), input.amountPaisa,
        `Historical repayment already represented in cash book: ${input.note || 'Excel import'}`);
      const updated = this.getLoans().find((loan) => loan.id === loanId)!;
      const repayment = updated.repayments.find((item) => item.id === repaymentId)!;
      return { loan: updated, repayment };
    });

    this.notify('loans');
    this.notify('activity');
    return out;
  }

  deleteLoan(loanId: string, actor: AppUser): void {
    this.transaction(() => {
      const row = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [loanId]);
      if (!row) throw new Error('Loan record not found.');
      const repaymentRows = this.sqlite.all<any>('SELECT * FROM loan_repayments WHERE loan_id = ?', [loanId]);
      const txIds = [String(row.linked_tx_id || ''), ...repaymentRows.map((repayment) => String(repayment.linked_tx_id || ''))].filter(Boolean);
      const reversalBySource = new Map<string, number>();
      for (const txId of txIds) {
        const tx = this.getTransactionById(txId);
        if (!tx || tx.deletedAt || !tx.fundSourceId) continue;
        reversalBySource.set(tx.fundSourceId, (reversalBySource.get(tx.fundSourceId) || 0) + (tx.kind === 'income' ? -tx.amountPaisa : tx.amountPaisa));
      }
      for (const [sourceId, reversal] of reversalBySource) {
        if (this.fundSourceBalance(sourceId) + reversal < 0) throw new Error('This loan cannot be deleted because reversing its cash repayments would make a fund source balance negative.');
      }
      for (const txId of txIds) this.voidLinkedTransactionInsideTx(txId, `Loan ${row.loan_no} deleted`, actor);
      this.sqlite.run('DELETE FROM loan_repayments WHERE loan_id = ?', [loanId]);
      this.sqlite.run('DELETE FROM employee_loans WHERE id = ?', [loanId]);
      this.logActivity(actor.displayName, 'loan_deleted', String(row.loan_no), String(row.employee_name), Number(row.principal_paisa || 0), `Deleted loan ${row.loan_no}`);
    });
    this.notify('loans');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
  }

  deleteLoanRepayment(loanId: string, repaymentId: string, actor: AppUser): EmployeeLoan {
    const updated = this.transaction(() => {
      const loan = this.sqlite.get<any>('SELECT * FROM employee_loans WHERE id = ?', [loanId]);
      if (!loan) throw new Error('Loan record not found.');
      const rp = this.sqlite.get<any>('SELECT * FROM loan_repayments WHERE id = ? AND loan_id = ?', [repaymentId, loanId]);
      if (!rp) throw new Error('Loan repayment record not found.');
      if (rp.source === 'salary_deduction') throw new Error('This repayment is part of payroll. Delete the related salary payment to reverse it.');
      const linkedTxId = String(rp.linked_tx_id || '');
      if (linkedTxId) this.voidLinkedTransactionInsideTx(linkedTxId, `Loan repayment on ${loan.loan_no} deleted`, actor);

      this.sqlite.run('DELETE FROM loan_repayments WHERE id = ?', [repaymentId]);
      const nextRem = Math.min(
        Number(loan.principal_paisa || 0),
        Number(loan.remaining_paisa || 0) + Number(rp.amount_paisa || 0),
      );
      const nextStatus = nextRem > 0 ? 'active' : 'settled';
      this.sqlite.run(
        'UPDATE employee_loans SET remaining_paisa = ?, status = ?, settled_at = ? WHERE id = ?',
        [nextRem, nextStatus, nextRem > 0 ? '' : String(loan.settled_at || ''), loanId],
      );
      this.logActivity(
        actor.displayName,
        'loan_repayment_deleted',
        String(loan.loan_no),
        String(loan.employee_name),
        Number(rp.amount_paisa || 0),
        `Deleted repayment on ${loan.loan_no}`,
      );
      return this.getLoans().find((l) => l.id === loanId)!;
    });
    this.notify('loans');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
    return updated;
  }

  private mapRentItemRow(r: any): RentItem {
    return {
      id: String(r.id),
      sl: Number(r.sl || 0),
      name: String(r.name),
      category: r.category === 'urgent' ? 'urgent' : 'regular',
      monthlyAmountPaisa: Number(r.monthly_amount_paisa || 0),
      urgentAmountPaisa: Number(r.urgent_amount_paisa || 0),
      department: String(r.department || ''),
      notes: String(r.notes || ''),
      active: Boolean(r.active),
      sortOrder: Number(r.sort_order || 0),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  getRentItems(): RentItem[] {
    return this.sqlite
      .all<any>('SELECT * FROM rent_items ORDER BY active DESC, sort_order ASC, sl ASC, name ASC')
      .map((r) => this.mapRentItemRow(r));
  }

  createRentItem(
    input: {
      name?: string;
      category?: 'regular' | 'urgent';
      monthlyAmountPaisa?: number;
      urgentAmountPaisa?: number;
      department?: string;
      notes?: string;
      sl?: number;
    },
    actor: AppUser,
  ): RentItem {
    const created = this.transaction(() => {
      const name = String(input.name || '').trim();
      if (!name) throw new Error('Rent item name is required.');
      const dup = this.sqlite.get<{ id: string }>('SELECT id FROM rent_items WHERE LOWER(name) = LOWER(?)', [name]);
      if (dup) throw new Error(`Rent item "${name}" already exists.`);
      const maxOrder = Number(this.sqlite.scalar('SELECT COALESCE(MAX(sort_order), 0) FROM rent_items') || 0);
      const maxSl = Number(this.sqlite.scalar('SELECT COALESCE(MAX(sl), 0) FROM rent_items') || 0);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const cat = input.category === 'urgent' || ((input.urgentAmountPaisa ?? 0) > 0 && (input.monthlyAmountPaisa ?? 0) === 0) ? 'urgent' : 'regular';
      this.sqlite.run(
        `INSERT INTO rent_items (
          id, sl, name, category, monthly_amount_paisa, urgent_amount_paisa, department, notes, active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
          id,
          input.sl && input.sl > 0 ? input.sl : maxSl + 1,
          name,
          cat,
          input.monthlyAmountPaisa ?? 0,
          input.urgentAmountPaisa ?? 0,
          input.department || '',
          input.notes || '',
          maxOrder + 1,
          now,
          now,
        ],
      );
      if (input.department) this.ensureDepartmentInsideTx(input.department);
      this.logActivity(actor.displayName, 'rent_item_added', '', name, (input.monthlyAmountPaisa ?? 0) + (input.urgentAmountPaisa ?? 0), `Added rent obligation ${name}`);
      return this.mapRentItemRow(this.sqlite.get<any>('SELECT * FROM rent_items WHERE id = ?', [id])!);
    });
    this.notify('rent');
    this.notify('departments');
    return created;
  }

  updateRentItem(
    id: string,
    patch: {
      name?: string;
      category?: 'regular' | 'urgent';
      monthlyAmountPaisa?: number;
      urgentAmountPaisa?: number;
      department?: string;
      notes?: string;
      sl?: number;
      active?: boolean;
    },
    actor: AppUser,
  ): RentItem {
    const updated = this.transaction(() => {
      const prev = this.sqlite.get<any>('SELECT * FROM rent_items WHERE id = ?', [id]);
      if (!prev) throw new Error('Rent item not found.');
      const nextName = patch.name !== undefined ? String(patch.name).trim() : String(prev.name);
      if (!nextName || nextName.length < 2) throw new Error('Rent item name must be at least 2 characters.');
      const dup = this.sqlite.get<{ id: string }>('SELECT id FROM rent_items WHERE LOWER(name) = LOWER(?) AND id != ?', [nextName, id]);
      if (dup) throw new Error(`Rent item "${nextName}" already exists.`);
      const nextCat = patch.category ?? (prev.category === 'urgent' ? 'urgent' : 'regular');
      const nextMonthly = patch.monthlyAmountPaisa ?? Number(prev.monthly_amount_paisa || 0);
      const nextUrgent = patch.urgentAmountPaisa ?? Number(prev.urgent_amount_paisa || 0);
      const nextDept = patch.department ?? String(prev.department || '');
      const nextNotes = patch.notes ?? String(prev.notes || '');
      const nextSl = patch.sl ?? Number(prev.sl || 0);
      const nextActive = patch.active === undefined ? Boolean(prev.active) : Boolean(patch.active);
      const now = new Date().toISOString();
      this.sqlite.run(
        `UPDATE rent_items SET
          sl = ?, name = ?, category = ?, monthly_amount_paisa = ?, urgent_amount_paisa = ?,
          department = ?, notes = ?, active = ?, updated_at = ?
         WHERE id = ?`,
        [nextSl, nextName, nextCat, nextMonthly, nextUrgent, nextDept, nextNotes, nextActive ? 1 : 0, now, id],
      );
      if (nextName !== prev.name) {
        this.sqlite.run('UPDATE rent_payments SET rent_item_name = ? WHERE rent_item_id = ?', [nextName, id]);
      }
      if (nextDept) this.ensureDepartmentInsideTx(nextDept);
      this.logActivity(actor.displayName, 'rent_item_updated', '', nextName, nextMonthly + nextUrgent, `Updated rent obligation ${nextName}`);
      return this.mapRentItemRow(this.sqlite.get<any>('SELECT * FROM rent_items WHERE id = ?', [id])!);
    });
    this.notify('rent');
    return updated;
  }

  deleteRentItem(id: string, actor: AppUser): void {
    this.transaction(() => {
      const prev = this.sqlite.get<any>('SELECT * FROM rent_items WHERE id = ?', [id]);
      if (!prev) throw new Error('Rent item not found.');
      const payCount = Number(this.sqlite.scalar('SELECT COUNT(*) FROM rent_payments WHERE rent_item_id = ?', [id]) || 0);
      if (payCount > 0) {
        this.sqlite.run('UPDATE rent_items SET active = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
        this.logActivity(actor.displayName, 'rent_item_archived', '', String(prev.name), 0, 'Archived rent obligation with payment history');
      } else {
        this.sqlite.run('DELETE FROM rent_items WHERE id = ?', [id]);
        this.logActivity(actor.displayName, 'rent_item_deleted', '', String(prev.name), 0, 'Deleted rent obligation');
      }
    });
    this.notify('rent');
  }

  getRentPayments(monthKey?: string): RentPayment[] {
    const sql = monthKey && /^\d{4}-\d{2}$/.test(monthKey)
      ? `SELECT rp.*, fs.name AS fund_source_name, COALESCE(u.display_name, rp.paid_by_name) AS resolved_paid_by_name
         FROM rent_payments rp
         LEFT JOIN fund_sources fs ON fs.id = rp.fund_source_id
         LEFT JOIN users u ON u.id = rp.paid_by_id
         WHERE rp.month_key = ?
         ORDER BY rp.paid_date DESC, rp.created_at DESC`
      : `SELECT rp.*, fs.name AS fund_source_name, COALESCE(u.display_name, rp.paid_by_name) AS resolved_paid_by_name
         FROM rent_payments rp
         LEFT JOIN fund_sources fs ON fs.id = rp.fund_source_id
         LEFT JOIN users u ON u.id = rp.paid_by_id
         ORDER BY rp.month_key DESC, rp.paid_date DESC, rp.created_at DESC`;
    const rows = monthKey && /^\d{4}-\d{2}$/.test(monthKey) ? this.sqlite.all<any>(sql, [monthKey]) : this.sqlite.all<any>(sql);
    return rows.map((r) => ({
      id: String(r.id),
      rentItemId: String(r.rent_item_id),
      rentItemName: String(r.rent_item_name),
      monthKey: String(r.month_key),
      paidDate: String(r.paid_date),
      amountPaisa: Number(r.amount_paisa || 0),
      department: String(r.department || ''),
      fundSourceId: String(r.fund_source_id || ''),
      fundSourceName: String(r.fund_source_name || ''),
      paymentMethod: String(r.payment_method),
      referenceNo: String(r.reference_no || ''),
      notes: String(r.notes || ''),
      receiptSha: String(r.receipt_sha || ''),
      receiptName: String(r.receipt_name || ''),
      receiptType: String(r.receipt_type || ''),
      linkedTxId: String(r.linked_tx_id || ''),
      linkedVoucherNo: String(r.linked_voucher_no || ''),
      paidById: String(r.paid_by_id),
      paidByName: String(r.resolved_paid_by_name || r.paid_by_name),
      createdAt: String(r.created_at),
    }));
  }

  payRentItem(
    input: {
      rentItemId: string;
      monthKey: string;
      paidDate: string;
      amountPaisa: number;
      department: string;
      fundSourceId: string;
      paymentMethod: string;
      referenceNo: string;
      notes: string;
    },
    actor: AppUser,
    receipt?: { sha256: string; name: string; type: string },
  ): RentPayment {
    const out = this.transaction(() => {
      const item = this.sqlite.get<any>('SELECT * FROM rent_items WHERE id = ?', [input.rentItemId]);
      if (!item) throw new Error('Rent obligation item not found.');
      const now = new Date().toISOString();
      const rpId = crypto.randomUUID();
      const ref = input.referenceNo || `RENT-${input.monthKey}-${String(item.sl || 1).padStart(2, '0')}`;
      const ledgerTx = this.insertLedgerTxInsideTx({
        kind: 'expense',
        txDate: input.paidDate,
        amountPaisa: input.amountPaisa,
        department: input.department,
        head: input.department,
        subCategory: 'Office Rent & Utility',
        paymentMethod: input.paymentMethod,
        referenceNo: ref,
        counterparty: String(item.name),
        counterpartyPhone: '',
        purpose: `${input.monthKey} rent/bill payment — ${item.name}`,
        notes: input.notes,
        categoryGroup: 'rent',
        fundSourceId: input.fundSourceId,
      }, actor, receipt);

      this.sqlite.run(
        `INSERT INTO rent_payments (
          id, rent_item_id, rent_item_name, month_key, paid_date, amount_paisa, department, fund_source_id,
          payment_method, reference_no, notes, receipt_sha, receipt_name, receipt_type,
          linked_tx_id, linked_voucher_no, paid_by_id, paid_by_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          rpId,
          item.id,
          item.name,
          input.monthKey,
          input.paidDate,
          input.amountPaisa,
          input.department,
          input.fundSourceId,
          input.paymentMethod,
          ref,
          input.notes,
          receipt?.sha256 || '',
          receipt?.name || '',
          receipt?.type || '',
          ledgerTx.id,
          ledgerTx.voucherNo,
          actor.id,
          actor.displayName,
          now,
        ],
      );
      this.logActivity(actor.displayName, 'rent_paid', ledgerTx.voucherNo, String(item.name), input.amountPaisa, `${input.monthKey} rent paid`);
      return this.getRentPayments().find((x) => x.id === rpId)!;
    });
    this.notify('rent');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
    return out;
  }

  deleteRentPayment(id: string, actor: AppUser): void {
    this.transaction(() => {
      const rp = this.sqlite.get<any>('SELECT * FROM rent_payments WHERE id = ?', [id]);
      if (!rp) throw new Error('Rent payment record not found.');
      this.assertPeriodUnlocked(String(rp.paid_date));
      const linkedTxId = String(rp.linked_tx_id || '');
      if (linkedTxId) {
        this.voidLinkedTransactionInsideTx(linkedTxId, `Rent payment for ${rp.rent_item_name} (${rp.month_key}) deleted`, actor);
      }
      this.sqlite.run('DELETE FROM rent_payments WHERE id = ?', [id]);
      this.logActivity(actor.displayName, 'rent_payment_deleted', String(rp.linked_voucher_no || rp.month_key), String(rp.rent_item_name), Number(rp.amount_paisa || 0), `Deleted ${rp.month_key} rent payment`);
    });
    this.notify('rent');
    this.notify('transactions');
    this.notify('fundSources');
    this.notify('activity');
  }

  getAuditChain(limit = 400): AuditChainEntry[] {
    const rows = this.sqlite.all<any>(
      `SELECT la.*, COALESCE(u.display_name, la.actor_name) AS resolved_actor_name
       FROM ledger_audit la LEFT JOIN users u ON u.id = la.actor_id
       ORDER BY la.seq DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      actorId: String(r.actor_id),
      actorName: String(r.resolved_actor_name || r.actor_name),
      actorRole: String(r.actor_role),
      eventType: String(r.event_type),
      entryId: String(r.entry_id),
      voucherNo: String(r.voucher_no || ''),
      reason: String(r.reason),
      diff: (() => { try { return JSON.parse(r.diff_json || '[]'); } catch { return []; } })(),
      amountDeltaPaisa: Number(r.amount_delta_paisa || 0),
      prevHash: String(r.prev_hash),
      entryHash: String(r.entry_hash),
    }));
  }

  verifyAuditChain(): ChainVerificationResult {
    const brokenLinks: ChainVerificationResult['brokenLinks'] = [];
    const stateMismatches: ChainVerificationResult['stateMismatches'] = [];
    let expectedPrev = 'GENESIS_PACE_IT_LEDGER';
    let totalEntries = 0;

    // Keep the latest audited snapshot per transaction in a temporary SQLite table,
    // not a large JavaScript Map. This bounds Node heap growth on very large ledgers.
    // The separate connection reads one WAL snapshot and only writes to its TEMP DB,
    // so integrity verification does not take a write lock on the live ledger.
    const reader = new DatabaseSync(SQLITE_FILE);
    try {
      reader.exec('PRAGMA busy_timeout = 10000');
      reader.exec('PRAGMA cache_size = -4096');
      reader.exec('PRAGMA temp_store = FILE');
      reader.exec(`CREATE TEMP TABLE audit_latest_tx_snapshot (
        entry_id TEXT PRIMARY KEY,
        voucher_no TEXT NOT NULL DEFAULT '',
        after_snapshot_json TEXT NOT NULL
      ) WITHOUT ROWID`);
      reader.exec('BEGIN');

      const latestSnapshot = reader.prepare(`
        INSERT INTO temp.audit_latest_tx_snapshot (entry_id, voucher_no, after_snapshot_json)
        VALUES (?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET
          voucher_no = excluded.voucher_no,
          after_snapshot_json = excluded.after_snapshot_json
      `);
      const transactionEvents = new Set(['tx_created', 'tx_edited', 'tx_voided', 'tx_restored', 'tx_verified', 'tx_flagged']);

      // Stream the immutable append-only chain in sequence order and recompute every hash.
      for (const r of reader.prepare('SELECT * FROM ledger_audit ORDER BY seq ASC').iterate() as Iterable<any>) {
        totalEntries += 1;
        if (String(r.prev_hash) !== expectedPrev) {
          brokenLinks.push({ seq: Number(r.seq), voucherNo: String(r.voucher_no || ''), issue: 'Previous hash link mismatch' });
        }
        const recomputed = computeAuditHash({
          seq: Number(r.seq),
          at: String(r.at),
          actorId: String(r.actor_id),
          eventType: String(r.event_type),
          entryId: String(r.entry_id),
          voucherNo: String(r.voucher_no || ''),
          reason: String(r.reason),
          diffJson: String(r.diff_json || '[]'),
          amountDeltaPaisa: Number(r.amount_delta_paisa || 0),
          afterSnapshotJson: String(r.after_snapshot_json || '{}'),
          prevHash: String(r.prev_hash),
        });
        if (recomputed !== String(r.entry_hash)) {
          brokenLinks.push({ seq: Number(r.seq), voucherNo: String(r.voucher_no || ''), issue: 'Entry hash mismatch (record altered directly in DB)' });
        }
        expectedPrev = String(r.entry_hash);

        if (transactionEvents.has(String(r.event_type))) {
          latestSnapshot.run(String(r.entry_id), String(r.voucher_no || ''), String(r.after_snapshot_json || '{}'));
        }
      }

      // Compare live transaction state to the latest audited snapshot using a join.
      // Only the current row and its JSON snapshot are resident in JavaScript at once.
      const transactionRows = reader.prepare(
        `SELECT t.*, fs.name AS fund_source_name,
          COALESCE(u.display_name, t.created_by_name) AS resolved_created_by_name,
          a.after_snapshot_json AS audit_expected_snapshot
         FROM transactions t
         LEFT JOIN fund_sources fs ON fs.id = t.fund_source_id
         LEFT JOIN users u ON u.id = t.created_by_id
         LEFT JOIN temp.audit_latest_tx_snapshot a ON a.entry_id = t.id`,
      );
      for (const row of transactionRows.iterate() as Iterable<any>) {
        const tx = this.mapTxRow(row);
        const expectedSnap = row.audit_expected_snapshot;
        if (expectedSnap === null || expectedSnap === undefined) {
          stateMismatches.push({ txId: tx.id, voucherNo: tx.voucherNo, issue: 'Transaction exists without an audit chain entry' });
          continue;
        }
        const actualSnap = txSnapshotForAudit(tx);
        if (actualSnap !== String(expectedSnap)) {
          stateMismatches.push({ txId: tx.id, voucherNo: tx.voucherNo, issue: 'Transaction values differ from the latest audited snapshot' });
        }
      }

      // Any latest transaction snapshot without a corresponding row is a hard delete.
      const deletedRows = reader.prepare(
        `SELECT a.entry_id, a.voucher_no FROM temp.audit_latest_tx_snapshot a
         LEFT JOIN transactions t ON t.id = a.entry_id WHERE t.id IS NULL`,
      );
      for (const row of deletedRows.iterate() as Iterable<any>) {
        const txId = String(row.entry_id);
        stateMismatches.push({ txId, voucherNo: String(row.voucher_no || txId.slice(0, 8)), issue: 'Transaction was hard-deleted outside the application' });
      }

      reader.exec('COMMIT');
    } finally {
      try { reader.exec('ROLLBACK'); } catch { }
      reader.close();
    }

    return {
      ok: brokenLinks.length === 0 && stateMismatches.length === 0,
      totalEntries,
      checkedAt: new Date().toISOString(),
      brokenLinks,
      stateMismatches,
    };
  }

  getActivity(limit = 120): ActivityEvent[] {
    return this.sqlite
      .all<any>('SELECT * FROM activity ORDER BY at DESC LIMIT ?', [limit])
      .map((r) => ({
        id: String(r.id),
        at: String(r.at),
        by: String(r.by_user),
        action: String(r.action),
        voucherNo: String(r.voucher_no || ''),
        head: String(r.head || ''),
        amountPaisa: Number(r.amount_paisa || 0),
        detail: String(r.detail || ''),
      }));
  }

   

  storeReceipt(base64Data: string, name: string): { sha256: string; name: string; type: string } {
    const clean = String(base64Data || '').trim().replace(/^data:[^;]+;base64,/, '');
    if (!clean || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
      throw new Error('Invalid receipt file encoding.');
    }
    const bytes = Buffer.from(clean, 'base64');
    if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
      throw new Error('Receipt file must be under 10 MB.');
    }
    let mime: string | null = null;
    if (bytes.subarray(0, 1024).includes('%PDF-', 0, 'latin1')) mime = 'application/pdf';
    else if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') mime = 'image/png';
    else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
    if (!mime) throw new Error('Receipt must be a JPG, PNG, or PDF file.');

    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const safeName = String(name || 'receipt').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'receipt';
    const existing = this.sqlite.get<{ sha: string }>('SELECT sha FROM receipt_files WHERE sha = ?', [sha256]);
    if (!existing) {
      this.sqlite.run(
        'INSERT INTO receipt_files (sha, name, mime_type, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [sha256, safeName, mime, bytes.length, bytes, new Date().toISOString()],
      );
    }
    return { sha256, name: safeName, type: mime };
  }

  readReceipt(sha: string): { bytes: Buffer; mimeType: string } | null {
    if (!isSha(sha)) return null;
    const row = this.sqlite.get<{ data: Uint8Array; mime_type: string }>(
      'SELECT data, mime_type FROM receipt_files WHERE sha = ?',
      [sha],
    );
    if (!row || !row.data) return null;
    return { bytes: Buffer.from(row.data), mimeType: String(row.mime_type || 'application/octet-stream') };
  }

  async *streamFullBackupJson(batchSize = 200): AsyncGenerator<string> {
    const tableNames = [
      'departments', 'ledger_heads', 'fund_sources', 'employees', 'transactions',
      'salary_payments', 'employee_advances', 'salary_advance_repayments', 'employee_loans',
      'loan_repayments', 'rent_items', 'rent_payments', 'period_locks', 'ledger_audit',
      'receipt_files', 'activity', 'settings',
    ];
    const safeBatchSize = Math.max(25, Math.min(1000, Math.trunc(batchSize) || 200));
    // Use a separate read connection. A read transaction on the application's single
    // synchronous connection would prevent its own request handlers from beginning writes.
    const reader = new DatabaseSync(SQLITE_FILE);
    reader.exec('PRAGMA busy_timeout = 5000');
    reader.exec('PRAGMA cache_size = -4096');
    reader.exec('PRAGMA query_only = ON');
    reader.exec('BEGIN');
    try {
      const counts: Record<string, number> = {};
      for (const table of tableNames) {
        counts[table] = Number((reader.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n || 0);
      }
      const headerJson = JSON.stringify({
        format: FULL_BACKUP_FORMAT,
        version: 3,
        appName: 'Pace IT Ledger',
        exportedAt: new Date().toISOString(),
        counts,
      });
      yield `${headerJson.slice(0, -1)},"tables":{`;

      for (let tableIndex = 0; tableIndex < tableNames.length; tableIndex += 1) {
        const table = tableNames[tableIndex];
        const columns = (reader.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name);
        if (tableIndex > 0) yield ',';
        yield `${JSON.stringify(table)}:{"columns":${JSON.stringify(columns)},"rows":[`;
        let firstRow = true;
        let batch: string[] = [];
        let emitted = 0;
        const statement = reader.prepare(`SELECT * FROM ${table}`);
        for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
          const values = columns.map((column) => {
            const value = row[column];
            return value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
          });
          batch.push(`${firstRow ? '' : ','}${JSON.stringify(values)}`);
          firstRow = false;
          emitted += 1;
          if (batch.length >= safeBatchSize) {
            yield batch.join('');
            batch = [];
            // Yield to the event loop to keep request handling responsive; Readable.from
            // also applies backpressure when the client downloads slowly.
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
        if (batch.length) yield batch.join('');
        yield ']}';
        if (emitted !== counts[table]) throw new Error(`Backup snapshot changed while reading table ${table}.`);
      }
      yield '}}';
      reader.exec('COMMIT');
    } finally {
      try { reader.exec('ROLLBACK'); } catch { }
      reader.close();
    }
  }

  exportFullBackup() {
    const tableNames = [
      'departments',
      'ledger_heads',
      'fund_sources',
      'employees',
      'transactions',
      'salary_payments',
      'employee_advances',
      'salary_advance_repayments',
      'employee_loans',
      'loan_repayments',
      'rent_items',
      'rent_payments',
      'period_locks',
      'ledger_audit',
      'receipt_files',
      'activity',
      'settings',
    ];
    const tables: Record<string, { columns: string[]; rows: unknown[][] }> = {};
    const counts: Record<string, number> = {};
    for (const t of tableNames) {
      const cols = this.sqlite.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
      const data = this.sqlite.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
      tables[t] = {
        columns: cols,
        rows: data.map((row) =>
          cols.map((c) => {
            const v = row[c];
            if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
            return v;
          }),
        ),
      };
      counts[t] = data.length;
    }
    return {
      format: FULL_BACKUP_FORMAT,
      version: 3,
      appName: 'Pace IT Ledger',
      exportedAt: new Date().toISOString(),
      counts,
      tables,
    };
  }

  restoreSqliteSnapshot(snapshotPath: string, actor: AppUser): { transactionCount: number; previousDatabasePath: string } {
    if (!fs.existsSync(snapshotPath)) throw new Error('Uploaded SQLite backup file was not found.');
    const candidate = new DatabaseSync(snapshotPath);
    const previousConnection = this.sqlite;
    let snapshotInfo = { transactionCount: 0, auditCount: 0 };
    try {
      candidate.exec('PRAGMA busy_timeout = 10000');
      candidate.exec('PRAGMA foreign_keys = OFF');
      this.sqlite = new NativeDb(candidate);
      const requiredTables = ['transactions', 'ledger_audit', 'users', 'schema_migrations'];
      for (const table of requiredTables) {
        const exists = candidate.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        if (!exists) throw new Error(`SQLite backup is missing required table: ${table}.`);
      }
      this.createSchema();
      this.seedDefaultHeads();
      this.seedDefaultDepartments();
      this.seedDefaultFundSources();
      const check = candidate.prepare('PRAGMA quick_check').get() as any;
      if (check?.quick_check !== 'ok') throw new Error(`SQLite backup integrity check failed: ${String(check?.quick_check || 'unknown')}.`);
      const chain = this.verifyAuditChain();
      if (!chain.ok) throw new Error('SQLite backup audit-chain verification failed. The current database was not replaced.');
      snapshotInfo = {
        transactionCount: Number(candidate.prepare('SELECT COUNT(*) AS n FROM transactions').get()?.n || 0),
        auditCount: Number(candidate.prepare('SELECT COUNT(*) AS n FROM ledger_audit').get()?.n || 0),
      };
    } finally {
      this.sqlite = previousConnection;
      try { candidate.close(); } catch { }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let previousDatabasePath = `${SQLITE_FILE}.pre-restore-${stamp}`;
    if (fs.existsSync(previousDatabasePath)) previousDatabasePath += `-${crypto.randomBytes(3).toString('hex')}`;
    const failedDatabasePath = `${SQLITE_FILE}.rejected-${stamp}`;
    let oldMoved = false;
    let newMoved = false;

    try {
      this.sqlite.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.sqlite.raw.close();
      for (const sidecar of [`${SQLITE_FILE}-wal`, `${SQLITE_FILE}-shm`]) {
        try { fs.rmSync(sidecar, { force: true }); } catch { }
      }
      fs.renameSync(SQLITE_FILE, previousDatabasePath);
      oldMoved = true;
      fs.renameSync(snapshotPath, SQLITE_FILE);
      newMoved = true;
      this.openDatabaseConnection();
      this.createSchema();
      this.seedDefaultHeads();
      this.seedDefaultDepartments();
      this.seedDefaultFundSources();
      const finalCheck = this.sqlite.raw.prepare('PRAGMA quick_check').get() as any;
      if (finalCheck?.quick_check !== 'ok') throw new Error(`Restored database integrity check failed: ${String(finalCheck?.quick_check || 'unknown')}.`);
      const finalChain = this.verifyAuditChain();
      if (!finalChain.ok) throw new Error('Restored database audit-chain verification failed. Previous database was retained.');
      try {
        this.sqlite.run("INSERT INTO transactions_fts(transactions_fts, rank) VALUES ('integrity-check', 1)");
      } catch (error) {
        // FTS5 is not present in very old snapshots until the schema migrations run.
        if (!/no such table/i.test(String((error as any)?.message || ''))) throw error;
      }
      this.logSecurity('restore', { username: actor.username, detail: 'Restored SQLite database snapshot' });
      this.logActivity(actor.displayName, 'sqlite_backup_restored', '', '', 0,
        `Restored ${snapshotInfo.transactionCount.toLocaleString('en-US')} transactions and ${snapshotInfo.auditCount.toLocaleString('en-US')} audit entries`);
    } catch (error) {
      try { this.sqlite.raw.close(); } catch { }
      if (newMoved && fs.existsSync(SQLITE_FILE)) {
        try { fs.renameSync(SQLITE_FILE, failedDatabasePath); } catch { }
      }
      if (oldMoved && fs.existsSync(previousDatabasePath)) {
        for (const sidecar of [`${SQLITE_FILE}-wal`, `${SQLITE_FILE}-shm`]) {
          try { fs.rmSync(sidecar, { force: true }); } catch { }
        }
        try { fs.renameSync(previousDatabasePath, SQLITE_FILE); } catch { }
      }
      try { this.openDatabaseConnection(); this.createSchema(); } catch (reopenError) {
        console.error('[Pace IT Ledger] Could not reopen the previous database after restore failure:', reopenError);
      }
      throw error;
    }

    this.notify('transactions');
    this.notify('locks');
    this.notify('heads');
    this.notify('departments');
    this.notify('employees');
    this.notify('salaries');
    this.notify('loans');
    this.notify('rent');
    this.notify('fundSources');
    this.notify('advances');
    this.notify('activity');
    this.notify('users');
    return { transactionCount: snapshotInfo.transactionCount, previousDatabasePath };
  }

  restoreFullBackup(raw: any, actor: AppUser) {
    validateFullBackupShape(raw);
    this.transaction(() => {
      const tableNames = [
        'departments',
        'ledger_heads',
        'fund_sources',
        'employees',
        'transactions',
        'salary_payments',
        'employee_advances',
        'salary_advance_repayments',
        'employee_loans',
        'loan_repayments',
        'rent_items',
        'rent_payments',
        'period_locks',
        'ledger_audit',
        'receipt_files',
        'activity',
        'settings',
      ];
      for (const t of tableNames) {
        this.sqlite.run(`DELETE FROM ${t}`);
        if (!raw.tables[t]) continue;
        const { columns: allColumns, rows: allRows } = raw.tables[t];
        const validCols = new Set(this.sqlite.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name));
        const dropped = new Set<string>(t === 'transactions' ? ['fund_request_id'] : []);
        const keepIdx: number[] = [];
        allColumns.forEach((c: string, idx: number) => {
          if (dropped.has(c)) return;
          if (!validCols.has(c)) throw new Error(`Unexpected column "${c}" in table "${t}".`);
          keepIdx.push(idx);
        });
        const columns: string[] = keepIdx.map((idx) => allColumns[idx]);
        const rows: unknown[][] = allRows.map((r: unknown[]) => keepIdx.map((idx) => r[idx]));
        const blobColIdx = t === 'receipt_files' ? columns.indexOf('data') : -1;
        if (rows.length > 0) {
          const placeholders = columns.map(() => '?').join(', ');
          const sql = `INSERT INTO ${t} (${columns.join(', ')}) VALUES (${placeholders})`;
          for (const row of rows) {
            const bound = blobColIdx >= 0 && typeof row[blobColIdx] === 'string'
              ? row.map((v: unknown, idx: number) => (idx === blobColIdx ? Buffer.from(String(v), 'base64') : v))
              : row;
            this.sqlite.run(sql, bound);
          }
        }
      }
      if (Number(this.sqlite.scalar('SELECT COUNT(*) FROM departments') || 0) === 0) {
        this.insertDefaultDepartmentsInsideTx();
      }
      this.logSecurity('restore', { username: actor.username, detail: 'Full ledger backup restored' });
      this.logActivity(actor.displayName, 'backup_restored', '', '', 0, 'Restored full ledger backup');
    });
    this.notify('transactions');
    this.notify('locks');
    this.notify('heads');
    this.notify('departments');
    this.notify('employees');
    this.notify('salaries');
    this.notify('loans');
    this.notify('rent');
    this.notify('fundSources');
    this.notify('advances');
  }

  wipeDatabase(actor: AppUser, includeUsers = false): { factoryReset: boolean } {
    this.transaction(() => {
      const ledgerTables = [
        'transactions',
        'receipt_files',
        'employees',
        'salary_payments',
        'employee_advances',
        'salary_advance_repayments',
        'employee_loans',
        'loan_repayments',
        'rent_items',
        'rent_payments',
        'period_locks',
        'ledger_audit',
        'activity',
        'ledger_heads',
        'departments',
      ];
      for (const t of ledgerTables) {
        this.sqlite.run(`DELETE FROM ${t}`);
      }
      const hasSeq = this.sqlite.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
      );
      if (hasSeq) {
        this.sqlite.run("DELETE FROM sqlite_sequence WHERE name = 'ledger_audit'");
      }
      this.insertDefaultHeadsInsideTx();
      this.insertDefaultDepartmentsInsideTx();

      if (includeUsers) {
        this.sqlite.run('DELETE FROM sessions');
        this.sqlite.run('DELETE FROM security_events');
        this.sqlite.run('DELETE FROM users');
        this.sqlite.run('DELETE FROM settings');
      } else {
        this.logSecurity('database_wiped', {
          username: actor.username,
          detail: 'Wiped all ledger, staff, salary, loan, rent & receipt data',
        });
        this.logActivity(actor.displayName, 'database_wiped', '', '', 0, 'Cleared all data for a fresh start');
      }
    });

    this.notify('transactions');
    this.notify('locks');
    this.notify('heads');
    this.notify('departments');
    this.notify('employees');
    this.notify('salaries');
    this.notify('loans');
    this.notify('rent');
    this.notify('fundSources');
    this.notify('advances');
    this.notify('activity');
    if (includeUsers) {
      this.seedDefaultFundSources();
      this.notify('users');
    }

    return { factoryReset: includeUsers };
  }
}

export const db = new LedgerDatabase();
