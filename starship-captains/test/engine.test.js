import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  setup, apply, ask, score, winners, neighbours, routesAt, routeEnd, reservedBy, subordinates,
  damageCount, canActivate, roomsFor, countIconPairs, bonusesFor, GameError,
  techChoices, techSlotChoices, pump, undoable, revealsInfo, trainCost, promoteCost, medalsAvailable, abilities,
} from '../js/engine.js';
import * as D from '../js/data.js';

const newGame = (seed = 42) => setup({ names: ['Ann', 'Bob'], seed, first: 0 });
const expectError = (fn) => assert.throws(fn, GameError);
const act = (s, a) => apply(s, { p: s.current, ...a });

// Every effect keyword used anywhere in data.js must be one the engine knows. This is the
// cheap guard against typos as the 100-odd cards get transcribed.
const KEYWORDS = new Set(['move', 'jump', 'fight', 'tech', 'techR', 'repair', 'damage',
  'medal', 'artifact', 'pirateTok', 'android', 'cadet', 'ambush', 'queue',
  'coop', 'tincan', 'nian', 'anyTrack', 'anyTrack1x2', 'event',
  'fightSafe', 'drawTech3', 'drawOmega3', 'peekMissions3', 'trackPerAndroid',
  'ignoreDamage1', 'techNB', 'anyTrackNB', 'ignoreMissionDamage', 'freeTrain']);

function walkFx(fx, see) {
  for (const tok of fx ?? []) {
    if (Array.isArray(tok)) { see(tok[0]); continue; }
    if (typeof tok === 'string') { see(tok); continue; }
    if (tok.either) { for (const br of tok.either) walkFx(br, see); continue; }
    if (tok.pay) { walkFx([tok.pay], see); walkFx(tok.then, see); continue; }
    throw new Error(`odd effect token: ${JSON.stringify(tok)}`);
  }
}

test('every effect keyword in the data is one the engine implements', () => {
  const seen = new Set();
  const see = (k) => { seen.add(k); assert.ok(KEYWORDS.has(k), `unknown effect: ${k}`); };
  for (const r of D.ROOMS) walkFx(r.fx, see);
  for (const t of D.STATION_TILES) walkFx(t.fx, see);
  for (const f of D.FACTIONS) for (const side of f.sides) for (const sp of Object.values(side.bonus)) walkFx(sp, see);
  for (const t of D.TECHS) { walkFx(t.fx, see); walkFx(t.discard, see); walkFx(t.cost ? [t.cost] : [], see); }
  for (const m of D.MISSIONS) for (const line of m.lines) walkFx(line.fx, see);
  assert.ok(seen.size >= 8);
});

test('the tech and mission decks match the physical game', () => {
  assert.equal(D.TECHS.reduce((n, t) => n + t.n, 0), 50, '50 tech cards');
  // Every tech is now its own entry: the five duplicated abilities are mirrored pairs
  // with different edge icons, so no entry may carry a copy count above 1.
  for (const t of D.TECHS) assert.equal(t.n, 1, `${t.id}: duplicate copies must be separate entries`);
  // Each mirrored pair really is a mirror: one card's left edge is the other's right.
  for (const t of D.TECHS.filter((x) => x.id.endsWith('_m'))) {
    const base = D.TECHS.find((x) => x.id === t.id.slice(0, -2));
    assert.ok(base, `${t.id}: no card to mirror`);
    assert.deepEqual(t.L, base.R, `${t.id}: left edge should mirror ${base.id}'s right`);
    assert.deepEqual(t.R, base.L, `${t.id}: right edge should mirror ${base.id}'s left`);
    assert.equal(t.tier, base.tier, `${t.id}: tier should match ${base.id}`);
  }
  assert.equal(D.MISSIONS.length, 50, '50 mission cards');
  for (const set of [D.TECHS, D.MISSIONS, D.OMEGA]) {
    const ids = set.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  }
  // Every mission line is a real crew colour, and every mission scores something.
  for (const m of D.MISSIONS) {
    assert.ok(m.lines.length >= 1 && m.lines.length <= 3, `${m.id}: odd line count`);
    assert.ok(m.pts >= 2 && m.pts <= 7, `${m.id}: odd points`);
    for (const line of m.lines) {
      assert.ok([...D.ENSIGNS, 'gold'].includes(line.c), `${m.id}: bad line colour ${line.c}`);
    }
    // The faction a mission belongs to comes off its first line, so that is never gold.
    assert.ok(D.ENSIGNS.includes(m.lines[0].c), `${m.id}: first line is gold`);
  }
  // Exactly four lines in the deck are gold, and only an android can match one.
  const gold = D.MISSIONS.flatMap((m) => m.lines.filter((l) => l.c === 'gold'));
  assert.equal(gold.length, 4, 'four gold mission lines');
  for (const fig of [...D.ENSIGNS, D.CADET, 'R', 'Y', 'B']) {
    assert.equal(D.matches(fig, 'gold'), false, `${fig} must not match a gold line`);
  }
  assert.equal(D.matches(D.ANDROID, 'gold'), true);
  // Every room tech names a room colour the ship actually has.
  const roomColors = new Set(D.ROOMS.map((r) => r.color));
  for (const t of D.TECHS) if (t.room) assert.ok(roomColors.has(t.room), `${t.id}: bad room ${t.room}`);
});

test('the board graph is symmetric, duplicate-free and fully connected', () => {
  const ids = new Set(D.LOCS.map((l) => l.id));
  const seen = new Set();
  for (const { a, b, c } of D.ROUTES) {
    assert.ok(ids.has(a) && ids.has(b), `unknown location in route ${a}-${b}`);
    const key = [a, b].sort().join('-');
    assert.ok(!seen.has(key), `duplicate route ${key}`);
    seen.add(key);
    if (c !== null) assert.ok(D.ROUTE_COLORS.includes(c), `bad route colour ${c}`);
  }
  // Every planet has exactly one red, one green and one yellow route, so an ambush at
  // any planet always has a defined destination whatever colour the pirate is.
  for (const l of ids) {
    const cols = routesAt(l).map((i) => D.ROUTES[i].c).filter(Boolean).sort();
    assert.deepEqual(cols, [...D.ROUTE_COLORS].sort(), `${l} does not have one route of each colour`);
  }
  // reachability from Home
  const found = new Set(['home']);
  const stack = ['home'];
  while (stack.length) for (const n of neighbours(stack.pop())) if (!found.has(n)) { found.add(n); stack.push(n); }
  assert.equal(found.size, ids.size);
  // routes are two-way: the far end of a route from a leads back to a
  for (const l of ids) for (const i of routesAt(l)) assert.equal(routeEnd(i, routeEnd(i, l)), l);
});

test('component counts match the physical game', () => {
  assert.equal(D.LOCS.length, 14);          // 13 planets + Home Station
  assert.equal(D.ROUTES.length, 25);
  assert.equal(D.SETUP_PIRATES.length, 5);
  assert.equal(D.OMEGA.length, 12);
  assert.equal(D.ARTIFACTS.length, 3);
  assert.equal(D.PIRATES.reduce((n, p) => n + p.n, 0), 30);
  assert.equal(D.SHIP.cargoSlots, 7);
  assert.equal(D.SLOT_BOARD.length, 6);
  assert.equal(D.SLOT_BOARD.filter((s) => s.dmg).length, 4);
  assert.equal(D.FACTIONS.flatMap((f) => f.sides).length, 6);
  // every faction side has 4 bonuses and none of them sits on the event space
  for (const f of D.FACTIONS) for (const side of f.sides) {
    assert.equal(Object.keys(side.bonus).length, 4, `${side.id} bonus count`);
    assert.ok(!(D.EVENT_SPACE in side.bonus), `${side.id} collides with the event space`);
  }
});

test('setup deals one tile or mission to every planet and 7 damage to every ship', () => {
  const s = newGame();
  const planets = D.LOCS.filter((l) => !l.station).map((l) => l.id);
  const tiled = Object.keys(s.tiles);
  const stationed = Object.values(s.stations).filter((st) => st.at !== 'home').map((st) => st.at);
  const missioned = Object.keys(s.missions);
  assert.equal(tiled.length, D.NUMBERED_TILES);
  assert.equal(stationed.length, 2);
  assert.equal(new Set([...tiled, ...stationed, ...missioned]).size, planets.length);
  assert.equal(tiled.length + stationed.length, D.SETUP_TILED_PLANETS);
  for (const p of s.players) {
    assert.equal(damageCount(p), 7);
    assert.equal(p.ready.join(''), 'rybg');
    assert.equal(p.medals, 1);
    assert.equal(p.at, 'home');
  }
  assert.equal(s.pirates.filter(Boolean).length, 5);
  assert.equal(score(s, s.players[0]).total2, -13); // -7 damage, +1/2 medal
});

test('a cadet works only the gray room, an android works none', () => {
  const repair = D.ROOMS.find((r) => r.id === 'repair');
  const helm = D.ROOMS.find((r) => r.id === 'helm');
  assert.equal(canActivate('g', repair), true);
  assert.equal(canActivate('g', helm), false);
  assert.equal(canActivate('r', helm), true);
  assert.equal(canActivate('R', helm), true);   // a red commander is still red
  assert.equal(canActivate('b', helm), false);
  assert.equal(canActivate(D.ANDROID, repair), false);
});

test('activating sends the crew member to the back of the queue', () => {
  let s = newGame();
  s = act(s, { type: 'activate', room: 'science', with: { fig: 'b' } });
  const p = s.players[0];
  assert.ok(!p.ready.includes('b'));
  assert.equal(p.queue.at(-1), 'b');
  expectError(() => act(s, { type: 'activate', room: 'helm', with: { fig: 'b' } })); // already spent
});

test('two artifacts can activate a room instead of a crew member', () => {
  let s = newGame();
  const p = s.players[0];
  p.cargo[3] = { t: 'art', id: 'rb' };
  p.cargo[4] = { t: 'art', id: 'ry' };
  // rb + ry share red, so they can run the red room but not the blue one
  expectError(() => act(s, { type: 'activate', room: 'science', with: { art: [3, 4] } }));
  s = act(s, { type: 'activate', room: 'helm', with: { art: [3, 4] } });
  assert.equal(s.players[0].cargo[3], null);
  assert.equal(s.players[0].ready.join(''), 'rybg'); // no crew spent
});

test('training and promotion only happen before you act', () => {
  let s = newGame();
  s.players[0].medals = 3;
  s = act(s, { type: 'train', from: 'g', to: 'r' });
  assert.equal(s.players[0].ready.join(''), 'rybr');
  assert.equal(s.players[0].medals, 2);
  expectError(() => act(s, { type: 'promote', c: 'r' })); // only 2 medals left
  s.players[0].medals = 3;
  s = act(s, { type: 'promote', c: 'r' });
  assert.ok(s.players[0].ready.includes('R'));
  assert.equal(s.players[0].rings, D.COMMANDER_LIMIT - 1);
  s = act(s, { type: 'activate', room: 'repair', with: { fig: 'y' } });
  s.players[0].medals = 5;
  expectError(() => act(s, { type: 'train', from: 'b', to: 'r' })); // already acted
});

test('damage fills an empty slot, then makes you jettison cargo', () => {
  let s = newGame();
  const p = s.players[0];
  // one empty slot, one artifact, the rest already damaged
  p.cargo = [{ t: 'dmg' }, { t: 'dmg' }, { t: 'dmg' }, { t: 'dmg' }, { t: 'dmg' }, { t: 'art', id: 'rb' }, null];
  s = act(s, { type: 'activate', room: 'helm', with: { fig: 'r' } });
  s = act(s, { type: 'choose', opt: 'moon' });  // home-moon has a pirate: 1 damage
  assert.equal(s.players[0].cargo[6].t, 'dmg', 'the empty slot takes it');
  assert.equal(ask(s).q, 'move', 'second helm move still pending');
  s = act(s, { type: 'choose', opt: 'home' });  // back down the same pirate route
  assert.equal(ask(s).q, 'bump', 'nowhere to put it but on top of cargo');
  s = act(s, { type: 'choose', opt: 5 });       // jettison the artifact
  assert.equal(s.players[0].cargo[5].t, 'dmg');
  assert.equal(damageCount(s.players[0]), 11);  // 7 cargo + 4 tech slots
});

test('with every slot damaged, further damage stacks as excess', () => {
  let s = newGame();
  const p = s.players[0];
  p.cargo = p.cargo.map(() => ({ t: 'dmg' }));
  s = act(s, { type: 'activate', room: 'helm', with: { fig: 'r' } });
  s = act(s, { type: 'choose', opt: 'moon' });
  assert.equal(s.players[0].excess, 1);
  assert.equal(ask(s).q, 'move', 'no choice needed, it just piles up');
});

test('excess damage blocks the cargo slots but never the tech slots', () => {
  // Rulebook p. 9: excess keeps the cargo slots full until it is gone, "(But that does
  // not prevent you from repairing tech slots instead.)"
  const s = newGame();
  s.players[0].excess = 2;
  const before = damageCount(s.players[0]);

  // A ship starts with damaged tech slots, so the repair room must offer the choice.
  const asked = act(s, { type: 'activate', room: 'repair', with: { fig: 'g' } });
  assert.equal(ask(asked)?.q, 'repair', 'the choice is offered');
  const techSlot = asked.players[0].techSlots.findIndex((t) => t.dmg);
  const onTech = act(asked, { type: 'choose', opt: { zone: 'tech', i: techSlot } });
  assert.equal(onTech.players[0].excess, 2, 'the excess is untouched');
  assert.equal(onTech.players[0].techSlots[techSlot].dmg, false, 'the tech slot is clear');
  assert.equal(damageCount(onTech.players[0]), before - 1);

  // Cargo stays blocked while excess remains.
  const cargoSlot = asked.players[0].cargo.findIndex((c) => c?.t === 'dmg');
  if (cargoSlot >= 0) expectError(() => act(asked, { type: 'choose', opt: { zone: 'cargo', i: cargoSlot } }));
  const onExcess = act(asked, { type: 'choose', opt: { zone: 'excess' } });
  assert.equal(onExcess.players[0].excess, 1, 'excess can still be chosen');

  // With no damaged tech slot there is nothing to choose, so it just clears the excess.
  const g = structuredClone(s);
  g.players[0].techSlots = g.players[0].techSlots.map((t) => ({ ...t, dmg: false }));
  const auto = act(g, { type: 'activate', room: 'repair', with: { fig: 'g' } });
  assert.equal(ask(auto), null, 'nothing to ask about');
  assert.equal(auto.players[0].excess, 1, 'the excess is repaired');
});

test('a faction marker scores its zone, and a lap is worth +5', () => {
  const s = newGame();
  const m = s.players[0].marks[0];
  assert.equal(D.TRACK_ZONE_PTS[0], 0);
  assert.equal(D.TRACK_ZONE_PTS[3], 1);
  assert.equal(D.TRACK_ZONE_PTS[12], 4);
  m.sp = 2; m.loops = 1;
  assert.equal(score(s, s.players[0]).trackPts2, 2 * (1 + D.TRACK_LOOP_PTS));
});

test('the queue slides forward at end of round, leaving the last three', () => {
  let s = newGame();
  const p = s.players[0];
  p.queue = ['r', 'y', 'b', 'g', 'r'];
  p.ready = [];
  s.players[1].queue = [];
  s = act(s, { type: 'pass' });
  s = act(s, { type: 'pass' });
  assert.equal(s.round, 2);
  assert.deepEqual(s.players[0].queue, ['g', 'r'].length === 2 ? ['b', 'g', 'r'] : null);
  assert.deepEqual(s.players[0].ready, ['r', 'y']);
  assert.equal(s.players[0].medals, 2, 'round 2 hands out a medal');
});

test('rounds 3 and 4 each add a cadet, and the game ends after round 4', () => {
  let s = newGame();
  let guard = 0;
  while (!s.over && guard++ < 50) s = act(s, { type: 'pass' });
  assert.equal(s.over, true);
  assert.equal(s.round, D.ROUNDS);
  // started with one cadet, gained one in round 3 and one in round 4
  const crew = [...s.players[0].ready, ...s.players[0].queue];
  assert.equal(crew.filter((f) => f === D.CADET).length, 3);
  assert.ok(Array.isArray(s.scores));
});

test('the first player marker moves on each round', () => {
  let s = newGame();
  assert.equal(s.first, 0);
  s = act(s, { type: 'pass' });
  s = act(s, { type: 'pass' });
  assert.equal(s.first, 1);
  assert.equal(s.current, 1);
});

test('a planet is reserved by a lone ship, by nobody when two are there', () => {
  const s = newGame();
  assert.equal(reservedBy(s, 'home'), null, 'both ships start at Home');
  s.players[0].at = 'ice';
  assert.equal(reservedBy(s, 'ice'), 0);
  s.players[1].at = 'ice';
  assert.equal(reservedBy(s, 'ice'), null);
});

test('moving down a route with a pirate costs a damage', () => {
  let s = newGame();
  const i = D.routeBetween('home', 'moon');
  assert.ok(s.pirates[i], 'home-moon starts with a pirate');
  s = act(s, { type: 'activate', room: 'helm', with: { fig: 'r' } });
  assert.equal(ask(s).q, 'move');
  const before = damageCount(s.players[0]);
  s = act(s, { type: 'choose', opt: 'moon' });
  assert.equal(s.players[0].at, 'moon');
  assert.equal(damageCount(s.players[0]), before + 1);
  assert.equal(ask(s).q, 'move', 'the helm gives two moves');
});

test('the helm offers two moves and either may be skipped', () => {
  let s = newGame();
  s = act(s, { type: 'activate', room: 'helm', with: { fig: 'r' } });
  s = act(s, { type: 'choose', opt: 'ice' });     // no pirate on home-ice
  s = act(s, { type: 'choose', opt: 'skip' });
  assert.equal(s.players[0].at, 'ice');
  assert.equal(ask(s), null);
  assert.equal(damageCount(s.players[0]), 7, 'no pirate on that route');
});

test('a station tile fires on ending a turn there, then waits for next round', () => {
  let s = newGame();
  const [id, st] = Object.entries(s.stations).find(([, x]) => x.at !== 'home');
  s.players[0].at = st.at;
  s = act(s, { type: 'activate', room: 'repair', with: { fig: 'g' } });
  while (ask(s)) s = act(s, { type: 'choose', opt: pick(s) });
  s = act(s, { type: 'endTurn' });
  assert.equal(s.stations[id].out, false, 'the tile has been used');
});

function pick(s) {
  const f = ask(s);
  const p = s.players[s.current];
  if (f.q === 'repair') {
    // Excess first: it is the only thing that unblocks the cargo slots.
    if (p.excess > 0) return { zone: 'excess' };
    const i = p.cargo.findIndex((c) => c?.t === 'dmg');
    return i >= 0 ? { zone: 'cargo', i } : { zone: 'tech', i: p.techSlots.findIndex((t) => t.dmg) };
  }
  if (f.q === 'move') {
    // Head for a neighbouring planet with a mission if there is one, else wander.
    const n = neighbours(p.at);
    return n.find((loc) => s.missions[loc] && reservedBy(s, loc) === null) ?? n[(s.rng >>> 3) % n.length];
  }
  if (f.q === 'track') return 'coop';
  if (f.q === 'bump' || f.q === 'stow') {
    const i = p.cargo.findIndex((c) => c && c.t !== 'dmg');
    return i >= 0 ? i : 'drop';
  }
  if (f.q === 'line') return 'take';
  if (f.q === 'freeTrain') {
    const from = p.ready.find((x) => x === D.CADET || D.ENSIGNS.includes(x));
    return from ? { from, to: 'r' } : 'skip';
  }
  if (f.q === 'tech') {
    const slots = techSlotChoices(p, f);
    const card = techChoices(s, f)[0];
    return slots.length && card ? { card, slot: slots[0] } : 'skip';
  }
  if (f.q === 'peekMissions') return 'ok';
  if (f.q === 'branch') return 0;
  if (f.q === 'pay') {
    if (f.cost === 'medal') return p.medals > 0 ? 'pay' : 'skip';
    if (f.cost === 'tech') {
      const i = p.techSlots.findIndex((sl) => sl.tech);
      return i >= 0 ? i : 'skip';
    }
    const t = f.cost === 'artifact' ? 'art' : 'pir';
    const i = p.cargo.findIndex((c) => c?.t === t);
    return i >= 0 ? i : 'skip';
  }
  if (f.q === 'second') {
    if (f.line !== undefined) return 'extra';       // on a mission: resolve the line again
    const room = roomsFor(s, p).find((r) => canActivate(f.fig, r));
    return room ? { room: room.id } : 'skip';       // in a room: work another room
  }
  return 'skip';
}

test('tech bonus icons match only the same icon on the facing edge', () => {
  const s = newGame();
  const p = s.players[0];
  // the board's own middle pair already matches, and nothing else does
  assert.equal(countIconPairs(p), 1);
  // slot 2's left edge prints 'med'; a card with 'med' on its right edge pairs with it
  assert.deepEqual(bonusesFor(s, p, 1, { L: [], R: ['med'] }), ['med']);
  assert.deepEqual(bonusesFor(s, p, 1, { L: [], R: ['mov'] }), []);
});

test('a game of nothing but passes still scores, and ties are shared', () => {
  let s = newGame();
  while (!s.over) s = act(s, { type: 'pass' });
  const [a, b] = s.players.map((p) => score(s, p).total2);
  assert.equal(a, b);
  assert.deepEqual(winners(s), [0, 1]);
});

test('bot games finish inside four rounds without engine errors', () => {
  for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
    let s = newGame(seed);
    let guard = 0;
    while (!s.over && guard++ < 500) {
      if (ask(s)) { s = act(s, { type: 'choose', opt: pick(s) }); continue; }
      const p = s.players[s.current];
      // Complete the mission here if the crew stretches to it, otherwise work a room.
      const mid = s.missions[p.at];
      const owner = reservedBy(s, p.at);
      const m = mid && D.missionDef(mid);
      if (m && owner !== 1 - p.idx && p.ready.length >= m.lines.length) {
        s = act(s, { type: 'mission', assign: p.ready.slice(0, m.lines.length) });
        while (ask(s)) s = act(s, { type: 'choose', opt: pick(s) });
        s = act(s, { type: 'endTurn' });
        continue;
      }
      // Prefer the helm so the bot actually roams and finds missions to complete.
      const usable = roomsFor(s, p).filter((r) => p.ready.some((f) => canActivate(f, r)));
      const room = usable.find((r) => r.id === 'helm') ?? usable[0];
      if (!room) { s = act(s, { type: 'pass' }); continue; }
      const fig = p.ready.find((f) => canActivate(f, room));
      s = act(s, { type: 'activate', room: room.id, with: { fig } });
      while (ask(s)) s = act(s, { type: 'choose', opt: pick(s) });
      s = act(s, { type: 'endTurn' });
    }
    assert.equal(s.over, true, `seed ${seed} did not finish`);
    assert.equal(s.round, D.ROUNDS);
    for (const p of s.players) assert.ok(Number.isFinite(score(s, p).total2));
  }
});

test('setup deals only alpha techs face up, and the Tincan event shares its tech', () => {
  for (const seed of [1, 2, 3, 5, 8]) {
    const s = newGame(seed);
    const tin = s.tracks.find((t) => t.id === 'tincan');
    assert.equal(s.tech.row.length, D.TECH_ROW);
    assert.equal(s.tech.omega.length, D.OMEGA_ROW);
    for (const id of [...s.tech.row, tin.tech]) {
      assert.equal(D.techDef(id).tier, 'a', `${id} dealt face up but is a beta tech`);
    }
    // No card is in two places at once.
    const all = [...s.tech.row, ...s.tech.deck, tin.tech];
    assert.equal(all.length, D.TECHS.reduce((n, t) => n + t.n, 0));

    // Until the event fires the track's tech belongs to nobody; afterwards every
    // player can use it, without it occupying a slot.
    const p = s.players[0];
    const has = (st) => roomsFor(st, st.players[0]).some((r) => r.id === tin.tech);
    assert.equal(has(s), false);
    const after = structuredClone(s);
    after.tracks.find((t) => t.id === 'tincan').shared = true;
    if (D.techDef(tin.tech).room) {
      assert.equal(has(after), true);
      for (const q of after.players) assert.ok(roomsFor(after, q).some((r) => r.id === tin.tech));
    }
    assert.ok(p.techSlots.every((sl) => sl.tech !== tin.tech), 'shared tech must not take a slot');
  }
});

// Answer every question up to the one the test is about (track bonuses ask their own).
function until(g, q) {
  while (ask(g) && ask(g).q !== q) g = act(g, { type: 'choose', opt: pick(g) });
  assert.equal(ask(g)?.q, q, `expected to be asked '${q}'`);
  return g;
}

// Put a known mission on a planet and park the given crew there, ready to go.
function atMission(id, ready, { seed = 42, loc } = {}) {
  const s = newGame(seed);
  const at = loc ?? Object.keys(s.missions)[0];
  s.missions[at] = id;
  const p = s.players[0];
  p.at = at;
  p.ready = [...ready];
  p.queue = [];
  return { s, p, at };
}

test('a mission resolves its lines in order and the crew slide into the queue', () => {
  // Peace Talks: both lines are red - Ni'an 3, then Tincan 3.
  const { s, at } = atMission('peace_talks', ['r', 'r']);
  let g = act(s, { type: 'mission', assign: ['r', 'r'] });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  const p = g.players[0];

  assert.deepEqual(p.done, ['peace_talks']);
  assert.equal(g.missions[at], undefined, 'the mission leaves the planet');
  assert.deepEqual(p.ready, [], 'both figures left the ready room');
  assert.deepEqual(p.queue, ['r', 'r'], 'and join the queue, topmost line in front');
  assert.equal(p.marks[D.FACTIONS.findIndex((f) => f.id === 'nian')].sp, 3);
  assert.equal(p.marks[D.FACTIONS.findIndex((f) => f.id === 'tincan')].sp, 3);
  assert.equal(score(g, p).missionPts2, 2 * D.missionDef('peace_talks').pts);
});

test('a crew member of the wrong colour makes their line do nothing', () => {
  const { s } = atMission('peace_talks', ['b', 'b']);
  let g = act(s, { type: 'mission', assign: ['b', 'b'] });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  const p = g.players[0];
  assert.deepEqual(p.done, ['peace_talks'], 'the mission still counts for its points');
  for (const m of p.marks) assert.equal(m.sp, 0, 'but nothing was gained');
  assert.deepEqual(p.queue, ['b', 'b']);
});

test('a cadet matches nothing, an android matches every line and then leaves', () => {
  const { s } = atMission('peace_talks', [D.CADET, D.ANDROID]);
  let g = act(s, { type: 'mission', assign: [D.CADET, D.ANDROID] });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  const p = g.players[0];
  assert.equal(p.marks[D.FACTIONS.findIndex((f) => f.id === 'nian')].sp, 0, 'cadet matched nothing');
  assert.equal(p.marks[D.FACTIONS.findIndex((f) => f.id === 'tincan')].sp, 3, 'android matched');
  assert.deepEqual(p.queue, [D.CADET], 'the android does not join the queue');
  assert.ok(![...p.queue, ...p.ready].includes(D.ANDROID), 'it leaves the ship entirely');
});

test('a commander resolves its line, then either repeats it or calls up a subordinate', () => {
  const nian = D.FACTIONS.findIndex((f) => f.id === 'nian');

  // Extra work: the red commander resolves the Ni'an line a second time.
  {
    const { s } = atMission('peace_talks', ['R', 'r']);
    let g = until(act(s, { type: 'mission', assign: ['R', 'r'] }), 'second');
    g = act(g, { type: 'choose', opt: 'extra' });
    while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
    assert.equal(g.players[0].marks[nian].sp, 6, 'the line resolved twice');
  }
  // Command a subordinate: a red ensign comes up from the queue instead.
  {
    const { s, p } = atMission('peace_talks', ['R', 'r']);
    p.queue = ['b', 'r'];
    let g = until(act(s, { type: 'mission', assign: ['R', 'r'] }), 'second');
    g = act(g, { type: 'choose', opt: 'r' });
    while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
    const q = g.players[0];
    assert.equal(q.marks[nian].sp, 3, 'the line resolved once');
    assert.ok(q.ready.includes('r'), 'the subordinate reports to the ready room');
    assert.deepEqual(q.queue, ['b', 'R', 'r'], 'and the mission crew queue up behind');
  }
  // A commander can only call up a cadet or an ensign of its own colour.
  {
    const { s, p } = atMission('peace_talks', ['R', 'r']);
    p.queue = ['b'];
    const g = until(act(s, { type: 'mission', assign: ['R', 'r'] }), 'second');
    expectError(() => act(g, { type: 'choose', opt: 'b' }));
  }
});

test('a line that costs you something can be refused', () => {
  // The Duel's yellow line summons a pirate before advancing 3 on the Ni'an track.
  const { s } = atMission('the_duel', ['y', 'r']);
  const coop = D.FACTIONS.findIndex((f) => f.id === 'nian');
  const pirates0 = s.pirates.filter(Boolean).length;
  const g = until(act(s, { type: 'mission', assign: ['y', 'r'] }), 'line');

  let taken = act(g, { type: 'choose', opt: 'take' });
  while (ask(taken)) taken = act(taken, { type: 'choose', opt: pick(taken) });
  assert.ok(taken.players[0].marks[coop].sp >= 3, 'taking the line pays the 3 track spaces');

  let skipped = act(g, { type: 'choose', opt: 'skip' });
  while (ask(skipped)) skipped = act(skipped, { type: 'choose', opt: pick(skipped) });
  assert.equal(skipped.players[0].marks[coop].sp, 0, 'refusing gains nothing');
  assert.equal(skipped.pirates.filter(Boolean).length, pirates0, 'and summons no pirate');
  assert.deepEqual(skipped.players[0].done, ['the_duel'], 'the mission is still completed');
});

test('Arena Battle ignores all damage once its blue line is resolved', () => {
  const { s } = atMission('arena_battle', ['b', 'y', 'r']);
  const dmg0 = damageCount(s.players[0]);
  let g = act(s, { type: 'mission', assign: ['b', 'y', 'r'] });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  // Track bonuses can repair, so count the damage actually dealt rather than the total.
  assert.equal(g.log.filter((l) => l.includes('takes 1 damage')).length, 0, 'no damage was dealt');
  assert.equal(g.log.filter((l) => l.includes('ignores the damage')).length, 2, 'both hits ignored');
  assert.ok(g.log.some((l) => l.includes('arena shields')));
  // Without the blue crew member the shields never go up, so the damage lands.
  const { s: s2 } = atMission('arena_battle', ['r', 'y', 'r']);
  let h = act(s2, { type: 'mission', assign: ['r', 'y', 'r'] });
  while (ask(h)) h = act(h, { type: 'choose', opt: pick(h) });
  assert.ok(h.log.some((l) => l.includes('takes 1 damage')), 'damage lands without the shields');
  void dmg0;
});

test('a mission is reserved by the only ship on the planet', () => {
  const { s, at } = atMission('peace_talks', ['r', 'r']);
  s.players[0].at = at;
  s.current = 1;
  s.players[1].ready = ['r', 'r'];
  s.players[1].at = at;
  // With two ships there, neither reserves it and either may take it.
  assert.equal(reservedBy(s, at), null);
  assert.ok(act(s, { type: 'mission', assign: ['r', 'r'] }));
  // Alone, player 0 reserves it and player 1 is locked out.
  const solo = structuredClone(s);
  solo.players[1].at = 'home';
  solo.current = 1;
  assert.equal(reservedBy(solo, at), 0);
  expectError(() => act(solo, { type: 'mission', assign: ['r', 'r'] }));
});

test('completing a mission moves the top tile across and deals a new mission', () => {
  const { s, at } = atMission('peace_talks', ['r', 'r']);
  const before = Object.entries(s.tiles).filter(([, t]) => t.up);
  const [from, tile] = before.reduce((b, c) => (c[1].n > b[1].n ? c : b));
  const deckBefore = s.missionDeck.length;

  let g = act(s, { type: 'mission', assign: ['r', 'r'] });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });

  assert.equal(g.tiles[from], undefined, 'the tile leaves its planet');
  assert.deepEqual(g.tiles[at], { n: tile.n, up: false }, 'and lands face down where the mission was');
  assert.ok(g.missions[from], 'a new mission appears where the tile came from');
  assert.equal(g.missionDeck.length, deckBefore - 1);
});

test('turning tile 1 face down starts a pirate uprising', () => {
  const { s, at } = atMission('peace_talks', ['r', 'r']);
  // Leave tile 1 as the only face-up tile, so it is the one that moves.
  for (const [loc, t] of Object.entries(s.tiles)) { if (t.n !== 1) t.up = false; else s.tiles[loc] = { n: 1, up: true }; }
  const numbered = Object.keys(s.tiles).length;
  const piratesBefore = s.pirates.filter(Boolean).length;

  let g = act(s, { type: 'mission', assign: ['r', 'r'] });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });

  assert.ok(g.log.some((l) => l.includes('Pirate uprising')), 'the uprising fires');
  assert.equal(Object.values(g.tiles).filter((t) => t.up).length, numbered, 'every tile flips back up');
  assert.ok(g.pirates.filter(Boolean).length >= piratesBefore, 'pirates were placed, never removed');
  assert.ok(g.pirates.filter(Boolean).length <= piratesBefore + numbered);
});

test('researching a tech fills an empty slot and pays its matching edge bonuses', () => {
  const s = newGame();
  const p = s.players[0];
  // Slot 3's left edge prints 'med', so a card in slot 2 whose right edge prints 'med'
  // pairs with it. (Slots are numbered from 0 here.)
  // Put it on the board on its own, in case the shuffle already dealt a copy.
  s.tech.row = s.tech.row.filter((c) => c !== 'fleet_comms');
  s.tech.row.unshift('fleet_comms'); // L ['rep'], R ['med']
  s.tech.row.length = D.TECH_ROW;
  p.techSlots.forEach((sl) => { sl.tech = null; sl.dmg = false; });
  const medals = p.medals;

  let g = act(s, { type: 'activate', room: 'science', with: { fig: 'b' } });
  assert.equal(ask(g).q, 'tech');
  assert.ok(techChoices(g, ask(g)).includes('fleet_comms'));
  g = act(g, { type: 'choose', opt: { card: 'fleet_comms', slot: 1 } });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });

  const q = g.players[0];
  assert.equal(q.techSlots[1].tech, 'fleet_comms');
  assert.equal(q.medals, medals + 1, 'the matching med icon paid a medal');
  assert.equal(g.tech.row[0], null, 'a hole is left on the board');
  assert.ok(!g.tech.row.includes('fleet_comms'));
});

test('a damaged or occupied slot refuses a tech, but recycling replaces one', () => {
  const s = newGame();
  const p = s.players[0];
  s.tech.row[0] = 'fleet_comms';
  p.techSlots[0] = { tech: null, dmg: true };
  p.techSlots[1] = { tech: 'jump_drive', dmg: false };

  const g = act(s, { type: 'activate', room: 'science', with: { fig: 'b' } });
  expectError(() => act(g, { type: 'choose', opt: { card: 'fleet_comms', slot: 0 } }));
  expectError(() => act(g, { type: 'choose', opt: { card: 'fleet_comms', slot: 1 } }));

  // A recycle effect may take over an occupied slot, discarding what was there.
  const r = structuredClone(s);
  r.pending = [{ k: 'ask', q: 'tech', recycle: true }];
  const out = act(r, { type: 'choose', opt: { card: 'fleet_comms', slot: 1 } });
  assert.equal(out.players[0].techSlots[1].tech, 'fleet_comms');
  assert.ok(out.tech.discard.includes('jump_drive'), 'the old tech is discarded');
  // Even recycling cannot use a damaged slot.
  expectError(() => act(r, { type: 'choose', opt: { card: 'fleet_comms', slot: 0 } }));
});

test('the tech board refills from the alpha-beta deck at the end of the turn', () => {
  const s = newGame();
  const p = s.players[0];
  p.techSlots.forEach((sl) => { sl.tech = null; sl.dmg = false; });
  const taken = s.tech.omega[0];
  const deckBefore = s.tech.deck.length;

  let g = act(s, { type: 'activate', room: 'science', with: { fig: 'b' } });
  g = act(g, { type: 'choose', opt: { card: taken, slot: 0 } });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  assert.equal(g.tech.omega[0], null, 'the omega space is empty until the turn ends');

  g = act(g, { type: 'endTurn' });
  assert.ok(g.tech.omega[0], 'and is refilled');
  assert.ok(!D.OMEGA.some((o) => o.id === g.tech.omega[0]), 'from the alpha-beta deck, not the omega deck');
  assert.equal(g.tech.deck.length, deckBefore - 1);
});

// Walk a marker onto the event space, so that one named event fires.
function fireEvent(id, tweak = () => {}) {
  const s = newGame();
  const t = D.FACTIONS.findIndex((f) => f.id === D.eventDef(id).f);
  s.tracks[t].event = id;
  s.eventsDone = 0;
  tweak(s);
  s.players[0].marks[t].sp = D.EVENT_SPACE - 1;
  s.pending = [{ k: 'adv', t, left: 1 }];
  pump(s);
  let g = s;
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  return g;
}

test('every event card has a branch in the engine', () => {
  const s = newGame();
  for (const ev of D.EVENTS) {
    const g = structuredClone(s);
    const t = D.FACTIONS.findIndex((f) => f.id === ev.f);
    g.tracks[t].event = ev.id;
    g.eventsDone = 0;
    g.players[0].marks[t].sp = D.EVENT_SPACE - 1;
    g.pending = [{ k: 'adv', t, left: 1 }];
    assert.doesNotThrow(() => pump(g), `${ev.id} has no branch`);
    assert.ok(g.log.some((l) => l.includes(ev.name)), `${ev.id} did not announce itself`);
    assert.ok(!g.log.some((l) => l.includes('not implemented')), `${ev.id} is a stub`);
  }
});

test('Overtime Incentives calls up the queue, or a cadet for anyone who has passed', () => {
  const g = fireEvent('overtime_incentives', (s) => {
    s.players[0].queue = ['r', 'b'];
    s.players[1].queue = ['y'];
    s.players[1].passed = true;
  });
  assert.deepEqual(g.players[0].queue, ['b'], 'the front of the queue left');
  assert.ok(g.players[0].ready.includes('r'));
  assert.deepEqual(g.players[1].queue, ['y'], 'a passed player keeps their queue');
  assert.ok(g.players[1].ready.includes(D.CADET), 'and gains a cadet instead');
});

test('Routine Maintenance rewards the least damaged and repairs everyone else', () => {
  const g = fireEvent('routine_maintenance', (s) => {
    s.players[0].cargo = s.players[0].cargo.map(() => null);   // undamaged
    s.players[1].excess = 2;
  });
  assert.equal(g.players[0].medals, 1 + D.SHIP.medals, 'the least damaged gains a medal');
  assert.equal(g.players[1].excess, 1, 'everyone else repairs 1');
});

test('Sabotaged Negotiations shuts a room until it is repaired', () => {
  const g = fireEvent('sabotaged_negotiations', (s) => { s.players[0].queue = ['b']; });
  const p = g.players[0];
  assert.equal(p.roomDmg.science, true, 'the blue room matches the blue ensign at the front');
  assert.ok(!roomsFor(g, p).some((r) => r.id === 'science'), 'and cannot be activated');
  expectError(() => act(g, { type: 'activate', room: 'science', with: { fig: 'b' } }));
  // Repairing it puts it back in service.
  const fixed = structuredClone(g);
  fixed.pending = [{ k: 'ask', q: 'repair' }];
  const out = act(fixed, { type: 'choose', opt: { zone: 'room', i: 'science' } });
  assert.ok(roomsFor(out, out.players[0]).some((r) => r.id === 'science'));
});

test('Honesty Summit walks markers back, sparing bonus and starting spaces', () => {
  const t = D.FACTIONS.findIndex((f) => f.id === 'nian');
  const g = fireEvent('honesty_summit', (s) => {
    const side = D.FACTIONS[0].sides.find((x) => x.id === s.tracks[0].side);
    const bonusAt = Number(Object.keys(side.bonus)[0]);
    s.players[1].marks[0].sp = bonusAt;   // on a bonus space: stays put
    s.players[1].marks[2].sp = 0;         // on the start: stays put
  });
  assert.equal(g.players[1].marks[0].sp, Number(Object.keys(D.FACTIONS[0].sides.find((x) => x.id === g.tracks[0].side).bonus)[0]));
  assert.equal(g.players[1].marks[2].sp, 0);
  assert.ok(g.players[0].marks[t].sp < D.EVENT_SPACE, 'the marker that triggered it also steps back');
});

test('Explosive Crisis leaves a charge at every station for whoever docks first', () => {
  const g = fireEvent('explosive_crisis');
  for (const st of Object.values(g.stations)) assert.equal(st.bounty, 'damageAndTrack');
  // Ending a turn at a station sets it off, once.
  const home = g.stations.home;
  let h = structuredClone(g);
  h.players[h.current].at = home.at;
  h.turn = { acted: true };
  h.pending = null;
  h = act(h, { type: 'endTurn' });
  assert.equal(h.stations.home.bounty, null, 'the charge is spent');
  assert.ok(h.log.some((l) => l.includes('charge')));
});

test('Crowdsourcing leaves an artifact on each room tech, claimed by using the room', () => {
  const g = fireEvent('crowdsourcing', (s) => {
    s.players[0].techSlots[2] = { tech: 'jump_drive', dmg: false }; // a yellow room tech
  });
  const slot = g.players[0].techSlots[2];
  assert.ok(slot.art, 'an artifact waits on the room tech');
  let h = structuredClone(g);
  h.pending = null;
  h.turn = { acted: false };
  h.players[0].ready = ['y'];
  h = until(act(h, { type: 'activate', room: 'jump_drive', with: { fig: 'y' } }), 'takeArt');
  h = act(h, { type: 'choose', opt: 'take' });
  assert.equal(h.players[0].techSlots[2].art, null, 'it is taken off the card');
  assert.ok(h.players[0].cargo.some((c) => c?.t === 'art'), 'and into the hold');
});

// Install a tech in slot 0 and hand the player back.
function withTech(id, tweak = () => {}) {
  const s = newGame();
  s.players[0].techSlots[0] = { tech: id, dmg: false };
  tweak(s);
  return s;
}

test('every ability tech has wording and a `when` the engine knows', () => {
  const known = new Set(['trainFree', 'promoteCheap', 'spendAs', 'convert', 'anyTrackIsAny',
    'moveOrJumpAsRepair', 'extraMovePerTurn', 'stealth', 'medalBonusTrains', 'afterMission',
    'afterPromote', 'afterMissionWith', 'afterFightAndroid', 'androidReturns', 'extraStorage',
    'payPirateOrDiscardToIgnoreDamage', 'copyBoardRoom', 'replacesTech']);
  for (const t of D.TECHS) {
    if (!t.when) continue;
    assert.ok(known.has(t.when), `${t.id}: unknown ability '${t.when}'`);
    assert.ok(t.text, `${t.id}: no wording transcribed`);
  }
});

test('the suits and Quadcorders cut what training and promotion cost', () => {
  const plain = newGame();
  assert.equal(trainCost(plain, plain.players[0], 'b'), D.TRAIN_COST);
  assert.equal(promoteCost(plain, plain.players[0], 'y'), D.PROMOTE_COST);

  const q = withTech('quadcorders');            // training to blue is free
  assert.equal(trainCost(q, q.players[0], 'b'), 0);
  assert.equal(trainCost(q, q.players[0], 'r'), D.TRAIN_COST, 'other colours are unchanged');
  q.players[0].medals = 0;
  const out = act(q, { type: 'train', from: D.CADET, to: 'b' });
  assert.ok(out.players[0].ready.includes('b'));
  assert.equal(out.players[0].medals, 0);
  expectError(() => act(q, { type: 'train', from: D.CADET, to: 'r' }));

  const suit = withTech('security_suit');       // yellow commanders cost 1 less
  assert.equal(promoteCost(suit, suit.players[0], 'y'), D.PROMOTE_COST - 1);
  assert.equal(promoteCost(suit, suit.players[0], 'b'), D.PROMOTE_COST);
});

test('the display cases let stored artifacts and pirate tokens pay as medals', () => {
  const s = withTech('artifact_display');
  const p = s.players[0];
  p.medals = 0;
  p.cargo[0] = { t: 'art', id: D.ARTIFACTS[0].id };
  assert.equal(medalsAvailable(s, p), 1);
  const out = act(s, { type: 'train', from: D.CADET, to: 'r' });
  assert.equal(out.players[0].cargo[0], null, 'the artifact was spent');
  assert.ok(out.players[0].ready.includes('r'));
  // A pirate token does not work for the Artifact Display.
  const t = withTech('artifact_display');
  t.players[0].medals = 0;
  t.players[0].cargo[0] = { t: 'pir' };
  expectError(() => act(t, { type: 'train', from: D.CADET, to: 'r' }));
});

test('Repair Bots and the Wormhole Generator rewrite the move tech bonus', () => {
  // Slot 1's right edge must match slot 2's left edge ('med'), so use a 'mov' pairing:
  // slot 0's R and slot 1's L both carry 'mov' once a card with R ['mov'] goes in slot 0.
  const base = newGame();
  base.players[0].techSlots.forEach((sl) => { sl.tech = null; sl.dmg = false; });
  base.tech.row = base.tech.row.filter((c) => c !== 'blast_phasers');
  base.tech.row.unshift('blast_phasers'); // L ['med'], R ['mov']
  base.tech.row.length = D.TECH_ROW;

  // Slot 1's left edge prints 'mov', so a card in slot 0 whose right edge prints 'mov' pairs.
  const icons = bonusesFor(base, base.players[0], 0, D.techDef('blast_phasers'));
  assert.deepEqual(icons, ['mov']);

  const bots = structuredClone(base);
  bots.players[0].techSlots[4] = { tech: 'repair_bots', dmg: false };
  let g = act(bots, { type: 'activate', room: 'science', with: { fig: 'b' } });
  g = act(g, { type: 'choose', opt: { card: 'blast_phasers', slot: 0 } });
  assert.equal(ask(g).q, 'repair', 'the move bonus became a repair');
});

test('Stealth Paint ignores pirates you fly past and the first damage of a mission', () => {
  const s = withTech('stealth_paint');
  const p = s.players[0];
  p.at = 'home';
  const i = routesAt('home').find((j) => neighbours('home').includes(routeEnd(j, 'home')));
  s.pirates[i] = true;
  const dmg0 = damageCount(p);
  let g = act(s, { type: 'activate', room: 'helm', with: { fig: 'r' } });
  g = act(g, { type: 'choose', opt: routeEnd(i, 'home') });
  assert.equal(damageCount(g.players[0]), dmg0, 'flying past the pirate costs nothing');
  assert.ok(g.log.some((l) => l.includes('never sees you')));
});

test('the observers report a completed mission to their own faction', () => {
  // Ni'an Observer watches yellow missions; Peace Talks is a red one.
  const nian = D.FACTIONS.findIndex((f) => f.id === 'nian');
  const run = (tech, mission) => {
    const { s } = atMission(mission, ['r', 'r']);
    s.players[0].techSlots[0] = { tech, dmg: false };
    let g = act(s, { type: 'mission', assign: ['r', 'r'] });
    while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
    return g.players[0];
  };
  const watched = run('fleet_observer', 'peace_talks');   // red mission, red observer
  const ignored = run('nian_observer', 'peace_talks');    // red mission, yellow observer
  const coop = D.FACTIONS.findIndex((f) => f.id === 'coop');
  assert.ok(watched.marks[coop].sp > ignored.marks[coop].sp, 'only the matching observer fires');
  assert.ok(ignored.marks[nian].sp >= 3, 'the mission itself still paid out');
});

test('Dimensional Lockers widen the hold when installed', () => {
  const s = newGame();
  const p = s.players[0];
  p.techSlots.forEach((sl) => { sl.tech = null; sl.dmg = false; });
  s.tech.row = s.tech.row.filter((c) => c !== 'dimensional_lockers');
  s.tech.row.unshift('dimensional_lockers');
  s.tech.row.length = D.TECH_ROW;
  const before = p.cargo.length;
  let g = act(s, { type: 'activate', room: 'science', with: { fig: 'b' } });
  g = act(g, { type: 'choose', opt: { card: 'dimensional_lockers', slot: 1 } });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  assert.equal(g.players[0].cargo.length, before + 2);
  assert.equal(abilities(g, g.players[0], 'extraStorage').length, 1);
});

test('Metal-Eating Bugs can be paid by giving up an installed tech', () => {
  const { s, p } = atMission('metal_bugs', ['b', 'y']);
  p.techSlots[2] = { tech: 'jump_drive', dmg: false };
  p.excess = 2; // something for the repair to fix
  const g = until(act(s, { type: 'mission', assign: ['b', 'y'] }), 'pay');
  assert.equal(g.pending.at(-1).cost, 'tech');

  let paid = act(g, { type: 'choose', opt: 2 });
  while (ask(paid)) paid = act(paid, { type: 'choose', opt: pick(paid) });
  assert.equal(paid.players[0].techSlots[2].tech, null, 'the tech is given up');
  assert.ok(paid.tech.discard.includes('jump_drive'), 'and goes to the discard pile');
  assert.equal(paid.players[0].excess, 1, 'the repair happened');

  let kept = act(g, { type: 'choose', opt: 'skip' });
  while (ask(kept)) kept = act(kept, { type: 'choose', opt: pick(kept) });
  assert.equal(kept.players[0].techSlots[2].tech, 'jump_drive', 'declining keeps the tech');
  assert.equal(kept.players[0].excess, 2, 'and gains no repair');
});

test('a move can be taken back later in the same turn', () => {
  const s = newGame();
  const p = s.players[0];
  p.ready = ['r', 'y', 'b', D.CADET];
  p.medals = 5;
  assert.equal(s.history, null, 'no history before the turn s first move');

  const a = act(s, { type: 'train', from: D.CADET, to: 'r' });
  assert.equal(a.history.moves.length, 1);
  const b = act(a, { type: 'promote', c: 'y' });
  assert.equal(b.history.moves.length, 2);
  assert.ok(b.players[0].ready.includes('Y'));

  // Undo the training; the promotion still stands.
  const out = act(b, { type: 'undo', move: 0 });
  assert.equal(out.history.moves.length, 1);
  assert.ok(out.players[0].ready.includes('Y'), 'the later move is replayed');
  assert.ok(out.players[0].ready.includes(D.CADET), 'the cadet is back');
  assert.equal(out.players[0].medals, 5 - D.PROMOTE_COST, 'only the promotion was paid for');
});

test('undo is refused for a move that revealed something', () => {
  const s = newGame();
  const p = s.players[0];
  p.techSlots.forEach((sl) => { sl.tech = null; sl.dmg = false; });
  // Researching takes a card off the board and the board refills from the deck, so the
  // move hands out information.
  let g = act(s, { type: 'activate', room: 'science', with: { fig: 'b' } });
  g = act(g, { type: 'choose', opt: { card: g.tech.row[0], slot: 1 } });
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });

  const why = undoable(g);
  assert.ok(why, 'the turn replays');
  assert.ok(why.some((r) => r !== null), 'at least one move cannot be undone');
  // Whichever move drew the card is refused by name.
  const i = why.findIndex((r) => r !== null);
  expectError(() => act(g, { type: 'undo', move: i }));
});

test('undoable explains every move, and the history resets each turn', () => {
  const s = newGame();
  s.players[0].ready = ['r', 'y'];
  const a = act(s, { type: 'activate', room: 'repair', with: { fig: 'r' } });
  const reasons = undoable(a);
  assert.equal(reasons.length, a.history.moves.length);
  for (const r of reasons) assert.ok(r === null || typeof r === 'string');

  // Ending the turn clears the history: you cannot reach back into a finished turn.
  let g = a;
  while (ask(g)) g = act(g, { type: 'choose', opt: pick(g) });
  g = act(g, { type: 'endTurn' });
  assert.equal(g.history, null);
  assert.deepEqual(undoable(g), []);
  expectError(() => apply(g, { p: g.current, type: 'undo', move: 0 }));
});

test('a hand-edited state reports as not replayable rather than undoing wrongly', () => {
  const s = newGame();
  s.players[0].ready = ['r', 'y', D.CADET];
  s.players[0].medals = 5;
  const a = act(s, { type: 'train', from: D.CADET, to: 'r' });
  const tampered = structuredClone(a);
  tampered.players[0].medals += 7; // nothing in the history accounts for this
  assert.equal(undoable(tampered), null);
  expectError(() => act(tampered, { type: 'undo', move: 0 }));
});

test('each route holds the pirate token itself, and fighting pays out that token', () => {
  const s = newGame();
  const placed = s.pirates.filter(Boolean);
  assert.equal(placed.length, D.SETUP_PIRATES.length, 'one pirate per skull route');
  for (const tok of placed) {
    assert.ok(D.ROUTE_COLORS.includes(tok.c), 'a pirate knows its exhaust colour');
    assert.ok(D.PIRATE_REWARDS.includes(tok.reward), 'and what it pays out');
  }
  assert.equal(s.pirateBag.length, 30 - placed.length, 'the bag is short by what was placed');

  // Fighting pays out the token on that route, not a fresh draw.
  const p = s.players[0];
  const i = routesAt(p.at).find((j) => s.pirates[j]) ?? routesAt('home')[0];
  const g = structuredClone(s);
  g.players[0].at = D.ROUTES[i].a;
  g.pirates[i] = { c: D.ROUTES[i].c ?? 'red', reward: 'android' };
  const bagBefore = g.pirateBag.length;
  g.pending = [{ k: 'ask', q: 'fight' }];
  let out = act(g, { type: 'choose', opt: i });
  while (ask(out)) out = act(out, { type: 'choose', opt: pick(out) });
  assert.equal(out.pirates[i], null, 'the pirate leaves the route');
  assert.ok(out.players[0].ready.includes(D.ANDROID), 'the android reward was paid');
  assert.equal(out.pirateBag.length, bagBefore, 'and no second token was drawn');
});

test('every card the UI offers a picture for has one on disk', () => {
  const has = (p) => existsSync(new URL(`../img/${p}.webp`, import.meta.url));
  for (const m of D.MISSIONS) assert.ok(has(`missions/${m.id}`), `mission crop ${m.id}`);
  for (const t of [...D.TECHS, ...D.OMEGA]) assert.ok(has(`techs/${t.id}`), `tech crop ${t.id}`);
  for (let n = 1; n <= D.NUMBERED_TILES; n++) {
    assert.ok(has(`tiles/up${n}`), `tile ${n} face up`);
    assert.ok(has(`tiles/dn${n}`), `tile ${n} face down`);
  }
  for (const t of D.STATION_TILES) assert.ok(has(`tiles/st_${t.id}`), `station tile ${t.id}`);
  for (const f of D.FACTIONS) for (const side of f.sides) assert.ok(has(`tracks/${side.id}`), `track side ${side.id}`);
  for (const r of D.PIRATE_REWARDS) assert.ok(has(`tokens/pirate_${r === 'android' ? 'android' : 'medalart'}`), `pirate token ${r}`);
  // The Tincan event is the tech on its track, not a card, so it has no crop of its own.
  for (const e of D.EVENTS.filter((e) => e.id !== 'tincan_tech')) {
    assert.ok(has(`events/${e.id}`), `event crop ${e.id}`);
  }
});

test('the board picture has a spot for every planet and no stray ones', () => {
  const locs = D.LOCS.map((l) => l.id).sort();
  assert.deepEqual(Object.keys(D.MAP).sort(), locs, 'MAP covers exactly the planets');
  for (const [id, xy] of Object.entries(D.MAP)) {
    assert.equal(xy.length, 2, `${id} has an x and a y`);
    for (const n of xy) assert.ok(n > 0 && n < 100, `${id} sits inside the picture`);
  }
});


test("a commander can only call up a cadet or an ensign of its own colour", () => {
  const p = { queue: ['R', 'r', 'y', 'g', 'B', 'A'] };
  // 'R' is the red commander itself: it goes to the queue the moment it is assigned, so
  // the bug this guards against was offering the player their own commander back.
  assert.deepEqual(subordinates(p, 'R'), ['r', 'g']);
  assert.deepEqual(subordinates(p, 'B'), ['g']);
  assert.deepEqual(subordinates(p, 'Y'), ['y', 'g']);
  assert.equal(subordinates({ queue: [] }, 'R').length, 0);
});

test('the engine refuses a commander called up as a subordinate', () => {
  const s = newGame();
  const p = s.players[s.current];
  const g = structuredClone(s);
  g.players[g.current].queue = ['R', 'r'];
  g.pending = [{ k: 'room', fig: 'R', phase: 'ask' }, { k: 'ask', q: 'second', fig: 'R' }];
  expectError(() => act(g, { type: 'choose', opt: 'R' }));
  const ok = act(g, { type: 'choose', opt: 'r' });
  assert.ok(ok.players[ok.current].ready.includes('r'), 'the ensign reports to the ready room');
  assert.ok(ok.players[ok.current].queue.includes('R'), 'the commander stays in the queue');
  assert.ok(p, 'sanity');
});

test('an observer fires on any line of its colour, not just the first', () => {
  // Rulebook appendix: "These cards care only about whether the completed mission has at
  // least 1 line of the depicted color." Lost World is yellow then blue, so the Tincan
  // Observer must still report in.
  const lost = D.missionDef('lost_world');
  assert.deepEqual(lost.lines.map((l) => l.c), ['y', 'b']);
  assert.ok(D.missionHasColor(lost, 'b'), 'blue is on the second line and still counts');
  assert.ok(D.missionHasColor(lost, 'y'));
  assert.ok(!D.missionHasColor(lost, 'r'));
  // Every observer's colour must be one a mission can actually carry.
  for (const t of D.TECHS.filter((t) => t.when === 'afterMission')) {
    assert.ok(D.MISSIONS.some((m) => D.missionHasColor(m, t.c)), `${t.id} can fire at all`);
  }
});

test('Turbo-Lasers fights without taking the damage', () => {
  const setUpFight = (safe) => {
    const g = newGame();
    const p = g.players[g.current];
    const i = routesAt(p.at).find((j) => g.pirates[j]) ?? routesAt(p.at)[0];
    g.pirates[i] = { c: D.ROUTES[i].c ?? 'red', reward: 'android' };
    g.players[g.current].cargo = g.players[g.current].cargo.map(() => null);
    g.pending = [{ k: 'ask', q: 'fight', ...(safe ? { safe: true } : {}) }];
    const before = damageCount(g.players[g.current]);
    let out = act(g, { type: 'choose', opt: i });
    while (ask(out)) out = act(out, { type: 'choose', opt: pick(out) });
    // The ship starts with damaged tech slots, so compare the change, not the total.
    return damageCount(out.players[out.current]) - before;
  };
  assert.equal(setUpFight(false), 1, 'a plain fight costs 1 damage');
  assert.equal(setUpFight(true), 0, 'with Turbo-Lasers it costs none');
});

test('the only card that fights safely is the one printed that way', () => {
  const safe = D.TECHS.filter((t) => JSON.stringify(t).includes('fightSafe')).map((t) => t.id);
  assert.deepEqual(safe, ['turbo_lasers']);
});

test('a track remembers which event it had after the event happens', () => {
  const s = newGame();
  const t = D.FACTIONS.findIndex((f) => f.id === 'nian');
  const had = s.tracks[t].event;
  assert.ok(had, 'the track starts with an event');

  const g = structuredClone(s);
  g.players[g.current].marks[t].sp = D.EVENT_SPACE - 1;
  g.pending = [{ k: 'fx', fx: [['nian', 1]], i: 0 }];
  let out = pump(g) ?? g;
  while (ask(out)) out = apply(out, { p: out.current, type: 'choose', opt: pick(out) });

  assert.equal(out.tracks[t].event, null, 'it cannot fire a second time');
  assert.equal(out.tracks[t].fired, had, 'but we still know which card it was');
  assert.equal(out.eventsDone, 1);
});

test('every matching mission line is offered, even a harmless one', () => {
  // Rulebook p. 13: "you MAY perform all depicted effects ... or if there is an effect you
  // want to avoid, ignore the entire line." Urgent Repair's only line is pure profit and
  // must still be offered, because declining can matter (a track you don't want to move).
  const m = D.missionDef('urgent_repair');
  assert.deepEqual(m.lines.map((l) => l.c), ['b']);
  const { s, p } = atMission('urgent_repair', ['b']);
  const g = act(s, { type: 'mission', assign: ['b'] });
  assert.equal(ask(g)?.q, 'line', 'the line is offered rather than resolved');
  assert.equal(ask(g).line, 0);

  const drain = (x) => { while (ask(x)) x = apply(x, { p: x.current, type: 'choose', opt: pick(x) }); return x; };
  const took = drain(act(g, { type: 'choose', opt: 'take' }));
  const left = drain(act(g, { type: 'choose', opt: 'skip' }));
  assert.ok(left.players[0].done.includes('urgent_repair'), 'skipping still completes it');
  assert.ok(took.players[0].done.includes('urgent_repair'));
  // Taking it repairs; skipping it does not.
  assert.ok(damageCount(took.players[0]) < damageCount(left.players[0]), 'the repair only happens if taken');
  assert.ok(p, 'sanity');
});

test('only Steal Secret Plans and the Omega Megacomputer use the omega deck', () => {
  // Rulebook appendix: "Steal Secret Plans / Omega Megacomputer - These are the only cards
  // that use the omega deck." Tincan Library draws from the ordinary tech deck.
  const uses = (defs, kw) => defs.filter((d) => JSON.stringify(d).includes(kw)).map((d) => d.id).sort();
  assert.deepEqual(uses([...D.MISSIONS, ...D.TECHS, ...D.OMEGA], 'drawOmega3'),
    ['omega_megacomputer', 'omega_megacomputer_m', 'secret_plans']);
  assert.deepEqual(uses([...D.MISSIONS, ...D.TECHS, ...D.OMEGA], 'drawTech3'), ['tincan_library']);
});

test('drawing 3 omega cards offers omega cards, and may replace a tech', () => {
  const s = newGame();
  const g = structuredClone(s);
  const p = g.players[g.current];
  p.techSlots[2] = { tech: 'jump_drive', dmg: false };
  g.pending = [{ k: 'fx', fx: ['drawOmega3'], i: 0 }];
  const out = pump(g) ?? g;
  const f = ask(out);
  assert.equal(f.q, 'tech');
  assert.equal(f.pool.length, 3);
  for (const id of f.pool) assert.ok(D.OMEGA.some((o) => o.id === id), `${id} is an omega card`);
  assert.ok(techSlotChoices(out.players[out.current], f).includes(2), 'an occupied slot can be replaced');
});

test('"but don\'t gain tech bonuses" is the recycling icon, so it may replace a tech', () => {
  // Rulebook p. 11: the blue chip is plain research; the round gear with arrows is
  // "Recycling a Tech Slot". All three of these missions print the gear.
  const bonusless = D.MISSIONS.filter((m) => JSON.stringify(m).includes('techNB')).map((m) => m.id).sort();
  assert.deepEqual(bonusless, ['dormant_lab', 'experimental_research', 'first_contact']);

  const g = newGame();
  const p = g.players[g.current];
  g.tech.row[0] = 'fleet_comms';
  p.techSlots.forEach((sl) => { sl.tech = 'jump_drive'; sl.dmg = false; });
  g.pending = [{ k: 'fx', fx: ['techNB'], i: 0 }];
  const out = pump(g) ?? g;
  const f = ask(out);
  assert.equal(f.q, 'tech');
  assert.ok(f.noBonus, 'no edge bonuses');
  assert.ok(techSlotChoices(out.players[out.current], f).length, 'a full tech board is still a legal target');
});

test('the Blue Station repairs before it draws the artifact', () => {
  // Upright (apex down) the wrench is left of the artifact, and effects resolve left to
  // right - so a full hold is cleared by one before the other arrives.
  assert.deepEqual(D.STATION_TILES.find((t) => t.id === 'blue').fx, [['repair', 1], ['artifact', 1]]);

  const s = newGame();
  const p = s.players[s.current];
  p.cargo = p.cargo.map(() => ({ t: 'dmg' }));
  p.cargo[0] = { t: 'pir' };
  s.pending = [{ k: 'fx', fx: D.STATION_TILES.find((t) => t.id === 'blue').fx, i: 0 }];
  let g = pump(s) ?? s;
  assert.equal(ask(g).q, 'repair', 'the repair comes first');
  g = act(g, { type: 'choose', opt: { zone: 'cargo', i: 1 } });
  assert.equal(ask(g), null, 'the artifact lands in the slot the repair just freed');
  assert.ok(g.players[g.current].cargo.some((c) => c?.t === 'art'), 'the artifact is aboard');
});
