import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.release/runtime');
await access(join(root, 'client/dist/index.html')).catch(() => { throw new Error('Сначала npm run build:hosted.'); });
await access(join(root, 'server/dist/index.js'));
const clientHtml = await readFile(join(root, 'client/dist/index.html'), 'utf8');
if (!clientHtml.includes('assets/')) throw new Error('В client/dist не найдена сборка Vite.');
await mkdir(directory, { recursive: true });
await cp(join(root, 'client/dist'), join(directory, 'public'), { recursive: true });
await cp(join(root, 'server/dist'), join(directory, 'server'), { recursive: true });
const source = JSON.parse(await readFile(join(root, 'server/package.json'), 'utf8'));
const sourceLock = JSON.parse(await readFile(join(root, 'server/package-lock.json'), 'utf8'));
const pkg = {
  name: 'tank-front-runtime', version: source.version, private: true, type: 'module', engines: source.engines,
  scripts: { start: 'node --max-old-space-size=192 --env-file-if-exists=.env server/index.js' }, dependencies: source.dependencies,
};
const lock = {
  name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
  packages: { '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, engines: pkg.engines }, 'node_modules/ws': sourceLock.packages['node_modules/ws'] },
};
await writeFile(join(directory, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
await writeFile(join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
await writeFile(join(directory, 'README.txt'), `Танковый фронт — готовая серверная копия\n\nNode.js >=22.14.0. Извлеките файлы в корень приложения.\nУстановите npm ci --omit=dev. Старт: npm start.\nEnvironment: NODE_ENV=production, STATIC_DIR=public, PUBLIC_URL=https://ВАШ-ТОЧНЫЙ-ХОСТ.\nPORT — выделенный хостингом порт. Приложение слушает 0.0.0.0.\nСайт автоматически подключается к /ws на своём адресе.\nПубликация требует действительного бесплатного HTTPS/WSS.\nВ архиве нет node_modules, исходных .env и токенов.\n`);
const archive = resolve(root, '.release/tank-front-runtime.tar.gz');
const result = spawnSync('tar', ['-czf', archive, '-C', directory, 'package.json', 'package-lock.json', 'server', 'public', 'README.txt'], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log(archive);
