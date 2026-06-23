import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3030',
      '/dashboard.json': 'http://127.0.0.1:3030',
      '/military-dashboard.json': 'http://127.0.0.1:3030',
      '/untracked-dashboard.json': 'http://127.0.0.1:3030',
      '/rss.xml': 'http://127.0.0.1:3030',
      '/feed.xml': 'http://127.0.0.1:3030',
    },
  },
});
