import { useCallback, useEffect, useRef, useState } from 'react';

const mem = new Map<string, unknown>();

export function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (mem.has(key)) return mem.get(key) as T;
    return initial;
  });
  useEffect(() => {
    mem.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

const scrolls = new Map<string, number>();
export function useScrollMemory(key: string) {
  const keyRef = useRef(key);
  keyRef.current = key;
  const ref = useCallback((el: HTMLElement | null) => {
    if (el) { const y = scrolls.get(keyRef.current); if (y) requestAnimationFrame(() => { el.scrollTop = y; }); }
  }, []);
  const onScroll = useCallback((e: React.UIEvent<HTMLElement>) => { scrolls.set(keyRef.current, e.currentTarget.scrollTop); }, []);
  return { ref, onScroll } as { ref: React.RefCallback<HTMLElement>; onScroll: React.UIEventHandler<HTMLElement> };
}
