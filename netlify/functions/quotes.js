const https = require('https');

function get(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Cache-Control': 'no-cache'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

const SYMS = ['DELTA.BK','GULF.BK','KTB.BK','PTTEP.BK','TOP.BK','SCB.BK','TTB.BK','AOT.BK','CPALL.BK','KCE.BK','NVDA','TSM','BZ=F','^TNX','USDTHB=X','^SET.BK'];

const STOOQ = {
  'DELTA.BK':'delta.bk','GULF.BK':'gulf.bk','KTB.BK':'ktb.bk',
  'PTTEP.BK':'pttep.bk','TOP.BK':'top.bk','SCB.BK':'scb.bk',
  'TTB.BK':'ttb.bk','AOT.BK':'aot.bk','CPALL.BK':'cpall.bk',
  'KCE.BK':'kce.bk','NVDA':'nvda.us','TSM':'tsm.us',
  'BZ=F':'brent.f','^TNX':'10ust.b','USDTHB=X':'usdthb'
};

// Attempt 1: Yahoo Finance batch v7 quote
async function fromYahooV7() {
  const symsStr = SYMS.join(',');
  for (const host of ['query2', 'query1']) {
    try {
      const r = await get(`https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symsStr)}&lang=en&region=US`);
      if (r.code !== 200) continue;
      const j = JSON.parse(r.body);
      const result = j?.quoteResponse?.result;
      if (result?.length) return { source: 'yahoo-v7', result };
    } catch (e) {}
  }
  throw new Error('yahoo v7 failed');
}

// Attempt 2: Yahoo Finance per-symbol v8 chart (often works without crumb)
async function fromYahooChart() {
  const results = await Promise.all(SYMS.map(async sym => {
    try {
      const r = await get(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d&corsDomain=finance.yahoo.com`);
      if (r.code !== 200) return null;
      const j = JSON.parse(r.body);
      const meta = j?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) return null;
      const prev = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
      return {
        symbol: sym,
        regularMarketPrice: meta.regularMarketPrice,
        regularMarketChange: meta.regularMarketChange || (meta.regularMarketPrice - prev),
        regularMarketChangePercent: meta.regularMarketChangePercent || 0,
        regularMarketDayHigh: meta.regularMarketDayHigh || meta.regularMarketPrice,
        regularMarketDayLow: meta.regularMarketDayLow || meta.regularMarketPrice,
        regularMarketVolume: meta.regularMarketVolume || 0,
        regularMarketTime: meta.regularMarketTime || Math.floor(Date.now() / 1000),
        currency: meta.currency || (sym.endsWith('.BK') ? 'THB' : 'USD')
      };
    } catch (e) { return null; }
  }));
  const result = results.filter(Boolean);
  if (!result.length) throw new Error('yahoo chart all failed');
  return { source: 'yahoo-chart', result };
}

// Attempt 3: Stooq historical endpoint — always has last trading day data, works on weekends
async function fromStooq() {
  const now = new Date();
  const d2 = now.toISOString().slice(0, 10).replace(/-/g, '');
  const d1 = new Date(now - 14 * 24 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');

  const settled = await Promise.allSettled(
    Object.entries(STOOQ).map(async ([yfSym, sq]) => {
      const r = await get(`https://stooq.com/q/d/l/?s=${sq}&d1=${d1}&d2=${d2}&i=d`);
      if (r.code !== 200) throw new Error('http ' + r.code);
      // CSV: Date,Open,High,Low,Close,Volume — oldest first, take last row
      const lines = r.body.trim().split('\n').filter(l => l.trim() && !l.startsWith('Date'));
      if (!lines.length) throw new Error('no rows');
      const v = lines[lines.length - 1].split(',');
      const cl = parseFloat(v[4]), op = parseFloat(v[1]);
      if (isNaN(cl) || cl <= 0) throw new Error('bad price');
      return {
        symbol: yfSym,
        regularMarketPrice: cl,
        regularMarketChange: cl - op,
        regularMarketChangePercent: op ? (cl - op) / op * 100 : 0,
        regularMarketDayHigh: parseFloat(v[2]),
        regularMarketDayLow: parseFloat(v[3]),
        regularMarketVolume: parseFloat(v[5]) || 0,
        regularMarketTime: Math.floor(Date.now() / 1000),
        currency: yfSym.endsWith('.BK') ? 'THB' : 'USD'
      };
    })
  );
  const result = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!result.length) throw new Error('stooq all failed');
  return { source: 'stooq', result };
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

exports.handler = async () => {
  try {
    const data = await fromYahooV7()
      .catch(() => fromYahooChart())
      .catch(() => fromStooq());
    return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
