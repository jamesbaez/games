// Smoke test for js/ui.js without a browser: stub the few DOM/browser APIs the UI uses,
// start pass & play games, and click random enabled buttons. A game is exactly 4 rounds,
// so unlike Drillers every game must finish — there is nothing to abandon.
// Fails on any non-GameError exception (reported by ui.js via console.error), a screen
// with no enabled buttons, or if any game fails to reach the game-over screen.
// Usage: node test/ui-fuzz.mjs [games=4] [seed=1] [maxClicks=20000]
const GAMES = Number(process.argv[2] || 4);
let seed = Number(process.argv[3] || 1);
const MAX_CLICKS = Number(process.argv[4] || 20000);

// html is #app as a browser would show it: the game screen is a frame (see renderGame in
// ui.js) whose g-* parts are filled in separately.
let html = '';
let frame = '';
const parts = {};
const rebuild = () => { html = frame.replace(/id="(g-[a-z]+)"[^>]*>/g, (tag, id) => tag + (parts[id] || '')); };
const region = (id) => (frame.includes(`id="${id}"`) ? { set innerHTML(v) { parts[id] = v; rebuild(); } } : null);
let clickHandler = null;
const fields = { name: { value: 'Ann' }, p2: { value: 'Bob' }, code: { value: '' } };
const app = {
  set innerHTML(v) { frame = v; for (const k in parts) delete parts[k]; rebuild(); },
  get innerHTML() { return html; },
  addEventListener(type, fn) { if (type === 'click') clickHandler = fn; },
};
globalThis.document = {
  getElementById: (id) => (id === 'app' ? app : fields[id] || region(id)),
  addEventListener() {}, visibilityState: 'visible', hasFocus: () => true,
  createElement: () => ({ set innerHTML(v) {}, addEventListener() {}, set className(v) {} }),
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
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

function snapshot() {
  const s = JSON.parse(store['captains.local'] || 'null');
  if (!s) return 'no saved game';
  return JSON.stringify({
    round: s.round, current: s.current, over: s.over,
    pending: s.pending?.map((f) => f.k + (f.q ? ':' + f.q : '')),
    players: s.players.map((p) => ({
      at: p.at, ready: p.ready.join(''), queue: p.queue.join(''), medals: p.medals,
      done: p.done.length, passed: p.passed,
      techs: p.techSlots.filter((t) => t.tech).length,
    })),
    log: s.log.slice(-10),
  }, null, 1);
}

const unesc = (x) => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const click = (dataset) => clickHandler({
  target: {
    closest: (sel) => (sel === '[data-act]'
      ? (dataset.act ? { disabled: false, dataset } : null)
      : sel === '[data-img]' ? null
      : (dataset.lobby ? { dataset } : null)),
  },
});

let games = 0;
let clicks = 0;
// What the run actually exercised, so a "passing" fuzz that never plays isn't mistaken
// for coverage.
const seen = { missions: 0, techs: 0, fights: 0, events: 0, uprisings: 0 };
function tally() {
  const s = JSON.parse(store['captains.local'] || 'null');
  if (!s) return;
  seen.missions = Math.max(seen.missions, s.players.reduce((n, p) => n + p.done.length, 0));
  seen.techs = Math.max(seen.techs, s.players.reduce((n, p) => n + p.techSlots.filter((t) => t.tech).length, 0));
  seen.fights += s.log.filter((l) => l.includes('takes on the pirate')).length && 0;
  seen.events = Math.max(seen.events, s.eventsDone);
  seen.uprisings = Math.max(seen.uprisings, s.log.filter((l) => l.includes('uprising')).length);
}
const newGame = () => { click({ lobby: 'leave' }); click({ lobby: 'local' }); };
click({ lobby: 'local' });

for (; clicks < MAX_CLICKS && games < GAMES && !errors.length; clicks++) {
  if (html.includes('data-lobby="reveal"')) { click({ lobby: 'reveal' }); continue; }
  if (html.includes('Game over')) { games++; tally(); newGame(); continue; }

  // Buttons that take a game action, and the lobby-style buttons the mission flow uses.
  const acts = [...html.matchAll(/<button[^>]*?data-act='([^']*)'/g)]
    .filter((m) => !/\sdisabled/.test(m[0])).map((m) => unesc(m[1]));
  const crew = [...html.matchAll(/data-lobby="(assign|pickCrew)"(?:\s+data-(?:id|fig)="([^"]*)")?/g)];

  if (!acts.length && !crew.length) {
    console.log('No enabled actions on screen:\n' + html.slice(0, 2000) + '\n' + snapshot());
    process.exit(1);
  }
  // Take a mission when one is offered, often enough to exercise that path.
  if (crew.length && (!acts.length || rnd() < 0.5)) {
    const m = crew[Math.floor(rnd() * crew.length)];
    click(m[1] === 'assign' ? { lobby: 'assign', id: m[2] } : { lobby: 'pickCrew', fig: m[2] });
    continue;
  }
  // Passing ends a player's whole round, so pick it rarely; end-of-turn is nudged instead.
  // Head for a mission when one is on offer, so missions actually get played.
  const toMission = acts.filter((a) => {
    const j = JSON.parse(a);
    return j.type === 'choose' && typeof j.opt === 'string' && !!JSON.parse(store['captains.local'] || '{}').missions?.[j.opt];
  });
  if (toMission.length && rnd() < 0.6) { click({ act: toMission[Math.floor(rnd() * toMission.length)] }); continue; }
  // Undo is clicked sparingly: taken every time it is offered, turns never finish.
  const undos = acts.filter((a) => /"undo"/.test(a));
  if (undos.length && rnd() < 0.08) { click({ act: undos[Math.floor(rnd() * undos.length)] }); continue; }
  // Passing ends a player's whole round, so pick it rarely.
  const quiet = acts.filter((a) => !/"pass"|"undo"/.test(a));
  const pool = quiet.length && rnd() < 0.93 ? quiet : acts;
  let pick = pool[Math.floor(rnd() * pool.length)];
  if (rnd() < 0.3) pick = acts.find((a) => /"endTurn"/.test(a)) || pick;
  click({ act: pick });
}

console.log(JSON.stringify({ games, clicks, errors: errors.slice(0, 5), ...seen }));
if (games < GAMES) console.log('Did not finish every game:\n' + snapshot());
if (errors.length || games < GAMES) process.exit(1);
