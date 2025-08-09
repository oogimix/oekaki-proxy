// api/proxy/[...path].js
export default async function handler(req, res) {
  const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

  // CORS（まずは広め。後で自分のサイトに絞る）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, *');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // 目的URLを作る
  const segs = Array.isArray(req.query.path) ? req.query.path : [];
  const path = segs.join('/');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const targetUrl = new URL(path + qs, upstreamBase);
  const upstreamOrigin = new URL(upstreamBase).origin;

  // 転送ヘッダ（hop-by-hop除外）
  const hop = new Set([
    'host','connection','keep-alive','proxy-authenticate','proxy-authorization',
    'te','trailer','transfer-encoding','upgrade','content-length','accept-encoding'
  ]);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!hop.has(k.toLowerCase())) headers[k] = v;
  }

  // ★ 403回避：本家と同等に見せる
  // - Referer は「実ページの完全URL」を想定（php直打ちを嫌うWAF対策）
  // - Origin も上流オリジン
  // - UA/Accept/Accept-Language も一般的なブラウザに寄せる
  headers['referer'] = `${upstreamOrigin}/potiboard5/potiboard.php`;
  headers['origin']  = upstreamOrigin;
  headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
  headers['accept'] = headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  headers['accept-language'] = headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8';
  // Host は fetch 側で自動付与（上流ホスト）されるので基本不要

  // ボディ（POST等）
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
    body = Buffer.concat(chunks);
  }

  // 上流へ投げる
  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), { method: req.method, headers, body, redirect: 'manual' });
  } catch (e) {
    res.status(502).send('Upstream fetch failed: ' + e.message);
    return;
  }

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
    const sniff = buf.slice(0, 1000).toString('utf8');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify({
      target: targetUrl.toString(),
      status: upstream.status,
      preview: sniff
    }, null, 2));
    return;
  }

  res.send(buf);
}
