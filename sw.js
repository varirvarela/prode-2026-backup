/**
 * sw.js — Prode 2026 Service Worker v2
 * Strategy:
 *   - HTML files: Network first, fall back to cache (always gets latest)
 *   - Assets (JS libs, fonts, icons): Cache first (fast, stable)
 *   - Push notifications + offline fallback included
 */

const CACHE_NAME    = 'prode-2026-v2';
const CACHE_ASSETS  = [
  'https://cdn.jsdelivr.net/npm/firebase@9.23.0/firebase-app-compat.min.js',
  'https://cdn.jsdelivr.net/npm/firebase@9.23.0/firebase-database-compat.min.js',
];

// ── INSTALL ───────────────────────────────────────────────────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      // Only pre-cache CDN assets, not the HTML (always fetch fresh)
      return cache.addAll(CACHE_ASSETS).catch(function() {});
    })
  );
  self.skipWaiting(); // activate immediately
});

// ── ACTIVATE — clean up old caches ───────────────────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim(); // take control immediately
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // HTML files — NEVER serve from cache, always network
  if(e.request.destination === 'document' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .catch(() => caches.match(e.request)) // offline fallback only
    );
    return;
  }

  // CDN assets — cache first (fast)
  if(url.hostname.includes('jsdelivr') || url.hostname.includes('googleapis')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if(cached) return cached;
        return fetch(e.request).then(function(res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(c){ c.put(e.request, clone); });
          return res;
        });
      })
    );
    return;
  }

  // Everything else — network with cache fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── PUSH NOTIFICATION ─────────────────────────────────────────────────────────
self.addEventListener('push', function(e) {
  var data = { title: 'Prode 2026', body: 'You have a new notification.' };
  if(e.data) {
    try { data = e.data.json(); } catch(_) {
      try { var txt = e.data.text(); if(txt) data.body = txt; } catch(_) {}
    }
  }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Prode 2026', {
      body:    data.body || '',
      icon:    './icon-192.png',
      badge:   './icon-192.png',
      tag:     data.tag || 'prode-notif',
      data:    { url: data.url || './' },
      vibrate: [200, 100, 200],
    })
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(cls) {
      var match = cls.find(function(c){ return c.url.includes('prode-player'); });
      if(match) return match.focus();
      return clients.openWindow(url);
    })
  );
});

// ── FORCE ACTIVATE when told to skip waiting ──────────────────────────────────
self.addEventListener('message', function(e) {
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
