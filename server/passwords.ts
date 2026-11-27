import crypto from 'crypto';

 
 
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;  
const SCRYPT_N = 32768;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const HASH_PREFIX = 'scrypt$';
const scryptAsync = (password: string, salt: Buffer, keylen: number, N: number) =>
  new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: SCRYPT_N, maxmem: SCRYPT_MAXMEM });
  return `${HASH_PREFIX}${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function isPasswordHash(stored: string): boolean {
  return stored.startsWith(HASH_PREFIX);
}

 
export function needsRehash(stored: string): boolean {
  return isPasswordHash(stored) && Number(stored.split('$')[1]) < SCRYPT_N;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || !isPasswordHash(stored)) return false;
  const [, n, saltHex, hashHex] = stored.split('$');
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n), maxmem: SCRYPT_MAXMEM });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

 
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  if (!password || !isPasswordHash(stored)) return false;
  const [, n, saltHex, hashHex] = stored.split('$');
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, Number(n));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT_N);
  return `${HASH_PREFIX}${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', '1234567890', '12345678', '123456789', '0123456789',
  'qwertyuiop', 'qwerty123', 'qwerty1234', '1q2w3e4r5t', 'iloveyou', 'admin', 'admin123', 'admin1234', 'admin12345',
  'welcome123', 'letmein123', 'paceit', 'paceit123', 'paceit1234', 'pace_it', 'abc1234567', '1111111111', '0000000000',
]);

 
export function passwordProblem(password: unknown, username?: string): string | null {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 200) return 'Password is too long (200 characters at most).';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too common. Choose a less guessable one.';
  if (username && (lower === username.toLowerCase() || lower.includes(username.toLowerCase()) && username.length >= 4)) return 'The password must not contain the username.';
  return null;
}

 
export function cleanPhotoUrl(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  const v = String(raw).trim();
  if (!v) return '';
  if (v.length > 600_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(v)) {
    throw new Error('The photo must be an uploaded image (JPG, PNG or WebP).');
  }
  return v;
}

export function randomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(14), (b) => chars[b % chars.length]).join('');
}
