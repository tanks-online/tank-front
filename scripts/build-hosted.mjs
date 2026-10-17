import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// npm_execpath is supplied by npm on Windows and Linux. No shell interpolation.
if (!process.env.npm_execpath) throw new Error('Запустите через npm run build:hosted.');
for (const folder of ['client', 'server']) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, '--prefix', folder, 'run', 'build'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SERVER_URL: process.env.VITE_SERVER_URL || '/ws' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
