'use strict';

// Account statement as a PDF, written by hand (no PDF dependency): A4 pages,
// the built-in Helvetica fonts, brand colours as filled shapes. Game-mode
// statements show amounts as plain numbers (no currency symbol); coins are
// shown as coins.
//
// Integrity: the SHA-256 of the finished file is recorded with an HMAC
// signature (server secret), so a statement someone sends back in a dispute
// can be checked against what the server actually issued.

const crypto = require('crypto');

const W = 595;
const H = 842;
const M = 36;
const GOLD = [0.961, 0.722, 0.239];
const INK = [0.027, 0.035, 0.059];
const PANEL = [0.055, 0.075, 0.125];
const MUTED = [0.45, 0.49, 0.56];
const SPIKE = [0.07, 0.56, 0.41];
const CRUSH = [0.82, 0.2, 0.26];

// PDF strings: ASCII only, with ( ) \ escaped.
function pdfText(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

const fmt = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? '-' : Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPrice = (x) => (x == null ? '-' : String(Number(x)));
const fmtTime = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 19) : '-');
const rgb = (c, op) => `${c.map((v) => v.toFixed(3)).join(' ')} ${op}`;

function createPage() {
  const ops = [];
  return {
    ops,
    rect(x, y, w, h, color) { ops.push(`${rgb(color, 'rg')} ${x} ${y} ${w} ${h} re f`); },
    line(x1, y1, x2, y2, color, width = 0.5) { ops.push(`${rgb(color, 'RG')} ${width} w ${x1} ${y1} m ${x2} ${y2} l S`); },
    text(x, y, s, { size = 9, bold = false, color = INK } = {}) {
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color, 'rg')} ${x} ${y} Td (${pdfText(s)}) Tj ET`);
    },
    // Right-aligned, using Helvetica's average width (good enough for numbers).
    textRight(x, y, s, opts = {}) {
      const size = opts.size || 9;
      const width = pdfText(s).length * size * 0.53;
      this.text(x - width, y, s, opts);
    },
  };
}

function buildPdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const stream = p.ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// account: the object from records.loadAccount(). meta: { statementId, generatedAt }.
function renderStatement(account, meta = {}) {
  const pages = [];
  let page = null;
  let y = 0;
  const s = account.summary;
  const title = account.kind === 'match'
    ? `${account.match ? account.match.mode : 'match'} war${account.match && account.match.room_code ? ` - room ${account.match.room_code}` : ''}`
    : (account.competition && account.competition.title) || 'competition';

  function newPage() {
    page = createPage();
    pages.push(page);
    page.rect(0, H - 70, W, 70, INK);
    page.rect(0, H - 73, W, 3, GOLD);
    page.text(M, H - 34, 'SPIKE & CRUSH', { size: 16, bold: true, color: GOLD });
    page.text(M, H - 52, 'Account statement', { size: 10, color: [0.91, 0.93, 0.96] });
    page.textRight(W - M, H - 34, `Account ${account.accountNumber}`, { size: 12, bold: true, color: [0.91, 0.93, 0.96] });
    page.textRight(W - M, H - 52, `Page ${pages.length}`, { size: 9, color: [0.6, 0.64, 0.72] });
    y = H - 100;
  }
  function need(h) { if (y - h < M + 30) newPage(); }

  newPage();
  page.text(M, y, `Player: ${account.player ? account.player.username : '-'}`, { size: 10, bold: true }); y -= 14;
  page.text(M, y, `Played: ${title}`, { size: 9 }); y -= 12;
  const when = account.kind === 'match'
    ? `${fmtTime(account.match && (account.match.start_time || account.match.created_at))} to ${fmtTime(account.match && account.match.end_time)} UTC`
    : `${fmtTime(account.competition && account.competition.starts_at)} to ${fmtTime(account.competition && account.competition.ends_at)} UTC`;
  page.text(M, y, `Period: ${when}`, { size: 9 }); y -= 12;
  page.text(M, y, `Final rank: ${account.finalRank ?? '-'}    Amounts are game capital, not money. Coins have no cash value.`, { size: 8, color: MUTED }); y -= 22;

  // Summary block
  page.rect(M, y - 104, W - 2 * M, 110, [0.95, 0.96, 0.98]);
  const cells = [
    ['Starting capital', fmt(s.startingCapital)], ['Balance', fmt(s.balance)], ['Equity', fmt(s.equity)], ['Net profit', fmt(s.netProfit)],
    ['Gross profit', fmt(s.grossProfit)], ['Gross loss', fmt(s.grossLoss)], ['Profit factor', s.profitFactor == null ? '-' : fmt(s.profitFactor)], ['Win rate', s.winRate == null ? '-' : `${fmt(s.winRate, 1)}%`],
    ['Max drawdown', s.maxDrawdown == null ? '-' : `${fmt(s.maxDrawdown)} (${fmt(s.maxDrawdownPct, 1)}%)`], ['Margin level at close', s.marginLevel == null ? '-' : `${fmt(s.marginLevel, 1)}%`], ['Trades', `${s.trades} (${s.longTrades} long, ${s.shortTrades} short)`], ['Largest win / loss', `${fmt(s.largestWin)} / ${fmt(s.largestLoss)}`],
    ['Average win / loss', `${fmt(s.averageWin)} / ${fmt(s.averageLoss)}`], ['Average hold', s.averageHoldSeconds == null ? '-' : `${s.averageHoldSeconds}s`], ['Commission / swap', '0 / 0 (none in this game)'], ['Cards received / played', `${s.cardsReceived ?? '-'} / ${s.cardsPlayed ?? '-'}`],
  ];
  const colW = (W - 2 * M) / 4;
  cells.forEach(([k, v], i) => {
    const cx = M + 8 + (i % 4) * colW;
    const cy = y - 12 - Math.floor(i / 4) * 26;
    page.text(cx, cy, k, { size: 7, color: MUTED });
    page.text(cx, cy - 11, v, { size: 9, bold: true });
  });
  y -= 124;

  // Trades table
  const cols = [
    ['Ticket', 0], ['Open time', 50], ['Type', 140], ['Vol', 170], ['Symbol', 196], ['Open', 240], ['S/L', 290], ['T/P', 335], ['Close time', 380], ['Close', 466], ['Profit', 523],
  ];
  function header() {
    page.rect(M, y - 4, W - 2 * M, 16, PANEL);
    for (const [label, x] of cols) page.text(M + 3 + x, y, label, { size: 7, bold: true, color: GOLD });
    y -= 16;
  }
  page.text(M, y, 'Trades', { size: 11, bold: true }); y -= 16;
  header();
  for (const t of account.trades) {
    if (y < M + 50) { newPage(); header(); }
    const row = [
      t.ticket != null ? `#${t.ticket}` : '-', fmtTime(t.openTime), t.type, fmt(t.volume), t.symbol, fmtPrice(t.openPrice), fmtPrice(t.sl), fmtPrice(t.tp),
      fmtTime(t.closeTime), fmtPrice(t.closePrice), t.profit == null ? 'open' : fmt(t.profit),
    ];
    row.forEach((v, i) => page.text(M + 3 + cols[i][1], y, v, { size: 7, color: i === 10 && t.profit != null ? (t.profit >= 0 ? SPIKE : CRUSH) : INK }));
    y -= 10;
    if (t.comment) { page.text(M + 53, y, t.comment, { size: 6.5, color: MUTED }); y -= 9; }
    page.line(M, y + 5, W - M, y + 5, [0.88, 0.9, 0.93], 0.3);
  }
  if (!account.trades.length) { page.text(M + 3, y, 'No trades.', { size: 8, color: MUTED }); y -= 12; }

  need(40);
  y -= 12;
  page.text(M, y, `Statement ${meta.statementId || '-'} issued ${fmtTime(meta.generatedAt || new Date().toISOString())} UTC. Its SHA-256 is recorded by Spike & Crush;`, { size: 7, color: MUTED }); y -= 9;
  page.text(M, y, 'support can confirm a copy is genuine and unchanged. Prices and times are the game\'s market data; swap and commission do not exist in this game.', { size: 7, color: MUTED });

  return buildPdf(pages);
}

function statementSecret() {
  // Never an empty key (that would let anyone forge a statement signature).
  return require('./envCheck').signingSecret('statements', 'STATEMENT_SECRET', 'INTERNAL_ADMIN_SECRET', 'ADMIN_SECRET');
}

function signStatement(pdf) {
  const sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  const signature = crypto.createHmac('sha256', statementSecret()).update(sha256).digest('hex');
  return { sha256, signature };
}

function verifySignature(sha256, signature) {
  const expected = crypto.createHmac('sha256', statementSecret()).update(String(sha256)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Render, sign and record one statement. `generatedBy`: 'player' or an admin name.
async function issueStatement(sb, account, generatedBy) {
  const statementId = crypto.randomUUID();
  const pdf = renderStatement(account, { statementId, generatedAt: new Date().toISOString() });
  const { sha256, signature } = signStatement(pdf);
  const { error } = await sb.from('account_statements').insert({ id: statementId, account_number: account.accountNumber, sha256, signature, generated_by: String(generatedBy).slice(0, 120) });
  if (error) throw error;
  return { pdf, sha256, statementId };
}

// Given a file's hash: was it issued by us, for which account, and is the
// recorded signature still valid?
async function verifyStatementHash(sb, sha256) {
  const { data, error } = await sb.from('account_statements').select('id, account_number, sha256, signature, generated_by, created_at').eq('sha256', String(sha256).toLowerCase()).maybeSingle();
  if (error) throw error;
  if (!data) return { genuine: false };
  return { genuine: verifySignature(data.sha256, data.signature), statementId: data.id, accountNumber: Number(data.account_number), issuedAt: data.created_at, generatedBy: data.generated_by };
}

module.exports = { renderStatement, signStatement, verifySignature, issueStatement, verifyStatementHash, pdfText };
