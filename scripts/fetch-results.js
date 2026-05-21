/**
 * fetch-results.js — Prode 2026
 * Runs every 5 min via GitHub Actions.
 * Checks if any matches are live before calling API-Football.
 * Writes results to Firebase → auto-scoring fires in admin app.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import fetch from 'node-fetch';

// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_KEY      = process.env.API_FOOTBALL_KEY;
const DB_URL       = process.env.FIREBASE_DATABASE_URL;
const SA_JSON      = process.env.FIREBASE_SERVICE_ACCOUNT; // stringified JSON

if (!API_KEY || !DB_URL || !SA_JSON) {
  console.error('❌ Missing env vars. Need API_FOOTBALL_KEY, FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
}

// ── INIT FIREBASE ─────────────────────────────────────────────────────────────
initializeApp({
  credential: cert(JSON.parse(SA_JSON)),
  databaseURL: DB_URL,
});
const db = getDatabase();

// ── HELPERS ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function nowUTC() {
  return new Date();
}

function isMatchLiveOrRecent(kickoffTs) {
  if (!kickoffTs) return false;
  const now     = Date.now();
  const kickoff = kickoffTs;
  const elapsed = now - kickoff;
  // Live window: from kickoff to 2.5 hours after (90 min + ET + buffer)
  return elapsed >= -5 * 60 * 1000 && elapsed <= 150 * 60 * 1000;
}

function isMatchToday(kickoffTs) {
  if (!kickoffTs) return false;
  const now     = new Date();
  const kickoff = new Date(kickoffTs);
  return (
    kickoff.getUTCFullYear() === now.getUTCFullYear() &&
    kickoff.getUTCMonth()    === now.getUTCMonth() &&
    kickoff.getUTCDate()     === now.getUTCDate()
  );
}

// ── SCORING ENGINE (mirrors app logic) ───────────────────────────────────────
function computeScore(predHome, predAway, actHome, actAway, cfg) {
  cfg = cfg || { exact: 5, gd: 3, result: 1 };
  const ph = parseInt(predHome), pa = parseInt(predAway);
  const ah = parseInt(actHome),  aa = parseInt(actAway);
  if ([ph, pa, ah, aa].some(isNaN)) return { tier: 'zero', pts: 0 };
  if (ph === ah && pa === aa)       return { tier: 'exact',  pts: cfg.exact };
  const pr = ph > pa ? 'H' : ph < pa ? 'A' : 'D';
  const ar = ah > aa ? 'H' : ah < aa ? 'A' : 'D';
  if (pr === ar) {
    if ((ph - pa) === (ah - aa)) return { tier: 'gd',     pts: cfg.gd };
    return                              { tier: 'result', pts: cfg.result };
  }
  return { tier: 'zero', pts: 0 };
}

// ── LEADERBOARD UPDATER ───────────────────────────────────────────────────────
async function updateLeaderboard(scores, users, cfg) {
  const totals = {};

  // Aggregate all scores per user
  for (const [uid, matches] of Object.entries(scores)) {
    let total = 0, exact = 0, correct = 0;
    const roundBreakdown = {};

    for (const [mid, s] of Object.entries(matches)) {
      total   += s.pts || 0;
      if (s.tier === 'exact')               exact++;
      if (s.tier !== 'zero' && s.tier)      correct++;
    }

    totals[uid] = { totalPoints: total, exactScores: exact, correctResults: correct, roundBreakdown };
  }

  // Sort by total points and assign ranks
  const ranked = Object.entries(totals)
    .sort((a, b) => b[1].totalPoints - a[1].totalPoints)
    .map(([uid, data], i) => [uid, { ...data, rank: i + 1 }]);

  const updates = {};
  for (const [uid, data] of ranked) {
    updates[`leaderboard/${uid}`] = data;
  }

  if (Object.keys(updates).length) {
    await db.ref().update(updates);
    console.log(`📊 Leaderboard updated — ${ranked.length} players`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🕐 Starting fetch-results at ${nowUTC().toISOString()}`);

  // 1. Read fixtures from Firebase
  const fixturesSnap = await db.ref('fixtures').once('value');
  const fixtures = fixturesSnap.val() || {};

  // 2. Find matches that are live or recent today
  const liveMatches = Object.entries(fixtures).filter(([, f]) =>
    isMatchLiveOrRecent(f.kickoff) || isMatchToday(f.kickoff)
  );

  console.log(`📅 Fixtures today/live: ${liveMatches.length}`);

  if (liveMatches.length === 0) {
    console.log('💤 No live matches — skipping API call');
    process.exit(0);
  }

  // 3. Check which ones are actually live right now
  const trulyLive = liveMatches.filter(([, f]) => isMatchLiveOrRecent(f.kickoff));
  console.log(`⚽ Currently live or recently finished: ${trulyLive.length}`);

  if (trulyLive.length === 0) {
    console.log('💤 Matches today but none live yet — skipping API call');
    process.exit(0);
  }

  // 4. Collect unique API match IDs
  const apiIds = [...new Set(
    trulyLive.map(([, f]) => f.apiId).filter(Boolean)
  )];

  if (apiIds.length === 0) {
    console.log('⚠️  Live matches found but no apiId fields — was fixture sync run?');
    process.exit(0);
  }

  console.log(`🌐 Calling API-Football for ${apiIds.length} match(es)...`);

  // 5. Fetch each match from API-Football (one call per match to minimise quota)
  const resultUpdates  = {};
  const apiResultMap   = {};

  for (const apiId of apiIds) {
    try {
      const res  = await fetch(`https://v3.football.api-sports.io/fixtures?id=${apiId}`, {
        headers: { 'x-apisports-key': API_KEY, 'x-rapidapi-host': 'v3.football.api-sports.io' },
      });
      const data = await res.json();

      if (!data.response?.[0]) {
        console.warn(`⚠️  No response for apiId ${apiId}`);
        continue;
      }

      const fixture = data.response[0];
      const goals   = fixture.goals;
      const status  = fixture.fixture.status.short; // FT, AET, PEN, 1H, 2H, HT etc.

      console.log(`  Match ${apiId}: ${fixture.teams.home.name} ${goals.home ?? '?'}-${goals.away ?? '?'} ${fixture.teams.away.name} [${status}]`);

      // Only write result if match is finished
      const finished = ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(status);
      const inProgress = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'INT'].includes(status);

      if ((finished || inProgress) && goals.home !== null && goals.away !== null) {
        apiResultMap[apiId] = {
          homeScore:   goals.home,
          awayScore:   goals.away,
          status,
          finished,
          confirmedAt: Date.now(),
          source:      'api',
        };
      }
    } catch (err) {
      console.error(`❌ API error for match ${apiId}:`, err.message);
    }

    // Rate limit — avoid hammering API
    await sleep(300);
  }

  // 6. Map API results back to Firebase match IDs and write
  for (const [mid, fixture] of Object.entries(fixtures)) {
    if (!fixture.apiId) continue;
    const apiResult = apiResultMap[fixture.apiId];
    if (!apiResult) continue;

    resultUpdates[`results/${mid}`] = {
      homeScore:   apiResult.homeScore,
      awayScore:   apiResult.awayScore,
      source:      'api',
      status:      apiResult.status,
      confirmedAt: apiResult.confirmedAt,
    };
  }

  if (Object.keys(resultUpdates).length === 0) {
    console.log('📭 No results to write yet');
    process.exit(0);
  }

  // 7. Write results to Firebase
  await db.ref().update(resultUpdates);
  console.log(`✅ Wrote ${Object.keys(resultUpdates).length} result(s) to Firebase`);

  // 8. Re-run scoring for affected matches
  const scoringCfgSnap = await db.ref('config/scoring').once('value');
  const cfg = scoringCfgSnap.val() || { exact: 5, gd: 3, result: 1 };

  const predictionsSnap = await db.ref('predictions').once('value');
  const allPredictions  = predictionsSnap.val() || {};

  const scoresSnap = await db.ref('scores').once('value');
  const allScores  = scoresSnap.val() ? JSON.parse(JSON.stringify(scoresSnap.val())) : {};

  const scoreUpdates = {};
  let   scoreCount   = 0;

  for (const [mid] of Object.entries(resultUpdates)) {
    // mid is "results/match_123" — strip prefix
    const matchId  = mid.replace('results/', '');
    const result   = resultUpdates[mid];

    if (result.homeScore === undefined) continue;

    for (const [uid, matches] of Object.entries(allPredictions)) {
      const pred = matches[matchId];
      if (!pred || pred.homeScore === undefined) continue;

      const { tier, pts } = computeScore(
        pred.homeScore, pred.awayScore,
        result.homeScore, result.awayScore,
        cfg
      );

      scoreUpdates[`scores/${uid}/${matchId}`] = { tier, pts, computedAt: Date.now() };

      // Update in-memory scores for leaderboard calc
      if (!allScores[uid]) allScores[uid] = {};
      allScores[uid][matchId] = { tier, pts };
      scoreCount++;
    }
  }

  if (Object.keys(scoreUpdates).length) {
    await db.ref().update(scoreUpdates);
    console.log(`🏆 Scored ${scoreCount} prediction(s)`);

    // 9. Update leaderboard
    const usersSnap = await db.ref('users').once('value');
    await updateLeaderboard(allScores, usersSnap.val() || {}, cfg);
  }

  console.log('🏁 Done');
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
