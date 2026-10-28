'use strict';
const { WebSocketServer } = require('ws');

// A real MQTT-over-WebSocket endpoint with controllable transport failures.
// It never inspects or decrypts game payloads.
async function faultBroker() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wss.once('listening', resolve));
  const subscriptions = new Map(), blocked = new Set(), blackholes = new Set(), muted = new Set(), published = [];
  let connections = 0;
  const role = topic => topic?.endsWith('/host') ? 'host' : 'guest';
  wss.on('connection', ws => {
    connections++;
    ws.on('message', data => {
      if (blackholes.has(ws)) return;
      const bytes = Buffer.from(data); let at = 1, size = 0, factor = 1, digit;
      do { digit = bytes[at++]; size += (digit & 127) * factor; factor *= 128; } while (digit & 128);
      const body = bytes.subarray(at, at + size), type = bytes[0] >> 4;
      if (type === 1) ws.send(Buffer.from([0x20, 2, 0, 0]));
      else if (type === 8) {
        const length = body.readUInt16BE(2), topic = body.subarray(4, 4 + length).toString();
        if (blocked.has(role(topic))) { ws.terminate(); return; }
        subscriptions.set(ws, topic); ws.send(Buffer.from([0x90, 3, body[0], body[1], 0]));
      } else if (type === 3) {
        published.push(bytes);
        const length = body.readUInt16BE(0), topic = body.subarray(2, 2 + length).toString();
        for (const [target, subscription] of subscriptions) if (subscription === topic && target.readyState === 1 && !muted.has(role(topic)) && !blackholes.has(target)) {
          target.send(bytes); target.send(bytes); // Delivery may repeat after a reconnect.
        }
      } else if (type === 12) ws.send(Buffer.from([0xd0, 0]));
    });
    ws.on('close', () => { subscriptions.delete(ws); blackholes.delete(ws); });
    ws.on('error', () => {});
  });
  return {
    url: 'ws://127.0.0.1:' + wss.address().port, published,
    get connections() { return connections; },
    block(who) { blocked.add(who); for (const [ws, topic] of subscriptions) if (role(topic) === who) ws.terminate(); },
    unblock(who) { blocked.delete(who); },
    mute(who) { muted.add(who); }, unmute(who) { muted.delete(who); },
    drop() { for (const ws of wss.clients) ws.terminate(); },
    blackhole() { for (const ws of wss.clients) blackholes.add(ws); },
    async close() { for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); }
  };
}
module.exports = { faultBroker };
