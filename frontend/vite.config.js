import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/users': 'http://localhost:8080',
      '/collect-data': 'http://localhost:8080',
      '/health': 'http://localhost:8080'
    }
  }
});
