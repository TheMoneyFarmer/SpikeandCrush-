'use strict';

// The footer's social links. The owner sets them in admin (Branding, Social
// links); a platform with no link is simply not shown. Only links to that
// platform's own website are accepted, so a typo or a pasted link to anywhere
// else can never end up in every page's footer.

const SETTING_KEY = 'site.socials';

const PLATFORMS = [
  { key: 'instagram', label: 'Instagram', hosts: ['instagram.com'] },
  { key: 'x', label: 'X (Twitter)', hosts: ['x.com', 'twitter.com'] },
  { key: 'threads', label: 'Threads', hosts: ['threads.net', 'threads.com'] },
  { key: 'discord', label: 'Discord', hosts: ['discord.gg', 'discord.com'] },
  { key: 'facebook', label: 'Facebook', hosts: ['facebook.com', 'fb.com'] },
];

// '' clears a link. Anything else must be an https link to the platform itself
// (or one of its subdomains, like www.). Returns { url } or { error }.
function normalizeLink(platformKey, raw) {
  const platform = PLATFORMS.find((p) => p.key === platformKey);
  if (!platform) return { error: 'Unknown platform' };
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { url: '' };
  if (value.length > 300) return { error: `${platform.label}: link is too long` };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch (e) {
    return { error: `${platform.label}: that isn't a valid link` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: `${platform.label}: the link must start with https://` };
  if (url.username || url.password) return { error: `${platform.label}: that isn't a valid link` };
  const host = url.hostname.toLowerCase();
  if (!platform.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { error: `${platform.label}: the link must go to ${platform.hosts.join(' or ')}` };
  }
  url.protocol = 'https:';
  return { url: url.toString() };
}

// Saved settings, possibly old or hand-edited, to what the site shows: only
// platforms we know, only links that still pass the check.
function publicLinks(saved) {
  const out = [];
  for (const p of PLATFORMS) {
    const { url } = normalizeLink(p.key, saved && saved[p.key]);
    if (url) out.push({ key: p.key, label: p.label, url });
  }
  return out;
}

module.exports = { SETTING_KEY, PLATFORMS, normalizeLink, publicLinks };
