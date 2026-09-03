const SESSION_COOKIE = 'crownshy_board_session';
const SESSION_MESSAGE = 'crownshy-board-session-v1';
const MAX_CARD_LENGTH = 500;
const MAX_JSON_BYTES = 4_096;
const MAX_IMAGE_BYTES = 1_500_000;
const MIN_WRITING_WORDS = 50;
const MAX_WRITING_LENGTH = 20_000;
const MAX_WRITING_JSON_BYTES = 64_000;
const WRITING_TIME_ZONE = 'America/Los_Angeles';
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

type BoardItemRow = {
	id: string;
	kind: 'card' | 'image';
	content: string | null;
	created_at: number;
};

type ImageRow = {
	image_type: string;
	image_data: number[];
};

type WritingStateRow = {
	last_evaluated_date: string;
};

type WritingCountRow = {
	submission_date: string;
	submission_count: number;
};

type WritingSlotRow = {
	slot: number;
};

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handleRequest(request, env);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: 'board request failed',
					path: new URL(request.url).pathname,
					error: error instanceof Error ? error.message : String(error),
				}),
			);

			return json({ error: 'Something went wrong.' }, 500);
		}
	},

	async scheduled(_controller, env): Promise<void> {
		try {
			await enforceDailyWritingRule(env);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: 'daily writing enforcement failed',
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			throw error;
		}
	},
} satisfies ExportedHandler<Env>;

async function handleRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (!url.pathname.startsWith('/api/')) {
		return new Response('Not found', { status: 404 });
	}

	if (url.pathname === '/api/session') {
		return handleSession(request, env);
	}

	if (!(await isAuthenticated(request, env.BOARD_PASSWORD))) {
		return json({ error: 'Passphrase required.' }, 401);
	}

	await enforceDailyWritingRule(env);

	if (url.pathname === '/api/writing/today' && request.method === 'GET') {
		return getTodayWritingStatus(env);
	}

	if (url.pathname === '/api/writing/submissions' && request.method === 'POST') {
		if (!isSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
		return createWritingSubmission(request, env);
	}

	if (url.pathname === '/api/items' && request.method === 'GET') {
		return listItems(env);
	}

	if (url.pathname === '/api/cards' && request.method === 'POST') {
		if (!isSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
		return createCard(request, env);
	}

	if (url.pathname === '/api/images' && request.method === 'POST') {
		if (!isSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
		return createImage(request, env);
	}

	const imageMatch = url.pathname.match(/^\/api\/images\/([0-9a-f-]{36})$/);
	if (imageMatch && request.method === 'GET') {
		return getImage(imageMatch[1], env);
	}

	const itemMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})$/);
	if (itemMatch && request.method === 'DELETE') {
		if (!isSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
		return deleteItem(itemMatch[1], env);
	}

	return json({ error: 'Not found.' }, 404);
}

async function handleSession(request: Request, env: Env): Promise<Response> {
	if (request.method === 'GET') {
		if (!(await isAuthenticated(request, env.BOARD_PASSWORD))) {
			return json({ authenticated: false }, 401);
		}

		return json({ authenticated: true });
	}

	if (request.method === 'DELETE') {
		if (!isSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
		return json(
			{ authenticated: false },
			200,
			{ 'set-cookie': serializeSessionCookie('', request, 0) },
		);
	}

	if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
	if (!isSameOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_JSON_BYTES) return json({ error: 'Request is too large.' }, 413);
	if (!request.headers.get('content-type')?.startsWith('application/json')) {
		return json({ error: 'Expected JSON.' }, 415);
	}

	const body: unknown = await request.json();
	const passphrase = getStringProperty(body, 'passphrase');
	if (!passphrase || !(await timingSafeTextEqual(passphrase, env.BOARD_PASSWORD))) {
		return json({ error: 'That passphrase is not quite right.' }, 401);
	}

	const token = await createSessionToken(env.BOARD_PASSWORD);
	return json(
		{ authenticated: true },
		200,
		{ 'set-cookie': serializeSessionCookie(token, request, 60 * 60 * 24 * 30) },
	);
}

async function listItems(env: Env): Promise<Response> {
	const result = await env.BOARD_DB.prepare(
		`SELECT id, kind, content, created_at
		 FROM board_items
		 ORDER BY created_at ASC, id ASC`,
	).all<BoardItemRow>();

	return json({
		items: result.results.map(toPublicItem),
	});
}

async function createCard(request: Request, env: Env): Promise<Response> {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_JSON_BYTES) return json({ error: 'Request is too large.' }, 413);
	if (!request.headers.get('content-type')?.startsWith('application/json')) {
		return json({ error: 'Expected JSON.' }, 415);
	}

	const body: unknown = await request.json();
	const content = getStringProperty(body, 'content')?.trim();
	if (!content) return json({ error: 'Write something on the card first.' }, 400);
	if (content.length > MAX_CARD_LENGTH) {
		return json({ error: `Cards can be up to ${MAX_CARD_LENGTH} characters.` }, 400);
	}

	const item: BoardItemRow = {
		id: crypto.randomUUID(),
		kind: 'card',
		content,
		created_at: Date.now(),
	};

	await env.BOARD_DB.prepare(
		`INSERT INTO board_items (id, kind, content, image_type, image_data, created_at)
		 VALUES (?1, ?2, ?3, NULL, NULL, ?4)`,
	)
		.bind(item.id, item.kind, item.content, item.created_at)
		.run();

	return json({ item: toPublicItem(item) }, 201);
}

async function createImage(request: Request, env: Env): Promise<Response> {
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].toLowerCase() ?? '';
	if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
		return json({ error: 'Choose a JPEG, PNG, WebP, or GIF image.' }, 415);
	}

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_IMAGE_BYTES) {
		return json({ error: 'Board images can be up to 1.5 MB.' }, 413);
	}

	const bytes = await request.arrayBuffer();
	if (bytes.byteLength === 0) return json({ error: 'That image is empty.' }, 400);
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		return json({ error: 'Board images can be up to 1.5 MB.' }, 413);
	}

	const id = crypto.randomUUID();
	const createdAt = Date.now();

	await env.BOARD_DB.prepare(
		`INSERT INTO board_items (id, kind, content, image_type, image_data, created_at)
		 VALUES (?1, 'image', NULL, ?2, ?3, ?4)`,
	)
		.bind(id, contentType, bytes, createdAt)
		.run();

	return json(
		{
			item: toPublicItem({ id, kind: 'image', content: null, created_at: createdAt }),
		},
		201,
	);
}

async function getImage(id: string, env: Env): Promise<Response> {
	const row = await env.BOARD_DB.prepare(
		`SELECT image_type, image_data
		 FROM board_items
		 WHERE id = ?1 AND kind = 'image'`,
	)
		.bind(id)
		.first<ImageRow>();

	if (!row) return json({ error: 'Image not found.' }, 404);

	const bytes = Uint8Array.from(row.image_data);
	return new Response(bytes, {
		headers: {
			'content-type': row.image_type,
			'content-length': String(bytes.byteLength),
			'cache-control': 'private, max-age=3600',
			'x-content-type-options': 'nosniff',
		},
	});
}

async function deleteItem(id: string, env: Env): Promise<Response> {
	const result = await env.BOARD_DB.prepare('DELETE FROM board_items WHERE id = ?1').bind(id).run();
	if (result.meta.changes === 0) return json({ error: 'Item not found.' }, 404);

	return new Response(null, { status: 204 });
}

async function getTodayWritingStatus(env: Env): Promise<Response> {
	const today = getLocalDate(new Date());
	return json(await readWritingStatus(env.BOARD_DB, today));
}

async function createWritingSubmission(request: Request, env: Env): Promise<Response> {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_WRITING_JSON_BYTES) return json({ error: 'Submission is too large.' }, 413);
	if (!request.headers.get('content-type')?.startsWith('application/json')) {
		return json({ error: 'Expected JSON.' }, 415);
	}

	const body: unknown = await request.json();
	const content = getStringProperty(body, 'content')?.trim();
	if (!content) return json({ error: 'Paste in your writing first.' }, 400);
	if (content.length > MAX_WRITING_LENGTH) {
		return json({ error: `Submissions can be up to ${MAX_WRITING_LENGTH.toLocaleString()} characters.` }, 400);
	}

	const wordCount = countWords(content);
	if (wordCount < MIN_WRITING_WORDS) {
		return json({ error: `Write at least ${MIN_WRITING_WORDS} words before submitting.` }, 400);
	}

	const today = getLocalDate(new Date());
	const session = env.BOARD_DB.withSession('first-primary');
	const result = await session
		.prepare(
			`INSERT INTO writing_submissions (id, submission_date, slot, content, word_count, created_at)
			 SELECT ?1, ?2,
				CASE
					WHEN NOT EXISTS (
						SELECT 1 FROM writing_submissions WHERE submission_date = ?2 AND slot = 1
					) THEN 1
					ELSE 2
				END,
				?3, ?4, ?5
			 WHERE (SELECT COUNT(*) FROM writing_submissions WHERE submission_date = ?2) < 2`,
		)
		.bind(crypto.randomUUID(), today, content, wordCount, Date.now())
		.run();

	if (result.meta.changes === 0) {
		return json({ error: 'Both submissions are already in for today.' }, 409);
	}

	return json(await readWritingStatus(session, today), 201);
}

async function readWritingStatus(database: D1Database | D1DatabaseSession, date: string) {
	const result = await database
		.prepare('SELECT slot FROM writing_submissions WHERE submission_date = ?1 ORDER BY slot ASC')
		.bind(date)
		.all<WritingSlotRow>();
	const completedSlots = new Set(result.results.map((row) => row.slot));

	return {
		date,
		timeZone: WRITING_TIME_ZONE,
		minWords: MIN_WRITING_WORDS,
		completed: completedSlots.size,
		lights: [completedSlots.has(1), completedSlots.has(2)],
	};
}

async function enforceDailyWritingRule(env: Env): Promise<void> {
	const today = getLocalDate(new Date());
	const yesterday = shiftDate(today, -1);
	const session = env.BOARD_DB.withSession('first-primary');
	const state = await session
		.prepare('SELECT last_evaluated_date FROM writing_state WHERE id = 1')
		.first<WritingStateRow>();

	if (!state) {
		await session
			.prepare(
				`INSERT OR IGNORE INTO writing_state (id, started_on, last_evaluated_date, last_wipe_at)
				 VALUES (1, ?1, ?2, NULL)`,
			)
			.bind(today, yesterday)
			.run();
		return;
	}

	if (state.last_evaluated_date >= yesterday) return;

	const counts = await session
		.prepare(
			`SELECT submission_date, COUNT(*) AS submission_count
			 FROM writing_submissions
			 WHERE submission_date > ?1 AND submission_date <= ?2
			 GROUP BY submission_date`,
		)
		.bind(state.last_evaluated_date, yesterday)
		.all<WritingCountRow>();
	const countsByDate = new Map(counts.results.map((row) => [row.submission_date, row.submission_count]));

	let missedDay = false;
	for (let date = shiftDate(state.last_evaluated_date, 1); date <= yesterday; date = shiftDate(date, 1)) {
		if ((countsByDate.get(date) ?? 0) < 2) {
			missedDay = true;
			break;
		}
	}

	const updateState = session
		.prepare(
			`UPDATE writing_state
			 SET last_evaluated_date = ?1,
				 last_wipe_at = CASE WHEN ?2 = 1 THEN ?3 ELSE last_wipe_at END
			 WHERE id = 1`,
		)
		.bind(yesterday, missedDay ? 1 : 0, Date.now());

	if (missedDay) {
		await session.batch([session.prepare('DELETE FROM board_items'), updateState]);
	} else {
		await updateState.run();
	}
}

function countWords(value: string): number {
	const normalized = value.trim();
	return normalized ? normalized.split(/\s+/u).length : 0;
}

function getLocalDate(date: Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: WRITING_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date);
	const year = parts.find((part) => part.type === 'year')?.value;
	const month = parts.find((part) => part.type === 'month')?.value;
	const day = parts.find((part) => part.type === 'day')?.value;
	if (!year || !month || !day) throw new Error('Could not determine the writing date.');
	return `${year}-${month}-${day}`;
}

function shiftDate(date: string, days: number): string {
	const [year, month, day] = date.split('-').map(Number);
	const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
	return shifted.toISOString().slice(0, 10);
}

function toPublicItem(row: BoardItemRow) {
	return {
		id: row.id,
		kind: row.kind,
		content: row.content,
		imageUrl: row.kind === 'image' ? `/api/images/${row.id}` : null,
	};
}

function getStringProperty(value: unknown, key: string): string | null {
	if (typeof value !== 'object' || value === null || !(key in value)) return null;
	const property = Reflect.get(value, key);
	return typeof property === 'string' ? property : null;
}

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
	const headers = new Headers(extraHeaders);
	headers.set('content-type', 'application/json; charset=utf-8');
	headers.set('cache-control', 'no-store');
	headers.set('x-content-type-options', 'nosniff');
	return new Response(JSON.stringify(body), { status, headers });
}

function isSameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return origin === new URL(request.url).origin;
}

function serializeSessionCookie(value: string, request: Request, maxAge: number): string {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function getCookie(request: Request, name: string): string | null {
	const cookie = request.headers.get('cookie');
	if (!cookie) return null;

	for (const part of cookie.split(';')) {
		const [key, ...value] = part.trim().split('=');
		if (key === name) return value.join('=');
	}

	return null;
}

async function isAuthenticated(request: Request, secret: string): Promise<boolean> {
	const token = getCookie(request, SESSION_COOKIE);
	if (!token) return false;
	const expected = await createSessionToken(secret);
	return timingSafeTextEqual(token, expected);
}

async function createSessionToken(secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(SESSION_MESSAGE));
	return bytesToBase64Url(new Uint8Array(signature));
}

async function timingSafeTextEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	]);
	return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
