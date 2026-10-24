import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/network.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { Connection } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function transport(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  globalThis.WebSocket = class { static OPEN = 1; };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'WebSocket', previous);
    else delete globalThis.WebSocket;
  });
  const sent = [];
  const socket = { readyState: 1, bufferedAmount: 0, send: value => sent.push(JSON.parse(value)) };
  // Isolate the send boundary without opening a network connection or timers.
  const connection = Object.create(Connection.prototype);
  connection.ready = true;
  connection.ws = socket;
  return { connection, socket, sent };
}

test('commands require a joined session and an open socket', t => {
  const h = transport(t);
  h.connection.ready = false;
  h.connection.send({ type: 'input', seq: 1 });
  h.connection.send({ type: 'ping', id: 1 });
  h.connection.ready = true;
  h.socket.readyState = 0;
  h.connection.send({ type: 'input', seq: 2 });
  h.socket.readyState = 3;
  h.connection.send({ type: 'ping', id: 2 });
  assert.deepEqual(h.sent, []);
  h.socket.readyState = 1;
  h.connection.send({ type: 'input', seq: 3, fire: false });
  assert.deepEqual(h.sent, [{ type: 'input', seq: 3, fire: false }]);
});

test('congested controls are discarded; recovery sends only a fresh input', async t => {
  const h = transport(t);
  h.socket.bufferedAmount = 1000;
  h.connection.send({ type: 'input', seq: 1, moveX: 1, fire: true });
  h.socket.bufferedAmount = 1;
  h.connection.send({ type: 'input', seq: 2, moveX: -1, fire: true });
  assert.deepEqual(h.sent, []);
  h.socket.bufferedAmount = 0;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.sent, [], 'draining must not replay controls that are already out of date');
  h.connection.send({ type: 'input', seq: 3, moveX: 0, fire: false });
  assert.deepEqual(h.sent, [{ type: 'input', seq: 3, moveX: 0, fire: false }]);
});

test('ping and other control messages keep the bounded 32 KiB transport limit', t => {
  const h = transport(t);
  h.socket.bufferedAmount = 1;
  h.connection.send({ type: 'input', seq: 1 });
  h.connection.send({ type: 'ping', id: 1 });
  h.socket.bufferedAmount = 32767;
  h.connection.send({ type: 'restart' });
  h.socket.bufferedAmount = 32768;
  h.connection.send({ type: 'ping', id: 2 });
  h.connection.send({ type: 'restart' });
  h.socket.bufferedAmount = 50000;
  h.connection.send({ type: 'ping', id: 3 });
  assert.deepEqual(h.sent, [{ type: 'ping', id: 1 }, { type: 'restart' }]);
});
