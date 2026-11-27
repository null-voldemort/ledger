import { Router, Request, Response, NextFunction } from 'express';
import { Readable, Transform } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  db,
  verifyPasswordAsync,
  hashPassword,
  hashPasswordAsync,
  needsRehash,
  passwordProblem,
  SESSION_TTL_MS,
  type TransactionListQuery,
  SQLITE_DATABASE_DIR,
  SQLITE_DATABASE_FILE,
} from './db';
import { createSqliteSnapshot } from './sqliteSnapshot';
import { streamXlsxWorkbook, type XlsxSheet, type XlsxWorkbookOptions } from './xlsxStream';
import { transactionCsv, transactionWorksheet } from './exportStreams';
import { buildStatementWorkbook } from './statementWorkbook';
import { monthRangeOf } from '../src/utils/ledger';
import { toPaisa } from '../src/utils/money';
import { acquireMaintenance, releaseMaintenance } from './maintenance';
import type { AppUser } from '../src/types';
import { canEditRole } from '../src/utils/roles';
import {
  buildImportPlan, commitImportPlan, hashFile, importTag, readWorkbookGrids, sanitizeImportPlan, validateImportPlan,
  type PlanContext,
} from './excelImport';
import type { ImportPlan } from '../src/utils/importPlan';
import {
  validateEmployeeInput,
  validateLoanIssueInput,
  validateLoanRepayInput,
  validateSalaryPayInput,
  validateSalaryAdvanceInput,
  validateTransactionInput,
  validateRentItemInput,
  validateRentPaymentInput,
} from './validation';
import { clientMeta, lookupNetworkIdentity } from './clientInfo';

const router = Router();

function publicError(err: any, fallback = 'Something went wrong. Please try again.'): string {
  const msg = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  const internal =
    !msg ||
    err instanceof TypeError ||
    err instanceof RangeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    /^(ERR_SQLITE|SQLITE|ENOENT|EACCES|EPERM|ENOSPC|EBUSY|EMFILE|EEXIST)/.test(code) ||
    /sqlite|no such (table|column)|constraint failed|\bat\s+\S+\s+\(|node_modules|[A-Za-z]:\\|\/home\/|\/usr\/|ENOENT|EACCES|EPERM/i.test(msg);
  if (internal) {
    console.error('[Pace IT Ledger] Internal error:', err);
    return fallback;
  }
  return msg;
}

const SESSION_COOKIE = 'pace_it_session';
const SESSION_MAX_AGE_MS = SESSION_TTL_MS;

function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

function isHttpsRequest(req?: Request): boolean {
  if (process.env.PACE_HTTPS === '1' || process.env.COOKIE_SECURE === '1') return true;
  if (req?.headers['x-forwarded-proto'] === 'https') return true;
  if (process.env.APP_URL?.startsWith('https://')) return true;
  return false;
}

function cookieOptions(req?: Request) {
  const httpsProxy = isHttpsRequest(req);
  return {
    httpOnly: true,
    sameSite: (httpsProxy ? 'none' : 'lax') as 'none' | 'lax',
    secure: httpsProxy,
    partitioned: httpsProxy,
    path: '/',
  };
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  void db.ready().then(() => next(), next);
});

export interface AuthenticatedRequest extends Request {
  user?: AppUser;
  token?: string;
}

function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  const user = db.getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  req.user = user;
  req.token = token;
  next();
}

function adminMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

// Entering, editing and voiding entries: administrators and accountants only.
// Every other role (user, visitor, ceo, cto, general manager, ...) is read-only.
// The role is read from the database on each request, so a role change by an
// administrator takes effect immediately, without the person signing out.
function editorMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || !canEditRole(req.user.role)) {
    return res.status(403).json({ error: 'Your account is read-only. Only an administrator or accountant can make changes.' });
  }
  next();
}

const MAX_EVENT_STREAMS_PER_USER = 6;
const eventStreams = new Map<string, number>();

router.get('/events', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const uid = req.user!.id;
  if ((eventStreams.get(uid) || 0) >= MAX_EVENT_STREAMS_PER_USER) {
    return res.status(429).json({ error: 'Too many open live-update connections for this account.' });
  }
  eventStreams.set(uid, (eventStreams.get(uid) || 0) + 1);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const token = req.token || '';
  const stop = () => { try { res.end(); } catch { } };
  const onChange = (data: any) => {
    if (!db.isSessionActive(token)) return stop();
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  db.on('change', onChange);

  const heartbeat = setInterval(() => {
    if (!db.isSessionActive(token)) return stop();
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    const left = (eventStreams.get(uid) || 1) - 1;
    if (left <= 0) eventStreams.delete(uid);
    else eventStreams.set(uid, left);
    clearInterval(heartbeat);
    db.off('change', onChange);
  });
});

router.get('/status', authMiddleware, (_req: Request, res: Response) => {
  const m = db.getMaintenance();
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ maintenance: m ? { on: true, reason: m.reason, since: m.since } : { on: false } });
});

 
interface RateLimitRecord {
  attempts: number;
  lockedUntil: number;
  lastAttempt: number;
}
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_LOGIN_ATTEMPTS_PER_IP = 20;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, RateLimitRecord>();

function getClientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function secLog(req: Request, type: string, info: { username?: string; ip?: string; detail?: string } = {}) {
  const ip = getClientIp(req);
  const meta = clientMeta(req.headers, type === 'login_ok' || type === 'login_failed' ? (req.body || {}).device : undefined);
  if (type === 'login_ok' && meta.deviceId && info.username) meta.newDevice = !db.hasSeenDevice(info.username, meta.deviceId);
  const id = db.logSecurity(type, { ...info, ip, meta });
  if (id) lookupNetworkIdentity(ip).then((found) => { if (found.host || found.mac) db.addSecurityMeta(id, found); }).catch(() => undefined);
}

function checkRateLimit(key: string) {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record) return { locked: false, retryAfterSeconds: 0, attempts: 0 };
  if (record.lockedUntil > now) return { locked: true, retryAfterSeconds: Math.ceil((record.lockedUntil - now) / 1000), attempts: record.attempts };
  if (now - record.lastAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
    return { locked: false, retryAfterSeconds: 0, attempts: 0 };
  }
  return { locked: false, retryAfterSeconds: 0, attempts: record.attempts };
}

function recordFailedLogin(key: string, max = MAX_LOGIN_ATTEMPTS) {
  const now = Date.now();
  const record = loginAttempts.get(key) || { attempts: 0, lockedUntil: 0, lastAttempt: now };
  record.attempts += 1;
  record.lastAttempt = now;
  if (record.attempts >= max) {
    record.lockedUntil = now + LOCKOUT_DURATION_MS;
    loginAttempts.set(key, record);
    return { locked: true, retryAfterSeconds: Math.ceil(LOCKOUT_DURATION_MS / 1000), attemptsRemaining: 0 };
  }
  loginAttempts.set(key, record);
  return { locked: false, retryAfterSeconds: 0, attemptsRemaining: max - record.attempts };
}

const DUMMY_HASH = hashPassword('not-a-real-password-' + Math.random());

async function confirmAdminPassword(req: AuthenticatedRequest, res: Response, passwordOverride?: string): Promise<boolean> {
  const password = String(passwordOverride ?? req.body?.password ?? '');
  const key = `admin-confirm:${req.user!.id}`;
  const limit = checkRateLimit(key);
  if (limit.locked) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.` });
    return false;
  }
  const stored = db.getUserById(req.user!.id);
  if (!password || !stored || !(await verifyPasswordAsync(password, stored.password))) {
    const fail = recordFailedLogin(key);
    if (password) secLog(req, 'admin_confirm_failed', { username: req.user!.username });
    res.status(403).json({
      error: password
        ? `Incorrect admin password. ${fail.attemptsRemaining} attempt${fail.attemptsRemaining === 1 ? '' : 's'} remaining.`
        : 'Enter your admin password to continue.',
    });
    return false;
  }
  loginAttempts.delete(key);
  return true;
}

 

router.get('/auth/setup-status', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ needsSetup: db.needsSetup() });
});

router.post('/auth/setup', (req: Request, res: Response) => {
  try {
    if (!db.needsSetup()) {
      return res.status(403).json({ error: 'Setup has already been completed. Please sign in.' });
    }
    const { username, displayName, password, loadSampleData } = req.body || {};
    const user = db.bootstrapFirstAdmin({
      username,
      displayName,
      password,
      loadSampleData: Boolean(loadSampleData),
    });
    secLog(req, 'setup_admin', { username: user.username, detail: loadSampleData ? 'Initial admin account + sample ledger' : 'Initial admin account' });
    const token = db.createSession(user.id);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
    return res.json({ user });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not complete setup.') });
  }
});

router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (username.length > 100 || password.length > 200) {
      return res.status(400).json({ error: 'Invalid username or password.' });
    }
    const norm = username.trim().toLowerCase().replace(/\s+/g, '_');
    const ip = getClientIp(req);
    const userKey = `login-user:${norm}:${ip}`;
    const ipKey = `login-ip:${ip}`;

    const lockedStatus = [checkRateLimit(userKey), checkRateLimit(ipKey)].find((x) => x.locked);
    if (lockedStatus) {
      res.setHeader('Retry-After', lockedStatus.retryAfterSeconds);
      const minutes = Math.ceil(lockedStatus.retryAfterSeconds / 60);
      return res.status(429).json({
        error: `Too many failed login attempts. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`,
        retryAfter: lockedStatus.retryAfterSeconds,
      });
    }

    const user = db.getUserByUsername(norm);
    const passwordOk = (await verifyPasswordAsync(password, user ? user.password : DUMMY_HASH)) && !!user;
    if (!user || !passwordOk) {
      const failUser = recordFailedLogin(userKey);
      const failIp = recordFailedLogin(ipKey, MAX_LOGIN_ATTEMPTS_PER_IP);
      secLog(req, 'login_failed', { username: norm.slice(0, 60), ip, detail: user ? 'wrong password' : 'unknown username' });
      const failStatus = failUser.locked ? failUser : failIp.locked ? failIp : failUser;
      if (failStatus.locked) {
        secLog(req, 'login_locked', { username: norm.slice(0, 60), ip, detail: 'account temporarily locked' });
        res.setHeader('Retry-After', failStatus.retryAfterSeconds);
        const minutes = Math.ceil(failStatus.retryAfterSeconds / 60);
        return res.status(429).json({ error: `Too many failed attempts. Locked for ${minutes} minute${minutes > 1 ? 's' : ''}.` });
      }
      return res.status(401).json({
        error: `Invalid username or password. ${failUser.attemptsRemaining} attempt${failUser.attemptsRemaining === 1 ? '' : 's'} remaining.`,
      });
    }

    if (user.disabled) {
      secLog(req, 'login_disabled', { username: user.username, ip });
      return res.status(403).json({ error: 'This account has been disabled. Contact an administrator.' });
    }

    loginAttempts.delete(userKey);
    if (needsRehash(user.password)) {
      try { db.replacePasswordHash(user.id, await hashPasswordAsync(password)); } catch {   }
    }
    secLog(req, 'login_ok', { username: user.username, ip });

    const token = db.createSession(user.id);
    const fresh = db.getUserById(user.id) || user;
    const profile: AppUser = {
      id: fresh.id,
      username: fresh.username,
      displayName: fresh.displayName,
      role: fresh.role,
      theme: fresh.theme || 'light',
      phoneNumber: fresh.phoneNumber,
      email: fresh.email,
      photoUrl: fresh.photoUrl,
      disabled: fresh.disabled,
      createdAt: fresh.createdAt,
    };

    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
    return res.json({ user: profile });
  } catch (err: any) {
    return res.status(500).json({ error: publicError(err, 'Login failed.') });
  }
});

router.get('/auth/me', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: req.user });
});

router.put('/auth/preferences', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const theme = req.body?.theme === 'dark' ? 'dark' : 'light';
    const updated = db.updateUserPreferences(req.user!.id, { theme });
    return res.json({ ok: true, user: updated });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not save preferences.') });
  }
});

router.put('/auth/profile', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body || {};
    if (body.username !== undefined) {
      const candidate = String(body.username || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (candidate !== req.user!.username) {
        const currentPassword = String(body.currentPassword || '');
        const stored = db.getUserById(req.user!.id);
        if (!currentPassword || !stored || !(await verifyPasswordAsync(currentPassword, stored.password))) {
          secLog(req, 'username_change_failed', { username: req.user!.username });
          return res.status(403).json({ error: 'Enter your current password to change your username.' });
        }
      }
    }
    const updated = db.updateUserProfile(req.user!.id, {
      username: body.username,
      displayName: body.displayName,
      phoneNumber: body.phoneNumber,
      email: body.email,
      photoUrl: body.photoUrl,
      theme: body.theme,
    });
    if (updated.username !== req.user!.username) {
      secLog(req, 'username_changed', { username: updated.username, detail: `${req.user!.username} -> ${updated.username}` });
    }
    return res.json({ ok: true, user: updated });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update profile.') });
  }
});

router.post('/auth/logout', (req: Request, res: Response) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const who = db.getUserByToken(token);
    if (who) secLog(req, 'logout', { username: who.username });
    db.destroySession(token);
  }
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  return res.json({ ok: true });
});

router.post('/auth/logout-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  db.destroyUserSessions(req.user!.id);
  secLog(req, 'logout_all', { username: req.user!.username, detail: 'signed out everywhere' });
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  return res.json({ ok: true });
});

router.post('/auth/change-password', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, password } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'Enter your current password.' });
    }
    const stored = db.getUserById(req.user!.id);
    if (!stored || !(await verifyPasswordAsync(currentPassword, stored.password))) {
      secLog(req, 'password_change_failed', { username: req.user!.username });
      return res.status(403).json({ error: 'Current password is incorrect.' });
    }
    const prob = passwordProblem(password, req.user!.username);
    if (prob) return res.status(400).json({ error: prob });
    db.replacePasswordHash(req.user!.id, await hashPasswordAsync(password));
    db.destroyUserSessions(req.user!.id, req.token);
    secLog(req, 'password_changed', { username: req.user!.username, detail: 'signed out other sessions' });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not change password.') });
  }
});

router.get('/auth/avatars', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getUserAvatars());
});

router.get('/heads', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getHeads());
});

router.post('/heads', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { kind, name, description, active } = req.body || {};
    if (kind !== 'income' && kind !== 'expense') return res.status(400).json({ error: 'Type must be income or expense.' });
    const head = db.upsertHead({ kind, name, description, active }, req.user!);
    return res.json(head);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not save head.') });
  }
});

router.patch('/heads/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description } = req.body || {};
    const head = db.renameHead(req.params.id, { name, description }, req.user!);
    return res.json(head);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not rename channel/office.') });
  }
});

router.get('/departments', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getDepartments());
});

router.post('/departments', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, active } = req.body || {};
    const dept = db.upsertDepartment({ name, description, active }, req.user!);
    return res.json(dept);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not save department.') });
  }
});

router.patch('/departments/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, description, active } = req.body || {};
    const dept = db.renameDepartment(req.params.id, { name, description, active }, req.user!);
    return res.json(dept);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update department.') });
  }
});

router.get('/fund-sources', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getFundSources());
});

router.post('/fund-sources', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = db.createFundSource(String(req.body?.name || ''));
    return res.status(201).json(source);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not create fund source.') });
  }
});

router.patch('/fund-sources/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const source = db.updateFundSource(req.params.id, {
      name: req.body?.name === undefined ? undefined : String(req.body.name),
      active: req.body?.active === undefined ? undefined : Boolean(req.body.active),
    });
    return res.json(source);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update fund source.') });
  }
});

 

function validLedgerDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dates must use YYYY-MM-DD format.');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('A valid calendar date is required.');
  }
  return date;
}

function readTransactionQuery(req: AuthenticatedRequest): TransactionListQuery {
  const q = req.query;
  const allowedAudit = new Set(['all', 'edited', 'amount_changed', 'flagged', 'receipt', 'unclassified_dept', 'flagged_or_changed']);
  const kind = q.kind === 'income' || q.kind === 'expense' ? q.kind : 'all';
  const auditFilter = allowedAudit.has(String(q.auditFilter || 'all'))
    ? String(q.auditFilter || 'all') as TransactionListQuery['auditFilter']
    : 'all';
  const limitText = q.limit === undefined ? '50' : String(q.limit);
  if (!/^\d{1,3}$/.test(limitText)) throw new Error('Page size must be between 1 and 100.');
  const limit = Number(limitText);
  if (limit < 1 || limit > 100) throw new Error('Page size must be between 1 and 100.');
  const from = validLedgerDate(q.from);
  const to = validLedgerDate(q.to);
  if (from && to && from > to) throw new Error('The start date must not be after the end date.');
  const allowedSort = new Set<string>(['newest', 'oldest', 'amount_desc', 'amount_asc', 'party_asc', 'party_desc', 'department_asc', 'voucher_desc', 'voucher_asc']);
  const sort = (allowedSort.has(String(q.sort || '')) ? String(q.sort) : 'newest') as TransactionListQuery['sort'];
  const cursor = q.cursor === undefined ? undefined : String(q.cursor);
  if (cursor !== undefined && (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
    throw new Error('Invalid transaction cursor. Refresh the list and try again.');
  }
  return {
    limit,
    cursor,
    from,
    to,
    kind,
    head: q.head ? String(q.head).slice(0, 100) : undefined,
    department: q.department ? String(q.department).slice(0, 100) : undefined,
    paymentMethod: q.paymentMethod ? String(q.paymentMethod).slice(0, 80) : undefined,
    employeeId: q.employeeId ? String(q.employeeId).slice(0, 80) : undefined,
    fundSourceId: q.fundSourceId ? String(q.fundSourceId).slice(0, 80) : undefined,
    auditFilter,
    search: q.search ? String(q.search).slice(0, 120) : '',
    sort,
  };
}

router.get('/transactions', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json(db.getTransactionsPage(readTransactionQuery(req)));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not load transactions.') });
  }
});

router.get('/transactions/summary', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const from = validLedgerDate(req.query.from);
    const to = validLedgerDate(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'Both start and end dates are required.' });
    if (from > to) return res.status(400).json({ error: 'The start date must not be after the end date.' });
    const label = String(req.query.label || `${from} – ${to}`).slice(0, 80);
    return res.json(db.getPeriodSummary(from, to, label));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not load period summary.') });
  }
});

router.get('/transactions/employee-stats', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const from = validLedgerDate(req.query.from);
    const to = validLedgerDate(req.query.to);
    if (from && to && from > to) return res.status(400).json({ error: 'The start date must not be after the end date.' });
    return res.json(db.getEmployeeSpendStats(from, to));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not load employee summaries.') });
  }
});

router.get('/transactions/facets', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getTransactionFacets());
});

router.get('/transactions/employee-activity', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const from = validLedgerDate(req.query.from);
    const to = validLedgerDate(req.query.to);
    if (!from || !to) return res.status(400).json({ error: 'Both start and end dates are required.' });
    if (from > to) return res.status(400).json({ error: 'The start date must not be after the end date.' });
    return res.json(db.getEmployeeActivityIds(from, to));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not load employee activity.') });
  }
});

router.get('/transactions/export.csv', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  let snapshot: ReturnType<typeof db.openTransactionExportSnapshot> | null = null;
  try {
    const query = readTransactionQuery(req);
    snapshot = db.openTransactionExportSnapshot(query);
    const label = String(req.query.label || 'Daily-Ledger').slice(0, 80).replace(/[^\w-]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Pace-IT-${label}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    const stream = Readable.from(transactionCsv(snapshot));
    res.on('close', () => { if (!res.writableFinished) { stream.destroy(); snapshot?.close(); } });
    stream.on('error', (error) => {
      snapshot?.close();
      if (res.headersSent) res.destroy(error);
      else res.status(500).json({ error: publicError(error, 'Could not export transactions.') });
    });
    return stream.pipe(res);
  } catch (err: any) {
    snapshot?.close();
    return res.status(400).json({ error: publicError(err, 'Could not export transactions.') });
  }
});

router.get('/transactions/export.xlsx', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  let snapshot: ReturnType<typeof db.openTransactionExportSnapshot> | null = null;
  try {
    const query = readTransactionQuery(req);
    const statementReport = String(req.query.report || '') === 'statement';
    let report: { from: string; to: string; label: string } | undefined;
    if (statementReport) {
      const from = validLedgerDate(req.query.from);
      const to = validLedgerDate(req.query.to);
      if (!from || !to) return res.status(400).json({ error: 'Both start and end dates are required for a statement export.' });
      if (from > to) return res.status(400).json({ error: 'The start date must not be after the end date.' });
      report = { from, to, label: String(req.query.label || `${from} – ${to}`).slice(0, 80) };
      query.sort = 'oldest'; // a statement runs oldest to newest so the balance column reads down the page
    }
    snapshot = db.openTransactionExportSnapshot(query, report);
    let workbookOptions: XlsxWorkbookOptions | undefined;
    let sheets: XlsxSheet[];
    if (statementReport && report) {
      // A period that is exactly one calendar month can be signed off; show who did it on the statement.
      const month = monthRangeOf(report.from.slice(0, 7));
      const lock = month.from === report.from && month.to === report.to
        ? db.getPeriodLocks().find((l) => l.periodKey === report.from.slice(0, 7))
        : undefined;
      const built = buildStatementWorkbook(snapshot.summary!, snapshot.rows, {
        generatedBy: req.user?.displayName || '',
        generatedAt: new Date(),
        lock: lock ? { lockedByName: lock.lockedByName, lockedAt: lock.lockedAt } : undefined,
      });
      sheets = built.sheets;
      workbookOptions = built.options;
    } else {
      sheets = [{ name: 'Transactions', rows: transactionWorksheet(snapshot.rows), widths: [18, 12, 12, 20, 24, 26, 16, 20, 18, 30, 34, 14, 10, 16, 28, 20] }];
    }
    const from = report?.from || String(req.query.from || 'all-dates');
    const to = report?.to || String(req.query.to || '');
    const label = report
      ? `Pace-IT-Statement-${from}-to-${to}`
      : `Pace-IT-${String(req.query.label || 'Daily-Ledger').slice(0, 80).replace(/[^\w-]+/g, '_')}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${label}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    const stream = Readable.from(streamXlsxWorkbook(sheets, workbookOptions));
    res.on('close', () => { if (!res.writableFinished) { stream.destroy(); snapshot?.close(); } });
    stream.on('error', (error) => {
      snapshot?.close();
      if (res.headersSent) res.destroy(error);
      else res.status(500).json({ error: publicError(error, 'Could not export transactions.') });
    });
    return stream.pipe(res);
  } catch (err: any) {
    snapshot?.close();
    return res.status(400).json({ error: publicError(err, 'Could not export transactions.') });
  }
});

router.get('/transactions/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const transaction = db.getTransactionById(req.params.id);
  if (!transaction) return res.status(404).json({ error: 'Transaction not found.' });
  return res.json(transaction);
});

router.post('/transactions', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateTransactionInput(req.body, false);
    let receipt: { sha256: string; name: string; type: string } | undefined;
    if (req.body?.receipt?.data) {
      receipt = db.storeReceipt(req.body.receipt.data, req.body.receipt.name || 'receipt');
    }
    const created = db.createTransaction(input, req.user!, receipt);
    return res.status(201).json(created);
  } catch (err: any) {
    const msg = publicError(err, 'Could not save transaction.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.patch('/transactions/:id', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateTransactionInput(req.body, true);
    let receipt: { sha256: string; name: string; type: string } | undefined;
    if (req.body?.receipt?.data) {
      receipt = db.storeReceipt(req.body.receipt.data, req.body.receipt.name || 'receipt');
    }
    const updated = db.editTransaction(req.params.id, input, req.user!, receipt);
    return res.json(updated);
  } catch (err: any) {
    const msg = publicError(err, 'Could not update transaction.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.post('/transactions/:id/verify', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const status = req.body?.status === 'flagged' ? 'flagged' : 'verified';
    const note = String(req.body?.note || '');
    const updated = db.verifyOrFlagTransaction(req.params.id, status, note, req.user!);
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update verification status.') });
  }
});

router.post('/transactions/:id/void', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.softDeleteTransaction(req.params.id, String(req.body?.reason || ''), req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    const msg = publicError(err, 'Could not void transaction.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.post('/transactions/:id/restore', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.restoreTransaction(req.params.id, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    const msg = publicError(err, 'Could not restore transaction.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.get('/receipts/:sha', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const found = db.readReceipt(req.params.sha);
  if (!found) return res.status(404).json({ error: 'Receipt not found.' });
  const bytes = found.bytes;
  const isPdf = bytes.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
  res.setHeader('Content-Type', isPdf ? 'application/pdf' : isPng ? 'image/png' : (found.mimeType || 'image/jpeg'));
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  return res.send(bytes);
});

router.get('/employees', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getEmployees());
});

router.post('/employees', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateEmployeeInput(req.body, false);
    const created = db.createEmployee({
      ...input,
      role: input.role || 'Staff',
      department: input.department || '',
      branch: input.branch || '',
    }, req.user!);
    return res.status(201).json(created);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not add employee.') });
  }
});

router.patch('/employees/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateEmployeeInput(req.body, true);
    const updated = db.updateEmployee(req.params.id, {
      ...input,
      name: input.name || undefined,
    }, req.user!);
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update employee.') });
  }
});

router.get('/advances', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getSalaryAdvances());
});

router.post('/advances', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateSalaryAdvanceInput(req.body);
    const result = db.createSalaryAdvance(input, req.user!);
    return res.status(201).json(result);
  } catch (err: any) {
    const msg = publicError(err, 'Could not record salary advance.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.delete('/advances/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.deleteSalaryAdvance(req.params.id, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    const msg = publicError(err, 'Could not delete salary advance.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.get('/salaries', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const monthKey = typeof req.query.monthKey === 'string' ? req.query.monthKey : undefined;
  return res.json(db.getSalaryPayments(monthKey));
});

router.post('/salaries/pay', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateSalaryPayInput(req.body);
    let receipt: { sha256: string; name: string; type: string } | undefined;
    if (req.body?.receipt?.data) {
      receipt = db.storeReceipt(req.body.receipt.data, req.body.receipt.name || 'salary-voucher');
    }
    const result = db.payEmployeeSalary(input, req.user!, receipt);
    return res.status(201).json(result);
  } catch (err: any) {
    const msg = publicError(err, 'Could not process salary payment.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.delete('/salaries/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.deleteSalaryPayment(req.params.id, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not delete salary payment.') });
  }
});

router.get('/loans', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getLoans());
});

router.post('/loans', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateLoanIssueInput(req.body);
    let receipt: { sha256: string; name: string; type: string } | undefined;
    if (req.body?.receipt?.data) {
      receipt = db.storeReceipt(req.body.receipt.data, req.body.receipt.name || 'loan-voucher');
    }
    const result = db.issueLoan(input, req.user!, receipt);
    return res.status(201).json(result);
  } catch (err: any) {
    const msg = publicError(err, 'Could not issue loan.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.delete('/loans/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.deleteLoan(req.params.id, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not delete loan.') });
  }
});

router.post('/loans/:id/repay', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateLoanRepayInput(req.body);
    let receipt: { sha256: string; name: string; type: string } | undefined;
    if (req.body?.receipt?.data) {
      receipt = db.storeReceipt(req.body.receipt.data, req.body.receipt.name || 'repayment-voucher');
    }
    const result = db.repayLoan(req.params.id, input, req.user!, receipt);
    return res.status(201).json(result);
  } catch (err: any) {
    const msg = publicError(err, 'Could not record repayment.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.delete('/loans/:id/repayments/:repaymentId', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const loan = db.deleteLoanRepayment(req.params.id, req.params.repaymentId, req.user!);
    return res.json({ ok: true, loan });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not delete loan repayment.') });
  }
});

router.get('/rent-items', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getRentItems());
});

router.post('/rent-items', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateRentItemInput(req.body, false);
    const created = db.createRentItem(input, req.user!);
    return res.status(201).json(created);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not add rent item.') });
  }
});

router.patch('/rent-items/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateRentItemInput(req.body, true);
    const updated = db.updateRentItem(req.params.id, input, req.user!);
    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update rent item.') });
  }
});

router.delete('/rent-items/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.deleteRentItem(req.params.id, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not delete rent item.') });
  }
});

router.get('/rent-payments', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const monthKey = typeof req.query.monthKey === 'string' ? req.query.monthKey : undefined;
  return res.json(db.getRentPayments(monthKey));
});

router.post('/rent-payments', authMiddleware, editorMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const input = validateRentPaymentInput(req.body);
    let receipt: { sha256: string; name: string; type: string } | undefined;
    if (req.body?.receipt?.data) {
      receipt = db.storeReceipt(req.body.receipt.data, req.body.receipt.name || 'rent-voucher');
    }
    const created = db.payRentItem(input, req.user!, receipt);
    return res.status(201).json(created);
  } catch (err: any) {
    const msg = publicError(err, 'Could not record rent payment.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.delete('/rent-payments/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    db.deleteRentPayment(req.params.id, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    const msg = publicError(err, 'Could not delete rent payment.');
    return res.status(/locked/i.test(msg) ? 403 : 400).json({ error: msg });
  }
});

router.get('/locks', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getPeriodLocks());
});

router.post('/locks', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const lock = db.lockPeriod(String(req.body?.periodKey || ''), String(req.body?.note || ''), req.user!);
    return res.json(lock);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not lock period.') });
  }
});

router.post('/locks/:periodKey/unlock', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  if (!(await confirmAdminPassword(req, res))) return;
  try {
    db.unlockPeriod(req.params.periodKey, String(req.body?.reason || ''), req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not unlock period.') });
  }
});

router.get('/audit', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getAuditChain(400));
});

router.get('/audit/verify', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.verifyAuditChain());
});

router.get('/activity', authMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getActivity(120));
});

 

router.get('/admin/users', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.listUsers());
});

router.post('/admin/users', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { username, displayName, password, role } = req.body || {};
    const created = db.createUser({ username, displayName, password, role });
    secLog(req, 'user_created', { username: req.user!.username, detail: `created ${created.username} (${created.role})` });
    return res.status(201).json(created);
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not create user.') });
  }
});

router.patch('/admin/users/:id', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { username, displayName, role, phoneNumber, email } = req.body || {};
    const before = db.getUserById(req.params.id);
    const updated = db.adminUpdateUser(req.params.id, { username, displayName, role, phoneNumber, email }, req.user!.id);
    const roleNote = before && before.role !== updated.role ? `; role ${before.role} -> ${updated.role}` : '';
    secLog(req, 'user_updated', { username: req.user!.username, detail: `updated ${updated.username} (${updated.role})${roleNote}` });
    return res.json({ ok: true, user: updated });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update user account.') });
  }
});

router.patch('/admin/users/:id/disabled', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const disabled = Boolean(req.body?.disabled);
    const u = db.setUserDisabled(req.params.id, disabled, req.user!.id);
    secLog(req, disabled ? 'user_disabled' : 'user_enabled', { username: req.user!.username, detail: `${u.username}` });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not update user.') });
  }
});

router.post('/admin/users/:id/reset-password', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const u = db.adminResetPassword(req.params.id, String(req.body?.password || ''));
    secLog(req, 'password_reset', { username: req.user!.username, detail: `reset password for ${u.username}` });
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not reset password.') });
  }
});

router.get('/admin/bin', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
      return res.status(400).json({ error: 'Bin page limit must be an integer between 1 and 100.' });
    }
    const cursor = req.query.cursor === undefined ? undefined : String(req.query.cursor);
    if (cursor && cursor.length > 512) return res.status(400).json({ error: 'Invalid Bin cursor.' });
    return res.json(db.getDeletedTransactionsPage({ limit: rawLimit, cursor }));
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not load the Bin.') });
  }
});

router.get('/admin/security-events', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  return res.json(db.getSecurityEvents(200));
});

router.get('/admin/backup', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: Response) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="pace-it-ledger-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  const stream = Readable.from(db.streamFullBackupJson());
  // Destroy the async iterator on client cancellation so its finally block closes
  // the read snapshot instead of continuing to serialize a backup nobody receives.
  res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
  stream.on('error', (error) => {
    if (res.headersSent) res.destroy(error);
    else res.status(500).json({ error: publicError(error, 'Could not export backup.') });
  });
  return stream.pipe(res);
});

router.get('/admin/backup/sqlite', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const tempDir = fs.mkdtempSync(path.join(SQLITE_DATABASE_DIR, '.sqlite-backup-'));
  const snapshotPath = path.join(tempDir, 'pace-it-ledger.sqlite');
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  const cleanup = () => { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { } };
  try {
    await createSqliteSnapshot(SQLITE_DATABASE_FILE, snapshotPath, controller.signal);
    if (controller.signal.aborted || res.destroyed) { cleanup(); return; }
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="pace-it-ledger-${new Date().toISOString().slice(0, 10)}.sqlite"`);
    res.setHeader('Cache-Control', 'no-store');
    const fileStream = fs.createReadStream(snapshotPath);
    fileStream.once('close', cleanup);
    fileStream.once('error', (error) => {
      cleanup();
      if (res.headersSent) res.destroy(error);
      else res.status(500).json({ error: publicError(error, 'Could not download SQLite backup.') });
    });
    res.once('close', () => { if (!res.writableFinished) fileStream.destroy(); });
    fileStream.pipe(res);
  } catch (error) {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: publicError(error, 'Could not create SQLite backup.') });
    else res.destroy(error as Error);
  }
});


// ---- Excel import (admin only; preview -> edit -> confirm; nothing is written before confirm) ----

function importContext(fileHash: string, sheetMonth = '', candidatePlan?: ImportPlan): PlanContext {
  const employees = db.getEmployees();
  let existingEntries = new Map<string, string[]>();
  let existingLinkedEntries = new Map<string, string[]>();
  if (candidatePlan) {
    const amountPaisa = (amount: string) => toPaisa(amount) ?? 0;
    const employeeName = (ref: string) => candidatePlan.employees.find((e) => e.key === ref)?.name
      || (ref.startsWith('db:') ? employees.find((e) => e.id === ref.slice(3))?.name : '')
      || ref;
    const duplicateIndexes = db.getImportDuplicateIndexes({
      entries: candidatePlan.entries.filter((e) => e.include).map((e) => ({
        txDate: e.txDate, kind: e.kind, amountPaisa: amountPaisa(e.amount),
      })),
      linked: [
        ...candidatePlan.salaryPayments.filter((r) => r.include).map((r) => ({
          txDate: r.txDate, categoryGroup: r.type === 'advance' ? 'salary_advance' : 'salary',
          employeeName: employeeName(r.employeeRef), amountPaisa: amountPaisa(r.amount),
        })),
        ...candidatePlan.loans.filter((r) => r.include).map((r) => ({
          txDate: r.txDate, categoryGroup: 'loan_issue', employeeName: employeeName(r.employeeRef), amountPaisa: amountPaisa(r.amount),
        })),
        ...candidatePlan.loanRepayments.filter((r) => r.include).map((r) => ({
          txDate: r.txDate, categoryGroup: 'loan_repayment', employeeName: employeeName(r.employeeRef), amountPaisa: amountPaisa(r.amount),
        })),
      ],
    });
    existingEntries = duplicateIndexes.existingEntries;
    existingLinkedEntries = duplicateIndexes.existingLinkedEntries;
  }
  let openingBalancePaisa = 0;
  if (/^\d{4}-\d{2}$/.test(sheetMonth)) {
    const [year, month] = sheetMonth.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    openingBalancePaisa = db.getPeriodSummary(`${sheetMonth}-01`, lastDay, sheetMonth).openingBalancePaisa;
  }
  const heads = db.getHeads();
  return {
    fundSources: db.getFundSources(),
    employees,
    rentItems: db.getRentItems().map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      monthlyAmountPaisa: r.monthlyAmountPaisa,
      urgentAmountPaisa: r.urgentAmountPaisa,
      department: r.department,
      notes: r.notes || '',
    })),
    headNames: {
      income: heads.filter((h) => h.kind === 'income').map((h) => h.name),
      expense: heads.filter((h) => h.kind === 'expense').map((h) => h.name),
    },
    departmentNames: db.getDepartments().map((d) => d.name),
    lockedPeriods: db.getPeriodLocks().map((l) => l.periodKey),
    existingEntries,
    existingLinkedEntries,
    openingBalancePaisa,
    alreadyImported: fileHash ? db.isImportBatchPresent(importTag(fileHash)) : false,
  };
}

router.post('/admin/import/preview', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 100) return res.status(400).json({ error: 'Choose an Excel (.xlsx) file to upload.' });
    let fileName = 'workbook.xlsx';
    try { fileName = decodeURIComponent(String(req.headers['x-file-name'] || fileName)).slice(0, 200); } catch { /* keep default */ }
    const grids = await readWorkbookGrids(buf);
    const fileHash = hashFile(buf);
    const baseContext = importContext(fileHash);
    const draft = buildImportPlan(grids, { fileName, fileHash }, baseContext);
    const ctx = importContext(fileHash, draft.sheetMonth, draft);
    const plan = buildImportPlan(grids, { fileName, fileHash }, ctx);
    secLog(req, 'import_previewed', { username: req.user!.username, detail: `previewed ${fileName}` });
    return res.json({ validation: validateImportPlan(plan, ctx) });
  } catch (error: any) {
    return res.status(400).json({ error: publicError(error, 'Could not read that Excel file.') });
  }
});

router.post('/admin/import/validate', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const plan = sanitizeImportPlan(req.body?.plan);
    return res.json({ validation: validateImportPlan(plan, importContext(plan.fileHash, plan.sheetMonth, plan)) });
  } catch (error: any) {
    return res.status(400).json({ error: publicError(error, 'Could not check the import.') });
  }
});

router.post('/admin/import/commit', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const plan = sanitizeImportPlan(req.body?.plan);
    if (!(await confirmAdminPassword(req, res))) return;
    const ctx = importContext(plan.fileHash, plan.sheetMonth, plan);
    const result = commitImportPlan(plan, req.user!, ctx, db as any);
    secLog(req, 'import_committed', {
      username: req.user!.username,
      detail: `imported ${plan.fileName}: ${result.entries} entries, ${result.employees} employees, ${result.salaryPayments} salary payments, ${result.loans} loans, ${result.loanRepayments} repayments, ${result.rentItems} rent items ${result.batch}`,
    });
    return res.json({ ok: true, result });
  } catch (error: any) {
    return res.status(400).json({ error: publicError(error, 'The import could not be completed. Nothing was imported.') });
  }
});

router.post('/admin/restore-sqlite', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/vnd.sqlite3' && contentType !== 'application/octet-stream') {
    return res.status(415).json({ error: 'Upload a SQLite backup file using application/vnd.sqlite3.' });
  }
  const adminPassword = String(req.headers['x-admin-password'] || '').slice(0, 200);
  if (!(await confirmAdminPassword(req, res, adminPassword))) return;
  if (!acquireMaintenance(SQLITE_DATABASE_DIR, 'restore')) {
    return res.status(503).json({ error: 'Another maintenance or restore operation is already running.' });
  }

  let tempDir = '';
  const maxUploadBytes = 10 * 1024 * 1024 * 1024;
  let receivedBytes = 0;
  try {
    tempDir = fs.mkdtempSync(path.join(SQLITE_DATABASE_DIR, '.sqlite-restore-'));
    const uploadPath = path.join(tempDir, 'incoming.sqlite');
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxUploadBytes) throw new Error('SQLite backup exceeds the 10 GB upload limit.');
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        if (receivedBytes > maxUploadBytes) callback(new Error('SQLite backup exceeds the 10 GB upload limit.'));
        else callback(null, chunk);
      },
    });
    await pipeline(req, limiter, fs.createWriteStream(uploadPath, { flags: 'wx' }));
    if (receivedBytes < 100) throw new Error('Uploaded file is too small to be a valid SQLite database.');
    const result = db.restoreSqliteSnapshot(uploadPath, req.user!);
    return res.json({ ok: true, transactionCount: result.transactionCount, previousDatabasePath: path.basename(result.previousDatabasePath) });
  } catch (error: any) {
    const message = publicError(error, 'Could not restore SQLite backup.');
    const status = /too large/i.test(message) ? 413 : 400;
    return res.status(status).json({ error: message });
  } finally {
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { } }
    releaseMaintenance(SQLITE_DATABASE_DIR);
  }
});

router.post('/admin/restore', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  if (!(await confirmAdminPassword(req, res))) return;
  try {
    db.restoreFullBackup(req.body?.backup, req.user!);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not restore backup.') });
  }
});

router.post('/admin/wipe', authMiddleware, adminMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  if (!(await confirmAdminPassword(req, res))) return;
  try {
    const confirmText = String(req.body?.confirmText || '').trim().toUpperCase();
    if (confirmText !== 'WIPE') {
      return res.status(400).json({ error: 'Type WIPE to confirm clearing the database.' });
    }
    const includeUsers = Boolean(req.body?.includeUsers);
    const result = db.wipeDatabase(req.user!, includeUsers);
    if (result.factoryReset) {
      res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    }
    return res.json({ ok: true, factoryReset: result.factoryReset });
  } catch (err: any) {
    return res.status(400).json({ error: publicError(err, 'Could not wipe database.') });
  }
});

export default router;