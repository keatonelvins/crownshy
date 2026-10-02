import type { Grid } from './grid.ts';
import type { Change, Store } from './store.ts';

const EASE = 'cubic-bezier(.2, .8, .2, 1)';
const OPEN_MS = 220;
const CLOSE_MS = 180;
const fieldSizing = CSS.supports('field-sizing', 'content');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function textarea(className: string, label: string): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.className = className;
  ta.rows = 1;
  ta.spellcheck = false;
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', label);
  return ta;
}

/** Fits textareas to their text where CSS field-sizing isn't available (two layouts total). */
function autosize(...tas: HTMLTextAreaElement[]) {
  if (fieldSizing || !tas.length) return;
  for (const ta of tas) ta.style.height = '0';
  const heights = tas.map((ta) => ta.scrollHeight);
  tas.forEach((ta, k) => (ta.style.height = `${heights[k]}px`));
}

/**
 * A list lifted off the board to write in. Opening puts the caret on a blank
 * line at the end, so a tap is all it takes to start jotting. Every line is an
 * item, and lines are edited like text: Return starts the next one, Backspace
 * at the start of a line joins it to the line above (so an empty line just goes
 * away), and blank lines are cleared when the list is put down.
 */
export class Sheet {
  id: string | null = null;

  private store: Store;
  private grid: Grid;
  private root: HTMLElement;
  private veil: HTMLElement;
  private sheet: HTMLElement;
  private inner: HTMLElement;
  private title: HTMLTextAreaElement;
  private lines: HTMLElement;
  // The always-empty line at the end; typing in it turns it into an item.
  private blank: HTMLTextAreaElement;
  private rows = new Map<string, HTMLTextAreaElement>();
  private pushed = false;
  private closing: Animation | null = null;

  constructor(store: Store, grid: Grid) {
    this.store = store;
    this.grid = grid;

    this.root = document.createElement('div');
    this.root.className = 'focus';
    this.root.hidden = true;
    this.veil = document.createElement('div');
    this.veil.className = 'veil';
    this.sheet = document.createElement('section');
    this.sheet.className = 'sheet';
    this.sheet.setAttribute('role', 'dialog');
    this.sheet.setAttribute('aria-modal', 'true');
    this.inner = document.createElement('div');
    this.inner.className = 'inner';
    this.title = textarea('title', 'title');
    this.title.setAttribute('enterkeyhint', 'next');
    this.lines = document.createElement('div');
    this.lines.className = 'lines';
    this.blank = textarea('line', 'new item');
    this.inner.append(this.title, this.lines);
    this.sheet.append(this.inner);
    this.root.append(this.veil, this.sheet);
    document.body.append(this.root);

    this.veil.addEventListener('click', () => this.close());
    this.sheet.addEventListener('click', (e) => {
      // Tapping the paper below the last line puts the caret there, like a notepad.
      if (e.target === this.sheet || e.target === this.inner || e.target === this.lines) this.focusAt(this.blank, 0);
    });
    this.sheet.addEventListener('keydown', (e) => this.onKey(e));
    this.sheet.addEventListener('input', (e) => this.onInput(e));
    this.sheet.addEventListener('paste', (e) => this.onPaste(e));
    addEventListener('popstate', (e) => this.onPop(e));
    visualViewport?.addEventListener('resize', () => this.fit());
    visualViewport?.addEventListener('scroll', () => this.fit());
    store.subscribe((c) => this.update(c));
  }

  open(
    id: string,
    opts: { from?: DOMRect | null; focus?: 'end' | 'title' | 'none'; history?: 'push' | 'replace' | 'none' } = {},
  ) {
    const o = this.store.live(id);
    if (!o) return;
    if (this.closing) {
      this.endHide();
    } else if (this.id && this.id !== id) {
      this.tidy(this.id);
      this.endHide();
    }

    this.id = id;
    this.grid.setLifted(id);
    this.title.value = o.data.title ?? '';
    this.root.hidden = false;
    this.render();
    autosize(this.title);
    document.documentElement.classList.add('sheet-open');
    this.fit();
    this.sheet.scrollTop = 0;

    // Focus inside the tap itself, so phones bring the keyboard up with the sheet.
    const focus = opts.focus ?? 'end';
    const empty = !o.data.title && !this.rows.size;
    if (focus === 'title' || (focus === 'end' && empty)) this.focusAt(this.title, this.title.value.length);
    else if (focus === 'end') this.focusAt(this.blank, 0);

    const how = opts.history ?? 'push';
    if (how === 'push') {
      history.pushState({ list: id }, '', `/board/${id}`);
      this.pushed = true;
    } else if (how === 'replace') {
      history.replaceState({ list: id }, '', `/board/${id}`);
      this.pushed = false;
    }

    if (opts.from && !reducedMotion.matches) this.animateFrom(opts.from);
  }

  close() {
    if (!this.id) return;
    if (this.pushed) {
      this.pushed = false;
      history.back(); // popstate hides it
      return;
    }
    history.replaceState(null, '', '/board');
    this.hide();
  }

  // ---------- showing and hiding ----------

  private animateFrom(from: DOMRect) {
    const to = this.sheet.getBoundingClientRect();
    const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    this.sheet.animate([{ transform }, { transform: 'none' }], { duration: OPEN_MS, easing: EASE });
    this.inner.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], { duration: OPEN_MS });
    this.veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: OPEN_MS });
  }

  private hide() {
    const id = this.id;
    if (!id) return;
    this.id = null;
    (document.activeElement as HTMLElement | null)?.blur();
    this.tidy(id);

    const card = this.store.live(id) ? this.grid.card(id) : undefined;
    const to = card?.getBoundingClientRect();
    const visible = to && to.bottom > 0 && to.top < innerHeight;
    if (reducedMotion.matches) {
      this.endHide();
      return;
    }
    const from = this.sheet.getBoundingClientRect();
    const end = visible
      ? { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})` }
      : { transform: 'scale(.97)', opacity: 0 };
    const opts: KeyframeAnimationOptions = { duration: CLOSE_MS, easing: EASE, fill: 'forwards' };
    const closing = this.sheet.animate([{ transform: 'none', opacity: 1 }, end], opts);
    this.inner.animate([{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], opts);
    this.veil.animate([{ opacity: 1 }, { opacity: 0 }], opts);
    this.closing = closing;
    const done = () => {
      if (this.closing === closing) this.endHide();
    };
    // `finished` settles even when the page is in the background (finish events don't),
    // and the timer covers animations that stall there.
    closing.finished.then(done, () => {});
    setTimeout(done, CLOSE_MS + 120);
  }

  /** Puts everything away at once, cutting short a closing animation. */
  private endHide() {
    this.closing = null;
    for (const a of this.root.getAnimations({ subtree: true })) a.cancel();
    this.root.hidden = true;
    this.grid.setLifted(null);
    this.lines.replaceChildren();
    this.rows.clear();
    document.documentElement.classList.remove('sheet-open');
  }

  /** Blank lines go away on close, and so does a list with nothing in it. */
  private tidy(id: string) {
    const o = this.store.live(id);
    if (!o) return;
    for (const item of this.store.itemsOf(id)) if (!item.text.trim()) this.store.removeItem(item.id);
    if (!o.data.title?.trim() && !this.store.itemsOf(id).length) this.store.removeObj(id);
  }

  private onPop(e: PopStateEvent) {
    const id = (e.state as { list?: string } | null)?.list;
    if (id && this.store.live(id)) {
      if (id !== this.id) {
        this.open(id, { history: 'none', focus: 'none', from: this.grid.card(id)?.getBoundingClientRect() });
        this.pushed = true;
      }
    } else if (this.id) {
      this.pushed = false;
      this.hide();
    }
  }

  /** Keeps the sheet inside the visible area when the phone keyboard is up. */
  private fit() {
    if (!this.id) return;
    const vv = visualViewport;
    this.root.style.setProperty('--vvh', `${vv ? vv.height : innerHeight}px`);
    this.root.style.setProperty('--vvt', `${vv ? vv.offsetTop : 0}px`);
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && this.sheet.contains(active)) this.reveal(active);
  }

  // ---------- rendering ----------

  private update(c: Change) {
    const id = this.id;
    if (!id) return;
    if (!this.store.live(id)) {
      // deleted on the other device
      this.close();
      return;
    }
    if (c.objs.has(id) && document.activeElement !== this.title) {
      this.title.value = this.store.objs.get(id)!.data.title ?? '';
      autosize(this.title);
    }
    if (c.lists.has(id)) this.render();
  }

  private render() {
    const id = this.id!;
    const active = document.activeElement;
    const keep = new Set<string>();
    const resized: HTMLTextAreaElement[] = [];
    this.store.itemsOf(id).forEach((item, k) => {
      keep.add(item.id);
      let ta = this.rows.get(item.id);
      if (!ta) {
        ta = textarea('line', 'item');
        ta.dataset.id = item.id;
        ta.value = item.text;
        this.rows.set(item.id, ta);
        resized.push(ta);
      } else if (ta.value !== item.text) {
        resized.push(ta);
        // changed on the other device
        if (ta === active) {
          const { selectionStart: s, selectionEnd: e } = ta;
          ta.value = item.text;
          ta.setSelectionRange(Math.min(s, item.text.length), Math.min(e, item.text.length));
        } else {
          ta.value = item.text;
        }
      }
      if (this.lines.children[k] !== ta) this.lines.insertBefore(ta, this.lines.children[k] ?? null);
    });
    for (const [itemId, ta] of this.rows) {
      if (!keep.has(itemId)) {
        ta.remove();
        this.rows.delete(itemId);
      }
    }
    if (this.lines.lastElementChild !== this.blank) this.lines.append(this.blank);
    autosize(...resized);
  }

  private focusAt(ta: HTMLTextAreaElement, pos: number) {
    ta.focus({ preventScroll: true });
    const p = Math.min(pos, ta.value.length);
    ta.setSelectionRange(p, p);
    this.reveal(ta);
  }

  private reveal(ta: HTMLTextAreaElement) {
    const sheet = this.sheet.getBoundingClientRect();
    const row = ta.getBoundingClientRect();
    const margin = 24;
    if (row.bottom > sheet.bottom - margin) this.sheet.scrollTop += row.bottom - sheet.bottom + margin;
    else if (row.top < sheet.top + margin) this.sheet.scrollTop -= sheet.top + margin - row.top;
  }

  // ---------- writing ----------

  private onInput(e: Event) {
    const ta = e.target as HTMLTextAreaElement;
    const id = this.id;
    if (!id) return;
    if (ta === this.title) {
      if (ta.value.includes('\n')) ta.value = ta.value.replace(/\s*\n\s*/g, ' ');
      this.store.setTitle(id, ta.value);
    } else if (ta === this.blank) {
      if (ta.value) this.adoptBlank(ta.value);
    } else if (ta.dataset.id) {
      this.store.setText(ta.dataset.id, ta.value);
    }
    autosize(ta);
  }

  /** The blank line got text: it becomes an item in place (keeping focus) and a new blank follows. */
  private adoptBlank(text: string): string {
    const id = this.id!;
    const last = this.store.itemsOf(id).at(-1)?.id ?? null;
    const itemId = this.store.addItem(id, last, text);
    const ta = this.blank;
    ta.dataset.id = itemId;
    ta.setAttribute('aria-label', 'item');
    this.rows.set(itemId, ta);
    this.blank = textarea('line', 'new item');
    this.lines.append(this.blank);
    return itemId;
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement) || e.isComposing || e.keyCode === 229) return;
    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.enter(ta);
    } else if (e.key === 'Backspace' && atStart) {
      if (this.backspace(ta)) e.preventDefault();
    } else if (e.key === 'ArrowUp' && atStart) {
      const prev = this.prev(ta);
      if (prev) {
        e.preventDefault();
        this.focusAt(prev, prev.value.length);
      }
    } else if (e.key === 'ArrowDown' && atEnd) {
      const next = this.next(ta);
      if (next) {
        e.preventDefault();
        this.focusAt(next, 0);
      }
    }
  }

  private prev(ta: HTMLTextAreaElement): HTMLTextAreaElement | null {
    if (ta === this.title) return null;
    return (ta.previousElementSibling as HTMLTextAreaElement | null) ?? this.title;
  }

  private next(ta: HTMLTextAreaElement): HTMLTextAreaElement | null {
    if (ta === this.title) return this.lines.firstElementChild as HTMLTextAreaElement;
    return ta.nextElementSibling as HTMLTextAreaElement | null;
  }

  private enter(ta: HTMLTextAreaElement) {
    const id = this.id!;
    if (ta === this.title) {
      this.focusAt(this.lines.firstElementChild as HTMLTextAreaElement, 0);
      return;
    }
    if (ta === this.blank) return; // nothing written on it yet
    const itemId = ta.dataset.id!;
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    if (!after && ta.nextElementSibling === this.blank) {
      // end of the last line: the blank line is already waiting
      if (before !== ta.value) this.setLine(ta, before);
      this.focusAt(this.blank, 0);
      return;
    }
    this.setLine(ta, before);
    const next = this.store.addItem(id, itemId, after);
    this.render();
    this.focusAt(this.rows.get(next)!, 0);
  }

  /** Backspace at the very start of a line. Returns whether it was handled. */
  private backspace(ta: HTMLTextAreaElement): boolean {
    if (ta === this.title) return false;
    const prev = this.prev(ta)!;
    if (ta === this.blank) {
      this.focusAt(prev, prev.value.length);
      return true;
    }
    const itemId = ta.dataset.id!;
    if (prev === this.title) {
      this.focusAt(this.title, this.title.value.length);
      if (!ta.value) this.store.removeItem(itemId);
    } else {
      // join this line onto the one above, caret at the seam
      const seam = prev.value.length;
      if (ta.value) this.setLine(prev, prev.value + ta.value);
      this.focusAt(prev, seam);
      this.store.removeItem(itemId);
    }
    this.render();
    return true;
  }

  private setLine(ta: HTMLTextAreaElement, text: string) {
    ta.value = text;
    this.store.setText(ta.dataset.id!, text);
    autosize(ta);
  }

  /** Pasting several lines makes several items. */
  private onPaste(e: ClipboardEvent) {
    const ta = e.target;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!(ta instanceof HTMLTextAreaElement) || !this.id || !text.includes('\n')) return;
    e.preventDefault();
    if (ta === this.title) {
      ta.setRangeText(text.replace(/\s*\n\s*/g, ' ').trim(), ta.selectionStart, ta.selectionEnd, 'end');
      this.store.setTitle(this.id, ta.value);
      return;
    }
    const pasted = text.split(/\r?\n/).filter((l) => l.trim());
    if (!pasted.length) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const lines = [before + pasted[0], ...pasted.slice(1)];
    const caret = lines[lines.length - 1].length;
    lines[lines.length - 1] += after;

    let prevId = ta === this.blank ? this.adoptBlank(lines[0]) : ta.dataset.id!;
    const first = this.rows.get(prevId)!;
    this.setLine(first, lines[0]);
    for (const line of lines.slice(1)) prevId = this.store.addItem(this.id, prevId, line);
    this.render();
    this.focusAt(this.rows.get(prevId)!, caret);
  }
}
