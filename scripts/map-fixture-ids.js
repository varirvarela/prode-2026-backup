/**
 * map-fixture-ids.js — Prode 2026
 * ONE-TIME: Maps football-data.org fixture IDs to Firebase fixture IDs.
 * Run via GitHub Actions before the tournament starts.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;
const FDO_KEY = process.env.FDO_KEY;

if(!SA_JSON || !DB_URL || !FDO_KEY) {
  console.error('❌ Missing env vars: FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL, FDO_KEY');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

async function fdoFetch(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { 'X-Auth-Token': FDO_KEY }
  });
  if(!res.ok) throw new Error(`HTTP ${res.status} from football-data.org`);
  return res.json();
}

function normTeam(name) {
  return (name||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
}

function teamsMatch(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if(na === nb) return true;
  if(na.slice(0,4) === nb.slice(0,4)) return true;
  if(na.length > 4 && nb.includes(na.slice(0,5))) return true;
  if(nb.length > 4 && na.includes(nb.slice(0,5))) return true;
  const aliases = {
    'united states':'usa', 'usa':'united states',
    'korea republic':'south korea', 'south korea':'korea republic',
    'czechia':'czech republic', 'czech republic':'czechia',
    'ivory coast':'cote divoire', 'cote divoire':'ivory coast',
    'cote d ivoire':'ivory coast',
    'dr congo':'congo dr', 'congo dr':'dr congo',
    'bosnia':'bosnia and herzegovina', 'bosnia and herzegovina':'bosnia',
    'ir iran':'iran', 'iran':'ir iran',
    'cabo verde':'cape verde', 'cape verde':'cabo verde'
  };
  if(aliases[na]===nb || aliases[nb]===na) return true;
  return false;
}

async function main() {
  console.log('🔗 Starting fixture ID mapping...\n');

  // Load Firebase fixtures
  const fbSnap = await db.ref('fixtures').once('value');
  const fbFixtures = fbSnap.val() || {};
  const fbEntries = Object.entries(fbFixtures);
  console.log(`📦 Firebase fixtures: ${fbEntries.length}`);

  // Fetch all WC 2026 matches from football-data.org
  console.log('📡 Fetching from football-data.org...');
  const data = await fdoFetch('/competitions/WC/matches?season=2026');
  const apiMatches = data.matches || [];
  console.log(`📡 Got ${apiMatches.length} matches\n`);

  if(!apiMatches.length) {
    console.error('❌ No matches returned. Check your FDO_KEY.');
    process.exit(1);
  }

  let matched=0, already=0, unmatched=0;
  const updates = {};
  const unmatchedList = [];

  for(const m of apiMatches) {
    const apiId   = m.id;
    const apiDate = m.utcDate ? m.utcDate.slice(0,10) : '';
    const apiHome = m.homeTeam?.name || '';
    const apiAway = m.awayTeam?.name || '';
    if(!apiHome || !apiAway) continue;

    // Already mapped?
    const alreadyMapped = fbEntries.find(e => e[1].apiFixtureId === apiId);
    if(alreadyMapped) { already++; continue; }

    // Match by date + team name
    let bestFid = null;
    for(const [fid, f] of fbEntries) {
      const fDate = f.kickoff ? new Date(f.kickoff).toISOString().slice(0,10) : '';
      if(fDate !== apiDate) continue;
      if(teamsMatch(apiHome, f.homeTeam) && teamsMatch(apiAway, f.awayTeam)) {
        bestFid = fid; break;
      }
    }

    if(bestFid) {
      updates[`fixtures/${bestFid}/apiFixtureId`] = apiId;
      updates[`fixtures/${bestFid}/apiHomeTeam`]  = apiHome;
      updates[`fixtures/${bestFid}/apiAwayTeam`]  = apiAway;
      updates[`fixtures/${bestFid}/apiSource`]    = 'football-data.org';
      console.log(`  ✅ ${apiHome} vs ${apiAway} (${apiDate}) → ${bestFid}`);
      matched++;
    } else {
      unmatchedList.push(`${apiHome} vs ${apiAway} on ${apiDate} [ID:${apiId}]`);
      unmatched++;
    }
  }

  if(Object.keys(updates).length) {
    console.log(`\n💾 Writing ${matched} mappings to Firebase...`);
    await db.ref().update(updates);
  }

  console.log(`\n📊 Summary:`);
  console.log(`  ✅ Mapped:    ${matched}`);
  console.log(`  ⏭️  Already:  ${already}`);
  console.log(`  ❌ Unmatched: ${unmatched}`);

  if(unmatchedList.length) {
    console.log('\n⚠️  Unmatched (need manual fix in Firebase):');
    unmatchedList.forEach(u => console.log('  ', u));
  } else {
    console.log('\n🎉 All fixtures mapped! fetch-results.js will match by ID.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
