# Crown Shy Press

The website for [crownshypress.com](https://crownshypress.com), built with Astro and TypeScript.

## Commands

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `pnpm install`            | Install dependencies                             |
| `pnpm dev`                | Start the Astro-only UI development server       |
| `pnpm dev:board`          | Build and start the full local board on port 8787 |
| `pnpm build`              | Build the production site to `./dist/`           |
| `pnpm check`              | Type-check the Astro page and Worker              |
| `pnpm types`              | Regenerate Cloudflare binding types               |
| `pnpm preview`            | Preview the production build                     |
| `pnpm astro ...`          | Run an Astro CLI command                         |

## Shared board

The unlisted board lives at `/board/`. It uses a Worker API and D1 for both cards and browser-resized images.

For local development, copy `.dev.vars.example` to `.dev.vars`, choose a passphrase, then run:

```sh
pnpm wrangler d1 migrations apply crownshy-board --local
pnpm dev:board
```

Open `http://localhost:8787/board/` for the working local board. For UI-only fixture data, run `pnpm dev` and open `http://localhost:4321/board/?fixture=1`.

The daily writing form accepts two anonymous submissions of at least 50 words per Los Angeles calendar day. Submissions remain archived in D1. If a completed day has fewer than two submissions, the board's cards and images are cleared while the writing archive is preserved.

## Cloudflare Workers

Build the Astro site with `pnpm build`, then deploy the Worker and its static assets with `pnpm wrangler deploy`. Set `BOARD_PASSWORD` as a Worker secret rather than committing it.
