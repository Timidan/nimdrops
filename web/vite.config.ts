import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `host: true` exposes the dev server on the LAN so a phone (or an HTTPS
  // tunnel in front of it) can load the mini app — required by the Nimiq Pay
  // mini-app tutorial and by the Task 7 on-device spike.
  server: { port: 5173, host: true },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
