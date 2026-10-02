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

## Deploy

Pushing to `main` deploys automatically through Cloudflare Workers Builds.
Other branches get their own preview URLs.

To deploy by hand instead: `npm run deploy` (run `npx wrangler login` first).

After changing bindings in `wrangler.jsonc`, run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`.
