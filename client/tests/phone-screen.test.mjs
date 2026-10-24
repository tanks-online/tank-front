import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/phone-screen.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { PhoneScreen } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class TrackedEvents extends EventTarget {
  listeners = new Map();
  addEventListener(type, listener, options) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(listener);
    this.listeners.set(type, handlers);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0); }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function screen(t, { native = false } = {}) {
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  };
  const classes = new Set();
  const document = new TrackedEvents();
  const orientation = new TrackedEvents();
  const viewport = new TrackedEvents();
  const window = new TrackedEvents();
  const calls = { fullscreen: 0, exit: 0, lock: 0, unlock: 0, layout: 0 };
  document.body = {
    classList: {
      contains: name => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
  };
  document.documentElement = {};
  document.fullscreenElement = null;
  Object.assign(window, { innerWidth: 390, innerHeight: 844, screen: { orientation }, visualViewport: viewport });
  if (native) {
    document.documentElement.requestFullscreen = async () => {
      calls.fullscreen++;
      document.fullscreenElement = document.documentElement;
    };
    document.exitFullscreen = async () => { calls.exit++; document.fullscreenElement = null; };
    orientation.lock = async value => { calls.lock++; assert.equal(value, 'landscape'); };
    orientation.unlock = () => { calls.unlock++; };
  }
  Object.assign(globalThis, { document, window });
  const controller = new PhoneScreen(() => { calls.layout++; });
  t.after(() => {
    controller.destroy();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    controller, document, window, orientation, viewport, calls,
    get rotated() { return classes.has('phone-rotated'); },
    emit(target, type) { target.dispatchEvent(new Event(type)); },
  };
}

test('portrait uses the CSS fallback without native APIs and only reports actual layout changes', async t => {
  const h = screen(t);
  h.controller.setActive(true);
  assert.equal(h.rotated, true);
  assert.equal(h.calls.layout, 1);
  h.controller.setActive(true);
  h.emit(h.window, 'resize');
  h.emit(h.viewport, 'resize');
  h.emit(h.window, 'orientationchange');
  h.emit(h.orientation, 'change');
  h.emit(h.document, 'fullscreenchange');
  await h.controller.enterLandscape();
  assert.equal(h.rotated, true);
  assert.equal(h.calls.layout, 1, 'browser events must not repeatedly reset controls');
  h.window.innerWidth = 844;
  h.window.innerHeight = 390;
  h.emit(h.orientation, 'change');
  assert.equal(h.rotated, false);
  assert.equal(h.calls.layout, 2);
  h.controller.setActive(false);
  h.window.innerWidth = 390;
  h.window.innerHeight = 844;
  h.emit(h.window, 'resize');
  assert.equal(h.rotated, false, 'the menu and PC mode must never be rotated');
  assert.equal(h.calls.layout, 2);
});

test('native fullscreen and landscape locks owned by the controller are released on leaving', async t => {
  const h = screen(t, { native: true });
  h.controller.setActive(true);
  await h.controller.enterLandscape();
  assert.equal(h.calls.fullscreen, 1);
  assert.equal(h.calls.lock, 1);
  assert.equal(h.document.fullscreenElement, h.document.documentElement);
  h.controller.setActive(false);
  assert.equal(h.calls.exit, 1);
  assert.equal(h.calls.unlock, 1);
  assert.equal(h.rotated, false);
  h.controller.setActive(false);
  h.controller.destroy();
  assert.equal(h.calls.exit, 1, 'cleanup must be idempotent');
  assert.equal(h.calls.unlock, 1);
});

test('a fullscreen request that finishes after leaving is closed without a late orientation lock', async t => {
  const h = screen(t, { native: true });
  const pending = deferred();
  h.document.documentElement.requestFullscreen = () => {
    h.calls.fullscreen++;
    return pending.promise.then(() => { h.document.fullscreenElement = h.document.documentElement; });
  };
  h.controller.setActive(true);
  const entering = h.controller.enterLandscape();
  h.controller.setActive(false);
  pending.resolve();
  await entering;
  assert.equal(h.calls.fullscreen, 1);
  assert.equal(h.calls.lock, 0);
  assert.equal(h.calls.exit, 1);
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.rotated, false);
});

test('an orientation lock that resolves after leaving is unlocked', async t => {
  const h = screen(t, { native: true });
  const pending = deferred();
  h.orientation.lock = () => { h.calls.lock++; return pending.promise; };
  h.controller.setActive(true);
  const entering = h.controller.enterLandscape();
  await Promise.resolve();
  assert.equal(h.calls.lock, 1);
  h.controller.setActive(false);
  pending.resolve();
  await entering;
  assert.equal(h.calls.unlock, 1);
  assert.equal(h.calls.exit, 1);
});

test('leaving never exits an existing or replacement fullscreen session owned elsewhere', async t => {
  const h = screen(t, { native: true });
  const foreign = {};
  h.document.fullscreenElement = foreign;
  h.controller.setActive(true);
  await h.controller.enterLandscape();
  h.controller.setActive(false);
  assert.equal(h.calls.fullscreen, 0);
  assert.equal(h.calls.exit, 0);
  assert.equal(h.document.fullscreenElement, foreign);
  assert.equal(h.calls.unlock, 1, 'only the orientation lock requested here is released');

  h.document.fullscreenElement = null;
  h.controller.setActive(true);
  await h.controller.enterLandscape();
  h.document.fullscreenElement = foreign;
  h.emit(h.document, 'fullscreenchange');
  h.controller.setActive(false);
  assert.equal(h.calls.fullscreen, 1);
  assert.equal(h.calls.exit, 0);
  assert.equal(h.document.fullscreenElement, foreign);
});

test('rejected fullscreen and orientation APIs keep the CSS fallback usable', async t => {
  const h = screen(t, { native: true });
  h.document.documentElement.requestFullscreen = async () => { throw new Error('Fullscreen unavailable'); };
  h.orientation.lock = async () => { throw new Error('Orientation lock unavailable'); };
  h.controller.setActive(true);
  await h.controller.enterLandscape();
  assert.equal(h.rotated, true);
  assert.equal(h.calls.exit, 0);
  assert.equal(h.calls.unlock, 0);
});

test('destroy removes every viewport listener and prevents later activation', async t => {
  const h = screen(t, { native: true });
  const targets = [h.window, h.viewport, h.orientation, h.document];
  assert.equal(targets.reduce((count, target) => count + target.listenerCount, 0), 5);
  h.controller.setActive(true);
  h.controller.setActive(true);
  assert.equal(targets.reduce((count, target) => count + target.listenerCount, 0), 5);
  h.controller.destroy();
  assert.equal(targets.reduce((count, target) => count + target.listenerCount, 0), 0);
  const layouts = h.calls.layout;
  h.controller.setActive(true);
  await h.controller.enterLandscape();
  h.emit(h.window, 'resize');
  h.emit(h.viewport, 'resize');
  h.emit(h.orientation, 'change');
  h.emit(h.document, 'fullscreenchange');
  assert.equal(h.rotated, false);
  assert.equal(h.calls.layout, layouts);
  assert.equal(h.calls.fullscreen, 0);
});
