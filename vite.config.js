import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const local = name => fileURLToPath(new URL(name, import.meta.url));
export default defineConfig({
  root: local('./renderer'), base: './', plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': local('./renderer/src') } },
  build: { outDir: local('./renderer-dist'), emptyOutDir: true, rollupOptions: { input: { manager: local('./renderer/index.html'), setup: local('./renderer/setup.html') } } },
});
