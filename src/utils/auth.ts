import { AppUser, ThemeMode } from '../types';

let memDeviceId = '';
let memLastUser = '';

export function getDeviceId(): string {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(memDeviceId)) {
    try {
      memDeviceId = crypto.randomUUID();
    } catch {
      memDeviceId = `dev-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    }
  }
  return memDeviceId;
}

function deviceInfo() {
  try {
    return { screen: `${screen.width}x${screen.height}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language };
  } catch {
    return {};
  }
}

export function getLastUser(): string {
  return memLastUser;
}

export function setLastUser(name: string): void {
  memLastUser = name;
}

const authListeners = new Set<(user: AppUser | null) => void>();

function notifyAuthChange(user: AppUser | null) {
  authListeners.forEach((cb) => {
    try { cb(user); } catch (e) { console.error('Auth listener error:', e); }
  });
}

export async function getSetupStatus(): Promise<{ needsSetup: boolean }> {
  const res = await fetch('/api/auth/setup-status', { credentials: 'include' });
  if (!res.ok) return { needsSetup: false };
  return res.json();
}

export async function setupFirstAdmin(input: {
  username: string;
  displayName: string;
  password: string;
  loadSampleData: boolean;
}): Promise<AppUser> {
  const res = await fetch('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceId() },
    credentials: 'include',
    body: JSON.stringify({ ...input, device: deviceInfo() }),
  });
  if (!res.ok) {
    let msg = 'Setup failed.';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const { user } = await res.json();
  setLastUser(user.username);
  notifyAuthChange(user);
  return user;
}

export async function login(username: string, password: string): Promise<AppUser> {
  const normalized = username.trim().toLowerCase().replace(/\s+/g, '_');
  if (!normalized || !password) throw new Error('Username and password are required.');

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': getDeviceId() },
    credentials: 'include',
    body: JSON.stringify({ username: normalized, password, device: deviceInfo() }),
  });

  if (!res.ok) {
    let msg = 'Invalid username or password.';
    try {
      const data = await res.json();
      if (data.error) msg = data.error;
    } catch {}
    throw new Error(msg);
  }

  const { user } = await res.json();
  setLastUser(user.username);
  notifyAuthChange(user);
  return user;
}

export async function getCurrentUser(): Promise<AppUser | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch {
    return null;
  }
}

export async function changePassword(currentPassword: string, password: string): Promise<void> {
  if (!currentPassword) throw new Error('Enter your current password.');
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ currentPassword, password }),
  });
  if (!res.ok) {
    let msg = 'Could not change password.';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
}

export async function updateUserProfile(data: {
  username?: string;
  currentPassword?: string;
  displayName?: string;
  phoneNumber?: string;
  email?: string;
  photoUrl?: string;
  theme?: ThemeMode;
}): Promise<AppUser> {
  const res = await fetch('/api/auth/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    let msg = 'Could not update profile.';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const result = await res.json();
  const user = result.user as AppUser;
  setLastUser(user.username);
  notifyAuthChange(user);
  return user;
}

export async function updatePreferences(theme: ThemeMode): Promise<AppUser> {
  const res = await fetch('/api/auth/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) {
    let msg = 'Could not save preferences.';
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const result = await res.json();
  return result.user as AppUser;
}

export async function getAccessToken(): Promise<string> {
  return '';
}

export async function signOut(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {}
  notifyAuthChange(null);
}

export function onAuthChange(callback: (user: AppUser | null) => void) {
  authListeners.add(callback);
  getCurrentUser().then((u) => callback(u)).catch(() => callback(null));
  return () => { authListeners.delete(callback); };
}