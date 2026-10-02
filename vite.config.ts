import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  environments: {
    client: {
      build: {
        modulePreload: { polyfill: false },
        rolldownOptions: {
          // The board is its own page with its own (small, framework-free) bundle.
          input: { index: 'index.html', board: 'board.html' },
        },
      },
    },
  },
})
