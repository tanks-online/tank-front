export type TankKind = 'scout' | 'medium' | 'heavy';

export interface PlayerState {
  id: string;
  name: string;
  tank: TankKind;
  x: number;
  z: number;
  angle: number;
  turret: number;
  hp: number;
  maxHp: number;
  kills: number;
  deaths: number;
  alive: boolean;
  respawnIn: number;
  connected: boolean;
  /** Authoritative time until the next shot; optional for older deployed servers. */
  reloadIn?: number;
}

export interface ObstacleState { x: number; z: number; w: number; d: number; h: number }
export interface ShellState { id: string; x: number; z: number }

export interface GameState {
  type: 'state';
  room: string;
  phase: 'waiting' | 'playing' | 'ended';
  remaining: number;
  tick: number;
  players: PlayerState[];
  shells: ShellState[];
  obstacles: ObstacleState[];
}

export interface RoomSummary {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  phase: 'waiting' | 'playing' | 'ended';
}
