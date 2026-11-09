'use strict';

// The one source of truth for page titles, descriptions and indexing.
// scripts/apply-seo.js writes these into each HTML file's <head>; server/seo.js
// uses them for the X-Robots-Tag header, the sitemap and competition pages.
const SITE = 'https://www.spikeandcrush.com';
const THEME_COLOR = '#14213d';
const OG_IMAGE = `${SITE}/og-image.png`;
const OG_IMAGE_ALT = 'Spike & Crush, the competitive trading game. Up. Then not.';

// file -> tags. `path` is the canonical URL. Pages without `index: true` are noindex.
const PAGES = {
  'landing.html': { path: '/', index: true, title: 'Spike & Crush | The competitive trading game', description: 'Compete in live trading wars on real market data, sabotage your rivals and climb the board. Free to play. Up. Then not.' },
  'competitions.html': { path: '/competitions', index: true, title: 'Competitions | Spike & Crush', description: 'Daily, weekly and monthly trading wars with coin prize pools. See what is live and enter before entry closes.' },
  'leaderboard.html': { path: '/leaderboard', index: true, title: 'Leaderboard | Spike & Crush', description: 'See who leads the board. War Rating, tiers and the top traders in Spike & Crush.' },
  'help.html': { path: '/help', index: true, title: 'Help and rules | Spike & Crush', description: 'How matches, game modes, sabotage cards, coins and ratings work in Spike & Crush.' },
  'sponsor.html': { path: '/sponsor', index: true, title: 'Sponsor | Spike & Crush', description: 'Put your brand in front of traders: present a competition, a game mode or the lobby partner strip.' },
  'contact.html': { path: '/contact', index: true, title: 'Contact | Spike & Crush', description: 'Questions, account help or a partnership idea? Send a message or email hello@spikeandcrush.com.' },
  'terms.html': { path: '/terms', index: true, title: 'Terms of Service | Spike & Crush', description: 'The rules for using Spike & Crush, a simulated trading game. Coins have no cash value and cannot be withdrawn.' },
  'privacy.html': { path: '/privacy', index: true, title: 'Privacy Policy | Spike & Crush', description: 'What Spike & Crush collects, why, who processes it, how long it is kept and how to ask for it to be deleted.' },
  'cookies.html': { path: '/cookies', index: true, title: 'Cookie Policy | Spike & Crush', description: 'Which cookies and local storage Spike & Crush uses, what each one does and how to change your choice.' },
  'responsible.html': { path: '/responsible', index: true, title: 'Responsible Gaming | Spike & Crush', description: 'Keep playing Spike & Crush healthy: limits, taking breaks and where to find support.' },

  'competition-play.html': { path: '/competition', title: 'Competition | Spike & Crush', description: 'A live trading competition on Spike & Crush.' },
  'index.html': { path: '/play', title: 'Lobby | Spike & Crush', description: 'Pick a mode and start a match.' },
  'lobby.html': { path: '/lobby.html', title: 'Match lobby | Spike & Crush', description: 'Waiting for the match to start.' },
  'game.html': { path: '/game.html', title: 'Match | Spike & Crush', description: 'A live Spike & Crush match.' },
  'spectate.html': { path: '/spectate.html', title: 'Spectate | Spike & Crush', description: 'Watch a live Spike & Crush match.' },
  'replay.html': { path: '/replay', title: 'Replay | Spike & Crush', description: 'Watch a finished Spike & Crush match again.' },
  'clip.html': { path: '/clip', title: 'Clip | Spike & Crush', description: 'A moment from a Spike & Crush match.' },
  'async.html': { path: '/async', title: 'Daily Challenge | Spike & Crush', description: 'Everyone trades the same market window today. Beat the board.' },
  'cards.html': { path: '/cards', title: 'Cards | Spike & Crush', description: 'Your sabotage cards and saved deck.' },
  'shop.html': { path: '/shop', title: 'Shop | Spike & Crush', description: 'Spend your coins on cosmetics and cards.' },
  'battle-pass.html': { path: '/battle-pass', title: 'Battle Pass | Spike & Crush', description: 'Earn rewards by playing this season.' },
  'wallet.html': { path: '/wallet', title: 'Wallet | Spike & Crush', description: 'Your coin balance and history.' },
  'profile.html': { path: '/profile', title: 'Profile | Spike & Crush', description: 'Player profile and match history.' },
  'settings.html': { path: '/settings', title: 'Settings | Spike & Crush', description: 'Your account, sound and display settings.' },
  'analytics.html': { path: '/analytics', title: 'Analytics | Spike & Crush', description: 'Your trading stats.' },
  'tournament.html': { path: '/tournament', title: 'Tournament | Spike & Crush', description: 'A Spike & Crush tournament bracket.' },
  'tournaments.html': { path: '/tournaments', title: 'Tournaments | Spike & Crush', description: 'Spike & Crush tournaments.' },
  'auth-callback.html': { path: '/auth-callback', title: 'Signing in | Spike & Crush', description: 'Finishing your sign-in.' },
  'reset-password.html': { path: '/reset-password', title: 'Reset password | Spike & Crush', description: 'Choose a new password.' },
  'verify-email.html': { path: '/verify-email', title: 'Verify your email | Spike & Crush', description: 'Confirm your email address.' },
  'thanks.html': { path: '/thanks', title: 'Thanks | Spike & Crush', description: 'Thanks for getting in touch.' },
  '404.html': { path: '/404', title: 'Page not found | Spike & Crush', description: 'This page went down.' },
  '500.html': { path: '/500', title: 'Something went wrong | Spike & Crush', description: 'Something went wrong on our side.' },
};

// Sent as a header too, so non-HTML responses and redirects carry it.
const NOINDEX_PREFIXES = ['/thanks', '/invite/', '/r/', '/play', '/wallet', '/cards', '/shop', '/battle-pass', '/async', '/replay', '/clip', '/settings', '/analytics', '/profile', '/tournament', '/auth-callback', '/reset-password', '/verify-email', '/trading-floor'];

function isNoindexPath(path) {
  if (NOINDEX_PREFIXES.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`))) return true;
  if (path.endsWith('.html')) {
    const page = PAGES[path.slice(1)];
    return !page || !page.index;
  }
  return false;
}

const SITEMAP_PATHS = Object.values(PAGES).filter((p) => p.index).map((p) => p.path);

module.exports = { SITE, THEME_COLOR, OG_IMAGE, OG_IMAGE_ALT, PAGES, SITEMAP_PATHS, isNoindexPath };
