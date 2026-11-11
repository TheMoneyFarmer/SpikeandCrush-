'use strict';

// The walkthrough: every tour, its version and its steps. Each step points at
// a real element through a data-tour anchor (data-tour="name" in the page);
// a step whose anchor is missing on screen shows centred instead of breaking.
// Admin (Fire Gameplay > Walkthrough) can switch tours off and edit any
// title/body; overrides live in game_config key 'tours'. Raising a tour's
// version shows it again to players who finished an older one - the lobby
// tour shows the shorter "What's new" steps instead of the full tour.
// Progress is per account: players.settings.tours[tourId] = { v, outcome, step, at }.

const DEFAULTS = {
  enabled: true,
  tours: {
    lobby: {
      version: 2,
      page: 'lobby',
      label: 'Lobby tour',
      steps: [
        { anchor: null, title: 'Welcome to Spike & Crush', body: 'Trade real market history against other players, sabotage the leader with cards, and finish with the highest equity. This takes about a minute.' },
        { anchor: 'modes', title: 'Pick a mode', body: 'Seven modes with the same trading rules and the same money maths. What changes is the length, the cards and how you win.' },
        { anchor: 'mode-quick', title: 'New? Start here', body: 'Quick War is the full game: 10 minutes, up to 4 cards, highest equity wins. The lobby marks your last mode so it is one tap next time.' },
        { anchor: 'compare-modes', title: 'Compare modes', body: 'Not sure which to play? This puts every mode side by side: length, cards, how you win and what is special.' },
        { anchor: 'mode-tournament', title: 'Elimination', body: 'Every 3 minutes the bottom 20% are knocked out. Stay out of the bottom and survive to win.' },
        { anchor: 'mode-solo', title: 'Practice free', body: 'Solo Ranked is free and always open, with no sabotage. Race the ghost of your own best run.' },
        { anchor: 'join-private', title: 'Play with friends', body: 'Got a 6 digit code? Join a Private War here. Hosting your own lets you set the house rules.' },
        { anchor: 'featured', title: 'Competitions', body: 'Longer events on one account, from a day to a month, with coin prizes.' },
      ],
    },
    whatsNew: {
      version: 1,
      page: 'lobby',
      label: "What's new",
      // Shown instead of the full lobby tour to players who finished an older lobby version.
      steps: [
        { anchor: 'modes', title: 'Every mode plays differently now', body: 'Each mode has its own cards and its own way to win. Tap Compare modes to see them side by side.' },
        { anchor: 'mode-tournament', title: 'New: Elimination', body: 'A cut every 3 minutes: the bottom 20% are knocked out. The Lifeline card saves you once.' },
        { anchor: 'mode-grand', title: 'Grand War market events', body: 'Start with 2 cards. Three of the biggest real moves of the session land near minutes 5, 10 and 15.' },
        { anchor: 'mode-solo', title: 'Solo ghost', body: 'Solo Ranked now shows the ghost of your best run, second by second.' },
      ],
    },
    firstMatch: {
      version: 1,
      page: 'game',
      label: 'First match (Solo Ranked)',
      // Runs in the player's first Solo Ranked match, after the rules card.
      modes: ['solo'],
      steps: [
        { anchor: 'chart', title: 'The chart', body: 'Real market history, replayed. Nobody knows what comes next, including us.' },
        { anchor: 'instruments', title: 'Instruments', body: 'Switch between the instruments in this match here.' },
        { anchor: 'trade', title: 'Buy or sell', body: 'Buy if you think the price goes up, sell if you think it goes down. Pick the size first: bigger lots move faster both ways.' },
        { anchor: 'positions', title: 'Your positions', body: 'Open trades and their profit or loss. Close one any time, or set a stop loss and take profit.' },
        { anchor: 'strip', title: 'The match strip', body: 'Spike alerts, missions and, in Solo, the ghost of your best run show up here. It never covers the chart.' },
        { anchor: 'cards', title: 'Cards', body: 'Win trades in a row to earn cards. In Solo you only get defense cards; in other modes you can attack the leader.' },
        { anchor: 'standings', title: 'Standings', body: 'Highest equity when the clock hits zero wins. Good luck.' },
      ],
    },
    postMatch: {
      version: 1,
      page: 'results',
      label: 'After your first match',
      steps: [
        { anchor: 'result-you', title: 'Your result', body: 'Your P&L and place. Every mode pays the same way: the top four share the prize pool.' },
        { anchor: 'result-rewards', title: 'Rewards', body: 'Missions, XP and new cards you unlocked. Heat is a separate score and never changes your result.' },
        { anchor: 'result-actions', title: 'What next', body: 'Rematch the same table, challenge a friend on the same market, or watch the replay.' },
      ],
    },
    mode_blitz: {
      version: 1,
      page: 'game',
      label: 'Blitz War intro',
      modes: ['blitz'],
      steps: [
        { anchor: 'cards', title: 'Two slots, fast refill', body: 'One win earns a card, two in a row earn two. Play them: a card you hold at the buzzer is wasted.' },
        { anchor: 'strip', title: 'More spikes', body: 'Spike alerts come more often in Blitz. Three minutes, go.' },
      ],
    },
    mode_grand: {
      version: 1,
      page: 'game',
      label: 'Grand War intro',
      modes: ['grand'],
      steps: [
        { anchor: 'strip', title: 'Market events', body: 'Near minutes 5, 10 and 15 the strip says "Market event": one of the biggest real moves of the session. The direction is never shown.' },
        { anchor: 'standings', title: 'Half-time', body: 'At minute 10 the half-time card shows the top five. The Steady Hand badge goes to the top-three finisher with the smallest dip from their peak.' },
      ],
    },
    mode_tournament: {
      version: 1,
      page: 'game',
      label: 'Elimination intro',
      modes: ['tournament'],
      steps: [
        { anchor: 'strip', title: 'Cut in 0:30', body: 'Before each cut the strip counts down. At 3, 6, 9 and 12 minutes the bottom 20% are knocked out.' },
        { anchor: 'standings', title: 'Danger', body: 'A Danger tag means you would go out if the cut happened now. Climb out before the clock runs down.' },
        { anchor: 'cards', title: 'Lifeline', body: 'If you hold Lifeline, play it before a cut you will not survive. It works once per match.' },
      ],
    },
    mode_async: {
      version: 1,
      page: 'game',
      label: 'Daily Challenge intro',
      modes: ['async'],
      steps: [
        { anchor: 'strip', title: 'Today\'s ghost', body: 'The same market for everyone today. The strip shows the ghost of today\'s best run so far.' },
      ],
    },
    mode_private: {
      version: 1,
      page: 'game',
      label: 'Private War intro',
      modes: ['private'],
      steps: [
        { anchor: 'strip', title: 'House rules', body: 'The host set the rules for this room. They were on the card before the start and stay the same all match.' },
      ],
    },
  },
};

let overrides = {};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function applyOverrides(partial) {
  overrides = isObj(partial) ? partial : {};
}

function getOverrides() {
  return overrides;
}

// Overrides: { enabled, tours: { id: { enabled, version, steps: [{ title, body }] } } }.
// Step text overrides by index; anchors stay as built (they point at real elements).
function get() {
  const out = { enabled: overrides.enabled !== false && DEFAULTS.enabled, tours: {} };
  for (const [id, base] of Object.entries(DEFAULTS.tours)) {
    const o = (isObj(overrides.tours) && isObj(overrides.tours[id]) && overrides.tours[id]) || {};
    const steps = base.steps.map((s, i) => {
      const so = Array.isArray(o.steps) && isObj(o.steps[i]) ? o.steps[i] : {};
      return { anchor: s.anchor, title: typeof so.title === 'string' && so.title.trim() ? so.title.slice(0, 120) : s.title, body: typeof so.body === 'string' && so.body.trim() ? so.body.slice(0, 600) : s.body };
    });
    out.tours[id] = { ...base, version: Number.isInteger(o.version) && o.version > 0 ? o.version : base.version, enabled: o.enabled !== false, steps };
  }
  return out;
}

module.exports = { DEFAULTS, applyOverrides, getOverrides, get };
