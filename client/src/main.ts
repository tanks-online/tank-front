import './style.css';
import './menu.css';
import './mobile.css';
import type { TankRenderer } from './renderer';
import { Connection } from './network';
import type { GameState, TankKind } from './types';
import { MobileControls, type MobileInput } from './mobile';
import { PhoneScreen } from './phone-screen';

const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const names: Record<TankKind, string> = { scout: 'СТРИЖ', medium: 'БАСТИОН', heavy: 'МОЛОТ' };
const specs: Record<TankKind, string> = { scout: '75 HP · урон 20 · скорость 10 · перезарядка 0,35 с', medium: '110 HP · урон 30 · скорость 7 · перезарядка 0,6 с', heavy: '160 HP · урон 45 · скорость 5 · перезарядка 1 с' };
let stored: Record<string, unknown> = {};
try { stored = JSON.parse(localStorage.getItem('tank-front-preferences') || '{}'); } catch { /* storage is optional */ }
if (!stored || typeof stored !== 'object') stored = {};
let tank: TankKind = ['scout','medium','heavy'].includes(String(stored.tank)) ? stored.tank as TankKind : 'medium';
let sound = stored.sound !== false;
let pcQuality: 'low' | 'high' = stored.pcQuality === 'low' || (!stored.pcQuality && stored.quality === 'low') ? 'low' : 'high';
let phoneQuality: 'low' | 'high' = stored.phoneQuality === 'high' ? 'high' : 'low';
let quality: 'low' | 'high' = pcQuality;
let deviceMode: 'phone' | 'pc' | undefined;
let controls: 'directional' | 'classic' = stored.controls === 'classic' ? 'classic' : 'directional';
let inviteRoom = new URLSearchParams(location.search).get('room')?.toUpperCase() || '';
if (!/^[A-Z0-9]{6}$/.test(inviteRoom)) inviteRoom = '';
let connection: Connection | undefined, battle: TankRenderer | undefined;
let playerId = '', room = '', inGame = false, seq = 0, aim = 0, firing = false;
let state: GameState | undefined, lastState: GameState | undefined, entryRevision = 0;
const keys = new Set<string>();
let audio: AudioContext | undefined;
let toastTimer: ReturnType<typeof setTimeout>;
let damageTimer: ReturnType<typeof setTimeout>;
let online = false;
let mobileInput: MobileInput = { moveX: 0, moveZ: 0, fire: false };
const touchControls = new MobileControls(input => {
  const changedFire = mobileInput.fire !== input.fire;
  mobileInput = input;
  if (input.aim !== undefined && deviceMode === 'phone') { aim = input.aim; battle?.setTouchAim(aim); }
  if (changedFire) sendInput();
});
const phoneScreen = new PhoneScreen(() => clearInput());
const cooldown: Record<TankKind, number> = { scout: 0.35, medium: 0.6, heavy: 1 };
const actionCodes = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight']);

el<HTMLInputElement>('nickname').value = typeof stored.name === 'string' ? stored.name.slice(0, 16) : 'Танкист';
el<HTMLInputElement>('sound').checked = sound;
el<HTMLSelectElement>('quality').value = quality;
el<HTMLSelectElement>('tank-select').value = tank;
el<HTMLSelectElement>('controls').value = controls;
el<HTMLSelectElement>('device-mode').value = stored.device === 'phone' ? 'phone' : 'pc';
el('tank-info').textContent = specs[tank];
function save(): void { try { localStorage.setItem('tank-front-preferences', JSON.stringify({ name: el<HTMLInputElement>('nickname').value, tank, sound, quality, pcQuality, phoneQuality, controls, device: deviceMode })); } catch { /* private browsing */ } }
function syncTouchControls(): void {
  const phone = deviceMode === 'phone' && inGame;
  const mine = state?.players.find(player => player.id === playerId);
  el('mobile-controls').hidden = !phone || state?.phase === 'ended';
  touchControls.setEnabled(phone && online && !!mine?.alive && !document.hidden && !el<HTMLDialogElement>('settings').open && state?.phase !== 'ended');
}
function chooseDevice(mode: 'phone' | 'pc'): void {
  clearInput(); touchControls.reset(true); deviceMode = mode;
  document.body.classList.toggle('phone-mode', mode === 'phone');
  document.body.classList.remove('phone-scoreboard-open'); el('mobile-scores').setAttribute('aria-expanded', 'false');
  el<HTMLSelectElement>('device-mode').value = mode;
  quality = mode === 'phone' ? phoneQuality : pcQuality;
  el<HTMLSelectElement>('quality').value = quality;
  battle?.setTouchMode(mode === 'phone'); battle?.setQuality(quality);
  el('device-screen').hidden = true; el('lobby').hidden = inGame;
  phoneScreen.setActive(mode === 'phone' && inGame); syncTouchControls(); save();
  if (mode === 'phone' && inGame) void phoneScreen.enterLandscape();
}
el('device-phone').addEventListener('click', () => chooseDevice('phone'));
el('device-pc').addEventListener('click', () => chooseDevice('pc'));
el('device-change').addEventListener('click', () => { clearInput(); el('lobby').hidden = true; el('device-screen').hidden = false; });
el('device-mode').addEventListener('change', () => chooseDevice(el<HTMLSelectElement>('device-mode').value as 'phone' | 'pc'));
el('mobile-scores').addEventListener('click', () => { const open = document.body.classList.toggle('phone-scoreboard-open'); el('mobile-scores').setAttribute('aria-expanded', String(open)); });
['mobile-fullscreen','rotate-retry'].forEach(id => el(id).addEventListener('click', () => { clearInput(); void phoneScreen.enterLandscape(); }));
el('rotate-menu').addEventListener('click', leaveGame);
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
  if (!deviceMode) { el('device-screen').hidden = false; el('lobby').hidden = true; return; }
  const nickname = el<HTMLInputElement>('nickname').value.trim();
  if (!nickname || /[\x00-\x1f\x7f]/.test(nickname)) { toast('Введите ник: от 1 до 16 символов.'); el('nickname').focus(); return; }
  save(); unlockAudio(); inGame = true; online = false; const revision = ++entryRevision; state = lastState = undefined; playerId = room = ''; seq = 0; keys.clear(); firing = false; touchControls.reset(true);
  el('lobby').hidden = true; el('game').hidden = false; el('results').hidden = true; el('waiting').hidden = true;
  el('phase-label').textContent = 'ПОДКЛЮЧЕНИЕ'; el('timer').textContent = '03:00'; el('ping').textContent = '— мс'; el('room-label').textContent = 'ПОИСК КОМНАТЫ'; el('scores').replaceChildren();
  el('game-status').textContent = 'Загружаем 3D-арену…';
  phoneScreen.setActive(deviceMode === 'phone'); syncTouchControls();
  if (deviceMode === 'phone') void phoneScreen.enterLandscape();
  try {
    const { TankRenderer } = await import('./renderer');
    if (!inGame || revision !== entryRevision) return;
    battle = new TankRenderer(el('battle-scene'), angle => aim = angle, pressed => { firing = pressed; sendInput(); }); battle.setTouchMode(deviceMode === 'phone'); battle.setQuality(quality);
  }
  catch { leaveGame(); toast('Для 3D-игры нужен WebGL 2. Обновите браузер и включите аппаратное ускорение.'); return; }
  connection = new Connection({ name: nickname, tank, ...(inviteRoom ? { room: inviteRoom } : { quickPlay: true }) }, {
    status: (message, connected) => { online = connected; el('game-status').textContent = message; el('game-status').classList.toggle('connected', connected); if (!connected) clearInput(); syncTouchControls(); },
    welcome: session => { playerId = session.playerId; room = session.room; el('room-label').textContent = `КОМНАТА ${room}`; const url = new URL(location.href); url.search = ''; url.searchParams.set('room', room); history.replaceState({}, '', url); },
    state: onState,
    error: (message, code) => { toast(message); if (!['RATE_LIMIT','RESTART_UNAVAILABLE'].includes(code)) { leaveGame(); el('play-note').textContent = message; } },
    ping: ms => { el('ping').textContent = `${ms} мс`; el('ping').classList.toggle('high-latency', ms > 180); },
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
    if (deviceMode === 'phone' && mobileInput.aim === undefined) { aim = mine.turret; battle?.setTouchAim(aim); }
    el('my-tank').textContent = names[mine.tank]; el('health-value').innerHTML = `${Math.max(0,mine.hp)} <small>/ ${mine.maxHp}</small>`;
    el('health-bar').style.width = `${Math.max(0, mine.hp / mine.maxHp * 100)}%`; el('health-bar').classList.toggle('critical', mine.hp / mine.maxHp < 0.3);
    el('kill-count').textContent = String(mine.kills); el('respawn').hidden = mine.alive || snapshot.phase !== 'playing';
    el('respawn').textContent = `Танк уничтожен · Возрождение через ${Math.ceil(mine.respawnIn)} с`;
    const reloading = Math.max(0, mine.reloadIn ?? 0);
    el('reload-label').textContent = !mine.alive ? 'ТАНК УНИЧТОЖЕН' : reloading > 0 ? `ПЕРЕЗАРЯДКА ${reloading.toFixed(1)} с` : 'ОРУДИЕ ГОТОВО';
    el('reload-bar').style.width = `${mine.alive ? Math.max(0, Math.min(1, 1 - reloading / cooldown[mine.tank])) * 100 : 0}%`;
    el('reload-track').classList.toggle('ready', mine.alive && reloading === 0);
    const previous = lastState?.players.find(p => p.id === playerId);
    if (previous && mine.hp < previous.hp) { tone(90, 0.22, 0.09); el('damage-flash').classList.add('active'); clearTimeout(damageTimer); damageTimer = setTimeout(() => el('damage-flash').classList.remove('active'), 300); }
    if (previous && mine.kills > previous.kills) toast('Цель уничтожена · +1');
  }
  if (lastState && snapshot.shells.some(s => !lastState!.shells.some(old => old.id === s.id))) tone(160, 0.1, 0.04);
  scoreRows(el('scores'), snapshot); el('results').hidden = snapshot.phase !== 'ended';
  if (snapshot.phase === 'ended') {
    const sorted = [...snapshot.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths), top = sorted[0];
    const draw = top && sorted.filter(p => p.kills === top.kills && p.deaths === top.deaths).length > 1;
    el('winner').textContent = draw ? 'Боевая ничья' : top ? `${top.name} побеждает` : 'Матч завершён'; scoreRows(el('final-scores'), snapshot);
    el<HTMLButtonElement>('restart').disabled = snapshot.players.filter(p => p.connected).length < 2;
  }
  syncTouchControls();
  lastState = snapshot;
}

function leaveGame(): void {
  ++entryRevision; inGame = false; online = false; touchControls.setEnabled(false); phoneScreen.setActive(false); connection?.close(); connection = undefined; battle?.destroy(); battle = undefined; state = lastState = undefined; keys.clear(); firing = false; room = ''; playerId = '';
  document.body.classList.remove('phone-scoreboard-open'); el('mobile-scores').setAttribute('aria-expanded', 'false'); syncTouchControls();
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
function clearInput(): void { keys.clear(); firing = false; touchControls.reset(); document.querySelector('.scoreboard')?.classList.remove('expanded'); connection?.send({ type: 'input', seq: ++seq, forward: 0, turn: 0, aim, fire: false }); }
function sendInput(): void {
  if (!inGame || !online || !state || document.hidden || el<HTMLDialogElement>('settings').open || state.phase === 'ended') return;
  if (deviceMode === 'phone') {
    connection?.send({ type: 'input', seq: ++seq, forward: 0, turn: 0, moveX: mobileInput.moveX, moveZ: mobileInput.moveZ, aim, fire: mobileInput.fire });
    return;
  }
  const down = (...codes: string[]) => codes.some(code => keys.has(code)) ? 1 : 0;
  const horizontal = down('KeyD','ArrowRight') - down('KeyA','ArrowLeft');
  const vertical = down('KeyS','ArrowDown') - down('KeyW','ArrowUp');
  const power = down('ShiftLeft','ShiftRight') ? 0.45 : 1;
  connection?.send({ type: 'input', seq: ++seq,
    forward: controls === 'classic' ? -vertical * power : 0,
    turn: controls === 'classic' ? -horizontal : 0,
    ...(controls === 'directional' ? { moveX: horizontal * power, moveZ: vertical * power } : {}),
    aim, fire: firing || !!down('Space'),
  });
}
window.addEventListener('keydown', event => {
  if (!inGame || deviceMode === 'phone' || el<HTMLDialogElement>('settings').open) return;
  if (actionCodes.has(event.code) || event.code === 'Tab') { event.preventDefault(); if (!event.repeat) { keys.add(event.code); sendInput(); } }
  if (event.code === 'Tab') document.querySelector('.scoreboard')?.classList.add('expanded');
  if (event.code === 'Escape') { clearInput(); el<HTMLDialogElement>('settings').showModal(); }
});
window.addEventListener('keyup', event => { if (keys.delete(event.code)) sendInput(); if (event.code === 'Tab') document.querySelector('.scoreboard')?.classList.remove('expanded'); });
window.addEventListener('blur', clearInput); document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput(); syncTouchControls(); });
setInterval(sendInput, 50);
['settings-open','game-settings'].forEach(id => el(id).addEventListener('click', () => { clearInput(); el<HTMLDialogElement>('settings').showModal(); syncTouchControls(); }));
el('settings-close').addEventListener('click', () => el<HTMLDialogElement>('settings').close());
el('settings').addEventListener('close', syncTouchControls);
el('sound').addEventListener('change', () => { sound = el<HTMLInputElement>('sound').checked; save(); unlockAudio(); tone(400, 0.1); });
el('quality').addEventListener('change', () => { quality = el<HTMLSelectElement>('quality').value as 'low'|'high'; if (deviceMode === 'phone') phoneQuality = quality; else pcQuality = quality; battle?.setQuality(quality); save(); });
el('controls').addEventListener('change', () => { clearInput(); controls = el<HTMLSelectElement>('controls').value as 'directional'|'classic'; save(); });
el('tank-select').addEventListener('change', () => { tank = el<HTMLSelectElement>('tank-select').value as TankKind; el('tank-info').textContent = specs[tank]; save(); });
window.addEventListener('pagehide', () => { inGame = false; online = false; touchControls.setEnabled(false); phoneScreen.setActive(false); connection?.close(); battle?.destroy(); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  connection = undefined; battle = undefined; inGame = false; online = false; state = lastState = undefined; keys.clear(); firing = false; syncTouchControls();
  el('game').hidden = true; el('lobby').hidden = !deviceMode; el('device-screen').hidden = !!deviceMode; inviteRoom = new URLSearchParams(location.search).get('room') || ''; updateInvitation();
});
