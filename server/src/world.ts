export const WORLD = { width: 80, depth: 64, tankRadius: 1.4, shellRadius: 0.16 } as const;

export const OBSTACLES = [
  { x: -20, z: -12, w: 12, d: 8, h: 4 },
  { x: 16, z: 10, w: 10, d: 12, h: 4 },
  { x: 0, z: -20, w: 10, d: 6, h: 3 },
  { x: -12, z: 18, w: 8, d: 8, h: 3 },
  { x: 27, z: -19, w: 6, d: 14, h: 4 },
  { x: -29, z: 12, w: 6, d: 14, h: 4 },
  { x: 1, z: 3, w: 8, d: 5, h: 3 },
] as const;

export const TANKS = {
  scout: { hp: 75, speed: 10, damage: 20, cooldown: 350 },
  medium: { hp: 110, speed: 7, damage: 30, cooldown: 600 },
  heavy: { hp: 160, speed: 5, damage: 45, cooldown: 1000 },
} as const;
export type TankType = keyof typeof TANKS;
export type Phase = 'waiting' | 'playing' | 'ended';
export interface Point { x: number; z: number }

export function circleHitsBox(x: number, z: number, radius: number, box: { x: number; z: number; w: number; d: number }): boolean {
  const nx = Math.max(box.x - box.w / 2, Math.min(x, box.x + box.w / 2));
  const nz = Math.max(box.z - box.d / 2, Math.min(z, box.z + box.d / 2));
  return (x - nx) ** 2 + (z - nz) ** 2 < radius ** 2;
}

// Earliest intersection along a segment, including a start already inside the shape.
export function segmentBox(a: Point, b: Point, box: { x: number; z: number; w: number; d: number }, padding = 0): number | null {
  let enter = 0, leave = 1;
  for (const axis of ['x', 'z'] as const) {
    const half = (axis === 'x' ? box.w : box.d) / 2 + padding;
    const low = box[axis] - half, high = box[axis] + half;
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] < low || a[axis] > high) return null;
    } else {
      const t1 = (low - a[axis]) / delta, t2 = (high - a[axis]) / delta;
      enter = Math.max(enter, Math.min(t1, t2));
      leave = Math.min(leave, Math.max(t1, t2));
      if (enter > leave) return null;
    }
  }
  return enter <= 1 && leave >= 0 ? Math.max(0, enter) : null;
}

export function segmentCircle(a: Point, b: Point, center: Point, radius: number): number | null {
  const dx = b.x - a.x, dz = b.z - a.z, ox = a.x - center.x, oz = a.z - center.z;
  const c = ox * ox + oz * oz - radius * radius;
  if (c <= 0) return 0;
  const aa = dx * dx + dz * dz;
  if (aa < 1e-12) return null;
  const bb = 2 * (ox * dx + oz * dz), discriminant = bb * bb - 4 * aa * c;
  if (discriminant < 0) return null;
  const t = (-bb - Math.sqrt(discriminant)) / (2 * aa);
  return t >= 0 && t <= 1 ? t : null;
}
