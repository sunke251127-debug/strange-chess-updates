'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startChessServer } = require('../server/server.cjs');

async function withServer(fn) {
  const server = await startChessServer({ host: '127.0.0.1', port: 0, quiet: true });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

test('detailed host info is local-only and never exposed through proxy/tunnel headers', async () => {
  await withServer(async server => {
    const local = await fetch(`http://127.0.0.1:${server.port}/api/info`);
    assert.equal(local.status, 200);
    const info = await local.json();
    assert.equal(info.isLocalHost, true);
    assert.equal(info.port, server.port);
    assert.ok(Array.isArray(info.lanUrls));

    for (const headers of [
      { 'cf-connecting-ip': '203.0.113.9' },
      { 'cf-ray': 'test-request' },
      { 'x-forwarded-for': '203.0.113.9' }
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/info`, { headers });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.deepEqual(body, { error: 'local host only' });
    }
  });
});

test('public health is minimal and only whitelisted board assets are served', async () => {
  await withServer(async server => {
    const healthResponse = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { 'cf-connecting-ip': '203.0.113.9' }
    });
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true });

    const checkResponse = await fetch(`http://127.0.0.1:${server.port}/src/check-detector.js`);
    assert.equal(checkResponse.status, 200);
    assert.match(checkResponse.headers.get('content-type') || '', /javascript/);
    assert.match(await checkResponse.text(), /detectChecks/);

    const listing = await fetch(`http://127.0.0.1:${server.port}/src/`, {
      headers: { 'cf-connecting-ip': '203.0.113.9' }
    });
    assert.equal(listing.status, 404);
    const packageJson = await fetch(`http://127.0.0.1:${server.port}/package.json`, {
      headers: { 'cf-connecting-ip': '203.0.113.9' }
    });
    assert.equal(packageJson.status, 404);
    const tools = await fetch(`http://127.0.0.1:${server.port}/tools/cloudflared-provenance.json`);
    assert.equal(tools.status, 404);
  });
});
