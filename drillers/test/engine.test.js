import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, apply, cardDef, trackUsed, revealsInfo, undoable, upgrade, GameError } from '../js/engine.js';
import * as D from '../js/data.js';

const newGame = (seed = 42) => setup({ names: ['Ann', 'Bob'], seed, first: 0 });
const expectError = (fn) => assert.throws(fn, GameError);
// Put a specific card into player 0's hand.
function giveCard(s, defId) {
  const iid = 'c' + s.nextId++;
  s.cards[iid] = defId;
  s.players[0].hand.push(iid);
  return iid;
}

test('card data is complete', () => {
  const count = (shop) => D.CARDS.filter((c) => c.shop === shop).length;
  assert.equal(count('start'), 8);
  assert.equal(count('drill'), 12);
  assert.equal(count('move'), 12);
  assert.equal(count('util'), 12);
  assert.equal(count('adv'), 16);
  assert.equal(D.CORRIDOR_TILES.length, 29);
  assert.equal(D.FLOOR_CARDS.filter((c) => c.deck === 'start').length, 3);
  assert.equal(D.FLOOR_CARDS.filter((c) => c.deck === 'deep').length, 9);
});

test('revealsInfo: plain moves are undoable, draws/excavation/turn end are not', () => {
  const s = newGame();
  const torso = s.players[0].hand[0];
  const s1 = apply(s, { p: 0, type: 'playMain', iid: torso, option: 1 });
  assert.equal(revealsInfo(s, s1), false);
  const s2 = apply(s1, { p: 0, type: 'move', dir: 1 });
  assert.equal(revealsInfo(s1, s2), false);

  const dig = structuredClone(s);
  Object.assign(dig.players[0], { floor: 2, drills: 5 });
  assert.equal(revealsInfo(dig, apply(dig, { p: 0, type: 'excavate' })), true);

  const drawer = structuredClone(s);
  const dmg = giveCard(drawer, 'damage');
  assert.equal(revealsInfo(drawer, apply(drawer, { p: 0, type: 'playMain', iid: dmg })), true);

  const e1 = apply(s, { p: 0, type: 'endOps' });
  assert.equal(revealsInfo(s, e1), false);
  const e2 = apply(e1, { p: 0, type: 'endSurface' });
  const low = structuredClone(e1);
  low.players[0].fuel = 2;
  assert.equal(apply(low, { p: 0, type: 'endSurface' }).players[0].fuel, low.players[0].fuelMax, 'finishing surfacing refuels');
  assert.equal(revealsInfo(e2, apply(e2, { p: 0, type: 'endTurn', keep: [] })), true);
});

test('the turn history records each move and clears when the turn passes', () => {
  let s = newGame();
  assert.equal(s.history, null);
  s = apply(s, { p: 0, type: 'default', kind: 'move' });
  s = apply(s, { p: 0, type: 'default', kind: 'drill' });
  assert.deepEqual(s.history.moves.map((m) => [m.action.kind, m.revealed]), [['move', false], ['drill', false]]);
  assert.deepEqual(undoable(s), [null, null]);
  s = apply(s, { p: 0, type: 'endOps' });
  s = apply(s, { p: 0, type: 'endSurface' });
  assert.equal(s.history.moves.length, 4);
  s = apply(s, { p: 0, type: 'endTurn', keep: [] });
  assert.equal(s.history, null);
  expectError(() => apply(s, { p: 0, type: 'undo', move: 0 }));
});

test('undoing the last move restores the state before it', () => {
  const s0 = apply(newGame(), { p: 0, type: 'default', kind: 'move' });
  const s1 = apply(s0, { p: 0, type: 'move', dir: 1 });
  assert.deepEqual(apply(s1, { p: 0, type: 'undo', move: 1 }), s0);
  expectError(() => apply(s1, { p: 1, type: 'undo', move: 1 })); // not your turn
  expectError(() => apply(s1, { p: 0, type: 'undo', move: 2 }));
});

test('a move from before a reveal can still be undone, but not the reveal', () => {
  let s = newGame();
  Object.assign(s.players[0], { floor: 3, drills: 4, fuel: 9 });
  s.floors[4].card = 'lobby';
  for (let i = 0; i < 3; i++) s = apply(s, { p: 0, type: 'default', kind: 'move' });
  s = apply(s, { p: 0, type: 'barrier' });
  assert.deepEqual(undoable(s), [null, null, null, 'revealed hidden information']);
  expectError(() => apply(s, { p: 0, type: 'undo', move: 3 }));

  const u = apply(s, { p: 0, type: 'undo', move: 1 });
  const p = u.players[0];
  assert.deepEqual([p.fuel, p.moves, p.floor, p.credits], [3, 2, 4, s.players[0].credits]);
  assert.equal(u.floors[4].cardUp, true);
  assert.deepEqual(u.history.moves.map((m) => m.action.type), ['default', 'default', 'barrier']);
  assert.deepEqual(undoable(u), [null, null, 'revealed hidden information']);
});

test('a move a later move depends on cannot be undone', () => {
  let s = newGame();
  Object.assign(s.players[0], { fuel: 3, moves: 0 });
  s = apply(s, { p: 0, type: 'default', kind: 'move' });
  s = apply(s, { p: 0, type: 'move', dir: 1 });
  assert.deepEqual(undoable(s), ['move 2 needs it', null]);
  expectError(() => apply(s, { p: 0, type: 'undo', move: 0 }));
});

test('a move that would change what a later move revealed cannot be undone', () => {
  let s = newGame();
  const reckless = giveCard(s, 'reckless_drilling'); // puts a DAMAGE on top of your deck
  const dmg = giveCard(s, 'damage'); // draws 1
  s.players[0].fuel = 5;
  s = apply(s, { p: 0, type: 'playMain', iid: reckless });
  s = apply(s, { p: 0, type: 'playMain', iid: dmg });
  assert.equal(s.cards[s.players[0].hand.at(-1)], 'damage', 'drew the DAMAGE Reckless Drilling put on the deck');
  // Without Reckless Drilling the draw would have been a different card.
  assert.deepEqual(undoable(s), ['would change what move 2 revealed', 'revealed hidden information']);
});

test('the turn history is ignored if it no longer matches the game', () => {
  let s = apply(newGame(), { p: 0, type: 'default', kind: 'move' });
  s.players[0].credits += 5; // edited by hand
  assert.equal(undoable(s), null);
  expectError(() => apply(s, { p: 0, type: 'undo', move: 0 }));
});

test('v2 saves load with an empty turn history', () => {
  const { history, ...old } = newGame();
  const s = upgrade({ ...old, v: 2 });
  assert.equal(s.v, 3);
  assert.equal(s.history, null);
  assert.equal(apply(s, { p: 0, type: 'default', kind: 'move' }).history.moves.length, 1);
});

test('first player is random and starting credits and cards follow turn order', () => {
  const firsts = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const s = setup({ names: ['Ann', 'Bob'], seed });
    firsts.add(s.current);
    assert.equal(s.players[s.current].credits, 2);
    assert.equal(s.players[1 - s.current].credits, 4);
    assert.equal(s.players[s.current].hand.length, 3);
    assert.equal(s.players[1 - s.current].hand.length, 4);
  }
  assert.deepEqual([...firsts].sort(), [0, 1]);
});

test('setup deals hands with TORSO first and correct credits', () => {
  const s = newGame();
  for (const p of s.players) {
    assert.equal(s.cards[p.hand[0]], 'torso');
    assert.equal(p.deck.length + p.hand.length, 9);
  }
  assert.deepEqual(s.players.map((p) => p.hand.length), [3, 4]);
  assert.deepEqual(s.players.map((p) => p.credits), [2, 4]);
  assert.equal(s.floors[2].cardUp, true);
  assert.ok(s.floors.slice(3).every((f) => f.barrier && f.card));
  assert.equal(s.shops.adv.row.length, 2);
  assert.equal(s.advUnder.length, 2);
});

test('only the current player can act; moving needs moves and open floors', () => {
  let s = newGame();
  expectError(() => apply(s, { p: 1, type: 'endOps' }));
  expectError(() => apply(s, { p: 0, type: 'move', dir: 1 }));
  s = apply(s, { p: 0, type: 'default', kind: 'move' });
  assert.equal(s.players[0].fuel, 7);
  s = apply(s, { p: 0, type: 'move', dir: 1 });
  assert.equal(s.players[0].floor, 1);
  expectError(() => apply(s, { p: 0, type: 'move', dir: -1 }));
});

test('choice cards apply the chosen option', () => {
  let s = newGame();
  const torso = s.players[0].hand[0];
  const a = apply(s, { p: 0, type: 'playMain', iid: torso, option: 0 });
  assert.equal(a.players[0].drills, 1);
  assert.equal(a.players[0].moves, 0);
  const b = apply(s, { p: 0, type: 'playMain', iid: torso, option: 1 });
  assert.equal(b.players[0].moves, 2);
});

test('card repairs are free and remove damage from the game', () => {
  let s = newGame();
  const pit = giveCard(s, 'pit_stop');
  s = apply(s, { p: 0, type: 'playMain', iid: pit });
  assert.equal(s.players[0].turn.repairs, 1);
  const p = s.players[0];
  const dmg = [...p.hand, ...p.deck].find((x) => s.cards[x] === 'damage');
  p.hand.push(dmg);
  p.deck = p.deck.filter((x) => x !== dmg);
  const pile = s.damagePile;
  s = apply(s, { p: 0, type: 'repair', iid: dmg });
  assert.equal(s.damagePile, pile + 1);
  assert.ok(!s.players[0].hand.includes(dmg));
  assert.equal(s.players[0].credits, 2);
});

test('a card that draws and repairs lets you repair the top card before drawing', () => {
  let s = newGame();
  const wc = giveCard(s, 'water_cooling');
  const dmg = 'c' + s.nextId++;
  s.cards[dmg] = 'damage';
  s.players[0].deck.unshift(dmg);
  const next = s.players[0].deck[1];
  const played = apply(s, { p: 0, type: 'playMain', iid: wc });
  assert.equal(played.players[0].hand.length, s.players[0].hand.length - 1);
  assert.equal(played.players[0].turn.draws, 1);
  assert.equal(revealsInfo(s, played), false);

  s = apply(played, { p: 0, type: 'repair', iid: dmg });
  s = apply(s, { p: 0, type: 'draw' });
  assert.equal(s.players[0].hand.at(-1), next);
  assert.equal(s.players[0].turn.draws, 0);
  expectError(() => apply(s, { p: 0, type: 'draw' }));

  // Any other action draws first.
  const moved = apply({ ...played, players: [{ ...played.players[0], moves: 1 }, played.players[1]] }, { p: 0, type: 'move', dir: 1 });
  assert.equal(moved.players[0].hand.at(-1), dmg);
  assert.equal(moved.players[0].turn.draws, 0);
});

test('repairing the last card of the deck shuffles the discard pile into a new deck', () => {
  let s = newGame();
  const pit = giveCard(s, 'pit_stop');
  s = apply(s, { p: 0, type: 'playMain', iid: pit });
  const p = s.players[0];
  const dmg = 'c' + s.nextId++;
  s.cards[dmg] = 'damage';
  p.discard.push(...p.deck);
  p.deck = [dmg];
  const discarded = [...p.discard];
  s = apply(s, { p: 0, type: 'repair', iid: dmg });
  assert.deepEqual([...s.players[0].deck].sort(), discarded.sort());
  assert.deepEqual(s.players[0].discard, []);
});

test('excavating a corridor adds minerals and a tile', () => {
  let s = newGame();
  s.players[0].floor = 2;
  s.players[0].drills = 2;
  const before = s.floors[2].minerals.length;
  const tile = D.CORRIDOR_TILES[s.floors[2].corridors[0]];
  s = apply(s, { p: 0, type: 'excavate' });
  assert.equal(s.floors[2].minerals.length, before + tile.minerals.length);
  assert.equal(s.players[0].tiles.length, 1);
  assert.equal(trackUsed(s.players[0]), 2);
});

test('Suction Engine makes only silver free to collect', () => {
  let s = newGame();
  s = apply(s, { p: 0, type: 'playMain', iid: giveCard(s, 'suction_engine') });
  s.players[0].floor = 2;
  s.players[0].drills = 0;
  s.floors[2].minerals = ['silver', 'silver', 'gold'];
  s.players[0].storageMax = 3;
  s = apply(s, { p: 0, type: 'collect', mineral: 'silver' });
  s = apply(s, { p: 0, type: 'collect', mineral: 'silver' });
  assert.deepEqual(s.players[0].storage, ['silver', 'silver']);
  expectError(() => apply(s, { p: 0, type: 'collect', mineral: 'gold' }));
  s.players[0].drills = 1;
  s = apply(s, { p: 0, type: 'collect', mineral: 'gold' });
  assert.equal(s.players[0].drills, 0);
});

test('free fuel-cap upgrades apply before the fuel gain', () => {
  let s = newGame();
  const p = s.players[0];
  p.fuel = p.fuelMax;
  s = apply(s, { p: 0, type: 'playMain', iid: giveCard(s, 'refuelling_drone') });
  assert.equal(s.players[0].fuelMax, p.fuelMax + 1);
  assert.equal(s.players[0].fuel, p.fuelMax + 1);
});

test('barrier removal opens the floor, moves the mech, expands advanced shop at floor 4', () => {
  let s = newGame();
  const p = s.players[0];
  p.floor = 3;
  s.floors[3].barrier = false;
  p.drills = 4;
  s = apply(s, { p: 0, type: 'barrier' });
  assert.equal(s.players[0].floor, 4);
  assert.equal(s.floors[4].barrier, false);
  assert.equal(s.shops.adv.row.length, 4);
});

test('market pays falling prices then overflow', () => {
  let s = newGame();
  const p = s.players[0];
  p.storageMax = 7;
  p.storage = ['emerald', 'emerald', 'emerald', 'emerald'];
  s.phase = 'surface';
  s = apply(s, { p: 0, type: 'sell' });
  const q = s.players[0];
  assert.equal(q.credits, 2 + 8 + 8 + 7 + 6);
  assert.equal(q.market.emerald, 3);
  assert.deepEqual(q.overflow, ['emerald']);
});

test('upkeep keeps one card free and charges fuel for extras', () => {
  let s = newGame();
  s = apply(s, { p: 0, type: 'endOps' });
  assert.equal(s.phase, 'surface');
  s = apply(s, { p: 0, type: 'endSurface' });
  const hand = s.players[0].hand;
  s = apply(s, { p: 0, type: 'endTurn', keep: hand.slice(0, 2) });
  assert.equal(s.players[0].fuel, 9);
  assert.equal(s.players[0].hand.length, 5);
  assert.equal(s.current, 1);
});

test('milestone goes to the first player and others gain credits', () => {
  let s = newGame();
  const p = s.players[0];
  p.floor = 2;
  p.drills = 6;
  for (let i = 0; i < 3; i++) s = apply(s, { p: 0, type: 'excavate' });
  assert.equal(trackUsed(s.players[0]), 6);
  assert.equal(s.milestones[0], 0);
  assert.equal(s.players[1].credits, 4 + D.MILESTONES[0].credits);
});

test('completing the progress track gives everyone else one final turn', () => {
  let s = newGame();
  const p = s.players[0];
  p.overflow = Array(10).fill('silver'); // limit = 15
  p.floor = 4;
  s.floors[4].barrier = false;
  p.drills = 99;
  while (s.endBy === null) s = apply(s, { p: 0, type: 'excavate' });
  assert.equal(s.finalMilestone, 0);
  s = apply(s, { p: 0, type: 'endOps', opt: { chill: 'damage' } });
  s = apply(s, { p: 0, type: 'endTurn', keep: [] });
  assert.equal(s.over, false);
  assert.equal(s.current, 1);
  s = apply(s, { p: 1, type: 'endOps' });
  s = apply(s, { p: 1, type: 'endSurface' });
  s = apply(s, { p: 1, type: 'endTurn', keep: [] });
  assert.equal(s.over, true);
  assert.ok(s.scores[0].milestones >= 18);
  assert.equal(s.scores[0].depth, -7);
});

test('advanced cards need a battery tile', () => {
  let s = newGame();
  s.phase = 'surface';
  s.players[0].credits = 50;
  const iid = s.shops.adv.row[0];
  expectError(() => apply(s, { p: 0, type: 'buy', shop: 'adv', iid }));
  s.players[0].tiles.push({ id: 'b3', ex: false });
  s = apply(s, { p: 0, type: 'buy', shop: 'adv', iid });
  assert.equal(s.players[0].tiles[0].ex, true);
});

test('buying an advanced card spends the battery that loses the fewest points', () => {
  let s = newGame();
  s.phase = 'surface';
  s.players[0].credits = 50;
  // k5 (floor 3 corridor) loses 2, k18 (floor 5 corridor) loses 1
  s.players[0].tiles.push({ id: 'k5', ex: false }, { id: 'k18', ex: false });
  s = apply(s, { p: 0, type: 'buy', shop: 'adv', iid: s.shops.adv.row[0] });
  assert.deepEqual(s.players[0].tiles.map((t) => t.ex), [false, true]);
});

test('floor cards: Jackpot emeralds and Cave With No Ceiling', () => {
  let s = newGame();
  const p = s.players[0];
  s.floors[3].card = 'jackpot';
  p.floor = 2;
  p.drills = 4;
  s = apply(s, { p: 0, type: 'barrier' });
  assert.deepEqual(s.floors[3].jackpot, [true, true]);
  s = apply(s, { p: 0, type: 'collect', jackpot: true });
  assert.deepEqual(s.players[0].storage, ['emerald']);
  s = apply(s, { p: 0, type: 'endOps', opt: { exchange: 'emerald' } });
  assert.deepEqual(s.players[0].storage, ['ruby']);

  let t = newGame();
  t.floors[3].card = 'nocave';
  t.floors[3].cardUp = true;
  t.floors[3].barrier = false;
  t.players[0].floor = 3;
  t.players[0].moves = 2;
  t = apply(t, { p: 0, type: 'endOps', opt: { cave: 'emerald' } });
  assert.deepEqual(t.players[0].storage, ['emerald']);
});

// A simple greedy bot plays full games to make sure the engine never breaks and games end.
// check(s) runs in Upkeep, before the turn ends.
function botTurn(s, check) {
  const P = () => s.players[s.current];
  const tryAct = (a) => { try { s = apply(s, { ...a, p: s.current }); return true; } catch (e) { if (!(e instanceof GameError)) throw e; return false; } };
  for (const iid of [...P().hand]) {
    const c = cardDef(s, iid);
    if (!tryAct({ type: 'playMain', iid, floor: 0 })) tryAct({ type: 'playFuel', iid });
    if (c.ability && !c.ability.special) tryAct({ type: 'ability', iid });
  }
  for (const iid of P().perms) tryAct({ type: 'ability', iid });
  const dmgs = () => [...P().hand, ...P().discard].filter((x) => s.cards[x] === 'damage');
  while (P().turn.repairs > 0 && dmgs().length && tryAct({ type: 'repair', iid: dmgs()[0] }));
  let guard = 0;
  while (guard++ < 60) {
    const p = P();
    const fl = s.floors[p.floor];
    if (p.storage.length >= p.storageMax || (p.fuel < 3 && p.floor > 0)) {
      if (p.floor > 0 && (p.moves > 0 || tryAct({ type: 'default', kind: 'move' }))) { if (tryAct({ type: 'move', dir: -1 })) continue; }
      break;
    }
    if (tryAct({ type: 'barrier' })) continue;
    if (tryAct({ type: 'excavate' })) continue;
    if (tryAct({ type: 'collect', jackpot: true })) continue;
    const best = [...fl.minerals].sort((a, b) => D.MINERAL_POINTS[b] - D.MINERAL_POINTS[a])[0];
    if (best && tryAct({ type: 'collect', mineral: best })) continue;
    if (p.moves > 0 && tryAct({ type: 'move', dir: 1 })) continue;
    break;
  }
  P().tiles.forEach((_, i) => tryAct({ type: 'exhaust', index: i }));
  if (!tryAct({ type: 'endOps' })) tryAct({ type: 'endOps', opt: { chill: 'damage', squeeze: 'damage' } });
  if (s.phase === 'surface') {
    tryAct({ type: 'sell' });
    if (dmgs().length) tryAct({ type: 'repair', iid: dmgs()[0] });
    tryAct({ type: 'upStorage' });
    for (const shop of ['adv', 'drill', 'move', 'util']) for (const iid of [...s.shops[shop].row]) tryAct({ type: 'buy', shop, iid });
    tryAct({ type: 'refuel' });
    tryAct({ type: 'endSurface' });
  }
  check?.(s);
  const ok = tryAct({ type: 'endTurn', keep: [] });
  assert.ok(ok, 'endTurn should always be legal in upkeep');
  return s;
}

test('mine tiles can be exhausted while surfacing, to pay for cards', () => {
  let s = newGame();
  Object.assign(s.players[0], { floor: 2, drills: 2 });
  s = apply(s, { p: 0, type: 'excavate' });
  assert.equal(s.players[0].tiles[0].ex, false);

  const inOps = apply(s, { p: 0, type: 'exhaust', index: 0 });
  assert.equal(inOps.players[0].tiles[0].ex, true);

  // The rulebook (p. 9) allows exhausting during Surfacing too, usually to pay costs.
  s.players[0].floor = 0;
  let surfacing = apply(s, { p: 0, type: 'endOps', opt: {} });
  assert.equal(surfacing.phase, 'surface');
  const before = surfacing.players[0].credits;
  surfacing = apply(surfacing, { p: 0, type: 'exhaust', index: 0 });
  assert.equal(surfacing.players[0].tiles[0].ex, true);
  assert.ok(surfacing.players[0].credits > before || surfacing.players[0].fuel > 0);
});

test("floor card: Toys R' Rust repairs a card from any zone", () => {
  const base = newGame();
  base.floors[2].card = 'toys';
  base.floors[2].cardUp = true;
  Object.assign(base.players[0], { floor: 2, fuel: 5, storage: ['silver'] });

  // The rulebook allows hand, play area, discard pile and the top of the deck.
  for (const zone of ['hand', 'play', 'discard', 'deck']) {
    const s = structuredClone(base);
    const p = s.players[0];
    const iid = giveCard(s, 'damage'); // lands in hand
    if (zone !== 'hand') {
      p.hand = p.hand.filter((x) => x !== iid);
      if (zone === 'deck') p.deck.unshift(iid); else p[zone].push(iid);
    }
    const after = apply(s, { p: 0, type: 'endOps', opt: { toys: iid } });
    const q = after.players[0];
    assert.equal([...q.hand, ...q.play, ...q.discard, ...q.deck].includes(iid), false, `${zone} card should be repaired away`);
    assert.equal(q.fuel, 4);
    assert.deepEqual(q.storage, []);
    assert.equal(after.damagePile, s.damagePile + 1);
  }

  const s = structuredClone(base);
  expectError(() => apply(s, { p: 0, type: 'endOps', opt: { toys: s.players[1].hand[0] } })); // not your card
});

test('bot games run to completion without engine errors', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let s = newGame(seed);
    let turns = 0;
    while (!s.over && turns < 600) { s = botTurn(s); turns++; }
    assert.ok(s.over, `seed ${seed} did not finish in 600 turns`);
    assert.ok(Number.isFinite(s.scores[0].total));
  }
});

test('in bot games every turn replays, and each allowed undo leaves a turn that replays', () => {
  let undos = 0;
  const check = (s) => {
    const why = undoable(s);
    assert.ok(why, `turn ${s.turnNo}: the history should replay to the current state`);
    why.forEach((w, i) => {
      if (w !== null) return;
      const u = apply(s, { p: s.current, type: 'undo', move: i });
      assert.equal(u.history?.moves.length ?? 0, why.length - 1);
      if (undos++ % 10 === 0) assert.ok(undoable(u), `turn ${s.turnNo}: undoing move ${i + 1} should leave a turn that replays`);
    });
  };
  for (const seed of [1, 2]) {
    let s = newGame(seed);
    while (!s.over && s.turnNo < 600) s = botTurn(s, check);
  }
  assert.ok(undos > 100);
});
