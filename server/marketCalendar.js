'use strict';

// Market calendar: when each instrument class trades, in New York time
// (DST aware through Intl). A competition's pool includes a class only if its
// market is open for the WHOLE window - nothing is faked open.
//
//   crypto       always
//   forex        Sunday 17:00 to Friday 17:00
//   metals, commodities, indices, futures (CME Globex style)
//                Sunday 18:00 to Friday 17:00, closed 17:00-18:00 Monday-Thursday
//   stocks       Monday-Friday 09:30-16:00, closed on NYSE holidays
//
// Approximations (stated, not hidden): early closes (13:00 days) are treated
// as full days; product-specific hours (e.g. softs) use the Globex hours.

const TZ = 'America/New_York';
const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const CLASSES = ['forex', 'metals', 'indices', 'commodities', 'crypto', 'stocks', 'futures'];
const CLASS_LABEL = { forex: 'Forex', metals: 'Metals', indices: 'Indices', commodities: 'Energy', crypto: 'Crypto', stocks: 'Stocks', futures: 'Futures' };

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function ny(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { dow, minutes: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

function openAt(cls, ms) {
  const { dow, minutes, date } = ny(ms);
  switch (cls) {
    case 'crypto':
      return true;
    case 'forex':
      if (dow === 6) return false;
      if (dow === 0) return minutes >= 17 * 60;
      if (dow === 5) return minutes < 17 * 60;
      return true;
    case 'metals':
    case 'commodities':
    case 'indices':
    case 'futures':
      if (dow === 6) return false;
      if (dow === 0) return minutes >= 18 * 60;
      if (dow === 5) return minutes < 17 * 60;
      return !(minutes >= 17 * 60 && minutes < 18 * 60);
    case 'stocks':
      if (dow === 0 || dow === 6 || NYSE_HOLIDAYS.has(date)) return false;
      return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
    default:
      return false;
  }
}

// Open for the whole window [startMs, endMs)? Checked every 5 minutes plus
// both ends (no market here opens or closes off a 5-minute boundary).
function openThroughout(cls, startMs, endMs) {
  const step = 5 * 60 * 1000;
  for (let t = startMs; t < endMs; t += step) if (!openAt(cls, t)) return false;
  return openAt(cls, Math.max(startMs, endMs - 1000));
}

function openClasses(startMs, endMs, classes = CLASSES) {
  return classes.filter((c) => openThroughout(c, startMs, endMs));
}

// The competition pool for a window: every instrument whose class is open
// throughout, from the given instrument registry ({ SYMBOL: { category } }).
function poolFor(startMs, endMs, registry, { classes = CLASSES } = {}) {
  const open = new Set(openClasses(startMs, endMs, classes));
  const symbols = Object.entries(registry).filter(([, cfg]) => open.has(cfg.category)).map(([sym]) => sym);
  return { classes: [...open], labels: [...open].map((c) => CLASS_LABEL[c]), symbols };
}

module.exports = { openAt, openThroughout, openClasses, poolFor, CLASSES, CLASS_LABEL, NYSE_HOLIDAYS, TZ };
