import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { server: { type: 'string' }, origin: { type: 'string' } } });
if (!values.server || !values.origin) {
  console.error('Usage: npm run verify:remote -- --server https://SERVICE.onrender.com --origin https://PROJECT.pages.dev');
  process.exit(1);
}
const base = new URL(values.server), site = new URL(values.origin);
if (base.protocol !== 'https:' || site.protocol !== 'https:' || base.origin !== values.server || site.origin !== values.origin) throw new Error('Нужны точные HTTPS origin без завершающего / и путей. TLS-проверку отключать нельзя.');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const sockets = [];

async function request(path) {
  const response = await fetch(new URL(path, base), { headers: { Origin: site.origin }, signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200, `${path} status`);
  assert.equal(response.headers.get('access-control-allow-origin'), site.origin, 'CORS должен разрешать только origin сайта');
  return response.json();
}
async function player(join) {
  const url = new URL('/ws', base); url.protocol = 'wss:';
  const ws = new WebSocket(url, { origin: site.origin, handshakeTimeout: 120000 }); sockets.push(ws);
  let welcome;
  const queue = [], pending = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'error') { for (const p of pending.splice(0)) p.reject(new Error(message.message)); return; }
    const index = pending.findIndex(p => p.predicate(message));
    if (index >= 0) { const [p] = pending.splice(index, 1); p.resolve(message); } else { queue.push(message); if (queue.length > 40) queue.shift(); }
  });
  function wait(predicate) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i,1); reject(new Error('Таймаут игровых сообщений.')); }, 15000);
      const p = { predicate, resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } }; pending.push(p);
    });
  }
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'join', ...join }));
  welcome = await wait(x => x.type === 'welcome');
  return { ws, welcome, wait };
}

try {
  console.log('Проверка HTTPS, CORS и двух WSS-соединений. Холодный старт может занять около минуты.');
  assert.equal((await request('/health')).ok, true);
  assert.ok(Array.isArray(await request('/rooms')));
  const a = await player({ name: 'Проверка-А', tank: 'scout' });
  const b = await player({ name: 'Проверка-Б', tank: 'medium', room: a.welcome.room });
  const snapshot = await a.wait(x => x.type === 'state' && x.phase === 'playing' && x.players.length === 2);
  assert.ok(snapshot.players.some(p => p.id === b.welcome.playerId));
  const initial = snapshot.players.find(p => p.id === a.welcome.playerId);
  let seq = 0;
  const input = setInterval(() => a.ws.send(JSON.stringify({ type: 'input', seq: ++seq, forward: 1, turn: 0, aim: 0, fire: true })), 50);
  try { await a.wait(x => x.type === 'state' && x.tick > snapshot.tick && x.players.some(p => p.id === initial.id && Math.hypot(p.x - initial.x, p.z - initial.z) > .2)); }
  finally { clearInterval(input); }
  console.log(`PASS: HTTPS + exact CORS + WSS + 2 игрока + движение, комната ${a.welcome.room}.`);
  console.log('Это автоматическая проверка двух соединений. Приёмка двумя физическими устройствами через интернет пока требует отдельного прохождения docs/ACCEPTANCE.md.');
} catch (error) { console.error('FAIL:', error.message); process.exitCode = 1; }
finally { for (const ws of sockets) ws.close(); setTimeout(() => sockets.forEach(ws => ws.terminate()), 500).unref(); }
