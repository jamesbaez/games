// Online games live in a Firebase Realtime Database, used through its REST API (no SDK):
//   rooms/<CODE> = { seq, host, state? }
//     seq counts writes. The database rules (firebase.rules.json) only accept the next seq, so a
//     device that missed a move can't overwrite it. state is the engine state as a JSON string,
//     because the database would drop its empty arrays and nulls. It's missing until the second
//     player joins; host is the creator's name.
//   seen/<CODE>/<seat> = server time that seat last had the game on screen and in focus; removed when it leaves.
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

// Calls onRoom with the room now and after every change. EventSource retries dropped connections itself;
// call resume() when the page is shown again, in case the phone closed the stream while it slept.
export function watchRoom(code, { onRoom, onStatus }) {
  let es = null;
  let closed = false;
  const refresh = () => getRoom(code).then((room) => closed || onRoom(room), () => closed || onStatus('Offline, retrying…'));
  const open = () => {
    es?.close();
    const src = (es = new EventSource(dbUrl(`rooms/${code}`)));
    src.onopen = () => onStatus('Online');
    src.onerror = () => {
      if (closed) return;
      onStatus('Reconnecting…');
      if (src.readyState === EventSource.CLOSED) setTimeout(() => { if (!closed && es === src) open(); }, 5000);
    };
    src.addEventListener('put', (e) => {
      const { path, data } = JSON.parse(e.data);
      if (path === '/') onRoom(decode(data)); else refresh();
    });
    src.addEventListener('patch', refresh);
  };
  open();
  return {
    resume() { if (es.readyState === EventSource.CLOSED) open(); refresh(); },
    close() { closed = true; es.close(); },
  };
}

// here = true every 30 seconds while a seat has the game on screen and in focus, so its turn alerts
// are skipped; here = false as soon as it doesn't.
export const markSeen = (code, seat, here) => put(`seen/${code}/${seat}`, here ? { '.sv': 'timestamp' } : null, true).catch(() => {});

export const alertTopic = (code, seat) => `drillers-${code.toLowerCase()}-p${seat + 1}`;

// Sends a notification to a seat's ntfy topic, unless that seat has the game on screen.
export async function notify(code, seat, message, click) {
  try {
    const seen = await (await fetch(dbUrl(`seen/${code}/${seat}`))).json();
    if (typeof seen === 'number' && Date.now() - seen < SEEN_FRESH_MS) return;
    await fetch(`https://ntfy.sh/${alertTopic(code, seat)}?${new URLSearchParams({ title: 'Drillers', click, tags: 'pick' })}`, { method: 'POST', body: message });
  } catch {}
}
