/**
 * map-fixture-ids.js — Prode 2026
 * ONE-TIME SCRIPT: Maps API-Football fixture IDs to Firebase fixture IDs.
 *
 * Run once before the tournament (or now):
 *   node map-fixture-ids.js
 *
 * What it does:
 *   1. Fetches all WC 2026 fixtures from API-Football (league=1, season=2026)
 *   2. Matches each to your Firebase fixture by date + team name
 *   3. Writes apiFixtureId into each Firebase fixture
 *   4. Reports any unmatched fixtures so you can fix manually
 *
 * After this runs, fetch-results.js can match by ID — bulletproof forever.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;
const API_KEY = process.env.API_FOOTBALL_KEY;

if(!SA_JSON || !DB_URL || !API_KEY) {
  console.error('❌ Missing env vars. Need: FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, API_FOOTBALL_KEY');
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

// Normalize team name for fuzzy matching
function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Check if two team names are close enough
function teamsMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if(na === nb) return true;
  // First 4 chars
  if(na.slice(0,4) === nb.slice(0,4)) return true;
  // One contains the other (handles "korea republic" vs "south korea")
  if(na.includes(nb.slice(0,5)) || nb.includes(na.slice(0,5))) return true;
  // Known aliases
  const aliases = {
    'united states': 'usa',
    'usa': 'united states',
    'korea republic': 'south korea',
    'south korea': 'korea republic',
    'ivory coast': 'cote divoire',
    'cote divoire': 'ivory coast',
    'dr congo': 'congo dr',
    'congo dr': 'dr congo',
    'bosnia': 'bosnia and herzegovina',
    'bosnia and herzegovina': 'bosnia',
    'trinidad and tobago': 'trinidad tobago',
  };
  if(aliases[na] === nb || aliases[nb] === na) return true;
  return false;
}

async function main() {
  console.log('🔗 Starting fixture ID mapping...\n');

  // Load Firebase fixtures
  const fbSnap = await db.ref('fixtures').once('value');
  const fbFixtures = fbSnap.val() || {};
  const fbEntries = Object.entries(fbFixtures);
  console.log(`📦 Firebase fixtures: ${fbEntries.length}`);

  // Fetch API-Football WC 2026 fixtures
  console.log('📡 Fetching from API-Football (league=1, season=2026)...');
  const data = await apiFetch('/fixtures?league=1&season=2026&timezone=UTC');
  const apiFixtures = data.response || [];
  console.log(`📡 API-Football fixtures: ${apiFixtures.length}\n`);

  if(!apiFixtures.length) {
    console.error('❌ No fixtures returned from API-Football. Check your API key and subscription.');
    process.exit(1);
  }

  let matched   = 0;
  let unmatched = 0;
  let already   = 0;
  const unmatchedList = [];
  const updates = {};

  for(const apiFix of apiFixtures) {
    const apiId   = apiFix.fixture.id;
    const apiDate = new Date(apiFix.fixture.date).toISOString().slice(0, 10);
    const apiHome = apiFix.teams.home.name;
    const apiAway = apiFix.teams.away.name;

    // Find matching Firebase fixture
    let bestMatch = null;

    for(const [fid, f] of fbEntries) {
      // Skip if already mapped to this ID
      if(f.apiFixtureId === apiId) { already++; bestMatch = fid; break; }

      const fDate = f.kickoff ? new Date(f.kickoff).toISOString().slice(0, 10) : '';
      if(fDate !== apiDate) continue;

      if(teamsMatch(apiHome, f.homeTeam) && teamsMatch(apiAway, f.awayTeam)) {
        bestMatch = fid;
        break;
      }
      // Try reversed (shouldn't happen but just in case)
      if(teamsMatch(apiHome, f.awayTeam) && teamsMatch(apiAway, f.homeTeam)) {
        bestMatch = fid;
        console.log(`  ⚠️  Reversed match: API ${apiHome} vs ${apiAway} → Firebase ${f.homeTeam} vs ${f.awayTeam}`);
        break;
      }
    }

    if(bestMatch) {
      if(fbFixtures[bestMatch].apiFixtureId === apiId) {
        // Already correct
      } else {
        updates[`fixtures/${bestMatch}/apiFixtureId`] = apiId;
        updates[`fixtures/${bestMatch}/apiHomeTeam`]  = apiHome;
        updates[`fixtures/${bestMatch}/apiAwayTeam`]  = apiAway;
        matched++;
        console.log(`  ✅ ${apiHome} vs ${apiAway} (${apiDate}) → ${bestMatch} [API ID: ${apiId}]`);
      }
    } else {
      unmatched++;
      unmatchedList.push({ apiId, apiDate, apiHome, apiAway });
      console.log(`  ❌ NO MATCH: ${apiHome} vs ${apiAway} on ${apiDate} [API ID: ${apiId}]`);
    }
  }

  // Write all updates atomically
  if(Object.keys(updates).length > 0) {
    console.log(`\n💾 Writing ${Object.keys(updates).length / 3} mappings to Firebase...`);
    await db.ref().update(updates);
    console.log('✅ Done!');
  }

  console.log(`\n📊 Summary:`);
  console.log(`  ✅ Mapped:     ${matched}`);
  console.log(`  ⏭️  Already:   ${already}`);
  console.log(`  ❌ Unmatched: ${unmatched}`);

  if(unmatchedList.length > 0) {
    console.log('\n⚠️  UNMATCHED FIXTURES (need manual fix):');
    console.log('   Add apiFixtureId manually to these Firebase fixtures:');
    unmatchedList.forEach(u => {
      console.log(`   API ID ${u.apiId}: ${u.apiHome} vs ${u.apiAway} on ${u.apiDate}`);
    });
    console.log('\n   To fix: In Firebase console, add apiFixtureId: <ID> to the matching fixture.');
  } else {
    console.log('\n🎉 All fixtures mapped! fetch-results.js will now match by ID.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
