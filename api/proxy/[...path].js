export default async function handler(req, res) {
  const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

  // まずは広め（あとでOriginを絞ってOK）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, *');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const segs = Array.isArray(req.query.path) ? req.query.path : [];
  const path = segs.join('/');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = new URL(path + qs, upstreamBase).toString();

  const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
  const headers = {};
  for (const [k,v] of Object.entries(req.headers)) {
    if (!hop.has(k.toLowerCase())) headers[k] = v;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    await new Promise((ok, ng) => { req.on('data', c=>chunks.push(c)); req.on('end', ok); req.on('error', ng); });
    body = Buffer.concat(chunks);
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
  } catch (e) {
    res.status(502).send('Upstream fetch failed: ' + e.message);
    return;
  }

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
    res.setHeader(key, value);
  });

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.send(buf);
}
