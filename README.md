# crownshy press

A coworking app for two, live at [www.crownshypress.com](https://www.crownshypress.com).

Repo: https://github.com/keatonelvins/crownshy.git

## Stack

- **Frontend:** React + TypeScript + Vite (`src/`)
- **Backend:** Cloudflare Worker (`worker/index.ts`), serves `/api/*`
- **Hosting:** Cloudflare Workers with static assets, configured in `wrangler.jsonc`

## Develop

```bash
npm install
npm run dev
```

This runs the app and the Worker together locally at http://localhost:5173.

## Board

`/board` is a private, live-synced board for the two of us.

- **Password:** the Worker checks `BOARD_PASSWORD` and leaves a long-lived cookie. Locally it comes from `.dev.vars` (gitignored, one line: `BOARD_PASSWORD=...`). In production it's a secret: `npx wrangler secret put BOARD_PASSWORD`.
- **Data:** one Durable Object (`worker/board.ts`) keeps the board in SQLite and holds a WebSocket to each open board. The Worker inlines the current board into the page, so it paints before the socket connects.
- **Client:** `board.html` + `src/board/` (no framework; kept small for speed). Edits apply locally first, queue while offline, and sync when the socket is back. `public/board-sw.js` serves the last copy of the page instantly on repeat visits.
- **Wire format:** `shared/protocol.ts`, used by both sides.

## Deploy

Pushing to `main` deploys automatically through Cloudflare Workers Builds.
Other branches get their own preview URLs.

To deploy by hand instead: `npm run deploy` (run `npx wrangler login` first).

After changing bindings in `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.
