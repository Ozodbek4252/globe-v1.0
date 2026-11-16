import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// `base: './'` makes every built URL relative to the page, so the same build works at
// https://<user>.github.io/<repo>/, on a custom domain, after a repo rename, or from `vite preview`.
// Runtime fetches and image paths go through src/lib/url.ts, which prefixes import.meta.env.BASE_URL.
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
    // File-change events from a Windows bind mount don't reach a Linux container; poll there instead.
    watch: process.env.VITE_USE_POLLING === '1' ? { usePolling: true, interval: 300 } : undefined,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
