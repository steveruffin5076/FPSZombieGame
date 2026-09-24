import { defineConfig } from 'vite';

/**
 * Deadlight dev/build configuration.
 *
 * Notes
 * -----
 *  - `base: './'` keeps the build portable (it can be served from any
 *    subdirectory, which is what the itch.io / static-host deploy needs).
 *  - The dev server binds `0.0.0.0` with permissive hosts so it can be reached
 *    from a containerised preview or a LAN device for split-screen testing.
 *  - `three` is split into its own chunk: it never changes between builds, so
 *    the browser can cache it independently of gameplay code.
 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  esbuild: {
    legalComments: 'none',
  },
});
