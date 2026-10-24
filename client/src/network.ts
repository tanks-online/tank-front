import type { GameState } from './types';

export function serverAddress(): URL {
  const raw = import.meta.env.VITE_SERVER_URL || (import.meta.env.DEV ? 'ws://localhost:3000/ws' : '');
  if (!raw) throw new Error('Адрес сервера не настроен. Задайте VITE_SERVER_URL при сборке сайта.');
  const url = raw === '/ws' ? new URL('/ws', location.href) : new URL(raw);
  if (raw === '/ws') url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/ws' || url.username || url.password) throw new Error('Неверный VITE_SERVER_URL: нужен wss://HOST/ws.');
  if (location.protocol === 'https:' && url.protocol !== 'wss:') throw new Error('Сайт открыт по HTTPS. Для игры нужен защищённый адрес wss://.');
  return url;
}

export function httpAddress(path: string): string {
  const url = serverAddress();
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = path;
  return url.toString();
}

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function isState(x: unknown): x is GameState {
  if (!record(x) || x.type !== 'state' || typeof x.room !== 'string' || !['waiting', 'playing', 'ended'].includes(String(x.phase)) || !finite(x.remaining) || !finite(x.tick)) return false;
  if (!Array.isArray(x.players) || x.players.length > 8 || !Array.isArray(x.shells) || x.shells.length > 256 || !Array.isArray(x.obstacles) || x.obstacles.length > 64) return false;
  return x.players.every(p => record(p) && typeof p.id === 'string' && typeof p.name === 'string' && p.name.length <= 32 && ['scout','medium','heavy'].includes(String(p.tank)) && ['x','z','angle','turret','hp','maxHp','kills','deaths','respawnIn'].every(k => finite(p[k])) && typeof p.alive === 'boolean' && typeof p.connected === 'boolean') &&
    x.shells.every(s => record(s) && typeof s.id === 'string' && finite(s.x) && finite(s.z)) &&
    x.obstacles.every(o => record(o) && ['x','z','w','d','h'].every(k => finite(o[k])));
}

export interface JoinOptions { name: string; tank: string; room?: string; quickPlay?: boolean }
interface Session { playerId: string; resumeToken: string; room: string }
interface Callbacks {
  status: (message: string, online: boolean) => void;
  welcome: (session: Session) => void;
  state: (state: GameState) => void;
  error: (message: string, code: string) => void;
  ping: (ms: number) => void;
}

/** A single bounded connection, with exponential retry and session restoration. */
export class Connection {
  private ws?: WebSocket;
  private session?: Session;
  private stopped = false;
  private retries = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private openedAt = 0;
  private lastMessage = 0;
  private pingId = 0;
  private pendingPing = new Map<number, number>();
  private ready = false;

  constructor(private join: JoinOptions, private cb: Callbacks) { this.open(); }

  private open(): void {
    if (this.stopped) return;
    this.ready = false;
    this.cb.status(this.retries ? 'Связь потеряна. Переподключаемся… Если сервер спал, запуск может занять около минуты.' : 'Подключаемся… Бесплатный сервер после простоя может запускаться около минуты.', false);
    let ws: WebSocket;
    try { ws = new WebSocket(serverAddress()); } catch (e) { this.fail(e instanceof Error ? e.message : 'Не удалось открыть соединение.', 'CONFIG'); return; }
    this.ws = ws;
    this.openedAt = this.lastMessage = Date.now();
    ws.addEventListener('open', () => {
      if (this.stopped || this.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'join', ...this.join, ...(this.session ? { quickPlay: undefined, room: this.session.room, resumeToken: this.session.resumeToken } : {}) }));
    });
    ws.addEventListener('message', event => {
      if (this.stopped || this.ws !== ws || typeof event.data !== 'string' || event.data.length > 65536) return;
      this.lastMessage = Date.now();
      let data: unknown;
      try { data = JSON.parse(event.data); } catch { this.fail('Сервер прислал некорректный ответ.', 'PROTOCOL'); return; }
      if (!record(data)) return;
      if (data.type === 'welcome' && typeof data.playerId === 'string' && typeof data.resumeToken === 'string' && typeof data.room === 'string') {
        this.session = { playerId: data.playerId, resumeToken: data.resumeToken, room: data.room };
        this.ready = true; this.retries = 0;
        this.cb.welcome(this.session); this.cb.status('Соединение установлено', true);
      } else if (isState(data)) this.cb.state(data);
      else if (data.type === 'pong' && finite(data.id)) {
        const started = this.pendingPing.get(data.id);
        if (started !== undefined) { this.cb.ping(Math.round(performance.now() - started)); this.pendingPing.delete(data.id); }
      } else if (data.type === 'error' && typeof data.code === 'string' && typeof data.message === 'string') {
        if (data.code === 'SESSION_EXPIRED' && this.session) {
          const room = this.session.room; this.session = undefined; this.join.room = room; this.join.quickPlay = undefined;
          this.cb.status('Восстановление истекло. Пробуем войти в комнату заново…', false);
          ws.close();
        } else if (['RESTART_UNAVAILABLE', 'RATE_LIMIT'].includes(data.code)) this.cb.error(data.message, data.code);
        else this.fail(data.message, data.code);
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws || this.stopped) return;
      this.ready = false;
      clearInterval(this.watchdog); this.pendingPing.clear();
      if (++this.retries > 12) { this.fail('Сервер недоступен. Проверьте интернет и адрес сервера; возможно, бесплатный лимит исчерпан. Попробуйте позже.', 'UNAVAILABLE'); return; }
      this.cb.status('Связь потеряна. Восстанавливаем соединение… Пробуждение сервера может занять около минуты.', false);
      this.reconnectTimer = setTimeout(() => this.open(), Math.min(1000 * 2 ** (this.retries - 1), 10000) + Math.random() * 300);
    });
    ws.addEventListener('error', () => { /* Browser hides TLS/Origin failure details; close triggers retry. */ });
    this.watchdog = setInterval(() => {
      const now = Date.now();
      if ((ws.readyState === WebSocket.CONNECTING && now - this.openedAt > 75000) || (ws.readyState === WebSocket.OPEN && now - this.lastMessage > 15000)) { ws.close(); return; }
      if (!this.ready) return;
      const id = ++this.pingId;
      this.pendingPing.set(id, performance.now());
      if (this.pendingPing.size > 5) this.pendingPing.delete(this.pendingPing.keys().next().value!);
      this.send({ type: 'ping', id });
    }, 2000);
  }

  send(data: unknown): void {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    // Input describes the current controls: a queued history becomes stale and
    // can arrive as a burst after a slow connection recovers. The next 20 Hz
    // update supplies the latest controls once the socket has drained.
    const input = record(data) && data.type === 'input';
    if (input ? this.ws.bufferedAmount !== 0 : this.ws.bufferedAmount >= 32768) return;
    this.ws.send(JSON.stringify(data));
  }
  private fail(message: string, code: string): void { this.close(); this.cb.error(message, code); }
  close(): void { this.stopped = true; this.ready = false; clearTimeout(this.reconnectTimer); clearInterval(this.watchdog); this.pendingPing.clear(); this.ws?.close(1000, 'Leaving'); }
}
