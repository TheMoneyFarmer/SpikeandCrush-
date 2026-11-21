'use strict';

const csvLoader = require('./csvLoader');
const curated = require('./curated');
const intrabar = require('./intrabar');
const actionEngine = require('./actionEngine');
const gameFeel = require('./config/gameFeel');
// Price steps per data second (Action Engine delivery; 1 = the old engine).
const deliverySteps = () => Math.max(1, Math.min(10, Math.floor(Number((gameFeel.get().market || {}).deliveryHz) || 1)));

// spread: the median ask - bid of the price source itself (Dukascopy tick
// data, London and New York mornings, 2026-11-11..18; scripts/measure-spreads.js).
// Futures are the exception: the real exchange's top-of-book spread, 1 tick on
// the deep contracts (equity-index micros, crude, gas, metals, euro, T-Bond)
// and 2 ticks on the thinner ones (owner decision 2026-11-22).
// dataFile is a substring match against the actual filenames in
// data/historical/ (which carry long date-stamped names) - see csvLoader.findFile.
// dukascopy is the instrument id scripts/fetch-market-data.js downloads into
// data/market/<SYMBOL>/ (m1/h1/d1) - when those files exist they take
// precedence over both dataFile and the synthetic fallback.
// EURUSD/XAUUSD keep dataFile: null and the exact basePrice/volatility/spread
// the existing (pre-expansion) synthetic engine already used, so their behavior
// is unchanged for players still in a plain Quick War.
const INSTRUMENTS = {
  // ---- forex ----------------------------------------------------------------
  EURUSD: {
    name: 'EUR/USD', category: 'forex', nickname: ['fiber', 'euro', 'eurusd'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00003, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.08, volatility: 0.0002, dukascopy: 'eurusd',
  },
  GBPUSD: {
    name: 'GBP/USD', category: 'forex', nickname: ['cable', 'pound', 'sterling'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00005, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.27, volatility: 0.00025, dukascopy: 'gbpusd',
  },
  USDJPY: {
    name: 'USD/JPY', category: 'forex', nickname: ['yen', 'dollar yen', 'usdjpy'],
    pipSize: 0.01, pipValue: 9.1, spread: 0.004, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 3, dataFile: null, basePrice: 149.5, volatility: 0.03, dukascopy: 'usdjpy',
  },
  USDCHF: {
    name: 'USD/CHF', category: 'forex', nickname: ['swissy', 'swiss franc'],
    pipSize: 0.0001, pipValue: 10.9, spread: 0.00008, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.88, volatility: 0.00022, dukascopy: 'usdchf',
  },
  AUDUSD: {
    name: 'AUD/USD', category: 'forex', nickname: ['aussie', 'australian'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00008, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.66, volatility: 0.00022, dukascopy: 'audusd',
  },
  USDCAD: {
    name: 'USD/CAD', category: 'forex', nickname: ['loonie', 'canadian'],
    pipSize: 0.0001, pipValue: 7.4, spread: 0.00011, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 1.36, volatility: 0.00022, dukascopy: 'usdcad',
  },
  NZDUSD: {
    name: 'NZD/USD', category: 'forex', nickname: ['kiwi', 'new zealand'],
    pipSize: 0.0001, pipValue: 10, spread: 0.00009, contractSize: 100000,
    minLot: 0.01, maxLot: 100, decimals: 5, dataFile: null, basePrice: 0.61, volatility: 0.00025, dukascopy: 'nzdusd',
  },

  // ---- metals -----------------------------------------------------------------
  XAUUSD: {
    name: 'Gold', category: 'metals', nickname: ['gold', 'xauusd', 'yellow metal'],
    pipSize: 0.01, pipValue: 1, spread: 0.51, contractSize: 100,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: null, basePrice: 1950.0, volatility: 0.5, dukascopy: 'xauusd',
  },
  XAGUSD: {
    name: 'Silver', category: 'metals', nickname: ['silver', 'xagusd'],
    pipSize: 0.001, pipValue: 5, spread: 0.033, contractSize: 5000,
    minLot: 0.01, maxLot: 50, decimals: 3, dataFile: null, basePrice: 23.5, volatility: 0.05, dukascopy: 'xagusd',
  },

  // ---- indices ------------------------------------------------------------
  NAS100: {
    name: 'NASDAQ 100', category: 'indices', nickname: ['nasdaq', 'nas', 'tech index', 'hundred'],
    pipSize: 0.1, pipValue: 1, spread: 1, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 2, dataFile: 'USATECH.IDX', basePrice: 14037, volatility: 8, dukascopy: 'usatechidxusd',
  },
  US30: {
    name: 'Dow Jones', category: 'indices', nickname: ['dow', 'dow jones', 'usa30', 'thirty'],
    pipSize: 0.1, pipValue: 1, spread: 1.53, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 2, dataFile: 'USA30.IDX', basePrice: 24731, volatility: 10, dukascopy: 'usa30idxusd',
  },
  UK100: {
    name: 'FTSE 100', category: 'indices', nickname: ['ftse', 'footsie', 'uk100'],
    pipSize: 0.1, pipValue: 1.27, spread: 1, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 1, dataFile: null, basePrice: 7650, volatility: 8, dukascopy: 'gbridxgbp',
  },
  GER40: {
    name: 'DAX 40', category: 'indices', nickname: ['dax', 'german index', 'ger40'],
    pipSize: 0.1, pipValue: 1, spread: 1.1, contractSize: 1,
    minLot: 0.1, maxLot: 100, decimals: 1, dataFile: null, basePrice: 16800, volatility: 15, dukascopy: 'deuidxeur',
  },

  // ---- commodities --------------------------------------------------------
  BRENT: {
    name: 'Brent Crude', category: 'commodities', nickname: ['brent', 'brent crude', 'uk oil'],
    pipSize: 0.01, pipValue: 10, spread: 0.05, contractSize: 1000,
    minLot: 0.01, maxLot: 50, decimals: 3, dataFile: 'BRENT.CMD', basePrice: 46.8, volatility: 0.15, dukascopy: 'brentcmdusd',
  },
  USOIL: {
    name: 'WTI Crude', category: 'commodities', nickname: ['wti', 'crude', 'oil', 'usoil'],
    pipSize: 0.01, pipValue: 10, spread: 0.05, contractSize: 1000,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: null, basePrice: 78.5, volatility: 0.3, dukascopy: 'lightcmdusd',
  },

  // ---- crypto ---------------------------------------------------------------
  BTCUSD: {
    name: 'Bitcoin', category: 'crypto', nickname: ['bitcoin', 'btc'],
    pipSize: 0.01, pipValue: 0.01, spread: 50, contractSize: 1,
    minLot: 0.01, maxLot: 10, decimals: 1, dataFile: 'BTC-USD', basePrice: 9795, volatility: 15, dukascopy: 'btcusd',
  },
  ETHUSD: {
    name: 'Ethereum', category: 'crypto', nickname: ['ethereum', 'eth'],
    pipSize: 0.01, pipValue: 0.01, spread: 4, contractSize: 1,
    minLot: 0.01, maxLot: 50, decimals: 2, dataFile: 'ETH-USD', basePrice: 186.7, volatility: 0.3, dukascopy: 'ethusd',
  },
  // USTUSD's CSV is present but empty (0 data rows) - csvLoader falls back to
  // synthetic automatically. Treated as a low-volatility, ~$1 asset.
  USTUSD: {
    name: 'TerraUSD', category: 'crypto', nickname: ['ust', 'terra', 'terrausd'],
    pipSize: 0.0001, pipValue: 0.0001, spread: 0.002, contractSize: 1,
    minLot: 1, maxLot: 10000, decimals: 4, dataFile: 'UST-USD', basePrice: 1.0, volatility: 0.002,
  },

  // ---- stocks -------------------------------------------------------------
  AAPL: {
    name: 'Apple Inc', category: 'stocks', nickname: ['apple', 'aapl'],
    pipSize: 0.01, pipValue: 1, spread: 0.14, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: 'AAPL.US-USD', basePrice: 351.17, volatility: 0.5, dukascopy: 'aaplususd',
  },
  // ---- Bell Rush (stocks only) and The Pit (futures only) --------------------
  // Free Dukascopy history, same pipeline as forex (scripts/fetch-market-data.js).
  // Shown as 'Stocks (simulated)' and 'Futures (simulated)': historical replay.
  // Stocks trade in whole shares (contractSize 1). Futures trade in whole
  // contracts with the real exchange multiplier as contractSize and the real
  // tick as pipSize (pipValue = dollars per tick). P&L = move x size x contractSize.
  MSFT: {
    name: 'Microsoft', category: 'stocks', nickname: ['msft'],
    pipSize: 0.01, pipValue: 1, spread: 0.32, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'msftususd', simulated: true,
  },
  NVDA: {
    name: 'NVIDIA', category: 'stocks', nickname: ['nvda'],
    pipSize: 0.01, pipValue: 1, spread: 0.06, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'nvdaususd', simulated: true,
  },
  TSLA: {
    name: 'Tesla', category: 'stocks', nickname: ['tsla'],
    pipSize: 0.01, pipValue: 1, spread: 0.4, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'tslaususd', simulated: true,
  },
  AMZN: {
    name: 'Amazon', category: 'stocks', nickname: ['amzn'],
    pipSize: 0.01, pipValue: 1, spread: 0.11, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'amznususd', simulated: true,
  },
  META: {
    name: 'Meta Platforms', category: 'stocks', nickname: ['meta'],
    pipSize: 0.01, pipValue: 1, spread: 0.65, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'fbususd', simulated: true,
  },
  GOOGL: {
    name: 'Alphabet', category: 'stocks', nickname: ['googl'],
    pipSize: 0.01, pipValue: 1, spread: 0.16, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'googlususd', simulated: true,
  },
  AMD: {
    name: 'AMD', category: 'stocks', nickname: ['amd'],
    pipSize: 0.01, pipValue: 1, spread: 0.7, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'amdususd', simulated: true,
  },
  NFLX: {
    name: 'Netflix', category: 'stocks', nickname: ['nflx'],
    pipSize: 0.01, pipValue: 1, spread: 0.03, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'nflxususd', simulated: true,
  },
  JPM: {
    name: 'JPMorgan Chase', category: 'stocks', nickname: ['jpm'],
    pipSize: 0.01, pipValue: 1, spread: 0.26, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'jpmususd', simulated: true,
  },
  BA: {
    name: 'Boeing', category: 'stocks', nickname: ['ba'],
    pipSize: 0.01, pipValue: 1, spread: 0.2, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'baususd', simulated: true,
  },
  PLTR: {
    name: 'Palantir', category: 'stocks', nickname: ['pltr'],
    pipSize: 0.01, pipValue: 1, spread: 0.21, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'pltrususd', simulated: true,
  },
  SPY: {
    name: 'S&P 500 ETF', category: 'stocks', nickname: ['spy'],
    pipSize: 0.01, pipValue: 1, spread: 0.05, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'spyususd', simulated: true,
  },
  QQQ: {
    name: 'Nasdaq 100 ETF', category: 'stocks', nickname: ['qqq'],
    pipSize: 0.01, pipValue: 1, spread: 0.06, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'qqqususd', simulated: true,
  },
  INTC: {
    name: 'Intel', category: 'stocks', nickname: ['intc'],
    pipSize: 0.01, pipValue: 1, spread: 0.04, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'intcususd', simulated: true,
  },
  UBER: {
    name: 'Uber', category: 'stocks', nickname: ['uber'],
    pipSize: 0.01, pipValue: 1, spread: 0.06, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'uberususd', simulated: true,
  },
  AVGO: {
    name: 'Broadcom', category: 'stocks', nickname: ['avgo'],
    pipSize: 0.01, pipValue: 1, spread: 0.4, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'avgoususd', simulated: true,
  },
  ORCL: {
    name: 'Oracle', category: 'stocks', nickname: ['orcl'],
    pipSize: 0.01, pipValue: 1, spread: 0.25, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'orclususd', simulated: true,
  },
  CRM: {
    name: 'Salesforce', category: 'stocks', nickname: ['crm'],
    pipSize: 0.01, pipValue: 1, spread: 0.3, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'crmususd', simulated: true,
  },
  PYPL: {
    name: 'PayPal', category: 'stocks', nickname: ['pypl'],
    pipSize: 0.01, pipValue: 1, spread: 0.06, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'pyplususd', simulated: true,
  },
  XOM: {
    name: 'Exxon Mobil', category: 'stocks', nickname: ['xom'],
    pipSize: 0.01, pipValue: 1, spread: 0.13, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'xomususd', simulated: true,
  },
  CVX: {
    name: 'Chevron', category: 'stocks', nickname: ['cvx'],
    pipSize: 0.01, pipValue: 1, spread: 0.13, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'cvxususd', simulated: true,
  },
  WMT: {
    name: 'Walmart', category: 'stocks', nickname: ['wmt'],
    pipSize: 0.01, pipValue: 1, spread: 0.05, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'wmtususd', simulated: true,
  },
  COST: {
    name: 'Costco', category: 'stocks', nickname: ['cost'],
    pipSize: 0.01, pipValue: 1, spread: 1.41, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'costususd', simulated: true,
  },
  V: {
    name: 'Visa', category: 'stocks', nickname: ['v'],
    pipSize: 0.01, pipValue: 1, spread: 0.25, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'vususd', simulated: true,
  },
  MA: {
    name: 'Mastercard', category: 'stocks', nickname: ['ma'],
    pipSize: 0.01, pipValue: 1, spread: 0.89, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'maususd', simulated: true,
  },
  BABA: {
    name: 'Alibaba', category: 'stocks', nickname: ['baba'],
    pipSize: 0.01, pipValue: 1, spread: 0.1, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'babaususd', simulated: true,
  },
  MU: {
    name: 'Micron', category: 'stocks', nickname: ['mu'],
    pipSize: 0.01, pipValue: 1, spread: 0.87, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'muususd', simulated: true,
  },
  SNOW: {
    name: 'Snowflake', category: 'stocks', nickname: ['snow'],
    pipSize: 0.01, pipValue: 1, spread: 1.01, contractSize: 1, unit: 'share', lotStep: 1,
    minLot: 1, maxLot: 1000, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'snowususd', simulated: true,
  },
  // CME Micro E-mini S&P 500: $5 x index, tick 0.25 = $1.25
  'MES': {
    name: 'Micro E-mini S&P 500 (simulated futures)', category: 'futures', nickname: ['mes', 'es'],
    pipSize: 0.25, pipValue: 1.25, spread: 0.25, contractSize: 5, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'usa500idxusd', simulated: true,
  },
  // CME Micro E-mini Nasdaq-100: $2 x index, tick 0.25 = $0.50
  'MNQ': {
    name: 'Micro E-mini Nasdaq-100 (simulated futures)', category: 'futures', nickname: ['mnq', 'nq'],
    pipSize: 0.25, pipValue: 0.5, spread: 0.25, contractSize: 2, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'usatechidxusd', simulated: true,
  },
  // CBOT Micro E-mini Dow: $0.50 x index, tick 1 = $0.50
  'MYM': {
    name: 'Micro E-mini Dow (simulated futures)', category: 'futures', nickname: ['mym', 'ym'],
    pipSize: 1, pipValue: 0.5, spread: 1, contractSize: 0.5, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'usa30idxusd', simulated: true,
  },
  // CME Micro E-mini Russell 2000: $5 x index, tick 0.10 = $0.50
  'M2K': {
    name: 'Micro E-mini Russell 2000 (simulated futures)', category: 'futures', nickname: ['m2k', 'rty'],
    pipSize: 0.1, pipValue: 0.5, spread: 0.1, contractSize: 5, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'ussc2000idxusd', simulated: true,
  },
  // NYMEX Micro WTI: 100 barrels, tick $0.01 = $1
  'MCL': {
    name: 'Micro WTI Crude Oil (simulated futures)', category: 'futures', nickname: ['mcl', 'cl'],
    pipSize: 0.01, pipValue: 1, spread: 0.01, contractSize: 100, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'lightcmdusd', simulated: true,
  },
  // ICE Brent: 1,000 barrels, tick $0.01 = $10
  'BZ': {
    name: 'Brent Crude (simulated futures)', category: 'futures', nickname: ['bz'],
    pipSize: 0.01, pipValue: 10, spread: 0.01, contractSize: 1000, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 3, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'brentcmdusd', simulated: true,
  },
  // NYMEX Henry Hub: 10,000 MMBtu, tick $0.001 = $10
  'NG': {
    name: 'Natural Gas (simulated futures)', category: 'futures', nickname: ['ng'],
    pipSize: 0.001, pipValue: 10, spread: 0.001, contractSize: 10000, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 3, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'gascmdusd', simulated: true,
  },
  // COMEX Micro Gold: 10 troy oz, tick $0.10 = $1
  'MGC': {
    name: 'Micro Gold (simulated futures)', category: 'futures', nickname: ['mgc', 'gc'],
    pipSize: 0.1, pipValue: 1, spread: 0.1, contractSize: 10, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'xauusd', simulated: true,
  },
  // COMEX Micro Silver: 1,000 troy oz, tick $0.005 = $5
  'SIL': {
    name: 'Micro Silver (simulated futures)', category: 'futures', nickname: ['sil', 'si'],
    pipSize: 0.005, pipValue: 5, spread: 0.005, contractSize: 1000, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 3, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'xagusd', simulated: true,
  },
  // COMEX Micro Copper: 2,500 lb, tick $0.0005 = $1.25
  'MHG': {
    name: 'Micro Copper (simulated futures)', category: 'futures', nickname: ['mhg', 'hg'],
    pipSize: 0.0005, pipValue: 1.25, spread: 0.0005, contractSize: 2500, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 4, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'coppercmdusd', simulated: true,
  },
  // NYMEX Platinum: 50 troy oz, tick $0.10 = $5
  'PL': {
    name: 'Platinum (simulated futures)', category: 'futures', nickname: ['pl'],
    pipSize: 0.1, pipValue: 5, spread: 0.2, contractSize: 50, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'xptcmdusd', simulated: true,
  },
  // NYMEX Palladium: 100 troy oz, tick $0.50 = $50
  'PA': {
    name: 'Palladium (simulated futures)', category: 'futures', nickname: ['pa'],
    pipSize: 0.5, pipValue: 50, spread: 1, contractSize: 100, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'xpdcmdusd', simulated: true,
  },
  // CBOT 30-Year T-Bond: $1,000 per point, tick 1/32 = $31.25
  'ZB': {
    name: 'US Treasury Bond (simulated futures)', category: 'futures', nickname: ['zb'],
    pipSize: 0.03125, pipValue: 31.25, spread: 0.03125, contractSize: 1000, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 3, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'ustbondtrusd', simulated: true,
  },
  // ICE US Dollar Index: $1,000 x index, tick 0.005 = $5
  'DX': {
    name: 'US Dollar Index (simulated futures)', category: 'futures', nickname: ['dx'],
    pipSize: 0.005, pipValue: 5, spread: 0.01, contractSize: 1000, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 3, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'dollaridxusd', simulated: true,
  },
  // CFE VIX: $1,000 x index, tick 0.05 = $50
  'VX': {
    name: 'Volatility Index (simulated futures)', category: 'futures', nickname: ['vx'],
    pipSize: 0.05, pipValue: 50, spread: 0.1, contractSize: 1000, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'volidxusd', simulated: true,
  },
  // CME Micro EUR/USD: 12,500 EUR, tick 0.0001 = $1.25
  'M6E': {
    name: 'Micro EUR/USD (simulated futures)', category: 'futures', nickname: ['m6e', '6e'],
    pipSize: 0.0001, pipValue: 1.25, spread: 0.0001, contractSize: 12500, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 5, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'eurusd', simulated: true,
  },
  // CBOT Soybeans: 5,000 bushels, price in cents, tick 1/4 cent = $12.50
  'ZS': {
    name: 'Soybeans (simulated futures)', category: 'futures', nickname: ['zs'],
    pipSize: 0.25, pipValue: 12.5, spread: 0.5, contractSize: 50, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'soybeancmdusx', simulated: true,
  },
  // ICE White Sugar (London No. 5, the data this feed carries, priced in $/tonne): 50 tonnes, tick $0.10 = $5
  'SB': {
    name: 'White Sugar (simulated futures)', category: 'futures', nickname: ['sb'],
    pipSize: 0.1, pipValue: 5, spread: 0.2, contractSize: 50, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'sugarcmdusd', simulated: true,
  },
  // ICE Coffee C: 37,500 lb, price in cents, tick 0.05 cent = $18.75
  'KC': {
    name: 'Coffee (simulated futures)', category: 'futures', nickname: ['kc'],
    pipSize: 0.05, pipValue: 18.75, spread: 0.1, contractSize: 375, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'coffeecmdusx', simulated: true,
  },
  // ICE Cocoa: 10 tonnes, tick $1 = $10
  'CC': {
    name: 'Cocoa (simulated futures)', category: 'futures', nickname: ['cc'],
    pipSize: 1, pipValue: 10, spread: 2, contractSize: 10, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 0, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'cocoacmdusd', simulated: true,
  },
  // ICE Cotton No. 2: 50,000 lb, price in cents, tick 0.01 cent = $5
  'CT': {
    name: 'Cotton (simulated futures)', category: 'futures', nickname: ['ct'],
    pipSize: 0.01, pipValue: 5, spread: 0.02, contractSize: 500, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'cottoncmdusx', simulated: true,
  },
  // ICE FCOJ-A: 15,000 lb, price in cents, tick 0.05 cent = $7.50
  'OJ': {
    name: 'Orange Juice (simulated futures)', category: 'futures', nickname: ['oj'],
    pipSize: 0.05, pipValue: 7.5, spread: 0.1, contractSize: 150, unit: 'contract', lotStep: 1,
    minLot: 1, maxLot: 50, decimals: 2, dataFile: null, basePrice: 100, volatility: 0.3, dukascopy: 'ojuicecmdusx', simulated: true,
  },
};

// Classes every mode except Bell Rush and The Pit draws from.
const DEFAULT_MODE_CLASSES = ['forex', 'metals', 'indices', 'commodities', 'crypto'];

const CATEGORIES = Object.keys(INSTRUMENTS).reduce((set, sym) => set.add(INSTRUMENTS[sym].category), new Set());

// Live-only coins: traded only in live-data competitions (server/liveMarket.js,
// Coinbase prices). They are NOT in INSTRUMENTS, so no war match, replay,
// ticker or curation ever deals them (there is no replay data for them).
// getInstrument() finds them so quotes, P&L and margin work in a live competition.
const crypto_ = (name, nick, decimals, spread, minLot, maxLot) => ({ name, category: 'crypto', nickname: nick, pipSize: 10 ** -decimals, pipValue: 10 ** -decimals, spread, contractSize: 1, minLot, maxLot, decimals, dataFile: null, liveOnly: true });
const LIVE_INSTRUMENTS = {
  SOLUSD: crypto_('Solana', ['solana', 'sol'], 2, 0.06, 0.01, 2000),
  XRPUSD: crypto_('XRP', ['xrp', 'ripple'], 4, 0.0006, 1, 100000),
  DOGEUSD: crypto_('Dogecoin', ['dogecoin', 'doge'], 5, 0.00006, 10, 1000000),
  ADAUSD: crypto_('Cardano', ['cardano', 'ada'], 4, 0.0002, 1, 100000),
  LTCUSD: crypto_('Litecoin', ['litecoin', 'ltc'], 2, 0.06, 0.01, 2000),
  LINKUSD: crypto_('Chainlink', ['chainlink', 'link'], 3, 0.008, 0.1, 20000),
  AVAXUSD: crypto_('Avalanche', ['avalanche', 'avax'], 3, 0.008, 0.1, 20000),
  BCHUSD: crypto_('Bitcoin Cash', ['bitcoin cash', 'bch'], 2, 0.3, 0.01, 500),
};

// The Pit moved to CME/COMEX micro contracts on 2026-11-21. Old trade rows
// still carry the full-size tickers, so those names keep resolving.
const RENAMED = { ES: 'MES', NQ: 'MNQ', YM: 'MYM', RTY: 'M2K', CL: 'MCL', GC: 'MGC', SI: 'SIL', HG: 'MHG', '6E': 'M6E' };

function getInstrument(symbol) {
  return INSTRUMENTS[symbol] || LIVE_INSTRUMENTS[symbol] || INSTRUMENTS[RENAMED[symbol]] || null;
}

function listInstruments() {
  return Object.entries(INSTRUMENTS).map(([symbol, cfg]) => ({ symbol, ...cfg }));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks `count` instruments: always at least 1 forex pair, at most 2 crypto, at
// most 2 indices, and (when count < the number of categories available) no
// repeated category so a short match still feels varied.
// Instruments players may be dealt or pick: with market curation on, only the
// ones the data kept (and admin left enabled) - see server/curated.js.
function playableSymbols(mode = null) {
  return curated.enabledSymbols(Object.keys(INSTRUMENTS), mode);
}

function isPlayable(symbol, mode = null) {
  return Boolean(INSTRUMENTS[symbol]) && curated.isEnabled(symbol, mode);
}

// opts.topN: only the N most active playable instruments (curation ranking) -
// Blitz plays the busiest markets only (server/config/modeIdentity.js).
// Action Engine: how many busy windows an instrument has for a match of
// `dataSeconds` market seconds (0 = not offered at that length). Instruments
// without curated data keep the old behaviour (not scored).
function actionWindowCount(symbol, dataSeconds) {
  if (!actionEngine.cfg().enabled || !curated.isActive()) return Infinity;
  const pl = curated.getPlaylist(symbol);
  if (!pl) return Infinity;
  const key = curated.durationKey(pl, dataSeconds);
  if (!key) return 0;
  return actionEngine.scoreWindows(symbol, Math.ceil(dataSeconds / 60), pl.validStarts[key] || [], curated.barsAt).length;
}

function selectMatchInstruments(count = 5, mode = null, opts = {}) {
  let all = playableSymbols(mode);
  // Never lower the bar: an instrument without busy windows for this match
  // length is simply not offered.
  // Each mode draws only from its own instrument classes (stocks only in Bell
  // Rush, futures only in The Pit).
  if (Array.isArray(opts.classes)) all = all.filter((sym) => opts.classes.includes(INSTRUMENTS[sym].category));
  if (opts.dataSeconds) all = all.filter((sym) => actionWindowCount(sym, opts.dataSeconds) >= actionEngine.cfg().minEligibleWindows);
  if (opts.topN) {
    const cat = curated.load();
    const rank = new Map(((cat && cat.ranking) || []).map((r) => [r.sym, r.rank]));
    all = all.slice().sort((a, b) => (rank.get(a) || 999) - (rank.get(b) || 999)).slice(0, Math.max(count, opts.topN));
  }
  count = Math.min(count, all.length);
  const byCategory = {};
  for (const sym of all) {
    const cat = INSTRUMENTS[sym].category;
    (byCategory[cat] = byCategory[cat] || []).push(sym);
  }

  const selected = [];
  const usedCategories = new Set();

  const forexPick = byCategory.forex && byCategory.forex.length ? shuffle(byCategory.forex)[0] : null;
  if (forexPick) {
    selected.push(forexPick);
    usedCategories.add('forex');
  }

  const capPerCategory = { crypto: 2, indices: 2 };
  const categoryCount = { forex: forexPick ? 1 : 0 };

  const pool = shuffle(all.filter((s) => s !== forexPick));
  for (const sym of pool) {
    if (selected.length >= count) break;
    const cat = INSTRUMENTS[sym].category;
    const cap = capPerCategory[cat] || Infinity;
    if ((categoryCount[cat] || 0) >= cap) continue;
    if (count < 5 && usedCategories.has(cat)) continue;
    selected.push(sym);
    usedCategories.add(cat);
    categoryCount[cat] = (categoryCount[cat] || 0) + 1;
  }

  // If category diversity constraints left us short (small registries, tight
  // caps), fill remaining slots from whatever's left regardless of category.
  if (selected.length < count) {
    for (const sym of pool) {
      if (selected.length >= count) break;
      if (selected.includes(sym)) continue;
      selected.push(sym);
    }
  }

  return shuffle(selected);
}

const PRE_MATCH_MINUTES = 120; // 2 hours of 1-minute bars shown as historical context
const LIVE_MINUTES = 10; // the default match length; callers pass longer ones
const WINDOW_MINUTES = PRE_MATCH_MINUTES + LIVE_MINUTES;
const TICKS_PER_MINUTE = 60; // live minutes get interpolated to 1-second ticks for the existing tick-driven engine
// A 130-minute window may span at most this much more real time than 130
// minutes (a few dropped no-trade minutes are fine, a weekend is not).
const MAX_WINDOW_GAP_RATIO = 1.25;
const MIN_HISTORY_BARS = 1440;

// matchId -> { [symbol]: compact price window } - see assignMatchWindow. A live
// match's prices are numbers in typed arrays, not one object per second, and the
// long chart history isn't kept at all (built when a player asks for it). That
// took a match from about 7 MB to well under 1 MB of memory.
const MATCH_WINDOWS = new Map();

// A Brownian bridge from `open` to `close`, clamped into [low, high] - keeps
// every synthetic sub-tick consistent with the real candle's recorded range
// while still looking like an organic path rather than a straight line.
function interpolateMinuteToTicks(bar, ticksPerMinute) {
  const { open, high, low, close } = bar;
  const n = ticksPerMinute;
  const range = Math.max(high - low, Math.abs(close - open), 1e-6);
  const stepVol = (range / Math.sqrt(n)) * 0.6;

  const w = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    w[i] = w[i - 1] + (Math.random() * 2 - 1) * stepVol;
  }

  const mids = [];
  for (let t = 1; t <= n; t++) {
    const bridge = w[t] - (t / n) * w[n];
    let mid = open + (close - open) * (t / n) + bridge;
    mid = Math.min(high, Math.max(low, mid));
    mids.push(mid);
  }
  return mids; // length n, last value === close-ish
}

function buildTick(mid, spread, decimals) {
  const roundedMid = Number(mid.toFixed(decimals));
  return {
    mid: roundedMid,
    bid: Number((roundedMid - spread / 2).toFixed(decimals)),
    ask: Number((roundedMid + spread / 2).toFixed(decimals)),
  };
}

// Builds (once, cached) the pre-match + live windows for one instrument in one
// match: a random valid start offset into that instrument's day of 1-minute
// bars, sliced into 120 pre-match minutes (shown as-is, one point per minute -
// consistent with the chart's per-minute pre-match candles elsewhere) and the
// match's live minutes interpolated into one-second ticks for the existing
// tick-driven match engine (price:update, SL/TP checks, etc. all stay unchanged).
// Simple string hash -> mulberry32 PRNG, used only so the Async Daily
// Challenge can give every player the exact same historical window for a
// given symbol on a given UTC calendar day (fairness requirement) without
// pulling in a random-seeding dependency.
function seededRandom(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// Deterministic sibling of selectMatchInstruments for the Async Daily
// Challenge - every player who starts today's challenge must see the exact
// same instrument set, so this shuffles with a seeded PRNG instead of
// Math.random() rather than reusing the category-diversity logic above
// (which doesn't need to be deterministic for the competitive modes it serves).
function selectDailyInstruments(seed, count = 3, mode = 'async', classes = DEFAULT_MODE_CLASSES) {
  const rand = seededRandom(seed);
  const all = playableSymbols(mode).filter((sym) => classes.includes(INSTRUMENTS[sym].category));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, count);
}

// Curated path (server/curated.js): the match plays a valid start offset of the
// instrument's closed-loop playlist, every second generated by the seeded
// intrabar generator (server/intrabar.js) keyed by playlist minute, so the
// same (seed, start) gives byte-identical prices to every player and every
// replay (ghost challenges reuse both). `speed` = data seconds per real second.
function assignCuratedWindow(matchId, symbol, seed, liveMinutes, opts) {
  const cfg = getInstrument(symbol);
  const speed = Math.max(1, Math.floor(Number(opts.speed) || 1));
  const seedStr = String(seed || matchId);
  const durationSeconds = liveMinutes * 60;
  const dataMinutes = Math.ceil(liveMinutes * speed);
  const pl = curated.getPlaylist(symbol);
  const ae = actionEngine.cfg();
  const useAE = ae.enabled && opts.actionEngine !== false;
  // Anti-memorisation (Action Engine): price scale and mirror flip from the
  // seed and symbol, so a replay with the same seed and start is identical.
  const shape = useAE ? actionEngine.transformFor(seededRandom(`${seedStr}:${symbol}:shape`)) : { scale: 1, flip: false };

  const build = (start) => {
    const preBars = curated.barsAt(symbol, start - PRE_MATCH_MINUTES, PRE_MATCH_MINUTES);
    const liveBars = curated.barsAt(symbol, start, dataMinutes);
    const ref = liveBars.length ? liveBars[0].open : 0;
    const T = (v) => (shape.flip ? 2 * ref - v : v) * shape.scale;
    const shaped = (b) => {
      if (shape.scale === 1 && !shape.flip) return b;
      const a = T(b.high);
      const z = T(b.low);
      return { open: T(b.open), high: Math.max(a, z), low: Math.min(a, z), close: T(b.close), index: b.index };
    };
    const ticksOf = (bars) => {
      const mids = new Float64Array(bars.length * TICKS_PER_MINUTE);
      let i = 0;
      for (const bar of bars) {
        const path = intrabar.barPath(shaped(bar), TICKS_PER_MINUTE, cfg.decimals, seedStr, `${symbol}:${bar.index}`);
        for (let k = 0; k < path.length; k++) mids[i++] = path[k];
      }
      return mids;
    };
    const preMids = ticksOf(preBars);
    const preBase = preMids.length ? preMids[0] : 0;
    const preOffsets = new Float32Array(preMids.length);
    for (let i = 0; i < preMids.length; i++) preOffsets[i] = preMids[i] - preBase;
    return {
      symbol,
      spread: cfg.spread * shape.scale,
      decimals: cfg.decimals,
      preBase,
      preOffsets,
      live: ticksOf(liveBars),
      anchor: null,
      curated: { start, seed: seedStr, speed, loopLength: pl.bars.length, srcTime: pl.srcTimes[start], shape: { ...shape, ref } },
      speed,
      lastIndex: -1,
      lastTick: null,
    };
  };

  // A replay (ghost, challenge) names its start: rebuild exactly that.
  if (Number.isInteger(opts.startIndex)) return build(opts.startIndex);
  const rand = seededRandom(`${seedStr}:${symbol}:start`);
  if (!useAE) {
    const start = curated.pickStart(symbol, durationSeconds * speed, rand);
    return start === null ? null : build(start);
  }
  const key = curated.durationKey(pl, durationSeconds * speed);
  const valid = key ? pl.validStarts[key] : [];
  const eligible = actionEngine.scoreWindows(symbol, dataMinutes, valid || [], curated.barsAt);
  if (!eligible.length) return null; // not enough action: this instrument is not offered
  const hz = deliverySteps();
  const picked = actionEngine.pickWindow(symbol, eligible, rand, (start) => {
    const entry = build(start);
    const samples = [];
    for (let k = 0; k < durationSeconds * hz; k++) samples.push([k / hz, priceAtEntry(entry, k / hz, stepsFor(entry, hz), seedStr).mid]);
    return { entry, samples };
  }, speed);
  if (!picked) return null;
  picked.entry.action = { percentile: Math.round(picked.pct), continuity: picked.continuity, reason: picked.reason || null };
  return picked.entry;
}

// Chart history for a curated match: the playlist minutes before the pre-match
// ticks, as 1-minute rows at seconds relative to match start (never real
// dates). Capped so the loop never shows the match's own minutes again.
const CURATED_CONTEXT_MAX_BARS = 2880;
function buildCuratedContext(entry) {
  const { start, loopLength, srcTime } = entry.curated;
  const span = PRE_MATCH_MINUTES + Math.ceil(entry.live.length / TICKS_PER_MINUTE) + 1;
  const count = Math.max(0, Math.min(CURATED_CONTEXT_MAX_BARS, loopLength - span));
  const first = start - PRE_MATCH_MINUTES - count;
  const bars = curated.barsAt(entry.symbol, first, count);
  const sh = entry.curated.shape;
  const T = (v) => (sh && sh.flip ? 2 * sh.ref - v : v) * ((sh && sh.scale) || 1);
  const m1 = bars.map((b, k) => {
    const hi = T(b.high);
    const lo = T(b.low);
    return [(first + k - start) * 60, T(b.open), Math.max(hi, lo), Math.min(hi, lo), T(b.close)];
  });
  return {
    context: { m1, h1: [], d1: [] },
    // Keeps H1/H4 boundaries on the source bar's real minute-of-day.
    alignOffset: srcTime ? ((srcTime % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS : 0,
  };
}

function assignMatchWindow(matchId, symbol, seed, liveMinutes = LIVE_MINUTES, opts = {}) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);

  let match = MATCH_WINDOWS.get(matchId);
  if (!match) {
    match = {};
    MATCH_WINDOWS.set(matchId, match);
  }
  if (match[symbol]) return match[symbol];

  if (curated.isActive() && curated.getPlaylist(symbol)) {
    const entry = assignCuratedWindow(matchId, symbol, seed, liveMinutes, opts);
    if (entry) {
      match[symbol] = entry;
      return entry;
    }
  }

  // Raw path (curation off or no playlist). Replay speed still applies: the
  // match needs speed x its length of market minutes.
  const rawSpeed = Math.max(1, Math.floor(Number(opts.speed) || 1));
  liveMinutes = Math.ceil(liveMinutes * rawSpeed);
  const dayBars = csvLoader.getInstrumentDayData(symbol, cfg);
  // A match needs live prices for its whole length (Grand War is 20 minutes).
  const windowMinutes = PRE_MATCH_MINUTES + liveMinutes;
  const maxStart = dayBars.length - windowMinutes;
  const rand = seed ? seededRandom(`${seed}:${symbol}`) : Math.random;
  // Multi-day market data has weekend/overnight gaps (closed-market bars are
  // dropped at download time) - a window spanning one would play a jump
  // between sessions as if it were a single minute, so retry for a stretch
  // that's (near-)continuous real time. Seeded runs stay deterministic since
  // the same PRNG sequence is consumed in the same order.
  // With market data, also skip the first ~day of bars so there's always
  // 1-minute history before the window for the 1m-30m chart timeframes.
  const minStart = csvLoader.getMarketSeries(symbol) ? Math.min(MIN_HISTORY_BARS, Math.floor(maxStart / 2)) : 0;
  const pickStart = () => minStart + Math.floor(rand() * (maxStart - minStart));
  let startIndex = maxStart > 0 ? pickStart() : 0;
  for (let attempt = 0; attempt < 50 && maxStart > 0; attempt++) {
    const span = dayBars[startIndex + windowMinutes - 1].time - dayBars[startIndex].time;
    if (span <= (windowMinutes - 1) * 60 * MAX_WINDOW_GAP_RATIO) break;
    startIndex = pickStart();
  }

  const preMatchBars = dayBars.slice(startIndex, startIndex + PRE_MATCH_MINUTES);
  const liveBars = dayBars.slice(startIndex + PRE_MATCH_MINUTES, startIndex + windowMinutes);

  // Same per-second interpolation as the live bars below, not just bar.close -
  // a flat one-point-per-minute close produces a zero-range doji in every
  // bucket at any timeframe <= 60s (5s/10s/30s/M1 all collapse to one raw
  // point per bucket), which is most of the visible chart right at match
  // start when pre-match history dominates the screen.
  const roundedMids = (bars) => {
    const mids = new Float64Array(bars.length * TICKS_PER_MINUTE);
    let i = 0;
    for (const bar of bars) {
      for (const mid of interpolateMinuteToTicks(bar, TICKS_PER_MINUTE)) mids[i++] = Number(mid.toFixed(cfg.decimals));
    }
    return mids;
  };
  // Pre-match prices are only ever read to draw the chart, so they're stored as
  // small offsets from the first one (Float32 is exact enough for an offset;
  // reading rounds back to the instrument's decimals).
  const preMids = roundedMids(preMatchBars);
  const preBase = preMids.length ? preMids[0] : 0;
  const preOffsets = new Float32Array(preMids.length);
  for (let i = 0; i < preMids.length; i++) preOffsets[i] = preMids[i] - preBase;

  match[symbol] = {
    symbol,
    spread: cfg.spread,
    decimals: cfg.decimals,
    preBase,
    preOffsets,
    live: roundedMids(liveBars),
    anchor: preMatchBars.length ? preMatchBars[0].time : null,
    speed: rawSpeed,
    // Every read in the same second wants the same tick.
    lastIndex: -1,
    lastTick: null,
  };
  return match[symbol];
}

const DAY_SECONDS = 86400;
const CONTEXT_M1_DAYS = 2; // feeds 1m-30m candles beyond the 2h of pre-match ticks
const CONTEXT_M1_MIN_BARS = 2880; // ...stretched further back for session-hours instruments (AAPL)
const CONTEXT_H1_DAYS = 45; // feeds 1h/4h
const CONTEXT_D1_BARS = 400; // feeds D1

// Real bars from before the pre-match ticks, for browsing history on the
// higher chart timeframes (1m..D1). Each resolution covers the stretch the
// finer one doesn't, with no overlap or gap between them, so a client candle
// spanning a handover still merges into correct OHLC. Times are seconds relative to match start (same
// axis as the ticks, never real dates - a calendar date would let a player
// look up what happens next), plus alignOffset = match start's seconds into
// its UTC day, so the client can align H1/H4/D1 candles to real boundaries.
function buildChartContext(symbol, anchor) {
  const market = csvLoader.getMarketSeries(symbol);
  if (!market || anchor === null) return { context: null, alignOffset: 0 };

  // anchor = real time of the first pre-match tick
  const preMatchSeconds = PRE_MATCH_MINUTES * 60;
  const rel = (time) => time - anchor - preMatchSeconds;
  const dayFloor = (time) => Math.floor(time / DAY_SECONDS) * DAY_SECONDS;
  const toRow = (b) => [rel(b.time), b.open, b.high, b.low, b.close];

  // The m1 stretch starts on a whole hour (so an H1 candle never mixes h1 and
  // m1 bars) and h1 hands over to d1 on a UTC midnight, likewise for D1.
  const hourFloor = (time) => Math.floor(time / 3600) * 3600;
  let m1Start = hourFloor(anchor - CONTEXT_M1_DAYS * DAY_SECONDS);
  const anchorIndex = market.m1.findIndex((b) => b.time >= anchor);
  const minBarsIndex = Math.max(0, (anchorIndex === -1 ? market.m1.length : anchorIndex) - CONTEXT_M1_MIN_BARS);
  if (market.m1.length) m1Start = Math.min(m1Start, hourFloor(market.m1[minBarsIndex].time));
  if (market.m1.length && market.m1[0].time > m1Start) m1Start = hourFloor(market.m1[0].time) + 3600;
  m1Start = Math.min(m1Start, anchor);
  const h1Start = dayFloor(m1Start - CONTEXT_H1_DAYS * DAY_SECONDS);

  const m1 = market.m1.filter((b) => b.time >= m1Start && b.time < anchor);
  const h1 = market.h1.filter((b) => b.time >= h1Start && b.time < m1Start);
  const d1End = h1.length ? dayFloor(h1[0].time) : m1Start;
  const d1 = market.d1.filter((b) => b.time < d1End).slice(-CONTEXT_D1_BARS);

  const matchStart = anchor + preMatchSeconds;
  return {
    context: { m1: m1.map(toRow), h1: h1.map(toRow), d1: d1.map(toRow) },
    alignOffset: ((matchStart % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS,
  };
}

// The one place real match time becomes market (data) time: real elapsed
// seconds x the match's replay speed. SL/TP, candles, the loss window and the
// chart all read prices through this. Real-time rules (late entry, disconnect
// grace, the match clock) never call it.
function dataSecondsFor(matchId, symbol, elapsedSeconds) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  const speed = (entry && entry.speed) || 1;
  return Math.floor(elapsedSeconds * speed);
}

function getCurrentPrice(matchId, symbol, elapsedSeconds) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry) throw new Error(`No window assigned for match ${matchId} / ${symbol}`);
  const index = Math.max(0, Math.min(entry.live.length - 1, Math.floor(elapsedSeconds * (entry.speed || 1))));
  if (entry.lastIndex !== index) {
    entry.lastIndex = index;
    entry.lastTick = { t: index, ...buildTick(entry.live[index], entry.spread, entry.decimals) };
  }
  return entry.lastTick;
}

// Sub-second prices (Action Engine, no frozen candle). The per-second series
// above is never changed: second k is exactly entry.live[k], so replays and
// anything reading whole seconds see the same prices as before. Between
// second k and k+1 the price follows a seeded Brownian bridge (same seed for
// every player in the match, so everyone sees the same path), scaled to the
// window's typical one-second move.
function typicalStep(entry) {
  if (entry.typStep !== undefined) return entry.typStep;
  const d = [];
  for (let i = 1; i < entry.live.length; i++) d.push(Math.abs(entry.live[i] - entry.live[i - 1]));
  d.sort((a, b) => a - b);
  const nonZero = d.filter((x) => x > 0);
  entry.typStep = (nonZero.length ? nonZero[Math.floor(nonZero.length / 2)] : 0) || 10 ** -entry.decimals;
  return entry.typStep;
}

function bridgePoints(entry, k, sub, seedKey) {
  const cache = entry.bridgeCache || (entry.bridgeCache = { k: -1, sub: 0, pts: null });
  if (cache.k === k && cache.sub === sub) return cache.pts;
  const a = entry.live[k];
  const b = entry.live[Math.min(k + 1, entry.live.length - 1)];
  const rand = intrabar.rngFor(String(seedKey), `${entry.symbol}:sub:${k}`);
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
  // At least two price units, so the steps survive rounding to the instrument's decimals.
  const sigma = Math.max(typicalStep(entry), Math.abs(b - a), 2 * 10 ** -entry.decimals) * 0.6;
  const w = [0];
  for (let j = 1; j <= sub; j++) w.push(w[j - 1] + (normal() * sigma) / Math.sqrt(sub));
  const unit = 10 ** -entry.decimals;
  const round = (v) => Number(v.toFixed(entry.decimals));
  const pts = [a];
  for (let j = 1; j < sub; j++) {
    let v = round(a + ((b - a) * j) / sub + (w[j] - (j / sub) * w[sub]));
    // Every step must visibly move: never equal to the step before it, and
    // the last one never equal to the next whole second's price.
    const prev = pts[j - 1];
    if (v === round(prev) || (j === sub - 1 && v === round(b))) {
      const dir = b > prev ? 1 : b < prev ? -1 : rand() < 0.5 ? 1 : -1;
      v = round(prev + dir * unit);
      if (j === sub - 1 && v === round(b)) v = round(prev - dir * unit);
    }
    pts.push(v);
  }
  cache.k = k;
  cache.sub = sub;
  cache.pts = pts;
  return pts;
}

// Price at a real match time t (seconds, may be fractional), with `sub` price
// steps per data second. Whole seconds return exactly the per-second series.
function priceAtEntry(entry, t, sub, seedKey) {
  const dataT = Math.max(0, t * (entry.speed || 1));
  const k = Math.min(entry.live.length - 1, Math.floor(dataT + 1e-9));
  const j = Math.min(sub - 1, Math.floor((dataT - k) * sub + 1e-9));
  if (j <= 0 || sub <= 1) {
    if (entry.lastIndex !== k) {
      entry.lastIndex = k;
      entry.lastTick = { t: k, ...buildTick(entry.live[k], entry.spread, entry.decimals) };
    }
    return entry.lastTick;
  }
  const mid = bridgePoints(entry, k, sub, seedKey)[j];
  return { t: k + j / sub, ...buildTick(mid, entry.spread, entry.decimals) };
}

// Steps per DATA second so the player gets deliveryHz distinct prices per
// REAL second at any replay speed.
const stepsFor = (entry, hz = deliverySteps()) => Math.max(1, Math.ceil(hz / (entry.speed || 1)));

function getPriceAt(matchId, symbol, t, sub = null) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry) throw new Error(`No window assigned for match ${matchId} / ${symbol}`);
  return priceAtEntry(entry, t, sub || stepsFor(entry), (entry.curated && entry.curated.seed) || entry.seedKey || matchId);
}

function getPreMatchHistory(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry) return null;
  const total = entry.preOffsets.length;
  const ticks = new Array(total);
  for (let i = 0; i < total; i++) {
    ticks[i] = { t: i - total, ...buildTick(entry.preBase + entry.preOffsets[i], entry.spread, entry.decimals) };
  }
  return ticks;
}

// Higher-timeframe history for the chart (see buildChartContext) - null for
// instruments with no downloaded market data, which then show ticks only.
function getChartContext(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry) return null;
  if (entry.curated) return buildCuratedContext(entry);
  return buildChartContext(symbol, entry.anchor);
}

// Lowest and highest mid the live path passes through in data seconds
// (fromData, toData] - lets SL/TP catch a level crossed between two ticks
// when one real second covers several data seconds (replay speed > 1).
function liveRangeBetween(matchId, symbol, fromData, toData) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry || toData <= fromData) return null;
  let lo = Infinity;
  let hi = -Infinity;
  const end = Math.min(entry.live.length - 1, toData);
  for (let i = Math.max(0, fromData + 1); i <= end; i++) {
    if (entry.live[i] < lo) lo = entry.live[i];
    if (entry.live[i] > hi) hi = entry.live[i];
  }
  return lo === Infinity ? null : { low: lo, high: hi };
}

// What a ghost challenge, telemetry and spike alerts need to know about a
// match's market: start offset, seed and speed per instrument (curated only).
function getMarketInfo(matchId) {
  const match = MATCH_WINDOWS.get(matchId);
  if (!match) return null;
  const out = {};
  for (const [symbol, entry] of Object.entries(match)) {
    out[symbol] = entry.curated ? { curated: true, start: entry.curated.start, seed: entry.curated.seed, speed: entry.speed, shape: entry.curated.shape ? { scale: entry.curated.shape.scale, flip: entry.curated.shape.flip } : null } : { curated: false, speed: entry.speed || 1 };
  }
  return out;
}

// Grand War market events: real big moves (top topPercent%) in this match's
// live window, in data seconds from match start.
function getBigMoves(matchId, symbol, topPercent) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry || !entry.curated) return [];
  const minutes = Math.ceil(entry.live.length / TICKS_PER_MINUTE);
  return curated.movesBetween(symbol, entry.curated.start, minutes, topPercent).map((m) => ({ symbol, dataSecond: m.minute * TICKS_PER_MINUTE, movePct: entry.curated.shape && entry.curated.shape.flip ? -m.movePct : m.movePct, rangeBps: m.rangeBps }));
}

// Real spike events inside this match's live window, in data seconds from
// match start (curated matches only - nothing is ever invented).
function getSpikeSchedule(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry || !entry.curated) return [];
  const minutes = Math.ceil(entry.live.length / TICKS_PER_MINUTE);
  return curated.spikesBetween(symbol, entry.curated.start, minutes).map((s) => ({ symbol, dataSecond: s.minute * TICKS_PER_MINUTE, movePct: entry.curated.shape && entry.curated.shape.flip ? -s.movePct : s.movePct, rangeBps: s.rangeBps }));
}

function releaseMatchWindows(matchId) {
  MATCH_WINDOWS.delete(matchId);
}

// Full-resolution live tick series for a match's instrument, for persisting
// into the replays table at match end - must be called before
// releaseMatchWindows() clears the underlying cache.
function getFullLiveSeries(matchId, symbol) {
  const match = MATCH_WINDOWS.get(matchId);
  const entry = match && match[symbol];
  if (!entry) return [];
  return Array.from(entry.live, (mid, t) => ({ t, mid }));
}

function getSpread(symbol) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  return cfg.spread;
}

// USD/JPY, USD/CHF, USD/CAD: prices are in the second currency, so a profit
// has to be converted back to dollars at the current rate. Without this a
// USD/JPY pip paid about $1,000 a lot instead of about $9.
function isUsdBase(symbol) {
  const cfg = getInstrument(symbol);
  return Boolean(cfg && cfg.category === 'forex' && symbol.startsWith('USD'));
}

function calculatePnL(direction, lots, entryPrice, currentPrice, symbol) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  const diff = direction === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
  const pnl = diff * lots * cfg.contractSize;
  return isUsdBase(symbol) ? pnl / currentPrice : pnl;
}

function getPipValue(symbol, lots) {
  const cfg = getInstrument(symbol);
  if (!cfg) throw new Error(`Unknown instrument: ${symbol}`);
  return cfg.pipSize * cfg.contractSize * lots;
}

// How a market sizes an order: forex/CFDs in lots (0.01 steps), stocks in
// whole shares, futures in whole contracts.
const UNIT_WORDS = { lot: ['lot', 'lots'], share: ['share', 'shares'], contract: ['contract', 'contracts'] };
function sizeRules(symbol) {
  const cfg = getInstrument(symbol);
  const unit = (cfg && cfg.unit) || 'lot';
  // Lot markets keep the match rule they always had (any size from 0.01);
  // shares and contracts start at 1.
  return { unit, step: (cfg && cfg.lotStep) || 0.01, min: unit === 'lot' ? 0.01 : (cfg && cfg.minLot) || 1, max: (cfg && cfg.maxLot) || 100 };
}

function unitWord(symbol, n) {
  const w = UNIT_WORDS[sizeRules(symbol).unit] || UNIT_WORDS.lot;
  return Number(n) === 1 ? w[0] : w[1];
}

// Rounds a size down to the market's step (0.01 lots, 1 share, 1 contract).
function floorToStep(symbol, n) {
  const { step } = sizeRules(symbol);
  return step >= 1 ? Math.floor(Number(n) + 1e-9) : Math.floor(Number(n) * 100 + 1e-9) / 100;
}

// null when the size is valid for this market, else the message to show.
function sizeError(symbol, n) {
  const { unit, step, min } = sizeRules(symbol);
  const v = Number(n);
  if (!Number.isFinite(v) || v < min) return `Size must be at least ${min} ${unitWord(symbol, min)}`;
  if (step >= 1 && Math.abs(v - Math.round(v)) > 1e-9) return `${unit === 'contract' ? 'Futures trade' : 'Stocks trade'} in whole ${UNIT_WORDS[unit][1]}`;
  return null;
}

// What the game screens need to size orders and show P&L, so they never keep
// their own copy of these numbers.
function clientSpecs(symbols) {
  const out = {};
  for (const sym of symbols || []) {
    const cfg = getInstrument(sym);
    if (!cfg) continue;
    const r = sizeRules(sym);
    out[sym] = { category: cfg.category, contractSize: cfg.contractSize, pipSize: cfg.pipSize, pipValue: cfg.pipValue, decimals: cfg.decimals, usdBase: isUsdBase(sym), unit: r.unit, step: r.step, min: r.min, max: r.max };
  }
  return out;
}

// Called once at server startup so every instrument's data (real CSV or
// synthetic fallback) is loaded/generated up front rather than on the first
// match that happens to use it, and so there's a clear report of what loaded.
// Decorative price snapshot for the Trading Floor home screen ticker - not
// tied to any match, rotates through each instrument's day data using the
// current minute as a slowly-advancing shared cursor.
function getTickerSnapshot() {
  const cursor = Math.floor(Date.now() / 60000);
  const rows = [];
  for (const [symbol, cfg] of Object.entries(INSTRUMENTS)) {
    const dayBars = csvLoader.getInstrumentDayData(symbol, cfg);
    if (!dayBars || !dayBars.length) continue;
    const bar = dayBars[cursor % dayBars.length];
    const changePct = bar.open ? ((bar.close - bar.open) / bar.open) * 100 : 0;
    rows.push({ symbol, price: Number(bar.close.toFixed(cfg.decimals)), changePct: Number(changePct.toFixed(2)) });
  }
  return rows;
}

function preloadAll() {
  const report = [];
  for (const [symbol, cfg] of Object.entries(INSTRUMENTS)) {
    const bars = csvLoader.getInstrumentDayData(symbol, cfg);
    report.push({
      symbol,
      source: csvLoader.getMarketSeries(symbol) ? 'market' : cfg.dataFile && !csvLoader.isSynthetic(symbol) ? 'csv' : 'synthetic',
      points: bars.length,
    });
  }
  return report;
}

module.exports = {
  INSTRUMENTS,
  LIVE_INSTRUMENTS,
  DEFAULT_MODE_CLASSES,
  CATEGORIES: Array.from(CATEGORIES),
  getInstrument,
  listInstruments,
  selectMatchInstruments,
  selectDailyInstruments,
  playableSymbols,
  isPlayable,
  assignMatchWindow,
  dataSecondsFor,
  liveRangeBetween,
  getMarketInfo,
  getSpikeSchedule,
  getBigMoves,
  getCurrentPrice,
  getPriceAt,
  actionWindowCount,
  getPreMatchHistory,
  getChartContext,
  releaseMatchWindows,
  getFullLiveSeries,
  getSpread,
  calculatePnL,
  isUsdBase,
  getPipValue,
  sizeRules,
  unitWord,
  floorToStep,
  sizeError,
  clientSpecs,
  preloadAll,
  getTickerSnapshot,
  PRE_MATCH_MINUTES,
  LIVE_MINUTES,
};
