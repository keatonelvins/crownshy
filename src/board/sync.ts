import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import type { Store } from './store.ts';

const BACKOFF = [250, 500, 1000, 2000, 4000, 8000];
// Coalesces keystrokes into one message while still feeling live to the other person.
const SEND_DELAY = 40;
// Back from the background after this long: assume the socket is dead and reconnect.
const STALE_AFTER = 15_000;

/** Keeps one WebSocket to the board open and feeds it the store's ops. */
export class Sync {
  private store: Store;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer = 0;
  private sendTimer = 0;
  private lastSent = -Infinity;
  private heartbeat = 0;
  private lastHeard = 0;
  private hiddenAt = 0;

  constructor(store: Store) {
    this.store = store;
  }

  start() {
    this.store.onOps = () => this.sendSoon();
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.wake(Date.now() - this.hiddenAt > STALE_AFTER);
      } else {
        this.hiddenAt = Date.now();
        this.flush();
        this.store.save();
      }
    });
    addEventListener('pagehide', () => this.store.save());
    addEventListener('online', () => this.wake(true));
    addEventListener('pageshow', (e) => {
      if (e.persisted) this.wake(true);
    });
  }

  /** Sends whatever is queued right now. */
  flush() {
    clearTimeout(this.sendTimer);
    this.sendTimer = 0;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const batch = this.store.takeBatch();
    if (!batch) return;
    this.send({ t: 'ops', id: batch.id, ops: batch.ops });
    this.lastSent = performance.now();
  }

  private connect() {
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    const old = this.ws;
    this.ws = null;
    old?.close();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { epoch, seq } = this.store;
    const ws = new WebSocket(`${proto}//${location.host}/board/ws?epoch=${epoch}&since=${seq}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastHeard = Date.now();
      for (const batch of this.store.unacked()) this.send({ t: 'ops', id: batch.id, ops: batch.ops });
      this.flush();
      this.heartbeat = setInterval(() => this.beat(), 20_000);
    };
    ws.onmessage = (e) => {
      this.lastHeard = Date.now();
      if (e.data === 'pong' || typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data) as ServerMsg;
      if (msg.t === 'ack') this.store.ack(msg.id, msg.seq);
      else this.store.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.heartbeat);
      this.retry();
    };
  }

  private send(msg: ClientMsg) {
    this.ws?.send(JSON.stringify(msg));
  }

  // The first change after a pause goes out right away; a burst of typing after it is
  // sent at most every SEND_DELAY ms.
  private sendSoon() {
    if (this.sendTimer) return;
    const wait = Math.max(0, this.lastSent + SEND_DELAY - performance.now());
    if (wait === 0) {
      this.sendTimer = -1;
      queueMicrotask(() => this.flush());
    } else {
      this.sendTimer = setTimeout(() => this.flush(), wait);
    }
  }

  private beat() {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastHeard > 50_000) this.connect();
    else ws.send('ping');
  }

  private wake(stale: boolean) {
    const ws = this.ws;
    if (stale || !ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      this.connect();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    // A socket can look open after a nap and be dead; make it prove itself.
    const asked = Date.now();
    ws.send('ping');
    setTimeout(() => {
      if (this.ws === ws && this.lastHeard < asked) this.connect();
    }, 2500);
  }

  private retry() {
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] * (0.75 + Math.random() / 2);
    this.attempt++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
    if (this.attempt === 4) this.checkSignedIn();
  }

  /** Repeated failures can mean the cookie is gone; the page itself knows. */
  private async checkSignedIn() {
    try {
      const res = await fetch('/board', { method: 'HEAD', cache: 'no-store' });
      if (res.ok && !res.headers.get('X-Board')) location.reload();
    } catch {
      // offline; keep retrying quietly
    }
  }
}
