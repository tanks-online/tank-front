import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/mobile.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { MobileControls } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

class ClassList {
  names = new Set();
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  contains(name) { return this.names.has(name); }
}

class Element extends EventTarget {
  classList = new ClassList();
  captures = new Set();
  style = {};
  attributes = new Map();
  constructor(left, width, scale) {
    super();
    this.offsetWidth = width;
    this.rect = { left, top: 20, width: width * scale, height: width * scale };
  }
  getBoundingClientRect() { return this.rect; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    this.captures.delete(id);
    const event = new Event('lostpointercapture');
    Object.assign(event, { pointerId: id });
    this.dispatchEvent(event);
  }
}

function controls(t, { rotated = false, scale = 1 } = {}) {
  const previous = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
  const pads = { move: new Element(20, 120, scale), aim: new Element(300, 120, scale) };
  const knobs = { move: new Element(0, 48, scale), aim: new Element(0, 48, scale) };
  const document = new EventTarget();
  document.hidden = false;
  document.body = { classList: new ClassList() };
  if (rotated) document.body.classList.add('phone-rotated');
  document.getElementById = id => ({ 'move-pad': pads.move, 'aim-pad': pads.aim, 'move-knob': knobs.move, 'aim-knob': knobs.aim })[id];
  const window = new EventTarget();
  Object.assign(globalThis, { document, window });
  let input = { moveX: 0, moveZ: 0, fire: false };
  let updates = 0;
  const controller = new MobileControls(value => { input = value; updates++; });
  controller.setEnabled(true);
  t.after(() => {
    controller.destroy();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    controller, document, window, pads, knobs,
    get input() { return input; },
    get updates() { return updates; },
    pointer(side, type, pointerId, dx = 0, dy = 0) {
      const rect = pads[side].getBoundingClientRect();
      const event = new Event(type, { cancelable: true });
      Object.assign(event, {
        pointerId, button: 0,
        clientX: rect.left + rect.width / 2 + dx,
        clientY: rect.top + rect.height / 2 + dy,
      });
      pads[side].dispatchEvent(event);
    },
  };
}

test('two fingers move and fire together; lifting either finger preserves the other', t => {
  const h = controls(t);
  h.pointer('move', 'pointerdown', 1, 36, 0);
  h.pointer('aim', 'pointerdown', 2, 0, -36);
  assert.equal(h.input.moveX, 1);
  assert.equal(h.input.fire, true);
  assert.equal(h.input.aim, Math.PI);
  h.pointer('move', 'pointerup', 1);
  assert.equal(h.input.moveX, 0);
  assert.equal(h.input.fire, true);
  h.pointer('move', 'pointerdown', 3, -36, 0);
  h.pointer('aim', 'pointerup', 2);
  assert.equal(h.input.moveX, -1);
  assert.equal(h.input.fire, false);
  assert.equal(h.input.aim, Math.PI, 'turret retains its aim when the fire finger is lifted');
});

test('another finger cannot steal an occupied pad or own both pads', t => {
  const h = controls(t);
  h.pointer('move', 'pointerdown', 1, 36, 0);
  h.pointer('move', 'pointerdown', 2, -36, 0);
  h.pointer('move', 'pointermove', 2, -36, 0);
  h.pointer('move', 'pointerup', 2);
  assert.equal(h.input.moveX, 1);
  h.pointer('aim', 'pointerdown', 1, 36, 0);
  assert.equal(h.input.fire, false);
  h.pointer('aim', 'pointerdown', 3);
  assert.equal(h.input.fire, true, 'holding the center fires without requiring a drag');
});

test('ordinary reset retains turret direction; a new session clears and emits it', t => {
  const h = controls(t);
  h.pointer('aim', 'pointerdown', 1, 36, 0);
  h.pointer('aim', 'pointerup', 1);
  h.controller.reset();
  assert.equal(h.input.aim, Math.PI / 2);
  const updates = h.updates;
  h.controller.reset(true);
  assert.equal(h.input.aim, undefined);
  assert.equal(Object.hasOwn(h.input, 'aim'), false);
  assert.equal(h.updates, updates + 1, 'the new session receives the cleared aim even with both sticks already released');
  assert.equal(h.input.moveX, 0);
  assert.equal(h.input.moveZ, 0);
  assert.equal(h.input.fire, false);
});

test('pointer cancellation and lost capture stop only the affected control', t => {
  const h = controls(t);
  h.pointer('move', 'pointerdown', 1, 36, 0);
  h.pointer('aim', 'pointerdown', 2);
  h.pointer('aim', 'pointercancel', 2);
  assert.equal(h.input.fire, false);
  assert.equal(h.input.moveX, 1);
  h.pointer('aim', 'pointerdown', 3);
  h.pads.move.releasePointerCapture(1);
  assert.equal(h.input.moveX, 0);
  assert.equal(h.input.fire, true);
});

for (const trigger of ['disable', 'blur', 'hidden', 'reset']) {
  test(`${trigger} stops movement and fire and releases both fingers`, t => {
    const h = controls(t);
    h.pointer('move', 'pointerdown', 1, 36, 0);
    h.pointer('aim', 'pointerdown', 2);
    if (trigger === 'disable') h.controller.setEnabled(false);
    if (trigger === 'blur') h.window.dispatchEvent(new Event('blur'));
    if (trigger === 'hidden') { h.document.hidden = true; h.document.dispatchEvent(new Event('visibilitychange')); }
    if (trigger === 'reset') h.controller.reset();
    assert.equal(h.input.moveX, 0);
    assert.equal(h.input.moveZ, 0);
    assert.equal(h.input.fire, false);
    assert.equal(h.pads.move.captures.size, 0);
    assert.equal(h.pads.aim.captures.size, 0);
    h.pointer('move', 'pointermove', 1, 36, 0);
    h.pointer('aim', 'pointermove', 2, 36, 0);
    assert.equal(h.input.moveX, 0, 'a cancelled touch must be lifted and pressed again');
    assert.equal(h.input.fire, false);
  });
}

test('movement has a deadzone, analog speed and a circular diagonal limit', t => {
  const h = controls(t);
  h.pointer('move', 'pointerdown', 1, 2, 0);
  assert.equal(h.input.moveX, 0);
  h.pointer('move', 'pointermove', 1, 18, 0);
  assert.ok(h.input.moveX > 0.3 && h.input.moveX < 0.5);
  h.pointer('move', 'pointermove', 1, 100, 100);
  assert.ok(Math.abs(Math.hypot(h.input.moveX, h.input.moveZ) - 1) < 1e-12);
});

test('scaled controls use their visible coordinates and keep the knob inside the pad', t => {
  const h = controls(t, { scale: 0.5 });
  h.pointer('move', 'pointerdown', 1, 18, 0);
  assert.equal(h.input.moveX, 1);
  assert.equal(h.knobs.move.style.transform, 'translate(-50%, -50%) translate(36px, 0px)');
});

test('portrait CSS rotation maps touches back to the same game movement and aim', t => {
  const h = controls(t, { rotated: true });
  h.pointer('move', 'pointerdown', 1, 0, 36);
  assert.equal(h.input.moveX, 1, 'screen-down points to game-right after clockwise rotation');
  assert.equal(h.input.moveZ, 0);
  h.pointer('move', 'pointermove', 1, -36, 0);
  assert.equal(h.input.moveX, 0);
  assert.equal(h.input.moveZ, 1, 'screen-left points to game-down after clockwise rotation');
  h.pointer('aim', 'pointerdown', 2, 36, 0);
  assert.equal(h.input.fire, true);
  assert.equal(h.input.aim, Math.PI);
});
