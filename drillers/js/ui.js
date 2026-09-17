import { setup, apply, cardDef, tileDef, floorCardDef, activeFloorCard, nextMineral, trackUsed, trackLimit, score, revealsInfo, GameError } from './engine.js';
import * as D from './data.js';
import { hostGame, joinGame, newCode, packSave, unpackSave } from './net.js';

const app = document.getElementById('app');
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const SAVE_VERSION = 2; // bump when the state shape changes so old saves are ignored
const RULEBOOK = 'https://filemanager.czechgames.com/storage/files/drillers/rules/Drillers_rulebook_EN_2026-05-21.pdf';

// session: { mode: 'local'|'host'|'guest'|'moved', seat, state, net, status, code, undo, canUndo, url }
// undo (local/host only): earlier states of the current turn, cleared when hidden info is revealed.
// canUndo (guest only): whether the host has something to undo, sent with each state.
let session = null;
let message = '';
let keep = new Set();
let passCurtain = null; // local mode: index of player we're waiting to hand the phone to
let pendingMove = null; // { mode, code, state } from a #move= link, waiting for confirmation

const esc = (x) => String(x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const MIN_ABBR = { silver: 'Ag', gold: 'Au', sapphire: 'Sa', emerald: 'Em', ruby: 'Ru' };
const gem = (m) => `<span class="gem gem-${m}" title="${m}">${MIN_ABBR[m]}</span>`;
const floorLabel = (f) => (f === 0 ? 'Surface' : f === 1 ? 'Entrance' : 'F' + f);
const savedState = (st) => (st && st.v === SAVE_VERSION ? st : null);

// ---------- lobby ----------
function renderLobby() {
  const host = LS.get('drillers.host');
  const guest = LS.get('drillers.guest');
  const local = savedState(LS.get('drillers.local'));
  const name = LS.get('drillers.name') || '';
  app.innerHTML = `
    <section class="lobby">
      <h1>Drillers</h1>
      <p class="muted">Unofficial fan implementation for playing with a friend. Own the real game! <a href="${RULEBOOK}" target="_blank" rel="noopener">Rulebook (PDF)</a></p>
      <label for="name">Your name</label>
      <input id="name" value="${esc(name)}" maxlength="16" placeholder="Driller">
      <div class="box">
        <h2>Play on two phones</h2>
        <button data-lobby="host">Host a new game</button>
        <div class="row">
          <input id="code" maxlength="5" placeholder="CODE" autocapitalize="characters">
          <button data-lobby="join">Join</button>
        </div>
        ${host ? `<button class="secondary" data-lobby="resumeHost">Resume hosting ${esc(host.code)}</button>` : ''}
        ${guest ? `<button class="secondary" data-lobby="resumeGuest">Rejoin ${esc(guest.code)}</button>` : ''}
      </div>
      <div class="box">
        <h2>Pass &amp; play on this phone</h2>
        <input id="p2" maxlength="16" placeholder="Second player's name">
        <button data-lobby="local">Start local game</button>
        ${local ? `<button class="secondary" data-lobby="resumeLocal">Resume local game</button>` : ''}
      </div>
    </section>`;
}

function myName() {
  const input = document.getElementById('name');
  if (!input) return LS.get('drillers.name') || 'Driller';
  const n = input.value.trim() || 'Driller';
  LS.set('drillers.name', n);
  return n;
}

function startHost(code, saved) {
  const name = myName();
  session = { mode: 'host', seat: 0, state: savedState(saved), code, status: 'Starting…', undo: [] };
  session.net = hostGame({
    code,
    onStatus: (st) => { session.status = st; render(); },
    onHello: (guestName) => {
      if (!session.state) {
        session.state = setup({ names: [name, guestName], seed: Math.floor(Math.random() * 2 ** 31) });
        LS.set('drillers.host', { code, state: session.state });
      }
      session.net.send({ t: 'state', state: session.state, seat: 1, canUndo: session.undo.length > 0 });
      render();
    },
    onUndo: () => {
      if (!undo(1)) session.net.send({ t: 'error', msg: 'Nothing to undo.' });
    },
    onAction: (action) => {
      try {
        commit(apply(session.state, { ...action, p: 1 }));
      } catch (e) {
        session.net.send({ t: 'error', msg: e instanceof GameError ? e.message : 'Something went wrong.' });
        if (!(e instanceof GameError)) console.error(e);
      }
    },
  });
  LS.set('drillers.host', { code, state: session.state });
  render();
}

function startGuest(code) {
  const name = myName();
  session = { mode: 'guest', seat: 1, state: null, code, status: 'Connecting…' };
  LS.set('drillers.guest', { code });
  session.net = joinGame({
    code, name,
    onStatus: (st) => { session.status = st; render(); },
    onMessage: (msg) => {
      if (msg.t === 'state') { session.state = msg.state; session.seat = msg.seat; session.canUndo = !!msg.canUndo; message = ''; }
      if (msg.t === 'error') message = msg.msg;
      render();
    },
  });
  render();
}

function startLocal(state) {
  session = { mode: 'local', state, status: 'Pass & play', undo: [] };
  passCurtain = state.over ? null : state.current; // start behind the curtain so the first player isn't spoiled
  LS.set('drillers.local', state);
  render();
}

// ---------- move to another device ----------
// Packs the game into a link. A host stops hosting here so the other device can take the room code.
async function moveDevice() {
  const { mode, code, state } = session;
  let url;
  try {
    url = `${location.origin}${location.pathname}#move=${await packSave(mode === 'host' ? { mode, code, state } : { mode, state })}`;
  } catch (e) {
    console.error(e);
    message = 'Could not make a link in this browser.';
    render();
    return;
  }
  if (session.net) session.net.destroy();
  session = { mode: 'moved', from: mode, url };
  message = '';
  render();
}

function renderMoved() {
  app.innerHTML = `<section class="lobby"><h1>Move this game</h1>
    <p>Open this link on your other device.${session.from === 'host' ? ' Hosting has stopped on this phone; your friend reconnects automatically once the other device opens the link.' : ''}</p>
    <input readonly value="${esc(session.url)}">
    ${navigator.share ? '<button data-lobby="shareMove">Share link…</button>' : ''}
    <button class="${navigator.share ? 'secondary' : ''}" data-lobby="copyMove">Copy link</button>
    ${message ? `<p class="status">${esc(message)}</p>` : ''}
    <button class="secondary" data-lobby="leave">Back to menu</button></section>`;
}

function renderPendingMove() {
  const names = pendingMove.state.players.map((p) => esc(p.name)).join(' vs ');
  const replaces = pendingMove.mode === 'host' ? 'the game you host on this device' : 'the pass &amp; play game saved on this device';
  app.innerHTML = `<section class="lobby"><h1>Load moved game?</h1>
    <p>${names}, turn ${pendingMove.state.turnNo}${pendingMove.mode === 'host' ? `, room ${esc(pendingMove.code)}` : ''}.</p>
    <p class="muted">This replaces ${replaces}. Close the game on the old device first.</p>
    <button class="primary" data-lobby="acceptMove">Load it here</button>
    <button class="secondary" data-lobby="rejectMove">Cancel</button></section>`;
}

const moveHash = globalThis.location?.hash || '';
if (moveHash.startsWith('#move=')) {
  history.replaceState(null, '', location.pathname);
  unpackSave(moveHash.slice(6))
    .then((m) => {
      if (savedState(m.state) && (m.mode === 'local' || m.mode === 'host')) pendingMove = m;
      else alert('That link is from an older version of the game and cannot be loaded.');
    })
    .catch(() => alert('That move link is broken or incomplete.'))
    .then(render);
}

// ---------- state changes ----------
function commit(next) {
  const prev = session.state;
  session.undo = revealsInfo(prev, next) ? [] : [...session.undo, prev];
  show(next);
}

// Step back one action if the seat is the current player and nothing was revealed since.
function undo(seat) {
  if (!session.undo.length || session.state.current !== seat) return false;
  show(session.undo.pop());
  return true;
}

function show(next) {
  const prevCurrent = session.state.current;
  session.state = next;
  message = '';
  if (session.mode === 'host') {
    LS.set('drillers.host', { code: session.code, state: next });
    session.net.send({ t: 'state', state: next, seat: 1, canUndo: session.undo.length > 0 });
  }
  if (session.mode === 'local') {
    LS.set('drillers.local', next);
    if (next.current !== prevCurrent && !next.over) passCurtain = next.current;
  }
  if (next.current !== prevCurrent) keep = new Set();
  render();
}

function act(action) {
  const s = session.state;
  const seat = session.mode === 'local' ? s.current : session.seat;
  const full = { ...action, p: seat };
  if (session.mode === 'guest') {
    // validate locally for instant feedback, then send to the host
    try { apply(s, full); } catch (e) { message = e.message; render(); return; }
    session.net.send(full);
    return;
  }
  try {
    commit(apply(s, full));
  } catch (e) {
    message = e instanceof GameError ? e.message : 'Something went wrong.';
    if (!(e instanceof GameError)) console.error(e);
    render();
  }
}

// ---------- rendering helpers ----------
function fxText(fx = {}) {
  const bits = [];
  if (fx.moves) bits.push(`${fx.moves}↕️`);
  if (fx.drills) bits.push(`${fx.drills}⛏`);
  if (fx.fuel) bits.push(`+${fx.fuel}⛽`);
  if (fx.credits) bits.push(`+${fx.credits}c`);
  if (fx.draw) bits.push(`+${fx.draw} card`);
  if (fx.drone) bits.push(`refresh ${fx.drone > 1 ? fx.drone + ' drones' : 'drone'}`);
  if (fx.repair) bits.push(`repair${fx.repair > 1 ? ' ×' + fx.repair : ''}`);
  if (fx.damage) bits.push('take damage');
  if (fx.damageTop) bits.push('DAMAGE on deck');
  if (fx.damageHand) bits.push('DAMAGE to hand');
  return bits.join(' · ');
}

function cardHtml(s, iid, buttons = '') {
  const c = cardDef(s, iid);
  const main = fxText(c.fx);
  const choose = c.choose ? 'choose: ' + c.choose.map((o) => o.label).join(' / ') : '';
  const cost = c.perm ? 'permanent' : c.play === 'solid' ? 'burn a mineral' : `${c.play}⛽`;
  return `<div class="card card-${c.shop}">
    <div class="card-top"><b>${esc(c.name)}</b><span>${c.pts ? `<span class="pts neg">${c.pts}</span>` : ''}${pic('cards/' + c.id)}</span></div>
    <div class="card-line">${c.perm ? '' : `<span class="fuel">burn +${c.fuel}⛽</span>`} <span class="cost">main ${cost}</span></div>
    ${main || choose ? `<div class="card-line">${[main, choose].filter(Boolean).join(' · ')}</div>` : ''}
    ${c.text ? `<div class="card-text">${esc(c.text)}</div>` : ''}
    ${buttons ? `<div class="card-btns">${buttons}</div>` : ''}
  </div>`;
}

// Small button that opens a component photo in the viewer.
const pic = (path) => `<button class="pic" data-img="img/${path}.webp" aria-label="Show image">🖼</button>`;

function showImage(src) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<img src="${esc(src)}" alt=""><p>Tap to close</p>`;
  v.querySelector('img').onerror = () => { v.querySelector('p').textContent = 'No image for this yet. Tap to close'; };
  v.addEventListener('click', () => v.remove());
  document.body.append(v);
}

function btn(label, action, opts = {}) {
  return `<button class="${opts.cls || ''}" ${opts.disabled ? 'disabled' : ''} data-act="${esc(JSON.stringify(action))}">${label}</button>`;
}

function repairBtn(s, p, iid) {
  if (s.phase === 'upkeep') return '';
  if (p.turn.repairs > 0) return btn('Repair (free)', { type: 'repair', iid }, { cls: 'secondary' });
  if (s.phase === 'surface' && !p.turn.repaired) return btn(`Repair ${D.REPAIR_COST}c`, { type: 'repair', iid }, { cls: 'secondary', disabled: p.credits < D.REPAIR_COST });
  return '';
}

function mineHtml(s, me) {
  const rows = s.floors.map((fl, f) => {
    const def = D.FLOORS[f];
    const mechs = s.players.filter((p) => p.floor === f).map((p) => `<span class="mech mech-${p.idx}">${esc(p.name.slice(0, 8))}</span>`).join('');
    const parts = [];
    if (fl.minerals.length) parts.push(fl.minerals.map(gem).join(''));
    if (fl.jackpot) {
      const owners = s.players.filter((p) => fl.jackpot[p.idx]).map((p) => esc(p.name)).join(', ');
      if (owners) parts.push(`<span class="tag">Jackpot ${gem('emerald')} for ${owners}</span>`);
    }
    if (fl.corridors.length) {
      const top = D.CORRIDOR_TILES[fl.corridors[0]];
      parts.push(`<span class="tag">corridors ×${fl.corridors.length}, ${def.corridorCost}⛏ → ${top.minerals.map(gem).join('')} ${top.pts}pt ${pic('tiles/k' + fl.corridors[0])}</span>`);
    }
    if (fl.barrier) parts.push(`<span class="tag barrier">BARRIER ${def.barrier.drill}⛏ · ${def.barrier.pts}pt ${pic('tiles/b' + f)}</span>`);
    if (fl.card) {
      const fc = floorCardDef(fl.card);
      parts.push(fl.cardUp ? `<span class="tag floorcard">${esc(fc.name)}: ${esc(fc.text)} ${pic('floors/' + fl.card)}</span>` : '<span class="tag">floor card ?</span>');
    }
    return `<div class="floor ${me && me.floor === f ? 'here' : ''}">
      <div class="floor-name">${floorLabel(f)}${def.penalty ? ` <span class="muted">−${def.penalty}</span>` : ''}</div>
      <div class="floor-body">${mechs}${parts.join(' ')}</div></div>`;
  });
  return `<div class="mine">${rows.join('')}</div>`;
}

function dashHtml(s, p, mine) {
  const nextFuel = D.FUEL.upgradeCosts[p.fuelMax - D.FUEL.startMax];
  const market = D.MINERALS.map((m) => {
    const n = p.market[m];
    const next = n < 3 ? D.MARKET_PRICES[m][n] : D.OVERFLOW_PRICE[m];
    return `<span class="mk">${gem(m)}${n}/3 <small>next ${next}c</small></span>`;
  }).join('');
  const used = trackUsed(p);
  const limit = trackLimit(p);
  const miles = D.MILESTONES.map((m, i) => {
    const owner = s.milestones[i];
    return `<span class="tag ${owner === p.idx ? 'good' : ''}">@${m.at}: ${m.pts}pt${owner !== null ? ' (' + esc(s.players[owner].name) + ')' : ''}</span>`;
  }).join(' ');
  const tiles = p.tiles.map((t, i) => {
    const d = tileDef(t.id);
    const exLabel = d.ex === 'battery' ? '🔋' : fxText(d.ex);
    const label = `${d.barrier ? 'Barrier' : 'Corridor'} F${d.floor} ${d.pts - (t.ex ? d.loss : 0)}pt · ${exLabel}${t.ex ? ' (used)' : ''}`;
    const canEx = mine && !t.ex && d.ex !== 'battery' && s.phase !== 'upkeep' && s.current === p.idx && !s.over;
    return `<span class="tile ${t.ex ? 'ex' : ''}">${label} ${pic('tiles/' + t.id)}${canEx ? ' ' + btn(`exhaust −${d.loss}pt`, { type: 'exhaust', index: i }, { cls: 'small' }) : ''}</span>`;
  }).join('');
  return `<div class="dash">
    <div class="stats">
      <span>⛽ <b>${p.fuel}</b>/${p.fuelMax}</span>
      <span>↕️ <b>${p.moves}</b></span>
      <span>⛏ <b>${p.drills}</b></span>
      <span>💰 <b>${p.credits}</b></span>
      <span>🤖 ${p.drones.map((d) => (d ? '●' : '○')).join('')}</span>
      <span>${floorLabel(p.floor)}</span>
      ${p.turn.repairs ? `<span class="good">🔧 ${p.turn.repairs} free repair${p.turn.repairs > 1 ? 's' : ''}</span>` : ''}
    </div>
    <div>Storage (${p.storage.length}/${p.storageMax}): ${p.storage.map(gem).join('') || '<span class="muted">empty</span>'}</div>
    <div class="market">${market}</div>
    <div>Progress ${used}/${limit} <span class="muted">(overflow ${p.overflow.length}/${D.OVERFLOW_SLOTS})</span> ${miles} ${pic('milestones')}</div>
    <div class="bar"><div style="width:${Math.min(100, (used / D.TRACK_LENGTH) * 100)}%"></div><div class="ovf" style="width:${(Math.min(p.overflow.length, D.OVERFLOW_SLOTS) / D.TRACK_LENGTH) * 100}%"></div></div>
    ${p.tiles.length ? `<div class="tiles">${tiles}</div>` : ''}
    <div class="muted">Deck ${p.deck.length} · discard ${p.discard.length} · hand ${p.hand.length}${p.refreshTile ? ' · shop refresh available' : ''}${mine && nextFuel !== undefined ? ` · next fuel upgrade ${nextFuel}c` : ''}</div>
  </div>`;
}

function endOpsBtns(s, p) {
  const fl = s.floors[p.floor];
  const label = p.floor === 0 ? 'End Operations → Surface' : 'End Operations';
  const B = (text, opt = {}, disabled = false) => btn(text, { type: 'endOps', opt }, { cls: 'primary', disabled });
  const roomy = p.storage.length < p.storageMax;
  switch (activeFloorCard(s, p.floor)) {
    case 'pileup':
      return (fl.minerals.includes('silver') && roomy ? B(`${label} + take ${gem('silver')}`, { pileup: true }) : '') + B(label);
    case 'squeeze':
      if (s.players.some((o) => o !== p && o.floor === p.floor)) return B(`${label} (pay fuel)`, { squeeze: 'fuel' }, p.fuel < 1) + B(`${label} (take damage)`, { squeeze: 'damage' });
      return B(label);
    case 'dispatch':
      return B(`${label} (+${2 * p.drones.filter(Boolean).length}c)`, { dispatch: 'credits' }) + B(`${label} (1⛽ → drone)`, { dispatch: 'drone' }, p.fuel < 1);
    case 'jackpot':
      return B(label) + [...new Set(p.storage)].filter(nextMineral).map((m) => B(`${label} + upgrade ${gem(m)}`, { exchange: m })).join('');
    case 'nocave':
      return B(label) + [['sapphire', 1], ['emerald', 2], ['ruby', 3]].filter(([, n]) => p.moves >= n && roomy)
        .map(([m, n]) => B(`${label} + ${n}↕️ → ${gem(m)}`, { cave: m })).join('');
    case 'chill':
      return B(`${label} (pay 1⛽)`, { chill: 'fuel' }, p.fuel < 1) + B(`${label} (take damage)`, { chill: 'damage' });
    case 'toys': {
      const targets = [...p.hand, ...p.discard, p.deck[0]].filter((iid) => iid && cardDef(s, iid).pts < 0);
      const extra = p.fuel >= 1 && p.storage.length ? targets.map((iid) => B(`${label} + repair ${esc(cardDef(s, iid).name)}`, { toys: iid })).join('') : '';
      return B(label) + extra;
    }
    default:
      return B(label);
  }
}

function actionsHtml(s, p) {
  const out = [];
  const fl = s.floors[p.floor];
  const canUndo = session.mode === 'guest' ? session.canUndo : session.undo.length > 0;
  out.push(`<button class="secondary" ${canUndo ? '' : 'disabled'} data-lobby="undo">↶ Undo</button>`);
  if (s.phase === 'ops') {
    const collectCost = p.turn.passives.includes('suction') ? 'free' : '1⛏';
    const canCollect = (p.drills >= 1 || collectCost === 'free') && p.storage.length < p.storageMax;
    out.push(btn('▲ Up', { type: 'move', dir: -1 }, { disabled: p.moves < 1 || p.floor === 0 }));
    out.push(btn('▼ Down', { type: 'move', dir: 1 }, { disabled: p.moves < 1 || p.floor === 6 || s.floors[p.floor + 1]?.barrier }));
    for (const m of new Set(fl.minerals)) {
      out.push(btn(`Collect ${gem(m)} (${collectCost})`, { type: 'collect', mineral: m }, { disabled: !canCollect }));
      if (activeFloorCard(s, p.floor) === 'lobby') out.push(btn(`Collect ${gem(m)} + 1c→1⛽`, { type: 'collect', mineral: m, pay: true }, { disabled: !canCollect || p.credits < 1 }));
    }
    if (fl.jackpot?.[p.idx]) out.push(btn(`Collect your Jackpot ${gem('emerald')} (${collectCost})`, { type: 'collect', jackpot: true }, { disabled: !canCollect }));
    if (fl.corridors.length) {
      const hot = activeFloorCard(s, p.floor) === 'hottub' && !p.turn.floorUsed.hottub;
      const cost = D.FLOORS[p.floor].corridorCost - (hot ? 1 : 0);
      out.push(btn(`Excavate corridor (${cost}⛏)`, { type: 'excavate' }, { disabled: p.drills < cost }));
    }
    const below = s.floors[p.floor + 1];
    if (below?.barrier) out.push(btn(`Drill barrier (${D.FLOORS[p.floor + 1].barrier.drill}⛏)`, { type: 'barrier' }, { disabled: p.drills < D.FLOORS[p.floor + 1].barrier.drill }));
    out.push(btn('3⛽ → 1↕️', { type: 'default', kind: 'move' }, { cls: 'secondary', disabled: p.fuel < 3 }));
    out.push(btn('4⛽ → 1⛏', { type: 'default', kind: 'drill' }, { cls: 'secondary', disabled: p.fuel < 4 }));
    out.push(btn('Take damage → 3⛽', { type: 'default', kind: 'damage' }, { cls: 'secondary', disabled: p.turn.dmgFuel }));
    if (p.drones.includes(true)) for (const m of new Set(p.storage)) out.push(btn(`Drone: sell ${gem(m)}`, { type: 'droneSell', mineral: m }, { cls: 'secondary' }));
    out.push(endOpsBtns(s, p));
  } else if (s.phase === 'surface') {
    out.push(`<span class="muted">Sell unwanted hand cards with their Discard +${D.DISCARD_CREDITS}c button, and buy from the Shops below.</span>`);
    out.push(btn(`Sell all storage (${p.storage.length})`, { type: 'sell' }, { disabled: !p.storage.length }));
    out.push(btn('Refuel', { type: 'refuel' }, { disabled: p.fuel >= p.fuelMax }));
    out.push(btn(`Upgrade storage (${D.STORAGE.upgradeCost}c)`, { type: 'upStorage' }, { disabled: p.storageMax >= D.STORAGE.max || p.credits < D.STORAGE.upgradeCost }));
    const fc = D.FUEL.upgradeCosts[p.fuelMax - D.FUEL.startMax];
    out.push(btn(`Upgrade fuel tank (${fc ?? '—'}c)`, { type: 'upFuel' }, { disabled: fc === undefined || p.credits < fc }));
    out.push(btn('Done surfacing → Upkeep', { type: 'endSurface' }, { cls: 'primary' }));
  } else if (s.phase === 'upkeep') {
    const cost = Math.max(0, keep.size - p.turn.keepFree);
    out.push(`<span class="muted">Tick cards in hand to keep (${p.turn.keepFree} free, then 1⛽ each).</span>`);
    out.push(btn(`End turn${keep.size ? ` (keep ${keep.size}, ${cost}⛽)` : ''}`, { type: 'endTurn', keep: [...keep] }, { cls: 'primary', disabled: p.fuel < cost }));
  }
  return `<div class="actions">${out.join('')}</div>`;
}

function handHtml(s, p, myTurn) {
  return p.hand.map((iid) => {
    const c = cardDef(s, iid);
    let b = '';
    if (myTurn && s.phase === 'ops') {
      const can = c.play === 'solid' ? p.storage.length > 0 : p.fuel >= c.play;
      const costLabel = c.play === 'solid' ? 'burn mineral' : `${c.play}⛽`;
      const base = { type: 'playMain', iid };
      if (c.choose) c.choose.forEach((o, i) => { b += btn(`Play: ${o.label} (${costLabel})`, { ...base, option: i }, { disabled: !can }); });
      else if (c.teleport) s.floors.forEach((f, fi) => { if (!f.barrier && fi !== p.floor) b += btn(`Play → ${floorLabel(fi)}`, { ...base, floor: fi }, { disabled: !can }); });
      else b += btn(`Play (${costLabel})`, base, { disabled: !can });
      b += btn(`Burn +${c.fuel}⛽`, { type: 'playFuel', iid }, { cls: 'secondary' });
    }
    if (myTurn && s.phase === 'surface') b += btn(`Discard +${D.DISCARD_CREDITS}c`, { type: 'discardCard', iid }, { cls: 'secondary' });
    if (myTurn) b += repairBtn(s, p, iid);
    if (myTurn && s.phase === 'upkeep') {
      b += `<label class="keep"><input type="checkbox" id="keep-${iid}" data-keep="${iid}" ${keep.has(iid) ? 'checked' : ''}> keep</label>`;
    }
    return cardHtml(s, iid, b);
  }).join('') || '<p class="muted">No cards in hand.</p>';
}

function abilityBtns(s, p, iid) {
  const c = cardDef(s, iid);
  const ab = c.ability;
  if (!ab || s.phase !== 'ops') return '';
  const spent = ab.limit === '1x' && p.turn.abil[iid];
  if (ab.special === 'harpoon') {
    let b = '';
    for (const f of [p.floor - 1, p.floor + 1]) {
      const fl = s.floors[f];
      if (!fl || fl.barrier) continue;
      for (const m of new Set(fl.minerals)) b += btn(`Harpoon ${gem(m)} from ${floorLabel(f)}`, { type: 'ability', iid, floor: f, mineral: m }, { disabled: spent || p.drills < 1 });
    }
    return b || '<span class="muted">nothing to harpoon</span>';
  }
  if (ab.special === 'exchange') {
    return [...new Set(p.storage)].filter(nextMineral).map((m) => btn(`Upgrade ${gem(m)}→${gem(nextMineral(m))}`, { type: 'ability', iid, mineral: m }, { disabled: spent })).join('') || '<span class="muted">nothing to upgrade</span>';
  }
  const cost = [ab.cost?.fuel ? `${ab.cost.fuel}⛽` : '', ab.cost?.drone ? 'drone' : ''].filter(Boolean).join('+');
  return btn(`Use${cost ? ` (${cost} → ${fxText(ab.gain)})` : `: ${fxText(ab.gain)}`}`, { type: 'ability', iid }, { disabled: spent });
}

function playAreaHtml(s, p, myTurn) {
  return p.play.map((iid) => {
    let b = '';
    if (myTurn && p.turn.mainPlayed.includes(iid)) b += abilityBtns(s, p, iid);
    if (myTurn) b += repairBtn(s, p, iid);
    return cardHtml(s, iid, b);
  }).join('');
}

function shopsHtml(s, p, myTurn) {
  return D.SHOPS.map(({ id, name }) => {
    const sh = s.shops[id];
    const cards = sh.row.map((iid) => {
      const c = cardDef(s, iid);
      let b = `<span class="price">${c.cost}c${c.bat ? ' + 🔋' : ''}</span>`;
      if (myTurn && s.phase === 'surface') b += btn('Buy', { type: 'buy', shop: id, iid }, { disabled: p.credits < c.cost });
      if (myTurn && s.phase === 'ops' && p.drones.includes(true)) b += btn('Drone buy', { type: 'droneBuy', shop: id, iid }, { cls: 'secondary', disabled: p.credits < c.cost });
      return cardHtml(s, iid, b);
    }).join('');
    const refresh = myTurn && s.phase === 'surface' && p.refreshTile ? btn('Refresh shop', { type: 'refreshShop', shop: id }, { cls: 'small secondary' }) : '';
    return `<div class="shop"><h3>${esc(name)} <span class="muted">(${sh.deck.length} left)</span> ${refresh}</h3><div class="cards">${cards || '<span class="muted">sold out</span>'}</div></div>`;
  }).join('');
}

function scoresHtml(s) {
  const rows = s.players.map((p, i) => {
    const sc = s.scores?.[i] || score(s, p);
    return `<tr class="${s.winner === i ? 'good' : ''}"><td>${esc(p.name)}</td><td>${sc.tiles}</td><td>${sc.minerals}</td><td>${sc.credits}</td><td>${sc.milestones}</td><td>${sc.refresh}</td><td>${sc.depth}</td><td>${sc.cards}</td><td><b>${sc.total}</b></td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><tr><th></th><th>Tiles</th><th>Minerals</th><th>Credits</th><th>Milestones</th><th>Refresh</th><th>Depth</th><th>Cards</th><th>Total</th></tr>${rows}</table></div>`;
}

function renderGame() {
  const s = session.state;
  if (!s) {
    app.innerHTML = `<section class="lobby"><h1>Drillers</h1>
      ${session.mode === 'host' ? `<p>Room code</p><div class="bigcode">${esc(session.code)}</div><p>Your friend opens this page and enters the code.</p>` : ''}
      <p class="status">${esc(session.status)}</p>
      <button class="secondary" data-lobby="leave">Back</button></section>`;
    return;
  }
  if (session.mode === 'local' && passCurtain !== null) {
    app.innerHTML = `<section class="lobby"><h1>Pass the phone</h1><p>Hand it to <b>${esc(s.players[passCurtain].name)}</b>.</p><button class="primary" data-lobby="reveal">I'm ${esc(s.players[passCurtain].name)} — show my turn</button></section>`;
    return;
  }
  const seat = session.mode === 'local' ? s.current : session.seat;
  const me = s.players[seat];
  const cur = s.players[s.current];
  const myTurn = !s.over && s.current === seat;
  const others = s.players.filter((p) => p.idx !== seat);
  const top = me.deck[0];
  const phaseName = { ops: 'Operations', surface: 'Surfacing', upkeep: 'Upkeep' }[s.phase];
  const canRepair = myTurn && s.phase !== 'upkeep' && (me.turn.repairs > 0 || (s.phase === 'surface' && !me.turn.repaired));

  app.innerHTML = `
    <header class="top">
      <div><b>Drillers</b> ${session.code ? `<span class="muted">room ${esc(session.code)}</span>` : ''}</div>
      <div class="status">${esc(session.status || '')}</div>
      <div><a href="${RULEBOOK}" target="_blank" rel="noopener">Rules</a> ${session.mode !== 'guest' ? '<button class="small secondary" data-lobby="move">Move device</button>' : ''} <button class="small secondary" data-lobby="leave">Menu</button></div>
    </header>
    ${s.over ? `<section><h2>Game over — ${esc(s.players[s.winner].name)} wins!</h2>${scoresHtml(s)}</section>` : `
    <div class="turn ${myTurn ? 'mine' : ''}">Turn ${s.turnNo}: <b>${esc(cur.name)}</b> — ${phaseName}${myTurn ? ' (you)' : ''}</div>`}
    ${s.endBy !== null && !s.over ? '<div class="alert">The mine is collapsing — final turns!</div>' : ''}
    ${message ? `<div class="alert">${esc(message)}</div>` : ''}
    <div class="layout">
      <section class="col">
        <h2>Mine ${pic('board')}</h2>
        ${mineHtml(s, me)}
        <h2>Log</h2>
        <div class="log">${s.log.slice(-12).reverse().map((l) => `<div>${esc(l)}</div>`).join('')}</div>
      </section>
      <section class="col">
        <h2>${esc(me.name)} (you) ${pic('dashboard')}</h2>
        ${dashHtml(s, me, true)}
        ${myTurn ? actionsHtml(s, me) : ''}
        <h3>Hand</h3>
        <div class="cards">${handHtml(s, me, myTurn)}</div>
        ${top ? `<h3>Top of your deck</h3><div class="cards">${cardHtml(s, top, myTurn ? repairBtn(s, me, top) : '')}</div>` : ''}
        ${me.play.length ? `<h3>Play area</h3><div class="cards">${playAreaHtml(s, me, myTurn)}</div>` : ''}
        ${me.perms.length ? `<h3>Permanent cards</h3><div class="cards">${me.perms.map((iid) => cardHtml(s, iid, myTurn ? abilityBtns(s, me, iid) : '')).join('')}</div>` : ''}
        ${canRepair && me.discard.length ? `<details><summary>Repair from discard pile</summary><div class="cards">${me.discard.map((iid) => cardHtml(s, iid, repairBtn(s, me, iid))).join('')}</div></details>` : ''}
        <h2>Shops</h2>
        ${shopsHtml(s, me, myTurn)}
        ${others.map((o) => `<h2>${esc(o.name)}</h2>${dashHtml(s, o, false)}`).join('')}
        ${!s.over ? `<details><summary>Current score estimate</summary>${scoresHtml(s)}</details>` : ''}
      </section>
    </div>`;
}

function render() {
  if (pendingMove) renderPendingMove();
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
  if (what === 'undo') {
    if (session.mode === 'guest') session.net.undo();
    else if (!undo(session.mode === 'local' ? session.state.current : session.seat)) { message = 'Nothing to undo.'; render(); }
  }
  if (what === 'host') { LS.del('drillers.host'); startHost(newCode(), null); }
  if (what === 'resumeHost') { const h = LS.get('drillers.host'); startHost(h.code, h.state); }
  if (what === 'join' || what === 'resumeGuest') {
    const code = what === 'join' ? document.getElementById('code').value.trim().toUpperCase() : LS.get('drillers.guest').code;
    if (code.length !== 5) { message = 'Enter the 5-letter room code.'; alert(message); return; }
    startGuest(code);
  }
  if (what === 'local') {
    const a = myName();
    const b = (document.getElementById('p2').value || '').trim() || 'Player 2';
    startLocal(setup({ names: [a, b], seed: Math.floor(Math.random() * 2 ** 31) }));
  }
  if (what === 'resumeLocal') startLocal(savedState(LS.get('drillers.local')));
  if (what === 'reveal') { passCurtain = null; render(); }
  if (what === 'move') moveDevice();
  if (what === 'shareMove') navigator.share({ title: 'Drillers game', url: session.url }).catch(() => {});
  if (what === 'copyMove') {
    navigator.clipboard.writeText(session.url)
      .then(() => { message = 'Link copied.'; }, () => { message = 'Copy failed. Select the link above and copy it.'; })
      .then(render);
  }
  if (what === 'acceptMove') {
    const m = pendingMove;
    pendingMove = null;
    if (m.mode === 'host') startHost(m.code, m.state); else startLocal(m.state);
  }
  if (what === 'rejectMove') { pendingMove = null; render(); }
  if (what === 'leave') {
    if (session?.net) session.net.destroy();
    session = null;
    message = '';
    render();
  }
});
app.addEventListener('change', (e) => {
  const k = e.target.dataset?.keep;
  if (!k) return;
  if (e.target.checked) keep.add(k); else keep.delete(k);
  render();
});

render();
