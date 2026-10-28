'use strict';
const CONFIG = /*__CONFIG__*/;
const CACHE = 'strange-chess-mobile-' + CONFIG.build;
const PREFIX = 'strange-chess-mobile-';
const PATHS = new Set(CONFIG.files.map(f => f.url));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Build a complete immutable bundle. A failed install never touches the active cache.
    const cache = await caches.open(CACHE);
    try {
      for (const file of CONFIG.files) {
        const response = await fetch(file.url + '?build=' + CONFIG.build, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('Incomplete bundle: ' + file.url);
        const bytes = await response.clone().arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        if (hash !== file.hash) throw new Error('Bundle integrity: ' + file.url);
        await cache.put(file.url, response);
      }
    } catch (error) { await caches.delete(CACHE); throw error; }
    // Deliberately wait for every old tab to close. No skipWaiting during a game.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Default activation runs only after every old controlled tab has gone away.
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'BUILD') event.ports[0]?.postMessage({ build: CONFIG.build, version: CONFIG.version });
});

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  const key = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html') ? '/' : url.pathname;
  if (!PATHS.has(key)) return;
  // Serve this worker's complete version, even when a newer worker is waiting.
  event.respondWith(caches.open(CACHE).then(cache => cache.match(key)).then(response => response || Response.error()));
});
