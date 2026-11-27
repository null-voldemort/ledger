import { RefObject, useCallback, useLayoutEffect, useRef } from 'react';

export const SIDEBAR_MS = 260;
export const SIDEBAR_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const SIDEBAR_PANEL_ID = 'app-sidebar-panel';

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Smooth desktop sidebar collapse/expand without per-frame page layout.
 *
 * The page content ("stage") has a fixed width that does not depend on the
 * sidebar, so it never reflows or gets squeezed. Only its position changes,
 * and that is animated with a GPU-only transform. The sidebar panel animates
 * its own width (tiny, isolated subtree).
 */
export function useSidebarSlide(
  row: RefObject<HTMLElement | null>,
  stage: RefObject<HTMLElement | null>,
  open: boolean,
) {
  const before = useRef<{ panelW: number; stageLeft: number } | null>(null);
  const running = useRef<Animation[]>([]);

  const capture = useCallback(() => {
    const panel = document.getElementById(SIDEBAR_PANEL_ID);
    const m = stage.current;
    if (!panel || !m) { before.current = null; return; }
    before.current = {
      panelW: panel.getBoundingClientRect().width,
      stageLeft: m.getBoundingClientRect().left,
    };
  }, [stage]);

  useLayoutEffect(() => {
    const from = before.current;
    before.current = null;
    const r = row.current;
    const m = stage.current;
    const panel = document.getElementById(SIDEBAR_PANEL_ID);

    running.current.forEach((a) => a.cancel());
    running.current = [];

    if (!from || !r || !m || !panel || reduced()) { if (r) r.style.overflowX = ''; return; }

    const opts: KeyframeAnimationOptions = { duration: SIDEBAR_MS, easing: SIDEBAR_EASE };
    const anims: Animation[] = [];

    const panelTo = panel.getBoundingClientRect().width;
    if (Math.abs(from.panelW - panelTo) > 0.5) {
      anims.push(panel.animate([{ width: `${from.panelW}px` }, { width: `${panelTo}px` }], opts));
    }

    const dx = from.stageLeft - m.getBoundingClientRect().left;
    if (Math.abs(dx) > 0.5) {
      anims.push(m.animate(
        [{ transform: `translate3d(${dx}px,0,0)` }, { transform: 'translate3d(0,0,0)' }],
        opts,
      ));
    }

    if (!anims.length) { r.style.overflowX = ''; return; }

    r.style.overflowX = 'clip';
    running.current = anims;
    Promise.allSettled(anims.map((a) => a.finished)).then(() => {
      if (running.current === anims) { running.current = []; r.style.overflowX = ''; }
    });
  }, [open, row, stage]);

  return { capture };
}
