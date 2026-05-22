/**
 * sw.js — Prode 2026 Service Worker
 * Handles Web Push notifications and offline caching.
 *
 * Place this file in the SAME directory as prode-player.html
 */

const CACHE_NAME = 'prode-2026-v1';
const CACHE_FILES = [
  './prode-player.html',
];

// ── INSTALL ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH — serve from cache, fallback to network ────────────────────────────
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── PUSH NOTIFICATION ─────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'Prode 2026', body: 'You have a new notification.' };
  try { data = e.data.json(); } catch(err) {
    try { data.body = e.data.text(); } catch(_) {}
  }

  const options = {
    body:    data.body || '',
    icon:    './icon-192.png',
    badge:   './icon-192.png',
    tag:     data.tag || 'prode-notif',
    data:    { url: data.url || './' },
    actions: data.actions || [],
    vibrate: [200, 100, 200],
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'Prode 2026', options)
  );
});

// ── NOTIFICATION CLICK ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      const match = cls.find(c => c.url.includes('prode-player'));
      if (match) return match.focus();
      return clients.openWindow(url);
    })
  );
});

// ── BACKGROUND SYNC (future use) ─────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-predictions') {
    // Future: sync offline predictions when back online
    console.log('[SW] Background sync:', e.tag);
  }
});
