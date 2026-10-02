import { imageUrl } from '../../shared/protocol.ts';
import type { Grid } from './grid.ts';
import type { Store } from './store.ts';
import type { Uploads } from './uploads.ts';

const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const OPEN_MS = 220;
const CLOSE_MS = 180;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * A picture lifted off the board to look at, as big as the screen allows. The
 * board copy (already cached) shows at once; the full copy takes its place as
 * soon as it's decoded. Tap anywhere, Escape or Back to put it down.
 */
export class Viewer {
  id: string | null = null;

  private store: Store;
  private grid: Grid;
  private uploads: Uploads;
  private root: HTMLElement;
  private img: HTMLImageElement;
  private pushed = false;
  private closing: Animation | null = null;

  constructor(store: Store, grid: Grid, uploads: Uploads) {
    this.store = store;
    this.grid = grid;
    this.uploads = uploads;
    this.root = document.createElement('div');
    this.root.className = 'view';
    this.root.hidden = true;
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.draggable = false;
    this.root.append(this.img);
    document.body.append(this.root);

    this.root.addEventListener('click', () => this.close());
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.id) this.close();
    });
    addEventListener('popstate', (e) => this.onPop(e));
    addEventListener('resize', () => this.place());
    store.subscribe(() => {
      // put away on the other device
      if (this.id && !this.store.live(this.id)) this.close();
    });
  }

  open(id: string, opts: { from?: DOMRect | null; history?: 'push' | 'replace' | 'none' } = {}) {
    const o = this.store.live(id);
    if (o?.kind !== 'image') return;
    if (this.closing) this.endHide();
    this.id = id;
    this.grid.setLifted(id);

    const board = this.uploads.localUrl(id, 'board') ?? (o.data.up ? imageUrl(id, 'board') : '');
    const full = this.uploads.localUrl(id, 'full') ?? (o.data.up ? imageUrl(id, 'full') : '');
    this.img.style.backgroundImage = o.data.ph ? `url("${o.data.ph}")` : '';
    if (board) this.img.src = board;
    else this.img.removeAttribute('src');
    if (full) {
      const sharp = new Image();
      sharp.src = full;
      sharp
        .decode()
        .then(() => {
          if (this.id === id) this.img.src = full;
        })
        .catch(() => {});
    }

    this.root.hidden = false;
    document.documentElement.classList.add('view-open');
    this.place();

    const how = opts.history ?? 'push';
    if (how === 'push') {
      history.pushState({ image: id }, '', `/board/${id}`);
      this.pushed = true;
    } else if (how === 'replace') {
      history.replaceState({ image: id }, '', `/board/${id}`);
      this.pushed = false;
    }

    if (opts.from && !reducedMotion.matches) {
      const to = this.img.getBoundingClientRect();
      // same shape as the card, so a plain scale gets it there
      const transform = `translate(${opts.from.left - to.left}px, ${opts.from.top - to.top}px) scale(${opts.from.width / to.width})`;
      this.img.animate([{ transform }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE });
      this.root.animate([{ backgroundColor: 'rgba(0, 0, 0, 0)' }, {}], { duration: OPEN_MS });
    }
  }

  close() {
    if (!this.id) return;
    if (this.pushed) {
      this.pushed = false;
      history.back(); // popstate puts it down
      return;
    }
    history.replaceState(null, '', '/board');
    this.hide();
  }

  /** Fits the picture to the screen with a margin, never blowing it up past 1.5×. */
  private place() {
    const o = this.id ? this.store.objs.get(this.id) : undefined;
    if (!o) return;
    const { w = 1, h = 1 } = o.data;
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    const margin = vw < 600 ? 10 : 40;
    const scale = Math.min((vw - 2 * margin) / w, (vh - 2 * margin) / h, 1.5);
    const width = w * scale;
    const height = h * scale;
    Object.assign(this.img.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${(vw - width) / 2}px`,
      top: `${(vh - height) / 2}px`,
    });
  }

  private hide() {
    const id = this.id;
    if (!id) return;
    this.id = null;
    const card = this.store.live(id) ? this.grid.card(id) : undefined;
    const to = card?.getBoundingClientRect();
    if (reducedMotion.matches || !to || to.bottom < 0 || to.top > innerHeight) {
      this.endHide();
      return;
    }
    const from = this.img.getBoundingClientRect();
    const opts: KeyframeAnimationOptions = { duration: CLOSE_MS, easing: EASE, fill: 'forwards' };
    const closing = this.img.animate(
      [{ transform: 'none' }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})` }],
      opts,
    );
    this.root.animate([{}, { backgroundColor: 'rgba(0, 0, 0, 0)' }], opts);
    this.closing = closing;
    const done = () => {
      if (this.closing === closing) this.endHide();
    };
    closing.finished.then(done, () => {});
    setTimeout(done, CLOSE_MS + 120);
  }

  private endHide() {
    this.closing = null;
    for (const a of this.root.getAnimations({ subtree: true })) a.cancel();
    this.root.hidden = true;
    this.img.removeAttribute('src');
    this.grid.setLifted(null);
    document.documentElement.classList.remove('view-open');
  }

  private onPop(e: PopStateEvent) {
    const id = (e.state as { image?: string } | null)?.image;
    if (id && this.store.live(id)) {
      if (id !== this.id) {
        this.open(id, { history: 'none', from: this.grid.card(id)?.getBoundingClientRect() });
        this.pushed = true;
      }
    } else if (this.id) {
      this.pushed = false;
      this.hide();
    }
  }
}
