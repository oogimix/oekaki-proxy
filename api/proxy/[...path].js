export default async function handler(req, res) {
  const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

  // CORS（あとで Origin を自分のGitHub Pagesに絞ってOK）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, *');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const segs = Array.isArray(req.query.path) ? req.query.path : [];
  const path = segs.join('/');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const targetUrl = new URL(path + qs, upstreamBase);

  // 転送ヘッダ（危険/不要は除外）
  const hop = new Set([
    'host','connection','keep-alive','proxy-authenticate','proxy-authorization',
    'te','trailer','transfer-encoding','upgrade','content-length','accept-encoding'
  ]);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!hop.has(k.toLowerCase())) headers[k] = v;
  }

  // ★ 403回避：上流基準のReferer/Origin/User-Agentを明示
  headers['referer'] = upstreamBase; // 上流直アクセスっぽく見せる
  headers['origin']  = new URL(upstreamBase).origin;
  if (!headers['user-agent']) {
    headers['user-agent'] = 'Mozilla/5.0 (proxy; +vercel)';
  }

  // ボディ（POST等）
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
    body = Buffer.concat(chunks);
  }

  // 上流へ
  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), { method: req.method, headers, body, redirect: 'manual' });
  } catch (e) {
    res.status(502).send('Upstream fetch failed: ' + e.message);
    return;
  }

  // ★ デバッグモード：?__debug=1 を付けると情報を返す
  const isDebug = targetUrl.searchParams.has('__debug');

  // レスポンスヘッダ（埋め込み阻害は除去、Locationはプロキシ化）
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'x-frame-options') return;
    if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;

    if (k === 'location') {
      try {
        const loc = new URL(value, upstreamBase);
        const proxied = `/api/proxy/${loc.pathname.replace(/^\//,'')}${loc.search||''}${loc.hash||''}`;
        res.setHeader('Location', proxied);
      } catch { res.setHeader('Location', value); }
      return;
    }
    if (k === 'set-cookie') {
      const cookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [value];
      if (cookies) res.setHeader('Set-Cookie', cookies);
      return;
    }
    res.setHeader(key, value);
  });

  const buf = Buffer.from(await upstream.arrayBuffer());

  if (isDebug) {
    // 上流の最初の数百文字だけテキスト確認
    const sniff = buf.slice(0, 800).toString('utf8');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({
      target: targetUrl.toString(),
      status: upstream.status,
      upstreamHeaders: Object.fromEntries(upstream.headers),
      preview: sniff
    }, null, 2));
    return;
  }

  res.send(buf);
}
