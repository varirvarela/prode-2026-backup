/**
 * send-push.js — Prode 2026
 * Sends Web Push notifications to all subscribed players.
 * Triggered by GitHub Actions when admin writes a new broadcast notification.
 * 
 * Requires:
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON (GitHub secret)
 *   FIREBASE_DATABASE_URL     — Firebase DB URL (GitHub secret)
 *   VAPID_PUBLIC_KEY          — VAPID public key (GitHub secret)
 *   VAPID_PRIVATE_KEY         — VAPID private key (GitHub secret)
 *   TOURNAMENT_ID             — Tournament ID (GitHub secret or env var)
 *   PUSH_MESSAGE              — Message to send (passed as env var from workflow)
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import webpush                  from 'web-push';

const SA_JSON       = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL        = process.env.FIREBASE_DATABASE_URL;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const PUSH_MESSAGE  = process.env.PUSH_MESSAGE || 'New notification from Prode 2026';

if(!SA_JSON || !DB_URL || !VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

webpush.setVapidDetails(
  'mailto:admin@prode2026.app',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

async function main() {
  console.log(`📣 send-push.js starting at ${new Date().toISOString()}`);
  console.log(`Message: "${PUSH_MESSAGE}"`);

  // Read push subscriptions from Firebase
  // Stored at tournaments/{tid}/pushSubscriptions/{uid}
  const tid = TOURNAMENT_ID;
  if(!tid) {
    console.error('❌ TOURNAMENT_ID not set');
    process.exit(1);
  }

  const subsSnap = await db.ref(`tournaments/${tid}/pushSubscriptions`).once('value');
  const subs = subsSnap.val() || {};
  const entries = Object.entries(subs);

  if(!entries.length) {
    console.log('ℹ️  No push subscriptions found — players need to enable notifications first');
    process.exit(0);
  }

  console.log(`📱 Found ${entries.length} push subscription(s)`);

  const payload = JSON.stringify({
    title: 'Prode 2026',
    body: PUSH_MESSAGE,
    icon: '/prode-2026-backup/icon-192.png',
    badge: '/prode-2026-backup/icon-192.png',
    data: { url: '/' }
  });

  let sent = 0;
  let failed = 0;
  const toDelete = [];

  for(const [uid, sub] of entries) {
    // sub is the PushSubscription object {endpoint, keys: {p256dh, auth}}
    if(!sub || !sub.endpoint) { failed++; continue; }
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
      console.log(`  ✅ Sent to ${uid}`);
    } catch(err) {
      if(err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired — remove it
        toDelete.push(uid);
        console.log(`  🗑️  Removed expired subscription for ${uid}`);
      } else {
        failed++;
        console.log(`  ❌ Failed for ${uid}: ${err.message}`);
      }
    }
  }

  // Clean up expired subscriptions
  if(toDelete.length) {
    const updates = {};
    toDelete.forEach(uid => { updates[`tournaments/${tid}/pushSubscriptions/${uid}`] = null; });
    await db.ref().update(updates);
  }

  console.log(`\n📊 Results: ${sent} sent, ${failed} failed, ${toDelete.length} expired`);
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
