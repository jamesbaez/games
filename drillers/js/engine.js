// Pure game engine: apply(state, action) -> new state. Deterministic (seeded RNG in state).
import * as D from './data.js';

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

const CARD = Object.fromEntries(D.CARDS.map((c) => [c.id, c]));
const FLOOR_CARD = Object.fromEntries(D.FLOOR_CARDS.map((c) => [c.id, c]));

export const cardDef = (s, iid) => CARD[s.cards[iid]];
export const floorCardDef = (id) => FLOOR_CARD[id];
export function tileDef(id) {
  if (id[0] === 'k') return D.CORRIDOR_TILES[Number(id.slice(1))];
  const floor = Number(id.slice(1));
  return { floor, ...D.FLOORS[floor].barrier, minerals: [], barrier: true };
}
export const trackUsed = (p) => p.tiles.reduce((n, t) => n + tileDef(t.id).width, 0);
export const trackLimit = (p) => D.TRACK_LENGTH - Math.min(p.overflow.length, D.OVERFLOW_SLOTS);
export const shopSize = (s, shop) => (shop === 'adv' && s.advExpanded ? 4 : 2);
export const activeFloorCard = (s, f) => (s.floors[f].cardUp ? s.floors[f].card : null);
export const nextMineral = (m) => D.MINERALS[D.MINERALS.indexOf(m) + 1];

// ---------- rng ----------
function rand(s) {
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function shuffle(s, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const freshTurn = () => ({
  mainPlayed: [], abil: {}, passives: [], movesGained: 0, drillsGained: 0, fuelPlays: 0,
  dmgFuel: false, repairs: 0, repaired: false, keepFree: 1, floorUsed: {},
});

function log(s, msg) {
  s.log.push(msg);
  if (s.log.length > 60) s.log.shift();
}

function mk(s, defId) {
  const iid = 'c' + s.nextId++;
  s.cards[iid] = defId;
  return iid;
}

// ---------- setup ----------
export function setup({ names, seed = Date.now(), first }) {
  const n = names.length;
  const s = {
    v: 2, rng: seed >>> 0, cards: {}, nextId: 1, log: [], current: 0, phase: 'ops',
    over: false, endBy: null, finalTurns: null, turnNo: 1, scores: null,
  };
  s.floors = D.FLOORS.map((f) => ({ minerals: [...f.minerals], corridors: [], barrier: !!f.barrier, card: null, cardUp: false, jackpot: null }));
  for (const f of [2, 3, 4, 5, 6]) {
    s.floors[f].corridors = shuffle(s, D.CORRIDOR_TILES.map((_, i) => i).filter((i) => D.CORRIDOR_TILES[i].floor === f));
  }
  const starts = shuffle(s, D.FLOOR_CARDS.filter((c) => c.deck === 'start').map((c) => c.id));
  s.floors[2].card = starts[0];
  s.floors[2].cardUp = true;
  const deeps = shuffle(s, D.FLOOR_CARDS.filter((c) => c.deck === 'deep').map((c) => c.id));
  for (const f of [3, 4, 5, 6]) s.floors[f].card = deeps.pop();

  s.shops = {};
  for (const { id } of D.SHOPS) {
    const deck = shuffle(s, D.CARDS.filter((c) => c.shop === id).map((c) => mk(s, c.id)));
    s.shops[id] = { deck, row: deck.splice(0, 2) };
  }
  s.advUnder = s.shops.adv.deck.splice(0, 2);
  s.advExpanded = false;
  s.damagePile = D.DAMAGE_CARDS - n;
  s.milestones = D.MILESTONES.map(() => null);
  s.finalMilestone = null;

  s.players = names.map((name, i) => {
    const torso = mk(s, 'torso');
    const rest = D.CARDS.filter((c) => c.shop === 'start' && c.id !== 'torso').map((c) => mk(s, c.id));
    rest.push(mk(s, 'damage'));
    const p = {
      idx: i, name, floor: 0, deck: [torso, ...shuffle(s, rest)], hand: [], discard: [], play: [], perms: [],
      fuel: D.FUEL.start, fuelMax: D.FUEL.startMax, storageMax: D.STORAGE.start, storage: [],
      market: Object.fromEntries(D.MINERALS.map((m) => [m, 0])), overflow: [], tiles: [],
      drones: [true, false, false], refreshTile: true, credits: 0,
      moves: 0, drills: 0, turn: freshTurn(),
    };
    return p;
  });
  // Random first player (drawn after all shuffles); starting credits and cards follow turn order.
  s.current = first ?? Math.floor(rand(s) * n);
  s.players.forEach((p, i) => {
    const order = (i - s.current + n) % n;
    p.credits = D.STARTING_CREDITS[n][order];
    draw(s, p, D.STARTING_CARDS[n][order]);
  });
  log(s, `Game started. ${s.players[s.current].name} goes first.`);
  return s;
}

// ---------- helpers ----------
function reshuffleIfEmpty(s, p) {
  if (!p.deck.length && p.discard.length) {
    p.deck = shuffle(s, p.discard);
    p.discard = [];
    log(s, `${p.name} shuffles their discard pile into a new deck.`);
  }
}
function draw(s, p, n) {
  for (let i = 0; i < n; i++) {
    reshuffleIfEmpty(s, p);
    if (!p.deck.length) return;
    p.hand.push(p.deck.shift());
    reshuffleIfEmpty(s, p);
  }
}
function gainFuel(p, n) { p.fuel = Math.min(p.fuelMax, p.fuel + n); }
function refreshDrone(p) {
  const i = p.drones.indexOf(false);
  if (i >= 0) p.drones[i] = true;
}
function useDrone(p) {
  const i = p.drones.lastIndexOf(true);
  if (i < 0) fail('No active drone.');
  p.drones[i] = false;
}
function giveDamage(s, p, zone = 'discard') {
  if (s.damagePile > 0) {
    s.damagePile--;
    const d = mk(s, 'damage');
    if (zone === 'top') p.deck.unshift(d); else p[zone].push(d);
    log(s, `${p.name} takes 1 damage.`);
    return;
  }
  const m = [...D.MINERALS].reverse().find((x) => p.market[x] > 0);
  if (m) {
    p.market[m]--;
    log(s, `No DAMAGE cards left: ${p.name} loses a ${m} from their market.`);
  }
}
function toOverflow(s, p, m) {
  p.overflow.push(m);
  checkEnd(s, p);
}
const cheapest = (list) => [...list].sort((a, b) => D.MINERAL_POINTS[a] - D.MINERAL_POINTS[b])[0];
function burnSolid(s, p, wanted) {
  if (!p.storage.length) fail('Needs solid fuel: a mineral in storage.');
  const m = wanted && p.storage.includes(wanted) ? wanted : cheapest(p.storage);
  p.storage.splice(p.storage.indexOf(m), 1);
  log(s, `${p.name} burns a ${m} as solid fuel.`);
  toOverflow(s, p, m);
}
function sellMineral(s, p, m) {
  const sold = p.market[m];
  if (sold < 3) {
    const price = D.MARKET_PRICES[m][sold];
    p.market[m]++;
    p.credits += price;
    log(s, `${p.name} sells ${m} for ${price}.`);
  } else {
    p.credits += D.OVERFLOW_PRICE[m];
    log(s, `${p.name} sells ${m} to overflow for ${D.OVERFLOW_PRICE[m]}.`);
    toOverflow(s, p, m);
  }
}
function exchangeMineral(p, m) {
  const i = p.storage.indexOf(m);
  if (i < 0 || !nextMineral(m)) fail('Pick a mineral in storage that can be upgraded.');
  p.storage[i] = nextMineral(m);
}
function addTile(s, p, id) {
  p.tiles.push({ id, ex: false });
  const used = trackUsed(p);
  D.MILESTONES.forEach((m, i) => {
    if (s.milestones[i] === null && used >= m.at) {
      s.milestones[i] = p.idx;
      for (const o of s.players) if (o !== p) o.credits += m.credits;
      log(s, `${p.name} reaches milestone ${i + 1} (${m.pts} pts); others gain ${m.credits} credits.`);
    }
  });
  checkEnd(s, p);
}
function checkEnd(s, p) {
  if (s.endBy !== null || !p.tiles.length) return;
  if (trackUsed(p) >= trackLimit(p)) {
    s.endBy = p.idx;
    s.finalMilestone = p.idx;
    for (const o of s.players) if (o !== p) draw(s, o, D.FINAL_MILESTONE.draw);
    log(s, `${p.name} completes their progress track! The mine is collapsing — everyone else gets one final turn.`);
  }
}
function upStorage(p) { if (p.storageMax < D.STORAGE.max) p.storageMax++; }
function upFuel(p) { if (p.fuelMax - D.FUEL.startMax < D.FUEL.upgradeCosts.length) p.fuelMax++; }

function applyFx(s, p, fx = {}, iid) {
  if (fx.moves) { p.moves += fx.moves; p.turn.movesGained += fx.moves; }
  if (fx.drills) { p.drills += fx.drills; p.turn.drillsGained += fx.drills; }
  if (fx.fuel) gainFuel(p, fx.fuel);
  if (fx.credits) p.credits += fx.credits;
  for (let i = 0; i < (fx.drone || 0); i++) refreshDrone(p);
  if (fx.draw) draw(s, p, fx.draw);
  for (let i = 0; i < (fx.damage || 0); i++) giveDamage(s, p, 'discard');
  for (let i = 0; i < (fx.damageTop || 0); i++) giveDamage(s, p, 'top');
  for (let i = 0; i < (fx.damageHand || 0); i++) giveDamage(s, p, 'hand');
  if (fx.upStorage) upStorage(p);
  if (fx.upFuel) upFuel(p);
  if (fx.repair) p.turn.repairs += fx.repair;
  if (fx.removeSelf && iid) {
    p.play = p.play.filter((x) => x !== iid);
    log(s, `${cardDef(s, iid).name} is removed from the game.`);
  }
}

function findOwned(p, iid) {
  for (const zone of ['hand', 'play', 'discard']) if (p[zone].includes(iid)) return zone;
  if (p.deck[0] === iid) return 'deck';
  return null;
}
function repairCard(s, p, iid) {
  const zone = findOwned(p, iid);
  if (!zone) fail('You can repair a card in hand, play area, discard pile or on top of your deck.');
  p[zone] = p[zone].filter((x) => x !== iid);
  if (s.cards[iid] === 'damage') s.damagePile++;
  log(s, `${p.name} repairs away ${cardDef(s, iid).name}.`);
  if (zone === 'hand') draw(s, p, 1);
}

// Floor card triggers other than end of Operations.
function floorEffect(s, p, f, when, a = {}) {
  const id = activeFloorCard(s, f);
  if (!id) return;
  const first = (key) => {
    if (p.turn.floorUsed[key]) return false;
    p.turn.floorUsed[key] = true;
    return true;
  };
  if (when === 'reveal') {
    if (id === 'lobby') p.credits += 2;
    if (id === 'chill') gainFuel(p, 2);
    if (id === 'jackpot') s.floors[f].jackpot = s.players.map(() => true);
  }
  if (when === 'corridor') {
    if (id === 'ritz') p.credits += 2;
    if (id === 'chill') gainFuel(p, 2);
    if (id === 'radbath' && first('radbath')) { gainFuel(p, 5); giveDamage(s, p, 'discard'); }
  }
  if (when === 'collect') {
    if (id === 'squeeze') p.credits += 2;
    if (id === 'lobby' && a.pay) {
      if (p.credits < 1) fail('Lobby: you need 1 credit.');
      p.credits--;
      gainFuel(p, 1);
    }
  }
}

// End of Operations floor card effects (mech's current floor). Choices come in `o`.
function endOpsFloor(s, p, o = {}) {
  const f = p.floor;
  const fl = s.floors[f];
  const id = activeFloorCard(s, f);
  if (!id) return;
  switch (id) {
    case 'pileup':
      if (o.pileup) {
        if (!fl.minerals.includes('silver')) fail('No silver on this floor.');
        if (p.storage.length >= p.storageMax) fail('Storage is full.');
        fl.minerals.splice(fl.minerals.indexOf('silver'), 1);
        p.storage.push('silver');
      }
      break;
    case 'brewery': gainFuel(p, 1); break;
    case 'lobby': p.turn.keepFree = Math.max(p.turn.keepFree, 3); break;
    case 'squeeze': {
      const others = s.players.filter((x) => x !== p && x.floor === f).length;
      for (let i = 0; i < others; i++) {
        if (o.squeeze !== 'damage' && p.fuel >= 1) p.fuel--; else giveDamage(s, p, 'discard');
      }
      break;
    }
    case 'dispatch':
      if (o.dispatch === 'drone') {
        if (p.fuel < 1) fail('Dispatch: you need 1 fuel.');
        p.fuel--;
        refreshDrone(p);
      } else p.credits += 2 * p.drones.filter(Boolean).length;
      break;
    case 'jackpot':
      if (o.exchange) exchangeMineral(p, o.exchange);
      break;
    case 'nocave':
      if (o.cave) {
        const cost = { sapphire: 1, emerald: 2, ruby: 3 }[o.cave];
        if (!cost) fail('Pick sapphire, emerald or ruby.');
        if (p.moves < cost) fail(`Needs ${cost} moves.`);
        if (p.storage.length >= p.storageMax) fail('Storage is full.');
        p.moves -= cost;
        p.storage.push(o.cave);
      }
      break;
    case 'chill':
      if (o.chill !== 'damage' && p.fuel >= 1) p.fuel--; else giveDamage(s, p, 'discard');
      break;
    case 'toys':
      if (o.toys) {
        if (p.fuel < 1) fail("Toys R' Rust: you need 1 fuel.");
        if (!findOwned(p, o.toys)) fail('Pick a card you own to repair.');
        p.fuel--;
        burnSolid(s, p);
        repairCard(s, p, o.toys);
      }
      break;
    default: break;
  }
  log(s, `${FLOOR_CARD[id].name} resolves for ${p.name}.`);
}

function payBattery(s, p) {
  const t = p.tiles.find((x) => !x.ex && tileDef(x.id).ex === 'battery');
  if (!t) fail('Advanced cards need a battery: an unexhausted mine tile with a battery.');
  t.ex = true;
}
function buyCard(s, p, shop, iid) {
  const sh = s.shops[shop];
  if (!sh || !sh.row.includes(iid)) fail('That card is not in the shop.');
  const def = cardDef(s, iid);
  if (p.credits < def.cost) fail(`Not enough credits (need ${def.cost}).`);
  if (def.bat) payBattery(s, p);
  p.credits -= def.cost;
  sh.row = sh.row.filter((x) => x !== iid);
  if (def.perm) p.perms.push(iid);
  else p.deck.unshift(iid);
  log(s, `${p.name} buys ${def.name}.`);
}
function refillShops(s) {
  for (const { id } of D.SHOPS) {
    const sh = s.shops[id];
    while (sh.row.length < shopSize(s, id) && sh.deck.length) sh.row.push(sh.deck.shift());
  }
}

// ---------- scoring ----------
export function score(s, p) {
  const tiles = p.tiles.reduce((n, t) => { const d = tileDef(t.id); return n + d.pts - (t.ex ? d.loss : 0); }, 0);
  let minerals = [...p.storage, ...p.overflow].reduce((n, m) => n + D.MINERAL_POINTS[m], 0);
  for (const m of D.MINERALS) minerals += p.market[m] * D.MINERAL_POINTS[m];
  const credits = Math.floor(p.credits / 5);
  let milestones = 0;
  D.MILESTONES.forEach((m, i) => { if (s.milestones[i] === p.idx) milestones += m.pts; });
  if (s.finalMilestone === p.idx) milestones += D.FINAL_MILESTONE.pts;
  const refresh = p.refreshTile ? D.REFRESH_TILE_POINTS : 0;
  const depth = -D.FLOORS[p.floor].penalty;
  const owned = [...p.deck, ...p.hand, ...p.discard, ...p.play];
  const cards = owned.reduce((n, iid) => n + Math.min(0, cardDef(s, iid).pts), 0);
  const total = tiles + minerals + credits + milestones + refresh + depth + cards;
  return { tiles, minerals, credits, milestones, refresh, depth, cards, total };
}

// True if going from prev to next exposed hidden information (cards drawn or reshuffled,
// the next corridor tile, a floor card, shop cards) or passed the turn. Undo stops there.
export function revealsInfo(prev, next) {
  if (next.current !== prev.current || next.over || next.rng !== prev.rng || next.advExpanded !== prev.advExpanded) return true;
  if (next.floors.some((f, i) => f.corridors.length !== prev.floors[i].corridors.length || f.cardUp !== prev.floors[i].cardUp)) return true;
  if (next.players.some((p, i) => p.deck.length < prev.players[i].deck.length)) return true;
  return D.SHOPS.some(({ id }) => next.shops[id].deck.length < prev.shops[id].deck.length);
}

// ---------- actions ----------
export function apply(state, action) {
  const s = structuredClone(state);
  step(s, action);
  return s;
}

const OPS = new Set(['playMain', 'playFuel', 'default', 'move', 'collect', 'excavate', 'barrier', 'ability', 'droneSell', 'droneBuy', 'endOps']);
const SURFACE = new Set(['sell', 'discardCard', 'upStorage', 'upFuel', 'refuel', 'buy', 'refreshShop', 'endSurface']);

function step(s, a) {
  if (s.over) fail('The game is over.');
  if (a.p !== s.current) fail('It is not your turn.');
  const p = s.players[a.p];
  if (OPS.has(a.type) && s.phase !== 'ops') fail('Only during Operations.');
  if (SURFACE.has(a.type) && s.phase !== 'surface') fail('Only while surfacing.');
  if (a.type === 'endTurn' && s.phase !== 'upkeep') fail('Finish your Operations first.');

  switch (a.type) {
    case 'playMain': {
      if (!p.hand.includes(a.iid)) fail('Card not in hand.');
      const c = cardDef(s, a.iid);
      const opt = c.choose ? c.choose[a.option ?? 0] : null;
      if (c.choose && !opt) fail('Pick one of the options.');
      if (c.teleport) {
        const t = a.floor;
        if (!Number.isInteger(t) || t < 0 || t >= s.floors.length || s.floors[t].barrier) fail('Pick an open floor.');
      }
      if (c.play === 'solid') burnSolid(s, p, a.solid);
      else {
        if (p.fuel < c.play) fail(`Not enough fuel (need ${c.play}).`);
        p.fuel -= c.play;
      }
      p.hand = p.hand.filter((x) => x !== a.iid);
      p.play.push(a.iid);
      p.turn.mainPlayed.push(a.iid);
      log(s, `${p.name} plays ${c.name}${opt ? ` (${opt.label})` : ''}.`);
      applyFx(s, p, c.fx, a.iid);
      if (opt) applyFx(s, p, opt.fx);
      if (c.passive) {
        p.turn.passives.push(c.passive);
        if (c.passive === 'flywheel') gainFuel(p, p.turn.fuelPlays);
      }
      if (c.marketToOverflow) {
        const col = a.market && p.market[a.market] > 0 ? a.market : D.MINERALS.find((m) => p.market[m] > 0);
        if (col) { p.market[col]--; toOverflow(s, p, col); }
      }
      if (c.teleport) p.floor = a.floor;
      break;
    }
    case 'playFuel': {
      if (!p.hand.includes(a.iid)) fail('Card not in hand.');
      const c = cardDef(s, a.iid);
      p.hand = p.hand.filter((x) => x !== a.iid);
      p.play.push(a.iid);
      const bonus = p.turn.passives.filter((x) => x === 'flywheel').length;
      gainFuel(p, c.fuel + bonus);
      p.turn.fuelPlays++;
      log(s, `${p.name} burns ${c.name} for ${c.fuel + bonus} fuel.`);
      break;
    }
    case 'default': {
      if (a.kind === 'move') {
        if (p.fuel < D.DEFAULTS.moveFuel) fail('Not enough fuel.');
        p.fuel -= D.DEFAULTS.moveFuel;
        applyFx(s, p, { moves: 1 });
      } else if (a.kind === 'drill') {
        if (p.fuel < D.DEFAULTS.drillFuel) fail('Not enough fuel.');
        p.fuel -= D.DEFAULTS.drillFuel;
        applyFx(s, p, { drills: 1 });
      } else if (a.kind === 'damage') {
        if (p.turn.dmgFuel) fail('Only once per turn.');
        p.turn.dmgFuel = true;
        giveDamage(s, p, 'discard');
        gainFuel(p, D.DEFAULTS.damageFuel);
      } else fail('Unknown default function.');
      break;
    }
    case 'move': {
      if (p.moves < 1) fail('No moves left.');
      const to = p.floor + (a.dir < 0 ? -1 : 1);
      if (to < 0 || to >= s.floors.length) fail('Cannot move there.');
      if (s.floors[to].barrier) fail('That floor is still behind a barrier.');
      p.moves--;
      p.floor = to;
      break;
    }
    case 'collect': {
      const fl = s.floors[p.floor];
      const free = p.turn.passives.includes('suction');
      if (!free && p.drills < 1) fail('Need 1 drill.');
      if (p.storage.length >= p.storageMax) fail('Storage is full.');
      if (a.jackpot) {
        if (!fl.jackpot?.[p.idx]) fail('Your Jackpot emerald is not here.');
        fl.jackpot[p.idx] = false;
        p.storage.push('emerald');
      } else {
        const i = fl.minerals.indexOf(a.mineral);
        if (i < 0) fail('No such mineral here.');
        if (a.pay && p.credits < 1) fail('Lobby: you need 1 credit.');
        fl.minerals.splice(i, 1);
        p.storage.push(a.mineral);
      }
      if (!free) p.drills--;
      if (!a.jackpot) floorEffect(s, p, p.floor, 'collect', a);
      break;
    }
    case 'excavate': {
      const f = p.floor;
      const fl = s.floors[f];
      if (!fl.corridors.length) fail('No corridor tiles on this floor.');
      const hot = activeFloorCard(s, f) === 'hottub' && !p.turn.floorUsed.hottub;
      const cost = D.FLOORS[f].corridorCost - (hot ? 1 : 0);
      if (p.drills < cost) fail(`Need ${cost} drills.`);
      p.drills -= cost;
      const idx = fl.corridors.shift();
      fl.minerals.push(...D.CORRIDOR_TILES[idx].minerals);
      log(s, `${p.name} excavates a corridor on ${D.FLOORS[f].name}.`);
      addTile(s, p, 'k' + idx);
      if (hot) { p.turn.floorUsed.hottub = true; giveDamage(s, p, 'hand'); }
      floorEffect(s, p, f, 'corridor');
      if (p.turn.passives.includes('jackhammer')) gainFuel(p, 1);
      break;
    }
    case 'barrier': {
      const f = p.floor + 1;
      if (f >= s.floors.length || !s.floors[f].barrier) fail('No barrier below you.');
      const cost = D.FLOORS[f].barrier.drill;
      if (p.drills < cost) fail(`Need ${cost} drills.`);
      p.drills -= cost;
      s.floors[f].barrier = false;
      s.floors[f].cardUp = true;
      log(s, `${p.name} breaks through to ${D.FLOORS[f].name}` + (s.floors[f].card ? ` and finds ${FLOOR_CARD[s.floors[f].card].name}.` : '.'));
      addTile(s, p, 'b' + f);
      floorEffect(s, p, f, 'reveal');
      p.floor = f;
      if (f === 4 && !s.advExpanded) {
        s.advExpanded = true;
        s.shops.adv.row.push(...s.advUnder);
        s.advUnder = [];
        log(s, 'The advanced shop expands to 4 cards.');
      }
      if (p.turn.passives.includes('jackhammer')) gainFuel(p, 1);
      break;
    }
    case 'ability': {
      const isPerm = p.perms.includes(a.iid);
      if (!isPerm && !p.turn.mainPlayed.includes(a.iid)) fail('Play that card for its main effect first.');
      const c = cardDef(s, a.iid);
      const ab = c.ability;
      if (!ab) fail('No ability.');
      const used = p.turn.abil[a.iid] || 0;
      if (ab.limit === '1x' && used) fail('Already used this turn.');
      if (ab.req?.movesGained && p.turn.movesGained < ab.req.movesGained) fail(`Needs ${ab.req.movesGained} moves gained this turn.`);
      if (ab.req?.drillsGained && p.turn.drillsGained < ab.req.drillsGained) fail(`Needs ${ab.req.drillsGained} drills gained this turn.`);
      if (ab.cost?.fuel && p.fuel < ab.cost.fuel) fail('Not enough fuel.');
      if (ab.cost?.drone && !p.drones.includes(true)) fail('No active drone.');
      if (ab.special === 'harpoon') {
        const t = a.floor;
        if (Math.abs(t - p.floor) !== 1 || !s.floors[t] || s.floors[t].barrier) fail('Pick an adjacent open floor.');
        if (!s.floors[t].minerals.includes(a.mineral)) fail('No such mineral there.');
        if (p.drills < 1) fail('Need 1 drill.');
        if (p.storage.length >= p.storageMax) fail('Storage is full.');
        s.floors[t].minerals.splice(s.floors[t].minerals.indexOf(a.mineral), 1);
        p.storage.push(a.mineral);
        p.drills--;
        floorEffect(s, p, t, 'collect', {});
      }
      if (ab.special === 'exchange') exchangeMineral(p, a.mineral);
      if (ab.cost?.fuel) p.fuel -= ab.cost.fuel;
      if (ab.cost?.drone) useDrone(p);
      applyFx(s, p, ab.gain);
      p.turn.abil[a.iid] = used + 1;
      log(s, `${p.name} uses ${c.name}.`);
      break;
    }
    case 'repair': {
      if (s.phase === 'upkeep') fail('Not during Upkeep.');
      if (!findOwned(p, a.iid)) fail('You can repair a card in hand, play area, discard pile or on top of your deck.');
      if (p.turn.repairs > 0) p.turn.repairs--;
      else {
        if (s.phase !== 'surface') fail('No repair available.');
        if (p.turn.repaired) fail('You can only buy one repair per surfacing.');
        if (p.credits < D.REPAIR_COST) fail(`Repair costs ${D.REPAIR_COST} credits.`);
        p.credits -= D.REPAIR_COST;
        p.turn.repaired = true;
      }
      repairCard(s, p, a.iid);
      break;
    }
    case 'droneSell': {
      if (!p.drones.includes(true)) fail('No active drone.');
      const i = p.storage.indexOf(a.mineral);
      if (i < 0) fail('Mineral not in storage.');
      useDrone(p);
      p.storage.splice(i, 1);
      sellMineral(s, p, a.mineral);
      break;
    }
    case 'droneBuy': {
      if (!p.drones.includes(true)) fail('No active drone.');
      buyCard(s, p, a.shop, a.iid);
      useDrone(p);
      break;
    }
    case 'exhaust': {
      if (s.phase === 'upkeep') fail('Not during Upkeep.');
      const t = p.tiles[a.index];
      if (!t || t.ex) fail('Tile already exhausted.');
      const d = tileDef(t.id);
      if (d.ex === 'battery') fail('Batteries are spent automatically when you buy an advanced card.');
      t.ex = true;
      applyFx(s, p, d.ex);
      break;
    }
    case 'endOps': {
      endOpsFloor(s, p, a.opt);
      p.moves = 0;
      p.drills = 0;
      s.phase = p.floor === 0 ? 'surface' : 'upkeep';
      log(s, p.floor === 0 ? `${p.name} surfaces.` : `${p.name} ends Operations on ${D.FLOORS[p.floor].name}.`);
      break;
    }
    case 'sell': {
      if (!p.storage.length) fail('Storage is empty.');
      const minerals = p.storage;
      p.storage = [];
      for (const m of minerals) sellMineral(s, p, m);
      break;
    }
    case 'discardCard': {
      if (!p.hand.includes(a.iid)) fail('Card not in hand.');
      p.hand = p.hand.filter((x) => x !== a.iid);
      p.discard.push(a.iid);
      p.credits += D.DISCARD_CREDITS;
      break;
    }
    case 'upStorage': {
      if (p.storageMax >= D.STORAGE.max) fail('Storage fully upgraded.');
      if (p.credits < D.STORAGE.upgradeCost) fail(`Costs ${D.STORAGE.upgradeCost} credits.`);
      p.credits -= D.STORAGE.upgradeCost;
      upStorage(p);
      break;
    }
    case 'upFuel': {
      const cost = D.FUEL.upgradeCosts[p.fuelMax - D.FUEL.startMax];
      if (cost === undefined) fail('Fuel tank fully upgraded.');
      if (p.credits < cost) fail(`Costs ${cost} credits.`);
      p.credits -= cost;
      upFuel(p);
      break;
    }
    case 'refuel': p.fuel = p.fuelMax; break;
    case 'buy': buyCard(s, p, a.shop, a.iid); break;
    case 'refreshShop': {
      if (!p.refreshTile) fail('Shop refresh tile already used.');
      const sh = s.shops[a.shop];
      if (!sh) fail('Unknown shop.');
      p.refreshTile = false;
      sh.deck.push(...shuffle(s, sh.row));
      sh.row = sh.deck.splice(0, shopSize(s, a.shop));
      log(s, `${p.name} refreshes a shop.`);
      break;
    }
    case 'endSurface': s.phase = 'upkeep'; break;
    case 'endTurn': {
      const keep = (a.keep || []).filter((x) => p.hand.includes(x));
      const cost = Math.max(0, keep.length - p.turn.keepFree);
      if (p.fuel < cost) fail(`Keeping ${keep.length} cards costs ${cost} fuel.`);
      p.fuel -= cost;
      p.discard.push(...p.hand.filter((x) => !keep.includes(x)), ...p.play);
      p.hand = keep;
      p.play = [];
      p.moves = 0;
      p.drills = 0;
      draw(s, p, D.HAND_SIZE);
      refillShops(s);
      p.turn = freshTurn();
      if (s.endBy !== null) {
        s.finalTurns = s.finalTurns === null ? s.players.length - 1 : s.finalTurns - 1;
        if (s.finalTurns <= 0) return gameOver(s);
      }
      s.current = (s.current + 1) % s.players.length;
      s.phase = 'ops';
      s.turnNo++;
      break;
    }
    default: fail('Unknown action.');
  }
}

function gameOver(s) {
  s.over = true;
  s.scores = s.players.map((p) => score(s, p));
  const order = s.players.map((p, i) => i).sort((a, b) =>
    s.scores[b].total - s.scores[a].total ||
    s.players[b].credits - s.players[a].credits ||
    s.players[b].fuel - s.players[a].fuel);
  s.winner = order[0];
  log(s, `The mine collapses! ${s.players[s.winner].name} wins with ${s.scores[s.winner].total} points.`);
}
