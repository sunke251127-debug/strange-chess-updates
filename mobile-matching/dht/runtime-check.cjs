'use strict';
// Executes the real network stack in Bare, including the native UDP/crypto addons.
const DHT = require('hyperdht');
const crypto = require('hypercore-crypto');
const { Matchmaker } = require('./matchmaker.cjs');
const port = 40000 + (crypto.randomBytes(2)[0] * 256 + crypto.randomBytes(2)[1]) % 20000;
const bootstrap = DHT.bootstrapper(port, '127.0.0.1');
const options = { dht: { bootstrap: [port], firewalled: false }, heartbeatInterval: 100, discoveryInterval: 250 };
const clients = [new Matchmaker(options), new Matchmaker(options)];
let received = 0, sent = false, finished = false;
const timeout = setTimeout(() => finish(new Error('Bare DHT runtime check timed out')), 20000);
async function finish(error) {
  if (finished) return; finished = true; clearTimeout(timeout);
  await Promise.all(clients.map(client => client.close())); await bootstrap.destroy();
  if (error) { console.error(error); Bare.exitCode = 1; }
  else console.log('Bare native DHT discovery, exclusive pairing and encrypted bidirectional messages passed');
}
for (const client of clients) client.on('event', event => {
  if (event.type === 'paired' && !sent && clients.every(value => value.pair)) {
    sent = true;
    clients[0].send({ check: 'native-a' }); clients[1].send({ check: 'native-b' });
  } else if (event.type === 'data') {
    if (!['native-a', 'native-b'].includes(event.body?.check)) return void finish(new Error('Bad runtime response'));
    if (++received === 2) void finish();
  }
});
bootstrap.fullyBootstrapped().then(() => clients.forEach(client => client.start())).catch(finish);
