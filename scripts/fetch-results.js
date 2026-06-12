/**
 * fetch-results.js — Prode 2026
 * Fetches WC 2026 results from football-data.org.
 * Writes results to Firebase AND rescores all tournaments automatically.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase }          from 'firebase-admin/database';
import fetch                    from 'node-fetch';

const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const DB_URL  = process.env.FIREBASE_DATABASE_URL;
const FDO_KEY = process.env.FDO_KEY;

if(!SA_JSON || !DB_URL || !FDO_KEY) {
  console.error('❌ Missing env vars');
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

// ── Scoring engine (mirrors app logic) ───────────────────────────────────────
function computeScore(predHome, predAway, actHome, actAway, cfg) {
  cfg = cfg || { exact: 5, gd: 3, result: 1 };
  const ph = parseInt(predHome), pa = parseInt(predAway);
  const ah = parseInt(actHome),  aa = parseInt(actAway);
  if(isNaN(ph)||isNaN(pa)||isNaN(ah)||isNaN(aa)) return { tier:'zero', pts:0 };
  if(ph===ah && pa===aa) return { tier:'exact', pts:cfg.exact };
  const pr = ph>pa?'H':ph<pa?'A':'D';
  const ar = ah>aa?'H':ah<aa?'A':'D';
  if(pr===ar) {
    if((ph-pa)===(ah-aa)) return { tier:'gd', pts:cfg.gd };
    return { tier:'result', pts:cfg.result };
  }
  return { tier:'zero', pts:0 };
}

// ── Score a single match for all tournaments ──────────────────────────────────
async function scoreMatchForAllTournaments(matchId, homeScore, awayScore) {
  // Get all tournaments
  const tournsSnap = await db.ref('tournaments').once('value');
  const tournaments = tournsSnap.val() || {};
  const tids = Object.keys(tournaments);

  console.log(`  📊 Scoring ${matchId} (${homeScore}-${awayScore}) across ${tids.length} tournaments...`);

  for(const tid of tids) {
    const t = tournaments[tid];

    // Get scoring config for this tournament
    const cfg = t.scoring || { exact:5, gd:3, result:1 };

    // Get all predictions for this match in this tournament
    const predsSnap = await db.ref(`tournaments/${tid}/predictions`).once('value');
    const allPreds = predsSnap.val() || {};

    const scoreUpdates = {};
    const lbUpdates = {};

    // Score each player
    for(const [uid, userPreds] of Object.entries(allPreds)) {
      const pred = userPreds[matchId];
      if(!pred || pred.homeScore === undefined || pred.awayScore === undefined) continue;

      const result = computeScore(pred.homeScore, pred.awayScore, homeScore, awayScore, cfg);
      scoreUpdates[`tournaments/${tid}/scores/${uid}/${matchId}`] = {
        tier:       result.tier,
        points:     result.pts,
        computedAt: Date.now()
      };
    }

    if(Object.keys(scoreUpdates).length > 0) {
      await db.ref().update(scoreUpdates);
      console.log(`    ✓ ${tid}: scored ${Object.keys(scoreUpdates).length} predictions`);

      // Now update leaderboard for this tournament
      await updateLeaderboard(tid);
    }
  }
}

// ── Update leaderboard for a tournament ───────────────────────────────────────
async function updateLeaderboard(tid) {
  const [scoresSnap, usersSnap] = await Promise.all([
    db.ref(`tournaments/${tid}/scores`).once('value'),
    db.ref(`tournaments/${tid}/users`).once('value')
  ]);

  const allScores = scoresSnap.val() || {};
  const users     = usersSnap.val() || {};
  const validUids = new Set(Object.keys(users));

  const totals = {};
  for(const [uid, matches] of Object.entries(allScores)) {
    if(!validUids.has(uid)) continue;
    let total=0, exact=0, correct=0;
    for(const sc of Object.values(matches)) {
      const pts = sc.points !== undefined ? sc.points : (sc.pts || 0);
      total  += pts;
      if(sc.tier === 'exact') exact++;
      if(sc.tier !== 'zero')  correct++;
    }
    totals[uid] = { totalPoints:total, exactScores:exact, correctResults:correct, updatedAt:Date.now() };
  }

  const ranked = Object.entries(totals).sort((a,b) => b[1].totalPoints - a[1].totalPoints);
  const lbUpdates = {};
  ranked.forEach(([uid, data], i) => {
    lbUpdates[`tournaments/${tid}/leaderboard/${uid}`] = { ...data, rank: i+1 };
  });

  if(Object.keys(lbUpdates).length > 0) {
    await db.ref().update(lbUpdates);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🕐 Starting fetch-results at ${new Date().toISOString()}`);

  // Load Firebase fixtures (need apiFixtureId mappings)
  const fixturesSnap = await db.ref('fixtures').once('value');
  const fixtures = fixturesSnap.val() || {};

  const apiIdToFid = {};
  for(const [fid, f] of Object.entries(fixtures)) {
    if(f.apiFixtureId) apiIdToFid[f.apiFixtureId] = fid;
  }

  const mappedCount = Object.keys(apiIdToFid).length;
  console.log(`📦 Mapped fixtures: ${mappedCount}/${Object.keys(fixtures).length}`);

  if(!mappedCount) {
    console.error('❌ No fixtures mapped. Run Map Fixture IDs first!');
    process.exit(1);
  }

  // Load existing results to detect changes
  const existingResultsSnap = await db.ref('results').once('value');
  const existingResults = existingResultsSnap.val() || {};

  // Fetch today's matches from football-data.org
  console.log('📡 Fetching IN_PLAY + FINISHED from football-data.org...');
  const data = await fdoFetch('/competitions/WC/matches?season=2026&status=IN_PLAY,PAUSED,FINISHED');
  const matches = data.matches || [];
  console.log(`📡 Got ${matches.length} matches`);

  if(!matches.length) { console.log('No active matches.'); process.exit(0); }

  const resultUpdates = {};
  const changedMatches = []; // matches where score changed
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
    if(!fid) { noMap++; continue; }

    // Check if score changed
    const existing = existingResults[fid];
    const scoreChanged = !existing ||
      existing.homeScore !== hg ||
      existing.awayScore !== ag;

    resultUpdates[`results/${fid}`] = {
      homeScore: hg, awayScore: ag, status,
      source: 'football-data.org',
      confirmedAt: Date.now(),
      isLive, isFinal: isFinished
    };
    if(isFinished) resultUpdates[`fixtures/${fid}/status`] = 'FT';

    if(scoreChanged) {
      changedMatches.push({ fid, homeScore: hg, awayScore: ag });
      console.log(`  ${isFinished?'✅ FT':'🔴 LIVE'}: ${m.homeTeam?.name} ${hg}-${ag} ${m.awayTeam?.name} ${scoreChanged?'[SCORE CHANGED]':''}`);
    }
    updated++;
  }

  // Write results to Firebase
  if(Object.keys(resultUpdates).length > 0) {
    await db.ref().update(resultUpdates);
  }

  // Rescore all tournaments for changed matches
  if(changedMatches.length > 0) {
    console.log(`\n🔄 Rescoring ${changedMatches.length} changed match(es) across all tournaments...`);
    for(const { fid, homeScore, awayScore } of changedMatches) {
      await scoreMatchForAllTournaments(fid, homeScore, awayScore);
    }
    console.log('✅ All tournaments rescored');
  } else {
    console.log('No score changes — skipping rescore');
  }

  console.log(`\n📊 Done: ${updated} results checked · ${skipped} skipped · ${noMap} unmapped`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
