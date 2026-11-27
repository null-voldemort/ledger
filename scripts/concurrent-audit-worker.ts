import { db } from '../server/db';
import { validateTransactionInput } from '../server/validation';

await db.ready();

const workerId = Number(process.env.WORKER_ID);
if (!Number.isInteger(workerId) || workerId < 1 || workerId > 8) {
  throw new Error('WORKER_ID must be an integer between 1 and 8.');
}

const storedAdmin = db.getUserByUsername('load_test_admin');
if (!storedAdmin || storedAdmin.disabled || storedAdmin.role !== 'admin') {
  throw new Error('Load-test administrator is missing or disabled.');
}
const actor = {
  id: storedAdmin.id,
  username: storedAdmin.username,
  displayName: storedAdmin.displayName,
  role: storedAdmin.role,
  theme: storedAdmin.theme,
  disabled: storedAdmin.disabled,
  phoneNumber: storedAdmin.phoneNumber,
  email: storedAdmin.email,
  photoUrl: storedAdmin.photoUrl,
  createdAt: storedAdmin.createdAt,
};
const fundSource = db.getFundSources().find((source) => source.active);
if (!fundSource) throw new Error('No active fund source is available for concurrent writes.');
const department = db.getDepartments().find((item) => item.active)?.name || 'ALHAMRA-OFFICE';
const head = db.getHeads().find((item) => item.active && item.kind === 'income')?.name || 'OTHER-INCOME';

for (let index = 0; index < 5; index += 1) {
  const referenceNo = `LOAD-CONCURRENT-${workerId}-${index}`;
  const input = (amount: string, reason?: string) => validateTransactionInput({
    kind: 'income',
    txDate: '2026-11-26',
    amount,
    department,
    head,
    subCategory: 'Concurrent API write test',
    paymentMethod: 'Cash in Hand',
    referenceNo,
    counterparty: `Concurrent API writer ${workerId}`,
    purpose: 'Atomic transaction and audit-chain concurrency verification',
    fundSourceId: fundSource.id,
    ...(reason ? { reason } : {}),
  }, Boolean(reason));

  const created = db.createTransaction(input('1.00'), actor);
  db.editTransaction(created.id, input('1.25', 'Concurrent writer edit verification'), actor);
}
