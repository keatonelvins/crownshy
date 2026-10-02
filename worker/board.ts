import { DurableObject } from 'cloudflare:workers';
import { generateNKeysBetween } from 'fractional-indexing';
import { ID_RE, LIMITS, ORD_RE, newId } from '../shared/protocol.ts';
import type {
  ClientMsg,
  ItemOp,
  ItemRow,
  ObjOp,
  ObjRow,
  Op,
  ServerMsg,
  Snapshot,
} from '../shared/protocol.ts';

type ObjSql = { id: string; kind: string; ord: string; data: string; del: number; seq: number };
type ItemSql = { id: string; list: string; ord: string; text: string; del: number; seq: number };

const SEED: [string, string[]][] = [
  [
    'todo list',
    [
      'go on the internet archive tour',
      'visit sf art institute archives',
      'make a sticker book',
      'design book covers for penguin classics',
      'pick/purchase a printer',
      'log app',
    ],
  ],
  ['zine ideas', ['bag tour', 'lists', 'book cover designer interviews', 'benches', 'trees']],
  ['workshop ideas', ['mini photobook', 'acquaintance cards', 'traveler notebook', '8bit friend']],
];

const objRow = (r: ObjSql): ObjRow => ({
  id: r.id,
  kind: 'list',
  ord: r.ord,
  data: JSON.parse(r.data),
  del: r.del ? 1 : 0,
  seq: r.seq,
});

const itemRow = (r: ItemSql): ItemRow => ({
  id: r.id,
  list: r.list,
  ord: r.ord,
  text: r.text,
  del: r.del ? 1 : 0,
  seq: r.seq,
});

/**
 * The one shared board. Rows live in this object's SQLite database; both
 * browsers hold a hibernatable WebSocket to it. Each change bumps a global
 * sequence number, so a reconnecting client asks for `seq > since` and gets
 * exactly what it missed.
 */
export class Board extends DurableObject<Env> {
  private sql: SqlStorage;
  private seq = 0;
  private epoch = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Current board, for inlining into the page. */
  snapshot(): string {
    const o = this.sql.exec<ObjSql>('SELECT * FROM objects WHERE del = 0').toArray().map(objRow);
    const i = this.sql
      .exec<ItemSql>('SELECT items.* FROM items JOIN objects ON objects.id = items.list WHERE items.del = 0 AND objects.del = 0')
      .toArray()
      .map(itemRow);
    return JSON.stringify({ epoch: this.epoch, seq: this.seq, o, i } satisfies Snapshot);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sameBoard = url.searchParams.get('epoch') === this.epoch;
    const since = sameBoard ? Number(url.searchParams.get('since')) || 0 : 0;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.sync(since)));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg?.t !== 'ops' || typeof msg.id !== 'string' || !Array.isArray(msg.ops)) return;

    const rows = this.apply(msg.ops);
    ws.send(JSON.stringify({ t: 'ack', id: msg.id, seq: this.seq } satisfies ServerMsg));
    if (!rows.o.length && !rows.i.length) return;
    const out = JSON.stringify({ t: 'ch', seq: this.seq, ...rows } satisfies ServerMsg);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(out);
      } catch {
        // closing; it will resync on reconnect
      }
    }
  }

  private sync(since: number): ServerMsg {
    if (since <= 0 || since > this.seq) {
      const snap: Snapshot = JSON.parse(this.snapshot());
      return { t: 'sync', epoch: this.epoch, seq: this.seq, full: 1, o: snap.o, i: snap.i };
    }
    const o = this.sql.exec<ObjSql>('SELECT * FROM objects WHERE seq > ?', since).toArray().map(objRow);
    const i = this.sql.exec<ItemSql>('SELECT * FROM items WHERE seq > ?', since).toArray().map(itemRow);
    return { t: 'sync', epoch: this.epoch, seq: this.seq, full: 0, o, i };
  }

  private apply(ops: Op[]) {
    const o = new Map<string, ObjRow>();
    const i = new Map<string, ItemRow>();
    try {
      this.ctx.storage.transactionSync(() => {
        for (const op of ops.slice(0, LIMITS.opsPerBatch)) {
          if (op?.k === 'o') {
            const row = this.applyObj(op);
            if (row) o.set(row.id, row);
          } else if (op?.k === 'i') {
            const row = this.applyItem(op);
            if (row) i.set(row.id, row);
          }
        }
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('seq', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", this.seq);
      });
    } catch (err) {
      console.error('apply failed', err);
      this.seq = Number(this.sql.exec<{ v: number }>("SELECT v FROM meta WHERE k = 'seq'").one().v);
      return { o: [], i: [] };
    }
    return { o: [...o.values()], i: [...i.values()] };
  }

  private applyObj(op: ObjOp): ObjRow | null {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return null;
    const cur = this.sql.exec<ObjSql>('SELECT * FROM objects WHERE id = ?', op.id).toArray()[0];
    if (!cur && op.kind !== 'list') return null;
    const ord = typeof op.ord === 'string' && ORD_RE.test(op.ord) ? op.ord : cur?.ord;
    if (!ord) return null;
    const data =
      op.data !== undefined
        ? JSON.stringify({ title: typeof op.data?.title === 'string' ? op.data.title.slice(0, LIMITS.title) : '' })
        : (cur?.data ?? '{}');
    const del = op.del === 1 || op.del === 0 ? op.del : cur?.del ? 1 : 0;
    const row: ObjSql = { id: op.id, kind: 'list', ord, data, del, seq: ++this.seq };
    this.sql.exec(
      `INSERT INTO objects (id, kind, ord, data, del, seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, data = excluded.data, del = excluded.del, seq = excluded.seq`,
      row.id, row.kind, row.ord, row.data, row.del, row.seq,
    );
    return objRow(row);
  }

  private applyItem(op: ItemOp): ItemRow | null {
    if (typeof op.id !== 'string' || !ID_RE.test(op.id)) return null;
    const cur = this.sql.exec<ItemSql>('SELECT * FROM items WHERE id = ?', op.id).toArray()[0];
    const list = typeof op.list === 'string' && ID_RE.test(op.list) ? op.list : cur?.list;
    const ord = typeof op.ord === 'string' && ORD_RE.test(op.ord) ? op.ord : cur?.ord;
    if (!list || !ord) return null;
    const text = typeof op.text === 'string' ? op.text.slice(0, LIMITS.text) : (cur?.text ?? '');
    const del = op.del === 1 || op.del === 0 ? op.del : cur?.del ? 1 : 0;
    const row: ItemSql = { id: op.id, list, ord, text, del, seq: ++this.seq };
    this.sql.exec(
      `INSERT INTO items (id, list, ord, text, del, seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET list = excluded.list, ord = excluded.ord, text = excluded.text, del = excluded.del, seq = excluded.seq`,
      row.id, row.list, row.ord, row.text, row.del, row.seq,
    );
    return itemRow(row);
  }

  private migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, ord TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}', del INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, list TEXT NOT NULL, ord TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', del INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS objects_seq ON objects (seq)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS items_seq ON items (seq)');

    const meta = new Map(this.sql.exec<{ k: string; v: string | number }>('SELECT k, v FROM meta').toArray().map((r) => [r.k, r.v]));
    if (meta.has('seq')) {
      this.seq = Number(meta.get('seq'));
      this.epoch = String(meta.get('epoch'));
      return;
    }

    // A brand new board: start it with the lists we already have.
    this.epoch = newId();
    this.ctx.storage.transactionSync(() => {
      const listOrds = generateNKeysBetween(null, null, SEED.length);
      SEED.forEach(([title, items], n) => {
        const list = newId();
        this.sql.exec(
          'INSERT INTO objects (id, kind, ord, data, del, seq) VALUES (?, ?, ?, ?, 0, ?)',
          list, 'list', listOrds[n], JSON.stringify({ title }), ++this.seq,
        );
        const itemOrds = generateNKeysBetween(null, null, items.length);
        items.forEach((text, m) => {
          this.sql.exec(
            'INSERT INTO items (id, list, ord, text, del, seq) VALUES (?, ?, ?, ?, 0, ?)',
            newId(), list, itemOrds[m], text, ++this.seq,
          );
        });
      });
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('seq', ?), ('epoch', ?)", this.seq, this.epoch);
    });
  }
}
