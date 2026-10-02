import type { Grid } from './grid.ts';
import type { Store } from './store.ts';

const HOLD_MS = 320; // touch: press and hold to pick a card up
const MOUSE_SLOP = 6; // mouse: this much movement turns a press into a drag
const TOUCH_SLOP = 8; // touch: moving this much before the hold means it's a scroll
const SWAP_AT = 0.5; // cover this much of a card (the smaller of the two) to take its place
const EDGE = 64; // auto-scroll zone at the top and bottom of the screen
const BIN_REACH = 28; // extra room around the corner button when dropping onto it
const EASE = 'cubic-bezier(.2, .8, .2, 1)';

type Press = { id: string; card: HTMLElement; pointer: number; touch: boolean; x: number; y: number; timer: number };
type Box = { left: number; top: number; right: number; bottom: number };
type Dragging = {
  id: string;
  card: HTMLElement;
  // the floating copy that follows the pointer
  ghost: HTMLElement;
  pointer: number;
  // where on the card it was grabbed
  grabX: number;
  grabY: number;
  // where the copy sits before any movement, and its size
  left: number;
  top: number;
  w: number;
  h: number;
  x: number;
  y: number;
  // cards it's already over; only moving onto a new one causes a swap
  over: Set<string>;
  away: boolean;
};

/** How much two boxes share, as a share of the smaller one (0 to 1). */
function cover(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const area = (r: Box) => (r.right - r.left) * (r.bottom - r.top);
  return (w * h) / Math.min(area(a), area(b));
}

/**
 * Rearranging the board: drag a card (press and hold first on a phone, so a
 * normal swipe still scrolls). Once it covers half of another card, the two
 * trade places; carried into empty space at the bottom of a column, it goes to
 * the end. Dropping it on the corner button (a + that turns into a × while
 * dragging) deletes it.
 */
export class Drag {
  private grid: Grid;
  private store: Store;
  private bin: HTMLElement;
  private press: Press | null = null;
  private drag: Dragging | null = null;
  private scrolling = 0;
  private swallowClick = false;

  constructor(root: HTMLElement, grid: Grid, store: Store, bin: HTMLElement) {
    this.grid = grid;
    this.store = store;
    this.bin = bin;
    grid.onLayout = () => this.place();

    root.addEventListener('pointerdown', (e) => this.down(e));
    addEventListener('pointermove', (e) => this.move(e));
    addEventListener('pointerup', (e) => this.up(e));
    addEventListener('pointercancel', (e) => this.up(e, true));
    // Once a card is picked up, the finger moves the card, not the page.
    root.addEventListener(
      'touchmove',
      (e) => {
        if (this.drag) e.preventDefault();
      },
      { passive: false },
    );
    root.addEventListener('contextmenu', (e) => {
      if (this.press?.touch || this.drag) e.preventDefault();
    });
    // A drag ends with a click on the card; that click shouldn't open it.
    root.addEventListener(
      'click',
      (e) => {
        if (!this.swallowClick) return;
        this.swallowClick = false;
        e.stopPropagation();
      },
      true,
    );
  }

  private down(e: PointerEvent) {
    if (e.button !== 0 || this.drag) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (!card?.dataset.id) return;
    const touch = e.pointerType !== 'mouse';
    this.press = {
      id: card.dataset.id,
      card,
      pointer: e.pointerId,
      touch,
      x: e.clientX,
      y: e.clientY,
      timer: touch ? setTimeout(() => this.begin(), HOLD_MS) : 0,
    };
  }

  private move(e: PointerEvent) {
    const p = this.press;
    if (p && e.pointerId === p.pointer) {
      const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (p.touch && d > TOUCH_SLOP) this.release();
      else if (!p.touch && d > MOUSE_SLOP) this.begin();
      return;
    }
    const g = this.drag;
    if (!g || e.pointerId !== g.pointer) return;
    g.x = e.clientX;
    g.y = e.clientY;
    this.place();
    this.retarget();
    this.autoscroll();
  }

  private up(e: PointerEvent, cancelled = false) {
    if (this.press && e.pointerId === this.press.pointer) {
      this.release();
      return;
    }
    if (this.drag && e.pointerId === this.drag.pointer) {
      this.end(!cancelled);
      this.swallowClick = true;
      setTimeout(() => (this.swallowClick = false));
    }
  }

  private release() {
    clearTimeout(this.press?.timer);
    this.press = null;
  }

  private begin() {
    const p = this.press!;
    this.release();
    // What moves is a floating copy; the card stays in the grid as an empty slot
    // showing where it will land. (Moving the card itself would stretch the page.)
    const rect = p.card.getBoundingClientRect();
    const ghost = p.card.cloneNode(true) as HTMLElement;
    ghost.classList.add('ghost');
    ghost.removeAttribute('tabindex');
    ghost.removeAttribute('role');
    Object.assign(ghost.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      fontSize: getComputedStyle(p.card).fontSize,
      transformOrigin: `${p.x - rect.left}px ${p.y - rect.top}px`,
    });
    document.body.append(ghost);
    p.card.classList.add('slot');

    this.drag = {
      id: p.id,
      card: p.card,
      ghost,
      pointer: p.pointer,
      grabX: p.x - rect.left,
      grabY: p.y - rect.top,
      left: rect.left,
      top: rect.top,
      w: rect.width,
      h: rect.height,
      x: p.x,
      y: p.y,
      over: new Set(),
      away: false,
    };
    this.grid.drag = { id: p.id, order: this.grid.order().map((o) => o.id) };
    document.documentElement.classList.add('dragging');
    navigator.vibrate?.(8);
    this.place();
  }

  /** Keeps the floating copy under the pointer. */
  private place() {
    const g = this.drag;
    if (!g) return;
    g.ghost.style.transform = `translate(${g.x - g.grabX - g.left}px, ${g.y - g.grabY - g.top}px) scale(1.03)`;
  }

  private retarget() {
    const g = this.drag!;
    const b = this.bin.getBoundingClientRect();
    const away =
      g.x > b.left - BIN_REACH && g.x < b.right + BIN_REACH && g.y > b.top - BIN_REACH && g.y < b.bottom + BIN_REACH;
    if (away !== g.away) {
      g.away = away;
      g.ghost.classList.toggle('away', away);
      this.bin.classList.toggle('hot', away);
    }
    if (away) return;

    // Judged against where cards are settling, not where they are mid-glide.
    const order = this.grid.order();
    const covered = this.covered(g);
    // Cards it has moved off can count again; cards it's still over can't.
    for (const id of g.over) if (!covered.has(id)) g.over.delete(id);

    let target = -1;
    let best = 0;
    order.forEach((o, k) => {
      const c = covered.get(o.id);
      if (c !== undefined && !g.over.has(o.id) && c > best) {
        best = c;
        target = k;
      }
    });

    const ids = order.map((o) => o.id);
    const from = ids.indexOf(g.id);
    if (target >= 0) {
      // the two trade places
      [ids[from], ids[target]] = [ids[target], ids[from]];
    } else {
      // carried below everything in a column (or into an empty one): to the end
      const box = this.box(g);
      const end = this.grid.columnEnd((box.left + box.right) / 2);
      if (end === null || (box.top + box.bottom) / 2 <= end || from === ids.length - 1) return;
      ids.push(...ids.splice(from, 1));
    }
    this.grid.drag = { id: g.id, order: ids };
    this.grid.layout(true);
    // Whatever is under it now (moved there or not) has to be left before it counts.
    g.over = new Set(this.covered(g).keys());
  }

  /** Where the floating copy is, at the card's own size. */
  private box(g: Dragging): Box {
    const left = g.x - g.grabX;
    const top = g.y - g.grabY;
    return { left, top, right: left + g.w, bottom: top + g.h };
  }

  /** The other cards it covers enough of to take their place, and by how much. */
  private covered(g: Dragging): Map<string, number> {
    const box = this.box(g);
    const out = new Map<string, number>();
    for (const o of this.grid.order()) {
      if (o.id === g.id) continue;
      const slot = this.grid.slot(o.id);
      const c = slot ? cover(box, slot) : 0;
      if (c >= SWAP_AT) out.set(o.id, c);
    }
    return out;
  }

  private autoscroll() {
    if (this.scrolling) return;
    const step = () => {
      const g = this.drag;
      // no scrolling while hovering the ×, which sits at the bottom edge
      const speed =
        !g || g.away ? 0 : g.y < EDGE ? (g.y - EDGE) / EDGE : g.y > innerHeight - EDGE ? (g.y - innerHeight + EDGE) / EDGE : 0;
      if (!speed) {
        this.scrolling = 0;
        return;
      }
      scrollBy(0, speed * 16);
      this.place();
      this.retarget();
      this.scrolling = requestAnimationFrame(step);
    };
    this.scrolling = requestAnimationFrame(step);
  }

  private end(commit: boolean) {
    const g = this.drag!;
    this.drag = null;
    cancelAnimationFrame(this.scrolling);
    this.scrolling = 0;
    const arranged = this.grid.order().map((o) => o.id);
    this.grid.drag = null;
    document.documentElement.classList.remove('dragging');
    this.bin.classList.remove('hot');

    const { card, ghost } = g;
    const lift = ghost.style.transform;
    const done = () => {
      ghost.remove();
      card.classList.remove('slot');
    };

    if (commit && g.away) {
      // the card shrinks into the × as it goes: the point being held lands on its center
      const b = this.bin.getBoundingClientRect();
      const toBin = `translate(${b.left + b.width / 2 - g.x}px, ${b.top + b.height / 2 - g.y}px)`;
      ghost
        .animate([{ transform: lift, opacity: 0.55 }, { transform: `${toBin} ${lift} scale(.04)`, opacity: 0 }], {
          duration: 220,
          easing: 'cubic-bezier(.4, 0, .7, .2)',
          fill: 'forwards',
        })
        .finished.then(done, done);
      this.store.removeObj(g.id);
      return;
    }
    if (commit) this.store.arrange(arranged);
    this.grid.layout(true);
    if (!card.isConnected) {
      // deleted on the other device mid-drag
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: 'forwards' }).finished.then(done, done);
      return;
    }
    // glide into the slot, then swap back to the real card
    const to = card.getBoundingClientRect();
    ghost
      .animate([{ transform: lift }, { transform: `translate(${to.left - g.left}px, ${to.top - g.top}px)` }], {
        duration: 200,
        easing: EASE,
        fill: 'forwards',
      })
      .finished.then(done, done);
  }
}
