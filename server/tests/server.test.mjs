import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGameServer } from '../dist/server.js';
import { readConfig } from '../dist/config.js';

const ORIGIN = 'https://tank-example.github.io';
function client(url, origin = ORIGIN) {
  const socket = new WebSocket(url, origin === undefined ? {} : { origin });
  const pending = [], frames = [];
  socket.on('message', data => {
    const value = JSON.parse(data.toString());
    const waiter = pending.find(item => item.predicate(value));
    if (waiter) { pending.splice(pending.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(value); }
    else frames.push(value);
  });
  return {
    socket,
    open: () => once(socket, 'open'),
    send: value => socket.send(JSON.stringify(value)),
    next(predicate, timeout = 2_000) {
      const index = frames.findIndex(predicate);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          pending.splice(pending.indexOf(waiter), 1);
          reject(new Error('Timed out waiting for server frame'));
        }, timeout) };
        pending.push(waiter);
      });
    },
    async close(code = 1000, reason = '') { if (socket.readyState < WebSocket.CLOSING) { socket.close(code, reason); await once(socket, 'close'); } },
  };
}
async function setup(t, options = {}) {
  const app = createGameServer({ port: 0, host: '127.0.0.1', allowedOrigins: [ORIGIN], ...options });
  const address = await app.listen();
  t.after(() => app.close());
  return { app, url: `ws://127.0.0.1:${address.port}/ws`, http: `http://127.0.0.1:${address.port}` };
}
async function joined(url, room, extra = {}) {
  const peer = client(url);
  await peer.open();
  peer.send({ type: 'join', name: 'Танкист', tank: 'scout', ...(room ? { room } : {}), ...extra });
  const welcome = await peer.next(data => data.type === 'welcome');
  return { peer, welcome };
}

test('HTTP health and rooms support only allowlisted browser CORS', async t => {
  const { url, http } = await setup(t);
  const health = await fetch(`${http}/health`, { headers: { Origin: ORIGIN } });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await health.json()).ok, true);
  const forbidden = await fetch(`${http}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(forbidden.headers.get('access-control-allow-origin'), null);
  const { peer, welcome } = await joined(url);
  const rooms = await (await fetch(`${http}/rooms`)).json();
  assert.equal(rooms[0].id, welcome.room);
  assert.equal(rooms[0].players, 1);
  assert.equal(rooms[0].capacity, 8);
  await peer.close();
});

test('two clients see the same room, move, ping and resume identity without a second tank', async t => {
  const { url } = await setup(t);
  const { peer: a, welcome } = await joined(url);
  const { peer: b } = await joined(url, welcome.room, { name: 'Второй', tank: 'medium' });
  const initial = await a.next(data => data.type === 'state' && data.phase === 'playing');
  assert.equal(initial.players.length, 2);
  const player = initial.players.find(p => p.id === welcome.playerId);
  a.send({ type: 'input', seq: 1, forward: 1, turn: 0, aim: player.angle, fire: false });
  const moved = await a.next(data => data.type === 'state' && data.phase === 'playing' && data.tick > initial.tick && data.players.some(p => p.id === player.id && Math.hypot(p.x - player.x, p.z - player.z) > 0.01));
  assert.equal(moved.phase, 'playing');
  a.send({ type: 'ping', id: 17 });
  assert.deepEqual(await a.next(data => data.type === 'pong'), { type: 'pong', id: 17 });
  await a.close();
  await b.next(data => data.type === 'state' && data.players.some(p => p.id === welcome.playerId && !p.connected));
  const { peer: resumed, welcome: nextWelcome } = await joined(url, welcome.room, { resumeToken: welcome.resumeToken });
  assert.equal(nextWelcome.playerId, welcome.playerId);
  assert.equal(nextWelcome.resumeToken, welcome.resumeToken);
  const state = await resumed.next(data => data.type === 'state' && data.players.length === 2);
  assert.equal(state.players.filter(p => p.id === welcome.playerId).length, 1);
  await resumed.close();
  await b.close();
});

test('a full room and unknown room return clear protocol errors', async t => {
  const { url } = await setup(t, { roomCapacity: 2 });
  const { peer: a, welcome } = await joined(url);
  const { peer: b } = await joined(url, welcome.room);
  const c = client(url); await c.open();
  c.send({ type: 'join', room: welcome.room, name: 'Третий', tank: 'heavy' });
  assert.equal((await c.next(data => data.type === 'error')).code, 'ROOM_FULL');
  c.send({ type: 'join', room: 'AAAAAA', name: 'Третий', tank: 'heavy' });
  assert.equal((await c.next(data => data.type === 'error')).code, 'ROOM_NOT_FOUND');
  await c.close(); await b.close(); await a.close();
});

test('eight human sessions can play; a ninth is rejected, including during disconnect reservation', async t => {
  const { url } = await setup(t);
  const first = await joined(url);
  const players = [first];
  for (let index = 1; index < 8; index++) {
    players.push(await joined(url, first.welcome.room, { name: `Игрок ${index + 1}`, tank: ['scout', 'medium', 'heavy'][index % 3] }));
  }
  const full = await first.peer.next(data => data.type === 'state' && data.phase === 'playing' && data.players.filter(p => p.connected).length === 8);
  assert.equal(new Set(full.players.map(p => p.id)).size, 8);
  const ninth = client(url); await ninth.open();
  ninth.send({ type: 'join', room: first.welcome.room, name: 'Девятый', tank: 'heavy' });
  assert.equal((await ninth.next(data => data.type === 'error')).code, 'ROOM_FULL');
  const disconnected = players.pop();
  await disconnected.peer.close();
  ninth.send({ type: 'join', room: first.welcome.room, name: 'Девятый', tank: 'heavy' });
  assert.equal((await ninth.next(data => data.type === 'error')).code, 'ROOM_FULL');
  const resumed = await joined(url, first.welcome.room, { resumeToken: disconnected.welcome.resumeToken });
  assert.equal(resumed.welcome.playerId, disconnected.welcome.playerId);
  const restored = await resumed.peer.next(data => data.type === 'state' && data.players.filter(p => p.connected).length === 8);
  assert.equal(restored.players.length, 8);
  await ninth.close();
  await resumed.peer.close();
  await Promise.all(players.map(player => player.peer.close()));
});

test('quick play fills a room with humans, then creates another instead of rejecting the ninth', async t => {
  const { app, url } = await setup(t);
  const first = await joined(url, undefined, { quickPlay: true });
  const players = [first];
  const second = await joined(url, undefined, { quickPlay: true, name: 'Второй' });
  players.push(second);
  assert.equal(second.welcome.room, first.welcome.room);
  for (let index = 2; index < 8; index++) {
    const next = await joined(url, undefined, { quickPlay: true, name: `Игрок ${index + 1}` });
    players.push(next);
    assert.equal(next.welcome.room, first.welcome.room);
  }
  const ninth = await joined(url, undefined, { quickPlay: true, name: 'Девятый' });
  players.push(ninth);
  assert.notEqual(ninth.welcome.room, first.welcome.room);
  assert.equal(app.rooms.size, 2);
  assert.equal(app.rooms.get(first.welcome.room).game.connectedCount(), 8);
  assert.equal(app.rooms.get(ninth.welcome.room).game.connectedCount(), 1);
  await Promise.all(players.map(player => player.peer.close()));
});

test('quick play prefers a populated room and skips ended or nearly finished rounds', async t => {
  const { app, url } = await setup(t);
  const a = await joined(url);
  const b = await joined(url, a.welcome.room);
  const c = await joined(url);
  const d = await joined(url, undefined, { quickPlay: true });
  assert.equal(d.welcome.room, a.welcome.room, 'prefer the room with two connected players');
  const firstGame = app.rooms.get(a.welcome.room).game;
  firstGame.phase = 'playing';
  firstGame.startedAt = Date.now() - firstGame.duration + 4_000;
  const e = await joined(url, undefined, { quickPlay: true });
  assert.equal(e.welcome.room, c.welcome.room, 'do not drop a player into the last seconds of a round');
  firstGame.phase = 'ended';
  app.rooms.get(c.welcome.room).game.phase = 'ended';
  const f = await joined(url, undefined, { quickPlay: true });
  assert.notEqual(f.welcome.room, a.welcome.room);
  assert.notEqual(f.welcome.room, c.welcome.room);
  await Promise.all([a, b, c, d, e, f].map(player => player.peer.close()));
});

test('quickPlay requires a boolean and cannot be combined with an explicit invite room', async t => {
  const { url } = await setup(t);
  const peer = client(url); await peer.open();
  peer.send({ type: 'join', name: 'А', tank: 'scout', quickPlay: 'yes' });
  assert.equal((await peer.next(data => data.type === 'error')).code, 'BAD_MESSAGE');
  peer.send({ type: 'join', name: 'А', tank: 'scout', quickPlay: true, room: 'ABC234' });
  assert.equal((await peer.next(data => data.type === 'error')).code, 'BAD_MESSAGE');
  await peer.close();
});

test('WebSocket fire reaches authoritative damage, respawn and shared end-of-round results', async t => {
  const { app, url } = await setup(t, { gameOptions: { matchDurationMs: 1_800, respawnMs: 200 } });
  const { peer: a, welcome: attacker } = await joined(url, undefined, { tank: 'heavy' });
  const { peer: b, welcome: victim } = await joined(url, attacker.room, { tank: 'scout' });
  await a.next(data => data.type === 'state' && data.phase === 'playing');
  const game = app.rooms.get(attacker.room).game;
  Object.assign(game.players.get(attacker.playerId), { x: -10, z: -28, angle: 0, turret: 0 });
  Object.assign(game.players.get(victim.playerId), { x: -10, z: -24, angle: Math.PI, turret: Math.PI });
  let seq = 0;
  const trigger = setInterval(() => a.send({ type: 'input', seq: ++seq, forward: 0, turn: 0, aim: 0, fire: true }), 40);
  t.after(() => clearInterval(trigger));
  await b.next(data => data.type === 'state' && data.players.some(p => p.id === victim.playerId && p.hp === 30));
  const dead = await b.next(data => data.type === 'state' && data.players.some(p => p.id === victim.playerId && !p.alive));
  assert.equal(dead.players.find(p => p.id === attacker.playerId).kills, 1);
  const respawned = await b.next(data => data.type === 'state' && data.tick > dead.tick && data.players.some(p => p.id === victim.playerId && p.alive && p.hp === 75));
  assert.equal(respawned.players.find(p => p.id === victim.playerId).deaths, 1);
  const ended = await b.next(data => data.type === 'state' && data.phase === 'ended');
  clearInterval(trigger);
  assert.equal(ended.remaining, 0);
  assert.equal(ended.players.find(p => p.id === attacker.playerId).kills, 1);
  const shared = await a.next(data => data.type === 'state' && data.phase === 'ended');
  assert.deepEqual(shared.players.map(p => [p.id, p.kills, p.deaths]), ended.players.map(p => [p.id, p.kills, p.deaths]));
  await a.close(); await b.close();
});

test('invalid and missing origins cannot complete WebSocket upgrade', async t => {
  const { url } = await setup(t);
  for (const options of [{ origin: 'https://evil.example' }, {}]) {
    const socket = new WebSocket(url, options);
    const status = await new Promise(resolve => {
      socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); socket.terminate(); });
      socket.on('error', () => {});
    });
    assert.equal(status, 403);
  }
});

test('malformed input, prototype tank names, rate and oversized payload are bounded', async t => {
  const { url } = await setup(t);
  const peer = client(url); await peer.open();
  peer.send({ type: 'join', name: 'А', tank: 'constructor' });
  assert.equal((await peer.next(data => data.type === 'error')).code, 'BAD_MESSAGE');
  peer.socket.send('{bad json');
  assert.equal((await peer.next(data => data.type === 'error')).code, 'BAD_MESSAGE');
  peer.send({ type: 'join', name: 'А', tank: 'heavy' });
  await peer.next(data => data.type === 'welcome');
  peer.send({ type: 'input', seq: 1, forward: 500, turn: 0, aim: 0, fire: true });
  assert.equal((await peer.next(data => data.type === 'error')).code, 'BAD_MESSAGE');
  for (let i = 0; i < 65; i++) peer.send({ type: 'ping', id: i });
  assert.equal((await peer.next(data => data.code === 'RATE_LIMIT')).code, 'RATE_LIMIT');
  await peer.close();
  const oversized = client(url); await oversized.open();
  const closed = once(oversized.socket, 'close');
  oversized.socket.send('x'.repeat(1_025));
  const [code] = await closed;
  assert.equal(code, 1009);
});

test('expired reservations and empty rooms release bounded capacity', async t => {
  const { app, url } = await setup(t, { reconnectGraceMs: 50, idleRoomMs: 100, maxRooms: 1 });
  const { peer, welcome } = await joined(url);
  await peer.close();
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(app.rooms.size, 0);
  const expired = client(url); await expired.open();
  expired.send({ type: 'join', room: welcome.room, resumeToken: welcome.resumeToken, name: 'А', tank: 'heavy' });
  assert.equal((await expired.next(data => data.type === 'error')).code, 'SESSION_EXPIRED');
  await expired.close();
  const { peer: fresh } = await joined(url);
  await fresh.close();
});

test('explicit Leaving immediately releases the session and room for the next play', async t => {
  const { app, url, http } = await setup(t, { maxRooms: 1 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { peer } = await joined(url, undefined, { quickPlay: true });
    assert.equal(app.rooms.size, 1);
    // Local close can complete before the peer has observed TCP shutdown.
    const serverClosed = once([...app.wss.clients][0], 'close');
    await peer.close(1000, 'Leaving');
    await serverClosed;
    const health = await (await fetch(`${http}/health`)).json();
    assert.equal(health.rooms, 0, 'an intentional exit leaves no empty room occupying capacity');
    assert.equal(health.players, 0, 'an intentional exit leaves no reserved session');
  }
  const { peer } = await joined(url);
  await peer.close(1000, 'Leaving');
});

test('production configuration fails closed and hosting PORT takes precedence', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production' }), /ALLOWED_ORIGINS/);
  assert.throws(() => readConfig({ PORT: '0' }), /PORT/);
  assert.throws(() => readConfig({ ALLOWED_ORIGINS: 'https://name.github.io/repo/' }), /ALLOWED_ORIGINS/);
  assert.throws(() => readConfig({ ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS/);
  assert.equal(readConfig({ PORT: '4000', SERVER_PORT: '5000', ALLOWED_ORIGINS: ORIGIN }).port, 4000);
  assert.equal(readConfig({ SERVER_PORT: '5000' }).port, 5000);
  assert.equal(readConfig({}).host, '0.0.0.0');
});
