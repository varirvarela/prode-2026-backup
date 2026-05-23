/**
 * sync-fixtures.js — One-time fixture sync for Prode 2026
 * Uses openfootball/worldcup.json — free, no API key required.
 * Run via GitHub Actions: Actions → Sync WC 2026 Fixtures → Run workflow
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

// openfootball 2026 WC JSON — free, no key, public domain
const SOURCE_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

const FLAG_MAP = {
  'Argentina':'🇦🇷','Brazil':'🇧🇷','France':'🇫🇷','Germany':'🇩🇪','Spain':'🇪🇸',
  'England':'🏴󠁧󠁢󠁥󠁮󠁧󠁿','Portugal':'🇵🇹','Netherlands':'🇳🇱','Italy':'🇮🇹','Belgium':'🇧🇪',
  'Uruguay':'🇺🇾','Croatia':'🇭🇷','Morocco':'🇲🇦','Senegal':'🇸🇳','Japan':'🇯🇵',
  'South Korea':'🇰🇷','Mexico':'🇲🇽','USA':'🇺🇸','United States':'🇺🇸','Canada':'🇨🇦',
  'Ecuador':'🇪🇨','Colombia':'🇨🇴','Chile':'🇨🇱','Peru':'🇵🇪','Venezuela':'🇻🇪',
  'Bolivia':'🇧🇴','Paraguay':'🇵🇾','Serbia':'🇷🇸','Switzerland':'🇨🇭','Denmark':'🇩🇰',
  'Poland':'🇵🇱','Austria':'🇦🇹','Ukraine':'🇺🇦','Turkey':'🇹🇷','Romania':'🇷🇴',
  'Hungary':'🇭🇺','Czech Republic':'🇨🇿','Slovakia':'🇸🇰','Wales':'🏴󠁧󠁢󠁷󠁬󠁳󠁿',
  'Scotland':'🏴󠁧󠁢󠁳󠁣󠁴󠁿','Greece':'🇬🇷','Algeria':'🇩🇿','Egypt':'🇪🇬','Nigeria':'🇳🇬',
  'Cameroon':'🇨🇲','Ghana':'🇬🇭','Tunisia':'🇹🇳','Ivory Coast':'🇨🇮','Mali':'🇲🇱',
  'DR Congo':'🇨🇩','South Africa':'🇿🇦','Australia':'🇦🇺','Iran':'🇮🇷',
  'Saudi Arabia':'🇸🇦','Qatar':'🇶🇦','Iraq':'🇮🇶','Uzbekistan':'🇺🇿','China':'🇨🇳',
  'Indonesia':'🇮🇩','New Zealand':'🇳🇿','Costa Rica':'🇨🇷','Panama':'🇵🇦',
  'Honduras':'🇭🇳','Jamaica':'🇯🇲','Iceland':'🇮🇸','Norway':'🇳🇴','Sweden':'🇸🇪',
  'Slovenia':'🇸🇮','Albania':'🇦🇱','Georgia':'🇬🇪','Austria':'🇦🇹',
  'Bahrain':'🇧🇭','Kuwait':'🇰🇼','Oman':'🇴🇲','Jordan':'🇯🇴',
};

function getFlag(name) { return FLAG_MAP[name] || '🏳️'; }

function getRoundLabel(round, group) {
  if(!round) return 'Group Stage';
  const r = round.toLowerCase();
  if(r.includes('matchday') || r.includes('group')) {
    return group ? `Group Stage — ${group}` : 'Group Stage';
  }
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
  if(r.includes('matchday') || r.includes('group')) return 'group';
  if(r.includes('round of 32') || r.includes('1/16')) return 'r32';
  if(r.includes('round of 16') || r.includes('1/8')) return 'r16';
  if(r.includes('quarter')) return 'qf';
  if(r.includes('semi')) return 'sf';
  if(r.includes('third')) return 'tp';
  if(r.includes('final')) return 'final';
  return 'group';
}

function parseKickoff(date, time) {
  // time format: "13:00 UTC-6" or "20:00"
  if(!date) return null;
  try {
    const timeStr = time ? time.split(' ')[0] : '12:00';
    const offsetMatch = time ? time.match(/UTC([+-]\d+)/) : null;
    const offsetHours = offsetMatch ? parseInt(offsetMatch[1]) : 0;
    const dt = new Date(`${date}T${timeStr}:00Z`);
    dt.setHours(dt.getHours() - offsetHours); // convert to UTC
    return dt.getTime();
  } catch(e) {
    return new Date(date).getTime();
  }
}

async function main() {
  console.log('⚽ Syncing 2026 World Cup fixtures from openfootball (no API key needed)\n');

  console.log(`Fetching: ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if(!res.ok) throw new Error(`HTTP ${res.status} from openfootball`);
  const data = await res.json();

  const matches = data.matches || [];
  console.log(`Found ${matches.length} matches\n`);

  if(!matches.length) {
    console.log('⚠️  No matches found in openfootball data');
    process.exit(0);
  }

  // Transform to Firebase schema
  const updates = {};
  let idx = 1;

  for(const m of matches) {
    // Generate a stable match ID from teams + date
    const home = m.team1 || m.team1_code || 'TBD';
    const away = m.team2 || m.team2_code || 'TBD';
    const mid  = `match_of_${String(idx).padStart(3,'0')}`;
    const stage = getStage(m.round);

    updates[`fixtures/${mid}`] = {
      homeTeam:  home,
      awayTeam:  away,
      homeFlag:  getFlag(home),
      awayFlag:  getFlag(away),
      kickoff:   parseKickoff(m.date, m.time),
      round:     getRoundLabel(m.round, m.group),
      stage:     stage,
      venue:     m.ground || m.stadium || '',
      city:      m.ground || '',
      status:    'NS',
      group:     m.group || '',
      matchday:  m.round || '',
    };
    idx++;
  }

  console.log(`Writing ${Object.keys(updates).length} fixtures to Firebase…`);
  await db.ref().update(updates);

  // Summary by stage
  const byRound = {};
  for(const m of matches) {
    const r = getRoundLabel(m.round, m.group);
    const key = r.includes('Group') ? 'Group Stage' : r;
    byRound[key] = (byRound[key]||0) + 1;
  }
  console.log('\n✅ Fixtures synced!');
  console.log('── Breakdown:');
  for(const [round, count] of Object.entries(byRound)) {
    console.log(`   ${round}: ${count} matches`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1);
});
