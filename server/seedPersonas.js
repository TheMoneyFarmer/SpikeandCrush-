'use strict';

// One-time (idempotent) script to create persistent DB accounts for every
// entry in personas.js, so the global leaderboard looks populated from day
// one. Run with: node server/seedPersonas.js
// Safe to re-run - existing persona usernames are skipped.

require('dotenv').config();
const db = require('./database');
const { TRADER_PERSONAS, RATING_RANGES } = require('./personas');

function tierForRating(rating) {
  if (rating >= 2200) return 'War Lord';
  if (rating >= 1800) return 'Elite';
  if (rating >= 1500) return 'Veteran';
  if (rating >= 1200) return 'Analyst';
  if (rating >= 900) return 'Broker';
  if (rating >= 600) return 'Trader';
  return 'Recruit';
}

function ratingForStyle(style) {
  const r = RATING_RANGES[style] || RATING_RANGES.aggressive;
  return r.min + Math.floor(Math.random() * (r.max - r.min));
}

async function seedPersonaAccounts() {
  let created = 0;
  let skipped = 0;
  for (const persona of TRADER_PERSONAS) {
    const existing = await db.getPlayerByUsername(persona.username);
    if (existing) {
      skipped++;
      continue;
    }
    const rating = ratingForStyle(persona.style);
    const wins = 20 + Math.floor(Math.random() * 80);
    const losses = 10 + Math.floor(Math.random() * 60);
    const total = wins + losses;
    const player = await db.createPlayer({
      username: persona.username,
      email: `${persona.username.toLowerCase()}@spikecrushtrade.internal`,
      passwordHash: null,
    });
    await db.updatePlayer(player.id, {
      war_rating: rating,
      tier: tierForRating(rating),
      wins,
      losses,
      total_matches: total,
      coins: 500,
      is_persona: true,
    });
    created++;
  }
  return { created, skipped };
}

if (require.main === module) {
  seedPersonaAccounts()
    .then(({ created, skipped }) => {
      console.log(`Seeded ${created} persona accounts, skipped ${skipped} already existing.`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('Seeding failed:', e);
      process.exit(1);
    });
}

module.exports = { seedPersonaAccounts };
