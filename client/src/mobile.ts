export interface MobileInput {
  moveX: number;
  moveZ: number;
  aim?: number;
  fire: boolean;
}

type PadSide = 'move' | 'aim';
interface Pad {
  side: PadSide;
  element: HTMLElement;
  knob: HTMLElement;
  pointerId: number | null;
}

/** Two independent pointer captures let the driver move and fire together. */
export class MobileControls {
  private readonly pads: Pad[];
  private readonly listeners = new AbortController();
  private enabled = false;
  private input: MobileInput = { moveX: 0, moveZ: 0, fire: false };
  private lastEmitted: MobileInput = { ...this.input };

  constructor(private readonly onChange: (input: MobileInput) => void) {
    const required = (id: string): HTMLElement => {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing mobile control: ${id}`);
      return element;
    };
    this.pads = (['move', 'aim'] as const).map(side => ({
      side, element: required(`${side}-pad`), knob: required(`${side}-knob`), pointerId: null,
    }));
    const options = { signal: this.listeners.signal, passive: false };
    for (const pad of this.pads) {
      pad.element.addEventListener('pointerdown', event => this.begin(pad, event), options);
      pad.element.addEventListener('pointermove', event => this.move(pad, event), options);
      pad.element.addEventListener('pointerup', event => this.end(pad, event), options);
      pad.element.addEventListener('pointercancel', event => this.end(pad, event), options);
      pad.element.addEventListener('lostpointercapture', event => this.end(pad, event), options);
      pad.element.addEventListener('contextmenu', event => event.preventDefault(), options);
      this.centerKnob(pad);
    }
    window.addEventListener('blur', () => this.reset(), { signal: this.listeners.signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.reset();
    }, { signal: this.listeners.signal });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.reset();
    for (const pad of this.pads) pad.element.setAttribute('aria-disabled', String(!enabled));
  }

  reset(clearAim = false): void {
    for (const pad of this.pads) this.release(pad);
    this.input.moveX = 0;
    this.input.moveZ = 0;
    this.input.fire = false;
    if (clearAim) delete this.input.aim;
    this.emit();
  }

  destroy(): void {
    this.enabled = false;
    this.reset();
    this.listeners.abort();
  }

  private begin(pad: Pad, event: PointerEvent): void {
    if (!this.enabled || pad.pointerId !== null || event.button !== 0) return;
    // A pointer may only own one pad, even when controls overlap after a resize.
    if (this.pads.some(other => other.pointerId === event.pointerId)) return;
    event.preventDefault();
    pad.pointerId = event.pointerId;
    pad.element.setPointerCapture(event.pointerId);
    pad.element.classList.add('active');
    if (pad.side === 'aim') this.input.fire = true;
    this.update(pad, event);
    this.emit();
  }

  private move(pad: Pad, event: PointerEvent): void {
    if (!this.enabled || pad.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.update(pad, event);
    this.emit();
  }

  private end(pad: Pad, event: PointerEvent): void {
    if (pad.pointerId !== event.pointerId) return;
    event.preventDefault();
    this.release(pad);
    if (pad.side === 'move') {
      this.input.moveX = 0;
      this.input.moveZ = 0;
    } else {
      this.input.fire = false;
    }
    this.emit();
  }

  private update(pad: Pad, event: PointerEvent): void {
    // Measure each time: fullscreen, orientation changes and responsive scaling
    // can all change the pads while a finger is still held down.
    const rect = pad.element.getBoundingClientRect();
    const knobRect = pad.knob.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2 - Math.min(knobRect.width, knobRect.height) / 2);
    const screenX = event.clientX - rect.left - rect.width / 2;
    const screenY = event.clientY - rect.top - rect.height / 2;
    // Browsers without orientation locking display #game rotated clockwise.
    // Convert the touch back into the game's unrotated screen axes first.
    const rotated = document.body.classList.contains('phone-rotated');
    let x = (rotated ? screenY : screenX) / radius;
    let z = (rotated ? -screenX : screenY) / radius;
    const rawLength = Math.hypot(x, z);
    if (rawLength > 1) { x /= rawLength; z /= rawLength; }
    const length = Math.min(rawLength, 1);
    // The DOM rect includes CSS scale; convert displacement back to CSS pixels.
    const scaleX = rect.width / (pad.element.offsetWidth || rect.width || 1);
    const scaleY = rect.height / (pad.element.offsetHeight || rect.height || 1);
    pad.knob.style.transform = `translate(-50%, -50%) translate(${x * radius / (scaleX || 1)}px, ${z * radius / (scaleY || 1)}px)`;
    if (pad.side === 'move') {
      const strength = length <= 0.12 ? 0 : (length - 0.12) / 0.88;
      const factor = length > 0 ? strength / length : 0;
      this.input.moveX = x * factor || 0;
      this.input.moveZ = z * factor || 0;
    } else if (length > 0.16) {
      this.input.aim = Math.atan2(x, z);
    }
  }

  private release(pad: Pad): void {
    const pointerId = pad.pointerId;
    // Clear ownership first: releasePointerCapture can dispatch a lost event.
    pad.pointerId = null;
    if (pointerId !== null && pad.element.hasPointerCapture(pointerId)) pad.element.releasePointerCapture(pointerId);
    pad.element.classList.remove('active');
    this.centerKnob(pad);
  }

  private centerKnob(pad: Pad): void {
    pad.knob.style.transform = 'translate(-50%, -50%)';
  }

  private emit(): void {
    const current = this.input, previous = this.lastEmitted;
    if (current.moveX === previous.moveX && current.moveZ === previous.moveZ && current.aim === previous.aim && current.fire === previous.fire) return;
    this.lastEmitted = { ...current };
    this.onChange({ ...current });
  }
}
