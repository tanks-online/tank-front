import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  if (command === 'build') {
    const raw = env.VITE_SERVER_URL;
    if (!raw) throw new Error('Задайте VITE_SERVER_URL=/ws для сайта и сервера на одном адресе либо wss://HOST/ws для отдельного клиента.');
    if (raw !== '/ws') {
      const url = new URL(raw);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'wss:' && !(local && url.protocol === 'ws:')) || url.pathname !== '/ws' || url.username || url.password || url.search || url.hash) {
        throw new Error('VITE_SERVER_URL: нужен /ws или полный wss://HOST/ws без секретов. ws:// разрешён только для localhost.');
      }
    }
  }
  return { base: './', server: { port: 5173, strictPort: true }, preview: { port: 4173, strictPort: true }, build: { target: 'es2022', sourcemap: false } };
});
