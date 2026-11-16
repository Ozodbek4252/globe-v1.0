import { clampLat } from '../lib/geo';
import { setZoom, type GlobeState } from './state';
import type { Rotation } from './projection';

/** What the input layer reports upward; everything else it does directly on the shared state. */
export interface InputCallbacks {
  /** The pointer moved over the globe with no drag in progress. x/y are canvas-relative. */
  hover(x: number, y: number, event: PointerEvent): void;
  /** The pointer left the canvas while not dragging. */
  leave(): void;
  /** A drag is moving the globe. */
  dragMoved(): void;
  /** A press-and-release without moving: a click at canvas-relative x/y. */
  click(x: number, y: number): void;
  /** Escape was pressed on the canvas. */
  escape(): void;
}

interface Drag {
  x: number;
  y: number;
  rot: Rotation;
  moved: number;
  lastX: number;
  lastY: number;
  lastT: number;
}

interface Pinch {
  /** distance between the two pointers at the start */
  d: number;
  /** zoom at the start */
  z: number;
}

/** Degrees of rotation per pixel of drag at zoom 1; divided by the on-screen radius. */
const DRAG_DEGREES = 75;
/** A drag shorter than this many pixels counts as a click. */
const CLICK_SLOP = 5;
/** If the pointer rested this long before release, the globe does not coast. */
const COAST_REST_MS = 80;

/**
 * Wire drag with inertia, pinch and wheel zoom, and keyboard control to a canvas.
 * Returns a function that removes every listener.
 */
export function attachInput(
  canvas: HTMLCanvasElement,
  state: GlobeState,
  callbacks: InputCallbacks,
): () => void {
  const pointers = new Map<number, [number, number]>();
  let drag: Drag | null = null;
  let pinch: Pinch | null = null;

  const pairDistance = (): number => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0;
  };

  function onPointerDown(e: PointerEvent): void {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    state.flying = null;
    state.vel = [0, 0];
    if (pointers.size === 1) {
      drag = {
        x: e.offsetX,
        y: e.offsetY,
        rot: [...state.rot],
        moved: 0,
        lastX: e.offsetX,
        lastY: e.offsetY,
        lastT: performance.now(),
      };
      state.dragging = true;
      canvas.style.cursor = 'grabbing';
    } else if (pointers.size === 2) {
      pinch = { d: pairDistance(), z: state.zoom };
      drag = null;
      state.dragging = false;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
    if (pinch && pointers.size === 2) {
      setZoom(state, (pinch.z * pairDistance()) / pinch.d);
      return;
    }
    if (drag) {
      const dx = e.offsetX - drag.x;
      const dy = e.offsetY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      const k = DRAG_DEGREES / (state.baseScale * state.zoom);
      state.rot = [drag.rot[0] + dx * k, clampLat(drag.rot[1] - dy * k), 0];
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT);
      state.vel = [((e.offsetX - drag.lastX) * k) / dt, (-(e.offsetY - drag.lastY) * k) / dt];
      drag.lastX = e.offsetX;
      drag.lastY = e.offsetY;
      drag.lastT = now;
      state.dirty = true;
      callbacks.dragMoved();
      return;
    }
    callbacks.hover(e.offsetX, e.offsetY, e);
  }

  function onPointerEnd(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && pointers.size === 0) {
      if (drag.moved < CLICK_SLOP) {
        state.vel = [0, 0];
        callbacks.click(e.offsetX, e.offsetY);
      } else if (performance.now() - drag.lastT > COAST_REST_MS) {
        state.vel = [0, 0];
      }
      drag = null;
      state.dragging = false;
      canvas.style.cursor = 'grab';
    }
  }

  function onPointerLeave(): void {
    if (!drag) callbacks.leave();
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    setZoom(state, state.zoom * Math.exp(-e.deltaY * 0.0015));
  }

  function onKeyDown(e: KeyboardEvent): void {
    const step = 8 / state.zoom;
    let move: [number, number] | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        move = [step, 0];
        break;
      case 'ArrowRight':
        move = [-step, 0];
        break;
      case 'ArrowUp':
        move = [0, -step];
        break;
      case 'ArrowDown':
        move = [0, step];
        break;
    }
    if (move) {
      state.rot[0] += move[0];
      state.rot[1] = clampLat(state.rot[1] + move[1]);
      state.dirty = true;
      e.preventDefault();
    }
    if (e.key === '+' || e.key === '=') setZoom(state, state.zoom * 1.25);
    if (e.key === '-') setZoom(state, state.zoom / 1.25);
    if (e.key === 'Escape') callbacks.escape();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerEnd);
    canvas.removeEventListener('pointercancel', onPointerEnd);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
  };
}
