// In-memory stand-in for the Firebase Realtime Database REST API, covering what js/net.js uses:
// GET (plain or as an event stream), PUT sent as POST ?x-http-method-override=PUT, print=silent,
// {".sv":"timestamp"}, and the rules in firebase.rules.json (hand-coded below).
// Set chaos.failWrite / chaos.dropStream (probabilities) to exercise failed saves and dropped connections.
import http from 'node:http';

const CODE = /^[A-Z]{8}$/;

function allowed(path, old, value) {
  const room = path.match(/^rooms\/([^/]+)$/);
  if (room) {
    if (value === null) return true;
    return CODE.test(room[1]) && typeof value.host === 'string' && typeof value.seq === 'number'
      && value.seq === (old ? old.seq + 1 : 0)
      && (value.state === undefined || (typeof value.state === 'string' && value.state.length < 200000));
  }
  const seen = path.match(/^seen\/([^/]+)\/[^/]+$/);
  return !!seen && CODE.test(seen[1]) && (value === null || typeof value === 'number');
}

export function fakeFirebase({ random = Math.random } = {}) {
  const chaos = { failWrite: 0, dropStream: 0 };
  const data = new Map(); // path -> value; only room and seen paths are ever stored
  const streams = new Map(); // path -> Set of open event-stream responses
  const readable = (path) => /^rooms\/[^/]+$|^seen\/[^/]+\/[^/]+$/.test(path);
  const event = (res, value) => res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: value })}\n\n`);
  const json = (res, status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.match(/^\/(.*)\.json$/)?.[1];
    const method = url.searchParams.get('x-http-method-override') || req.method;
    if (path === undefined) return json(res, 404, { error: 'not found' });
    if (method === 'GET') {
      if (!readable(path)) return json(res, 401, { error: 'Permission denied' });
      if (req.headers.accept !== 'text/event-stream') return json(res, 200, data.get(path) ?? null);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      event(res, data.get(path) ?? null);
      if (!streams.has(path)) streams.set(path, new Set());
      streams.get(path).add(res);
      req.on('close', () => streams.get(path).delete(res));
      return;
    }
    if (method !== 'PUT') return json(res, 405, { error: 'method not supported by the fake' });
    let body = '';
    for await (const chunk of req) body += chunk;
    if (random() < chaos.failWrite) return json(res, 503, { error: 'chaos' });
    let value = JSON.parse(body);
    if (value?.['.sv'] === 'timestamp') value = Date.now();
    if (!allowed(path, data.get(path), value)) return json(res, 401, { error: 'Permission denied' });
    if (value === null) data.delete(path); else data.set(path, value);
    for (const s of streams.get(path) || []) {
      if (random() < chaos.dropStream) s.end(); else event(s, value);
    }
    if (url.searchParams.get('print') === 'silent') res.writeHead(204).end(); else json(res, 200, value);
  });

  return {
    data,
    chaos,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => { for (const set of streams.values()) for (const s of set) s.end(); server.close(); },
  };
}
