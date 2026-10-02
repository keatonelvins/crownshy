import { DurableObject } from 'cloudflare:workers';

type FileSql = { type: string; data: ArrayBuffer };

/**
 * The board's image files, one row per stored copy (key: `<image id>/<copy>`).
 * Image ids are never reused, so a stored copy never changes and everything in
 * front of this (edge cache, browser cache, service worker) can keep it forever.
 */
export class Images extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, at INTEGER NOT NULL)',
    );
  }

  put(key: string, type: string, data: ArrayBuffer) {
    this.sql.exec(
      `INSERT INTO files (key, type, data, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET type = excluded.type, data = excluded.data, at = excluded.at`,
      key, type, data, Date.now(),
    );
  }

  get(key: string): FileSql | null {
    return this.sql.exec<FileSql>('SELECT type, data FROM files WHERE key = ?', key).toArray()[0] ?? null;
  }
}
