// Rendering and input for Starship Captains. Mirrors drillers/js/ui.js: every change
// re-renders #app, except that the game screen is a frame built once whose parts are
// replaced, so a move arriving mid-message can't wipe the chat box or close the keyboard.
import {
  setup, apply, ask, score, winners, neighbours, routesAt, routeEnd, reservedBy,
  damageCount, cargoTokens, canActivate, roomsFor, techChoices, techSlotChoices,
  bonusesFor, techDef, sharedTech, abilities, trainCost, promoteCost, medalsAvailable,
  countIconPairs, locDef, undoable, subordinates, GameError,
} from './engine.js';
import * as D from './data.js';
import { onlineReady, createRoom, getRoom, writeRoom, watchRoom, postChat, markSeen, notify, alertTopic, packSave, unpackSave } from './net.js';

const app = document.getElementById('app');
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const SAVE_VERSION = 2; // bump with state.v in engine.js when the state shape changes
const RULEBOOK = 'https://czechgames.com/en/starship-captains/';
const OFFLINE = 'Could not reach the game server. Check your connection and try again.';
const RELOADING = 'Reloading the game, try again in a moment.';

const openSections = new Set(['turn', 'map']);
const keepOpen = (name) => `data-keep="${name}"${openSections.has(name) ? ' open' : ''}`;
app.addEventListener('toggle', (e) => {
  const name = e.target.dataset?.keep;
  if (name) e.target.open ? openSections.add(name) : openSections.delete(name);
}, true);

let session = null;
let message = '';
let passCurtain = null;   // local mode: whose turn we're waiting to hand the phone to
let pendingMove = null;   // { mode:'local', state } from a #move= link
let seatPick = null;      // { code, room } while choosing a seat
let busy = false;
let assigning = null;     // { id, at, crew: [] } while picking crew for a mission
let artPick = [];         // cargo slots ticked to spend two artifacts on a room

const esc = (x) => String(x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const savedState = (st) => (st?.v === SAVE_VERSION ? st : null);
const gameLink = (hash) => `${location.origin}${location.pathname}#${hash}`;
const reloading = () => session.mode === 'online' && session.seq < 0;

// ---------- names for the pieces ----------
const FIG = { r: '🔴 red ensign', y: '🟡 yellow ensign', b: '🔵 blue ensign', g: '⚪ cadet',
  R: '🔴 RED COMMANDER', Y: '🟡 YELLOW COMMANDER', B: '🔵 BLUE COMMANDER', A: '🤖 android' };
const figName = (f) => FIG[f] ?? f;
const figShort = (f) => ({ r: '🔴', y: '🟡', b: '🔵', g: '⚪', R: '🔴◉', Y: '🟡◉', B: '🔵◉', A: '🤖' }[f] ?? f);
const COLOR_NAME = { r: 'red', y: 'yellow', b: 'blue', gray: 'gray', gold: 'gold' };
const ART = { rb: '🟥🟦', ry: '🟥🟨', by: '🟦🟨' };
const locName = (id) => locDef(id)?.name ?? id;
const missionDef = (id) => D.missionDef(id);
const trackName = (t) => D.FACTIONS[t].name;

// Component images live in img/, named by the ids in data.js (see CLAUDE.md).
const pic = (path) => `<button class="small secondary pic" data-img="img/${path}.webp" title="Picture">🖼</button>`;

function showImage(src) {
  const box = document.createElement('div');
  box.className = 'imgview';
  box.innerHTML = `<img src="${esc(src)}" alt=""><button class="secondary">Close</button>`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

// ---------- lobby ----------
function renderLobby() {
  const online = LS.get('captains.online');
  const local = savedState(LS.get('captains.local'));
  const name = LS.get('captains.name') || '';
  app.innerHTML = `
    <section class="lobby">
      <h1>Starship Captains</h1>
      <p class="muted">Unofficial fan implementation for playing with a friend. Own the real game!
        <a href="${RULEBOOK}" target="_blank" rel="noopener">About the game</a></p>
      <label for="name">Your name</label>
      <input id="name" value="${esc(name)}" maxlength="16" placeholder="Captain">
      <div class="box">
        <h2>Play online</h2>
        ${onlineReady ? `
        <p class="muted">Every move is saved online: play live, or a move every few hours, on any phone or laptop.</p>
        <button data-lobby="create">Create a new game</button>
        <div class="row">
          <input id="code" maxlength="8" placeholder="GAME CODE" autocapitalize="characters">
          <button data-lobby="join">Join</button>
        </div>
        ${online ? `<button class="secondary" data-lobby="resumeOnline">Resume game ${esc(online.code)}</button>` : ''}`
        : '<p class="muted">Online play isn\'t set up yet.</p>'}
      </div>
      <div class="box">
        <h2>Pass &amp; play on this phone</h2>
        <input id="p2" maxlength="16" placeholder="Second player's name">
        <button data-lobby="local">Start local game</button>
        ${local ? '<button class="secondary" data-lobby="resumeLocal">Resume local game</button>' : ''}
      </div>
    </section>`;
}

function myName() {
  const input = document.getElementById('name');
  if (!input) return LS.get('captains.name') || 'Captain';
  const n = input.value.trim() || 'Captain';
  LS.set('captains.name', n);
  return n;
}

async function lobbyTask(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } finally { busy = false; }
}

function startLocal(state) {
  session = { mode: 'local', state };
  LS.set('captains.local', state);
  message = '';
  passCurtain = null;
  resetTurnUi();
  render();
}

// ---------- online ----------
async function createOnline() {
  let code;
  try { code = await createRoom(myName()); } catch (e) { console.warn(e); alert(OFFLINE); return; }
  startOnline(code, 0);
}

async function openOnline(code) {
  const saved = LS.get('captains.online');
  if (saved?.code === code) { startOnline(code, saved.seat); return; }
  let room;
  try { room = await getRoom(code); } catch (e) { console.warn(e); alert(OFFLINE); return; }
  if (!room) { alert(`No game found with code ${code}.`); return; }
  if (room.state && !savedState(room.state)) { alert('That game was saved by an older version and cannot be loaded.'); return; }
  seatPick = { code, room };
  render();
}

function renderSeatPick() {
  const { code, room } = seatPick;
  app.innerHTML = room.state
    ? `<section class="lobby"><h1>Game ${esc(code)}</h1><p>Which captain are you on this device?</p>
      ${room.state.players.map((p, i) => `<button data-lobby="seat" data-seat="${i}">${esc(p.name)}</button>`).join('')}
      <button class="secondary" data-lobby="leave">Cancel</button></section>`
    : `<section class="lobby"><h1>Join game ${esc(code)}</h1><p><b>${esc(room.host)}</b> is waiting for a second captain.</p>
      <label for="name">Your name</label>
      <input id="name" value="${esc(LS.get('captains.name') || '')}" maxlength="16" placeholder="Captain">
      <button class="primary" data-lobby="joinSeat">Join the game</button>
      <button class="secondary" data-lobby="leave">Cancel</button></section>`;
}

async function joinAsSecond() {
  const { code, room } = seatPick;
  const state = setup({ names: [room.host, myName()], seed: Math.floor(Math.random() * 2 ** 31) });
  let ok;
  try { ok = await writeRoom(code, { seq: room.seq + 1, host: room.host, state }); } catch (e) { console.warn(e); alert(OFFLINE); return; }
  if (ok) startOnline(code, 1);
  else await openOnline(code);
}

function startOnline(code, seat) {
  seatPick = null;
  LS.set('captains.online', { code, seat });
  const read = LS.get('captains.chatRead');
  const me = { mode: 'online', code, seat, host: '', state: null, confirmed: null, seq: -1,
    status: 'Connecting…', saving: Promise.resolve(), gen: 0,
    chat: [], chatRead: read?.code === code ? read.id : '' };
  session = me;
  me.net = watchRoom(code, {
    onRoom: (room) => { if (session === me) receive(me, room); },
    onChat: (msgs) => {
      if (session !== me) return;
      me.chat = msgs;
      if (document.activeElement?.id === 'chat-text') readChat();
      render();
    },
    onStatus: (st) => { if (session === me) { me.status = st; render(); } },
  });
  me.beat = setInterval(() => { if (present()) markSeen(code, seat, true); }, 30000);
  markSeen(code, seat, present());
  render();
}

const present = () => document.visibilityState === 'visible' && document.hasFocus();

function presenceChanged() {
  if (session?.mode !== 'online') return;
  if (document.visibilityState === 'visible') session.net.resume();
  markSeen(session.code, session.seat, present());
}
document.addEventListener('visibilitychange', presenceChanged);
addEventListener('focus', presenceChanged);
addEventListener('blur', presenceChanged);

function receive(me, room) {
  if (!room) { me.status = 'This game no longer exists.'; render(); return; }
  const state = room.state && savedState(room.state);
  if (room.state && !state) { me.status = 'This game was saved by an older version and cannot continue.'; render(); return; }
  if (room.seq <= me.seq) return;
  if (me.seq >= 0) message = '';
  if (me.state?.current !== state?.current) resetTurnUi();
  Object.assign(me, { seq: room.seq, host: room.host, state, confirmed: state });
  render();
}

function save(me, prev, next) {
  const room = { seq: ++me.seq, host: me.host, state: next };
  const gen = me.gen;
  me.saving = me.saving.then(async () => {
    if (me.gen !== gen) return;
    let ok = false;
    try { ok = await writeRoom(me.code, room); } catch {}
    if (ok) { me.confirmed = next; alertOthers(me, prev, next); return; }
    me.gen++;
    Object.assign(me, { seq: -1, state: me.confirmed });
    if (session !== me) return;
    message = 'Your last move did not save (offline, or the game changed on another device). Reloading the game…';
    resetTurnUi();
    render();
    me.net.resume();
  });
}

function alertOthers(me, prev, next) {
  const link = gameLink(`room=${me.code}`);
  if (next.over && !prev.over) {
    next.players.forEach((p, i) => { if (i !== me.seat) notify(me.code, i, `Game over: ${resultText(next)}.`, link); });
  } else if (!next.over && next.current !== prev.current && next.current !== me.seat) {
    notify(me.code, next.current, `Your turn against ${next.players[me.seat].name}.`, link);
  }
}

// ---------- chat ----------
function readChat() {
  const last = session.chat.at(-1)?.id;
  if (!last || last <= session.chatRead) return;
  session.chatRead = last;
  LS.set('captains.chatRead', { code: session.code, id: last });
}

async function sendChat(me, input) {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  readChat();
  try {
    await postChat(me.code, me.seat, text);
  } catch {
    if (!input.value) input.value = text;
    message = 'Your message did not send. Check your connection and try again.';
    if (session === me) render();
    return;
  }
  const link = gameLink(`room=${me.code}`);
  me.state.players.forEach((p, i) => { if (i !== me.seat) notify(me.code, i, `${me.state.players[me.seat].name}: ${text}`, link, 'speech_balloon'); });
}

function chatHtml(s, seat) {
  const msgs = session.chat.slice(-100).reverse();
  return `<div class="chat-log">${msgs.length
    ? msgs.map((m) => `<div class="${m.seat === seat ? 'me' : ''}"><b>${esc(s.players[m.seat]?.name ?? '?')}</b> ${esc(m.text)}</div>`).join('')
    : '<div>No messages yet.</div>'}</div>`;
}

function leave() {
  if (session?.net) {
    session.net.close();
    clearInterval(session.beat);
    markSeen(session.code, session.seat, false);
  }
  session = null;
  seatPick = null;
  message = '';
  resetTurnUi();
  render();
}

// ---------- move to another device ----------
async function moveDevice() {
  let url;
  try {
    url = gameLink(`move=${await packSave({ mode: 'local', state: session.state })}`);
  } catch (e) {
    console.error(e);
    message = 'Could not make a link in this browser.';
    render();
    return;
  }
  session = { mode: 'moved', url };
  message = '';
  render();
}

function renderMoved() {
  app.innerHTML = `<section class="lobby"><h1>Move this game</h1>
    <p>Open this link on your other device.</p>
    <input readonly value="${esc(session.url)}">
    ${navigator.share ? `<button data-lobby="share" data-text="${esc(session.url)}">Share link…</button>` : ''}
    <button class="${navigator.share ? 'secondary' : ''}" data-lobby="copy" data-text="${esc(session.url)}">Copy link</button>
    ${message ? `<p class="status">${esc(message)}</p>` : ''}
    <button class="secondary" data-lobby="leave">Back to menu</button></section>`;
}

function renderPendingMove() {
  const names = pendingMove.state.players.map((p) => esc(p.name)).join(' vs ');
  app.innerHTML = `<section class="lobby"><h1>Load moved game?</h1>
    <p>${names}, round ${pendingMove.state.round}.</p>
    <p class="muted">This replaces the pass &amp; play game saved on this device. Close the game on the old device first.</p>
    <button class="primary" data-lobby="acceptMove">Load it here</button>
    <button class="secondary" data-lobby="rejectMove">Cancel</button></section>`;
}

const startHash = globalThis.location?.hash || '';
if (startHash.startsWith('#move=') || startHash.startsWith('#room=')) history.replaceState(null, '', location.pathname + location.search);
if (startHash.startsWith('#move=')) {
  unpackSave(startHash.slice(6))
    .then((m) => {
      const state = savedState(m.state);
      if (state && m.mode === 'local') pendingMove = { mode: 'local', state };
      else alert('That link is from an older version of the game and cannot be loaded.');
    })
    .catch(() => alert('That move link is broken or incomplete.'))
    .then(render);
}
if (startHash.startsWith('#room=') && onlineReady) lobbyTask(() => openOnline(startHash.slice(6).toUpperCase()));

// ---------- state changes ----------
function resetTurnUi() { assigning = null; artPick = []; }

function show(next) {
  const prev = session.state;
  session.state = next;
  message = '';
  if (session.mode === 'online') save(session, prev, next);
  if (session.mode === 'local') {
    LS.set('captains.local', next);
    if (next.current !== prev.current && !next.over) passCurtain = next.current;
  }
  if (next.current !== prev.current) resetTurnUi();
  render();
}

function act(action) {
  const s = session.state;
  if (reloading()) { message = RELOADING; render(); return; }
  const seat = session.mode === 'local' ? s.current : session.seat;
  try {
    show(apply(s, { ...action, p: seat }));
  } catch (e) {
    message = e instanceof GameError ? e.message : 'Something went wrong.';
    if (!(e instanceof GameError)) console.error(e);
    render();
  }
}

const btn = (label, action, opts = {}) =>
  `<button class="${opts.cls ?? ''}" data-act='${esc(JSON.stringify(action))}'${opts.off ? ' disabled' : ''}>${label}</button>`;
const choose = (label, opt, opts = {}) => btn(label, { type: 'choose', opt }, opts);

// ---------- the open question ----------
// Everything the pending machine can ask, as big buttons. Nothing else on the screen is
// usable while a question is open, so this comes first.
function askHtml(s, p) {
  const f = ask(s);
  if (!f) return '';
  const body = {
    move: () => `${routesAt(p.at).map((r) => {
      const loc = routeEnd(r, p.at);
      return choose(`${esc(locName(loc))}${s.pirates[r] ? ` \u2620 ${esc(s.pirates[r].c)}` : ''}${whatsAt(s, loc)}`, loc);
    }).join('')}
      ${f.orRepair ? choose('Repair 1 instead', 'repair', { cls: 'secondary' }) : ''}
      ${choose('Stay put', 'skip', { cls: 'secondary' })}`,
    jump: () => `${D.LOCS.filter((l) => l.id !== p.at).map((l) => choose(`${esc(l.name)}${whatsAt(s, l.id)}`, l.id)).join('')}
      ${f.orRepair ? choose('Repair 1 instead', 'repair', { cls: 'secondary' }) : ''}
      ${choose('Stay put', 'skip', { cls: 'secondary' })}`,
    fight: () => {
      const here = routesAt(p.at).filter((i) => s.pirates[i]);
      return here.length
        ? `${here.map((i) => choose(`${esc(pirate(s.pirates[i]))} towards ${esc(locName(routeEnd(i, p.at)))}`, i)).join('')}
           ${choose('Do not fight', 'skip', { cls: 'secondary' })}`
        : `<p class="muted">No pirate on any route from here.</p>${choose('Continue', 'skip')}`;
    },
    repair: () => `${p.excess ? choose(`Excess damage (${p.excess})`, { zone: 'excess' }) : ''}
      ${p.cargo.map((c, i) => (c?.t === 'dmg' && !p.excess ? choose(`Cargo slot ${i + 1}`, { zone: 'cargo', i }) : '')).join('')}
      ${p.techSlots.map((sl, i) => (sl.dmg ? choose(`Tech slot ${i + 1}`, { zone: 'tech', i }) : '')).join('')}
      ${Object.keys(p.roomDmg).filter(() => !p.excess).map((id) => choose(`${esc(D.ROOMS.find((r) => r.id === id).name)} room`, { zone: 'room', i: id })).join('')}
      ${p.excess ? '<p class="muted">Excess damage sits on top of full cargo slots, so no cargo slot can be cleared until it is gone \u2014 but a tech slot can be repaired instead.</p>' : ''}`,
    bump: () => `<p>No room for the damage. Jettison something:</p>
      ${p.cargo.map((c, i) => (c && c.t !== 'dmg' ? choose(tokenName(c), i) : '')).join('')}`,
    stow: () => `<p>No room for ${tokenName(f.tok)}. Jettison something, or leave it behind:</p>
      ${p.cargo.map((c, i) => (c && c.t !== 'dmg' ? choose(tokenName(c), i) : '')).join('')}
      ${choose('Leave it behind', 'drop', { cls: 'secondary' })}`,
    track: () => `${D.FACTIONS.map((fa) => choose(`${esc(fa.name)}${f.suggest === fa.id ? ' (as printed)' : ''}`, fa.id)).join('')}`,
    tech: () => techAskHtml(s, p, f),
    peekMissions: () => `<p>Choose which mission comes up next:</p>
      ${f.pool.map((id) => choose(missionLabel(id), id)).join('')}`,
    line: () => {
      const mf = missionFrame(s);
      const m = mf && missionDef(mf.id);
      const line = m?.lines[f.line];
      const fig = mf?.crew?.[f.line];
      return `<p><b>${m ? esc(m.name) : 'This mission'}</b>${m ? ` ${pic('missions/' + mf.id)}` : ''}
          \u2014 line ${f.line + 1} of ${m ? m.lines.length : '?'}${fig ? `, assigned ${figName(fig)}` : ''}</p>
        <p>${line ? esc(lineText(line)) : ''}</p>
        <p class="muted">${line && lineCost(line)
          ? `Careful: ${esc(lineCost(line))}.`
          : 'Nothing here can hurt you, but every line is optional.'}
          Skipping resolves nothing from this line \u2014 the mission still completes and still scores.</p>
        ${choose('Resolve it', 'take')} ${choose('Skip the line', 'skip', { cls: 'secondary' })}`;
    },
    second: () => secondAskHtml(s, p, f),
    branch: () => f.either.map((fx, i) => choose(esc(fxText(fx)), i)).join(''),
    pay: () => payAskHtml(s, p, f),
    takeArt: () => `${choose('Take the artifact', 'take')} ${choose('Leave it', 'skip', { cls: 'secondary' })}`,
    freeTrain: () => `<p>Free training — pick a crew member, then a colour:</p>
      ${p.ready.filter((x) => x === D.CADET || D.ENSIGNS.includes(x)).map((from) =>
        D.ENSIGNS.filter((to) => to !== from).map((to) =>
          choose(`${figShort(from)} → ${figShort(to)}`, { from, to })).join('')).join('')}
      ${choose('No thanks', 'skip', { cls: 'secondary' })}`,
  }[f.q];
  return `<section class="box ask"><h2>${esc(ASK_TITLE[f.q] ?? 'Choose')}</h2>
    <div class="btns">${body ? body() : choose('Continue', 'skip')}</div></section>`;
}

const ASK_TITLE = {
  move: 'Move where?', jump: 'Jump where?', fight: 'Fight a pirate?', repair: 'Repair what?',
  bump: 'Make room', stow: 'No room aboard', track: 'Which faction track?',
  tech: 'Research a tech', peekMissions: 'Choose the next mission', line: 'Resolve this line?',
  second: "Commander's second task", branch: 'Choose one', pay: 'Spend something?',
  takeArt: 'An artifact was left here', freeTrain: 'Free training',
};

// A short note of what is waiting at a planet, so you know before you fly there.
function whatsAt(s, loc) {
  const bits = [];
  const m = s.missions[loc];
  if (m) bits.push(`${D.missionDef(m).name} (${D.missionDef(m).pts})`);
  if (s.tiles[loc]) bits.push(`tile ${s.tiles[loc].n}`);
  const st = Object.entries(s.stations).find(([, x]) => x.at === loc && x.out);
  if (st) bits.push(D.STATION_TILES.find((t) => t.id === st[0]).name);
  return bits.length ? ` — ${esc(bits.join(', '))}` : '';
}

// A pirate token: the exhaust colour decides which route it can ambush onto, and the
// ship side is face up, so what it pays out is public before you decide to fight it.
const REWARD = { android: '\ud83e\udd16 android', medalArt: '\ud83c\udf96+\u2b22' };
const REWARD_GLYPH = { android: '\ud83e\udd16', medalArt: '\ud83c\udf96' };
// The token's reward side, so you can see what beating it pays before committing.
const rewardPic = (tok) => `img/tokens/pirate_${tok.reward === 'android' ? 'android' : 'medalart'}.webp`;
const pirate = (tok) => (tok ? `\u2620 ${tok.c} (${REWARD[tok.reward] ?? tok.reward})` : '');

const tokenName = (c) => (c?.t === 'art' ? `Artifact ${ART[c.id] ?? ''}` : c?.t === 'pir' ? 'Pirate token ☠' : 'Damage');
// The mission being resolved sits in a {k:'mission'} frame under whatever question is on
// top of the stack, so that is where a question finds out which card it belongs to.
const missionFrame = (s) => [...(s.pending ?? [])].reverse().find((f) => f.k === 'mission') ?? null;

function techAskHtml(s, p, f) {
  const cards = techChoices(s, f);
  const slots = techSlotChoices(p, f);
  if (!cards.length || !slots.length) {
    return `<p class="muted">${!slots.length ? 'No free tech slot — repair one first.' : 'No tech available.'}</p>${choose('Continue', 'skip')}`;
  }
  return `${cards.map((card) => {
    const d = techDef(card);
    return `<div class="tech-opt"><b>${esc(d.name)}</b> ${pic('techs/' + card)}
      ${d.text ? `<div class="muted">${esc(d.text)}</div>` : ''}
      <div class="btns">${slots.map((i) => {
        const bonus = bonusesFor(s, p, i, d).map(bonusName).join(' + ');
        const taken = p.techSlots[i].tech ? ` (recycle ${esc(techDef(p.techSlots[i].tech).name)})` : '';
        return choose(`Slot ${i + 1}${taken}${bonus ? ` — ${bonus}` : ''}`, { card, slot: i });
      }).join('')}</div></div>`;
  }).join('')}
  ${choose('Research nothing', 'skip', { cls: 'secondary' })}`;
}

// Your tech-slot board, drawn as the physical board reads: each slot between its two
// edges, with the junctions between slots showing which icons line up. A matching pair
// is what pays out when a card goes in, and what the omega Starship Schematics scores,
// so you need to see it before choosing a slot - not after.
const ICON = { rep: '\ud83d\udd27', med: '\ud83c\udf96', mov: '\u27a1\ufe0f' };

// Your tech-slot board, laid out left to right like the physical component: slots side
// by side with the three connectors between each pair, on fixed rows, so a match reads
// as two filled dots facing each other on the same row. Only facing edges can ever pay,
// so the outer edges of the first and last slot are left off - they match nothing.
function techSlotsHtml(s, p, mine) {
  const side = (i, k) => {
    const t = p.techSlots[i].tech;
    return (t ? techDef(t) : D.SLOT_BOARD[i])[k] ?? [];
  };
  const slot = (sl, i) => {
    const d = sl.tech && techDef(sl.tech);
    return `<div class="tslot${sl.dmg ? ' dmg' : ''}">
      <div class="muted">Slot ${i + 1}${sl.dmg ? ' 💥' : ''}</div>
      ${d ? `<b>${esc(d.name)}</b> ${pic('techs/' + sl.tech)}${sl.art ? '<div class="tag">⬢</div>' : ''}`
          : `<span class="muted">${sl.dmg ? 'damaged' : 'empty'}</span>`}</div>`;
  };
  // Between slot i and i+1: slot i's right edge facing slot i+1's left edge.
  const junction = (i) => {
    const L = side(i, 'R');
    const R = side(i + 1, 'L');
    return `<div class="junction">${D.BONUS_ICONS.map((ic) => {
      const hit = L.includes(ic) && R.includes(ic);
      return `<div class="jrow${hit ? ' live' : ''}" title="${esc(bonusName(ic))}">
        <span class="dotl">${L.includes(ic) ? '●' : '·'}</span>
        <span class="jic">${ICON[ic]}</span>
        <span class="dotr">${R.includes(ic) ? '●' : '·'}</span></div>`;
    }).join('')}</div>`;
  };
  const strip = p.techSlots.map((sl, i) =>
    slot(sl, i) + (i < p.techSlots.length - 1 ? junction(i) : '')).join('');
  // The cards' own wording would make the boxes far too tall, so it goes underneath.
  const notes = p.techSlots.map((sl, i) => {
    const d = sl.tech && techDef(sl.tech);
    if (!d) return '';
    return `<div class="slotnote"><b>${i + 1}. ${esc(d.name)}</b>
      ${d.text ? `<span class="muted">${esc(d.text)}</span>` : ''}
      ${d.room ? `<span class="tag room-${d.room}">Room: ${esc(fxText(d.fx))}</span>` : ''}
      ${d.discard ? `<span class="muted">Discard to: ${esc(fxText(d.discard))}</span>` : ''}</div>`;
  }).join('');
  const pairs = countIconPairs(p);
  return `<h3>Tech slots ${pic('slotboard')}</h3>
    <div class="slotstrip">${strip}</div>
    ${notes}
    ${mine ? `<p class="muted">A connector pays out only where the <b>same</b> row is filled on
      both facing edges (●&nbsp;●). ${pairs} matching pair${pairs === 1 ? '' : 's'} right now;
      pairs also score if you hold Starship Schematics.</p>` : ''}`;
}

const bonusName = (ic) => ({ rep: '🔧 repair', med: '🎖 medal', mov: '➡️ move' }[ic] ?? ic);

function secondAskHtml(s, p, f) {
  const cmd = f.fig;
  const subs = subordinates(p, cmd);
  const rooms = f.line === undefined ? roomsFor(s, p).filter((r) => canActivate(cmd, r)) : [];
  return `<p>${figName(cmd)} can do a second task.</p>
    ${f.line !== undefined ? choose('Resolve that mission line again', 'extra') : ''}
    ${rooms.map((r) => choose(`Work ${esc(r.name)} again`, { room: r.id })).join('')}
    ${subs.length ? `<p class="muted">Or call a subordinate up from the queue:</p>` : ''}
    ${[...new Set(subs)].map((x) => choose(`Call up ${figName(x)}`, x)).join('')}
    ${choose('Nothing', 'skip', { cls: 'secondary' })}`;
}

function payAskHtml(s, p, f) {
  const gain = fxText(f.then);
  if (f.cost === 'tech') {
    const slots = p.techSlots.map((sl, i) => [sl, i]).filter(([sl]) => sl.tech);
    return `<p>Give up an installed tech to ${esc(gain)}?</p>
      ${slots.map(([sl, i]) => choose(`Give up ${esc(techDef(sl.tech).name)} (slot ${i + 1})`, i)).join('')}
      ${slots.length ? '' : '<p class="muted">You have no tech installed.</p>'}
      ${choose('No thanks', 'skip', { cls: 'secondary' })}`;
  }
  const want = f.cost === 'artifact' ? 'art' : f.cost === 'pirateTok' ? 'pir' : 'medal';
  if (want === 'medal') {
    return `<p>Spend 1 medal to ${esc(gain)}?</p>
      ${choose('Spend a medal', 'pay', { off: medalsAvailable(s, p) < 1 })}
      ${choose('No thanks', 'skip', { cls: 'secondary' })}`;
  }
  const have = p.cargo.map((c, i) => [c, i]).filter(([c]) => c?.t === want);
  return `<p>Spend ${f.cost === 'artifact' ? 'an artifact' : 'a pirate token'} to ${esc(gain)}?</p>
    ${have.map(([c, i]) => choose(`Spend ${tokenName(c)}`, i)).join('')}
    ${have.length ? '' : '<p class="muted">You have none to spend.</p>'}
    ${choose('No thanks', 'skip', { cls: 'secondary' })}`;
}

// ---------- describing effects ----------
// Effects in plain English. The ones that take a number read better with it folded into
// the sentence ("advance 2 on the Tincan track") than tacked on as a multiplier.
const EFFECT_N = {
  coop: (n) => `advance ${n} on the Cooperative track`,
  tincan: (n) => `advance ${n} on the Tincan track`,
  nian: (n) => `advance ${n} on the Ni'an track`,
  anyTrack: (n) => `advance ${n} on any track`,
  anyTrackNB: (n) => `advance ${n} on any track, gaining no bonuses`,
  repair: (n) => `repair ${n}`,
  damage: (n) => `take ${n} damage`,
  medal: (n) => `gain ${n} medal${n > 1 ? 's' : ''}`,
  artifact: (n) => `draw ${n} artifact${n > 1 ? 's' : ''}`,
  pirateTok: (n) => `take ${n} pirate token${n > 1 ? 's' : ''}`,
  fight: (n) => (n > 1 ? `fight ${n} pirates` : 'fight a pirate'),
};

const EFFECT = {
  move: 'move', jump: 'jump', fightSafe: 'fight a pirate, ignoring the damage',
  android: 'gain an android', cadet: 'gain a cadet',
  queue: 'call the front of your queue to the ready room', ambush: 'a pirate appears',
  anyTrack1x2: 'advance 1 on any track, twice',
  tech: 'research a tech', techR: 'research or recycle a tech',
  techNB: 'research a tech, but gain no tech bonuses',
  drawTech3: 'draw 3 techs and research one', drawOmega3: 'draw 3 omega techs and research one',
  peekMissions3: 'look at the top 3 missions', trackPerAndroid: 'advance 1 on any track per android in your crew',
  ignoreMissionDamage: 'ignore all damage on this mission',
  freeTrain: 'train a crew member for free', event: '', ignoreDamage1: 'ignore 1 damage',
};

function fxText(fx) {
  if (!fx) return '';
  return fx.map((tok) => {
    if (Array.isArray(tok)) {
      const [k, n] = tok;
      if (EFFECT_N[k]) return EFFECT_N[k](n ?? 1);
      const base = EFFECT[k] ?? k;
      return n > 1 ? `${base} \u00d7${n}` : base;
    }
    if (typeof tok === 'object') {
      if (tok.either) return tok.either.map((b) => fxText(b)).join(' OR ');
      if (tok.pay) {
        const what = { pirateTok: 'a pirate token', artifact: 'an artifact', medal: 'a medal', tech: 'an installed tech' }[tok.pay] ?? tok.pay;
        return `give up ${what} to ${fxText(tok.then)}`;
      }
      return '?';
    }
    if (EFFECT_N[tok]) return EFFECT_N[tok](1);
    return EFFECT[tok] ?? tok;
  }).filter(Boolean).join(', ');
}

// What makes a line refusable, named so the question doesn't just say "it costs you
// something". Mirrors lineCanHurt in engine.js: damage and ambushes are the involuntary
// parts, everything else on a line can only help.
function lineCost(line) {
  const bad = [];
  const walk = (fx) => {
    for (const tok of fx ?? []) {
      if (tok && !Array.isArray(tok) && typeof tok === 'object') { walk(tok.then); continue; }
      const [k, n] = Array.isArray(tok) ? tok : [tok, 1];
      if (k === 'damage') bad.push(`${n} damage`);
      if (k === 'ambush') bad.push('a pirate appears');
    }
  };
  walk(line.fx);
  const counted = {};
  for (const b of bad) counted[b] = (counted[b] ?? 0) + 1;
  return Object.entries(counted).map(([b, n]) => (n > 1 ? `${b} \u00d7${n}` : b)).join(', ');
}

const lineText = (line) => `${COLOR_NAME[line.c] ?? line.c}: ${fxText(line.fx)}`;
// A finished mission, for the ship panel: its name, a dot per line colour (so a colour
// count can be read off without opening anything) and a button for the card itself.
const doneMission = (id) => {
  const m = missionDef(id);
  const dots = m.lines.map((l) => `<span class="ldot line-${l.c}" title="${esc(COLOR_NAME[l.c] ?? l.c)}"></span>`).join('');
  return `<span class="donem">${esc(m.name)} <span class="pts">${m.pts}</span>${dots}${pic('missions/' + id)}</span>`;
};

const missionLabel = (id) => {
  const m = missionDef(id);
  return `${esc(m.name)} (${m.pts})`;
};

function missionHtml(s, id, extra = '') {
  const m = missionDef(id);
  return `<div class="card"><b>${esc(m.name)}</b> <span class="pts">${m.pts}</span> ${pic('missions/' + id)}
    ${m.lines.map((l) => `<div class="line line-${l.c}">${esc(lineText(l))}</div>`).join('')}
    ${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}${extra}</div>`;
}

// ---------- the board, as a list ----------
// A map is unreadable at phone width, so the board is a list: the routes you can actually
// take first, then everything else, nearest first.
// The board photo with the live game drawn on it: a marker per planet showing its mission,
// its tile, a station and any ships. Routes aren't marked - they curve too much for a
// straight-line midpoint to be honest - so pirates stay in the list below.
function mapHtml(s, p) {
  const pins = Object.entries(D.MAP).map(([id, [x, y]]) => {
    const chips = [];
    const mission = s.missions[id];
    const tile = s.tiles[id];

    if (mission) {
      const m = missionDef(mission);
      chips.push(`<button class="chip mi" data-img="img/missions/${mission}.webp" title="${esc(m.name)} \u2014 ${m.pts} points">${m.pts}</button>`);
    }
    if (tile) {
      chips.push(`<button class="chip ti${tile.up ? '' : ' dn'}" data-img="img/tiles/${tile.up ? 'up' : 'dn'}${tile.n}.webp" title="Tile ${tile.n}${tile.up ? '' : ', face down'}">${tile.n}</button>`);
    }
    for (const [sid, st] of stationsAt(s, id)) {
      const def = D.STATION_TILES.find((t) => t.id === sid);
      chips.push(`<button class="chip st ${def.id}${st.out ? '' : ' used'}" data-img="img/tiles/st_${def.id}.webp"
        title="${esc(def.name)}${st.out ? `: ${esc(fxText(def.fx))}` : ' \u2014 tile used, back next round'}"
        >${st.out ? '\u2b22' : '\u2b21'}</button>`);
      if (st.bounty) chips.push(`<span class="chip bounty" title="${esc(BOUNTY[st.bounty].help)}">${BOUNTY[st.bounty].chip}</span>`);
    }
    for (const q of s.players.filter((q) => q.at === id)) {
      chips.push(`<span class="chip sh${q === p ? ' me' : ''}" title="${esc(q.name)}">\u{1F680}\u202f${esc(q.name)}</span>`);
    }
    return chips.length ? `<div class="pin" style="left:${x}%;top:${y}%">${chips.join('')}</div>` : '';
  }).join('');
  return `<details ${keepOpen('map')}><summary>Board picture</summary>
    <div class="galaxy"><img src="img/board.webp" alt="The galaxy">${pirateOverlay(s)}${pins}</div>
    <p class="muted">Tap a marker for the card. A \u2620 sits on a straight line between the two planets it blocks,
      which is not the curve printed on the board \u2014 the line shows which route it is. The list below says what kind.</p>
  </details>`;
}

// Pirates on the map. The printed routes curve so much that a marker placed at a straight
// midpoint can land on a different planet, so instead of guessing where the curve goes the
// overlay draws its own straight line between the two planets and puts the skull on that.
// The line is what makes the route unambiguous; it is not pretending to be the printed one.
function pirateOverlay(s) {
  const here = s.pirates.map((tok, i) => (tok ? { tok, r: D.ROUTES[i] } : null)).filter(Boolean);
  if (!here.length) return '';
  const lines = [];
  const skulls = [];
  for (const { tok, r } of here) {
    const [ax, ay] = D.MAP[r.a];
    const [bx, by] = D.MAP[r.b];
    // The skull sits ON the line, so it always reads as belonging to it. The midpoint is
    // first choice, but some straight lines pass over a third planet (Green-Rust runs right
    // through Frost), so slide along the line and keep the spot furthest from every other
    // planet rather than pushing the skull sideways off its own line.
    const others = Object.entries(D.MAP).filter(([id]) => id !== r.a && id !== r.b).map(([, xy]) => xy);
    const clearance = (x, y) => Math.min(...others.map(([px, py]) => Math.hypot(px - x, py - y)));
    const at = (t) => [ax + (bx - ax) * t, ay + (by - ay) * t];
    const [mx, my] = clearance(...at(0.5)) >= 7 ? at(0.5)
      : [0.38, 0.62, 0.3, 0.7, 0.25, 0.75, 0.5].map(at).sort((u, v) => clearance(...v) - clearance(...u))[0];
    const title = `Pirate between ${esc(locName(r.a))} and ${esc(locName(r.b))}: ${esc(pirate(tok))}. Fighting it costs 1 damage.`;
    lines.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"><title>${title}</title></line>`);
    skulls.push(`<button class="pskull" style="left:${mx}%;top:${my}%" data-img="${rewardPic(tok)}" title="${title}">${REWARD_GLYPH[tok.reward] ?? '\u2620'}</button>`);
  }
  return `<svg class="plines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines.join('')}</svg>${skulls.join('')}`;
}

// Every station on a planet, tile out or not. An event can leave a bounty on a station,
// and that bounty pays the next player to END a turn there regardless of the tile.
const stationsAt = (s, id) => Object.entries(s.stations).filter(([, st]) => st.at === id);
const BOUNTY = {
  medal: { tag: '\u{1F396} medal waiting', chip: '\u{1F396}', help: 'An event left a medal here. End your turn on this planet to take it.' },
  damageAndTrack: { tag: '\u{1F4A5} charge waiting', chip: '\u{1F4A5}', help: 'An event left a charge here. End your turn on this planet and you take the damage, then advance 1 on a track of your choice.' },
};

// What sits on a planet, as tags with a picture button each. Used by both board tables, so
// a planet with nothing on it says so rather than just showing a blank cell.
const TILE_NOTE = 'Numbered tiles are the countdown to the pirate uprising. '
  + 'Finishing a mission moves the highest face-up tile onto that planet, face down; '
  + 'when tile 1 goes face down the uprising fires and all five turn face up again. '
  + 'A tile on a planet is also what stops a new mission being dealt there.';

function spotHtml(s, id) {
  const bits = [];
  const mission = s.missions[id];
  const tile = s.tiles[id];
  bits.push(mission
    ? `<span class="mtag">${missionLabel(mission)}</span> ${pic('missions/' + mission)}`
    : '<span class="muted">no mission</span>');
  if (tile) {
    bits.push(`<span class="tag" title="${esc(TILE_NOTE)}">Tile ${tile.n}${tile.up ? '' : ' (face down)'}</span>`
      + ` ${pic('tiles/' + (tile.up ? 'up' : 'dn') + tile.n)}`);
  }
  // A station is listed whether or not its tile is out: an event's bounty sits on the
  // station itself and still pays whoever ends a turn there, used tile or not.
  for (const [sid, st] of stationsAt(s, id)) {
    const def = D.STATION_TILES.find((t) => t.id === sid);
    bits.push(st.out
      ? `<span class="tag" title="End your turn here to get: ${esc(fxText(def.fx))}">${esc(def.name)}: ${esc(fxText(def.fx))}</span> ${pic('tiles/st_' + def.id)}`
      : `<span class="tag used">${esc(def.name)} <span class="usedmark">USED</span>` +
        ` <span class="muted">back next round</span></span> ${pic('tiles/st_' + def.id)}`);
    if (st.bounty) bits.push(`<span class="tag bounty" title="${esc(BOUNTY[st.bounty].help)}">${BOUNTY[st.bounty].tag}</span>`);
  }
  for (const q of s.players.filter((q) => q.at === id)) bits.push(`<span class="tag">🚀 ${esc(q.name)}</span>`);
  return bits;
}

function boardHtml(s, p, myTurn) {
  const dist = bfs(p.at);
  const here = routesAt(p.at);
  // One table, nearest first: the Jumps column already says how far, so splitting the
  // neighbours into their own table only made the same planets appear twice.
  const all = D.LOCS.map((l) => l.id).sort((a, b) => (dist[a] ?? 99) - (dist[b] ?? 99));
  return `<div class="here"><b>Your ship is at ${esc(locName(p.at))}</b>
      ${s.missions[p.at] ? '' : '<span class="muted"> — no mission here</span>'}</div>
    ${mapHtml(s, p)}
    <details ${keepOpen('planets')}><summary>Planets (${D.LOCS.length})</summary>
    <table class="board"><thead><tr><th>Planet</th><th>Jumps</th><th></th></tr></thead><tbody>
      ${all.map((id) => {
        const i = here.find((j) => routeEnd(j, p.at) === id);
        const col = i === undefined ? null : D.ROUTES[i].c;
        return `<tr${id === p.at ? ' class="at"' : ''}><td>${esc(locName(id))}</td>
          <td class="muted">${dist[id] ?? '–'}${col ? ` <span class="dot dot-${col}"></span>` : ''}</td>
          <td>${i !== undefined && s.pirates[i] ? `<span class="tag pir">${esc(pirate(s.pirates[i]))}</span> ` : ''}${spotHtml(s, id).join(' ')}</td></tr>`;
      }).join('')}
    </tbody></table>
    <p class="muted">${TILE_NOTE}</p></details>
    ${missionsHtml(s)}
    ${piratesHtml(s)}
    ${myTurn && !ask(s) && !s.turn.acted ? missionHereHtml(s, p) : ''}`;
}

// Every pirate on the board. Planning a route matters more than the one in front of you,
// so this lists all of them, nearest first, with the ones you could fight now marked.
function piratesHtml(s) {
  const p = s.players[s.current];
  const here = new Set(routesAt(p.at));
  const dist = bfs(p.at);
  const rows = s.pirates.map((tok, i) => (tok ? { tok, i } : null)).filter(Boolean)
    .map(({ tok, i }) => {
      const { a, b } = D.ROUTES[i];
      const d = Math.min(dist[a] ?? 99, dist[b] ?? 99);
      return { d, html: `<tr><td>${esc(locName(a))} – ${esc(locName(b))}</td>
        <td>${esc(pirate(tok))} <button class="small secondary pic" data-img="${rewardPic(tok)}" title="Picture">\ud83d\uddbc</button></td>
        <td>${here.has(i) ? '<span class="tag">from here</span>' : `<span class="muted">${d} jump${d === 1 ? '' : 's'} away</span>`}</td></tr>` };
    })
    .sort((x, y) => x.d - y.d).map((r) => r.html).join('');
  if (!rows) return '<div class="muted">No pirates on the board.</div>';
  return `<details ${keepOpen('pirates')}><summary>Pirates (${s.pirates.filter(Boolean).length})</summary>
    <table class="board"><tbody>${rows}</tbody></table></details>`;
}

// Every face-up mission on the board, nearest first: the full text of each line, a
// picture button, and how far away it is. A mission's name alone doesn't tell you
// whether it is worth flying across the galaxy for.
function missionsHtml(s) {
  const p = s.players[s.current];
  const dist = bfs(p.at);
  const rows = Object.entries(s.missions)
    .map(([loc, id]) => ({ loc, id, d: dist[loc] ?? 99 }))
    .sort((a, b) => a.d - b.d)
    .map(({ loc, id, d }) => {
      const owner = reservedBy(s, loc);
      const where = loc === p.at ? '<span class="tag">you are here</span>'
        : `<span class="muted">${d} jump${d === 1 ? '' : 's'}</span>`;
      const held = owner !== null && owner !== p.idx
        ? `<span class="tag">reserved for ${esc(s.players[owner].name)}</span>` : '';
      return `<div class="missionrow">
        <div><b>${esc(locName(loc))}</b> ${where} ${held}</div>
        ${missionHtml(s, id)}</div>`;
    }).join('');
  return `<details ${keepOpen('missions')}><summary>Missions on the board (${Object.keys(s.missions).length})</summary>
    ${rows || '<div class="muted">None face up.</div>'}</details>`;
}

function bfs(from) {
  const d = { [from]: 0 };
  const q = [from];
  while (q.length) {
    const x = q.shift();
    for (const n of neighbours(x)) if (d[n] === undefined) { d[n] = d[x] + 1; q.push(n); }
  }
  return d;
}

// ---------- taking a mission ----------
function missionHereHtml(s, p) {
  const id = s.missions[p.at];
  if (!id) return '';
  const owner = reservedBy(s, p.at);
  const m = missionDef(id);
  if (owner !== null && owner !== p.idx) {
    return `<section class="box">${missionHtml(s, id)}<p class="muted">Reserved for ${esc(s.players[owner].name)}.</p></section>`;
  }
  if (!assigning || assigning.id !== id) {
    const can = p.ready.length >= m.lines.length;
    return `<section class="box">${missionHtml(s, id)}
      ${can ? `<button data-lobby="assign" data-id="${esc(id)}">Take this mission</button>`
        : `<p class="muted">You need ${m.lines.length} crew in your ready room; you have ${p.ready.length}.</p>`}</section>`;
  }
  // Picking one crew member per line.
  const used = [...assigning.crew];
  const left = [...p.ready];
  for (const f of used) { const i = left.indexOf(f); if (i >= 0) left.splice(i, 1); }
  const i = assigning.crew.length;
  const done = i >= m.lines.length;
  return `<section class="box">${missionHtml(s, id)}
    <h3>Assign crew</h3>
    ${m.lines.map((l, j) => `<div class="line line-${l.c}">
      ${assigning.crew[j] ? figShort(assigning.crew[j]) : (j === i ? '👉' : '·')} ${esc(lineText(l))}
      ${D.matches(assigning.crew[j] ?? '', l.c) ? ' <b>✓</b>' : ''}</div>`).join('')}
    ${done ? `${btn('Go', { type: 'mission', assign: assigning.crew }, { cls: 'primary' })}`
      : `<p>Choose crew for the <b>${esc(COLOR_NAME[m.lines[i].c] ?? m.lines[i].c)}</b> line:</p>
         <div class="btns">${[...new Set(left)].map((fig) =>
           `<button data-lobby="pickCrew" data-fig="${esc(fig)}">${figName(fig)}${D.matches(fig, m.lines[i].c) ? ' ✓' : ''}</button>`).join('')}</div>`}
    <button class="secondary" data-lobby="cancelAssign">Cancel</button></section>`;
}

// ---------- your ship ----------
function shipHtml(s, p, mine) {
  const rooms = roomsFor(s, p);
  return `<table class="ship">
    <tr><th>Ready room</th><td>${p.ready.length ? p.ready.map(figShort).join(' ') : '<span class="muted">empty</span>'}</td></tr>
    <tr><th>Queue</th><td>${p.queue.length ? p.queue.map(figShort).join(' → ') : '<span class="muted">empty</span>'}</td></tr>
    <tr><th>Medals</th><td>🎖 ${p.medals}${mine && medalsAvailable(s, p) > p.medals ? ` <span class="muted">(${medalsAvailable(s, p)} spendable)</span>` : ''}</td></tr>
    <tr><th>Rings left</th><td>${p.rings}</td></tr>
    <tr><th>Cargo</th><td>${p.cargo.map((c, i) => `<span class="slot${c ? ' slot-' + c.t : ''}" title="slot ${i + 1}">${c ? (c.t === 'dmg' ? '💥' : c.t === 'art' ? (ART[c.id] ?? '⬢') : '☠') : '·'}</span>`).join('')}
      ${p.excess ? ` <span class="tag">+${p.excess} excess damage</span>` : ''}</td></tr>
    <tr><th>Damage</th><td>${damageCount(p)} <span class="muted">(${D.PTS2.damage / 2} point each)</span></td></tr>
    <tr><th>Tracks</th><td>${p.marks.map((m, t) => `<div>${esc(trackName(t))}: space ${m.sp}${m.loops ? ` +${m.loops} lap${m.loops > 1 ? 's' : ''}` : ''} <span class="muted">(${D.TRACK_ZONE_PTS[m.sp]} pts)</span></div>`).join('')}</td></tr>
    <tr><th>Missions done</th><td>${p.done.length ? p.done.map(doneMission).join(' ') : '<span class="muted">none</span>'}</td></tr>
    <tr><th>Rooms</th><td>${rooms.map((r) => `<span class="tag room-${r.color}">${esc(r.name)}</span>`).join(' ')}
      ${Object.keys(p.roomDmg).length ? `<div class="muted">Out of action: ${Object.keys(p.roomDmg).map((id) => esc(D.ROOMS.find((x) => x.id === id).name)).join(', ')}</div>` : ''}</td></tr>
  </table>
  ${techSlotsHtml(s, p, mine)}`;
}

// ---------- this turn, and taking a move back ----------
// undoable() replays the whole turn, so cache it per state rather than per render.
const undoCache = new WeakMap();
function undoInfo(s) {
  if (!undoCache.has(s)) undoCache.set(s, undoable(s));
  return undoCache.get(s);
}

// A move in words, for the "this turn" list.
function moveLabel(s, p, a) {
  switch (a.type) {
    case 'train': return `Trained ${figShort(a.from)} into ${figShort(a.to)}`;
    case 'promote': return `Promoted ${figShort(a.c)}`;
    case 'activate': {
      const room = roomsFor(s, p).find((r) => r.id === a.room);
      const who = a.with?.fig ? figShort(a.with.fig) : 'two artifacts';
      return `${esc(room?.name ?? a.room)} with ${who}`;
    }
    case 'mission': {
      const m = D.missionDef(s.missions[p.at] ?? '');
      return `Took ${esc(m?.name ?? 'a mission')} with ${a.assign.map(figShort).join(' ')}`;
    }
    case 'choose': return `Chose ${esc(choiceLabel(a.opt))}`;
    case 'pass': return 'Passed';
    default: return esc(a.type);
  }
}

function choiceLabel(opt) {
  if (opt === null || opt === undefined) return '-';
  if (typeof opt === 'object') {
    if (opt.card) return techDef(opt.card)?.name ?? opt.card;
    if (opt.room) return opt.room;
    if (opt.from && opt.to) return `${opt.from} to ${opt.to}`;
    if (opt.zone) return `repair ${opt.zone} ${Number(opt.i) + 1 || opt.i}`;
    return JSON.stringify(opt);
  }
  return locDef(opt)?.name ?? D.missionDef(opt)?.name ?? String(opt);
}

// This turn's moves, newest first, each with an undo button or the reason it is stuck.
function turnHtml(s, p) {
  const moves = s.history?.moves || [];
  if (!moves.length) return '';
  const why = undoInfo(s);
  const rows = moves.map(({ action }, i) => {
    const undo = !why ? '' : why[i] === null
      ? btn('\u21b6 Undo', { type: 'undo', move: i }, { cls: 'small secondary' })
      : `<span class="muted">can't undo: ${esc(why[i])}</span>`;
    return `<div><span>${i + 1}. ${moveLabel(s, p, action)}</span>${undo}</div>`;
  }).reverse().join('');
  const note = why ? '' : '<div class="muted">This turn\'s moves can\'t be undone: their history doesn\'t match the game.</div>';
  return `<details ${keepOpen('turn')}><summary>This turn (${moves.length} move${moves.length > 1 ? 's' : ''})</summary>
    <div class="turn-moves">${note}${rows}</div></details>`;
}

// ---------- what you can do ----------
function actionsHtml(s, p) {
  if (ask(s)) return '';
  const acted = s.turn.acted;
  const rooms = roomsFor(s, p);
  const pairs = [];
  const arts = p.cargo.map((c, i) => [c, i]).filter(([c]) => c?.t === 'art');
  for (let a = 0; a < arts.length; a++) for (let b = a + 1; b < arts.length; b++) pairs.push([arts[a], arts[b]]);

  return `<section class="box">
    <h2>Your turn</h2>
    ${acted ? `<p>You have acted. ${btn('End turn', { type: 'endTurn' }, { cls: 'primary' })}</p>` : ''}
    ${!acted ? `
      <h3>Activate a room</h3>
      <div class="btns">${rooms.map((r) => {
        const who = [...new Set(p.ready.filter((f) => canActivate(f, r)))];
        return who.map((fig) => btn(`${esc(r.name)} — ${figName(fig)}`, { type: 'activate', room: r.id, with: { fig } })).join('');
      }).join('') || '<span class="muted">No crew in your ready room can work a room.</span>'}</div>
      ${pairs.length ? `<h3>…or spend two artifacts</h3><div class="btns">${
        pairs.flatMap(([[ca, ia], [cb, ib]]) => rooms
          .filter((r) => D.artifactPair(ca.id, cb.id).includes(r.color))
          .map((r) => btn(`${esc(r.name)} — ${ART[ca.id]}+${ART[cb.id]}`, { type: 'activate', room: r.id, with: { art: [ia, ib] } }))).join('')
      }</div>` : ''}
      <h3>…or train and promote first</h3>
      <div class="btns">${p.ready.filter((f) => f === D.CADET || D.ENSIGNS.includes(f)).flatMap((from) =>
        D.ENSIGNS.filter((to) => to !== from).map((to) => {
          const cost = trainCost(s, p, to);
          return btn(`Train ${figShort(from)} → ${figShort(to)} (${cost || 'free'})`,
            { type: 'train', from, to }, { off: medalsAvailable(s, p) < cost, cls: 'small' });
        })).join('') || '<span class="muted">Nobody to train.</span>'}</div>
      <div class="btns">${[...new Set(p.ready.filter((f) => D.ENSIGNS.includes(f)))].map((c) => {
        const cost = promoteCost(s, p, c);
        return btn(`Promote ${figShort(c)} (${cost} 🎖)`, { type: 'promote', c },
          { off: medalsAvailable(s, p) < cost || p.rings <= 0, cls: 'small' });
      }).join('') || ''}</div>
      <h3>…or stop for the round</h3>
      ${btn('Pass', { type: 'pass' }, { cls: 'secondary' })}` : ''}
  </section>`;
}

function techBoardHtml(s) {
  const card = (id) => {
    if (!id) return '<div class="tslot muted">(refills at end of turn)</div>';
    const d = techDef(id);
    return `<div class="tslot"><b>${esc(d.name)}</b> ${pic('techs/' + id)}
      ${d.room ? `<div class="tag room-${d.room}">Room: ${esc(fxText(d.fx))}</div>` : ''}
      ${d.text ? `<div class="muted">${esc(d.text)}</div>` : ''}
      ${d.discard ? `<div class="muted">Discard to: ${esc(fxText(d.discard))}</div>` : ''}
      <div class="edges">${d.L.map(bonusName).join(' ')} | ${d.R.map(bonusName).join(' ')}</div></div>`;
  };
  return `<div class="slots">${s.tech.row.map(card).join('')}</div>
    <h3>Omega techs</h3><div class="slots">${s.tech.omega.map(card).join('')}</div>
    <p class="muted">${s.tech.deck.length} techs left in the deck.</p>`;
}

// The Tincan event has no card of its own: it turns the tech sitting on the track into a
// shared one, so its picture is that tech's card.
function eventPic(s, t, ev) {
  if (ev.id !== 'tincan_tech') return ' ' + pic('events/' + ev.id);
  const tech = s.tracks[t].tech;
  return tech ? ` — ${esc(techDef(tech).name)} ${pic('techs/' + tech)}` : '';
}

// A faction track drawn from the data: 13 spaces, each with its bonus, its points zone
// and whoever is standing on it. Drawn rather than photographed so a marker can never sit
// on the wrong space - the photo of the side in play is one tap away for the real thing.
const TRACK_GLYPH = {
  medal: '\u{1F396}', artifact: '\u2b22', repair: '\u{1F527}', android: '\u{1F916}',
  cadet: '\u{1F9D1}', techR: '\u267b\ufe0f', tech: '\u267b\ufe0f', queue: '\u2b05\ufe0f',
};
const glyphFor = (fx) => fx.map((tok) => {
  const [k, n] = Array.isArray(tok) ? tok : [tok, 1];
  const g = TRACK_GLYPH[k] ?? '\u2726';
  return n > 1 ? `${g}\u00d7${n}` : g;
}).join(' ');

// The event on a track, still shown once it has happened: knowing what hit you is worth
// more than a tidy row. s.tracks[t] keeps `fired` (it resolved) and `gone` (removed
// unresolved at the two-event limit) alongside `event` (still waiting).
function eventLineHtml(s, t) {
  const tr = s.tracks[t];
  const id = tr.event ?? tr.fired ?? tr.gone;
  if (!id) return `<div class="muted">Event space ${D.EVENT_SPACE}: <i>none</i></div>`;
  const ev = D.eventDef(id);
  const mark = tr.event ? '' : tr.fired
    ? ' <span class="done">\u2713 resolved</span>'
    : ' <span class="muted">\u2014 removed unresolved (two events had already happened)</span>';
  return `<div class="muted">Event space ${D.EVENT_SPACE}: ${esc(ev.name)}${eventPic(s, t, ev)}${mark}</div>
    <div class="muted">${esc(ev.text)}</div>`;
}

function trackStripHtml(s, t, side, me) {
  const sp = [...Array(D.TRACK_LEN).keys()];
  const head = sp.map((i) => `<th class="z${D.TRACK_ZONE_PTS[i]}${i === D.EVENT_SPACE ? ' ev' : ''}">${i}${i === D.EVENT_SPACE ? '\u26a1' : ''}</th>`).join('');
  const rewards = sp.map((i) => {
    const b = side.bonus[i];
    return `<td class="z${D.TRACK_ZONE_PTS[i]}"${b ? ` title="${esc(fxText(b))}"` : ''}>${b ? glyphFor(b) : ''}</td>`;
  }).join('');
  const rows = s.players.map((q) => `<tr${q === me ? ' class="me"' : ''}><th>${esc(q.name)}</th>${
    sp.map((i) => `<td class="z${D.TRACK_ZONE_PTS[i]}">${q.marks[t].sp === i ? '\u25cf' : ''}</td>`).join('')
  }</tr>`).join('');
  const laps = s.players.filter((q) => q.marks[t].loops).map((q) => `${esc(q.name)} +${q.marks[t].loops}`).join(', ');
  return `<div class="tscroll"><table class="tstrip">
      <tr><th>Space</th>${head}</tr>
      <tr><th>Reward</th>${rewards}</tr>
      ${rows}
    </table></div>
    <p class="muted">Points by zone: spaces 1\u20133 are worth 1, 4\u20136 are 2, 7\u20139 are 3, 10\u201312 are 4.
      \u26a1 space ${D.EVENT_SPACE} fires the event. A lap is worth ${D.TRACK_LOOP_PTS}${laps ? `; laps so far: ${laps}` : ''}.</p>`;
}

function tracksHtml(s, me) {
  return D.FACTIONS.map((fa, t) => {
    const side = fa.sides.find((x) => x.id === s.tracks[t].side);
    return `<div class="track">
      <b>${esc(fa.name)}</b> <span class="muted">(side ${esc(side.id.slice(-1))})</span> ${pic('tracks/' + side.id)}
      ${trackStripHtml(s, t, side, me)}
      ${eventLineHtml(s, t)}</div>`;
  }).join('');
}

// ---------- scores ----------
function resultText(s) {
  const w = winners(s);
  return w.length === 1 ? `${s.players[w[0]].name} wins` : `${w.map((i) => s.players[i].name).join(' and ')} share the win`;
}

function scoresHtml(s) {
  return `<table class="scores"><thead><tr><th></th><th>Missions</th><th>Tracks</th><th>Crew</th><th>Tokens</th><th>Omega</th><th>Damage</th><th>Total</th></tr></thead>
    <tbody>${s.players.map((p) => {
      const sc = score(s, p);
      const h = (n) => (n / 2).toString();
      return `<tr><td>${esc(p.name)}</td><td>${h(sc.missionPts2)}</td><td>${h(sc.trackPts2)}</td><td>${h(sc.crewPts2)}</td>
        <td>${h(sc.tokenPts2)}</td><td>${h(sc.omegaPts2)}</td><td>${h(sc.damage * D.PTS2.damage)}</td><td><b>${h(sc.total2)}</b></td></tr>`;
    }).join('')}</tbody></table>`;
}

function alertsHtml() {
  const topic = alertTopic(session.code, session.seat);
  return `<details class="alerts" ${keepOpen('alerts')}><summary>🔔 Turn alerts</summary>
    <p>To get a notification when it's your turn, even with this page closed, install the free <b>ntfy</b> app (iPhone or Android), tap + and subscribe to:</p>
    <p><code>${esc(topic)}</code> <button class="small secondary" data-lobby="copy" data-text="${esc(topic)}">Copy</button></p>
    <p class="muted">On a laptop, open <a href="https://ntfy.sh/${esc(topic)}" target="_blank" rel="noopener">ntfy.sh/${esc(topic)}</a> and allow notifications. No alert is sent while this game is on your screen.</p>
  </details>`;
}

// ---------- the game screen ----------
function renderGame() {
  const s = session.state;
  if (!s) {
    const invite = gameLink(`room=${session.code}`);
    app.innerHTML = `<section class="lobby"><h1>Starship Captains</h1>
      <p>Game code</p><div class="bigcode">${esc(session.code)}</div>
      <p>Your friend opens this page, taps Join and enters the code, or opens your invite link.</p>
      ${navigator.share ? `<button data-lobby="share" data-text="${esc(invite)}">Share invite link…</button>` : ''}
      <button class="secondary" data-lobby="copy" data-text="${esc(invite)}">Copy invite link</button>
      ${message ? `<p class="status">${esc(message)}</p>` : ''}
      <p class="status">${esc(session.status)}</p>
      <button class="secondary" data-lobby="leave">Back</button></section>`;
    return;
  }
  if (session.mode === 'local' && passCurtain !== null) {
    app.innerHTML = `<section class="lobby"><h1>Pass the phone</h1>
      <p>Hand it to <b>${esc(s.players[passCurtain].name)}</b>.</p>
      <button class="primary" data-lobby="reveal">I'm ${esc(s.players[passCurtain].name)} — show my turn</button></section>`;
    return;
  }
  const seat = session.mode === 'local' ? s.current : session.seat;
  const me = s.players[seat];
  const cur = s.players[s.current];
  const myTurn = !s.over && s.current === seat;
  const others = s.players.filter((p) => p.idx !== seat);
  const online = session.mode === 'online';
  const unread = online ? session.chat.filter((m) => m.id > session.chatRead && m.seat !== seat) : [];
  const news = unread.at(-1);

  if (!document.getElementById('g-top')) {
    app.innerHTML = `<div id="g-top"></div>
      <div class="layout">
        <section class="col" id="g-mine"></section>
        <section class="col"><div id="g-side"></div>${online ? `
          <h2>Chat</h2>
          <form id="chat" class="chat"><input id="chat-text" maxlength="500" autocomplete="off" enterkeyhint="send" placeholder="Message"><button>Send</button></form>
          <div id="g-chat"></div>` : ''}</section>
      </div>`;
  }
  const parts = {};
  parts.top = `
    <header class="top">
      <div><b>Starship Captains</b> ${session.code ? `<span class="muted">game ${esc(session.code)}</span>` : ''}</div>
      <div class="status">${esc(session.status || '')}</div>
      <div><a href="${RULEBOOK}" target="_blank" rel="noopener">Rules</a>
        ${session.mode === 'local' ? '<button class="small secondary" data-lobby="move">Move device</button>' : ''}
        <button class="small secondary" data-lobby="leave">Menu</button></div>
    </header>
    ${online ? alertsHtml() : ''}
    ${s.over ? `<section><h2>Game over — ${esc(resultText(s))}!</h2>${scoresHtml(s)}</section>` : ''}
    <div class="hud ${myTurn ? 'mine' : ''}">
      ${s.over ? '' : `<div class="turn">Round ${s.round} of ${D.ROUNDS}: <b>${esc(cur.name)}</b>${myTurn ? ' (you)' : ''}${cur.passed ? ' — passed' : ''}</div>`}
      ${news ? `<button class="small secondary chat-news" data-lobby="chat">💬 ${unread.length > 1 ? `(${unread.length}) ` : ''}<b>${esc(s.players[news.seat]?.name ?? '?')}</b>: ${esc(news.text)}</button>` : ''}
      ${message ? `<div class="alert">${esc(message)}</div>` : ''}
    </div>
    ${myTurn ? askHtml(s, me) : ''}`;
  // On a phone these stack in this order, so what you plan from - the galaxy and the
  // faction tracks - sits directly under the turn line, then your own ship, and only then
  // everyone else's. An opponent's board below yours can't be mistaken for your own.
  parts.mine = `
    <h2>The galaxy ${pic('board')}</h2>
    ${boardHtml(s, me, myTurn)}
    <h2>Faction tracks</h2>
    ${tracksHtml(s, me)}`;
  if (online) parts.chat = chatHtml(s, seat);
  parts.side = `
    <section class="you">
      <h2>${esc(me.name)} (you) ${pic('dashboard')}</h2>
      ${shipHtml(s, me, true)}
      ${myTurn ? actionsHtml(s, me) : ''}
      ${myTurn ? turnHtml(s, me) : ''}
      <h2>Tech board</h2>
      ${techBoardHtml(s)}
    </section>
    ${others.map((o) => `<section class="them"><h2>${esc(o.name)} <span class="muted">(opponent)</span></h2>${shipHtml(s, o, false)}</section>`).join('')}
    ${!s.over ? `<details ${keepOpen('score')}><summary>Current score</summary>${scoresHtml(s)}</details>` : ''}
    <h2>Log</h2>
    <div class="log">${s.log.slice().reverse().map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
  for (const [k, html] of Object.entries(parts)) document.getElementById(`g-${k}`).innerHTML = html;

  // A new question can appear anywhere in a turn - after a mission line, a track bonus, a
  // pirate - and on a phone its buttons are easy to miss. Scroll to them when the question
  // itself changes, but not on an unrelated re-render (a chat message, an opponent's move).
  const key = myTurn ? JSON.stringify(ask(s) ?? null) : null;
  if (key !== lastAsk) {
    lastAsk = key;
    if (key) document.querySelector?.('.ask')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }
}
let lastAsk = null;

function render() {
  if (pendingMove) renderPendingMove();
  else if (seatPick) renderSeatPick();
  else if (session?.mode === 'moved') renderMoved();
  else if (!session) renderLobby();
  else renderGame();
}

// ---------- events ----------
app.addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  if (actEl && !actEl.disabled) { act(JSON.parse(actEl.dataset.act)); return; }
  const imgEl = e.target.closest('[data-img]');
  if (imgEl?.dataset.img) { showImage(imgEl.dataset.img); return; }
  const lob = e.target.closest('[data-lobby]');
  if (!lob || lob.disabled) return;
  const what = lob.dataset.lobby;
  if (what === 'create') lobbyTask(createOnline);
  if (what === 'join' || what === 'resumeOnline') {
    const code = what === 'join' ? document.getElementById('code').value.trim().toUpperCase() : LS.get('captains.online').code;
    if (!/^[A-Z]{8}$/.test(code)) { alert('Enter the 8-letter game code.'); return; }
    myName();
    lobbyTask(() => openOnline(code));
  }
  if (what === 'seat') startOnline(seatPick.code, Number(lob.dataset.seat));
  if (what === 'joinSeat') lobbyTask(joinAsSecond);
  if (what === 'local') {
    const a = myName();
    const b = (document.getElementById('p2').value || '').trim() || 'Player 2';
    startLocal(setup({ names: [a, b], seed: Math.floor(Math.random() * 2 ** 31) }));
  }
  if (what === 'resumeLocal') startLocal(savedState(LS.get('captains.local')));
  if (what === 'reveal') { passCurtain = null; render(); }
  if (what === 'move') moveDevice();
  if (what === 'assign') { assigning = { id: lob.dataset.id, crew: [] }; render(); }
  if (what === 'pickCrew') { assigning.crew.push(lob.dataset.fig); render(); }
  if (what === 'cancelAssign') { assigning = null; render(); }
  if (what === 'share') navigator.share({ title: 'Starship Captains', url: lob.dataset.text }).catch(() => {});
  if (what === 'copy') {
    navigator.clipboard.writeText(lob.dataset.text)
      .then(() => { message = 'Copied.'; }, () => { message = 'Copy failed. Select the text and copy it by hand.'; })
      .then(render);
  }
  if (what === 'acceptMove') {
    const m = pendingMove;
    pendingMove = null;
    startLocal(m.state);
  }
  if (what === 'rejectMove') { pendingMove = null; render(); }
  if (what === 'leave') leave();
  if (what === 'chat') {
    readChat();
    render();
    document.getElementById('chat')?.scrollIntoView({ block: 'center' });
  }
});
app.addEventListener('submit', (e) => {
  e.preventDefault();
  if (session?.mode !== 'online') return;
  sendChat(session, document.getElementById('chat-text'));
  render();
});
app.addEventListener('focusin', (e) => {
  if (e.target.id === 'chat-text' && session?.mode === 'online') { readChat(); render(); }
});

render();
