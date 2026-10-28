'use strict';
const IPC = BareKit.IPC;
let current = null;
let generation = '';
let buffered = Buffer.alloc(0);

function output(id, event) {
  try { IPC.write(Buffer.from(JSON.stringify({ id, ...event }) + '\n')); } catch {}
}
function fail(error) {
  output(generation, { type: 'fatal', message: 'DHT 联机异常：' + String(error?.message || error).slice(0, 200) });
  const old = current; current = null;
  if (old) old.close().catch(() => {});
}
// An uncaught worklet exception must never abort the local chess app.
Bare.on('uncaughtException', fail);
Bare.on('unhandledRejection', fail);

async function command(value) {
  if (!value || !/^[A-Za-z0-9_-]{12,64}$/.test(value.id || '')) return;
  if (value.type === 'start') {
    const old = current;
    current = null; generation = value.id;
    if (old) await old.close();
    if (generation !== value.id) return;
    // Load native dependencies only after error handlers and the request id are
    // installed. A failed addon must report to Java, never abort the chess app.
    const { Rendezvous: Matchmaker } = require('./rendezvous.cjs');
    const match = new Matchmaker(); current = match;
    match.on('event', event => { if (current === match) output(value.id, event); });
    match.start();
  } else if (value.id === generation && value.type === 'send') {
    current?.send(value.body);
  } else if (value.id === generation && value.type === 'wake' && current) {
    const match = current;
    await match.wake();
  } else if (value.id === generation && value.type === 'stop') {
    const old = current; current = null; generation = '';
    if (old) await old.close();
  }
}
IPC.on('data', chunk => {
  try {
    buffered = Buffer.concat([buffered, chunk]);
    let end;
    while ((end = buffered.indexOf(10)) >= 0) {
      if (end > 70000) throw new Error('IPC 消息过大');
      const value = JSON.parse(buffered.subarray(0, end).toString('utf8'));
      buffered = buffered.subarray(end + 1);
      command(value).catch(error => { if (value.id === generation) fail(error); });
    }
    if (buffered.length > 70000) throw new Error('IPC 消息过大');
  } catch (error) { fail(error); }
});
