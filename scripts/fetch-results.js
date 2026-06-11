/**
 * fetch-results.js — Prode 2026
 * Fetches live WC 2026 results from API-Football using stored apiFixtureId.
 * Run map-fixture-ids.js first to populate apiFixtureId on all fixtures.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;
const API_KEY = process.env.API_FOOTBALL_KEY;

if(!SA_JSON || !DB_URL || !API_KEY) {
  console.error('❌ Missing env vars');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

async function apiFetch(path) {
  const res = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if(data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }
  return data;
}

// Match window: WC matches run roughly 14:00-03:00 UTC
function isMatchWindow() {
  const hour = new Date().getUTCHours();
  return hour >= 14 || hour <= 4;
}

async function main() {
  console.log(`🕐 Starting fetch-results at ${new Date().toISOString()}`);

  if(!isMatchWindow()) {
    console.log('⏰ Outside match window — skipping');
    process.exit(0);
  }

  // Load Firebase fixtures (only ones with apiFixtureId mapped)
  const [fixturesSnap, resultsSnap] = await Promise.all([
    db.ref('fixtures').once('value'),
    db.ref('results').once('value')
  ]);
  const fixtures        = fixturesSnap.val() || {};
  const existingResults = resultsSnap.val() || {};

  // Build reverse map: apiFixtureId → Firebase fixture ID
  const apiIdToFid = {};
  for(const [fid, f] of Object.entries(fixtures)) {
    if(f.apiFixtureId) {
      apiIdToFid[f.apiFixtureId] = fid;
    }
  }
  const mappedCount = Object.keys(apiIdToFid).length;
  console.log(`📦 Firebase fixtures with apiFixtureId: ${mappedCount}/${Object.keys(fixtures).length}`);

  if(mappedCount === 0) {
    console.error('❌ No fixtures have apiFixtureId. Run map-fixture-ids.js first!');
    process.exit(1);
  }

  // Fetch today's WC 2026 fixtures from API-Football
  const today = new Date().toISOString().slice(0, 10);
  console.log(`📅 Fetching fixtures for: ${today}`);
  const data = await apiFetch(`/fixtures?league=1&season=2026&date=${today}&timezone=UTC`);
  let apiFixtures = data.response || [];

  // Also check yesterday for late-night matches
  if(new Date().getUTCHours() <= 4) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    console.log(`📅 Also checking yesterday: ${yesterday}`);
    const data2 = await apiFetch(`/fixtures?league=1&season=2026&date=${yesterday}&timezone=UTC`);
    apiFixtures = apiFixtures.concat(data2.response || []);
  }

  console.log(`📡 API returned ${apiFixtures.length} fixtures`);

  const liveStatuses = ['1H','HT','2H','ET','P','BT','LIVE'];
  const ftStatuses   = ['FT','AET','PEN'];
  let updated = 0, skipped = 0, noMap = 0;
  const updates = {};

  for(const apiFix of apiFixtures) {
    const apiId  = apiFix.fixture.id;
    const status = apiFix.fixture.status.short;
    const hg     = apiFix.goals.home;
    const ag     = apiFix.goals.away;

    const isLive     = liveStatuses.includes(status);
    const isFinished = ftStatuses.includes(status);

    if(!isLive && !isFinished) { skipped++; continue; }
    if(hg === null || ag === null) { skipped++; continue; }

    // Match by stored apiFixtureId
    const fid = apiIdToFid[apiId];
    if(!fid) {
      console.log(`  ⚠️  No Firebase match for API ID ${apiId}: ${apiFix.teams.home.name} vs ${apiFix.teams.away.name}`);
      noMap++;
      continue;
    }

    // Skip if identical
    const existing = existingResults[fid];
    if(existing &&
       existing.homeScore === hg &&
       existing.awayScore === ag &&
       existing.status    === status) {
      skipped++;
      continue;
    }

    updates[`results/${fid}`] = {
      homeScore:   hg,
      awayScore:   ag,
      status:      status,
      source:      'api-football',
      confirmedAt: Date.now(),
      isLive:      isLive && !isFinished,
      isFinal:     isFinished
    };

    if(isFinished) {
      updates[`fixtures/${fid}/status`] = 'FT';
    }

    const label = isFinished ? '✅ FT' : `🔴 LIVE(${status})`;
    console.log(`  ${label}: ${apiFix.teams.home.name} ${hg}-${ag} ${apiFix.teams.away.name}`);
    updated++;
  }

  if(Object.keys(updates).length > 0) {
    await db.ref().update(updates);
  }

  console.log(`\n📊 Done: ${updated} updated · ${skipped} skipped · ${noMap} unmapped`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
