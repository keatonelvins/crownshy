import type { Change, Obj, Store } from './store.ts';

const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

interface Metrics {
  width: number;
  pad: number;
  gap: number;
  n: number;
  fs: number;
}

function metrics(): Metrics {
  const width = document.documentElement.clientWidth;
  const phone = width < 600;
  const pad = phone ? 10 : 28;
  const gap = phone ? 10 : 22;
  const n = Math.max(2, Math.floor((width - 2 * pad + gap) / (250 + gap)));
  const colW = (width - 2 * pad - gap * (n - 1)) / n;
  // Type grows with the column so cards keep their proportions on every screen.
  const fs = Math.min(15.5, Math.max(11.5, 7 + colW * 0.026));
  return { width, pad, gap, n, fs };
}

/**
 * The board: cards in balanced columns. Each card goes into the shortest column
 * in board order, so new things land top-left. Columns are only rebalanced when
 * cards are added, removed or reordered, never while one is being written in,
 * so nothing jumps around under you.
 */
export class Grid {
  /** Called when a card is tapped. */
  onOpen: (id: string, card: HTMLElement) => void = () => {};
  /** Called after every layout pass. */
  onLayout = () => {};
  /** The card currently lifted into the sheet, kept hidden here. */
  lifted: string | null = null;
  /** A card being dragged, and the place in the order it would drop into. */
  drag: { id: string; index: number } | null = null;

  private root: HTMLElement;
  private store: Store;
  private cols: HTMLElement[] = [];
  private cards = new Map<string, HTMLElement>();
  private moves = new WeakMap<HTMLElement, Animation>();
  private width = 0;

  constructor(root: HTMLElement, store: Store) {
    this.root = root;
    this.store = store;
    store.subscribe((c) => this.update(c));
    root.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
      if (card?.dataset.id) this.onOpen(card.dataset.id, card);
    });
    root.addEventListener('keydown', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
      if (card?.dataset.id && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.onOpen(card.dataset.id, card);
      }
    });
  }

  card(id: string): HTMLElement | undefined {
    return this.cards.get(id);
  }

  /** Board order as shown, including where a dragged card would land. */
  order() {
    const order = this.store.ordered();
    const drag = this.drag;
    if (!drag) return order;
    const rest = order.filter((o) => o.id !== drag.id);
    const dragged = this.store.live(drag.id);
    if (dragged) rest.splice(Math.min(drag.index, rest.length), 0, dragged);
    return rest;
  }

  setLifted(id: string | null) {
    if (this.lifted) this.cards.get(this.lifted)?.classList.remove('lifted');
    this.lifted = id;
    if (id) this.cards.get(id)?.classList.add('lifted');
  }

  /** Re-lays out only if the width changed (phones fire resize while scrolling). */
  resize() {
    if (document.documentElement.clientWidth !== this.width) this.layout(false);
  }

  layout(animate: boolean) {
    const m = metrics();
    this.width = m.width;
    const style = document.documentElement.style;
    style.setProperty('--pad', `${m.pad}px`);
    style.setProperty('--gap', `${m.gap}px`);
    style.setProperty('--fs', `${m.fs.toFixed(2)}px`);

    const order = this.order();
    const live = new Set(order.map((o) => o.id));

    // First positions, for animating whatever moves (the dragged card follows the pointer instead).
    const first = new Map<string, DOMRect>();
    if (animate) {
      for (const [id, el] of this.cards) {
        if (live.has(id) && id !== this.drag?.id) first.set(id, el.getBoundingClientRect());
      }
    }

    if (this.cols.length !== m.n) {
      this.cols = Array.from({ length: m.n }, () => {
        const col = document.createElement('div');
        col.className = 'col';
        return col;
      });
      this.root.replaceChildren(...this.cols);
    }

    for (const [id, el] of this.cards) {
      if (!live.has(id)) {
        el.remove();
        this.cards.delete(id);
      }
    }
    const added: HTMLElement[] = [];
    for (const o of order) {
      let el = this.cards.get(o.id);
      if (!el) {
        el = this.createCard(o);
        this.cards.set(o.id, el);
        added.push(el);
      }
      // Anything not in a current column goes somewhere column-wide, so it can be measured.
      if (!this.cols.includes(el.parentElement!)) this.cols[0].append(el);
    }

    // Every card sits in a column of the same width, so heights are final.
    const heights = order.map((o) => this.cards.get(o.id)!.offsetHeight);
    const colHeights = new Array<number>(m.n).fill(0);
    const placed: HTMLElement[][] = this.cols.map(() => []);
    order.forEach((o, k) => {
      let best = 0;
      for (let c = 1; c < m.n; c++) if (colHeights[c] < colHeights[best] - 1) best = c;
      placed[best].push(this.cards.get(o.id)!);
      colHeights[best] += heights[k] + m.gap;
    });
    placed.forEach((els, c) => {
      const col = this.cols[c];
      els.forEach((el, k) => {
        if (col.children[k] !== el) col.insertBefore(el, col.children[k] ?? null);
      });
    });

    if (animate && !reducedMotion.matches) {
      for (const [id, rect] of first) {
        const el = this.cards.get(id)!;
        // a card already gliding starts its new glide from where it is now
        this.moves.get(el)?.cancel();
        const now = el.getBoundingClientRect();
        const dx = rect.left - now.left;
        const dy = rect.top - now.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        const move = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: EASE });
        this.moves.set(el, move);
      }
      for (const el of added) {
        el.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
      }
    }
    this.onLayout();
  }

  private update(c: Change) {
    for (const id of new Set([...c.objs, ...c.lists])) {
      const o = this.store.live(id);
      const el = this.cards.get(id);
      if (o && el) this.renderCard(el, o);
    }
    if (c.layout) this.layout(true);
  }

  private createCard(o: Obj): HTMLElement {
    const el = document.createElement('article');
    el.className = 'card list';
    el.dataset.id = o.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.append(document.createElement('h2'), document.createElement('ul'));
    if (o.id === this.lifted) el.classList.add('lifted');
    this.renderCard(el, o);
    return el;
  }

  private renderCard(el: HTMLElement, o: Obj) {
    const h2 = el.firstElementChild as HTMLElement;
    const title = o.data.title ?? '';
    if (h2.textContent !== title) h2.textContent = title;
    h2.hidden = !title;

    const ul = el.lastElementChild as HTMLElement;
    const old = new Map<string, HTMLElement>();
    for (const li of ul.children as HTMLCollectionOf<HTMLElement>) old.set(li.dataset.id!, li);
    this.store.itemsOf(o.id).forEach((item, k) => {
      let li = old.get(item.id);
      old.delete(item.id);
      if (!li) {
        li = document.createElement('li');
        li.dataset.id = item.id;
      }
      if (li.textContent !== item.text) li.textContent = item.text;
      if (ul.children[k] !== li) ul.insertBefore(li, ul.children[k] ?? null);
    });
    for (const li of old.values()) li.remove();
  }
}
