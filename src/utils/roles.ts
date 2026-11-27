// Single source of truth for account roles and what each one may do.
// Imported by both the Express server and the React client.
//
// Permission model:
//   admin       - everything (users, roles, locks, backup/restore, verification, master data)
//   accountant  - enter, edit and void ledger entries (history and audit trail are preserved)
//   all others  - strictly read-only. They are titles only and carry no write access.
//
// Anything not explicitly listed as a writer is read-only, so an unknown or
// corrupted role value can never gain write access.

export const USER_ROLES = [
  'admin',
  'accountant',
  'general_manager',
  'ceo',
  'cto',
  'visitor',
  'user',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Finance Admin',
  accountant: 'Accountant',
  general_manager: 'General Manager',
  ceo: 'CEO',
  cto: 'CTO',
  visitor: 'Visitor',
  user: 'User',
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Full access, including users, roles, locks, backup and restore.',
  accountant: 'Can enter, edit and void entries. No backup, restore, users or locks.',
  general_manager: 'Read-only.',
  ceo: 'Read-only.',
  cto: 'Read-only.',
  visitor: 'Read-only.',
  user: 'Read-only.',
};

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** Unknown values collapse to the read-only 'user' role, never to a privileged one. */
export function normalizeRole(value: unknown): UserRole {
  return isUserRole(value) ? value : 'user';
}

export function isAdminRole(role: unknown): boolean {
  return role === 'admin';
}

/** May enter, edit and void ledger entries. */
export function canEditRole(role: unknown): boolean {
  return role === 'admin' || role === 'accountant';
}

export function roleLabel(role: unknown): string {
  return ROLE_LABELS[normalizeRole(role)];
}

/** Text for role dropdowns, so the permission is visible at the point of choice. */
export function roleOptionLabel(role: UserRole): string {
  if (role === 'admin') return `${ROLE_LABELS.admin} — full access`;
  if (role === 'accountant') return `${ROLE_LABELS.accountant} — enter, edit, void`;
  return `${ROLE_LABELS[role]} — read-only`;
}
