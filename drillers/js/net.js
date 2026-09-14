// Peer-to-peer transport via PeerJS (global `Peer` from the CDN script).
// The host is authoritative: guests send actions, the host sends back full state.
const PREFIX = 'drillers-v1-';

export function newCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  return Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
}

export function hostGame({ code, onHello, onAction, onStatus }) {
  const peer = new Peer(PREFIX + code);
  let conn = null;
  peer.on('open', () => onStatus(`Waiting for your friend — share code ${code}`));
  peer.on('connection', (c) => {
    if (conn && conn.open) conn.close();
    conn = c;
    c.on('open', () => onStatus('Friend connected'));
    c.on('data', (msg) => {
      if (msg?.t === 'hello') onHello(msg.name);
      else if (msg?.t === 'action') onAction(msg.action);
    });
    c.on('close', () => onStatus(`Friend disconnected — they can rejoin with code ${code}`));
  });
  peer.on('disconnected', () => {
    onStatus('Lost the connection broker, reconnecting…');
    setTimeout(() => !peer.destroyed && peer.reconnect(), 1500);
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') onStatus('That room code is still in use — wait a few seconds and reload.');
    else onStatus(`Connection problem (${e.type})`);
  });
  return {
    send: (msg) => { if (conn && conn.open) conn.send(msg); },
    destroy: () => peer.destroy(),
  };
}

export function joinGame({ code, name, onMessage, onStatus }) {
  const peer = new Peer();
  let conn = null;
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    onStatus(`Connecting to ${code}…`);
    conn = peer.connect(PREFIX + code, { reliable: true });
    conn.on('open', () => { onStatus('Connected'); conn.send({ t: 'hello', name }); });
    conn.on('data', onMessage);
    conn.on('close', () => { onStatus('Disconnected — retrying…'); setTimeout(connect, 2500); });
  };
  peer.on('open', connect);
  peer.on('disconnected', () => setTimeout(() => !peer.destroyed && peer.reconnect(), 1500));
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') {
      onStatus(`No game found for code ${code} yet — is the host's page open? Retrying…`);
      setTimeout(connect, 3000);
    } else onStatus(`Connection problem (${e.type})`);
  });
  return {
    send: (action) => { if (conn && conn.open) conn.send({ t: 'action', action }); else onStatus('Not connected yet.'); },
    destroy: () => { stopped = true; peer.destroy(); },
  };
}
