// Pure rules engine for Starship Captains. No DOM access, no imports but the data.
// The state is plain JSON so it can be saved, sent over the wire and compared by value.
import * as D from './data.js';

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

// ---------- lookups ----------
const LOC = Object.fromEntries(D.LOCS.map((l) => [l.id, l]));
export const locDef = (id) => LOC[id];

// Route indices touching a location, and the location at the far end.
const ROUTES_AT = Object.fromEntries(D.LOCS.map((l) => [l.id, []]));
D.ROUTES.forEach((r, i) => { ROUTES_AT[r.a].push(i); ROUTES_AT[r.b].push(i); });
export const routesAt = (loc) => ROUTES_AT[loc];
export const routeEnd = (i, from) => (D.ROUTES[i].a === from ? D.ROUTES[i].b : D.ROUTES[i].a);
export const neighbours = (loc) => routesAt(loc).map((i) => routeEnd(i, loc));

// ---------- rng ----------
// mulberry32, seeded from the state so every game is reproducible from { seed }.
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
// A bag of token types expanded from { id/c/reward, n } counts, then shuffled.
const bag = (s, defs, key) => shuffle(s, defs.flatMap((d) => Array.from({ length: d.n ?? 1 }, () => d[key] ?? d)));

// ---------- setup ----------
export function setup({ names, seed = Date.now(), first } = {}) {
  if (!names?.length || names.length > 4) fail('Starship Captains is for 1-4 captains.');
  const s = {
    v: 2,
    rng: (seed >>> 0) || 1,
    round: 1,
    over: false,
    log: [],
    history: null,
    pending: null,
    scores: null,
  };

  // Which side of each faction track is in play, chosen at random, plus its event card.
  // The Cooperative and Ni'an tracks each draw one of their five events; the Tincan track
  // has only one event, and it also gets a face-up alpha tech (rulebook p. 5, step 4a),
  // dealt below once the tech deck exists.
  s.tracks = D.FACTIONS.map((f) => {
    const pool = D.eventsFor(f.id);
    return {
      id: f.id,
      side: f.sides[Math.floor(rand(s) * f.sides.length)].id,
      event: pool.length ? pool[Math.floor(rand(s) * pool.length)].id : null,
      tech: null,
    };
  });
  s.eventsDone = 0;

  // Pirates are placed below, once the bag of tokens exists.

  // Deal the triangle tiles. The home station tile waits on the round track; the other
  // 7 (numbered 1-5 plus the two planet stations) go to random planets, and every planet
  // left over starts with a face-up mission.
  const planets = D.LOCS.filter((l) => !l.station).map((l) => l.id);
  const spots = shuffle(s, [...planets]);
  s.tiles = {};
  s.stations = {}; // id -> { at: planet it belongs to, out: is the tile on the planet now }
  const placeable = [
    ...Array.from({ length: D.NUMBERED_TILES }, (_, i) => ({ kind: 'num', n: i + 1 })),
    ...D.STATION_TILES.filter((t) => !t.home).map((t) => ({ kind: 'station', id: t.id })),
  ];
  for (const tile of shuffle(s, placeable)) {
    const at = spots.pop();
    if (tile.kind === 'num') s.tiles[at] = { n: tile.n, up: true };
    else s.stations[tile.id] = { at, out: true };
  }
  // The home station tile starts on the round track: every ship begins at Home, and a
  // station tile is only put out when no ship is on its planet.
  s.stations.home = { at: 'home', out: false };

  // Every planet without a tile starts with a face-up mission; the rest of the deck
  // refills planets as missions are completed.
  s.missionDeck = shuffle(s, D.MISSIONS.map((m) => m.id));
  s.missions = Object.fromEntries(spots.map((id) => [id, s.missionDeck.pop()]));

  // The tech deck is alpha and beta shuffled together, but the face-up cards dealt at
  // setup must all be alpha: a beta card turned up goes to the bottom of the deck
  // unseen, which `dealAlpha` does by rotating it past the end.
  const techDeck = shuffle(s, D.TECHS.flatMap((c) => Array.from({ length: c.n }, () => c.id)));
  const dealAlpha = () => {
    for (let guard = techDeck.length; guard > 0; guard--) {
      const id = techDeck.pop();
      if (D.techDef(id).tier === 'a') return id;
      techDeck.unshift(id);
    }
    fail('the tech deck ran out of alpha techs');
  };
  s.tracks.find((t) => t.id === 'tincan').tech = dealAlpha();
  const omegaDeck = shuffle(s, D.OMEGA.map((c) => c.id));
  s.tech = {
    deck: techDeck,
    discard: [],
    row: Array.from({ length: D.TECH_ROW }, dealAlpha),
    omega: omegaDeck.splice(-D.OMEGA_ROW),
    omegaDeck,
    omegaDiscard: [],
  };
  s.artifactBag = bag(s, D.ARTIFACTS.map((a) => ({ ...a, n: 9 })), 'id'); // 27 tokens, 9 of each
  s.artifactDiscard = [];
  s.pirateBag = bag(s, D.PIRATES, null);
  s.pirateDiscard = [];

  // Each route holds the pirate token itself, not just a flag, so you can see what a
  // pirate is worth before you decide to fight it - the ship side is face up. It also
  // means defeating one pays out the token that was actually sitting there.
  s.pirates = D.ROUTES.map(() => null);
  for (const [a, b] of D.SETUP_PIRATES) {
    const i = D.routeBetween(a, b);
    if (i < 0) fail(`setup pirate on a route that doesn't exist: ${a}-${b}`);
    s.pirates[i] = s.pirateBag.pop() ?? null; // the skull routes take whatever comes out
  }

  s.first = Number.isInteger(first) ? first : Math.floor(rand(s) * names.length);
  s.current = s.first;
  s.turn = { acted: false };
  s.players = names.map((name, idx) => ({
    idx,
    name,
    at: 'home',
    ready: [...D.SHIP.ready],
    queue: [...D.SHIP.queue],
    cargo: Array.from({ length: D.SHIP.cargoSlots }, (_, i) => (i < D.SHIP.cargoDamaged ? { t: 'dmg' } : null)),
    excess: 0,
    techSlots: D.SLOT_BOARD.map((sl) => ({ tech: null, dmg: sl.dmg })),
    roomDmg: {}, // basic rooms knocked out by the Sabotaged Negotiations event
    medals: D.SHIP.medals,
    rings: D.SHIP.rings,
    marks: D.FACTIONS.map(() => ({ sp: 0, loops: 0 })),
    done: [],
    passed: false,
  }));
  log(s, `Round 1. ${s.players[s.first].name} has the first turn.`);
  return s;
}

const log = (s, line) => { s.log.push(line); };

// ---------- derived ----------
// A planet is reserved by the only ship standing on it; with two or more, nobody reserves
// it but any of them may complete its mission (rulebook p. 8).
export function reservedBy(s, loc) {
  const here = s.players.filter((p) => p.at === loc);
  return here.length === 1 ? here[0].idx : null;
}
export const damageCount = (p) => p.cargo.filter((c) => c?.t === 'dmg').length + p.excess
  + p.techSlots.filter((t) => t.dmg).length;
export const cargoTokens = (p) => p.cargo.filter((c) => c && c.t !== 'dmg');

// Which bonus icons would fire if a tech with these edges went into slot i. Facing icons
// come from the installed card if there is one, else the slot's own printed icons; a card
// covers the icons of the slot it sits in.
export function bonusesFor(s, p, i, card) {
  const edge = (j, side) => {
    if (j < 0 || j >= p.techSlots.length) return [];
    const t = p.techSlots[j].tech;
    return (t ? techDef(t) : D.SLOT_BOARD[j])[side] ?? [];
  };
  const left = edge(i - 1, 'R').filter((x) => (card.L ?? []).includes(x));
  const right = edge(i + 1, 'L').filter((x) => (card.R ?? []).includes(x));
  // One effect per match, resolved top to bottom (repair, medal, move).
  return D.BONUS_ICONS.filter((ic) => left.includes(ic) || right.includes(ic));
}

export const techDef = D.techDef;

// ---------- scoring ----------
// Everything is counted in half-points so the 1/2 per medal and artifact stays integer.
export function score(s, p) {
  const trackPts2 = p.marks.reduce((n, m) => n + 2 * (D.TRACK_ZONE_PTS[m.sp] + m.loops * D.TRACK_LOOP_PTS), 0);
  const crew = [...p.ready, ...p.queue];
  const commanders = crew.filter(D.isCommander).length;
  const androids = crew.filter((f) => f === D.ANDROID).length;
  const pirates = p.cargo.filter((c) => c?.t === 'pir').length;
  const artifacts = p.cargo.filter((c) => c?.t === 'art').length;
  const dmg = damageCount(p);
  const crewPts2 = commanders * D.PTS2.commander + androids * D.PTS2.android + pirates * D.PTS2.pirate;
  const tokenPts2 = p.medals * D.PTS2.medal + artifacts * D.PTS2.artifact;
  const omegaPts2 = p.techSlots.reduce((n, sl) => n + (sl.tech && techDef(sl.tech)?.score ? omegaScore(s, p, techDef(sl.tech)) : 0), 0);
  const missionPts2 = p.done.reduce((n, id) => n + 2 * D.missionDef(id).pts, 0);
  const total2 = trackPts2 + crewPts2 + tokenPts2 + omegaPts2 + missionPts2 + dmg * D.PTS2.damage;
  return { trackPts2, crewPts2, tokenPts2, omegaPts2, missionPts2, damage: dmg, total2 };
}

function omegaScore(s, p, card) {
  const { per, c, pts2 } = card.score;
  const crew = [...p.ready, ...p.queue];
  const count = {
    flat: () => 1,
    artifactType: () => new Set(p.cargo.filter((x) => x?.t === 'art').map((x) => x.id)).size,
    pirate: () => p.cargo.filter((x) => x?.t === 'pir').length,
    commander: () => crew.filter(D.isCommander).length,
    damage: () => damageCount(p),
    figColor: () => crew.filter((f) => D.figColor(f) === c).length,
    iconPair: () => countIconPairs(p),
    missionColor: () => p.done.filter((id) => D.missionHasColor(D.missionDef(id), c)).length,
  }[per];
  return (count ? count() : 0) * pts2;
}

// Who a commander may call up as its second task: "The subordinate must be either a cadet
// or an ensign of the commander's color" (rulebook p. 13). Never another commander - and
// never the commander itself, which is already in the queue by this point because it went
// there the moment it was assigned.
export const subordinates = (p, cmd) =>
  p.queue.filter((x) => x === D.CADET || (!D.isCommander(x) && D.figColor(x) === D.figColor(cmd)));

// Matching pairs of tech bonus icons across the whole tech-slot board, counting the
// pair printed on the board itself wherever it is still uncovered.
export function countIconPairs(p) {
  let n = 0;
  for (let i = 0; i < p.techSlots.length - 1; i++) {
    const side = (j, k) => { const t = p.techSlots[j].tech; return (t ? techDef(t) : D.SLOT_BOARD[j])[k] ?? []; };
    n += D.BONUS_ICONS.filter((ic) => side(i, 'R').includes(ic) && side(i + 1, 'L').includes(ic)).length;
  }
  return n;
}

// ---------- the pending machine ----------
// Effects resolve left to right, and some of them ask the player a question part way
// through (which route to move down, which damage to repair). So a half-resolved effect
// lives on a stack of plain-JSON frames in s.pending, and pump() runs it until either the
// stack empties or the top frame is a question. Frames must stay JSON: undo replays a
// turn and compares states with JSON.stringify.
//   { k:'fx',  fx, i }        an ordered effect list, i effects already done
//   { k:'adv', t, left }      advancing t's marker, left steps to go
//   { k:'ask', q, ... }       waiting for { type:'choose', opt }
//   { k:'mission', id, at, crew, i, phase }   resolving a mission line by line
//   { k:'room', fig, phase }  a room activation, kept open for a commander's second task
const push = (s, frame) => { (s.pending ||= []).push(frame); };
const top = (s) => s.pending?.[s.pending.length - 1] ?? null;
export const ask = (s) => (top(s)?.k === 'ask' ? top(s) : null);
const askFor = (s, q, extra = {}) => { push(s, { k: 'ask', q, ...extra }); };

export function pump(s) {
  let guard = 0;
  while (s.pending?.length) {
    if (++guard > 500) fail('That effect did not finish; please undo.');
    const f = top(s);
    if (f.k === 'ask') return;
    if (f.k === 'fx') {
      if (f.i >= f.fx.length) { s.pending.pop(); continue; }
      const tok = f.fx[f.i++];
      resolveToken(s, s.players[s.current], tok);
      continue;
    }
    if (f.k === 'adv') {
      if (f.left <= 0) { s.pending.pop(); continue; }
      f.left--;
      stepTrack(s, s.players[s.current], f.t, f.noBonus);
      continue;
    }
    if (f.k === 'endTurn') { s.pending.pop(); finishTurn(s); continue; }
    if (f.k === 'spend') {
      if (f.left <= 0) { s.pending.pop(); continue; }
      const who = s.players[s.current];
      const opts = payChoices(s, who);
      if (!opts.length) fail('You cannot pay that many medals.');
      if (opts.length === 1) { payOne(s, who, opts[0]); f.left--; continue; }
      askFor(s, 'spend', { left: f.left });
      return;
    }
    if (f.k === 'mission') { missionStep(s, f); continue; }
    if (f.k === 'room') {
      // The room's effects are done. A commander now takes a second task; anyone else
      // is finished and the frame closes.
      if (f.phase === 'first' && D.isCommander(f.fig)) { f.phase = 'ask'; askFor(s, 'second', { fig: f.fig }); continue; }
      s.pending.pop();
      continue;
    }
    s.pending.pop();
  }
  s.pending = null;
}

// ---------- installed tech abilities ----------
// Every ability tech is a `when` label on the card plus whatever parameters it needs.
// These helpers ask "does this player have such a tech?" so the rules below stay short.
// A tech counts only while it is installed in a slot; the Tincan track's shared tech
// counts for everybody once its event has fired.
export function abilities(s, p, when) {
  const out = [];
  for (const sl of p.techSlots) {
    const d = sl.tech && techDef(sl.tech);
    if (d?.when === when) out.push(d);
  }
  const sh = sharedTech(s) && techDef(sharedTech(s));
  if (sh?.when === when) out.push(sh);
  return out;
}
const hasAbility = (s, p, when, test = () => true) => abilities(s, p, when).some(test);

// Which bonus each matching edge icon pays out, in the order they are printed.
const BONUS_FX = { rep: ['repair', 1], med: ['medal', 1], mov: 'move' };

// Repair Bots and the Wormhole Generator rewrite what a move bonus pays out, and the
// Training Holovisor adds a free training to a medal bonus.
function bonusEffects(s, p, icons) {
  const fx = [];
  for (const ic of icons) {
    let tok = BONUS_FX[ic];
    for (const d of abilities(s, p, 'convert')) {
      if (d.from === ic) tok = d.to === 'rep' ? ['repair', 1] : d.to;
    }
    fx.push(tok);
    if (ic === 'med' && hasAbility(s, p, 'medalBonusTrains')) fx.push('freeTrain');
  }
  return fx;
}

// What a train or a promotion costs this player, after the suits and the Quadcorders.
export function trainCost(s, p, to) {
  return hasAbility(s, p, 'trainFree', (d) => d.c === to) ? 0 : D.TRAIN_COST;
}
export function promoteCost(s, p, c) {
  const less = abilities(s, p, 'promoteCheap').filter((d) => d.c === c).reduce((n, d) => n + d.less, 0);
  return Math.max(0, D.PROMOTE_COST - less);
}

// Medals are spent from the medal pile, but the Artifact and Trophy Displays let stored
// tokens stand in for them. Which to give up is a real decision - a pirate token is worth
// a point, an artifact half of one, and an artifact may be carrying an omega card's set -
// so the player is asked whenever more than one kind could pay.
const spendKinds = (s, p) => abilities(s, p, 'spendAs').map((d) => d.tok);

export function medalsAvailable(s, p) {
  const kinds = spendKinds(s, p);
  return p.medals + p.cargo.filter((c) => c && kinds.includes(c.t)).length;
}

// The distinct things that could pay one medal right now: the medal pile, then one entry
// per kind of stored token (artifacts of the same face count as one choice).
export function payChoices(s, p) {
  const kinds = spendKinds(s, p);
  const out = p.medals > 0 ? [{ medal: true }] : [];
  const seen = new Set();
  p.cargo.forEach((c, i) => {
    if (!c || !kinds.includes(c.t)) return;
    const key = c.t === 'art' ? `art:${c.id}` : c.t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ i });
  });
  return out;
}

function payOne(s, p, opt) {
  if (opt?.medal) {
    if (p.medals < 1) fail('You have no medal to spend.');
    p.medals--;
    return;
  }
  const c = p.cargo[opt?.i];
  if (!c || !spendKinds(s, p).includes(c.t)) fail('That cannot be spent as a medal.');
  if (c.t === 'art') s.artifactDiscard.push(c.id);
  log(s, `${p.name} spends a stored ${c.t === 'art' ? 'artifact' : 'pirate token'} as a medal.`);
  p.cargo[opt.i] = null;
}

// Dimensional Lockers widen the hold. The extra slots live on the end of p.cargo, added
// when the tech is installed, so every other cargo rule works unchanged.
function syncStorage(s, p) {
  const want = D.SHIP.cargoSlots + abilities(s, p, 'extraStorage').reduce((n, d) => n + d.slots, 0);
  while (p.cargo.length < want) p.cargo.push(null);
  while (p.cargo.length > want && p.cargo[p.cargo.length - 1] === null) p.cargo.pop();
}

// The observers and comms fire after the thing they watch for.
function afterTrigger(s, p, when, test = () => true) {
  for (const d of abilities(s, p, when)) {
    if (test(d)) { log(s, `${d.name} reports in.`); push(s, { k: 'fx', fx: d.fx, i: 0 }); }
  }
}

function deckDraw(s, which) {
  if (!s.tech[which].length) {
    const pile = which === 'deck' ? 'discard' : 'omegaDiscard';
    s.tech[which] = shuffle(s, s.tech[pile].splice(0));
  }
  return s.tech[which].pop() ?? null;
}
const drawFrom = (s, which, n) => Array.from({ length: n }, () => deckDraw(s, which)).filter(Boolean);

// Everything a research effect could install right now: the face-up board, or, for the
// effects that draw their own cards, just those.
export function techChoices(s, f) {
  return f.pool ?? [...s.tech.row, ...s.tech.omega].filter(Boolean);
}

// Which tech slots this research effect can fill. Damaged slots are closed until repaired;
// an occupied slot is only available to a recycle effect.
export function techSlotChoices(p, f) {
  return p.techSlots.map((sl, i) => ({ sl, i }))
    .filter(({ sl }) => !sl.dmg && (!sl.tech || f.recycle))
    .map(({ i }) => i);
}

// Take the chosen card out of wherever it came from, leaving a hole the board refills at
// the end of the turn. Cards drawn but not taken go to the bottom of their deck.
function takeTech(s, f, card) {
  if (f.pool) {
    const rest = f.pool.filter((c) => c !== card);
    s.tech[f.omega ? 'omegaDeck' : 'deck'].unshift(...rest);
    return;
  }
  for (const key of ['row', 'omega']) {
    const i = s.tech[key].indexOf(card);
    if (i >= 0) { s.tech[key][i] = null; return; }
  }
  fail('That tech is not on the board.');
}

const discardTech = (s, card) => {
  s.tech[D.OMEGA.some((o) => o.id === card) ? 'omegaDiscard' : 'discard'].push(card);
};

// The board tops itself up at the end of the turn, always from the alpha-beta deck even
// where an omega card was taken (rulebook p. 11).
function refillTech(s) {
  for (const key of ['row', 'omega']) {
    for (let i = 0; i < s.tech[key].length; i++) {
      if (s.tech[key][i] == null) s.tech[key][i] = deckDraw(s, 'deck');
    }
  }
}

// ---------- missions ----------
// One line at a time, top to bottom. `phase` tracks where inside a line we are, so the
// frame can survive the questions the line's effects ask:
//   null     about to start line i
//   'offer'  waiting on 'resolve this line?' (the line can hurt, so it is declinable)
//   'first'  the line's effects have just finished
//   'ask'    waiting on a commander's second task
//   'second' the second task has finished
function missionStep(s, f) {
  const p = s.players[s.current];
  const m = D.missionDef(f.id);
  if (f.i >= m.lines.length) { s.pending.pop(); finishMission(s, p, f); return; }
  const fig = f.crew[f.i];
  const line = m.lines[f.i];

  if (!f.phase) {
    if (!D.matches(fig, line.c)) {
      log(s, `${figName(fig)} is the wrong colour for that line; nothing happens.`);
      f.i++;
      return;
    }
    // Every matching line is offered, never resolved automatically. Rulebook p. 13: "If the
    // figure is an ensign matching the color of the line, you MAY perform all depicted
    // effects... or if there is an effect you want to avoid, ignore the entire line." Even
    // a line that looks like pure profit can be unwanted - advancing a track past an event
    // space, or drawing artifacts you have no room for.
    f.phase = 'offer';
    askFor(s, 'line', { line: f.i });
    return;
  }
  if (f.phase === 'first') {
    // A commander resolves the line, then does a second task before the next line.
    if (D.isCommander(fig)) { f.phase = 'ask'; askFor(s, 'second', { line: f.i, fig }); return; }
    f.phase = null;
    f.i++;
    return;
  }
  if (f.phase === 'second') { f.phase = null; f.i++; return; }
  // 'offer' and 'ask' are cleared by choose(), which is the only way out of them.
  fail('That mission is waiting on a choice.');
}

// Whether any line of a mission uses one of these effects, for Ni'an Comms.
function missionHad(m, keys) {
  const seen = [];
  const walk = (fx) => {
    for (const tok of fx ?? []) {
      if (Array.isArray(tok) || typeof tok === 'string') { seen.push(tokName(tok)); continue; }
      if (tok?.then) walk(tok.then);
      if (tok?.either) tok.either.forEach(walk);
    }
  };
  for (const line of m.lines) walk(line.fx);
  return seen.some((k) => keys.includes(k));
}

// Whether a line contains anything a player might not want. Costs inside `pay` and the
// branches of `either` are already choices, so only unconditional harm counts.

const figName = (f) => (f === D.ANDROID ? 'the android'
  : f === D.CADET ? 'the cadet'
  : `the ${D.figColor(f)} ${D.isCommander(f) ? 'commander' : 'ensign'}`);

function finishMission(s, p, f) {
  const m = D.missionDef(f.id);
  // The crew slide into the queue in line order, topmost in front. Androids have served
  // their purpose and leave the ship altogether.
  for (const fig of f.crew) {
    if (fig === D.ANDROID) log(s, 'The android returns to the general supply.');
    else p.queue.push(fig);
  }
  p.done.push(f.id);
  log(s, `${p.name} completes ${m.name} (${m.pts} points).`);
  // An observer watching that faction, and the Ni'an Comms if the mission moved you
  // about or hurt - the two things the Ni'an care to hear about.
  afterTrigger(s, p, 'afterMission', (d) => !d.c || D.missionHasColor(m, d.c));
  afterTrigger(s, p, 'afterMissionWith', () => missionHad(m, ['damage', 'move', 'jump']));
  newMission(s, f.at);
}

// After a mission is completed, the highest-numbered face-up tile moves face down onto
// the planet just cleared, and a new mission is dealt where that tile came from.
function newMission(s, at) {
  const up = Object.entries(s.tiles).filter(([, t]) => t.up);
  if (!up.length) return;
  const [from, tile] = up.reduce((best, cur) => (cur[1].n > best[1].n ? cur : best));
  delete s.tiles[from];
  s.tiles[at] = { n: tile.n, up: false };
  if (s.missionDeck.length) {
    s.missions[from] = s.missionDeck.pop();
    log(s, `Tile ${tile.n} moves to ${locDef(at).name}; a new mission appears at ${locDef(from).name}.`);
  }
  if (tile.n === 1) pirateUprising(s);
}

// When tile 1 is turned face down the pirates rise: one new pirate from each numbered
// planet, resolved in ascending tile order so that on a clash for the same route it is
// the higher-numbered planet's pirate that is discarded. Then every tile flips back up.
function pirateUprising(s) {
  log(s, 'Pirate uprising!');
  for (const [loc] of Object.entries(s.tiles).sort((a, b) => a[1].n - b[1].n)) placePirate(s, loc);
  for (const t of Object.values(s.tiles)) t.up = true;
}

const tokName = (tok) => (Array.isArray(tok) ? tok[0] : tok);
const tokN = (tok) => (Array.isArray(tok) ? tok[1] : 1);

function resolveToken(s, p, tok) {
  // Two tokens are objects rather than names: a choice between branches, and an optional
  // cost that unlocks a further effect. Both are plain JSON, so they ride in the frame.
  if (tok && typeof tok === 'object' && !Array.isArray(tok)) {
    if (tok.either) { askFor(s, 'branch', { either: tok.either }); return; }
    if (tok.pay) { askFor(s, 'pay', { cost: tok.pay, then: tok.then }); return; }
    fail(`Unknown effect: ${JSON.stringify(tok)}`);
  }
  const k = tokName(tok);
  const n = tokN(tok);
  switch (k) {
    case 'move': askFor(s, 'move', { orRepair: hasAbility(s, p, 'moveOrJumpAsRepair') }); break;
    case 'jump': askFor(s, 'jump', { orRepair: hasAbility(s, p, 'moveOrJumpAsRepair') }); break;
    case 'fight': askFor(s, 'fight'); break;
    case 'fightSafe': askFor(s, 'fight', { safe: true }); break;
    case 'repair': for (let i = 0; i < n; i++) repairOne(s, p); break;
    // Spend the tech being activated: it leaves its slot for the discard pile. Single-use
    // by construction, so a commander's second task can no longer see it.
    case 'discardThis': {
      const rf = [...s.pending].reverse().find((fr) => fr.k === 'room');
      const sl = rf?.slot !== undefined ? p.techSlots[rf.slot] : null;
      if (!sl?.tech) break;
      const card = sl.tech;
      sl.tech = null;
      discardTech(s, card);
      log(s, `${p.name} spends ${techDef(card).name}.`);
      break;
    }
    case 'damage': takeDamage(s, p, n); break;
    case 'medal': p.medals += n; log(s, `${p.name} gains ${n} medal${n > 1 ? 's' : ''}.`); break;
    case 'artifact': drawArtifacts(s, p, n); break;
    case 'pirateTok': for (let i = 0; i < n; i++) gainToken(s, p, { t: 'pir' }); break;
    case 'android': p.ready.push(D.ANDROID); log(s, `${p.name} gains an android.`); break;
    case 'cadet': p.ready.push(D.CADET); log(s, `${p.name} gains a cadet.`); break;
    case 'queue':
      if (p.queue.length) { p.ready.push(p.queue.shift()); log(s, `${p.name} calls up the front of the queue.`); }
      break;
    case 'ambush': ambush(s, p); break;
    // The Training Holovisor's free training, offered after a medal tech bonus.
    case 'freeTrain':
      if (p.ready.some((f) => f === D.CADET || D.ENSIGNS.includes(f))) askFor(s, 'freeTrain');
      break;
    case 'coop': case 'tincan': case 'nian':
      if (hasAbility(s, p, 'anyTrackIsAny')) { askFor(s, 'track', { n, suggest: k }); break; }
      push(s, { k: 'adv', t: D.FACTIONS.findIndex((f) => f.id === k), left: n }); break;
    case 'anyTrack': askFor(s, 'track', { n }); break;
    case 'anyTrack1x2': push(s, { k: 'fx', fx: [['anyTrack', 1], ['anyTrack', 1]], i: 0 }); break;
    case 'event': /* resolved by stepTrack when it lands on EVENT_SPACE */ break;
    case 'tech': case 'techR': askFor(s, 'tech', { recycle: k === 'techR' }); break;
    // Three missions research a tech "but don't gain tech bonuses". The icon they print
    // is the round gear with arrows - the RECYCLING one (rulebook p. 11) - so the tech may
    // also replace one already installed; only the edge bonuses are given up.
    case 'techNB': askFor(s, 'tech', { noBonus: true, recycle: true }); break;
    // Intergalactic Barbecue advances "without gaining bonuses": the marker moves, but
    // any bonus space it lands on or passes through is skipped.
    case 'anyTrackNB': askFor(s, 'track', { n, noBonus: true }); break;
    // Arena Battle's blue line has no effect of its own: it turns off damage for the
    // whole mission, which takeDamage checks for.
    case 'ignoreMissionDamage': {
      const mf = s.pending?.find((fr) => fr.k === 'mission');
      if (mf) mf.noDamage = true;
      log(s, 'The arena shields hold: no damage this mission.');
      break;
    }
    // Draw a few cards off a deck and research one of them. The rest go to the bottom.
    // Both "draw 3 and research one of them" lines print the recycle gear, not the plain
    // research one, and the appendix confirms it for Steal Secret Plans: "choose 1 - you
    // may put it in an empty tech slot OR REPLACE AN EXISTING TECH with it."
    case 'drawTech3': askFor(s, 'tech', { pool: drawFrom(s, 'deck', 3), recycle: true }); break;
    case 'drawOmega3': askFor(s, 'tech', { pool: drawFrom(s, 'omegaDeck', 3), omega: true, recycle: true }); break;
    // Gateway to the Stars: "Look at the top 3 missions, then move." Information only -
    // the cards stay on the deck in the same order. Where the next mission will be dealt
    // is already public, so knowing what it is tells you where to be.
    case 'peekMissions3': askFor(s, 'peekMissions', { pool: s.missionDeck.slice(-3).reverse() }); break;
    // "Advance 1 on a track of your choice for each android in your crew."
    case 'trackPerAndroid': {
      const n2 = [...p.ready, ...p.queue, ...p.away ?? []].filter((f) => f === D.ANDROID).length;
      if (n2) push(s, { k: 'fx', fx: Array.from({ length: n2 }, () => ['anyTrack', 1]), i: 0 });
      break;
    }
    // Reactive effects: these are read by the code that would deal the damage, not resolved
    // here, so reaching them as a plain effect token is a bug.
    case 'ignoreDamage1': fail('Damage-ignoring effects are handled when damage is dealt.');
    default: fail(`Unknown effect: ${k}`);
  }
}

// ---------- damage, cargo, repairs ----------
function emptyCargo(p) { return p.cargo.findIndex((c) => c === null); }

export function takeDamage(s, p, n = 1) {
  const mf = s.pending?.find((fr) => fr.k === 'mission');
  if (mf?.noDamage) { log(s, `${p.name} ignores the damage.`); return; }
  // Stealth Paint shrugs off the first damage of each mission.
  if (n > 0 && mf && !mf.stealthUsed && hasAbility(s, p, 'stealth')) {
    mf.stealthUsed = true;
    n--;
    log(s, 'The stealth plating takes the first hit.');
    if (n === 0) return;
  }
  for (let i = 0; i < n; i++) {
    const slot = emptyCargo(p);
    if (slot >= 0) { p.cargo[slot] = { t: 'dmg' }; continue; }
    // No empty slot: a token must go to make room, unless everything is already damage.
    if (cargoTokens(p).length) { askFor(s, 'bump'); return; }
    p.excess++;
  }
  log(s, `${p.name} takes ${n} damage.`);
}

// Repair takes excess damage first, then needs a choice of slot (rulebook p. 9).
// Excess damage sits on top of cargo slots that are already full, so no cargo slot can be
// cleared until the excess is gone. Tech slots are the exception, rulebook p. 9: "If you
// have excess damage, your cargo slots remain full of damage until all excess damage has
// been repaired. (But that does not prevent you from repairing tech slots instead.)"
// INTERPRETATION: a damaged basic room is on the ship board, not the tech-slot board, so
// excess blocks it the way it blocks cargo.
function repairOne(s, p) {
  const tech = p.techSlots.some((t) => t.dmg);
  if (p.excess > 0 && !tech) { p.excess--; log(s, `${p.name} repairs 1 damage.`); return; }
  const cargo = p.cargo.some((c) => c?.t === 'dmg');
  const room = Object.keys(p.roomDmg).length > 0;
  if (!p.excess && !cargo && !tech && !room) return;
  askFor(s, 'repair');
}

function gainToken(s, p, tok) {
  const slot = emptyCargo(p);
  if (slot >= 0) { p.cargo[slot] = tok; return; }
  if (cargoTokens(p).length) { askFor(s, 'stow', { tok }); return; }
  log(s, `${p.name} has no room for it and loses it.`);
}

function drawArtifacts(s, p, n) {
  // All of them are drawn before any is kept, per the timing note on rulebook p. 9.
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (!s.artifactBag.length) { s.artifactBag = shuffle(s, s.artifactDiscard.splice(0)); }
    if (s.artifactBag.length) drawn.push(s.artifactBag.pop());
  }
  for (const id of drawn) gainToken(s, p, { t: 'art', id });
}

// A drawn pirate goes on the route of its own colour leading from `loc`, if that route is
// free. Colourless routes can never receive one, and a pirate with nowhere to go is
// discarded. Used by the ambush effect and by the pirate uprising.
function placePirate(s, loc) {
  if (!s.pirateBag.length) s.pirateBag = shuffle(s, s.pirateDiscard.splice(0));
  const tok = s.pirateBag.pop();
  if (!tok) return false;
  const i = routesAt(loc).find((j) => D.ROUTES[j].c === tok.c && !s.pirates[j]);
  if (i === undefined) { s.pirateDiscard.push(tok); log(s, `A ${tok.c} pirate finds nowhere to lurk.`); return false; }
  s.pirates[i] = tok;
  log(s, `A ${tok.c} pirate moves in on the ${D.ROUTES[i].a}-${D.ROUTES[i].b} route.`);
  return true;
}

const ambush = (s, p) => { placePirate(s, p.at); };

// ---------- faction tracks ----------
function stepTrack(s, p, t, noBonus = false) {
  const m = p.marks[t];
  m.sp++;
  if (m.sp >= D.TRACK_LEN) { m.sp = 0; m.loops++; log(s, `${p.name} completes a lap of ${D.FACTIONS[t].name} (+${D.TRACK_LOOP_PTS}).`); }
  const side = D.FACTIONS[t].sides.find((x) => x.id === s.tracks[t].side);
  if (m.sp === D.EVENT_SPACE) fireEvent(s, t);
  const bonus = noBonus ? null : side.bonus[m.sp];
  if (bonus) push(s, { k: 'fx', fx: bonus, i: 0 });
}

// `event` is cleared once an event has happened, so a second marker reaching the space
// can't fire it again. `fired` and `gone` remember which card it was, purely so the UI can
// still show it: fired = it resolved, gone = it was removed unresolved once the game hit
// its two-event limit. They are extra fields, never read by the rules, so a device running
// older code ignores them and behaves exactly as before - no save-version bump needed.
function fireEvent(s, t) {
  if (s.eventsDone >= D.EVENT_LIMIT || !s.tracks[t].event) return;
  const ev = s.tracks[t].event;
  s.tracks[t].event = null;
  s.tracks[t].fired = ev;
  s.eventsDone++;
  const def = D.eventDef(ev);
  log(s, `Event: ${def.name}. ${def.text}`);
  resolveEvent(s, def);
  if (s.eventsDone >= D.EVENT_LIMIT) {
    for (const tr of s.tracks) {
      if (tr.event) tr.gone = tr.event;
      tr.event = null;
    }
  }
}

// Each event card is a named `special` with one branch here. Events are global, so they
// touch every player; anything that needs a decision is pushed as a frame per player so
// the pending machine asks each in turn.
// Events hit every player at once, including players whose turn it is not. The pending
// machine only ever asks the player whose turn it is, so anything an event does to the
// others resolves itself: damage jettisons the first spare token, and a repair takes the
// first damage it finds. Both are recorded in RULES.md as interpretations.
function autoDamage(s, p, n = 1) {
  for (let i = 0; i < n; i++) {
    const slot = p.cargo.findIndex((c) => c === null);
    if (slot >= 0) { p.cargo[slot] = { t: 'dmg' }; continue; }
    const spare = p.cargo.findIndex((c) => c && c.t !== 'dmg');
    if (spare < 0) { p.excess++; continue; }
    if (p.cargo[spare].t === 'art') s.artifactDiscard.push(p.cargo[spare].id);
    p.cargo[spare] = { t: 'dmg' };
  }
  log(s, `${p.name} takes ${n} damage.`);
}

function autoRepair(s, p) {
  if (p.excess > 0) { p.excess--; }
  else {
    const c = p.cargo.findIndex((x) => x?.t === 'dmg');
    if (c >= 0) p.cargo[c] = null;
    else {
      const t = p.techSlots.findIndex((x) => x.dmg);
      if (t >= 0) p.techSlots[t].dmg = false;
      else { const r = Object.keys(p.roomDmg)[0]; if (r) delete p.roomDmg[r]; else return; }
    }
  }
  log(s, `${p.name} repairs 1 damage.`);
}

const trackSide = (s, t) => D.FACTIONS[t].sides.find((x) => x.id === s.tracks[t].side);

function drawArtifactId(s) {
  if (!s.artifactBag.length) s.artifactBag = shuffle(s, s.artifactDiscard.splice(0));
  return s.artifactBag.pop() ?? null;
}

// Each event card is a named `special` with one branch here.
function resolveEvent(s, def) {
  switch (def.special) {
    // --- Tincan -------------------------------------------------------------------
    case 'tincanTech':
      // The tech on the Tincan track becomes usable by everyone, in place.
      s.tracks.find((x) => x.id === 'tincan').shared = true;
      break;

    // --- Cooperative --------------------------------------------------------------
    case 'overtime':
      for (const q of s.players) {
        if (q.passed) q.ready.push(D.CADET);
        else if (q.queue.length) q.ready.push(q.queue.shift());
      }
      break;
    case 'routineMaintenance': {
      const dmg = s.players.map(damageCount);
      const least = Math.min(...dmg);
      s.players.forEach((q, i) => {
        if (dmg[i] === least) { q.medals++; log(s, `${q.name} gains 1 medal.`); }
        else autoRepair(s, q);
      });
      break;
    }
    case 'outreach':
      // Every marker creeps forward one, but only where that is free: a space with a
      // bonus, or the event space, is skipped rather than resolved.
      for (const q of s.players) {
        q.marks.forEach((m, t) => {
          const nx = (m.sp + 1) % D.TRACK_LEN;
          if (nx === D.EVENT_SPACE || trackSide(s, t).bonus[nx]) return;
          m.sp = nx;
          if (nx === 0) m.loops++;
        });
      }
      break;
    case 'crowdsourcing':
      // An artifact waits face down on each room tech; activating that room may claim it.
      for (const q of s.players) {
        for (const sl of q.techSlots) {
          if (sl.tech && techDef(sl.tech)?.room) sl.art = drawArtifactId(s);
        }
      }
      break;

    // --- Ni'an --------------------------------------------------------------------
    case 'repossession': {
      for (const q of s.players) {
        if (!q.cargo.some((c) => c?.t === 'pir')) autoDamage(s, q, 1);
      }
      const pir = s.players.map((q) => q.cargo.filter((c) => c?.t === 'pir').length);
      const most = Math.max(...pir);
      if (most > 0) {
        s.players.forEach((q, i) => {
          if (pir[i] !== most) return;
          q.cargo[q.cargo.findIndex((c) => c?.t === 'pir')] = null;
          log(s, `${q.name} hands back a pirate token.`);
        });
      }
      break;
    }
    case 'sabotage':
      // The basic room matching the front of the queue is put out of action until repaired.
      for (const q of s.players) {
        const fig = q.queue[0];
        if (!fig || fig === D.ANDROID) continue;
        const color = fig === D.CADET ? 'gray' : D.figColor(fig);
        const room = D.ROOMS.find((r) => r.color === color);
        if (!room) continue;
        q.roomDmg[room.id] = true;
        log(s, `${q.name}'s ${room.name} is sabotaged.`);
      }
      break;
    case 'honestySummit':
      for (const q of s.players) {
        q.marks.forEach((m, t) => {
          if (m.sp === 0 || trackSide(s, t).bonus[m.sp]) return;
          m.sp--;
        });
      }
      break;
    case 'nianExpansion': {
      // Every empty route around the planet showing the highest face-up tile.
      const up = Object.entries(s.tiles).filter(([, t]) => t.up);
      if (!up.length) break;
      const [loc] = up.reduce((b, c) => (c[1].n > b[1].n ? c : b));
      for (const i of routesAt(loc)) {
        if (s.pirates[i]) continue;
        if (!s.pirateBag.length) s.pirateBag = shuffle(s, s.pirateDiscard.splice(0));
        s.pirates[i] = s.pirateBag.pop() ?? null;
      }
      log(s, `Pirates swarm ${locDef(loc).name}.`);
      break;
    }

    // --- both factions ------------------------------------------------------------
    case 'stationBounty':
      // Something waits at every space station for whoever ends a turn there first.
      for (const st of Object.values(s.stations)) st.bounty = def.give;
      break;

    default: fail(`Unknown event: ${def.special}`);
  }
}

// ---------- rooms ----------
// The four printed rooms, plus any room techs installed in a player's slots, plus the
// Tincan track's tech once that event has fired: it is never installed in anyone's slot,
// it just becomes usable by everybody (so it has no edge bonuses and can't be recycled).
export function roomsFor(s, p) {
  const asRoom = (id) => {
    const d = techDef(id);
    return d?.room ? { id, name: d.name, color: d.room, fx: d.fx ?? [], discard: d.discard ?? null } : null;
  };
  const techRooms = p.techSlots.map((sl, i) => {
    const r = sl.tech && asRoom(sl.tech);
    return r && { ...r, slot: i, art: !!sl.art };
  }).filter(Boolean);
  const shared = sharedTech(s) && asRoom(sharedTech(s));
  const basic = D.ROOMS.filter((r) => !p.roomDmg[r.id]);
  return [...basic, ...techRooms, ...(shared ? [shared] : [])];
}

// The Tincan track's alpha tech, once its event has made it available to every player.
export function sharedTech(s) {
  const t = s.tracks.find((x) => x.id === 'tincan');
  return t && t.shared ? t.tech : null;
}

// What activating a room resolves. A "Discard this to:" tech spends itself for its
// `discard` effects; a card that offers both (Ram Drive: take the damage, or spend the
// card) asks which way. The card goes first, so a research effect can use the slot it
// just vacated.
const roomFx = (room) => {
  if (!room.discard) return room.fx;
  const spend = ['discardThis', ...room.discard];
  return room.fx.length ? [{ either: [room.fx, spend] }] : spend;
};

// Just enough of an effect list to name it in the log - the UI owns the real wording.
const fxWord = (fx) => (fx ?? []).map((t) => (Array.isArray(t) ? `${t[0]} ${t[1]}` : String(t))).join(' + ') || 'it';

// Can this figure work this room? Androids never activate rooms at all (rulebook p. 7).
export function canActivate(fig, room) {
  if (fig === D.ANDROID) return false;
  return room.color === 'gray' ? true : D.figColor(fig) === room.color;
}

// ---------- actions ----------
// The state keeps the current turn's history so a move can be taken back later in the
// turn: history = { start: the state before the turn's first move, moves: [{ action,
// revealed }] }, or null before the first move. Undo is just another action, so online
// it saves and syncs like any other.
export function apply(state, action) {
  if (action.type === 'undo') return undoMove(state, action);
  const { history, ...prev } = state;
  const s = structuredClone(prev);
  step(s, action);
  const revealed = revealsInfo(prev, s);
  s.history = s.current !== prev.current || s.over ? null : {
    start: history?.start ?? structuredClone(prev),
    moves: [...(history?.moves || []), { action, revealed }],
  };
  return s;
}

// ---------- undo ----------
// True if going from prev to next exposed hidden information, or passed the turn. Such a
// move can't be taken back, because you cannot un-see what it showed you.
export function revealsInfo(prev, next) {
  if (next.current !== prev.current || next.over || next.rng !== prev.rng) return true;
  // A deck or bag that got shorter handed something out.
  const shrank = (a, b) => a.length < b.length;
  if (shrank(next.tech.deck, prev.tech.deck) || shrank(next.tech.omegaDeck, prev.tech.omegaDeck)) return true;
  if (shrank(next.missionDeck, prev.missionDeck)) return true;
  if (shrank(next.artifactBag, prev.artifactBag) || shrank(next.pirateBag, prev.pirateBag)) return true;
  // A triangle tile turned over.
  const faces = (s) => JSON.stringify(Object.entries(s.tiles).map(([k, t]) => [k, t.n, t.up]).sort());
  if (faces(next) !== faces(prev)) return true;
  // Gateway to the Stars shows you the top of the mission deck without moving a card.
  const peeked = (s) => s.pending?.some((f) => f.k === 'ask' && f.q === 'peekMissions');
  return !!(peeked(next) || peeked(prev));
}

// The current turn as states: before its first move, then after each move. Null if the
// history doesn't lead to this state (edited by hand, or recorded under older rules).
function replayTurn(s) {
  if (!s.history) return [s];
  const states = [s.history.start];
  try {
    for (const { action } of s.history.moves) states.push(apply(states.at(-1), action));
  } catch (e) {
    if (e instanceof GameError) return null;
    throw e;
  }
  return JSON.stringify(states.at(-1)) === JSON.stringify(s) ? states : null;
}

// What a move exposed: for each hidden zone it changed, what that zone holds afterwards
// and what it handed out. Two moves that reveal the same thing are interchangeable.
function exposed(b, a) {
  const changed = (x, y) => JSON.stringify(x) !== JSON.stringify(y);
  return JSON.stringify([
    a.rng !== b.rng && a.rng,
    changed(a.tech.deck, b.tech.deck) && [a.tech.deck, a.tech.row, a.tech.omega],
    changed(a.tech.omegaDeck, b.tech.omegaDeck) && [a.tech.omegaDeck, a.tech.omega],
    changed(a.missionDeck, b.missionDeck) && [a.missionDeck, a.missions],
    changed(a.artifactBag, b.artifactBag) && a.artifactBag,
    changed(a.pirateBag, b.pirateBag) && a.pirateBag,
    changed(a.tiles, b.tiles) && a.tiles,
  ]);
}

// Replays the turn without move i. Refused if move i revealed something, if a later move
// fails without it, or if a later move would reveal anything different.
function takeBack(states, i) {
  const { moves } = states.at(-1).history;
  if (moves[i].revealed) fail('revealed hidden information');
  let s = states[i];
  for (let j = i + 1; j < moves.length; j++) {
    let next;
    try {
      next = apply(s, moves[j].action);
    } catch (e) {
      if (e instanceof GameError) fail(`move ${j + 1} needs it`);
      throw e;
    }
    if ((moves[j].revealed || revealsInfo(s, next)) && exposed(states[j], states[j + 1]) !== exposed(s, next)) {
      fail(`would change what move ${j + 1} revealed`);
    }
    s = next;
  }
  return s;
}

// For each move this turn: null if it can be undone, otherwise why not.
// Null instead of a list if this turn's history can't be replayed.
export function undoable(s) {
  const states = replayTurn(s);
  if (!states) return null;
  return (s.history?.moves || []).map((_, i) => {
    try {
      takeBack(states, i);
      return null;
    } catch (e) {
      if (e instanceof GameError) return e.message;
      throw e;
    }
  });
}

function undoMove(s, { p, move }) {
  if (s.over) fail('The game is over.');
  if (p !== s.current) fail('It is not your turn.');
  if (!Number.isInteger(move) || !s.history?.moves[move]) fail('Nothing to undo.');
  const states = replayTurn(s);
  if (!states) fail("This turn's history doesn't match the game, so it can't be undone.");
  try {
    return structuredClone(takeBack(states, move)); // the start state is shared between states
  } catch (e) {
    if (e instanceof GameError) fail(`Can't undo move ${move + 1}: ${e.message}.`);
    throw e;
  }
}

function step(s, a) {
  if (s.over) fail('The game is over.');
  if (a.p !== s.current) fail('It is not your turn.');
  const p = s.players[a.p];
  if (a.type !== 'choose' && ask(s)) fail('Finish the effect you are resolving first.');

  switch (a.type) {
    case 'train': {
      if (s.turn.acted) fail('Training happens at the start of your turn, before you act.');
      const cost = trainCost(s, p, a.to);
      if (medalsAvailable(s, p) < cost) fail('Training costs 1 medal.');
      const i = p.ready.indexOf(a.from);
      if (i < 0) fail('That crew member is not in your ready room.');
      if (D.isCommander(a.from) || a.from === D.ANDROID) fail('Only cadets and ensigns can be trained.');
      if (!D.ENSIGNS.includes(a.to)) fail('Train them into a red, yellow or blue ensign.');
      p.ready.splice(i, 1, a.to);
      log(s, `${p.name} trains ${a.from === D.CADET ? 'a cadet' : 'an ensign'} into a ${a.to} ensign.`);
      if (cost) push(s, { k: 'spend', left: cost });
      pump(s);
      break;
    }
    case 'promote': {
      if (s.turn.acted) fail('Promotion happens at the start of your turn, before you act.');
      const cost = promoteCost(s, p, a.c);
      if (medalsAvailable(s, p) < cost) fail(`Promotion costs ${cost} medals.`);
      if (p.rings <= 0) fail(`You may only have ${D.COMMANDER_LIMIT} commanders.`);
      const i = p.ready.indexOf(a.c);
      if (i < 0 || !D.ENSIGNS.includes(a.c)) fail('Pick an ensign in your ready room.');
      p.rings--;
      p.ready.splice(i, 1, a.c.toUpperCase());
      log(s, `${p.name} promotes a ${a.c} ensign to commander.`);
      // Fleet Comms reports a promotion back to the Cooperative.
      afterTrigger(s, p, 'afterPromote', (d) => !d.c || d.c === a.c);
      // On top of the trigger's frames, so you are asked what to pay before anything else.
      if (cost) push(s, { k: 'spend', left: cost });
      pump(s);
      break;
    }
    case 'activate': {
      const room = roomsFor(s, p).find((r) => r.id === a.room);
      if (!room) fail('No such room.');
      if (a.with?.fig !== undefined) {
        const i = p.ready.indexOf(a.with.fig);
        if (i < 0) fail('That crew member is not in your ready room.');
        if (!canActivate(a.with.fig, room)) fail(`A ${a.with.fig} cannot work the ${room.name}.`);
        p.ready.splice(i, 1);
        p.queue.push(a.with.fig); // to the back of the queue
      } else if (Array.isArray(a.with?.art)) {
        const [i, j] = a.with.art;
        if (i === j || ![i, j].every((k) => p.cargo[k]?.t === 'art')) fail('Pick two artifacts.');
        const colors = D.artifactPair(p.cargo[i].id, p.cargo[j].id);
        if (!colors.includes(room.color)) fail('Those artifacts do not match that room.');
        for (const k of [i, j]) { s.artifactDiscard.push(p.cargo[k].id); p.cargo[k] = null; }
      } else fail('Assign a crew member or spend two artifacts.');
      s.turn.acted = true;
      log(s, `${p.name} activates ${room.name}.`);
      // The room frame sits under the effects so a commander can be asked for a second
      // task once they finish. Artifacts are spent by nobody, so there is no second task.
      push(s, { k: 'room', fig: a.with?.fig ?? null, phase: 'first', slot: room.slot });
      // Crowdsourcing left an artifact on this room tech; you may claim it afterwards.
      if (room.art) push(s, { k: 'ask', q: 'takeArt', slot: room.slot });
      push(s, { k: 'fx', fx: roomFx(room), i: 0 });
      pump(s);
      break;
    }
    case 'mission': {
      if (s.turn.acted) fail('You have already acted this turn.');
      const id = s.missions[p.at];
      if (!id) fail('There is no mission here.');
      const owner = reservedBy(s, p.at);
      if (owner !== null && owner !== p.idx) fail('That mission is reserved for another captain.');
      const m = D.missionDef(id);
      if (!Array.isArray(a.assign) || a.assign.length !== m.lines.length) {
        fail(`${m.name} has ${m.lines.length} line${m.lines.length > 1 ? 's' : ''}; assign one crew member to each.`);
      }
      // Any figure may be assigned to any line, matching or not. Take them all out of
      // the ready room first so a crew member can't be assigned to two lines at once.
      const left = [...p.ready];
      for (const fig of a.assign) {
        const i = left.indexOf(fig);
        if (i < 0) fail('Your ready room does not have the crew for that.');
        left.splice(i, 1);
      }
      p.ready = left;
      delete s.missions[p.at];
      s.turn.acted = true;
      log(s, `${p.name} takes on ${m.name}.`);
      push(s, { k: 'mission', id, at: p.at, crew: a.assign, i: 0, phase: null });
      pump(s);
      break;
    }
    case 'pass':
      p.passed = true;
      s.turn.acted = true;
      log(s, `${p.name} passes.`);
      endTurn(s);
      break;
    case 'endTurn':
      if (ask(s)) fail('Finish the effect you are resolving first.');
      if (!s.turn.acted) fail('Take an action or pass first.');
      endTurn(s);
      break;
    case 'choose':
      choose(s, p, a.opt);
      pump(s);
      break;
    default: fail('Unknown action.');
  }
}

function choose(s, p, opt) {
  const f = ask(s);
  if (!f) fail('Nothing to choose right now.');
  s.pending.pop();
  switch (f.q) {
    case 'freeTrain': {
      if (opt === 'skip') break;
      const i = p.ready.indexOf(opt.from);
      if (i < 0 || D.isCommander(opt.from) || opt.from === D.ANDROID) fail('Pick a cadet or ensign in your ready room.');
      if (!D.ENSIGNS.includes(opt.to)) fail('Train them into a red, yellow or blue ensign.');
      p.ready.splice(i, 1, opt.to);
      log(s, `${p.name} trains a ${opt.to} ensign for free.`);
      break;
    }
    case 'move': {
      if (opt === 'repair' && f.orRepair) { repairOne(s, p); break; }
      if (opt === 'skip') { log(s, `${p.name} stays put.`); break; }
      const i = routesAt(p.at).find((j) => routeEnd(j, p.at) === opt);
      if (i === undefined) fail('No route goes there.');
      p.at = opt;
      log(s, `${p.name} flies to ${locDef(opt).name}.`);
      if (s.pirates[i]) {
        if (hasAbility(s, p, 'stealth')) log(s, 'The pirate never sees you go by.');
        else { log(s, 'A pirate takes a shot on the way past.'); takeDamage(s, p, 1); }
      }
      // Auxiliary Engine: one extra move a turn, offered right after a move.
      if (!s.turn.auxUsed && hasAbility(s, p, 'extraMovePerTurn')) {
        s.turn.auxUsed = true;
        log(s, 'The auxiliary engine has one more move in it.');
        push(s, { k: 'fx', fx: ['move'], i: 0 });
      }
      break;
    }
    case 'jump':
      // Like a move, a jump may be declined - it is an offer, and flying away is not
      // always what you want.
      if (opt === 'repair' && f.orRepair) { repairOne(s, p); break; }
      if (opt === 'skip') { log(s, `${p.name} stays put.`); break; }
      if (!locDef(opt)) fail('No such location.');
      p.at = opt;
      log(s, `${p.name} jumps to ${locDef(opt).name}.`);
      break;
    case 'fight': {
      if (opt === 'skip') break;
      const i = Number(opt);
      if (!routesAt(p.at).includes(i) || !s.pirates[i]) fail('No pirate on that route.');
      const tok = s.pirates[i];
      s.pirates[i] = null;
      log(s, `${p.name} takes on the pirate and wins.`);
      // A fight normally costs 1 damage. Turbo-Lasers ("Ignore the damage") asks with
      // safe set, so the hit never lands.
      if (f.safe) log(s, `${p.name} ignores the damage.`);
      else takeDamage(s, p, 1);
      if (tok.reward === 'android') {
        p.ready.push(D.ANDROID);
        afterTrigger(s, p, 'afterFightAndroid');
      } else { p.medals++; drawArtifacts(s, p, 1); }
      gainToken(s, p, { t: 'pir' });
      break;
    }
    case 'repair': {
      const { zone, i } = opt ?? {};
      const blocked = () => { if (p.excess > 0) fail('Repair the excess damage first; only tech slots can be repaired before it.'); };
      if (zone === 'excess') {
        if (p.excess <= 0) fail('You have no excess damage.');
        p.excess--;
      } else if (zone === 'cargo') {
        blocked();
        if (p.cargo[i]?.t !== 'dmg') fail('No damage in that cargo slot.');
        p.cargo[i] = null;
      } else if (zone === 'tech') {
        if (!p.techSlots[i]?.dmg) fail('No damage in that tech slot.');
        p.techSlots[i].dmg = false;
      } else if (zone === 'room') {
        blocked();
        if (!p.roomDmg[i]) fail('That room is not damaged.');
        delete p.roomDmg[i];
      } else fail('Pick a slot to repair.');
      log(s, `${p.name} repairs 1 damage.`);
      break;
    }
    case 'bump': { // discard a token to make room for incoming damage
      if (p.cargo[opt] == null || p.cargo[opt].t === 'dmg') fail('Pick an artifact or pirate token to jettison.');
      if (p.cargo[opt].t === 'art') s.artifactDiscard.push(p.cargo[opt].id);
      p.cargo[opt] = { t: 'dmg' };
      log(s, `${p.name} jettisons cargo and takes the damage.`);
      break;
    }
    case 'stow': { // no room for a token: discard one of yours, or refuse the new one
      if (opt === 'drop') { log(s, `${p.name} leaves it behind.`); break; }
      if (p.cargo[opt] == null || p.cargo[opt].t === 'dmg') fail('Pick an artifact or pirate token to jettison.');
      if (p.cargo[opt].t === 'art') s.artifactDiscard.push(p.cargo[opt].id);
      p.cargo[opt] = f.tok;
      break;
    }
    case 'track': {
      const t = D.FACTIONS.findIndex((x) => x.id === opt);
      if (t < 0) fail('Pick a faction track.');
      push(s, { k: 'adv', t, left: f.n ?? 1, noBonus: !!f.noBonus });
      break;
    }
    // Resolve this mission line, or refuse it? Refusing skips the whole line.
    case 'line': {
      const mf = top(s);
      if (mf?.k !== 'mission') fail('Nothing to choose right now.');
      const m = D.missionDef(mf.id);
      if (opt === 'skip') {
        log(s, `${p.name} leaves that line alone.`);
        mf.phase = null;
        mf.i++;
        break;
      }
      mf.phase = 'first';
      push(s, { k: 'fx', fx: m.lines[mf.i].fx, i: 0 });
      break;
    }
    // A commander's second task: extra work, or call a subordinate up from the queue.
    case 'second': {
      const fr = top(s);
      if (fr?.k !== 'mission' && fr?.k !== 'room') fail('Nothing to choose right now.');
      const cmd = fr.k === 'mission' ? fr.crew[fr.i] : fr.fig;
      if (opt === 'skip') { /* a commander may decline the second task */ }
      else if (opt === 'extra') {
        if (fr.k === 'mission') push(s, { k: 'fx', fx: D.missionDef(fr.id).lines[fr.i].fx, i: 0 });
        else fail('Pick the room for the extra work.');
      } else if (opt && opt.room) {
        // Extra work in a room: any room this commander could work, same or different.
        if (fr.k !== 'room') fail('That commander is on a mission, not in a room.');
        const room = roomsFor(s, p).find((r) => r.id === opt.room);
        if (!room || !canActivate(cmd, room)) fail('That commander cannot work that room.');
        log(s, `${p.name}'s ${D.figColor(cmd)} commander puts in extra work in ${room.name}.`);
        push(s, { k: 'fx', fx: room.fx, i: 0 });
      } else {
        // Command a subordinate: a cadet, or an ensign of the commander's own colour,
        // anywhere in the queue. Figures still out on the mission aren't in the queue.
        const want = opt;
        if (!subordinates(p, cmd).includes(want)) {
          fail(`A ${D.figColor(cmd)} commander can only call up a cadet or a ${D.figColor(cmd)} ensign from the queue.`);
        }
        const i = p.queue.indexOf(want);
        if (i < 0) fail('That crew member is not in your queue.');
        p.queue.splice(i, 1);
        p.ready.push(want);
        log(s, `${p.name}'s ${D.figColor(cmd)} commander calls up ${figName(want)}.`);
      }
      if (fr.k === 'mission') fr.phase = 'second';
      else fr.phase = 'done';
      break;
    }
    // Install a tech in a slot. Research needs an empty, undamaged slot; recycling may
    // also replace a tech already there. With no legal slot the effect simply does nothing.
    case 'tech': {
      if (opt === 'skip') { log(s, `${p.name} researches nothing.`); break; }
      const { card, slot } = opt ?? {};
      if (!techChoices(s, f).includes(card)) fail('That tech is not available.');
      if (!techSlotChoices(p, f).includes(slot)) {
        fail(p.techSlots[slot]?.dmg ? 'That tech slot is damaged; repair it first.'
          : p.techSlots[slot]?.tech ? 'That tech slot already holds a tech.'
          : 'No such tech slot.');
      }
      const sl = p.techSlots[slot];
      if (sl.tech) { discardTech(s, sl.tech); log(s, `${p.name} recycles ${techDef(sl.tech).name}.`); }
      takeTech(s, f, card);
      sl.tech = card;
      log(s, `${p.name} installs ${techDef(card).name}.`);
      // Edge icons that match the neighbouring edge pay out at once, top to bottom.
      const bonuses = f.noBonus ? [] : bonusesFor(s, p, slot, techDef(card));
      if (bonuses.length) push(s, { k: 'fx', fx: bonusEffects(s, p, bonuses), i: 0 });
      syncStorage(s, p);
      break;
    }
    // The face-down artifact Crowdsourcing left on a room tech.
    case 'takeArt': {
      const sl = p.techSlots[f.slot];
      if (opt !== 'skip' && sl?.art) { gainToken(s, p, { t: 'art', id: sl.art }); log(s, `${p.name} collects the artifact left on the room.`); }
      if (sl) sl.art = null;
      break;
    }
    // Which medal-or-token to give up for a train or a promotion, one at a time.
    case 'spend': {
      const sf = top(s);
      if (sf?.k !== 'spend') fail('Nothing to pay for right now.');
      payOne(s, p, opt);
      sf.left--;
      break;
    }
    // "A or B": resolve one branch of the effect.
    case 'branch': {
      const i = Number(opt);
      if (!f.either[i]) fail('Pick one of the two effects.');
      push(s, { k: 'fx', fx: f.either[i], i: 0 });
      break;
    }
    // An optional cost that buys a further effect. `opt` is the cargo slot to spend,
    // or 'skip' to decline; medals are spent from the medal pile, so any opt will do.
    case 'pay': {
      if (opt === 'skip') { log(s, `${p.name} declines to pay.`); break; }
      if (f.cost === 'medal') {
        // A medal cost can also be paid with a stored artifact or pirate token when the
        // matching Display is installed, so it goes through the same "what do you give
        // up?" question as training and promotion. The reward sits under the payment, so
        // it resolves once the payment is settled.
        if (medalsAvailable(s, p) < 1) fail('You have no medal to spend.');
        log(s, `${p.name} pays 1 medal for ${fxWord(f.then)}.`);
        push(s, { k: 'fx', fx: f.then, i: 0 });
        push(s, { k: 'spend', left: 1 });
        break;
      }
      if (f.cost === 'tech') {
        // Give up a tech you have already installed; the slot is left empty.
        const i = Number(opt);
        if (!p.techSlots[i]?.tech) fail('Pick an installed tech to give up.');
        discardTech(s, p.techSlots[i].tech);
        log(s, `${p.name} gives up ${techDef(p.techSlots[i].tech).name}.`);
        p.techSlots[i].tech = null;
        p.techSlots[i].art = null;
        syncStorage(s, p);
      } else {
        const t = f.cost === 'artifact' ? 'art' : 'pir';
        const i = Number(opt);
        if (p.cargo[i]?.t !== t) fail(`Pick ${t === 'art' ? 'an artifact' : 'a pirate token'} to spend.`);
        if (t === 'art') s.artifactDiscard.push(p.cargo[i].id);
        p.cargo[i] = null;
      }
      if (f.cost !== 'tech') log(s, `${p.name} spends ${f.cost === 'pirateTok' ? 'a pirate token' : 'an artifact'}.`);
      push(s, { k: 'fx', fx: f.then, i: 0 });
      break;
    }
    // You have now seen the top of the mission deck; nothing moves.
    case 'peekMissions':
      log(s, `${p.name} studies the next missions.`);
      break;
    default: fail('Unknown choice.');
  }
}

// ---------- turn and round ----------
// A station fires when you END a turn on its planet, once per round. Everything it does
// goes into ONE effect list, resolved in order: a question raised by the first effect (no
// room for the charge's damage) must be answered before the next effect runs. Resolving
// each station with its own pump() let a later station jump the queue - the Blue Station
// handed out an artifact that the earlier, still-unanswered damage then threw overboard.
function endTurn(s) {
  const p = s.players[s.current];
  const fx = [];
  for (const st of Object.values(s.stations)) {
    if (st.at !== p.at || !st.bounty) continue;
    const give = st.bounty;
    st.bounty = null;
    if (give === 'medal') { p.medals++; log(s, `${p.name} collects the medal left at the station.`); }
    else { log(s, `${p.name} sets off the charge left at the station.`); fx.push(['damage', 1], ['anyTrack', 1]); }
  }
  for (const [id, st] of Object.entries(s.stations)) {
    if (st.out && st.at === p.at) {
      const tile = D.STATION_TILES.find((t) => t.id === id);
      st.out = false; // used: it waits on the round track until next round
      log(s, `${p.name} docks at the ${tile.name}.`);
      fx.push(...tile.fx);
    }
  }
  // This frame sits at the BOTTOM of the stack, so the turn passes to the next player only
  // once every station effect above it - and every question it asked - has been resolved.
  // Before, the turn moved on at once and the question was answered by the wrong seat.
  push(s, { k: 'endTurn' });
  if (fx.length) push(s, { k: 'fx', fx, i: 0 });
  pump(s);
}

function finishTurn(s) {
  refillTech(s);
  s.turn = { acted: false };
  const next = s.players.filter((x) => !x.passed);
  if (!next.length) return endRound(s);
  let i = s.current;
  do { i = (i + 1) % s.players.length; } while (s.players[i].passed);
  s.current = i;
}

function endRound(s) {
  if (s.round >= D.ROUNDS) {
    s.over = true;
    s.scores = s.players.map((p) => score(s, p));
    log(s, 'The game is over.');
    return;
  }
  s.round++;
  for (const p of s.players) {
    p.passed = false;
    // The queue slides forward, leaving only the last 3 figures off duty.
    const moving = p.queue.splice(0, Math.max(0, p.queue.length - D.QUEUE_KEEP));
    p.ready.push(...moving);
    const gifts = D.ROUND_TRACK[s.round] ?? {};
    if (gifts.medals) p.medals += gifts.medals;
    if (gifts.cadets) for (let i = 0; i < gifts.cadets; i++) p.ready.push(D.CADET);
  }
  // Station tiles go back out, unless a ship is sitting on the planet.
  for (const st of Object.values(s.stations)) {
    if (!st.out && !s.players.some((p) => p.at === st.at)) st.out = true;
  }
  s.first = (s.first + 1) % s.players.length;
  s.current = s.first;
  s.turn = { acted: false };
  log(s, `Round ${s.round}. ${s.players[s.first].name} starts.`);
}

export function winners(s) {
  const best = Math.max(...s.players.map((p) => score(s, p).total2));
  return s.players.filter((p) => score(s, p).total2 === best).map((p) => p.idx);
}
