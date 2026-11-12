'use strict';

process.env.STATEMENT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const records = require('../server/records');
const pdf = require('../server/statementPdf');

const T0 = Date.parse('2026-11-12T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

// A scripted match with known trades (hand-computed below).
const rows = [
  { ticket: 1000101, deal: 5000101, direction: 'BUY', lots: 1, symbol: 'XAUUSD', entry_price: 2000, exit_price: 2003, pnl: 300, opened_at: at(10), closed_at: at(70), close_reason: 'take_profit', stop_loss: 1995, take_profit: 2003 },
  { ticket: 1000102, deal: 5000102, direction: 'SELL', lots: 0.5, symbol: 'EURUSD', entry_price: 1.1, exit_price: 1.102, pnl: -100, opened_at: at(20), closed_at: at(50), close_reason: 'stop_loss', stop_loss: 1.102 },
  { ticket: 1000103, deal: 5000103, direction: 'BUY', lots: 2, symbol: 'NAS100', entry_price: 18000, exit_price: 18002, pnl: 200, opened_at: at(80), closed_at: at(200), close_reason: 'sabotage' },
  { ticket: 1000104, deal: 5000104, direction: 'SELL', lots: 1, symbol: 'XAUUSD', entry_price: 2010, exit_price: 2014, pnl: -400, opened_at: at(210), closed_at: at(300), close_reason: 'match_end', backfilled: true },
];
const trades = rows.map(records.warTradeRow);

test('trade rows map to MT5 fields with game comments', () => {
  assert.strictEqual(trades[0].type, 'buy');
  assert.strictEqual(trades[1].type, 'sell');
  assert.strictEqual(trades[0].comment, 'TP hit');
  assert.strictEqual(trades[1].comment, 'SL hit');
  assert.strictEqual(trades[2].comment, 'force close by card');
  assert.strictEqual(trades[3].comment, 'match end; ids back-filled');
  assert.strictEqual(trades[0].swap, 0);
  assert.strictEqual(trades[0].commission, 0);
});

test('summary matches hand-computed figures', () => {
  // equity curve: 10000 -> 10300 (peak) -> 10100 -> 9900 -> 10000
  const curve = [{ t: 0, equity: 10000 }, { t: 70, equity: 10300 }, { t: 120, equity: 10100 }, { t: 250, equity: 9900 }, { t: 300, equity: 10000 }];
  const s = records.summarize({ trades, curve, closing: { equity: 10000, margin: 0, freeMargin: 10000, marginLevel: null, floatingPnl: 0 } });
  assert.strictEqual(s.grossProfit, 500); // 300 + 200
  assert.strictEqual(s.grossLoss, -500); // -100 - 400
  assert.strictEqual(s.netProfit, 0);
  assert.strictEqual(s.profitFactor, 1); // 500 / 500
  assert.strictEqual(s.winRate, 50); // 2 of 4
  assert.strictEqual(s.averageWin, 250);
  assert.strictEqual(s.averageLoss, -250);
  assert.strictEqual(s.largestWin, 300);
  assert.strictEqual(s.largestLoss, -400);
  assert.strictEqual(s.maxDrawdown, 400); // 10300 -> 9900
  assert.strictEqual(s.maxDrawdownPct, 3.88); // 400 / 10300
  assert.strictEqual(s.maxDrawdownAt, 250);
  assert.strictEqual(s.longTrades, 2);
  assert.strictEqual(s.shortTrades, 2);
  assert.strictEqual(s.averageHoldSeconds, 75); // (60 + 30 + 120 + 90) / 4
  assert.strictEqual(s.balance, 10000);
});

test('profit factor is empty with no losing trades; drawdown falls back to closed-trade balance', () => {
  const s = records.summarize({ trades: trades.slice(0, 1).concat(trades[2]) });
  assert.strictEqual(s.profitFactor, null);
  assert.strictEqual(s.maxDrawdown, 0);
  const s2 = records.summarize({ trades });
  // balance path: 10000, 9900 (t50), 10200 (t70), 10400 (t200), 10000 (t300) -> worst drop 400 from 10400
  assert.strictEqual(s2.maxDrawdown, 400);
});

test('CSV uses the MT5 positions column order and escapes text', () => {
  const csv = records.tradesCsv([{ ...trades[0], comment: 'TP hit, "fast"' }]);
  const [head, line] = csv.trim().split('\r\n');
  assert.strictEqual(head, 'Time,Position,Symbol,Type,Volume,Price,S / L,T / P,Time,Price,Commission,Swap,Profit,Deal,Comment,Data open (s),Data close (s)');
  assert.ok(line.startsWith('2026.11.12 10:00:10,1000101,XAUUSD,buy,1,2000,1995,2003,2026.11.12 10:01:10,2003,0,0,300,5000101,"TP hit, ""fast"""'));
});

test('modification log names the cause', () => {
  const log = records.modificationLog([
    { kind: 'sltp', real_at: at(30), data_s: 90, position_ref: 'p1', payload: { symbol: 'XAUUSD', before: { sl: null, tp: null }, after: { sl: 1995, tp: null }, by: 'player' } },
    { kind: 'sltp', real_at: at(40), data_s: 120, position_ref: 'p1', payload: { symbol: 'XAUUSD', before: { sl: 1995, tp: null }, after: { sl: 1999, tp: null }, by: 'card', card: 'stop_yank', attackerId: 'a1' } },
    { kind: 'close', payload: {} },
  ], (id) => (id === 'a1' ? 'rival' : null));
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].by, 'player');
  assert.strictEqual(log[1].by, 'card stop_yank by rival');
  assert.deepStrictEqual(log[1].after, { sl: 1999, tp: null });
});

test('PDF statement renders, spans pages for long histories, and its hash verifies', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ ...trades[i % 4], ticket: 2000000 + i }));
  const account = { kind: 'match', accountNumber: 48213907, player: { username: 'tester (x)' }, match: { mode: 'quick', room_code: 'ABCD', start_time: at(0), end_time: at(600) }, finalRank: 1, trades: many, summary: records.summarize({ trades: many }) };
  const file = pdf.renderStatement(account, { statementId: 'stmt-1', generatedAt: at(700) });
  const text = file.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(/\/Count [2-9]/.test(text), 'more than one page');
  assert.ok(text.includes('Account 48213907'));
  assert.ok(text.includes('tester \\(x\\)'), 'parentheses escaped');
  assert.ok(!/\$/.test(text.replace(/\/Length \d+/g, '')), 'no currency symbol on a game-mode statement');
  // xref offsets point at real objects
  const xref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.strictEqual(text.slice(xref, xref + 4), 'xref');
  const { sha256, signature } = pdf.signStatement(file);
  assert.strictEqual(sha256.length, 64);
  assert.ok(pdf.verifySignature(sha256, signature));
  assert.ok(!pdf.verifySignature(sha256, signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))));
  const changed = Buffer.from(file);
  changed[200] ^= 1;
  assert.notStrictEqual(pdf.signStatement(changed).sha256, sha256);
});
