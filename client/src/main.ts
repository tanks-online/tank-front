import './style.css';
import './menu.css';
import type { TankRenderer } from './renderer';
import { Connection } from './network';
import type { GameState, TankKind } from './types';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const names: Record<TankKind, string> = { scout: 'СТРИЖ', medium: 'БАСТИОН', heavy: 'МОЛОТ' };
const specs: Record<TankKind, string> = { scout: '75 HP · урон 20 · скорость 10 · перезарядка 0,35 с', medium: '110 HP · урон 30 · скорость 7 · перезарядка 0,6 с', heavy: '160 HP · урон 45 · скорость 5 · перезарядка 1 с' };
let stored: Record<string, unknown> = {};
try { stored = JSON.parse(localStorage.getItem('tank-front-preferences') || '{}'); } catch { /* storage is optional */ }
if (!stored || typeof stored !== 'object') stored = {};
let tank: TankKind = ['scout','medium','heavy'].includes(String(stored.tank)) ? stored.tank as TankKind : 'medium';
let sound = stored.sound !== false;
let quality: 'low' | 'high' = stored.quality === 'low' ? 'low' : 'high';
let inviteRoom = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
if (!/^[A-Z0-9]{6}$/.test(inviteRoom)) inviteRoom = '';
let connection: Connection | undefined, battle: TankRenderer | undefined;
let playerId = '', room = '', inGame = false, seq = 0, aim = 0, firing = false;
let state: GameState | undefined, lastState: GameState | undefined, entryRevision = 0;
const keys = new Set<string>();
let audio: AudioContext | undefined;
let toastTimer: ReturnType<typeof setTimeout>;

el<HTMLInputElement>('nickname').value = typeof stored.name === 'string' ? stored.name.slice(0, 16) : 'Танкист';
el<HTMLInputElement>('sound').checked = sound;
el<HTMLSelectElement>('quality').value = quality;
el<HTMLSelectElement>('tank-select').value = tank;
el('tank-info').textContent = specs[tank];
function save(): void { try { localStorage.setItem('tank-front-preferences', JSON.stringify({ name: el<HTMLInputElement>('nickname').value, tank, sound, quality })); } catch { /* private browsing */ } }
function toast(text: string): void { el('toast').textContent = text; el('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el('toast').hidden = true, 5500); }
function tone(freq: number, duration: number, volume = 0.05): void {
  if (!sound || !audio || audio.state !== 'running') return;
  const osc = audio.createOscillator(), gain = audio.createGain();
  osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, audio.currentTime); osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq / 3), audio.currentTime + duration);
  gain.gain.setValueAtTime(volume, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
  osc.connect(gain); gain.connect(audio.destination); osc.start(); osc.stop(audio.currentTime + duration);
}
function unlockAudio(): void { if (!audio) { try { audio = new AudioContext(); } catch { return; } } void audio.resume(); }
el('nickname').addEventListener('input', save);
function updateInvitation(): void {
  el('play').innerHTML = inviteRoom ? `Играть в ${inviteRoom} <span>↗</span>` : 'Играть <span>↗</span>';
  el('play-note').textContent = inviteRoom ? `Приглашение в комнату ${inviteRoom}. Введите ник и играйте.` : 'Автоматически найдём комнату. Бой начнётся от двух игроков.';
  el('cancel-invite').hidden = !inviteRoom;
}
el('cancel-invite').addEventListener('click', () => { inviteRoom = ''; history.replaceState({}, '', location.pathname); updateInvitation(); });
updateInvitation();
const clock = (n: number) => { const seconds = Math.max(0, Math.ceil(n)); return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; };

async function startGame(): Promise<void> {
  if (inGame) return;
  const nickname = el<HTMLInputElement>('nickname').value.trim();
  if (!nickname || /[\x00-\x1f\x7f]/.test(nickname)) { toast('Введите ник: от 1 до 16 символов.'); el('nickname').focus(); return; }
  save(); unlockAudio(); inGame = true; const revision = ++entryRevision; state = lastState = undefined; playerId = room = ''; seq = 0; keys.clear(); firing = false;
  el('lobby').hidden = true; el('game').hidden = false; el('results').hidden = true; el('waiting').hidden = true;
  el('phase-label').textContent = 'ПОДКЛЮЧЕНИЕ'; el('timer').textContent = '03:00'; el('ping').textContent = '— мс'; el('room-label').textContent = 'ПОИСК КОМНАТЫ'; el('scores').replaceChildren();
  el('game-status').textContent = 'Загружаем 3D-арену…';
  try {
    const { TankRenderer } = await import('./renderer');
    if (!inGame || revision !== entryRevision) return;
    battle = new TankRenderer(el('battle-scene'), angle => aim = angle, pressed => firing = pressed); battle.setQuality(quality);
  }
  catch { leaveGame(); toast('Для 3D-игры нужен WebGL 2. Обновите браузер и включите аппаратное ускорение.'); return; }
  connection = new Connection({ name: nickname, tank, ...(inviteRoom ? { room: inviteRoom } : { quickPlay: true }) }, {
    status: (message, online) => { el('game-status').textContent = message; el('game-status').classList.toggle('connected', online); if (!online) { keys.clear(); firing = false; } },
    welcome: session => { playerId = session.playerId; room = session.room; el('room-label').textContent = `КОМНАТА ${room}`; const url = new URL(location.href); url.search = ''; url.searchParams.set('room', room); history.replaceState({}, '', url); },
    state: onState,
    error: (message, code) => { toast(message); if (!['RATE_LIMIT','RESTART_UNAVAILABLE'].includes(code)) { leaveGame(); el('play-note').textContent = message; } },
    ping: ms => el('ping').textContent = `${ms} мс`,
  });
}
el('play').addEventListener('click', startGame);
el('nickname').addEventListener('keydown', event => { if (event.key === 'Enter') startGame(); });

function scoreRows(target: HTMLElement, snapshot: GameState): void {
  const sorted = [...snapshot.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name, 'ru'));
  target.replaceChildren();
  sorted.forEach((p, i) => {
    const row = document.createElement('div'); row.className = `score-row${p.id === playerId ? ' self' : ''}`;
    const name = document.createElement('span'); name.textContent = `${i + 1}. ${p.name}${p.id === playerId ? ' (вы)' : ''}${p.connected ? '' : ' · нет связи'}`;
    const score = document.createElement('b'); score.textContent = `${p.kills} / ${p.deaths}`; row.append(name, score); target.append(row);
  });
}
function onState(snapshot: GameState): void {
  if (!inGame) return;
  state = snapshot; battle?.update(snapshot, playerId);
  el('timer').textContent = clock(snapshot.remaining);
  el('phase-label').textContent = snapshot.phase === 'playing' ? 'КАЖДЫЙ ЗА СЕБЯ' : snapshot.phase === 'ended' ? 'МАТЧ ЗАВЕРШЁН' : 'ОЖИДАНИЕ ИГРОКОВ';
  el('waiting').hidden = snapshot.phase !== 'waiting';
  const mine = snapshot.players.find(p => p.id === playerId);
  if (mine) {
    el('my-tank').textContent = names[mine.tank]; el('health-value').innerHTML = `${Math.max(0,mine.hp)} <small>/ ${mine.maxHp}</small>`;
    el('health-bar').style.width = `${Math.max(0, mine.hp / mine.maxHp * 100)}%`; el('health-bar').classList.toggle('critical', mine.hp / mine.maxHp < 0.3);
    el('kill-count').textContent = String(mine.kills); el('respawn').hidden = mine.alive || snapshot.phase !== 'playing';
    el('respawn').textContent = `Танк уничтожен · Возрождение через ${Math.ceil(mine.respawnIn)} с`;
    const previous = lastState?.players.find(p => p.id === playerId); if (previous && mine.hp < previous.hp) tone(90, 0.22, 0.09);
  }
  if (lastState && snapshot.shells.some(s => !lastState!.shells.some(old => old.id === s.id))) tone(160, 0.1, 0.04);
  scoreRows(el('scores'), snapshot); el('results').hidden = snapshot.phase !== 'ended';
  if (snapshot.phase === 'ended') {
    const sorted = [...snapshot.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths), top = sorted[0];
    const draw = top && sorted.filter(p => p.kills === top.kills && p.deaths === top.deaths).length > 1;
    el('winner').textContent = draw ? 'Боевая ничья' : top ? `${top.name} побеждает` : 'Матч завершён'; scoreRows(el('final-scores'), snapshot);
    el<HTMLButtonElement>('restart').disabled = snapshot.players.filter(p => p.connected).length < 2;
  }
  lastState = snapshot;
}

function leaveGame(): void {
  ++entryRevision; connection?.close(); connection = undefined; battle?.destroy(); battle = undefined; inGame = false; state = lastState = undefined; keys.clear(); firing = false; room = ''; playerId = '';
  el('game').hidden = true; el('lobby').hidden = false; el('respawn').hidden = true; inviteRoom = ''; history.replaceState({}, '', location.pathname); updateInvitation();
}
['leave', 'results-leave'].forEach(id => el(id).addEventListener('click', leaveGame));
el('restart').addEventListener('click', () => connection?.send({ type: 'restart' }));
async function copyInvite(): Promise<void> {
  if (!room) { toast('Дождитесь подключения к комнате.'); return; }
  const url = new URL(location.href); url.search = ''; url.searchParams.set('room', room);
  try { await navigator.clipboard.writeText(url.toString()); toast('Ссылка скопирована. Отправьте её другу!'); }
  catch { const input = document.createElement('input'); input.value = url.toString(); input.readOnly = true; el('game-status').replaceChildren(document.createTextNode('Скопируйте ссылку: '), input); input.focus(); input.select(); }
}
['invite','invite-center'].forEach(id => el(id).addEventListener('click', () => void copyInvite()));
function clearInput(): void { keys.clear(); firing = false; connection?.send({ type: 'input', seq: ++seq, forward: 0, turn: 0, aim, fire: false }); }
window.addEventListener('keydown', event => {
  if (!inGame || el<HTMLDialogElement>('settings').open) return;
  if (['KeyW','KeyA','KeyS','KeyD','Tab'].includes(event.code)) { event.preventDefault(); keys.add(event.code); }
  if (event.code === 'Tab') document.querySelector('.scoreboard')?.classList.add('expanded');
  if (event.code === 'Escape') { clearInput(); el<HTMLDialogElement>('settings').showModal(); }
});
window.addEventListener('keyup', event => { keys.delete(event.code); if (event.code === 'Tab') document.querySelector('.scoreboard')?.classList.remove('expanded'); });
window.addEventListener('blur', clearInput); document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); });
setInterval(() => { if (!inGame || !state || document.hidden || el<HTMLDialogElement>('settings').open) return; connection?.send({ type: 'input', seq: ++seq, forward: Number(keys.has('KeyW')) - Number(keys.has('KeyS')), turn: Number(keys.has('KeyA')) - Number(keys.has('KeyD')), aim, fire: firing }); }, 50);
['settings-open','game-settings'].forEach(id => el(id).addEventListener('click', () => { clearInput(); el<HTMLDialogElement>('settings').showModal(); }));
el('settings-close').addEventListener('click', () => el<HTMLDialogElement>('settings').close());
el('sound').addEventListener('change', () => { sound = el<HTMLInputElement>('sound').checked; save(); unlockAudio(); tone(400, 0.1); });
el('quality').addEventListener('change', () => { quality = el<HTMLSelectElement>('quality').value as 'low'|'high'; battle?.setQuality(quality); save(); });
el('tank-select').addEventListener('change', () => { tank = el<HTMLSelectElement>('tank-select').value as TankKind; el('tank-info').textContent = specs[tank]; save(); });
window.addEventListener('pagehide', () => { connection?.close(); battle?.destroy(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  connection = undefined; battle = undefined; inGame = false; state = lastState = undefined; keys.clear(); firing = false;
  el('game').hidden = true; el('lobby').hidden = false; inviteRoom = new URLSearchParams(location.search).get('room') || ''; updateInvitation();
});
