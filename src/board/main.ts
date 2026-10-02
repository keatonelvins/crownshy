import './board.css';
import type { Snapshot } from '../../shared/protocol.ts';
import { Drag } from './drag.ts';
import { Grid } from './grid.ts';
import { Sheet } from './sheet.ts';
import { Store } from './store.ts';
import { Sync } from './sync.ts';

// The Worker inlines the board into the page; this device's own copy may be newer.
const inline = document.getElementById('state')?.textContent;
const store = Store.load(inline ? (JSON.parse(inline) as Snapshot) : null);

const root = document.getElementById('board')!;
const add = document.getElementById('add')!;
const grid = new Grid(root, store);
const sheet = new Sheet(store, grid);
new Drag(root, grid, store, add);
grid.onOpen = (id, card) => sheet.open(id, { from: card.getBoundingClientRect() });
grid.layout(false);

add.addEventListener('click', () => {
  const list = store.createList();
  // New things land top-left; jump there behind the sheet so closing it lands in view.
  scrollTo(0, 0);
  sheet.open(list.id, { from: add.getBoundingClientRect(), focus: 'title' });
});

// Opened at /board/<id>: start inside that list.
const linked = location.pathname.match(/^\/board\/([0-9A-Za-z]{8,32})$/)?.[1];
if (linked && store.live(linked)) {
  // Phones won't raise a keyboard without a tap, so only focus where there's a real keyboard.
  sheet.open(linked, { history: 'replace', focus: matchMedia('(pointer: fine)').matches ? 'end' : 'none' });
} else if (linked) {
  history.replaceState(null, '', '/board');
}

// Areal changes line heights when it arrives, so balance the columns again.
if (!document.fonts.check('16px Areal')) document.fonts.load('16px Areal').then(() => grid.layout(false));

let resizing = 0;
addEventListener('resize', () => {
  cancelAnimationFrame(resizing);
  resizing = requestAnimationFrame(() => grid.resize());
});

const sync = new Sync(store);
sync.start();

if (import.meta.env.DEV) Object.assign(window, { board: { store, grid, sheet, sync } });

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/board-sw.js', { scope: '/board' });
  // Opened from the cache? Ask whether this is the latest version of the app. If not,
  // switch now when we've only just opened, otherwise the next time the board comes
  // back to the front.
  const script = document.querySelector<HTMLScriptElement>('script[type=module][src]');
  if (script) navigator.serviceWorker.controller?.postMessage({ type: 'check', script: new URL(script.src).pathname });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data !== 'updated') return;
    if (performance.now() < 5000 && !sheet.id) {
      location.reload();
      return;
    }
    const reloadWhenBack = () => {
      if (document.visibilityState === 'visible') location.reload();
    };
    document.addEventListener('visibilitychange', reloadWhenBack);
  });
  navigator.serviceWorker.startMessages();
}
