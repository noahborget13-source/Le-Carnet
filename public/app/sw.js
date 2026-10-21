// Le Carnet — service worker (rend l'appli installable et accélère les chargements).
// Règles : on ne touche JAMAIS aux données (Supabase, /api) ; les pages sont toujours demandées au réseau d'abord,
// donc le mode maintenance et les mises à jour fonctionnent comme avant.
const VERSION = 'carnet-v1';
const LIBS = 'carnet-libs-v1';
const OFFLINE_HTML = '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Le Carnet — hors ligne</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14171C;color:#EDEBE3;font-family:system-ui,sans-serif;text-align:center;padding:24px}h1{font-family:Georgia,serif;font-weight:600;margin:0 0 10px}p{color:#9098A8;margin:0 0 22px}button{background:#5B6EF5;color:#fff;border:0;border-radius:9px;padding:11px 22px;font-size:15px;font-weight:600;cursor:pointer}</style></head><body><div><h1>Pas de connexion</h1><p>Le Carnet a besoin d\'internet pour afficher tes tâches.<br>Vérifie ta connexion puis réessaie.</p><button onclick="location.reload()">Réessayer</button></div></body></html>';

// Bibliothèques externes (versionnées) : mises en cache pour des ouvertures plus rapides.
const LIB_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [VERSION, LIBS];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pages de l'appli : réseau d'abord ; si pas d'internet, petit écran explicatif.
  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith(fetch(req).catch(() => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
    return;
  }

  // Bibliothèques : cache d'abord (rafraîchi en arrière-plan pour les polices).
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(LIBS);
      const hit = await cache.match(req);
      const refresh = fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(refresh); return hit; }
      return (await refresh) || Response.error();
    })());
    return;
  }

  // Icônes de l'appli : cache d'abord.
  if (url.origin === location.origin && url.pathname.startsWith('/icons/')) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
  }
  // Tout le reste (Supabase, /api, etc.) : on laisse passer sans y toucher.
});
