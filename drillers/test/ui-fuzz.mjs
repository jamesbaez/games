// Smoke test for js/ui.js without a browser: stub the few DOM/browser APIs the UI uses,
// start pass & play games, and click random enabled buttons. Random play can wander forever
// (e.g. never saving up drills for a barrier), so games past MAX_TURNS are abandoned.
// Fails on any non-GameError exception (reported by ui.js via console.error), a screen with
// no enabled buttons, or if no game at all reaches the game-over screen.
// Usage: node test/ui-fuzz.mjs [games=4] [seed=1] [maxTurns=2500]
const GAMES = Number(process.argv[2] || 4);
let seed = Number(process.argv[3] || 1);

let html = '';
let clickHandler = null;
const fields = { name: { value: 'Ann' }, p2: { value: 'Bob' }, code: { value: '' } };
const app = {
  set innerHTML(v) { html = v; },
  get innerHTML() { return html; },
  addEventListener(type, fn) { if (type === 'click') clickHandler = fn; },
};
globalThis.document = { getElementById: (id) => (id === 'app' ? app : fields[id] || null) };
const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.alert = () => {};
const errors = [];
console.error = (...a) => errors.push(a.map(String).join(' '));
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
Math.random = rnd; // ui.js seeds new games with Math.random; make runs reproducible

await import(new URL('../js/ui.js', import.meta.url));
const { trackUsed, trackLimit } = await import(new URL('../js/engine.js', import.meta.url));

// Summary of the in-progress local game (ui.js saves it to localStorage after every action).
function snapshot() {
  const s = JSON.parse(store['drillers.local'] || 'null');
  if (!s) return 'no saved game';
  return JSON.stringify({
    turnNo: s.turnNo, phase: s.phase, current: s.current, endBy: s.endBy,
    players: s.players.map((p) => ({ floor: p.floor, fuel: `${p.fuel}/${p.fuelMax}`, credits: p.credits,
      track: `${trackUsed(p)}/${trackLimit(p)}`, tiles: p.tiles.length, storage: p.storage.length,
      deck: p.deck.length, hand: p.hand.length, discard: p.discard.length })),
    barriers: s.floors.map((f) => f.barrier),
    corridorsLeft: s.floors.map((f) => f.corridors.length),
    log: s.log.slice(-8),
  }, null, 1);
}

const unesc = (x) => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const click = (dataset) => clickHandler({
  target: {
    closest: (sel) => (sel === '[data-act]'
      ? (dataset.act ? { disabled: false, dataset } : null)
      : (dataset.lobby ? { dataset } : null)),
  },
});
const MAX_TURNS = Number(process.argv[4] || 2500);
let games = 0;
let abandoned = 0;
let clicks = 0;
const newGame = () => { click({ lobby: 'leave' }); click({ lobby: 'local' }); };
click({ lobby: 'local' });
for (let i = 0; i < 1000000 && games + abandoned < GAMES && !errors.length; i++) {
  if (html.includes('data-lobby="reveal"')) { click({ lobby: 'reveal' }); continue; }
  if (html.includes('Game over')) { games++; newGame(); continue; }
  if (html.includes('<button class="secondary"  data-lobby="undo">') && rnd() < 0.1) { click({ lobby: 'undo' }); clicks++; continue; }
  if (clicks % 500 === 499 && JSON.parse(store['drillers.local']).turnNo > MAX_TURNS) {
    abandoned++;
    clicks++;
    newGame();
    continue;
  }
  const acts = [...html.matchAll(/<button class="[^"]*" +(disabled)? *data-act="([^"]*)"/g)]
    .filter((m) => !m[1]).map((m) => unesc(m[2]));
  if (!acts.length) {
    console.log('No enabled actions on screen:\n' + html.slice(0, 1500));
    process.exit(1);
  }
  let pick = acts[Math.floor(rnd() * acts.length)];
  // Occasionally force progress so games actually end.
  if (rnd() < 0.08) pick = acts.find((a) => /endOps|endSurface|endTurn/.test(a)) || pick;
  click({ act: pick });
  clicks++;
}

console.log(JSON.stringify({ games, abandoned, clicks, errors: errors.slice(0, 5) }));
if (games + abandoned < GAMES) console.log('Ran out of iterations mid-game:\n' + snapshot());
if (!errors.length && games === 0) console.log(`No errors, but no game reached game over within ${MAX_TURNS} turns. Random play can stall; try another seed or a higher maxTurns.`);
if (errors.length || games === 0) process.exit(1);
