import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-ledger-roles-test-'));
process.env.PACE_DATA_DIR = TMP_DIR;

const roles = await import('../src/utils/roles');
const { validateTransactionInput } = await import('../server/validation');
const { db } = await import('../server/db');

test.after(async () => {
  await db.ready();
  const raw = (db as any).sqlite?.raw;
  if (raw) {
    try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* already closed */ }
    try { raw.close(); } catch { /* keep original result */ }
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('only admin and accountant can edit; every other role is read-only', () => {
  assert.equal(roles.canEditRole('admin'), true);
  assert.equal(roles.canEditRole('accountant'), true);
  for (const r of ['user', 'visitor', 'ceo', 'cto', 'general_manager']) {
    assert.equal(roles.canEditRole(r), false, `${r} must be read-only`);
  }
  // Unknown, malformed or missing values must never gain write access.
  for (const r of ['', 'root', 'ADMIN', 'Admin ', 'superuser', null, undefined, 0, {}]) {
    assert.equal(roles.canEditRole(r), false);
  }
  assert.equal(roles.normalizeRole('root'), 'user');
  assert.equal(roles.isAdminRole('accountant'), false);
  assert.equal(roles.isAdminRole('admin'), true);
  for (const r of roles.USER_ROLES) assert.ok(roles.ROLE_LABELS[r], `label for ${r}`);
});

test('admin assigns roles; an accountant demoted to any read-only role loses all write power', async () => {
  const admin = await db.bootstrapFirstAdmin({
    username: 'admin',
    displayName: 'Finance Admin',
    password: 'SylhetVault#2026',
    loadSampleData: true,
  });

  for (const role of ['user', 'visitor', 'ceo', 'cto', 'general_manager', 'accountant'] as const) {
    const created = await db.createUser({
      username: `u_${role}`,
      displayName: role,
      password: 'LedgerPass#2026',
      role,
    });
    assert.equal(created.role, role);
    assert.equal(db.getUserById(created.id)!.role, role);
  }

  await assert.rejects(async () => db.createUser({
    username: 'sneaky', displayName: 'x', password: 'LedgerPass#2026', role: 'superuser' as any,
  }), /unknown role/i);

  const acct = db.getUserByUsername('u_accountant')!;
  assert.equal(roles.canEditRole(acct.role), true);

  for (const next of ['visitor', 'ceo', 'cto', 'general_manager', 'user'] as const) {
    db.adminUpdateUser(acct.id, { role: 'accountant' }, admin.id);
    assert.equal(roles.canEditRole(db.getUserById(acct.id)!.role), true);
    db.adminUpdateUser(acct.id, { role: next }, admin.id);
    const after = db.getUserById(acct.id)!;
    assert.equal(after.role, next);
    assert.equal(roles.canEditRole(after.role), false, `${next} must have no write power after demotion`);
  }

  assert.throws(() => db.adminUpdateUser(acct.id, { role: 'god' as any }, admin.id), /unknown role/i);
  assert.equal(db.getUserById(acct.id)!.role, 'user', 'a rejected change must not alter the role');

  // Admin safety rails still hold with the new roles.
  assert.throws(() => db.adminUpdateUser(admin.id, { role: 'accountant' }, admin.id), /own admin role/i);
  const second = await db.createUser({ username: 'admin2', displayName: 'Admin Two', password: 'LedgerPass#2026', role: 'admin' });
  db.adminUpdateUser(second.id, { role: 'accountant' }, admin.id);
  assert.equal(db.getUserById(second.id)!.role, 'accountant');
  assert.throws(() => db.adminUpdateUser(admin.id, { role: 'ceo' }, second.id), /administrator/i);
});

test('a corrupted role value in the database fails closed to read-only', () => {
  const u = db.getUserByUsername('u_visitor')!;
  (db as any).sqlite.run("UPDATE users SET role = 'root' WHERE id = ?", [u.id]);
  const loaded = db.getUserById(u.id)!;
  assert.equal(loaded.role, 'user');
  assert.equal(roles.canEditRole(loaded.role), false);
  (db as any).sqlite.run("UPDATE users SET role = 'visitor' WHERE id = ?", [u.id]);
});

test('accountant entries and edits leave full history; amount edits are flagged for the admin', async () => {
  const admin = db.getUserByUsername('admin')!;
  const acctUser = db.getUserByUsername('u_accountant')!;
  db.adminUpdateUser(acctUser.id, { role: 'accountant' }, admin.id);
  const acct = db.getUserById(acctUser.id)!;
  const source = db.getFundSources().find((s: any) => s.name === 'Company Revenue')!;

  // Fund the source first so the expense below is not rejected for insufficient balance.
  db.createTransaction(
    validateTransactionInput({
      kind: 'income',
      txDate: '2026-12-01',
      amount: '50000',
      department: 'BRAC-BANK-TRANSFER',
      head: 'BRAC-BANK-TRANSFER',
      subCategory: 'Company Fund Transfer',
      paymentMethod: 'BRAC Bank Transfer',
      referenceNo: 'EFTN-ROLE-001',
      counterparty: 'Pace IT Corporate Treasury',
      purpose: 'Funding for role test',
      fundSourceId: source.id,
    }, false),
    admin as any,
  );

  const base = {
    kind: 'expense',
    txDate: '2026-12-02',
    amount: '1200.00',
    department: 'BALUCHOR-OFFICE',
    head: 'BALUCHOR-OFFICE',
    subCategory: 'Fiber, ONU & Router Hardware',
    paymentMethod: 'Cash in Hand',
    referenceNo: 'MEMO-ROLE-1',
    counterparty: 'Sylhet Fiber Mart',
    purpose: 'Patch cords',
    fundSourceId: source.id,
  };
  const tx = db.createTransaction(validateTransactionInput(base, false), acct as any);
  assert.ok(!tx.verifiedByName, 'an accountant entry is never stamped as verified by an admin');

  const edited = db.editTransaction(
    tx.id,
    validateTransactionInput({ ...base, amount: '1450.00', reason: 'Two extra splitters on the same memo' }, true),
    acct as any,
  );
  assert.equal(edited.status, 'flagged');
  assert.equal(edited.editHistory.length, 1);
  assert.equal(edited.editHistory[0].byRole, 'accountant');

  db.softDeleteTransaction(tx.id, 'Duplicate of an earlier memo', acct as any);
  assert.equal(db.getAllTransactions(false).some((t: any) => t.id === tx.id), false, 'voided entry leaves the active ledger');
  const bin = db.getAllTransactions(true).find((t: any) => t.id === tx.id);
  assert.ok(bin, 'voided entry is retained, not erased');

  const chain = db.verifyAuditChain();
  assert.equal(chain.ok, true, 'audit chain stays intact after accountant activity');
});

test('every write route is restricted to admin or accountant (static guard against open routes)', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server', 'api.ts'), 'utf8');
  const routeLines = src.split('\n').filter((l) => /^router\.(post|patch|put|delete)\(/.test(l));
  assert.ok(routeLines.length > 20, 'expected to find the write routes');

  // Self-service account routes and sign-in are the only write routes open to any authenticated person.
  const selfService = [
    '/auth/setup', '/auth/login', '/auth/preferences', '/auth/profile',
    '/auth/logout', '/auth/logout-all', '/auth/change-password',
  ];
  const open: string[] = [];
  for (const line of routeLines) {
    const p = /^router\.\w+\('([^']+)'/.exec(line)![1];
    if (selfService.includes(p)) continue;
    if (!/adminMiddleware|editorMiddleware/.test(line)) open.push(line.trim());
  }
  assert.deepEqual(open, [], 'write routes open to read-only roles');

  const mustAllowAccountant = [
    "router.post('/transactions'", "router.patch('/transactions/:id'", "router.post('/transactions/:id/void'",
  ];
  for (const prefix of mustAllowAccountant) {
    const line = routeLines.find((l) => l.startsWith(prefix + ','))!;
    assert.match(line, /editorMiddleware/, `${prefix} should allow accountants`);
    assert.doesNotMatch(line, /adminMiddleware/);
  }

  // Backup, restore, wipe, user management and locks must stay admin-only.
  const adminOnly = [
    '/admin/restore-sqlite', '/admin/restore', '/admin/wipe', '/admin/users', '/admin/users/:id',
    '/admin/users/:id/disabled', '/admin/users/:id/reset-password', '/locks', '/locks/:periodKey/unlock',
    '/transactions/:id/verify', '/transactions/:id/restore',
    '/admin/import/preview', '/admin/import/validate', '/admin/import/commit',
  ];
  for (const p of adminOnly) {
    const line = routeLines.find((l) => l.includes(`('${p}',`));
    assert.ok(line, `route ${p} exists`);
    assert.match(line!, /adminMiddleware/, `${p} must stay admin-only`);
    assert.doesNotMatch(line!, /editorMiddleware/, `${p} must not be opened to accountants`);
  }
  for (const getPath of ['/admin/backup', '/admin/backup/sqlite', '/admin/users', '/admin/bin', '/admin/security-events']) {
    const line = src.split('\n').find((l) => l.startsWith(`router.get('${getPath}',`));
    assert.ok(line, `GET ${getPath} exists`);
    assert.match(line!, /adminMiddleware/, `GET ${getPath} must stay admin-only`);
  }
});

test('only an admin can set a base salary; an accountant pays the configured salary and cannot delete loans', async () => {
  const admin = db.getUserByUsername('admin')!;
  const acctUser = db.getUserByUsername('u_accountant')!;
  db.adminUpdateUser(acctUser.id, { role: 'accountant' }, admin.id);
  const acct = db.getUserById(acctUser.id)!;
  const source = db.getFundSources().find((s: any) => s.name === 'Company Revenue')!;
  const { validateSalaryPayInput } = await import('../server/validation');

  const emp = db.getEmployees().find((e: any) => e.monthlySalaryPaisa > 0)!;
  const unset = db.getEmployees().find((e: any) => e.id !== emp.id)!;
  db.updateEmployee(unset.id, { monthlySalaryPaisa: 0 }, admin as any);

  const pay = (employeeId: string, monthKey: string, base: string) => validateSalaryPayInput({
    employeeId, monthKey, paidDate: '2026-12-05', baseSalary: base, paymentMethod: 'Cash in Hand',
    department: 'BALUCHOR-OFFICE', head: 'BALUCHOR-OFFICE', fundSourceId: source.id,
  });

  // No configured salary: an accountant cannot invent one.
  assert.throws(() => db.payEmployeeSalary(pay(unset.id, '2026-12', '1000'), acct as any), /ask an administrator/i);

  // Configured salary: an accountant's typed base is ignored.
  const res = db.payEmployeeSalary(pay(emp.id, '2026-12', '1'), acct as any);
  assert.equal(res.payment.baseSalaryPaisa, emp.monthlySalaryPaisa);

  // Loan deletion is admin-only at the route level (see static guard test).
  const src = fs.readFileSync(path.join(process.cwd(), 'server', 'api.ts'), 'utf8').split('\n');
  for (const p of ["router.delete('/loans/:id',", "router.delete('/loans/:id/repayments/:repaymentId',", "router.patch('/employees/:id',"]) {
    const line = src.find((l) => l.startsWith(p))!;
    assert.match(line, /adminMiddleware/);
    assert.doesNotMatch(line, /editorMiddleware/);
  }
});
