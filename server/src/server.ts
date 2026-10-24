import http, { type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { readConfig, validateOrigins, type Config } from './config.js';
import { Game, type GameOptions, type Input } from './game.js';
import { TANKS, type TankType } from './world.js';
import { createStaticHandler, securityHeaders } from './static.js';

interface Room { game: Game; emptySince: number | null }
interface Session { playerId: string; token: string; room: string; socket: WebSocket | null; disconnectedAt: number | null }
interface Peer { socket: WebSocket; session?: Session; alive: boolean; connectedAt: number; windowStarted: number; messages: number; violations: number; pings: number }
export interface ServerOptions extends Partial<Config> {
  now?: () => number; gameOptions?: GameOptions; heartbeatMs?: number; reconnectGraceMs?: number; idleRoomMs?: number;
}
const ERROR_TEXT: Record<string, string> = {
  BAD_MESSAGE: 'Некорректное сообщение. Обновите страницу и попробуйте снова.',
  ROOM_FULL: 'В комнате уже восемь игроков. Выберите другую комнату.',
  ROOM_NOT_FOUND: 'Комната больше не существует. Создайте новую и отправьте друзьям новую ссылку.',
  CAPACITY: 'Сервер заполнен. Попробуйте позже или присоединитесь к существующей комнате.',
  RATE_LIMIT: 'Слишком много сообщений. Подождите несколько секунд.',
  SESSION_EXPIRED: 'Срок восстановления истёк. Войдите в комнату заново.',
  SESSION_IN_USE: 'Этот игрок уже подключён в другой вкладке.',
  RESTART_UNAVAILABLE: 'Новый бой доступен после окончания раунда при двух подключённых игроках.',
};

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 16 && !/[\x00-\x1f\x7f]/.test(value);
}
function validInput(value: Record<string, unknown>): value is Record<string, unknown> & Input {
  const directional = Object.hasOwn(value, 'moveX') || Object.hasOwn(value, 'moveZ');
  return Number.isSafeInteger(value.seq) && (value.seq as number) >= 0 &&
    ['forward', 'turn'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && Math.abs(value[k] as number) <= 1) &&
    (!directional || ['moveX', 'moveZ'].every(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && Math.abs(value[k] as number) <= 1)) &&
    typeof value.aim === 'number' && Number.isFinite(value.aim) && Math.abs(value.aim) <= 1_000_000 && typeof value.fire === 'boolean';
}
function rejectUpgrade(socket: NodeJS.WritableStream & { destroy(): void }, code: number, reason: string): void {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createGameServer(options: ServerOptions = {}) {
  const baseline = readConfig(options.allowedOrigins ? { ...process.env, ALLOWED_ORIGINS: options.allowedOrigins.join(',') } : process.env);
  const config: Config = { ...baseline, ...options, allowedOrigins: validateOrigins(options.allowedOrigins ?? baseline.allowedOrigins) };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) throw new Error('Некорректный port.');
  for (const [key, upper] of [['maxRooms', 4], ['maxPlayers', 32], ['roomCapacity', 8]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > upper) throw new Error(`Некорректный ${key}.`);
  }
  const now = options.now ?? Date.now;
  const graceMs = options.reconnectGraceMs ?? 30_000;
  const idleMs = options.idleRoomMs ?? 60_000;
  const rooms = new Map<string, Room>();
  const sessions = new Map<string, Session>();
  const peers = new Map<WebSocket, Peer>();
  const allowlist = new Set(config.allowedOrigins);
  const serveStatic = config.staticDir !== undefined ? createStaticHandler(config.staticDir) : undefined;
  const headers = securityHeaders(config.allowedOrigins);
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  const server = http.createServer({ maxHeaderSize: 8_192 }, (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (typeof origin === 'string' && allowlist.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }); res.end(); return; }
    const path = req.url?.split('?')[0];
    let body: unknown;
    if (path === '/health') body = { ok: true, rooms: rooms.size, players: sessions.size };
    else if (path === '/rooms') body = [...rooms].map(([id, { game }]) => ({
      id, players: game.connectedCount(), capacity: config.roomCapacity, phase: game.phase, remaining: game.remaining(now()),
    }));
    else {
      if (serveStatic && path !== '/ws') {
        void serveStatic(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
      } else { res.writeHead(404); res.end(); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 80;
  server.maxHeadersCount = 40;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, clientTracking: true });

  function send(socket: WebSocket, data: unknown): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 256 * 1024) { socket.terminate(); return false; }
    socket.send(typeof data === 'string' ? data : JSON.stringify(data));
    return true;
  }
  function error(socket: WebSocket, code: string): void { send(socket, { type: 'error', code, message: ERROR_TEXT[code] ?? ERROR_TEXT.BAD_MESSAGE }); }
  function broadcast(room: Room, time: number): void {
    const data = JSON.stringify(room.game.snapshot(time));
    for (const peer of peers.values()) if (peer.session?.room === room.game.room) send(peer.socket, data);
  }
  function randomRoomId(): string {
    // 30 random bits; codes contain no ambiguous O/0 or I/1 characters.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code: string;
    do { code = [...randomBytes(6)].map(byte => alphabet[byte & 31]).join(''); } while (rooms.has(code));
    return code;
  }
  function join(peer: Peer, message: Record<string, unknown>): void {
    if (peer.session) { error(peer.socket, 'BAD_MESSAGE'); return; }
    if (!validName(message.name) || typeof message.tank !== 'string' || !Object.hasOwn(TANKS, message.tank) ||
      (message.room !== undefined && (typeof message.room !== 'string' || !/^[A-Z0-9]{6}$/.test(message.room))) ||
      (message.quickPlay !== undefined && (typeof message.quickPlay !== 'boolean' || message.room !== undefined || message.resumeToken !== undefined)) ||
      (message.resumeToken !== undefined && (typeof message.resumeToken !== 'string' || !/^[a-f0-9]{64}$/.test(message.resumeToken)))) {
      error(peer.socket, 'BAD_MESSAGE'); return;
    }
    const time = now();
    let session: Session;
    let room: Room;
    if (message.resumeToken !== undefined) {
      const existing = sessions.get(message.resumeToken as string);
      if (!existing || existing.room !== message.room || (existing.disconnectedAt !== null && time - existing.disconnectedAt > graceMs)) {
        error(peer.socket, 'SESSION_EXPIRED'); return;
      }
      if (existing.socket && existing.socket.readyState < WebSocket.CLOSING) { error(peer.socket, 'SESSION_IN_USE'); return; }
      const resumedRoom = rooms.get(existing.room);
      if (!resumedRoom || !resumedRoom.game.players.has(existing.playerId)) { error(peer.socket, 'SESSION_EXPIRED'); return; }
      session = existing;
      room = resumedRoom;
      room.game.setConnected(session.playerId, true);
    } else {
      if (sessions.size >= config.maxPlayers) { error(peer.socket, 'CAPACITY'); return; }
      if (message.room !== undefined) {
        const requestedRoom = rooms.get(message.room as string);
        if (!requestedRoom) { error(peer.socket, 'ROOM_NOT_FOUND'); return; }
        room = requestedRoom;
        if (room.game.players.size >= config.roomCapacity) { error(peer.socket, 'ROOM_FULL'); return; }
      } else {
        const available = message.quickPlay === true ? [...rooms.values()]
          .filter(candidate => candidate.game.players.size < config.roomCapacity && candidate.game.connectedCount() > 0 &&
            (candidate.game.phase === 'waiting' || (candidate.game.phase === 'playing' && candidate.game.remaining(time) > 10)))
          .sort((a, b) => b.game.connectedCount() - a.game.connectedCount())[0] : undefined;
        if (available) room = available;
        else {
          if (rooms.size >= config.maxRooms) { error(peer.socket, 'CAPACITY'); return; }
          const roomId = randomRoomId();
          room = { game: new Game(roomId, { ...options.gameOptions, capacity: config.roomCapacity }), emptySince: null };
          rooms.set(roomId, room);
        }
      }
      session = { playerId: randomUUID(), token: randomBytes(32).toString('hex'), room: room.game.room, socket: null, disconnectedAt: null };
      room.game.addPlayer(session.playerId, message.name.trim(), message.tank as TankType, time);
      sessions.set(session.token, session);
    }
    session.socket = peer.socket;
    session.disconnectedAt = null;
    room.emptySince = null;
    peer.session = session;
    send(peer.socket, { type: 'welcome', playerId: session.playerId, resumeToken: session.token, room: session.room });
    broadcast(room, time);
  }

  function onMessage(peer: Peer, data: RawData, isBinary: boolean): void {
    const time = now();
    if (time - peer.windowStarted >= 1_000) { peer.windowStarted = time; peer.messages = 0; }
    if (++peer.messages > 60) {
      if (peer.messages === 61) error(peer.socket, 'RATE_LIMIT');
      if (++peer.violations > 120) peer.socket.close(1008, 'Rate limit');
      return;
    }
    if (isBinary) { error(peer.socket, 'BAD_MESSAGE'); peer.socket.close(1003, 'JSON text required'); return; }
    let message: unknown;
    try { message = JSON.parse(data.toString()); } catch { error(peer.socket, 'BAD_MESSAGE'); return; }
    if (!object(message) || typeof message.type !== 'string') { error(peer.socket, 'BAD_MESSAGE'); return; }
    if (message.type === 'join') { join(peer, message); return; }
    if (message.type === 'ping' && Number.isSafeInteger(message.id) && (message.id as number) >= 0) {
      send(peer.socket, { type: 'pong', id: message.id }); return;
    }
    const session = peer.session, room = session && rooms.get(session.room);
    if (!session || !room) { error(peer.socket, 'BAD_MESSAGE'); return; }
    if (message.type === 'input' && validInput(message)) room.game.setInput(session.playerId, message, time);
    else if (message.type === 'restart') {
      if (!room.game.restart(time)) error(peer.socket, 'RESTART_UNAVAILABLE');
      else broadcast(room, time);
    } else error(peer.socket, 'BAD_MESSAGE');
  }

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (stopping) { rejectUpgrade(socket, 503, 'Service Unavailable'); return; }
    if (req.url !== '/ws') { rejectUpgrade(socket, 404, 'Not Found'); return; }
    if (typeof req.headers.origin !== 'string' || !allowlist.has(req.headers.origin)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
    // Includes unauthenticated sockets so clients cannot bypass the bounded player pool.
    if (peers.size >= config.maxPlayers + 8) { rejectUpgrade(socket, 503, 'Service Unavailable'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', socket => {
    const time = now();
    const peer: Peer = { socket, alive: true, connectedAt: time, windowStarted: time, messages: 0, violations: 0, pings: 0 };
    peers.set(socket, peer);
    socket.on('pong', () => { peer.alive = true; });
    socket.on('ping', () => { if (++peer.pings > 10) socket.close(1008, 'Ping rate limit'); });
    socket.on('message', (data, binary) => onMessage(peer, data, binary));
    socket.on('error', () => {});
    socket.on('close', (code, reason) => {
      peers.delete(socket);
      const session = peer.session;
      if (!session || session.socket !== socket) return;
      session.socket = null;
      if (code === 1000 && reason.toString() === 'Leaving') {
        sessions.delete(session.token);
        const room = rooms.get(session.room);
        if (room) {
          room.game.removePlayer(session.playerId);
          if (room.game.players.size === 0) rooms.delete(session.room);
          else {
            if (room.game.connectedCount() === 0) room.emptySince ??= now();
            broadcast(room, now());
          }
        }
        return;
      }
      session.disconnectedAt = now();
      const room = rooms.get(session.room);
      if (room) {
        room.game.setConnected(session.playerId, false);
        if (room.game.connectedCount() === 0) room.emptySince = now();
        broadcast(room, now());
      }
    });
  });

  let lastTick = now(), tickCount = 0;
  const simulation = setInterval(() => {
    const time = now(), dt = Math.min(0.1, Math.max(0, (time - lastTick) / 1_000));
    lastTick = time;
    for (const [token, session] of sessions) {
      if (session.disconnectedAt !== null && time - session.disconnectedAt >= graceMs) {
        rooms.get(session.room)?.game.removePlayer(session.playerId);
        sessions.delete(token);
      }
    }
    for (const [roomId, room] of rooms) {
      if (room.emptySince !== null && time - room.emptySince >= idleMs && room.game.players.size === 0) { rooms.delete(roomId); continue; }
      room.game.step(time, dt);
      if (tickCount % 2 === 0) broadcast(room, time);
    }
    tickCount++;
    for (const peer of peers.values()) if (!peer.session && time - peer.connectedAt > 10_000) peer.socket.close(1008, 'Join timeout');
  }, 50);
  simulation.unref();
  const heartbeat = setInterval(() => {
    for (const peer of peers.values()) {
      if (!peer.alive) { peer.socket.terminate(); continue; }
      peer.alive = false;
      peer.pings = 0;
      peer.socket.ping();
    }
  }, options.heartbeatMs ?? 15_000);
  heartbeat.unref();

  return {
    server, wss, rooms, config,
    listen: () => new Promise<import('node:net').AddressInfo>((resolve, reject) => {
      const failed = (err: Error) => reject(err);
      server.once('error', failed);
      server.listen(config.port, config.host, () => {
        server.off('error', failed);
        resolve(server.address() as import('node:net').AddressInfo);
      });
    }),
    close: (): Promise<void> => closePromise ??= new Promise(resolve => {
      stopping = true;
      clearInterval(simulation);
      clearInterval(heartbeat);
      for (const peer of peers.values()) peer.socket.close(1001, 'Server restarting');
      const force = setTimeout(() => { for (const peer of peers.values()) peer.socket.terminate(); }, 500);
      force.unref();
      wss.close(() => { clearTimeout(force); });
      if (server.listening) server.close(() => resolve());
      else resolve();
    }),
  };
}
