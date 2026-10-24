import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { server: { type: 'string' }, origin: { type: 'string' }, full: { type: 'boolean', default: false }, directional: { type: 'boolean', default: false } } });
if (!values.server || !values.origin) {
  console.error('Usage: npm run verify:remote -- --server https://SERVICE.onrender.com --origin https://PROJECT.pages.dev [--full]');
  process.exit(1);
}
const base = new URL(values.server), site = new URL(values.origin);
if (base.protocol !== 'https:' || site.protocol !== 'https:' || base.origin !== values.server || site.origin !== values.origin) throw new Error('Нужны точные HTTPS origin без завершающего / и путей. TLS-проверку отключать нельзя.');
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { WebSocket } = require('ws');
const sockets = [], timers = new Set();
const log = message => console.log(`[${base.hostname}] ${message}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

async function request(path) {
  const response = await fetch(new URL(path, base), { headers: { Origin: site.origin }, signal: AbortSignal.timeout(120000) });
  assert.equal(response.status, 200, `${path} status`);
  assert.equal(response.headers.get('access-control-allow-origin'), site.origin, 'CORS должен разрешать только origin сайта');
  return response.json();
}
async function rejectForeignOrigin() {
  const origin = 'https://blocked-origin.invalid';
  const response = await fetch(new URL('/health', base), { headers: { Origin: origin }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.headers.get('access-control-allow-origin'), null, 'Чужой Origin не должен получать разрешение CORS.');
  const url = new URL('/ws', base); url.protocol = 'wss:';
  const ws = new WebSocket(url, { origin, handshakeTimeout: 30000 }); sockets.push(ws);
  await new Promise((resolve, reject) => {
    let rejected = false;
    ws.once('unexpected-response', (_request, res) => {
      rejected = true; res.resume(); ws.terminate();
      if (res.statusCode === 403) resolve(); else reject(new Error(`Чужой WSS Origin: ожидался 403, получен ${res.statusCode}.`));
    });
    ws.once('open', () => { ws.close(); reject(new Error('Чужой Origin смог открыть WSS.')); });
    ws.on('error', error => { if (!rejected) reject(error); });
  });
  log('PASS: чужой Origin не получает CORS и отклонён WSS со статусом 403.');
}
async function player(join) {
  const url = new URL('/ws', base); url.protocol = 'wss:';
  const ws = new WebSocket(url, { origin: site.origin, handshakeTimeout: 120000 }); sockets.push(ws);
  const queue = [], pending = [];
  let latest, failure, seq = 0;
  const rejectAll = error => { failure = error; for (const p of pending.splice(0)) p.reject(error); };
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { rejectAll(new Error('Ответ не JSON.')); return; }
    if (message.type === 'state') latest = message;
    if (message.type === 'error') { rejectAll(new Error(`${message.code}: ${message.message}`)); return; }
    let delivered = false;
    for (const p of [...pending]) if (p.predicate(message)) { pending.splice(pending.indexOf(p), 1); p.resolve(message); delivered = true; }
    if (!delivered) { queue.push(message); if (queue.length > 40) queue.shift(); }
  });
  ws.on('error', rejectAll);
  ws.on('close', (code, reason) => rejectAll(new Error(`WSS закрыт: ${code} ${reason}`)));
  function wait(predicate, timeout = 15000) {
    if (failure) return Promise.reject(failure);
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1); reject(new Error('Таймаут игровых сообщений.')); }, timeout);
      const p = { predicate, resolve: x => { clearTimeout(timer); resolve(x); }, reject: e => { clearTimeout(timer); reject(e); } }; pending.push(p);
    });
  }
  function send(message) { if (failure) throw failure; if (ws.readyState !== WebSocket.OPEN) throw new Error('WSS уже закрыт.'); ws.send(JSON.stringify(message)); }
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  send({ type: 'join', ...join });
  const welcome = await wait(x => x.type === 'welcome');
  return { ws, welcome, wait, send, get latest() { return latest; }, input(changes = {}) { send({ type: 'input', seq: ++seq, forward: 0, turn: 0, aim: 0, fire: false, ...changes }); } };
}

function clearPoint(p, obstacles, others) {
  if (Math.abs(p.x) > 38 || Math.abs(p.z) > 30) return false;
  if (others.some(o => o.alive && o.connected && distance(p, o) < 3.3)) return false;
  return !obstacles.some(o => (p.x - clamp(p.x, o.x - o.w / 2, o.x + o.w / 2)) ** 2 + (p.z - clamp(p.z, o.z - o.d / 2, o.z + o.d / 2)) ** 2 < 1.8 ** 2);
}
function clearSegment(a, b, obstacles, others) {
  const steps = Math.max(1, Math.ceil(distance(a, b) / 0.35));
  for (let i = 1; i <= steps; i++) if (!clearPoint({ x: a.x + (b.x - a.x) * i / steps, z: a.z + (b.z - a.z) * i / steps }, obstacles, others)) return false;
  return true;
}
// Test navigation only. The server still calculates all coordinates, collisions and hits.
function pathTo(start, goal, obstacles, others) {
  assert.ok(clearPoint(goal, obstacles, others), 'Контрольная точка свободна.');
  if (clearSegment(start, goal, obstacles, others)) return [goal];
  const nodes = [];
  for (let z = -30; z <= 30; z += 2) for (let x = -38; x <= 38; x += 2) if (clearPoint({ x, z }, obstacles, others)) nodes.push({ x, z });
  const key = p => `${p.x},${p.z}`, byKey = new Map(nodes.map(p => [key(p), p]));
  const closest = nodes.filter(p => clearSegment(start, p, obstacles, others)).sort((a, b) => distance(a, start) - distance(b, start))[0];
  if (!closest) throw new Error('Нет выхода из начальной позиции.');
  const open = new Set([key(closest)]), cost = new Map([[key(closest), 0]]), previous = new Map();
  let last;
  while (open.size) {
    let id, best = Infinity;
    for (const candidate of open) { const score = cost.get(candidate) + distance(byKey.get(candidate), goal); if (score < best) { id = candidate; best = score; } }
    const current = byKey.get(id); open.delete(id);
    if (distance(current, goal) < 4 && clearSegment(current, goal, obstacles, others)) { last = id; break; }
    for (const dx of [-2, 0, 2]) for (const dz of [-2, 0, 2]) {
      if (!dx && !dz) continue;
      const nextId = `${current.x + dx},${current.z + dz}`, next = byKey.get(nextId);
      if (!next || !clearSegment(current, next, obstacles, others)) continue;
      const score = cost.get(id) + Math.hypot(dx, dz);
      if (score < (cost.get(nextId) ?? Infinity)) { cost.set(nextId, score); previous.set(nextId, id); open.add(nextId); }
    }
  }
  if (!last) throw new Error('Нет безопасного пути к контрольной точке.');
  const raw = [goal]; for (let id = last; id; id = previous.get(id)) raw.unshift(byKey.get(id));
  const result = []; let current = start;
  while (raw.length) { let i = raw.length - 1; while (i > 0 && !clearSegment(current, raw[i], obstacles, others)) i--; current = raw[i]; result.push(current); raw.splice(0, i + 1); }
  return result;
}
async function navigate(peer, goal) {
  const id = peer.welcome.playerId, initial = peer.latest.players.find(p => p.id === id);
  const path = pathTo(initial, goal, peer.latest.obstacles, peer.latest.players.filter(p => p.id !== id));
  let waypoint = 0; const deadline = Date.now() + 70000;
  try {
    while (Date.now() < deadline) {
      const current = peer.latest.players.find(p => p.id === id);
      if (peer.latest.phase !== 'playing') throw new Error('Матч закончился во время движения.');
      if (distance(current, goal) < 0.5) return;
      while (waypoint < path.length - 1 && distance(current, path[waypoint]) < 0.65) waypoint++;
      const next = path[waypoint], desired = Math.atan2(next.x - current.x, next.z - current.z);
      const error = Math.atan2(Math.sin(desired - current.angle), Math.cos(desired - current.angle));
      const power = Math.min(1, distance(current, next) / 2);
      peer.input(values.directional
        ? { moveX: Math.sin(desired) * power, moveZ: Math.cos(desired) * power, aim: desired }
        : { forward: Math.abs(error) < 0.3 ? power : 0, turn: clamp(error * 1.6, -1, 1), aim: desired });
      await pause(50);
    }
    const current = peer.latest.players.find(p => p.id === id);
    throw new Error(`Таймаут движения к ${JSON.stringify(goal)}, позиция ${current.x},${current.z}, путь ${JSON.stringify(path.slice(waypoint))}`);
  } finally { peer.input(); }
}

try {
  log('Проверка HTTPS, CORS и двух WSS-соединений. Холодный старт может занять около минуты.');
  assert.equal((await request('/health')).ok, true);
  assert.ok(Array.isArray(await request('/rooms')));
  await rejectForeignOrigin();
  const a = await player({ name: 'Проверка-А', tank: values.full ? 'heavy' : 'scout' });
  if (values.directional) {
    const waiting = await a.wait(x => x.type === 'state' && x.phase === 'waiting');
    const initial = waiting.players.find(p => p.id === a.welcome.playerId);
    assert.equal(typeof initial.reloadIn, 'number', 'Нужен обновлённый сервер с перезарядкой.');
    const warmup = setInterval(() => a.input({ moveX: 0, moveZ: -0.45, aim: 0, fire: true }), 50); timers.add(warmup);
    try {
      await a.wait(x => x.type === 'state' && x.phase === 'waiting' && x.players.some(p => p.id === initial.id && p.z < initial.z - 0.2));
      await a.wait(x => x.type === 'state' && x.phase === 'waiting' && x.players.some(p => p.id === initial.id && p.reloadIn > 0));
    } finally { clearInterval(warmup); timers.delete(warmup); a.input(); }
    log('PASS: экранное направление, медленный ход и стрельба в одиночной разминке, серверная перезарядка.');
  }
  const b = await player({ name: 'Проверка-Б', tank: values.full ? 'scout' : 'medium', room: a.welcome.room });
  const snapshot = await a.wait(x => x.type === 'state' && x.phase === 'playing' && x.players.length === 2);
  await b.wait(x => x.type === 'state' && x.phase === 'playing' && x.players.length === 2);
  assert.ok(snapshot.players.some(p => p.id === b.welcome.playerId));
  log(`PASS: HTTPS + exact CORS + WSS + 2 игрока; новая комната ${a.welcome.room}.`);
  if (!values.full) {
    const initial = snapshot.players.find(p => p.id === a.welcome.playerId);
    const input = setInterval(() => a.input({ forward: 1, aim: initial.angle }), 50); timers.add(input);
    try { await a.wait(x => x.type === 'state' && x.tick > snapshot.tick && x.players.some(p => p.id === initial.id && distance(p, initial) > 0.2)); }
    finally { clearInterval(input); timers.delete(input); a.input(); }
    log('PASS: серверное движение. Для полной проверки используйте --full.');
  } else {
    await navigate(a, { x: -10, z: -28 }); log('PASS: первый игрок доехал к огневому рубежу через карту.');
    await navigate(b, { x: -10, z: -17 }); log('PASS: второй игрок доехал к цели.');
    const fireTick = a.latest.tick;
    const fire = setInterval(() => {
      const current = a.latest.players.find(p => p.id === a.welcome.playerId), target = a.latest.players.find(p => p.id === b.welcome.playerId);
      a.input({ aim: Math.atan2(target.x - current.x, target.z - current.z), fire: true });
    }, 50); timers.add(fire);
    let dead;
    try {
      const checks = await Promise.all([
        a.wait(x => x.type === 'state' && x.tick > fireTick && x.shells.length > 0),
        b.wait(x => x.type === 'state' && x.tick > fireTick && x.players.some(p => p.id === b.welcome.playerId && p.hp > 0 && p.hp < p.maxHp)),
        b.wait(x => x.type === 'state' && x.tick > fireTick && x.players.some(p => p.id === b.welcome.playerId && !p.alive && p.deaths === 1)),
      ]); dead = checks[2];
    } finally { clearInterval(fire); timers.delete(fire); a.input(); }
    assert.equal(dead.players.find(p => p.id === a.welcome.playerId).kills, 1);
    log('PASS: снаряд, серверный урон, уничтожение, 1 убийство и 1 смерть.');
    const respawned = await b.wait(x => x.type === 'state' && x.tick > dead.tick && x.players.some(p => p.id === b.welcome.playerId && p.alive && p.hp === p.maxHp && p.deaths === 1));
    assert.equal(respawned.players.find(p => p.id === b.welcome.playerId).hp, 75);
    log('PASS: возрождение с полным здоровьем; ожидаем естественное завершение трёхминутного матча.');
    const progress = setInterval(() => log(`До результатов: ${a.latest.remaining} с.`), 30000); timers.add(progress);
    let ended;
    try { ended = await a.wait(x => x.type === 'state' && x.phase === 'ended', (a.latest.remaining + 15) * 1000); }
    finally { clearInterval(progress); timers.delete(progress); }
    const shared = await b.wait(x => x.type === 'state' && x.phase === 'ended');
    assert.equal(ended.remaining, 0);
    const scores = x => x.players.map(p => ({ id: p.id, kills: p.kills, deaths: p.deaths })).sort((l, r) => l.id.localeCompare(r.id));
    assert.deepEqual(scores(ended), scores(shared));
    assert.equal(ended.players.find(p => p.id === a.welcome.playerId).kills, 1);
    assert.equal(ended.players.find(p => p.id === b.welcome.playerId).deaths, 1);
    a.send({ type: 'restart' });
    const restarted = await a.wait(x => x.type === 'state' && x.tick >= ended.tick && x.phase === 'playing' && x.players.every(p => p.kills === 0 && p.deaths === 0));
    assert.ok(restarted.remaining >= 175);
    log('PASS FULL: движение обоих игроков, стрельба, урон, смерть, возрождение, таймер, общие результаты и новый раунд.');
  }
  log('Это временные автоматические клиенты. Приёмка двумя физическими устройствами требует отдельного прохождения docs/ACCEPTANCE.md.');
} catch (error) { log(`FAIL: ${error.message}`); process.exitCode = 1; }
finally {
  for (const timer of timers) clearInterval(timer);
  for (const ws of sockets) ws.close();
  await pause(500);
  for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  log('Все проверочные WSS-клиенты закрыты.');
}
