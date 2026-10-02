import { ID_RE, LIMITS } from '../shared/protocol.ts';
import { gate } from './gate.ts';

export { Board } from './board.ts';
export { Images } from './images.ts';

const COOKIE = 'board';
// Browsers cap cookie lifetimes at 400 days; it's renewed on every visit.
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    if (url.pathname === '/board' || url.pathname.startsWith('/board/')) {
      return board(request, env, ctx, url);
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function board(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/board/login') {
    if (request.method !== 'POST') return redirect('/board');
    return login(request, env, url);
  }

  const authed = await isAuthed(request, env);

  if (path === '/board/ws') {
    if (!authed) return new Response(null, { status: 401 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response(null, { status: 403 });
    return boardStub(env).fetch(request);
  }

  if (path.startsWith('/board/img/')) {
    if (!authed) return new Response(null, { status: 401 });
    return image(request, env, ctx, url, path);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });

  // /board, or /board/<id> to open straight into a list or image
  const id = path.slice('/board/'.length);
  if (path !== '/board' && !ID_RE.test(id)) return redirect('/board');

  if (!authed) return html(gate(path, false), 200);
  return page(env, url);
}

/** The board shell with the current board inlined, so it paints without waiting on the socket. */
async function page(env: Env, url: URL): Promise<Response> {
  const [shell, snapshot] = await Promise.all([
    env.ASSETS.fetch(new URL('/board', url)),
    boardStub(env).snapshot(),
  ]);
  const state = snapshot.replace(/</g, '\\u003c');
  const body = new HTMLRewriter()
    .on('head', {
      element(head) {
        head.append(`<script id="state" type="application/json">${state}</script>`, { html: true });
      },
    })
    .transform(shell).body;

  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Board': '1',
    'Set-Cookie': cookie(await expectedToken(env), url),
  });
  return new Response(body, { status: 200, headers });
}

const IMAGE_PATH = /^\/board\/img\/([0-9A-Za-z]{8,32})\/(full|board)$/;
const IMAGE_TYPES = ['image/webp', 'image/jpeg'];

/** Stores and serves one copy of an image (the browser has already resized it). */
async function image(request: Request, env: Env, ctx: ExecutionContext, url: URL, path: string): Promise<Response> {
  const match = path.match(IMAGE_PATH);
  if (!match) return new Response(null, { status: 404 });
  const key = `${match[1]}/${match[2]}`;
  const files = env.IMAGES.getByName('images');

  if (request.method === 'PUT') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response(null, { status: 403 });
    const type = request.headers.get('Content-Type') ?? '';
    if (!IMAGE_TYPES.includes(type)) return new Response(null, { status: 415 });
    const data = await request.arrayBuffer();
    if (!data.byteLength || data.byteLength > LIMITS.imageBytes) return new Response(null, { status: 413 });
    await files.put(key, type, data);
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });

  // A stored copy never changes. The edge keeps it (and is only reachable past the
  // password check above); the browser keeps it forever.
  const cacheKey = new Request(new URL(path, url));
  let res = await caches.default.match(cacheKey);
  if (!res) {
    const file = await files.get(key);
    if (!file) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    res = new Response(file.data, {
      headers: { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: `"${key}"` },
    });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  }
  const out = new Response(request.method === 'HEAD' ? null : res.body, res);
  out.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return out;
}

async function login(request: Request, env: Env, url: URL): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get('p') ?? '');
  const next = String(form.get('next') ?? '');
  const to = /^\/board(\/[0-9A-Za-z]{8,32})?$/.test(next) ? next : '/board';

  if (!env.BOARD_PASSWORD || !(await same(await token(password), await expectedToken(env)))) {
    return html(gate(to, true), 401);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: to, 'Set-Cookie': cookie(await expectedToken(env), url) },
  });
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  if (!env.BOARD_PASSWORD) return false;
  const match = request.headers.get('Cookie')?.match(/(?:^|;\s*)board=([^;]+)/);
  if (!match) return false;
  return same(match[1], await expectedToken(env));
}

// The cookie holds an HMAC of the password, so changing the password signs everyone out.
async function token(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('crownshy board v1')));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let expected: { password: string; token: Promise<string> } | undefined;
function expectedToken(env: Env): Promise<string> {
  if (expected?.password !== env.BOARD_PASSWORD) {
    expected = { password: env.BOARD_PASSWORD, token: token(env.BOARD_PASSWORD) };
  }
  return expected.token;
}

async function same(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function cookie(value: string, url: URL): string {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

function boardStub(env: Env) {
  return env.BOARD.getByName('board');
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}
