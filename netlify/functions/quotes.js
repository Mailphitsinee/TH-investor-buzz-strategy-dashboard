const https = require('https');

function get(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
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

const SYMS = 'DELTA.BK,GULF.BK,KTB.BK,PTTEP.BK,TOP.BK,SCB.BK,TTB.BK,AOT.BK,CPALL.BK,KCE.BK,NVDA,TSM,BZ=F,^TNX,USDTHB=X,^SET.BK';

const STOOQ = {
  'DELTA.BK':'delta.bk','GULF.BK':'gulf.bk','KTB.BK':'ktb.bk',
  'PTTEP.BK':'pttep.bk','TOP.BK':'top.bk','SCB.BK':'scb.bk',
  'TTB.BK':'ttb.bk','AOT.BK':'aot.bk','CPALL.BK':'cpall.bk',
  'KCE.BK':'kce.bk','NVDA':'nvda.us','TSM':'tsm.us',
  'BZ=F':'brent.f','^TNX':'10ust.b','USDTHB=X':'usdthb'
};

async function fromYahoo() {
  for (const host of ['query2', 'query1']) {
    for (const ver of ['v7', 'v8']) {
      try {
        const url = `https://${host}.finance.yahoo.com/${ver}/finance/quote?symbols=${encodeURIComponent(SYMS)}&lang=en&region=US`;
        const r = await get(url);
        if (r.code === 200) {
          const j = JSON.parse(r.body);
          const result = j?.quoteResponse?.result;
          if (result?.length) return { source: 'yahoo', result };
        }
      } catch (e) { /* try next */ }
    }
  }
  throw new Error('yahoo failed');
}

async function fromStooq() {
  const settled = await Promise.allSettled(
    Object.entries(STOOQ).map(async ([yfSym, sq]) => {
      const r = await get(`https://stooq.com/q/l/?s=${sq}&f=sd2t2ohlcv&h&e=csv`);
      if (r.code !== 200) throw new Error('http ' + r.code);
      const lines = r.body.trim().split('\n');
      if (lines.length < 2) throw new Error('empty');
      const v = lines[1].split(',');
      const cl = parseFloat(v[6]), op = parseFloat(v[3]);
      if (!cl || cl <= 0 || isNaN(cl)) throw new Error('N/D');
      return {
        symbol: yfSym,
        regularMarketPrice: cl,
        regularMarketChange: cl - op,
        regularMarketChangePercent: op ? (cl - op) / op * 100 : 0,
        regularMarketDayHigh: parseFloat(v[4]),
        regularMarketDayLow: parseFloat(v[5]),
        regularMarketVolume: parseFloat(v[7]) || 0,
        regularMarketTime: Math.floor(Date.now() / 1000),
        currency: yfSym.endsWith('.BK') ? 'THB' : 'USD'
      };
    })
  );
  const result = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!result.length) throw new Error('stooq all N/D');
  return { source: 'stooq', result };
}

exports.handler = async () => {
  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  try {
    const data = await fromYahoo().catch(() => fromStooq());
    return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
