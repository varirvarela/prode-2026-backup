/**
 * backup.js — Prode 2026
 * Exports full Firebase Realtime Database snapshot to backups/YYYY-MM-DD.json
 * Run by GitHub Actions nightly at 03:00 UTC.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import { writeFileSync, mkdirSync } from 'fs';
import { join }                 from 'path';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;

if (!SA_JSON || !DB_URL) {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_DATABASE_URL');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

async function main() {
  console.log('📦 Starting backup...');
  const snap = await db.ref('/').once('value');
  const data = snap.val();

  if (!data) {
    console.log('⚠️  Database is empty — nothing to backup');
    process.exit(0);
  }

  // Write to backups/YYYY-MM-DD.json
  const date     = new Date().toISOString().slice(0, 10);
  const dir      = join(process.cwd(), '..', 'backups');
  const filepath = join(dir, `${date}.json`);

  mkdirSync(dir, { recursive: true });
  writeFileSync(filepath, JSON.stringify(data, null, 2));

  const size = (JSON.stringify(data).length / 1024).toFixed(1);
  console.log(`✅ Backup written: backups/${date}.json (${size} KB)`);

  // Keep last 30 days only — log count
  const { readdirSync } = await import('fs');
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  console.log(`📁 Total backups: ${files.length}`);
  if (files.length > 30) {
    console.log(`🗑  Oldest backup: ${files[0]} (consider cleaning up)`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Backup failed:', err);
  process.exit(1);
});
