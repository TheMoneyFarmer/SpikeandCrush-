'use strict';

// Security headers for every response (game server and admin panel). No
// dependency: these are the headers helmet would set, written out so each one
// is visible and reviewable. Audit items 29/36: the live site sent none.
//
// CSP notes: the pages still use inline <script> blocks and onclick handlers,
// so 'unsafe-inline' is needed for scripts for now; the policy still blocks
// scripts from any host not listed, plugins, framing and base-tag hijacks.
// Tighten to nonces when the inline scripts are moved into files.

function buildCsp({ supabaseUrl = process.env.SUPABASE_URL || '', admin = false } = {}) {
  let supabaseHost = '';
  try { supabaseHost = new URL(supabaseUrl).host; } catch (e) { /* unset in tests */ }
  const supa = supabaseHost ? [`https://${supabaseHost}`, `wss://${supabaseHost}`] : [];
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", ...supa, 'https://cdn.jsdelivr.net'],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", 'https://checkout.stripe.com', ...(admin ? [] : ['https://discord.com'])],
    'upgrade-insecure-requests': [],
  };
  return Object.entries(directives).map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k)).join('; ');
}

function securityHeaders(options = {}) {
  const csp = buildCsp(options);
  const isProd = process.env.NODE_ENV === 'production';
  return function setSecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.stripe.com")');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // HSTS only over HTTPS (Railway terminates TLS; req.secure honours trust proxy).
    if (req.secure || isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
  };
}

module.exports = { securityHeaders, buildCsp };
