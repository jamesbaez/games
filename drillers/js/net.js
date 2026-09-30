// Online games live in a Firebase Realtime Database, used through its REST API (no SDK):
//   rooms/<CODE> = { seq, host, state? }
//     seq counts writes. The database rules (firebase.rules.json) only accept the next seq, so a
//     device that missed a move can't overwrite it. state is the engine state as a JSON string,
//     because the database would drop its empty arrays and nulls. It's missing until the second
//     player joins; host is the creator's name.
//   seen/<CODE>/<seat> = server time that seat last had the game on screen and in focus; removed when it leaves.
//   chat/<CODE>/<id> = { seat, text }, one per chat message. The database picks the ids, which sort by time.
// Turn alerts go to ntfy.sh, one topic per room and seat.
const DB_URL = 'https://drillers-6dbe9-default-rtdb.firebaseio.com'; // see README.md
const DB = (new URLSearchParams(globalThis.location?.search).get('db') || DB_URL).replace(/\/+$/, ''); // ?db= for local testing
export const onlineReady = !!DB;
const SEEN_FRESH_MS = 45000; // a present device refreshes seen every 30 seconds

const dbUrl = (path, query = '') => `${DB}/${path}.json${query}`;

// Saved game <-> URL-safe text (gzip + base64url), for "move to another device" links.
export async function packSave(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function unpackSave(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const stream = new Blob([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export function newCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  return Array.from({ length: 8 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

// A POST with a method override is a "simple" cross-origin request, so browsers skip the CORS preflight.
// Resolves true once written, false if the database rules refused it; rejects when offline.
// keepalive lets a write finish while the page is being hidden.
async function put(path, value, keepalive = false) {
  const res = await fetch(dbUrl(path, '?x-http-method-override=PUT&print=silent'), { method: 'POST', body: JSON.stringify(value), keepalive });
  if (res.ok || res.status === 401) return res.ok;
  throw new Error(`database error ${res.status}`);
}

const decode = (room) => room && { ...room, state: room.state ? JSON.parse(room.state) : null };

export async function getRoom(code) {
  const res = await fetch(dbUrl(`rooms/${code}`));
  if (!res.ok) throw new Error(`database error ${res.status}`);
  return decode(await res.json());
}

export const writeRoom = (code, { seq, host, state }) =>
  put(`rooms/${code}`, state ? { seq, host, state: JSON.stringify(state) } : { seq, host });

export async function createRoom(host) {
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    if (await writeRoom(code, { seq: 0, host })) return code;
  }
  throw new Error('the database refused the new game');
}

// Keeps an EventSource open on path and passes its events to onEvent(type, { path, data }).
// EventSource retries dropped connections itself; resume() reopens one the phone closed while it slept.
function stream(path, onEvent, onStatus) {
  let es = null;
  let closed = false;
  const open = () => {
    es?.close();
    const src = (es = new EventSource(dbUrl(path)));
    src.onopen = () => onStatus('Online');
    src.onerror = () => {
      if (closed) return;
      onStatus('Reconnecting…');
      if (src.readyState === EventSource.CLOSED) setTimeout(() => { if (!closed && es === src) open(); }, 5000);
    };
    for (const type of ['put', 'patch']) src.addEventListener(type, (e) => onEvent(type, JSON.parse(e.data)));
  };
  open();
  return {
    resume() { if (es.readyState === EventSource.CLOSED) open(); },
    close() { closed = true; es.close(); },
  };
}

// Calls onRoom with the room now and after every change, and onChat with the game's chat messages
// ([{ id, seat, text }], oldest first) now and after every new one.
// Call resume() when the page is shown again, in case the phone closed the streams while it slept.
export function watchRoom(code, { onRoom, onChat, onStatus }) {
  let closed = false;
  const refresh = () => getRoom(code).then((room) => closed || onRoom(room), () => closed || onStatus('Offline, retrying…'));
  const room = stream(`rooms/${code}`, (type, { path, data }) => {
    if (type === 'put' && path === '/') onRoom(decode(data)); else refresh();
  }, onStatus);
  let msgs = {};
  const chat = stream(`chat/${code}`, (type, { path, data }) => {
    if (type === 'put' && path === '/') msgs = { ...data };
    else msgs = { ...msgs, ...(path === '/' ? data : { [path.split('/')[1]]: data }) }; // messages are written whole
    onChat(Object.keys(msgs).sort().filter((id) => typeof msgs[id]?.text === 'string').map((id) => ({ id, ...msgs[id] })));
  }, () => {});
  return {
    resume() { room.resume(); chat.resume(); refresh(); },
    close() { closed = true; room.close(); chat.close(); },
  };
}

// Adds a message to a game's chat. A plain POST is the REST API's "push": the database picks the id.
export async function postChat(code, seat, text) {
  const res = await fetch(dbUrl(`chat/${code}`, '?print=silent'), { method: 'POST', body: JSON.stringify({ seat, text }) });
  if (!res.ok) throw new Error(`database error ${res.status}`);
}

// here = true every 30 seconds while a seat has the game on screen and in focus, so its turn alerts
// are skipped; here = false as soon as it doesn't.
export const markSeen = (code, seat, here) => put(`seen/${code}/${seat}`, here ? { '.sv': 'timestamp' } : null, true).catch(() => {});

export const alertTopic = (code, seat) => `drillers-${code.toLowerCase()}-p${seat + 1}`;

// Sends a notification to a seat's ntfy topic, unless that seat has the game on screen.
export async function notify(code, seat, message, click, tags = 'pick') {
  try {
    const seen = await (await fetch(dbUrl(`seen/${code}/${seat}`))).json();
    if (typeof seen === 'number' && Date.now() - seen < SEEN_FRESH_MS) return;
    await fetch(`https://ntfy.sh/${alertTopic(code, seat)}?${new URLSearchParams({ title: 'Drillers', click, tags })}`, { method: 'POST', body: message });
  } catch {}
}
