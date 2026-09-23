'use strict';

const CACHE_NAME = 'ledger-v1';
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './fonts/memomentKkukKkuk.woff2',
  './fonts/Pretendard-Regular.woff2',
  './fonts/Pretendard-SemiBold.woff2',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

async function refresh(request, cache) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (_) {
    return null;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (event.request.mode === 'navigate') {
      const cached = await cache.match('./index.html');
      const update = refresh(new Request('./index.html'), cache);
      event.waitUntil(update);
      return cached || update || Response.error();
    }
    const cached = await cache.match(event.request);
    const update = refresh(event.request, cache);
    event.waitUntil(update);
    return cached || update || Response.error();
  })());
});
