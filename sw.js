/* RV Kitchen · Service Worker
   La aplicación completa (menú, fotos y logo) queda guardada en el
   dispositivo, así abre al instante y funciona sin internet.
   Las llamadas al servidor siempre intentan la red primero. */
const VERSION = 'rv-kitchen-v6';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-192.png', '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png', '/icons/favicon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL).catch(() => c.add('/index.html')))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Datos del servidor: siempre la red, nunca caché.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/.netlify')) {
    e.respondWith(fetch(req).catch(() => new Response('{"offline":true}', {
      status: 503, headers: { 'content-type': 'application/json' }
    })));
    return;
  }

  // La app de clientes (/pedir) y el panel (/admin) no usan la caché de la caja: siempre la red.
  if (url.pathname.startsWith('/pedir') || url.pathname.startsWith('/admin')) return;

  // Navegación: caché primero para arrancar rápido, y se refresca por detrás.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('/index.html').then((hit) => {
        const net = fetch(req).then((r) => {
          caches.open(VERSION).then((c) => c.put('/index.html', r.clone()));
          return r;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) caches.open(VERSION).then((c) => c.put(req, r.clone()));
      return r;
    }).catch(() => hit))
  );
});
