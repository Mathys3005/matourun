import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * Long-press then drag a card onto another day (touch and mouse).
 * Day containers carry `data-day="YYYY-MM-DD"`. Scrolling stays native until the
 * long press fires; from then on the page doesn't scroll and the card follows the finger.
 */
const LONG_PRESS_MS = 320;
const MOVE_TOLERANCE = 8;

interface DragState {
  id: string;
  fromDay: string;
  overDay: string | null;
  dy: number;
}

export function useDragToDay(onDrop: (id: string, day: string) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const press = useRef<{ id: string; day: string; x: number; y: number; timer: number } | null>(null);
  const dragging = useRef<DragState | null>(null);
  const startY = useRef(0);
  const justDragged = useRef(false);

  const dayAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest("[data-day]") as HTMLElement | null)?.dataset.day ?? null;

  const end = useCallback(
    (commit: boolean) => {
      const d = dragging.current;
      dragging.current = null;
      setDrag(null);
      if (d) {
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 50);
        if (commit && d.overDay && d.overDay !== d.fromDay) onDrop(d.id, d.overDay);
      }
    },
    [onDrop],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (p && !dragging.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE) {
          clearTimeout(p.timer);
          press.current = null; // it's a scroll or a swipe, not a long press
        }
        return;
      }
      const d = dragging.current;
      if (!d) return;
      const next = { ...d, dy: e.clientY - startY.current, overDay: dayAt(e.clientX, e.clientY) };
      dragging.current = next;
      setDrag(next);
      // Auto-scroll near the screen edges.
      if (e.clientY < 90) window.scrollBy(0, -12);
      else if (e.clientY > window.innerHeight - 150) window.scrollBy(0, 12);
    };
    const up = () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      end(true);
    };
    const cancel = () => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = null;
      end(false);
    };
    // While dragging, stop the page from scrolling (must be non-passive for iOS).
    const blockScroll = (e: TouchEvent) => {
      if (dragging.current) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    document.addEventListener("touchmove", blockScroll, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      document.removeEventListener("touchmove", blockScroll);
    };
  }, [end]);

  const bind = (id: string, day: string) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("button")) return; // the export button keeps its own tap
      const x = e.clientX;
      const y = e.clientY;
      const timer = window.setTimeout(() => {
        press.current = null;
        startY.current = y;
        const d = { id, fromDay: day, overDay: day, dy: 0 };
        dragging.current = d;
        setDrag(d);
        navigator.vibrate?.(12);
      }, LONG_PRESS_MS);
      press.current = { id, day, x, y, timer };
    },
    onContextMenu: (e: ReactMouseEvent) => e.preventDefault(),
    /** Cancels the click (navigation) that follows a drop. */
    onClickCapture: (e: ReactMouseEvent) => {
      if (justDragged.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  });

  return { drag, bind };
}
