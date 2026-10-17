import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../dist/game.js';
import { TANKS, WORLD, segmentBox, segmentCircle } from '../dist/world.js';

const input = (seq, changes = {}) => ({ seq, forward: 0, turn: 0, aim: 0, fire: false, ...changes });
function twoPlayers(options = {}) {
  const game = new Game('ABC234', options);
  game.addPlayer('a', 'Альфа', 'heavy', 0);
  game.step(0);
  assert.equal(game.phase, 'waiting');
  game.addPlayer('b', 'Браво', 'scout', 0);
  game.step(50);
  assert.equal(game.phase, 'playing');
  return game;
}

test('a round requires two humans; tank statistics and public state match the contract', () => {
  const game = twoPlayers();
  const state = game.snapshot(50);
  assert.equal(state.players.length, 2);
  assert.equal(state.players[0].maxHp, 160);
  assert.equal(state.players[1].maxHp, 75);
  assert.equal(state.remaining, 180);
  assert.equal(state.obstacles.length, 7);
  assert.equal('input' in state.players[0], false);
  assert.deepEqual(TANKS.medium, { hp: 110, speed: 7, damage: 30, cooldown: 600 });
});

test('movement is authoritative, collides with walls, buildings and tanks, and stale input stops', () => {
  const game = twoPlayers();
  const a = game.players.get('a'), b = game.players.get('b');
  Object.assign(a, { x: -10, z: -28, angle: 0 });
  Object.assign(b, { x: 34, z: 26 });
  game.setInput('a', input(1, { forward: 1 }), 100);
  game.step(100, 0.1);
  assert.equal(a.z, -27.5); // heavy speed 5 units/second
  game.step(500, 0.1);
  assert.equal(a.z, -27.5);
  Object.assign(a, { x: 0, z: 30.55, angle: 0 });
  game.setInput('a', input(2, { forward: 1 }), 550);
  game.step(550, 0.1);
  assert.ok(a.z <= WORLD.depth / 2 - WORLD.tankRadius);
  Object.assign(a, { x: 0, z: -25, angle: 0 });
  game.setInput('a', input(3, { forward: 1 }), 600);
  game.step(600, 0.1);
  game.setInput('a', input(4, { forward: 1 }), 650);
  game.step(650, 0.1);
  assert.equal(a.z, -24.5); // center building front is z=-23; radius stops at -24.4
  Object.assign(a, { x: -10, z: -28, angle: 0 });
  Object.assign(b, { x: -10, z: -25.1 });
  game.setInput('a', input(5, { forward: 1 }), 700);
  game.step(700, 0.1);
  assert.equal(a.z, -28);
});

test('shots use class cooldown and swept damage; kills, respawn, timed results and restart work', () => {
  const game = twoPlayers({ respawnMs: 150, matchDurationMs: 3_000 });
  const a = game.players.get('a'), b = game.players.get('b');
  Object.assign(a, { x: -10, z: -28, angle: 0, turret: 0 });
  Object.assign(b, { x: -10, z: -16, angle: Math.PI, turret: Math.PI });
  game.setInput('a', input(1, { fire: true }), 100);
  game.step(100);
  assert.equal(game.shells.size, 1);
  game.setInput('a', input(2, { fire: true }), 150);
  game.step(150);
  assert.equal(game.shells.size, 1, 'holding fire does not bypass the heavy cooldown');
  for (let now = 200; now <= 500; now += 50) game.step(now);
  assert.equal(b.hp, 30);
  game.setInput('a', input(3, { fire: true }), 1_100);
  game.step(1_100);
  for (let now = 1_150; now <= 1_400; now += 50) game.step(now);
  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  assert.equal(b.deaths, 1);
  game.step(1_600);
  assert.equal(b.alive, true);
  assert.equal(b.hp, 75);
  game.setConnected('b', false);
  game.step(2_050);
  assert.equal(game.phase, 'playing', 'timer continues when a player disconnects');
  game.step(3_050);
  assert.equal(game.phase, 'ended');
  assert.equal(game.remaining(), 0);
  assert.equal(game.restart(3_100), false);
  game.setConnected('b', true);
  assert.equal(game.restart(3_150), true);
  assert.equal(a.kills, 0);
  assert.equal(b.deaths, 0);
  assert.equal(game.remaining(3_150), 3);
});

test('a wall blocks a shot before a target and disconnect clears movement and trigger', () => {
  const game = twoPlayers();
  const a = game.players.get('a'), b = game.players.get('b');
  Object.assign(a, { x: 0, z: -28, angle: 0 });
  Object.assign(b, { x: 0, z: -10 });
  game.setInput('a', input(1, { forward: 1, fire: true }), 100);
  game.step(100);
  game.setConnected('a', false);
  const position = a.z;
  for (let now = 150; now < 1_000; now += 50) game.step(now);
  assert.equal(b.hp, b.maxHp);
  assert.equal(a.z, position);
  assert.equal(a.input.fire, false);
  assert.equal(game.shells.size, 0);
});

test('segment intersections hit shapes even when a fast projectile crosses them in one tick', () => {
  const a = { x: 0, z: -20 }, b = { x: 0, z: 20 };
  assert.equal(segmentBox(a, b, { x: 0, z: 0, w: 4, d: 4 }), 0.45);
  assert.equal(segmentCircle(a, b, { x: 0, z: 0 }, 2), 0.45);
  assert.equal(segmentCircle(a, b, { x: 10, z: 0 }, 2), null);
});

test('reconnecting into an occupied position moves the tank to safety without restoring damage', () => {
  const game = twoPlayers();
  const a = game.players.get('a'), b = game.players.get('b');
  Object.assign(a, { x: -10, z: -28, hp: 40 });
  game.setConnected('a', false);
  Object.assign(b, { x: a.x, z: a.z });
  game.setConnected('a', true);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= WORLD.tankRadius * 2);
  assert.equal(a.hp, 40);
  assert.equal(a.input.fire, false);
});
