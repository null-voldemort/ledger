import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

export function initialTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

let current: Theme =
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return current;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

export interface ThemeOrigin { x: number; y: number }

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void> };
type StartViewTransition = (cb: () => void) => ViewTransitionLike;

// ---- Device tier -----------------------------------------------------------------------------------
// The circular reveal is a GPU-composited effect, but on very weak machines even that can stutter. So the
// app starts from cheap hardware hints and then self-tunes: it counts dropped frames during the first
// reveals and, if the machine struggles, falls back to a short cross-fade (and remembers that choice).
const FX_KEY = 'pace_fx_low';

function readLowEndHint(): boolean {
  try {
    if (localStorage.getItem(FX_KEY) === '1') return true;
  } catch { /* storage unavailable */ }
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2) return true;
    if (nav.deviceMemory && nav.deviceMemory <= 2) return true;
    if (window.matchMedia('(prefers-reduced-data: reduce)').matches) return true;
  } catch { /* ignore */ }
  return false;
}

let lowEnd = typeof window !== 'undefined' ? readLowEndHint() : false;

function markLowEnd() {
  lowEnd = true;
  try { localStorage.setItem(FX_KEY, '1'); } catch { /* ignore */ }
}

/** Counts slow frames while the reveal plays; a clearly struggling device switches to the light effect. */
function watchFrames(ms: number) {
  let last = 0;
  let frames = 0;
  let slow = 0;
  const end = performance.now() + ms;
  const tick = (now: number) => {
    if (last) {
      frames++;
      if (frames > 2 && now - last > 28) slow++; // ignore the first frames (snapshot capture)
    }
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else if (frames > 10 && slow / (frames - 2) > 0.2) markLowEnd();
  };
  requestAnimationFrame(tick);
}

// Set to false to always use the plain cross-fade instead of the circular reveal.
const REVEAL_ENABLED = true;
const REVEAL_MS = 500;
const REVEAL_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Switch the theme.
 * - With `origin` (a click position) the new theme grows out of that point as a circle: the browser takes one
 *   snapshot of the old and new page and only a clip-path is animated, so nothing re-lays-out per frame.
 * - Without it (automatic switches on sign-in / startup) it is a short, quiet cross-fade.
 * - Reduced-motion users, hidden tabs and browsers without the View Transitions API switch instantly.
 */
export function applyTheme(t: Theme, opts?: { origin?: ThemeOrigin }): void {
  if (t === current) return;
  current = t;
  const root = document.documentElement;
  // The app has ~90 elements with their own colour transitions (buttons, cards, borders). If those run while the
  // theme flips, every box fades on its own clock and its outline flickers through the page-wide effect. So all
  // element transitions are frozen for the switch (html.theme-switching) and released once it has finished.
  const commit = () => {
    root.classList.add('theme-switching');
    root.classList.toggle('dark', t === 'dark');
    listeners.forEach((fn) => fn());
  };
  const release = () => {
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  };
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const vt = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!animate || typeof vt !== 'function' || document.visibilityState !== 'visible') {
    commit();
    release();
    return;
  }

  const origin = opts?.origin;
  const reveal = REVEAL_ENABLED && !!origin && !lowEnd;
  try {
    if (reveal) root.classList.add('theme-reveal');
    const transition = vt.call(document, commit);
    if (reveal && origin) {
      const { x, y } = origin;
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      transition.ready
        .then(() => {
          root.animate(
            { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${Math.ceil(radius)}px at ${x}px ${y}px)`] },
            { duration: REVEAL_MS, easing: REVEAL_EASE, pseudoElement: '::view-transition-new(root)' },
          );
          watchFrames(REVEAL_MS);
        })
        .catch(() => { /* transition was skipped (e.g. a second quick toggle) */ });
    }
    transition.finished.catch(() => undefined).finally(() => {
      root.classList.remove('theme-reveal');
      release();
    });
  } catch {
    root.classList.remove('theme-reveal');
    commit();
    release();
  }
}
