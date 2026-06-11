/**
 * fetch-results.js — Prode 2026
 * Fetches WC 2026 results from football-data.org.
 * Runs every 5 minutes via GitHub Actions during match windows.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;
const FDO_KEY = process.env.FDO_KEY;

if(!SA_JSON || !DB_URL) { console.error('❌ Missing env vars'); process.exit(1); }
if(!FDO_KEY) { console.error('❌ Missing FDO_KEY'); process.exit(1); }

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

async function fdoFetch(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': FDO_KEY }
  });
  if(!res.ok) throw new Error(`HTTP ${res.status} from football-data.org`);
  return res.json();
}

function isMatchWindow() {
  const hour = new Date().getUTCHours();
  return hour >= 14 || hour <= 4;
}

async function main() {
  console.log(`🕐 Starting fetch-results at ${new Date().toISOString()}`);

  if(!isMatchWindow()) {
    console.log('Outside match window — skipping');
    process.exit(0);
  }

  const fixturesSnap = await db.ref('fixtures').once('value');
  const fixtures = fixturesSnap.val() || {};

  const apiIdToFid = {};
  for(const [fid, f] of Object.entries(fixtures)) {
    if(f.apiFixtureId) apiIdToFid[f.apiFixtureId] = fid;
  }

  const mappedCount = Object.keys(apiIdToFid).length;
  console.log(`📦 Mapped fixtures: ${mappedCount}/${Object.keys(fixtures).length}`);

  if(!mappedCount) {
    console.error('❌ No fixtures mapped. Run Map Fixture IDs in admin first!');
    process.exit(1);
  }

  console.log('📡 Fetching IN_PLAY + FINISHED from football-data.org...');
  const data = await fdoFetch('/competitions/WC/matches?season=2026&status=IN_PLAY,PAUSED,FINISHED');
  const matches = data.matches || [];
  console.log(`📡 Got ${matches.length} matches`);

  if(!matches.length) { console.log('No active matches.'); process.exit(0); }

  const updates = {};
  let updated=0, skipped=0, noMap=0;

  for(const m of matches) {
    const apiId    = m.id;
    const status   = m.status;
    const isLive     = ['IN_PLAY','PAUSED'].includes(status);
    const isFinished = status === 'FINISHED';

    let hg = m.score?.fullTime?.home;
    let ag = m.score?.fullTime?.away;
    if((hg===null||hg===undefined) && m.score?.halfTime) {
      hg = m.score.halfTime.home;
      ag = m.score.halfTime.away;
    }

    if(hg===null||hg===undefined||ag===null||ag===undefined) { skipped++; continue; }

    const fid = apiIdToFid[apiId];
    if(!fid) {
      console.log(`  ⚠️  No match for API ID ${apiId}: ${m.homeTeam?.name} vs ${m.awayTeam?.name}`);
      noMap++; continue;
    }

    updates[`results/${fid}`] = {
      homeScore: hg, awayScore: ag, status,
      source: 'football-data.org',
      confirmedAt: Date.now(),
      isLive, isFinal: isFinished
    };
    if(isFinished) updates[`fixtures/${fid}/status`] = 'FT';

    console.log(`  ${isFinished?'✅ FT':'🔴 LIVE'}: ${m.homeTeam?.name} ${hg}-${ag} ${m.awayTeam?.name}`);
    updated++;
  }

  if(Object.keys(updates).length) await db.ref().update(updates);
  console.log(`\n📊 Done: ${updated} updated · ${skipped} skipped · ${noMap} unmapped`);
  process.exit(0);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
