import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
const require = createRequire(import.meta.url);
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'], alias: { events: require.resolve('events/') } },
  define: { 'import.meta.env.VITE_ABLO_BASE_URL': JSON.stringify(process.env.ABLO_BASE_URL ?? '') },
});
