import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // v dev móde beží API/MCP na apps/server
    proxy: { '/api': 'http://localhost:8787', '/mcp': 'http://localhost:8787' },
  },
});
