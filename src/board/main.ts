import './board.css';
import { imageUrl, newId, type Snapshot } from '../../shared/protocol.ts';
import { Drag } from './drag.ts';
import { Grid } from './grid.ts';
import { prepare } from './images.ts';
import { Sheet } from './sheet.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';
import { Uploads } from './uploads.ts';
import { Viewer } from './viewer.ts';

// The Worker inlines the board into the page; this device's own copy may be newer.
const inline = document.getElementById('state')?.textContent;
const store = Store.load(inline ? (JSON.parse(inline) as Snapshot) : null);

const uploads = new Uploads();
uploads.onDone = (id) => store.imageUploaded(id);
uploads.resume();

const root = document.getElementById('board')!;
const add = document.getElementById('add')!;
const menu = document.getElementById('menu')!;
const pick = document.getElementById('pick') as HTMLInputElement;
const grid = new Grid(root, store, uploads);
const sheet = new Sheet(store, grid);
const viewer = new Viewer(store, grid, uploads);
new Drag(root, grid, store, add);
grid.onOpen = (id, card) => {
  const from = card.getBoundingClientRect();
  if (store.live(id)?.kind === 'image') viewer.open(id, { from });
  else sheet.open(id, { from });
};
grid.layout(false);

// ---------- making things: + opens a short menu ----------

const setMenu = (open: boolean) => {
  document.documentElement.classList.toggle('menu-open', open);
  add.setAttribute('aria-expanded', String(open));
};
const menuOpen = () => document.documentElement.classList.contains('menu-open');

add.addEventListener('click', () => setMenu(!menuOpen()));
addEventListener('pointerdown', (e) => {
  const target = e.target as Node;
  if (menuOpen() && !menu.contains(target) && !add.contains(target)) setMenu(false);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuOpen()) setMenu(false);
});
menu.addEventListener('click', (e) => {
  const make = (e.target as HTMLElement).closest<HTMLElement>('[data-make]')?.dataset.make;
  if (!make) return;
  setMenu(false);
  if (make === 'image') {
    // inside the tap itself, or phones won't open the photo picker
    pick.click();
    return;
  }
  const list = store.createList();
  // New things land top-left; jump there behind the sheet so closing it lands in view.
  scrollTo(0, 0);
  sheet.open(list.id, { from: add.getBoundingClientRect(), focus: 'title' });
});

pick.addEventListener('change', () => {
  addImages([...(pick.files ?? [])]);
  pick.value = '';
});

/** New pictures land top-left, in the order picked, each as soon as it's ready. */
async function addImages(files: File[]) {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  scrollTo(0, 0);
  const ords = store.topKeys(images.length);
  // one at a time: a full-size photo takes a lot of memory to decode
  for (const [k, file] of images.entries()) {
    try {
      const { w, h, ph, full, board } = await prepare(file);
      const id = newId();
      uploads.add(id, { board, full });
      store.createImage(id, ords[k], { w, h, ph });
    } catch {
      // not a picture this browser can read
    }
  }
}

// On a laptop: drop pictures anywhere, or paste one (outside a list being written in).
addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  addImages([...e.dataTransfer.files]);
});
addEventListener('paste', (e) => {
  if (sheet.id || (e.target as HTMLElement).closest?.('textarea, input')) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addImages(files);
});

// ---------- the rest ----------

// Opened at /board/<id>: start with that list or picture up.
const linked = location.pathname.match(/^\/board\/([0-9A-Za-z]{8,32})$/)?.[1];
const linkedObj = linked ? store.live(linked) : undefined;
if (linked && linkedObj?.kind === 'image') {
  viewer.open(linked, { history: 'replace' });
} else if (linked && linkedObj) {
  // Phones won't raise a keyboard without a tap, so only focus where there's a real keyboard.
  sheet.open(linked, { history: 'replace', focus: matchMedia('(pointer: fine)').matches ? 'end' : 'none' });
} else if (linked) {
  history.replaceState(null, '', '/board');
}

// Areal changes line heights when it arrives, so balance the columns again.
if (!document.fonts.check('16px Areal')) document.fonts.load('16px Areal').then(() => grid.layout(false));

// No pinch-zoom: iPhone Safari ignores user-scalable=no, but its gesture events can be stopped.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault());
}

let resizing = 0;
addEventListener('resize', () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => grid.resize());
});

const sync = new Sync(store);
sync.start();

if (import.meta.env.DEV) Object.assign(window, { board: { store, grid, sheet, viewer, sync, uploads } });

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/board-sw.js', { scope: '/board' });
  // Opened from the cache? Ask whether this is the latest version of the app. If not,
  // switch now when we've only just opened, otherwise the next time the board comes
  // back to the front.
  const script = document.querySelector<HTMLScriptElement>('script[type=module][src]');
  if (script) navigator.serviceWorker.controller?.postMessage({ type: 'check', script: new URL(script.src).pathname });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data !== 'updated') return;
    if (performance.now() < 5000 && !sheet.id && !viewer.id) {
      location.reload();
      return;
    }
    const reloadWhenBack = () => {
      if (document.visibilityState === 'visible') location.reload();
    };
    document.addEventListener('visibilitychange', reloadWhenBack);
  });
  navigator.serviceWorker.startMessages();

  // Once things are quiet, fetch every board copy so the whole board works offline
  // (the service worker keeps them; anything already kept costs nothing).
  setTimeout(() => {
    for (const o of store.ordered()) {
      if (o.kind === 'image' && o.data.up && !uploads.localUrl(o.id, 'board')) {
        fetch(imageUrl(o.id, 'board'), { priority: 'low' } as RequestInit).catch(() => {});
      }
    }
  }, 4000);
}
