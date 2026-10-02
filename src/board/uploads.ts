import { imageUrl, type ImageCopy } from '../../shared/protocol.ts';

type Job = { key: string; id: string; copy: ImageCopy; blob: Blob };

let opened: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('board', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('uploads', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const tx = (await db()).transaction('uploads', mode);
  const req = fn(tx.objectStore('uploads'));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(req ? req.result : (undefined as T));
    tx.onerror = () => reject(tx.error);
  });
}

/** Waits a while, or until the connection comes back, whichever is first. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    addEventListener('online', done);
  });
}

/**
 * Image copies waiting to reach the server. They wait in IndexedDB, so an upload
 * survives a closed app or a dead connection and finishes on a later visit. Board
 * copies go first, since that's what the other person sees.
 */
export class Uploads {
  /** Called once every copy of an image is stored. */
  onDone: (id: string) => void = () => {};

  private running = false;
  private local = new Map<string, Partial<Record<ImageCopy, string>>>();
  // jobs that couldn't be written to IndexedDB
  private pending: Job[] = [];

  /** A copy that only exists on this device so far, to show instead of fetching it. */
  localUrl(id: string, copy: ImageCopy): string | undefined {
    return this.local.get(id)?.[copy];
  }

  add(id: string, copies: Record<ImageCopy, Blob>) {
    const jobs = (Object.keys(copies) as ImageCopy[]).map((copy) => ({ key: `${id}/${copy}`, id, copy, blob: copies[copy] }));
    // shown right away, before anything is written or sent
    this.remember(jobs);
    store('readwrite', (s) => {
      for (const job of jobs) s.put(job);
    })
      .catch(() => {
        // no IndexedDB (private browsing): this visit can still upload them
        this.pending.push(...jobs);
      })
      .finally(() => this.run());
  }

  /** Picks up uploads left over from an earlier visit. */
  async resume() {
    try {
      this.remember(await store<Job[]>('readonly', (s) => s.getAll()));
    } catch {
      return;
    }
    this.run();
  }

  private remember(jobs: Job[]) {
    for (const job of jobs) {
      const urls = this.local.get(job.id) ?? {};
      urls[job.copy] ??= URL.createObjectURL(job.blob);
      this.local.set(job.id, urls);
    }
  }

  private async queued(): Promise<Job[]> {
    const saved = await store<Job[]>('readonly', (s) => s.getAll()).catch(() => []);
    return [...this.pending, ...saved];
  }

  private async finish(job: Job) {
    this.pending = this.pending.filter((j) => j.key !== job.key);
    await store('readwrite', (s) => {
      s.delete(job.key);
    }).catch(() => {});
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    let wait = 1000;
    try {
      for (;;) {
        const jobs = await this.queued();
        if (!jobs.length) return;
        const job = jobs.find((j) => j.copy === 'board') ?? jobs[0];
        const res = await fetch(imageUrl(job.id, job.copy), {
          method: 'PUT',
          body: job.blob,
          headers: { 'Content-Type': job.blob.type },
        }).catch(() => null);
        // stored, or turned away for good (too big, wrong type): off the queue either way
        const settled = res && (res.ok || [400, 404, 413, 415].includes(res.status));
        if (settled) {
          await this.finish(job);
          if (res.ok && !jobs.some((j) => j.id === job.id && j.key !== job.key)) this.onDone(job.id);
          wait = 1000;
          continue;
        }
        // offline or a hiccup: try again in a bit
        await pause(wait);
        wait = Math.min(wait * 2, 30_000);
      }
    } finally {
      this.running = false;
    }
  }
}
