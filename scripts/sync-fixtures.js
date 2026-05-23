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
  console.error('❌ Missing env vars');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(SA_JSON)), databaseURL: DB_URL });
const db = getDatabase();

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
  'Slovenia':'🇸🇮','Albania':'🇦🇱','Georgia':'🇬🇪',
};

function getFlag(name) { return FLAG_MAP[name] || '🏳️'; }

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

async function apiFetch(path) {
  // Try both API hosts — api-football.com is the primary
  const hosts = [
    'https://v3.football.api-sports.io',
    'https://api-football-v1.p.rapidapi.com/v3',
  ];
  const headers = [
    { 'x-apisports-key': API_KEY },
    { 'x-rapidapi-key': API_KEY, 'x-rapidapi-host': 'api-football-v1.p.rapidapi.com' },
  ];

  for(let i = 0; i < hosts.length; i++) {
    try {
      const url = `${hosts[i]}${path}`;
      console.log(`  Trying: ${url}`);
      const res = await fetch(url, { headers: headers[i] });
      if(res.ok) {
        const data = await res.json();
        // Check for API error in response body
        if(data.errors && Object.keys(data.errors).length > 0) {
          console.log(`  API errors: ${JSON.stringify(data.errors)}`);
          continue;
        }
        return data;
      }
      console.log(`  HTTP ${res.status} from ${hosts[i]}`);
    } catch(e) {
      console.log(`  Error with ${hosts[i]}: ${e.message}`);
    }
  }
  throw new Error('All API hosts failed');
}

async function main() {
  console.log('⚽ Starting fixture sync — league=1, season=2026\n');

  // First check the league is accessible
  console.log('Checking league access…');
  const leagueData = await apiFetch('/leagues?id=1&season=2026');
  console.log(`  League response: ${leagueData.results} result(s)`);

  if(!leagueData.response || !leagueData.response.length) {
    console.log('⚠️  League 1 / season 2026 not accessible with your API key.');
    console.log('    Check your API-Football dashboard for available seasons.');
    console.log('\n    Falling back to manually checking what seasons are available…');

    const seasonsData = await apiFetch('/leagues?id=1');
    if(seasonsData.response && seasonsData.response.length) {
      const seasons = seasonsData.response[0].seasons || [];
      console.log(`    Available seasons for league 1: ${seasons.map(s => s.year).join(', ')}`);
    }
    process.exit(1);
  }

  // Fetch all fixture pages
  let allFixtures = [];
  let page = 1;
  while(true) {
    console.log(`Fetching page ${page}…`);
    const data = await apiFetch(`/fixtures?league=1&season=2026&page=${page}`);

    if(!data.response || !data.response.length) {
      console.log(`  No fixtures on page ${page}`);
      break;
    }
    allFixtures = allFixtures.concat(data.response);
    console.log(`  Got ${data.response.length} fixtures (total: ${allFixtures.length})`);

    if(!data.paging || page >= data.paging.total) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }

  if(!allFixtures.length) {
    console.log('\n⚠️  No fixtures returned. The 2026 WC fixtures may not be published yet in your plan.');
    console.log('   Check: https://dashboard.api-football.com');
    process.exit(0);
  }

  // Transform and write to Firebase
  const updates = {};
  for(const f of allFixtures) {
    const mid = `match_${f.fixture.id}`;
    updates[`fixtures/${mid}`] = {
      apiId:    f.fixture.id,
      homeTeam: f.teams.home.name,
      awayTeam: f.teams.away.name,
      homeFlag: getFlag(f.teams.home.name),
      awayFlag: getFlag(f.teams.away.name),
      kickoff:  new Date(f.fixture.date).getTime(),
      round:    getRoundLabel(f.league.round),
      stage:    getStage(f.league.round),
      venue:    (f.fixture.venue && f.fixture.venue.name) || '',
      city:     (f.fixture.venue && f.fixture.venue.city) || '',
      status:   (f.fixture.status && f.fixture.status.short) || 'NS',
      group:    f.league.round || '',
    };
  }

  console.log(`\nWriting ${Object.keys(updates).length} fixtures to Firebase…`);
  await db.ref().update(updates);

  const byRound = {};
  for(const f of allFixtures) {
    const r = getRoundLabel(f.league.round);
    byRound[r] = (byRound[r]||0) + 1;
  }

  console.log('\n✅ Fixtures synced!');
  for(const [round, count] of Object.entries(byRound)) {
    console.log(`   ${round}: ${count} matches`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1);
});
