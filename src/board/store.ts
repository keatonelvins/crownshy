import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { newId } from '../../shared/protocol.ts';
import type { ItemRow, Kind, ObjData, ObjRow, Op, ServerMsg, Snapshot } from '../../shared/protocol.ts';

export interface Obj {
  id: string;
  kind: Kind;
  ord: string;
  data: ObjData;
  del: 0 | 1;
  // A new list nobody has written in yet. It stays on this device until it has content.
  draft?: boolean;
}

export interface Item {
  id: string;
  list: string;
  ord: string;
  text: string;
  del: 0 | 1;
}

export interface Change {
  layout: boolean; // objects added, removed or reordered
  objs: Set<string>; // objects whose own fields changed
  lists: Set<string>; // lists whose items changed
}

type Batch = { id: string; gen: number; ops: Op[] };
type Saved = { epoch: string; seq: number; o: Obj[]; i: Item[]; ops: Op[] };

const KEY = 'board:v1';

export const byOrd = (a: { ord: string; id: string }, b: { ord: string; id: string }) =>
  a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** An order key between a and b; null means "the start" / "the end". */
export function between(a: string | null, b: string | null): string {
  if (a !== null && a === b) return generateKeyBetween(a, null);
  return generateKeyBetween(a, b);
}

/**
 * Local-first copy of the board. Edits apply here immediately and queue up as
 * ops for the server; server rows merge in field by field, except fields this
 * device has changed and the server hasn't confirmed yet.
 */
export class Store {
  epoch = '';
  seq = 0;
  readonly objs = new Map<string, Obj>();
  readonly items = new Map<string, Item>();

  /** Called when there are ops waiting to be sent. */
  onOps = () => {};

  // row key ('o:id' / 'i:id') -> field -> generation of the local write
  private pending = new Map<string, Map<string, number>>();
  private gen = 0;
  private outbox = new Map<string, Op>();
  private inflight: Batch[] = [];

  private orderCache: Obj[] | null = null;
  private itemsCache = new Map<string, Item[]>();
  private change: Change | null = null;
  private listeners = new Set<(c: Change) => void>();
  private saveTimer = 0;

  static load(inline: Snapshot | null): Store {
    const store = new Store();
    let saved: Saved | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      // unreadable; start from the server copy
    }
    const sameBoard = !!saved && !!inline && saved.epoch === inline.epoch;
    if (inline && !(sameBoard && saved!.seq > inline.seq)) {
      store.epoch = inline.epoch;
      store.seq = inline.seq;
      for (const r of inline.o) store.objs.set(r.id, { id: r.id, kind: r.kind, ord: r.ord, data: r.data, del: 0 });
      for (const r of inline.i) store.items.set(r.id, { id: r.id, list: r.list, ord: r.ord, text: r.text, del: 0 });
    } else if (saved) {
      store.epoch = saved.epoch;
      store.seq = saved.seq;
      for (const o of saved.o) store.objs.set(o.id, o);
      for (const i of saved.i) store.items.set(i.id, i);
    }
    // Edits that never reached the server: apply them again and resend.
    if (saved && (!inline || sameBoard)) for (const op of saved.ops) store.local(op);
    return store;
  }

  subscribe(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- reading ----------

  ordered(): Obj[] {
    return (this.orderCache ??= [...this.objs.values()].filter((o) => !o.del).sort(byOrd));
  }

  itemsOf(list: string): Item[] {
    let items = this.itemsCache.get(list);
    if (!items) {
      items = [...this.items.values()].filter((i) => i.list === list && !i.del).sort(byOrd);
      this.itemsCache.set(list, items);
    }
    return items;
  }

  live(id: string): Obj | undefined {
    const o = this.objs.get(id);
    return o && !o.del ? o : undefined;
  }

  // ---------- local edits ----------

  createList(): Obj {
    const first = this.ordered()[0];
    const o: Obj = { id: newId(), kind: 'list', ord: between(null, first?.ord ?? null), data: { title: '' }, del: 0, draft: true };
    this.objs.set(o.id, o);
    this.orderCache = null;
    this.touch().layout = true;
    return o;
  }

  /** Order keys for n new things at the very start of the board, in order. */
  topKeys(n: number): string[] {
    return generateNKeysBetween(null, this.ordered()[0]?.ord ?? null, n);
  }

  createImage(id: string, ord: string, image: { w: number; h: number; ph: string }) {
    this.local({ k: 'o', id, kind: 'image', ord, data: { ...image, up: 0 } });
  }

  /** Every copy is on the server now: the other device can load it. */
  imageUploaded(id: string) {
    const o = this.objs.get(id);
    if (o?.kind === 'image' && !o.data.up) this.local({ k: 'o', id, data: { ...o.data, up: 1 } });
  }

  setTitle(id: string, title: string) {
    this.local({ k: 'o', id, data: { title } });
    this.commitIfWritten(id);
  }

  /** Adds an item after `after` (an item id), or at the start when null. */
  addItem(list: string, after: string | null, text: string): string {
    const items = this.itemsOf(list);
    const k = after === null ? -1 : items.findIndex((i) => i.id === after);
    const ord = between(items[k]?.ord ?? null, items[k + 1]?.ord ?? null);
    const id = newId();
    this.local({ k: 'i', id, list, ord, text });
    this.commitIfWritten(list);
    return id;
  }

  setText(id: string, text: string) {
    const item = this.items.get(id);
    if (!item || item.text === text) return;
    this.local({ k: 'i', id, text });
    this.commitIfWritten(item.list);
  }

  removeItem(id: string) {
    if (this.items.has(id)) this.local({ k: 'i', id, del: 1 });
  }

  removeObj(id: string) {
    const o = this.objs.get(id);
    if (!o) return;
    if (o.draft) {
      this.objs.delete(id);
      for (const i of this.itemsOf(id)) this.items.delete(i.id);
      this.itemsCache.delete(id);
      this.orderCache = null;
      this.touch().layout = true;
      this.scheduleSave();
      return;
    }
    this.local({ k: 'o', id, del: 1 });
  }

  moveObj(id: string, ord: string) {
    this.local({ k: 'o', id, ord });
  }

  // ---------- talking to the server ----------

  /** Moves queued ops into a batch to send. */
  takeBatch(): Batch | null {
    if (!this.outbox.size) return null;
    const batch = { id: newId(), gen: this.gen, ops: [...this.outbox.values()] };
    this.outbox.clear();
    this.inflight.push(batch);
    this.scheduleSave();
    return batch;
  }

  /** Batches sent but not yet confirmed; resent after a reconnect. */
  unacked(): readonly Batch[] {
    return this.inflight;
  }

  ack(id: string, seq: number) {
    const k = this.inflight.findIndex((b) => b.id === id);
    if (k < 0) return;
    const [batch] = this.inflight.splice(k, 1);
    // Anything written at or before this batch is now the server's value too.
    for (const [key, fields] of this.pending) {
      for (const [field, gen] of fields) if (gen <= batch.gen) fields.delete(field);
      if (!fields.size) this.pending.delete(key);
    }
    this.seq = Math.max(this.seq, seq);
    this.scheduleSave();
  }

  receive(msg: Extract<ServerMsg, { t: 'sync' | 'ch' }>) {
    const c = this.touch();
    if (msg.t === 'sync') {
      if (msg.epoch !== this.epoch) {
        // A different board (it was reset): drop everything held here.
        this.objs.clear();
        this.items.clear();
        this.pending.clear();
        this.outbox.clear();
        this.inflight = [];
        this.itemsCache.clear();
        this.epoch = msg.epoch;
        this.seq = 0;
        c.layout = true;
      }
      if (msg.full) {
        const objs = new Set(msg.o.map((r) => r.id));
        const items = new Set(msg.i.map((r) => r.id));
        for (const [id, o] of this.objs) {
          if (!objs.has(id) && !o.draft && !this.pending.has('o:' + id)) {
            this.objs.delete(id);
            c.layout = true;
          }
        }
        for (const [id, item] of this.items) {
          if (!items.has(id) && !this.pending.has('i:' + id) && !this.objs.get(item.list)?.draft) {
            this.items.delete(id);
            this.dirtyList(item.list, c);
          }
        }
      }
    }
    for (const r of msg.o) this.mergeObj(r, c);
    for (const r of msg.i) this.mergeItem(r, c);
    if (c.layout) this.orderCache = null;
    this.seq = Math.max(this.seq, msg.seq);
    this.scheduleSave();
  }

  save() {
    clearTimeout(this.saveTimer);
    const o = [...this.objs.values()].filter((x) => !x.del && !x.draft);
    const lists = new Set(o.map((x) => x.id));
    const i = [...this.items.values()].filter((x) => !x.del && lists.has(x.list));
    const ops = [...this.inflight.flatMap((b) => b.ops), ...this.outbox.values()];
    try {
      localStorage.setItem(KEY, JSON.stringify({ epoch: this.epoch, seq: this.seq, o, i, ops } satisfies Saved));
    } catch {
      // storage full or blocked; the server still has everything that was sent
    }
  }

  // ---------- internals ----------

  private local(op: Op) {
    // An edit to a row that doesn't exist here (and can't create it) goes nowhere.
    const exists = op.k === 'o' ? this.objs.has(op.id) || (op.kind && op.ord) : this.items.has(op.id) || (op.list && op.ord);
    if (!exists) return;

    const g = ++this.gen;
    const key = op.k + ':' + op.id;
    let fields = this.pending.get(key);
    if (!fields) this.pending.set(key, (fields = new Map()));
    for (const f of Object.keys(op)) if (f !== 'k' && f !== 'id') fields.set(f, g);

    const c = this.touch();
    if (op.k === 'o') {
      let o = this.objs.get(op.id);
      if (!o) {
        if (!op.kind || !op.ord) return;
        o = { id: op.id, kind: op.kind, ord: op.ord, data: op.data ?? {}, del: 0 };
        this.objs.set(o.id, o);
        c.layout = true;
      }
      if (op.ord !== undefined && op.ord !== o.ord) {
        o.ord = op.ord;
        c.layout = true;
      }
      if (op.del !== undefined && op.del !== o.del) {
        o.del = op.del;
        c.layout = true;
      }
      if (op.data !== undefined) {
        o.data = op.data;
        c.objs.add(o.id);
      }
      if (c.layout) this.orderCache = null;
    } else {
      let item = this.items.get(op.id);
      if (!item) {
        if (!op.list || !op.ord) return;
        item = { id: op.id, list: op.list, ord: op.ord, text: '', del: 0 };
        this.items.set(item.id, item);
      }
      this.dirtyList(item.list, c);
      if (op.list !== undefined) item.list = op.list;
      if (op.ord !== undefined) item.ord = op.ord;
      if (op.text !== undefined) item.text = op.text;
      if (op.del !== undefined) item.del = op.del;
      this.dirtyList(item.list, c);
    }

    if (!this.isDraft(op)) {
      const prev = this.outbox.get(key);
      this.outbox.set(key, prev ? ({ ...prev, ...op } as Op) : op);
      this.onOps();
    }
    this.scheduleSave();
  }

  private isDraft(op: Op): boolean {
    const list = op.k === 'o' ? op.id : (op.list ?? this.items.get(op.id)?.list);
    return !!(list && this.objs.get(list)?.draft);
  }

  /** A draft list becomes real (and shared) once something is written in it. */
  private commitIfWritten(list: string) {
    const o = this.objs.get(list);
    if (!o?.draft) return;
    const items = this.itemsOf(list);
    if (!o.data.title && !items.some((i) => i.text)) return;
    o.draft = false;
    this.outbox.set('o:' + o.id, { k: 'o', id: o.id, kind: o.kind, ord: o.ord, data: o.data });
    for (const i of items) this.outbox.set('i:' + i.id, { k: 'i', id: i.id, list: i.list, ord: i.ord, text: i.text });
    this.onOps();
    this.scheduleSave();
  }

  private mergeObj(r: ObjRow, c: Change) {
    const mine = this.pending.get('o:' + r.id);
    const o = this.objs.get(r.id);
    if (!o) {
      if (r.del) return;
      this.objs.set(r.id, { id: r.id, kind: r.kind, ord: r.ord, data: r.data, del: 0 });
      c.layout = true;
      return;
    }
    if (!mine?.has('ord') && o.ord !== r.ord) {
      o.ord = r.ord;
      c.layout = true;
    }
    if (!mine?.has('del') && o.del !== r.del) {
      o.del = r.del;
      c.layout = true;
    }
    if (!mine?.has('data') && JSON.stringify(o.data) !== JSON.stringify(r.data)) {
      o.data = r.data;
      c.objs.add(r.id);
    }
  }

  private mergeItem(r: ItemRow, c: Change) {
    const mine = this.pending.get('i:' + r.id);
    let item = this.items.get(r.id);
    if (!item) {
      if (r.del) return;
      item = { id: r.id, list: r.list, ord: r.ord, text: r.text, del: 0 };
      this.items.set(r.id, item);
      this.dirtyList(r.list, c);
      return;
    }
    const next = {
      list: mine?.has('list') ? item.list : r.list,
      ord: mine?.has('ord') ? item.ord : r.ord,
      text: mine?.has('text') ? item.text : r.text,
      del: mine?.has('del') ? item.del : r.del,
    };
    if (next.list === item.list && next.ord === item.ord && next.text === item.text && next.del === item.del) return;
    this.dirtyList(item.list, c);
    Object.assign(item, next);
    this.dirtyList(item.list, c);
  }

  private dirtyList(list: string, c: Change) {
    this.itemsCache.delete(list);
    c.lists.add(list);
  }

  private touch(): Change {
    if (!this.change) {
      this.change = { layout: false, objs: new Set(), lists: new Set() };
      queueMicrotask(() => {
        const c = this.change;
        this.change = null;
        if (c) for (const fn of this.listeners) fn(c);
      });
    }
    return this.change;
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }
}
