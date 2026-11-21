'use strict';

// The event catalogue: every analytics event, who sends it, its properties and
// why it exists. Versioned: change a meaning -> bump SCHEMA_VERSION and note it.
// The collector refuses any client event not listed here as `client: true`.
//
// No event ever carries an email, a raw address, a token or free text typed
// by a player. Properties are short codes and numbers.

const SCHEMA_VERSION = 1;

const EVENTS = {
  // ---- visits (client, through the cookieless collector) ------------------------
  page_view: { client: true, props: [], purpose: 'Visitors and page views per page, landing pages, referrers, campaigns, devices, countries.' },
  signup_started: { client: true, props: ['location'], purpose: 'Funnel: opened the sign-up form.' },
  competition_viewed: { client: true, props: ['template'], purpose: 'Daily Open / Weekend Open page views, for view-to-entry conversion.' },
  support_opened: { client: true, props: [], purpose: 'Support chat opened.' },
  a2hs_shown: { client: true, props: ['platform'], purpose: 'Add to Home Screen prompt shown.' },
  a2hs_accepted: { client: true, props: ['platform'], purpose: 'Add to Home Screen accepted.' },
  a2hs_dismissed: { client: true, props: ['platform'], purpose: 'Add to Home Screen dismissed.' },
  app_installed: { client: true, props: ['platform'], purpose: 'The app was installed.' },
  orientation_landscape: { client: true, props: ['installed'], purpose: 'Game screen used in landscape on a phone.' },
  placement_impression: { client: false, props: ['slot'], purpose: 'A sponsor placement at least half visible for one second, once per visit (server writes it from /api/slots/seen).' },

  // ---- written by the server (ad blockers cannot drop these) --------------------
  signup_submitted: { client: false, props: ['method'], purpose: 'Funnel: account created (email or Google).' },
  email_verified: { client: false, props: [], purpose: 'Funnel: email address confirmed.' },
  login: { client: false, props: ['method'], purpose: 'A sign-in (not used for "active": see definitions.js).' },
  password_reset_requested: { client: false, props: [], purpose: 'Password reset link asked for.' },
  password_reset_completed: { client: false, props: [], purpose: 'New password set from a reset link.' },
  match_started: { client: false, props: ['ranked'], purpose: 'A human started a match (mode, device on the row).' },
  match_ended: { client: false, props: ['end_reason', 'rank', 'trades', 'cards'], purpose: 'A human finished, forfeited or dropped out of a match.' },
  trade_opened: { client: false, props: ['symbol_class'], purpose: 'A human opened a trade (never per price tick).' },
  card_played: { client: false, props: ['card'], purpose: 'A human played a card.' },
  spike_reacted: { client: false, props: ['reaction_ms'], purpose: 'A trade opened within 15 s after a spike alert, with the reaction time.' },
  invite_sent: { client: false, props: ['kind'], purpose: 'Friend request or in-lobby invite sent (kind: friend | lobby).' },
  invite_accepted: { client: false, props: ['kind'], purpose: 'Friend request or in-lobby invite accepted.' },
  discover_join: { client: false, props: [], purpose: 'Joined a match through Discover.' },
  private_room_created: { client: false, props: [], purpose: 'A Private War room was opened.' },
  private_room_joined: { client: false, props: [], purpose: 'Someone joined a Private War room they did not create.' },
  competition_entered: { client: false, props: ['template'], purpose: 'Entered a competition.' },
  placement_click: { client: false, props: ['slot'], purpose: 'A sponsor placement was clicked (/go/:id), with the page that showed it.' },
  partner_link_click: { client: false, props: ['link'], purpose: 'A partner link was followed (/go/:id partner placement, /go/l listing, /go/c winner claim).' },
  winner_step: { client: false, props: ['step'], purpose: 'A competition winner moved a step (emailed, claimed, link clicked, registered, credited...).' },
  support_escalated: { client: false, props: ['topic'], purpose: 'A support chat went to a human.' },
  client_disconnect: { client: false, props: [], purpose: 'A player in a live match lost the connection.' },
  client_reconnect: { client: false, props: [], purpose: 'A player came back into a live match.' },
  client_freeze: { client: false, props: ['gap_ms'], purpose: 'A player reported missing more than 3 seconds of prices.' },
  probe: { client: false, props: ['visitor', 'path', 'blocked'], purpose: 'A bot asked for a secret or admin path (/.env, /.git, /wp-admin, *.php). Visitor is a hashed address, never the IP.' },
};

const CLIENT_EVENTS = new Set(Object.entries(EVENTS).filter(([, e]) => e.client).map(([k]) => k));

module.exports = { SCHEMA_VERSION, EVENTS, CLIENT_EVENTS };
