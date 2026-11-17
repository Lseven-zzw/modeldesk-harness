import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.MODELDESK_ADMIN_BACKEND ?? 'http://127.0.0.1:8080'

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: '../app/admin/static', emptyOutDir: true },
  server: { port: 5173, proxy: {
    '/api': backend,
    '/admin/login': backend,
    '/admin/logout': backend,
  } },
})
