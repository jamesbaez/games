// Online smoke test: three copies of js/ui.js, each in its own worker thread with stubbed browser APIs,
// play one online game through test/fake-firebase.mjs by clicking random buttons:
//   Ann creates the game, Bob joins it, and Ann's "laptop" joins as Ann too, so both of Ann's
//   devices click during her turns and fight over saves. The fake database also fails some writes
//   and drops live connections. Every device also sends the odd chat message. Bob's page counts as
//   hidden, so turn and chat alerts go to him only. At the end every page is hidden, which must clear its presence.
// Fails on runtime errors, alerts, too little progress, alerts sent to the wrong seat, devices
// that disagree about the game or the chat once the clicking stops, presence left behind by hidden pages,
// or database rules that allow a stale save or a bad chat message.
// Usage: node test/online-fuzz.mjs [seconds=8] [dbUrl]  (a dbUrl runs against a real database, without chaos)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (isMainThread) {
  const SECONDS = Number(process.argv[2] || 8);
  let db = process.argv[3];
  let fake = null;
  if (!db) {
    const { fakeFirebase } = await import('./fake-firebase.mjs');
    fake = fakeFirebase();
    db = await fake.listen();
  }
  // Every worker gets its listener at spawn time: a device can finish its clicking before
  // the main thread would otherwise have subscribed, and a lost 'settling' deadlocks the run.
  const inbox = {};
  const waiters = {};
  const take = (key, field) => new Promise((resolve) => {
    const got = inbox[key]?.[field];
    if (got !== undefined) resolve(got);
    else (waiters[key] ??= {})[field] = resolve;
  });
  let settling = 0;
  const workers = {};
  const spawn = (key, role, name, hidden = false) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { role, name, hidden, db, seconds: SECONDS } });
    workers[key] = w;
    inbox[key] = {};
    w.on('message', (m) => {
      for (const field of ['code', 'joined', 'report']) {
        if (m[field] === undefined) continue;
        inbox[key][field] = m[field];
        waiters[key]?.[field]?.(m[field]);
      }
      if (m.settling) {
        if (fake) Object.assign(fake.chaos, { failWrite: 0, dropStream: 0 }); // let the final writes through
        // Compare views only once every device has stopped clicking.
        if (++settling === 3) for (const other of Object.values(workers)) other.postMessage({ settle: true });
      }
    });
    w.on('error', (e) => { console.log(`${key} crashed: ${e.stack || e}`); process.exit(1); });
    return w;
  };

  spawn('ann', 'create', 'Ann');
  const code = await take('ann', 'code');
  spawn('bob', 'join', 'Bob', true).postMessage({ code });
  await take('bob', 'joined'); // so the laptop can pick a seat
  spawn('laptop', 'seat0', 'Ann').postMessage({ code });
  await sleep(1000);
  if (fake) Object.assign(fake.chaos, { failWrite: 0.02, dropStream: 0.01 }); // once everyone has joined
  const reports = Object.fromEntries(await Promise.all(
    Object.keys(workers).map(async (k) => [k, await take(k, 'report')])));
  for (const w of Object.values(workers)) await w.terminate();
  const room = await (await fetch(`${db}/captains/rooms/${code}.json`)).json();
  const state = JSON.parse(room.state);
  const problems = [];
  for (const seat of [0, 1]) {
    const seen = await (await fetch(`${db}/captains/seen/${code}/${seat}.json`)).json();
    if (seen !== null) problems.push(`seat ${seat} still counts as on screen after every page was hidden (${seen})`);
  }
  // The database rules must refuse a stale save and must not let anyone list the games.
  const stale = await fetch(`${db}/captains/rooms/${code}.json?x-http-method-override=PUT&print=silent`, { method: 'POST', body: JSON.stringify({ seq: room.seq, host: room.host }) });
  if (stale.status !== 401) problems.push(`a stale save got status ${stale.status}, expected 401`);
  const list = await fetch(`${db}/captains/rooms.json`);
  if (list.status !== 401) problems.push(`listing all games got status ${list.status}, expected 401`);
  const chats = await fetch(`${db}/captains/chat.json`);
  if (chats.status !== 401) problems.push(`listing all chats got status ${chats.status}, expected 401`);
  const badChat = await fetch(`${db}/captains/chat/${code}.json`, { method: 'POST', body: JSON.stringify({ seat: 0, text: '' }) });
  if (badChat.status !== 401) problems.push(`an empty chat message got status ${badChat.status}, expected 401`);
  const chat = Object.values(await (await fetch(`${db}/captains/chat/${code}.json`)).json() || {});
  for (const [k, r] of Object.entries(reports)) {
    if (r.errors.length) problems.push(`${k}: errors ${r.errors.slice(0, 3).join(' | ')}`);
    if (r.alerts.length) problems.push(`${k}: alert() ${r.alerts.join(' | ')}`);
    if (!r.view) problems.push(`${k}: never reached the game screen`);
  }
  const views = Object.values(reports).map((r) => r.view);
  if (new Set(views).size !== 1) problems.push('devices disagree:\n' + Object.entries(reports).map(([k, r]) => `--- ${k}\n${r.view}`).join('\n'));
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const lastLog = esc(state.log.at(-1));
  if (!views[0]?.includes(lastLog)) problems.push(`devices don't show the saved game's last log line: ${state.log.at(-1)}`);
  if (!chat.length) problems.push('no chat messages were saved');
  else if (!views[0]?.includes(`</b> ${esc(chat.at(-1).text)}</div>`)) problems.push(`devices don't show the last chat message: ${chat.at(-1).text}`);
  fake?.close();
  if (!fake) { // leave a real database as it was
    for (const path of [`captains/rooms/${code}`, `captains/seen/${code}/0`, `captains/seen/${code}/1`, `captains/chat/${code}`]) await fetch(`${db}/${path}.json?x-http-method-override=DELETE`, { method: 'POST' });
  }
  const pings = Object.values(reports).flatMap((r) => r.pings);
  if (pings.some((p) => !p.endsWith(`-p2`))) problems.push(`alert sent to a seat that had the game on screen: ${pings.join(', ')}`);
  if (!pings.length) problems.push('no turn alerts were sent to Bob');
  // A game is only 4 rounds, so it can legitimately finish before the clock runs out.
  if (!state.over && room.seq < (fake ? 60 : 15)) problems.push(`only ${room.seq} saves`);
  console.log(JSON.stringify({ code, saves: room.seq, round: state.round, over: state.over, chat: chat.length, clicks: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, r.clicks])), reloads: Object.fromEntries(Object.entries(reports).map(([k, r]) => [k, r.reloads])), pings: pings.length }));
  if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
  process.exit(0);
}

// ---------- worker: one device ----------
const { role, name, hidden, db, seconds } = workerData;
let seed = [...role].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 2147483647;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
Math.random = rnd;

// html is #app as a browser would show it: the game screen is a frame (see renderGame in ui.js)
// whose g-* parts are filled in separately.
let html = '';
let frame = '';
const parts = {};
const rebuild = () => { html = frame.replace(/id="(g-[a-z]+)"[^>]*>/g, (tag, id) => tag + (parts[id] || '')); };
const region = (id) => (frame.includes(`id="${id}"`) ? { set innerHTML(v) { parts[id] = v; rebuild(); } } : null);
let clickHandler = null;
let submitHandler = null;
let visibilityHandler = null;
const fields = { name: { value: name }, p2: { value: '' }, code: { value: '' }, 'chat-text': { value: '' } };
const app = {
  set innerHTML(v) { frame = v; for (const k in parts) delete parts[k]; rebuild(); },
  get innerHTML() { return html; },
  addEventListener(type, fn) { if (type === 'click') clickHandler = fn; if (type === 'submit') submitHandler = fn; },
};
globalThis.document = {
  getElementById: (id) => (id === 'app' ? app : fields[id] || region(id)),
  addEventListener: (type, fn) => { if (type === 'visibilitychange') visibilityHandler = fn; },
  visibilityState: hidden ? 'hidden' : 'visible',
  hasFocus: () => document.visibilityState === 'visible',
  createElement: () => ({ addEventListener() {} }),
  body: { appendChild() {} },
};
globalThis.addEventListener = () => {};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.location = { search: `?db=${encodeURIComponent(db)}`, hash: '', origin: 'http://test', pathname: '/starship-captains/' };
globalThis.history = { replaceState() {} };
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
const alerts = [];
globalThis.alert = (m) => alerts.push(m);
const errors = [];
console.error = (...a) => errors.push(a.map(String).join(' '));
console.warn = (...a) => errors.push('warn: ' + a.map(String).join(' '));

const pings = [];
const realFetch = fetch;
globalThis.fetch = (url, opts) => {
  if (String(url).startsWith('https://ntfy.sh/')) { pings.push(String(url).split('?')[0]); return Promise.resolve(new Response('')); }
  return realFetch(url, opts);
};

// Minimal EventSource over fetch. Unlike a browser's, it never retries by itself; js/net.js does.
globalThis.EventSource = class {
  static CLOSED = 2;
  constructor(url) {
    this.readyState = 0;
    this.listeners = {};
    this.ctrl = new AbortController();
    this.run(url);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { this.readyState = 2; this.ctrl.abort(); }
  async run(url) {
    try {
      const res = await realFetch(url, { headers: { Accept: 'text/event-stream' }, signal: this.ctrl.signal });
      if (!res.ok) throw new Error(`status ${res.status}`);
      this.readyState = 1;
      this.onopen?.();
      let buf = '';
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const msg = buf.slice(0, i);
          const type = msg.match(/^event: (.*)$/m)?.[1];
          const data = msg.match(/^data: (.*)$/m)?.[1];
          for (const fn of this.listeners[type] || []) fn({ data });
        }
      }
    } catch {}
    if (this.readyState !== 2) { this.readyState = 2; this.onerror?.(); }
  }
};

await import(new URL('../js/ui.js', import.meta.url));

const unesc = (x) => x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const click = (dataset) => clickHandler({
  target: { closest: (sel) => (sel === '[data-act]' ? (dataset.act ? { disabled: false, dataset } : null) : sel === '[data-img]' ? null : (dataset.lobby ? { dataset } : null)) },
});
const waitFor = async (text) => { for (let i = 0; i < 1000 && !html.includes(text); i++) await sleep(10); return html.includes(text); };

if (role === 'create') {
  click({ lobby: 'create' });
  if (!await waitFor('class="bigcode"')) {
    throw new Error('never reached the game-code screen. errors=' + JSON.stringify(errors.slice(0, 3))
      + ' alerts=' + JSON.stringify(alerts) + ' html=' + html.slice(0, 400));
  }
  parentPort.postMessage({ code: html.match(/class="bigcode">([A-Z]+)</)[1] });
} else {
  const { code } = await new Promise((resolve) => parentPort.once('message', resolve));
  fields.code.value = code;
  click({ lobby: 'join' });
  if (role === 'join') { await waitFor('data-lobby="joinSeat"'); click({ lobby: 'joinSeat' }); }
  else { await waitFor('data-lobby="seat"'); click({ lobby: 'seat', seat: '0' }); }
}
if (!await waitFor('class="turn')) {
  throw new Error(`${role} never reached the game screen. errors=${JSON.stringify(errors.slice(0, 3))} `
    + `alerts=${JSON.stringify(alerts)} html=${html.slice(0, 500)}`);
}
parentPort.postMessage({ joined: true });

let clicks = 0;
let chats = 0;
let reloads = 0;
let reloadShown = false;
const end = Date.now() + seconds * 1000;
while (Date.now() < end && !html.includes('Game over')) {
  await sleep(rnd() * 4);
  if (html.includes('did not save') && !reloadShown) reloads++;
  reloadShown = html.includes('did not save');
  if (html.includes('id="chat-text"') && rnd() < 0.02) {
    fields['chat-text'].value = `${role} says <hi> & ${++chats}`;
    submitHandler({ preventDefault() {} });
    continue;
  }
  const acts = [...html.matchAll(/<button[^>]*?data-act='([^']*)'/g)]
    .filter((m) => !/\sdisabled/.test(m[0])).map((m) => unesc(m[1]));
  // Taking a mission is two lobby-style clicks: pick the mission, then crew per line.
  const crew = [...html.matchAll(/data-lobby="(assign|pickCrew)"(?:\s+data-(?:id|fig)="([^"]*)")?/g)];
  if (crew.length && (!acts.length || rnd() < 0.4)) {
    const m = crew[Math.floor(rnd() * crew.length)];
    click(m[1] === 'assign' ? { lobby: 'assign', id: m[2] } : { lobby: 'pickCrew', fig: m[2] });
    clicks++;
    continue;
  }
  if (!acts.length) continue;
  const undos = acts.filter((a) => /"undo"/.test(a)); // clicked sparingly, or turns never finish
  if (undos.length && rnd() < 0.08) { click({ act: undos[Math.floor(rnd() * undos.length)] }); clicks++; continue; }
  const quiet = acts.filter((a) => !/"pass"|"undo"/.test(a));
  const pool = quiet.length && rnd() < 0.93 ? quiet : acts;
  let pick = pool[Math.floor(rnd() * pool.length)];
  if (rnd() < 0.2) pick = acts.find((a) => /"endTurn"/.test(a)) || pick;
  click({ act: pick });
  clicks++;
}

// Let saves finish, reconnect any dropped stream as if the page were shown again, then compare views.
parentPort.postMessage({ settling: true });
await new Promise((resolve) => parentPort.once('message', resolve)); // every device has stopped
await sleep(1000);
document.visibilityState = 'visible';
visibilityHandler?.();
await sleep(1500);
const part = (re) => html.match(re)?.[0] || '';
const view = html.includes('class="turn') || html.includes('Game over')
  ? [part(/<div class="turn[^>]*>.*?<\/div>/).replace(/class="turn[^"]*"/, 'class="turn"').replace(' (you)', ''), part(/<h2>Game over.*?<\/section>/s), part(/<div class="log">.*?<\/div><\/div>/s), part(/<div class="chat-log">.*?<\/div><\/div>/s).replace(/<div class="(me)?">/g, '<div>'), part(/<summary>Current score estimate<\/summary>.*?<\/table>/s)].join('\n')
  : '';
document.visibilityState = 'hidden';
visibilityHandler?.();
await sleep(500);
parentPort.postMessage({ report: { clicks, reloads, errors, alerts, pings, view } });
