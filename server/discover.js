'use strict';

// Discover (Part 3B): who a player may see, what they may see about them, who
// may contact whom, and how suggestions are ordered. Pure rules, no I/O - the
// routes in server/index.js load rows and call these. Extends the existing
// friends system (server/friendsHub.js, presence.js); it doesn't replace it.
//
// Location: nothing here ever returns a country, city, region, coordinates or
// distance. The only location-like data that exists is the country a player
// picked themselves in Settings; it is used silently as a small "proximity"
// weight in suggestion order and never leaves the server.

const gameFeel = require('./config/gameFeel');

const VIS = ['everyone', 'friends', 'nobody'];
const REQ = ['everyone', 'fof', 'nobody'];

// Account privacy with defaults. Legacy toggles keep working:
// showOnline=false -> appear offline; allowFriends=false -> requests from
// nobody; allowInvites=false -> invites only from friends.
function privacy(settings = {}) {
  const s = settings || {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    appearOffline: s.appearOffline === true || s.showOnline === false,
    statusVisibility: pick(s.statusVisibility, VIS, 'everyone'),
    activityVisibility: pick(s.activityVisibility, VIS, 'everyone'),
    showInDiscover: s.showInDiscover !== false,
    requestsFrom: s.allowFriends === false ? 'nobody' : pick(s.requestsFrom, REQ, 'everyone'),
    invitesFrom: s.allowInvites === false ? 'friends' : pick(s.invitesFrom, [...REQ, 'friends'], 'everyone'),
    allowJoinFromDiscover: s.allowJoinFromDiscover !== false,
  };
}

// The settings keys a player may change from the Settings page.
function sanitizePrivacyPatch(patch = {}) {
  const out = {};
  if (typeof patch.appearOffline === 'boolean') {
    out.appearOffline = patch.appearOffline;
    out.showOnline = !patch.appearOffline; // keep the legacy flag in step
  }
  if (VIS.includes(patch.statusVisibility)) out.statusVisibility = patch.statusVisibility;
  if (VIS.includes(patch.activityVisibility)) out.activityVisibility = patch.activityVisibility;
  if (typeof patch.showInDiscover === 'boolean') out.showInDiscover = patch.showInDiscover;
  if (REQ.includes(patch.requestsFrom)) {
    out.requestsFrom = patch.requestsFrom;
    out.allowFriends = patch.requestsFrom !== 'nobody';
  }
  if ([...REQ, 'friends'].includes(patch.invitesFrom)) {
    out.invitesFrom = patch.invitesFrom;
    out.allowInvites = patch.invitesFrom === 'everyone';
  }
  if (typeof patch.allowJoinFromDiscover === 'boolean') out.allowJoinFromDiscover = patch.allowJoinFromDiscover;
  return out;
}

// 'self' | 'friend' | 'fof' | 'stranger'
function relation(viewerId, targetId, { friendIds = new Set(), targetFriendIds = null } = {}) {
  if (viewerId === targetId) return 'self';
  if (friendIds.has(targetId)) return 'friend';
  if (targetFriendIds && [...targetFriendIds].some((id) => friendIds.has(id))) return 'fof';
  return 'stranger';
}

const allowedBy = (level, rel) => rel === 'self' || level === 'everyone' || (level === 'friends' && rel === 'friend');

// What this viewer may know about the target's presence. Hidden players and
// anyone the viewer can't see read as plain offline (never "hidden").
function presenceView(targetPresence, targetSettings, rel) {
  const p = privacy(targetSettings);
  const off = { state: 'offline' };
  if (rel !== 'self' && p.appearOffline) return off;
  if (!allowedBy(p.statusVisibility, rel)) return off;
  const st = (targetPresence && targetPresence.status) || 'offline';
  if (st === 'offline') return off;
  const state = st === 'in_match' ? 'in_match' : st === 'away' ? 'away' : 'online';
  const view = { state };
  if (allowedBy(p.activityVisibility, rel) && (st === 'in_match' || st === 'in_lobby')) {
    view.mode = targetPresence.mode || null;
    // A Join button only for a lobby that is still open, when the owner allows it.
    if (st === 'in_lobby' && targetPresence.lobbyId && p.allowJoinFromDiscover) view.joinLobbyId = targetPresence.lobbyId;
  }
  return view;
}

function canRequest(targetSettings, rel) {
  const p = privacy(targetSettings);
  if (p.requestsFrom === 'nobody') return false;
  if (p.requestsFrom === 'fof') return rel === 'friend' || rel === 'fof';
  return true;
}

function canInvite(targetSettings, rel) {
  const p = privacy(targetSettings);
  if (rel === 'friend') return true;
  if (p.invitesFrom === 'nobody' || p.invitesFrom === 'friends') return false;
  if (p.invitesFrom === 'fof') return rel === 'fof';
  return true;
}

// May this candidate appear in the viewer's Discover lists at all?
function listable(viewerId, cand, { blocked = new Set() } = {}) {
  if (!cand || cand.id === viewerId) return false;
  if (cand.is_persona) return false; // personas are never offered as people to befriend
  if (blocked.has(cand.id)) return false;
  if (cand.is_banned || (cand.banned_until && new Date(cand.banned_until) > new Date())) return false;
  const p = privacy(cand.settings);
  if (p.appearOffline || !p.showInDiscover) return false;
  return true;
}

// Suggestion score. ctx: { me, friendIds, fofCount(id), playedWith(Set),
// myModes(Set), theirModes(id)->Set, myHours(Set), theirHours(id)->Set }.
// The proximity part uses only the self-chosen country and is never returned.
function score(cand, ctx) {
  const w = gameFeel.get().discover.weights;
  let s = 0;
  const mutual = ctx.fofCount ? ctx.fofCount(cand.id) : 0;
  s += w.friendsOfFriends * Math.min(3, mutual);
  const gap = Math.abs((cand.war_rating || 1000) - ((ctx.me && ctx.me.war_rating) || 1000));
  s += w.similarRank * Math.max(0, 1 - gap / 1000);
  if (ctx.playedWith && ctx.playedWith.has(cand.id)) s += w.playedTogether;
  if (ctx.myModes && ctx.theirModes) {
    const theirs = ctx.theirModes(cand.id) || new Set();
    if ([...ctx.myModes].some((m) => theirs.has(m))) s += w.sameModes;
  }
  if (ctx.myHours && ctx.theirHours) {
    const theirs = ctx.theirHours(cand.id) || new Set();
    if ([...ctx.myHours].some((h) => theirs.has(h))) s += w.similarHours;
  }
  if (ctx.me && ctx.me.country && cand.country === ctx.me.country) s += w.proximity;
  return s;
}

// The only fields a Discover row ever carries. No location of any kind.
function row(cand, view, extra = {}) {
  return {
    id: cand.id,
    username: cand.username,
    avatarUrl: cand.avatar_url || null,
    tier: cand.tier || null,
    warRating: cand.war_rating ?? null,
    level: extra.level ?? null,
    title: extra.title ?? null,
    state: view.state,
    mode: view.mode || null,
    joinLobbyId: view.joinLobbyId || null,
    mutualFriends: extra.mutualFriends || 0,
    relation: extra.relation || 'stranger',
    canRequest: Boolean(extra.canRequest),
    canInvite: Boolean(extra.canInvite),
  };
}

function paginate(list, page = 0, size = gameFeel.get().discover.pageSize) {
  const p = Math.max(0, Number(page) || 0);
  return { items: list.slice(p * size, p * size + size), page: p, pageSize: size, total: list.length, hasMore: (p + 1) * size < list.length };
}

module.exports = { privacy, sanitizePrivacyPatch, relation, presenceView, canRequest, canInvite, listable, score, row, paginate };
