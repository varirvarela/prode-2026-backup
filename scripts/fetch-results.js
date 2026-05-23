/**
 * fetch-results.js — Prode 2026
 * Fetches live WC 2026 results from openfootball/worldcup.json
 * and writes them to Firebase. Triggers auto-scoring.
 *
 * Source: https://github.com/openfootball/worldcup.json
 * Free, no API key, community-maintained. Updated within hours of match end.
 *
 * Runs every 5 minutes via GitHub Actions during match windows.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;

if(!SA_JSON || !DB_URL) {
  console.error('❌ Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_DATABASE_URL');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

const SOURCE_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

// Check if we're within a match window (no point calling if no matches today)
function isMatchWindow() {
  const now  = new Date();
  const hour = now.getUTCHours();
  const date = now.toISOString().slice(0,10);
  // WC matches typically run 15:00–03:00 UTC
  // Always run — openfootball doesn't rate-limit
  return true;
}

async function main() {
  console.log(`🕐 Starting fetch-results at ${new Date().toISOString()}`);

  // Fetch latest data from openfootball
  console.log('Fetching openfootball worldcup.json…');
  const res = await fetch(SOURCE_URL);
  if(!res.ok) throw new Error(`HTTP ${res.status} from openfootball`);
  const data = await res.json();

  const matches = data.matches || [];
  console.log(`📅 Total matches in source: ${matches.length}`);

  // Load existing Firebase fixtures to match by team names + date
  const fixturesSnap = await db.ref('fixtures').once('value');
  const fixtures = fixturesSnap.val() || {};

  // Load existing results to avoid re-writing unchanged ones
  const resultsSnap = await db.ref('results').once('value');
  const existingResults = resultsSnap.val() || {};

  let updated = 0;
  let skipped = 0;

  for(const m of matches) {
    // Only process matches that have scores
    if(m.score === undefined || m.score === null) { skipped++; continue; }

    // Parse score — openfootball format: { ft: [2, 1] } or score1/score2
    let homeScore, awayScore;
    if(m.score && m.score.ft) {
      [homeScore, awayScore] = m.score.ft;
    } else if(m.score1 !== undefined) {
      homeScore = m.score1;
      awayScore = m.score2;
    } else {
      skipped++;
      continue;
    }

    if(homeScore === null || awayScore === null) { skipped++; continue; }

    // Find matching fixture in Firebase by home+away team names and date
    const home = (m.team1 || '').toLowerCase();
    const away = (m.team2 || '').toLowerCase();
    const date = m.date || '';

    let matchedFid = null;
    for(const [fid, f] of Object.entries(fixtures)) {
      const fHome = (f.homeTeam || '').toLowerCase();
      const fAway = (f.awayTeam || '').toLowerCase();
      const fDate = f.kickoff ? new Date(f.kickoff).toISOString().slice(0,10) : '';
      if(fHome === home && fAway === away && fDate === date) {
        matchedFid = fid;
        break;
      }
    }

    if(!matchedFid) {
      console.log(`  ⚠️  No fixture match for: ${m.team1} vs ${m.team2} on ${date}`);
      skipped++;
      continue;
    }

    // Check if result already exists and is the same
    const existing = existingResults[matchedFid];
    if(existing && existing.homeScore === homeScore && existing.awayScore === awayScore) {
      skipped++;
      continue;
    }

    // Write result to Firebase
    await db.ref('results/'+matchedFid).set({
      homeScore,
      awayScore,
      source:      'openfootball',
      confirmedAt: Date.now(),
    });

    // Also update fixture status
    await db.ref('fixtures/'+matchedFid).update({ status: 'FT' });

    console.log(`  ✅ Result: ${m.team1} ${homeScore}-${awayScore} ${m.team2}`);
    updated++;
  }

  console.log(`\n📊 Done: ${updated} results updated · ${skipped} skipped`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
