// Wire format shared by the board client and its Durable Object.
//
// The board is a set of objects (only lists for now) and list items. Every row
// carries the server sequence number of its last change, so a client that
// reconnects can ask for exactly the rows it missed. Deletes are tombstones
// (del: 1) so they travel the same way.

export type Kind = 'list';

export interface ObjData {
  title?: string;
}

export interface ObjRow {
  id: string;
  kind: Kind;
  ord: string;
  data: ObjData;
  del: 0 | 1;
  seq: number;
}

export interface ItemRow {
  id: string;
  list: string;
  ord: string;
  text: string;
  del: 0 | 1;
  seq: number;
}

// Partial upserts. A field that is present overwrites; absent fields are left
// alone. Creating a row requires kind (objects) or list (items).
export interface ObjOp {
  k: 'o';
  id: string;
  kind?: Kind;
  ord?: string;
  data?: ObjData;
  del?: 0 | 1;
}

export interface ItemOp {
  k: 'i';
  id: string;
  list?: string;
  ord?: string;
  text?: string;
  del?: 0 | 1;
}

export type Op = ObjOp | ItemOp;

// epoch identifies one board database. A client holding rows from a different
// epoch (say, after a reset) throws them away and takes a full sync.
export interface Snapshot {
  epoch: string;
  seq: number;
  o: ObjRow[];
  i: ItemRow[];
}

export type ClientMsg = { t: 'ops'; id: string; ops: Op[] };

export type ServerMsg =
  // Rows changed since the client's `since`; full means "this is everything".
  | { t: 'sync'; epoch: string; seq: number; full: 0 | 1; o: ObjRow[]; i: ItemRow[] }
  // Someone else changed these rows.
  | { t: 'ch'; seq: number; o: ObjRow[]; i: ItemRow[] }
  // Your batch is durable.
  | { t: 'ack'; id: string; seq: number };

export const LIMITS = {
  title: 300,
  text: 4000,
  opsPerBatch: 500,
};

export const ID_RE = /^[0-9A-Za-z]{8,32}$/;
export const ORD_RE = /^[0-9A-Za-z]{1,128}$/;

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = '';
  for (const b of bytes) id += ID_CHARS[b % 62];
  return id;
}
