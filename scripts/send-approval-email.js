/**
 * send-approval-email.js — Prode 2026
 *
 * Polls Firebase for approved access requests without emailSent:true.
 * Fetches the tournament's scoring config, sends a welcome email via Resend,
 * then marks emailSent:true so it never sends twice.
 *
 * Runs every 5 minutes via GitHub Actions cron.
 *
 * Secrets required:
 *   FIREBASE_SERVICE_ACCOUNT  — Firebase service account JSON
 *   FIREBASE_DATABASE_URL     — e.g. https://prode-2026-7838f-default-rtdb.firebaseio.com
 *   BREVO_API_KEY              — from brevo.com → My Account → SMTP & API → API Keys
 */

import admin from 'firebase-admin';
import fetch from 'node-fetch';

// ── Firebase init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

// ── Config ────────────────────────────────────────────────────────────────────
// BREVO_API_KEY loaded directly in sendEmail via process.env
// Brevo sender set inline in sendEmail
const APP_URL        = 'https://varirvarela.github.io/prode-2026-backup/prode-player.html';

// ── Fetch scoring config (stored globally at config/scoring) ─────────────────
async function getScoringConfig(tid) {
  // Try tournament-level first, fall back to global config/scoring
  let snap = await db.ref(`tournaments/${tid}/config/scoring`).once('value');
  let cfg  = snap.val();
  if(!cfg || (!cfg.exact && !cfg.gd && !cfg.result)) {
    snap = await db.ref('config/scoring').once('value');
    cfg  = snap.val() || {};
  }
  return {
    exact:  cfg.exact  || 5,
    gd:     cfg.gd     || 3,
    result: cfg.result || 1,
  };
}

// ── Build email HTML ──────────────────────────────────────────────────────────
function buildEmail(name, scoring) {
  const firstName = name.split(' ')[0];

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body{margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;}
    .wrap{max-width:520px;margin:0 auto;padding:24px 16px;}
    .card{background:#080b10;border-radius:12px;overflow:hidden;}
    .header{padding:32px 28px 20px;text-align:center;border-bottom:1px solid #1c2333;}
    .logo{font-size:38px;font-weight:900;letter-spacing:4px;color:#e8edf8;margin-bottom:2px;}
    .logo span{color:#00e5a0;}
    .logo-sub{font-size:11px;color:#4a5570;letter-spacing:3px;}
    .body{padding:28px;}
    .section{background:#10141d;border:1px solid #1c2333;border-radius:10px;padding:24px;margin-bottom:16px;}
    h2{color:#e8edf8;font-size:20px;margin:0 0 10px;}
    p{color:#8a97b4;font-size:14px;line-height:1.7;margin:0 0 16px;}
    .btn{display:block;background:#00e5a0;color:#071810;text-decoration:none;text-align:center;padding:14px;border-radius:8px;font-weight:700;font-size:14px;letter-spacing:0.5px;margin-bottom:16px;}
    .tip{background:#0d1018;border:1px solid #1c2333;border-radius:8px;padding:12px 14px;}
    .tip p{font-size:12px;color:#4a5570;line-height:1.6;margin:0;}
    .tip strong{color:#00e5a0;}
    .score-row{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #1c2333;}
    .score-row:last-child{border-bottom:none;}
    .score-icon{font-size:18px;min-width:28px;}
    .score-desc{flex:1;font-size:13px;color:#8a97b4;}
    .score-pts{font-size:13px;font-weight:700;}
    .pts-pos{color:#00e5a0;}
    .pts-zero{color:#ff4d35;}
    .section-label{font-size:13px;font-weight:600;color:#e8edf8;margin-bottom:14px;}
    .footer{padding:16px 28px 24px;text-align:center;border-top:1px solid #1c2333;}
    .footer p{font-size:11px;color:#2a3040;line-height:1.8;margin:0;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">

      <div class="header">
        <div class="logo">PRODE <span>2026</span></div>
        <div class="logo-sub">WORLD CUP PREDICTION GAME</div>
      </div>

      <div class="body">

        <div class="section">
          <h2>You're in, ${firstName}! &#x1F389;</h2>
          <p>Your access request has been approved. Open the app, pick your avatar, and start predicting World Cup matches.</p>
          <a href="${APP_URL}" class="btn">Open Prode 2026 &rarr;</a>
          <div class="tip">
            <p>Sign in with the <strong>email and password</strong> you chose when you registered.<br>
            <strong>Save your login details</strong> &mdash; you&rsquo;ll need them every time you open the app on a new device.</p>
          </div>
        </div>

        <div class="section">
          <div class="section-label">How scoring works</div>
          <div class="score-row">
            <div class="score-icon">&#x1F947;</div>
            <div class="score-desc">Exact score (e.g. you said 2&ndash;1, it ended 2&ndash;1)</div>
            <div class="score-pts pts-pos">${scoring.exact} pts</div>
          </div>
          <div class="score-row">
            <div class="score-icon">&#x1F948;</div>
            <div class="score-desc">Right result + correct goal difference</div>
            <div class="score-pts pts-pos">${scoring.gd} pts</div>
          </div>
          <div class="score-row">
            <div class="score-icon">&#x1F949;</div>
            <div class="score-desc">Correct winner or draw, wrong margin</div>
            <div class="score-pts pts-pos">${scoring.result} pt${scoring.result === 1 ? '' : 's'}</div>
          </div>
          <div class="score-row">
            <div class="score-icon">&#x1F615;</div>
            <div class="score-desc">Wrong result</div>
            <div class="score-pts pts-zero">0 pts</div>
          </div>
        </div>

      </div>

      <div class="footer">
        <p>Prode 2026 &middot; World Cup Prediction Game<br>
        You received this because you requested access to the group.</p>
      </div>

    </div>
  </div>
</body>
</html>`;
}

// ── Send via Brevo ────────────────────────────────────────────────────────────
async function sendEmail(to, name, scoring) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key':      process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender:  { name: 'Prode 2026', email: process.env.BREVO_SENDER_EMAIL || 'pablorvarela@gmail.com' },
      to:      [{ email: to, name: name }],
      subject: '⚽ You\'ve been approved — Prode 2026',
      htmlContent: buildEmail(name, scoring),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo API error ${res.status}: ${err}`);
  }
  return await res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Checking for approved requests without emails...');

  const tournsSnap = await db.ref('tournaments').once('value');
  const tourns = tournsSnap.val() || {};
  let sent = 0;

  for (const [tid, tData] of Object.entries(tourns)) {
    const requests = tData.pending_requests || {};
    const pendingEmails = Object.entries(requests).filter(
      ([, r]) => r.status === 'approved' && r.email && r.emailSent !== true
    );

    if (!pendingEmails.length) continue;

    // Fetch this tournament's scoring config once per tournament
    const scoring = await getScoringConfig(tid);
    console.log(`Tournament ${tid} — scoring: exact=${scoring.exact} gd=${scoring.gd} result=${scoring.result}`);

    console.log(`  Found ${pendingEmails.length} pending email(s) in this tournament`);

    for (const [reqId, req] of pendingEmails) {
      console.log(`  Sending to ${req.email} (${req.name})...`);
      try {
        const result = await sendEmail(req.email, req.name || 'Player', scoring);
        console.log(`  Email accepted by Brevo:`, JSON.stringify(result));
        try {
          await db.ref(`tournaments/${tid}/pending_requests/${reqId}`).update({
            emailSent:   true,
            emailSentAt: Date.now(),
          });
          console.log(`  ✓ Firebase updated — emailSent:true`);
        } catch(fbErr) {
          console.error(`  ✗ Firebase update failed: ${fbErr.message}`);
        }
        sent++;
        console.log(`  ✓ Done: ${req.email}`);
      } catch (e) {
        console.error(`  ✗ Failed for ${req.email}: ${e.message}`);
      }
      // Small delay between sends to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log(`Done. ${sent} email(s) sent this run.`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
