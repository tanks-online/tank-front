import { OBSTACLES, TANKS, WORLD, circleHitsBox, segmentBox, segmentCircle, type Phase, type Point, type TankType } from './world.js';

export interface Input {
  seq: number; forward: number; turn: number; aim: number; fire: boolean;
  // Optional world-space direction. Both fields must be supplied together.
  moveX?: number; moveZ?: number;
}
export interface Player {
  id: string; name: string; tank: TankType; x: number; z: number; angle: number; turret: number;
  hp: number; maxHp: number; kills: number; deaths: number; alive: boolean; connected: boolean;
  input: Input; lastInputAt: number; lastShotAt: number; respawnAt: number;
}
interface Shell extends Point { id: string; owner: string; vx: number; vz: number; damage: number; expiresAt: number }
export interface GameOptions {
  capacity?: number; matchDurationMs?: number; respawnMs?: number; spawnPoints?: Point[];
}
const ZERO_INPUT: Input = { seq: -1, forward: 0, turn: 0, aim: 0, fire: false };
const DEFAULT_SPAWNS: Point[] = [
  { x: -34, z: -26 }, { x: 34, z: 26 }, { x: 34, z: -26 }, { x: -34, z: 26 },
  { x: -12, z: -28 }, { x: 12, z: 28 }, { x: -37, z: -4 }, { x: 37, z: 4 },
];
const normalizeAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const DIRECTION_TURN_SPEED: Record<TankType, number> = { scout: 4.8, medium: 3.8, heavy: 2.8 };
// Quantize only the wire representation; the simulation retains full precision.
const wirePosition = (value: number) => Math.round(value * 100) / 100;
const wireAngle = (value: number) => Math.round(value * 1_000) / 1_000;

export class Game {
  readonly players = new Map<string, Player>();
  readonly shells = new Map<string, Shell>();
  readonly capacity: number;
  readonly duration: number;
  readonly respawnMs: number;
  phase: Phase = 'waiting';
  tick = 0;
  startedAt = 0;
  private shellSequence = 0;
  private spawnCursor = 0;
  private spawns: Point[];
  private lastNow = 0;

  constructor(readonly room: string, options: GameOptions = {}) {
    this.capacity = options.capacity ?? 8;
    this.duration = options.matchDurationMs ?? 180_000;
    this.respawnMs = options.respawnMs ?? 3_000;
    this.spawns = options.spawnPoints?.length ? options.spawnPoints : DEFAULT_SPAWNS;
  }

  connectedCount(): number { return [...this.players.values()].filter(p => p.connected).length; }

  addPlayer(id: string, name: string, tank: TankType, now: number): Player {
    if (this.players.size >= this.capacity) throw new Error('ROOM_FULL');
    const hp = TANKS[tank].hp;
    const player: Player = {
      id, name, tank, x: 0, z: 0, angle: 0, turret: 0, hp, maxHp: hp, kills: 0, deaths: 0,
      alive: true, connected: true, input: { ...ZERO_INPUT }, lastInputAt: now, lastShotAt: -Infinity, respawnAt: 0,
    };
    this.players.set(id, player);
    this.spawn(player);
    return player;
  }

  setConnected(id: string, connected: boolean): void {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = connected;
    // A disconnected tank has no collider. Another player may now occupy its former position.
    if (connected && player.alive && !this.canMove(player, player.x, player.z)) {
      const hp = player.hp;
      this.spawn(player);
      player.hp = hp;
    }
    player.input = { ...ZERO_INPUT, aim: player.turret };
    player.lastInputAt = -Infinity;
  }

  removePlayer(id: string): void {
    this.players.delete(id);
    for (const [shellId, shell] of this.shells) if (shell.owner === id) this.shells.delete(shellId);
  }

  setInput(id: string, input: Input, now: number): void {
    const player = this.players.get(id);
    if (!player || !player.connected || input.seq <= player.input.seq) return;
    player.input = { ...input };
    player.lastInputAt = now;
  }

  restart(now: number): boolean {
    if (this.phase !== 'ended' || this.connectedCount() < 2) return false;
    this.begin(now);
    return true;
  }

  private begin(now: number): void {
    this.phase = 'playing';
    this.startedAt = now;
    this.shells.clear();
    for (const player of this.players.values()) {
      player.kills = 0;
      player.deaths = 0;
      player.alive = false;
      player.input = { ...ZERO_INPUT, aim: player.turret };
      player.lastInputAt = -Infinity;
    }
    for (const player of this.players.values()) {
      this.spawn(player);
      player.lastShotAt = -Infinity;
    }
  }

  private spawn(player: Player): void {
    let best = this.spawns[this.spawnCursor % this.spawns.length]!;
    let bestScore = -Infinity;
    for (let i = 0; i < this.spawns.length; i++) {
      const point = this.spawns[(this.spawnCursor + i) % this.spawns.length]!;
      if (!this.staticClear(point.x, point.z)) continue;
      let distance = Infinity;
      for (const other of this.players.values()) {
        if (other.id !== player.id && other.alive && other.connected) {
          distance = Math.min(distance, Math.hypot(other.x - point.x, other.z - point.z));
        }
      }
      if (distance > bestScore) { best = point; bestScore = distance; }
    }
    this.spawnCursor++;
    player.x = best.x;
    player.z = best.z;
    // Face the arena center. All angles use +Z as zero, +X as pi/2.
    player.angle = Math.atan2(-best.x, -best.z);
    player.turret = player.angle;
    player.hp = player.maxHp;
    player.alive = true;
    player.respawnAt = 0;
  }

  private staticClear(x: number, z: number): boolean {
    const r = WORLD.tankRadius;
    return Math.abs(x) <= WORLD.width / 2 - r && Math.abs(z) <= WORLD.depth / 2 - r &&
      !OBSTACLES.some(box => circleHitsBox(x, z, r, box));
  }

  private canMove(player: Player, x: number, z: number): boolean {
    if (!this.staticClear(x, z)) return false;
    for (const other of this.players.values()) {
      if (other.id !== player.id && other.alive && other.connected && Math.hypot(other.x - x, other.z - z) < WORLD.tankRadius * 2) return false;
    }
    return true;
  }

  step(now: number, deltaSeconds = 0.05): void {
    this.lastNow = now;
    this.tick++;
    if (this.phase === 'waiting' && this.connectedCount() >= 2) this.begin(now);
    // One human can practice while waiting; only a real round advances its timer.
    if (this.phase === 'ended') return;
    if (this.phase === 'playing' && now - this.startedAt >= this.duration) {
      this.phase = 'ended';
      this.shells.clear();
      for (const p of this.players.values()) p.input = { ...ZERO_INPUT, aim: p.turret };
      return;
    }
    const dt = Math.min(0.1, Math.max(0, deltaSeconds));
    for (const player of this.players.values()) {
      if (!player.connected) continue;
      if (!player.alive) {
        if (now >= player.respawnAt) this.spawn(player);
        else continue;
      }
      if (now - player.lastInputAt > 250) continue;
      const input = player.input;
      let drive = input.forward;
      if (input.moveX !== undefined && input.moveZ !== undefined) {
        const magnitude = Math.hypot(input.moveX, input.moveZ);
        drive = 0;
        if (magnitude > 0) {
          let desired = Math.atan2(input.moveX, input.moveZ);
          let difference = normalizeAngle(desired - player.angle);
          let direction = 1;
          // Reverse into directions behind the hull instead of making a 180-degree turn.
          if (Math.abs(difference) > Math.PI / 2) {
            desired = normalizeAngle(desired + Math.PI);
            difference = normalizeAngle(desired - player.angle);
            direction = -1;
          }
          const turnStep = DIRECTION_TURN_SPEED[player.tank] * dt;
          player.angle = normalizeAngle(player.angle + Math.max(-turnStep, Math.min(turnStep, difference)));
          // The chassis still drives along its tracks. Turning cannot become instant strafing,
          // and a diagonal key combination cannot exceed the class's normal speed.
          const alignment = Math.max(0, Math.cos(normalizeAngle(desired - player.angle)));
          drive = direction * Math.min(1, magnitude) * alignment;
        }
      } else {
        player.angle = normalizeAngle(player.angle + input.turn * 2.5 * dt);
      }
      player.turret = normalizeAngle(input.aim);
      const distance = drive * TANKS[player.tank].speed * dt;
      const nextX = player.x + Math.sin(player.angle) * distance;
      const nextZ = player.z + Math.cos(player.angle) * distance;
      if (this.canMove(player, nextX, player.z)) player.x = nextX;
      if (this.canMove(player, player.x, nextZ)) player.z = nextZ;
      if (input.fire && now - player.lastShotAt >= TANKS[player.tank].cooldown) {
        player.lastShotAt = now;
        const id = `s${++this.shellSequence}`;
        this.shells.set(id, {
          id, owner: player.id, x: player.x, z: player.z, vx: Math.sin(player.turret) * 34,
          vz: Math.cos(player.turret) * 34, damage: TANKS[player.tank].damage, expiresAt: now + 2_800,
        });
      }
    }
    for (const [id, shell] of this.shells) {
      if (now >= shell.expiresAt) { this.shells.delete(id); continue; }
      const next = { x: shell.x + shell.vx * dt, z: shell.z + shell.vz * dt };
      let hitAt = Infinity;
      let victim: Player | undefined;
      for (const box of OBSTACLES) {
        const hit = segmentBox(shell, next, box, WORLD.shellRadius);
        if (hit !== null && hit < hitAt) { hitAt = hit; victim = undefined; }
      }
      for (const player of this.players.values()) {
        if (player.id === shell.owner || !player.alive || !player.connected) continue;
        const hit = segmentCircle(shell, next, player, WORLD.tankRadius + WORLD.shellRadius);
        if (hit !== null && hit < hitAt) { hitAt = hit; victim = player; }
      }
      if (hitAt !== Infinity) {
        this.shells.delete(id);
        if (victim) {
          victim.hp = Math.max(0, victim.hp - shell.damage);
          if (victim.hp === 0) {
            victim.alive = false;
            victim.deaths++;
            victim.respawnAt = now + this.respawnMs;
            victim.input = { ...ZERO_INPUT, aim: victim.turret };
            const shooter = this.players.get(shell.owner);
            if (shooter) shooter.kills++;
          }
        }
      } else if (Math.abs(next.x) > WORLD.width / 2 || Math.abs(next.z) > WORLD.depth / 2) {
        this.shells.delete(id);
      } else { shell.x = next.x; shell.z = next.z; }
    }
  }

  remaining(now = this.lastNow): number {
    if (this.phase === 'waiting') return Math.ceil(this.duration / 1_000);
    if (this.phase === 'ended') return 0;
    return Math.max(0, Math.ceil((this.duration - (now - this.startedAt)) / 1_000));
  }

  snapshot(now = this.lastNow) {
    return {
      type: 'state' as const, room: this.room, phase: this.phase, remaining: this.remaining(now), tick: this.tick,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, tank: p.tank, x: wirePosition(p.x), z: wirePosition(p.z), angle: wireAngle(p.angle), turret: wireAngle(p.turret),
        hp: p.hp, maxHp: p.maxHp, kills: p.kills, deaths: p.deaths, alive: p.alive,
        respawnIn: p.alive ? 0 : wirePosition(Math.max(0, (p.respawnAt - now) / 1_000)), connected: p.connected,
        reloadIn: wirePosition(Math.max(0, (p.lastShotAt + TANKS[p.tank].cooldown - now) / 1_000)),
      })),
      shells: [...this.shells.values()].map(s => ({ id: s.id, x: wirePosition(s.x), z: wirePosition(s.z) })),
      obstacles: OBSTACLES,
    };
  }
}
