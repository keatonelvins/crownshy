// Makes the board open instantly, even on a bad connection: the last board page
// comes straight from the cache while a fresh copy is fetched in the background.
// The page then catches up over its socket, so a stale copy is fine for a moment.
// A page asks whether it's the latest version of the app; if the fresh copy says
// otherwise, it switches.

const PAGES = 'board-pages-v1';
const ASSETS = 'board-assets-v1';
const BOARD_PATH = /^\/board(\/[0-9A-Za-z]{8,32})?\/?$/;

// The background refresh in flight, if any.
let refreshing = Promise.resolve();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  if (e.data?.type !== 'check') return;
  e.waitUntil(
    (async () => {
      await refreshing;
      const latest = await (await caches.open(PAGES)).match('/board');
      if (latest && !assetsOf(await latest.text()).includes(e.data.script)) e.source.postMessage('updated');
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate' && BOARD_PATH.test(url.pathname)) {
    e.respondWith(page(e));
  } else if (/^\/(assets|fonts)\/|^\/board-icon/.test(url.pathname)) {
    e.respondWith(asset(req));
  }
});

async function page(e) {
  const cache = await caches.open(PAGES);
  const cached = await cache.match('/board');
  const fresh = fetch(e.request).then(async (res) => {
    if (res.ok && res.headers.get('X-Board')) {
      const old = await cache.match('/board');
      const [before, after] = await Promise.all([old ? old.text() : '', res.clone().text()]);
      await cache.put('/board', res.clone());
      await prune(before, after);
    } else if (res.ok) {
      // the password page: signed out, so forget the board
      await cache.delete('/board');
    }
    return res;
  });
  refreshing = fresh.catch(() => {});
  if (!cached) return fresh;
  e.waitUntil(fresh.catch(() => {}));
  return cached;
}

// Hashed files never change, so once fetched they're served from the cache.
async function asset(req) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

function assetsOf(html) {
  return [...html.matchAll(/\/assets\/[^"'\s)]+/g)].map((m) => m[0]).sort();
}

// Keep the assets of the page being shown and of the new one; drop the rest.
async function prune(...pages) {
  const keep = new Set(pages.flatMap(assetsOf));
  const cache = await caches.open(ASSETS);
  for (const req of await cache.keys()) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/assets/') && !keep.has(pathname)) await cache.delete(req);
  }
}
