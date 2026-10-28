'use strict';
// Runs the same coordinator and direct sockets as the Android worklet under Bare.
const DHT = require('hyperdht');
const crypto = require('hypercore-crypto');
const { Rendezvous } = require('./rendezvous.cjs');
const port = 40000 + (crypto.randomBytes(2)[0] * 256 + crypto.randomBytes(2)[1]) % 20000;
const bootstrap = DHT.bootstrapper(port, '127.0.0.1');
const options = { dht: { bootstrap: [port], firewalled: false }, topic: crypto.randomBytes(32),
  heartbeatInterval: 100, discoveryInterval: 250, electionDelay: 300, electionSettle: 500 };
const server = new Rendezvous({ ...options, coordinatorOnly: true, electionDelay: 0 });
const clients = [new Rendezvous(options), new Rendezvous(options)];
let checking = false, finished = false;
const received = [[], []];
const timer = setTimeout(() => { void finish(new Error('Bare rendezvous check timed out')); }, 25000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(timer);
  await Promise.all([server, ...clients].map(client => client.close())); await bootstrap.destroy();
  if (error) { console.error(error); Bare.exitCode = 1; }
  else console.log('Bare rendezvous election, temporary record release and direct game after coordinator shutdown passed');
}
async function check() {
  if (checking || !clients.every(client => client.pair)) return;
  checking = true;
  // Normal clients send a connection confirmation before leaving the lobby.
  await new Promise(resolve => setTimeout(resolve, 300));
  if (server.queue.players.size || server.queue.tickets.size) throw new Error('Completed introductions were retained');
  await server.close(); clients[0].send({ check: 'a-to-b' }); clients[1].send({ check: 'b-to-a' });
}
clients.forEach((client, index) => client.on('event', event => {
  if (event.type === 'paired') check().catch(finish);
  if (event.type === 'data') {
    received[index].push(event.body);
    if (received.every(values => values.length)) {
      if (received[0][0].check !== 'b-to-a' || received[1][0].check !== 'a-to-b') void finish(new Error('Invalid direct payload'));
      else void finish();
    }
  }
}));
bootstrap.fullyBootstrapped().then(async () => {
  server.start(); await new Promise(resolve => setTimeout(resolve, 500)); clients.forEach(client => client.start());
}).catch(finish);
