// Service worker sederhana: cache "kerangka" aplikasi agar cepat dibuka.
// Permintaan ke Apps Script (lintas domain, POST) TIDAK disentuh sama sekali.
const CACHE = 'lkb-v6';
const ASSETS = ['./', 'index.html', 'app.js', 'styles.css', 'vendor/sweetalert2.all.min.js',
                'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (req.method !== 'GET' || !sameOrigin) return; // biarkan API lewat apa adanya

  // Jaringan dulu (update kode langsung terlihat), cache sebagai cadangan offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html')))
  );
});
