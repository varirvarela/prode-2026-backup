/**
 * sync-fixtures.js — One-time fixture sync for Prode 2026
 * Fetches all 2026 World Cup fixtures from API-Football and writes to Firebase.
 * Run manually via GitHub Actions: Actions → Sync WC 2026 Fixtures → Run workflow
 *
 * API-Football: league=1, season=2026
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const API_KEY  = process.env.API_FOOTBALL_KEY;
const SA_JSON  = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL   = process.env.FIREBASE_DATABASE_URL;

if(!API_KEY || !SA_JSON || !DB_URL) {
  console.error('❌ Missing env vars — need API_FOOTBALL_KEY, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

// Flag emoji map for common national teams
const FLAG_MAP = {
  'Argentina':'🇦🇷','Brazil':'🇧🇷','France':'🇫🇷','Germany':'🇩🇪','Spain':'🇪🇸',
  'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Portugal':'🇵🇹','Netherlands':'🇳🇱','Italy':'🇮🇹','Belgium':'🇧🇪',
  'Uruguay':'🇺🇾','Croatia':'🇭🇷','Morocco':'🇲🇦','Senegal':'🇸🇳','Japan':'🇯🇵',
  'South Korea':'🇰🇷','Mexico':'🇲🇽','USA':'🇺🇸','Canada':'🇨🇦','Ecuador':'🇪🇨',
  'Colombia':'🇨🇴','Chile':'🇨🇱','Peru':'🇵🇪','Venezuela':'🇻🇪','Bolivia':'🇧🇴',
  'Paraguay':'🇵🇾','Serbia':'🇷🇸','Switzerland':'🇨🇭','Denmark':'🇩🇰','Poland':'🇵🇱',
  'Austria':'🇦🇹','Ukraine':'🇺🇦','Turkey':'🇹🇷','Romania':'🇷🇴','Hungary':'🇭🇺',
  'Czech Republic':'🇨🇿','Slovakia':'🇸🇰','Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿','Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Greece':'🇬🇷',
  'Algeria':'🇩🇿','Egypt':'🇪🇬','Nigeria':'🇳🇬','Cameroon':'🇨🇲','Ghana':'🇬🇭',
  'Tunisia':'🇹🇳','Ivory Coast':'🇨🇮','Mali':'🇲🇱','DR Congo':'🇨🇩','South Africa':'🇿🇦',
  'Australia':'🇦🇺','Iran':'🇮🇷','Saudi Arabia':'🇸🇦','Qatar':'🇶🇦','Iraq':'🇮🇶',
  'Uzbekistan':'🇺🇿','China':'🇨🇳','Indonesia':'🇮🇩','New Zealand':'🇳🇿',
  'Costa Rica':'🇨🇷','Panama':'🇵🇦','Honduras':'🇭🇳','Jamaica':'🇯🇲',
  'Iceland':'🇮🇸','Norway':'🇳🇴','Sweden':'🇸🇪','Finland':'🇫🇮',
  'Slovenia':'🇸🇮','Albania':'🇦🇱','Georgia':'🇬🇪','Romania':'🇷🇴',
};

function getFlag(name) {
  return FLAG_MAP[name] || '🏳️';
}

// Round label mapping from API-Football
function getRoundLabel(round) {
  if(!round) return 'Group Stage';
  const r = round.toLowerCase();
  if(r.includes('group')) return 'Group Stage';
  if(r.includes('round of 32') || r.includes('1/16')) return 'Round of 32';
  if(r.includes('round of 16') || r.includes('1/8')) return 'Round of 16';
  if(r.includes('quarter')) return 'Quarter-Finals';
  if(r.includes('semi')) return 'Semi-Finals';
  if(r.includes('third') || r.includes('3rd')) return 'Third Place';
  if(r.includes('final')) return 'Final';
  return round;
}

function getStage(round) {
  if(!round) return 'group';
  const r = round.toLowerCase();
  if(r.includes('group')) return 'group';
  if(r.includes('round of 32') || r.includes('1/16')) return 'r32';
  if(r.includes('round of 16') || r.includes('1/8')) return 'r16';
  if(r.includes('quarter')) return 'qf';
  if(r.includes('semi')) return 'sf';
  if(r.includes('third')) return 'tp';
  if(r.includes('final')) return 'final';
  return 'group';
}

async function fetchPage(page) {
  const url = `https://v3.football.api-sports.io/fixtures?league=1&season=2026&page=${page}`;
  const res = await fetch(url, {
    headers: { 'x-apisports-key': API_KEY }
  });
  if(!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function main() {
  console.log('⚽ Starting fixture sync — league=1, season=2026');

  // Fetch all pages
  let allFixtures = [];
  let page = 1;
  while(true) {
    console.log(`  Fetching page ${page}…`);
    const data = await fetchPage(page);

    if(!data.response || !data.response.length) break;
    allFixtures = allFixtures.concat(data.response);

    if(data.paging && page >= data.paging.total) break;
    page++;
    // Rate limit — small delay between pages
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`  Found ${allFixtures.length} fixtures`);

  if(!allFixtures.length) {
    console.log('⚠️  No fixtures found — check league/season IDs');
    process.exit(0);
  }

  // Transform to our schema
  const updates = {};
  for(const f of allFixtures) {
    const mid = `match_${f.fixture.id}`;
    const homeName = f.teams.home.name;
    const awayName = f.teams.away.name;
    const roundLabel = getRoundLabel(f.league.round);
    const stage = getStage(f.league.round);

    updates[`fixtures/${mid}`] = {
      apiId:     f.fixture.id,
      homeTeam:  homeName,
      awayTeam:  awayName,
      homeFlag:  getFlag(homeName),
      awayFlag:  getFlag(awayName),
      kickoff:   new Date(f.fixture.date).getTime(),
      round:     roundLabel,
      stage:     stage,
      venue:     f.fixture.venue.name || '',
      city:      f.fixture.venue.city || '',
      status:    f.fixture.status.short || 'NS',
      group:     f.league.round || '',
    };
  }

  // Write to Firebase
  console.log(`  Writing ${Object.keys(updates).length} fixtures to Firebase…`);
  await db.ref().update(updates);

  // Summary
  const byRound = {};
  for(const f of allFixtures) {
    const r = getRoundLabel(f.league.round);
    byRound[r] = (byRound[r]||0) + 1;
  }
  console.log('\n✅ Fixtures synced!');
  console.log('── Breakdown:');
  for(const [round, count] of Object.entries(byRound)) {
    console.log(`   ${round}: ${count} matches`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Sync failed:', err);
  process.exit(1);
});
