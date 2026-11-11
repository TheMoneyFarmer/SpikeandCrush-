'use strict';

// Game-server side of the admin "Fire" page (market curation, Fire monitor,
// progression, rank split, Discover). Mounted on the existing internal admin
// bridge (/internal/admin/fire/*, shared-secret, never public). The admin
// server does the logins, roles and the audit log; this does the work.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const gameFeel = require('./config/gameFeel');
const modeIdentity = require('./config/modeIdentity');
const toursConfig = require('./config/tours');
const curated = require('./curated');
const progression = require('./progression');
const sabotage = require('./sabotage');
const presence = require('./presence');
const discover = require('./discover');
const rankSplit = require('./rankSplit');

const ROOT = path.join(__dirname, '..');
const CURATED = path.join(ROOT, 'data', 'curated');
const NEXT = path.join(ROOT, 'data', 'curated-next');
const PREV = path.join(ROOT, 'data', 'curated-prev');
const ALERT_TO = process.env.FIRE_ALERT_EMAIL || 'hello@spikeandcrush.com';
const ALERT_EVERY_MS = 60 * 60 * 1000;

const rebuild = { running: false, startedAt: null, finishedAt: null, step: 'idle', log: [], result: null };
let lastAlertAt = 0;
let suppressedAlerts = 0;

// ---- config ------------------------------------------------------------------
async function loadConfig(db) {
  if (!db.isConfigured || !db.getGameConfig) return gameFeel.get();
  try {
    const stored = await db.getGameConfig('game_feel');
    gameFeel.applyOverrides(stored || {});
  } catch (e) {
    console.warn('[fire] could not load game_feel overrides:', e.message);
  }
  // Per-mode identity overrides (admin Fire Gameplay > Game Modes). New
  // matches snapshot them at creation; running matches keep their rules.
  try {
    modeIdentity.applyOverrides((await db.getGameConfig('mode_identity')) || {});
  } catch (e) {
    console.warn('[fire] could not load mode_identity overrides:', e.message);
  }
  try {
    toursConfig.applyOverrides((await db.getGameConfig('tours')) || {});
  } catch (e) {
    console.warn('[fire] could not load tours overrides:', e.message);
  }
  return gameFeel.get();
}

// ---- flat alert (throttled) ----------------------------------------------------
function flatAlertHandler(row) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_EVERY_MS) {
    suppressedAlerts++;
    return;
  }
  lastAlertAt = now;
  const extra = suppressedAlerts;
  suppressedAlerts = 0;
  const subject = `Fire monitor: a ${row.mode} match went flat for ${row.longest_flat_seconds}s on ${row.symbol}`;
  const text = `Match ${row.match_id} (${row.mode}) showed an unchanged ${row.symbol} price for ${row.longest_flat_seconds} seconds (limit ${gameFeel.get().market.flatLimitSeconds}s). Curated: ${row.curated}. Start offset: ${row.start_offset}. ${extra ? `${extra} more flat matches since the last alert.` : ''}\nCheck the Fire monitor in the admin panel.`;
  console.warn('[fire monitor]', subject);
  try {
    const { sendEmail } = require('../admin/lib/email');
    Promise.resolve(sendEmail({ to: ALERT_TO, subject, text, html: `<p>${text.replace(/\n/g, '<br>')}</p>` })).catch((e) => console.warn('[fire monitor] email failed:', e.message));
  } catch (e) {
    console.warn('[fire monitor] no mailer:', e.message);
  }
}

// ---- Fire monitor --------------------------------------------------------------
function monitor(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.mode}|${r.symbol}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const limit = gameFeel.get().market.flatLimitSeconds;
  const out = [];
  for (const [k, list] of by) {
    const [mode, symbol] = k.split('|');
    const flats = list.map((r) => Number(r.longest_flat_seconds)).sort((a, b) => a - b);
    out.push({
      mode,
      symbol,
      matches: list.length,
      medianFlat: flats[Math.floor(flats.length / 2)],
      worstFlat: flats[flats.length - 1],
      overLimit: flats.filter((f) => f > limit).length,
      changesPerMin: Math.round((list.reduce((s, r) => s + Number(r.changes_per_min), 0) / list.length) * 10) / 10,
      rangeBps: Math.round((list.reduce((s, r) => s + Number(r.range_bps), 0) / list.length) * 100) / 100,
    });
  }
  return out.sort((a, b) => b.worstFlat - a.worstFlat);
}

// ---- rebuild playlists ------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function startRebuild() {
  if (rebuild.running) return { started: false, error: 'A rebuild is already running' };
  Object.assign(rebuild, { running: true, startedAt: new Date().toISOString(), finishedAt: null, step: 'curating', log: [], result: null });
  (async () => {
    try {
      fs.rmSync(NEXT, { recursive: true, force: true });
      const cur = await run(process.execPath, ['scripts/curate-data.js', '--out', 'data/curated-next', '--report', 'docs/fire/curation-next.md']);
      rebuild.log.push(`curate exit ${cur.code}`);
      if (cur.code !== 0) throw new Error('curation failed');
      // Competitions keep the series they run on: carry the live comp files over.
      const oldCat = JSON.parse(fs.readFileSync(path.join(CURATED, 'catalog.json'), 'utf8'));
      const newCatPath = path.join(NEXT, 'catalog.json');
      const newCat = JSON.parse(fs.readFileSync(newCatPath, 'utf8'));
      for (const [sym, v] of Object.entries(oldCat.instruments)) {
        if (!v.comp) continue;
        fs.copyFileSync(path.join(CURATED, v.comp.file), path.join(NEXT, v.comp.file));
        if (newCat.instruments[sym]) newCat.instruments[sym].comp = v.comp;
      }
      newCat.compEpoch = oldCat.compEpoch;
      fs.writeFileSync(newCatPath, `${JSON.stringify(newCat, null, 1)}\n`);
      rebuild.step = 'validating';
      const val = await run(process.execPath, ['scripts/fire/validate-curated.js', 'data/curated-next', '30']);
      const verdict = JSON.parse(val.out.trim().split('\n').pop());
      rebuild.log.push(`validate: ${JSON.stringify(verdict)}`);
      if (!verdict.ok) {
        rebuild.result = { swapped: false, reason: 'failed the no-flat guarantee - the old playlists stay live', verdict };
        return;
      }
      rebuild.step = 'swapping';
      fs.rmSync(PREV, { recursive: true, force: true });
      fs.renameSync(CURATED, PREV);
      fs.renameSync(NEXT, CURATED);
      curated.setDir(CURATED); // new matches read the new playlists; running ones keep theirs in memory
      rebuild.result = { swapped: true, verdict };
    } catch (e) {
      rebuild.result = { swapped: false, reason: e.message };
    } finally {
      rebuild.running = false;
      rebuild.finishedAt = new Date().toISOString();
      rebuild.step = 'done';
    }
  })();
  return { started: true };
}

// ---- reports ------------------------------------------------------------------------
async function unlockReport(db) {
  if (!db.isConfigured || !db.listPlayersForUnlockReport) return null;
  const rows = await db.listPlayersForUnlockReport();
  const levels = {};
  const cards = Object.fromEntries(Object.keys(sabotage.CARDS).map((c) => [c, 0]));
  for (const r of rows) {
    const s = progression.standing(r);
    levels[s.level] = (levels[s.level] || 0) + 1;
    for (const c of progression.unlockedCards(s)) cards[c]++;
  }
  const n = rows.length || 1;
  return {
    players: rows.length,
    byLevel: Object.entries(levels).map(([level, count]) => ({ level: Number(level), count, share: Math.round((count / n) * 1000) / 10 })).sort((a, b) => a.level - b.level),
    byCard: Object.entries(cards).map(([id, count]) => ({ id, name: sabotage.CARDS[id].name, count, share: Math.round((count / n) * 1000) / 10 })).sort((a, b) => b.share - a.share),
  };
}

function createFireAdminRouter({ db, gameEngine, getOnlineSettings }) {
  const r = express.Router();

  r.get('/state', async (req, res) => {
    const cat = curated.load();
    const stats = db.listMarketStats ? await db.listMarketStats(new Date(Date.now() - 86400000).toISOString()).catch(() => null) : null;
    const rows = stats || gameEngine.getMarketStats();
    const online = presence.listOnline();
    const states = { online: 0, in_match: 0, in_lobby: 0, away: 0 };
    for (const id of online) states[presence.getPresence(id).status] = (states[presence.getPresence(id).status] || 0) + 1;
    const settings = await getOnlineSettings(online).catch(() => []);
    const priv = settings.map((s) => discover.privacy(s));
    const share = (f) => (priv.length ? Math.round((priv.filter(f).length / priv.length) * 1000) / 10 : null);
    const lobbies = ['quick', 'grand'].flatMap((m) => gameEngine.listWaitingMatchesByMode(m)).map((m) => ({ mode: m.mode, tier: m.lobbyTier || 'shared pool', players: Object.keys(m.players).length }));
    res.json({
      config: gameFeel.get(),
      overrides: gameFeel.getOverrides(),
      defaults: gameFeel.DEFAULTS,
      catalog: cat ? { ranking: cat.ranking, excluded: cat.excluded, cutoffAfterRank: cat.cutoffAfterRank, instruments: Object.fromEntries(Object.entries(cat.instruments).map(([s, v]) => [s, { class: v.class, score: v.score, activeMinutes: v.activeMinutes, segments: v.segments, seams: v.seams, validStarts: v.validStarts, spikes: v.spikes, bandPct: v.bandPct, windows: v.windows.slice(0, 40), comp: v.comp ? { activeMinutes: v.comp.activeMinutes } : null, sessionHint: v.sessionHint }])) } : null,
      monitor: monitor(rows),
      monitorSource: stats ? 'match_market_stats (database)' : 'this server, last 24h (database table not created yet)',
      rebuild,
      presence: { total: online.length, ...states },
      privacyAdoption: { sample: priv.length, appearOffline: share((p) => p.appearOffline), statusFriendsOrNobody: share((p) => p.statusVisibility !== 'everyone'), hiddenFromDiscover: share((p) => !p.showInDiscover), requestsNotEveryone: share((p) => p.requestsFrom !== 'everyone') },
      rankSplit: { enabled: rankSplit.enabled(), lobbies, suggestedTrigger: `turn on when concurrent players in public matches stay above ${gameFeel.get().rankSplit.suggestedTriggerConcurrent}` },
      tables: db.fireTablesStatus ? db.fireTablesStatus() : null,
      tours: { config: toursConfig.get(), overrides: toursConfig.getOverrides() },
      modes: { defaults: modeIdentity.DEFAULTS, overrides: modeIdentity.getOverrides(), effective: Object.fromEntries(Object.keys(modeIdentity.DEFAULTS).map((k) => [k, modeIdentity.identity(k)])), live: gameEngine.getModeCounts ? gameEngine.getModeCounts() : {} },
    });
  });

  r.post('/reload', async (req, res) => {
    const cfg = await loadConfig(db);
    res.json({ success: true, config: cfg });
  });

  r.post('/rebuild', async (req, res) => res.json(await startRebuild()));
  r.get('/rebuild', (req, res) => res.json(rebuild));

  r.post('/card-grant', async (req, res) => {
    try {
      const { playerId, cardId, revoke, reason } = req.body || {};
      if (!sabotage.CARDS[cardId]) return res.status(400).json({ error: 'Unknown card' });
      if (!reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'A reason is required' });
      await db.setCardGrant(playerId, cardId, { revoke: Boolean(revoke), reason });
      res.json({ success: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get('/unlock-report', async (req, res) => {
    try {
      res.json((await unlockReport(db)) || { error: 'database not configured' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}

module.exports = { createFireAdminRouter, loadConfig, flatAlertHandler, monitor, startRebuild };
