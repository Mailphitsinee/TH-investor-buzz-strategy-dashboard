const https = require('https');

function get(urlStr, redirects) {
  if ((redirects || 0) > 4) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, (redirects || 0) + 1).then(resolve).catch(reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title = (b.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/) ||
                   b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link  = (b.match(/<link>([\s\S]*?)<\/link>/)  || [])[1] || '';
    const pub   = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const src   = (b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const clean = s => s.replace(/<[^>]*>/g, '').trim();
    if (clean(title) && clean(link)) {
      items.push({
        title: clean(title),
        link:  clean(link),
        date:  pub ? new Date(pub).toISOString() : new Date().toISOString(),
        source: clean(src)
      });
    }
  }
  return items;
}

const FEEDS = {
  market: '\u0e2b\u0e38\u0e49\u0e19\u0e44\u0e17\u0e22 OR SET OR \u0e15\u0e25\u0e32\u0e14\u0e2b\u0e38\u0e49\u0e19',
  retail: '\u0e19\u0e31\u0e01\u0e25\u0e07\u0e17\u0e38\u0e19\u0e23\u0e32\u0e22\u0e22\u0e48\u0e2d\u0e22 OR \u0e01\u0e2d\u0e07\u0e17\u0e38\u0e19\u0e23\u0e27\u0e21 OR \u0e17\u0e2d\u0e07\u0e04\u0e33 OR \u0e14\u0e2d\u0e01\u0e40\u0e1a\u0e35\u0e49\u0e22',
  stocks: '\u0e2b\u0e38\u0e49\u0e19 DELTA OR GULF OR \u0e18\u0e19\u0e32\u0e04\u0e32\u0e23 OR \u0e19\u0e49\u0e33\u0e21\u0e31\u0e19 OR NVIDIA OR TESLA OR TSMC OR Apple OR Microsoft OR AMD OR Google OR JPMorgan OR Alibaba'
};

function gnewsUrl(q) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:7d') + '&hl=th&gl=TH&ceid=TH:th';
}

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

exports.handler = async () => {
  const settled = await Promise.allSettled(
    Object.entries(FEEDS).map(async ([key, query]) => {
      const r = await get(gnewsUrl(query));
      if (r.code !== 200) throw new Error('http ' + r.code);
      const items = parseRSS(r.body);
      if (!items.length) throw new Error('empty feed');
      return { key, items };
    })
  );

  const feeds = { market: [], retail: [], stocks: [] };
  settled.forEach(r => {
    if (r.status === 'fulfilled') feeds[r.value.key] = r.value.items;
  });

  const total = feeds.market.length + feeds.retail.length + feeds.stocks.length;
  if (total === 0) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'all feeds failed' }) };
  }
  return { statusCode: 200, headers: CORS, body: JSON.stringify(feeds) };
};
