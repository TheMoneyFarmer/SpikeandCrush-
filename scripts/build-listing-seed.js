#!/usr/bin/env node
'use strict';

// Builds data/seed/competition-listings.json and the generated logo files in
// client/img/listings/. Invented brands only, all tagged Preview. The random
// seed is fixed and printed, so the same file comes out every time.
//   node scripts/build-listing-seed.js

const fs = require('fs');
const path = require('path');
const { logoSvg } = require('../server/listingLogos');

const SEED = 20261112;
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickN = (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };
const money = () => (1 + Math.floor(rnd() * 30)) * 1000; // $1,000 to $30,000 in $1,000 steps
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const COUNTRIES = ['GB', 'CY', 'AE', 'AU', 'SG', 'NL', 'CZ', 'IE'];
const ASSETS = ['FX', 'Indices', 'Metals', 'Crypto', 'Energy'];
const PLATFORMS = ['MT5', 'MT4', 'cTrader', 'Web'];

const PROP = [
  ['Corvane Funding', 'Monthly challenge race'],
  ['Tidewell Trader Fund', 'Payout sprint'],
  ['Pellmont Capital Desk', 'Demo cup'],
  ['Brightfold Funded', 'Monthly challenge race'],
  ['Ostrava Peak Traders', 'Payout sprint'],
  ['Kestrine Funding Lab', 'Demo cup'],
];
const BROKERS = [
  ['Larkspur Markets', 'Raw spread account'],
  ['Venmoor FX', 'Standard account'],
  ['Quillstone Brokers', 'Zero commission account'],
  ['Harrowgate Capital', 'Pro account'],
  ['Selwyn Bay Markets', 'Standard account'],
];
const SPONSORED = [
  ['Glintdesk', 'A trading laptop', 'Top 3 of the Daily Open this week'],
  ['Northbeam Gear', 'A trading desktop', 'Best weekend trader'],
  ['Copperline Studios', 'A new phone', 'Highest return in the Weekend Open'],
  ['Arcwell Setups', 'A games console', 'Top 5 of the Daily Open on Friday'],
  ['Embervale Rigs', 'A dual-monitor setup', 'Most consistent trader this month'],
  ['Tallowfield Academy', 'A trading course bundle', 'Top 10 of the Weekend Open'],
];

// Tiers: 2 Featured, 4 Plus, the rest Standard.
const TIER = { 'prop:0': 'featured', 'broker:0': 'featured', 'prop:1': 'plus', 'prop:3': 'plus', 'broker:2': 'plus', 'sponsored:0': 'plus' };

const listings = [];
PROP.forEach(([name, kind], i) => {
  const days = pick([14, 21, 30]);
  listings.push({
    seedKey: `seed-prop-${i + 1}`, type: 'prop', preview: true,
    organizer: { name, country: pick(COUNTRIES), years: 1 + Math.floor(rnd() * 9), rating: Math.round((3.6 + rnd() * 1.3) * 10) / 10 },
    title: `${name.split(' ')[0]} ${kind === 'Demo cup' ? 'Demo Cup' : kind === 'Payout sprint' ? 'Payout Sprint' : 'Challenge Race'}`,
    kind, prize: { kind: 'money', amount: money(), currency: 'USD' },
    rules: [`Max daily loss ${pick([4, 5, 6])}%`, `Target ${pick([6, 8, 10])}%`, `${days} days`, pick(PLATFORMS)],
    assets: pickN(ASSETS, 2 + Math.floor(rnd() * 3)),
    platforms: pickN(PLATFORMS, 1 + Math.floor(rnd() * 2)),
    startsInDays: 7 + Math.floor(rnd() * 21), lengthDays: days,
    tier: TIER[`prop:${i}`] || 'standard', listedDaysAgo: Math.floor(rnd() * 30),
    summary: `A ${kind.toLowerCase()} run on ${name}'s own platform. Their rules apply.`,
  });
});
BROKERS.forEach(([name, account], i) => {
  const lev = pick(['1:30', '1:100', '1:200', '1:500']);
  listings.push({
    seedKey: `seed-broker-${i + 1}`, type: 'broker', preview: true,
    organizer: { name, country: pick(COUNTRIES), years: 2 + Math.floor(rnd() * 14), rating: Math.round((3.5 + rnd() * 1.4) * 10) / 10 },
    title: `${name.split(' ')[0]} Trading Cup`,
    kind: 'Live account contest', prize: { kind: 'money', amount: money(), currency: 'USD' },
    accountType: account, leverage: `Up to ${lev}`, instruments: pickN(ASSETS, 3),
    platforms: pickN(PLATFORMS, 1 + Math.floor(rnd() * 2)),
    rules: [account, `Leverage up to ${lev}`, `${pick([14, 30])} days`],
    assets: pickN(ASSETS, 3),
    startsInDays: 7 + Math.floor(rnd() * 21), lengthDays: pick([14, 30]),
    tier: TIER[`broker:${i}`] || 'standard', listedDaysAgo: Math.floor(rnd() * 30),
    summary: `A contest for ${name} account holders. The broker's terms apply.`,
  });
});
SPONSORED.forEach(([name, prize, how], i) => {
  listings.push({
    seedKey: `seed-sponsored-${i + 1}`, type: 'sponsored', preview: true,
    organizer: { name, country: null, years: null, rating: null },
    title: `Win ${prize.toLowerCase().replace(/^a /, 'a ').replace(/^an /, 'an ')}`,
    kind: 'Sponsored prize', prize: { kind: 'goods', text: prize },
    howToWin: how, rules: [how],
    assets: [], platforms: [],
    startsInDays: 7 + Math.floor(rnd() * 21), lengthDays: pick([2, 5, 7]),
    tier: TIER[`sponsored:${i}`] || 'standard', listedDaysAgo: Math.floor(rnd() * 30),
    summary: `${name} gives ${prize.toLowerCase()} to the winner. The offer is applied automatically through our link.`,
  });
});
for (const l of listings) {
  l.slug = slugify(`${l.organizer.name} ${l.title}`).slice(0, 60);
  l.organizer.logo = `/img/listings/${slugify(l.organizer.name)}.svg`;
  l.organizer.logoDark = l.organizer.logo;
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'data', 'seed'), { recursive: true });
fs.mkdirSync(path.join(root, 'client', 'img', 'listings'), { recursive: true });
fs.writeFileSync(path.join(root, 'data', 'seed', 'competition-listings.json'), `${JSON.stringify({ seed: SEED, note: 'Invented brands for Preview listings. Replace one by one in admin as real partners sign.', listings }, null, 2)}\n`);
for (const l of listings) fs.writeFileSync(path.join(root, 'client', l.organizer.logo), logoSvg(l.organizer.name, 'dark'));
console.log(`seed ${SEED}: ${listings.length} listings (${PROP.length} prop firms, ${BROKERS.length} brokers, ${SPONSORED.length} sponsored)`);
for (const l of listings) console.log(`  ${l.type.padEnd(9)} ${l.tier.padEnd(8)} ${l.organizer.name.padEnd(22)} ${l.prize.kind === 'money' ? `$${l.prize.amount.toLocaleString('en-US')}` : l.prize.text}  listed ${l.listedDaysAgo}d ago`);
