// Приложение открывается без интернета: всё нужное лежит в кэше. Модель хранится отдельно (IndexedDB).
const VERSION = 'bn-4a861c9';
const FILES = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'fonts/onest.woff2', 'fonts/unbounded.woff2', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'whisper/whisper.js', 'whisper/whisper.wasm',
  'js/app.js', 'js/store.js', 'js/idb.js', 'js/texts.js', 'js/audio.js', 'js/rec.js', 'js/models.js', 'js/transcriber.js',
  'js/worker.js', 'js/wake.js', 'js/log.js', 'js/zip.js', 'js/icons.js', 'js/vendor/preact-htm.js',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
