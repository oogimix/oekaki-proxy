export default async function handler(req, res) {
  const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

  // 入力: ?u=potiboard5/potiboard.php など
  const u = (req.query.u || '').toString().replace(/^\//, '');
  if (!u) { res.status(400).send('missing ?u='); return; }

  // CORS（必要なら後で自ドメインに絞る）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // 上流URL作成（u以外のクエリはそのまま転送）
  const orig = new URL(req.url, 'https://dummy.local');
  const qs = new URLSearchParams(orig.search);
  qs.delete('u');
  const target = new URL('/' + u + (qs.toString() ? `?${qs}` : ''), upstreamBase);

  // 転送ヘッダ
  const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!hop.has(k.toLowerCase())) headers[k] = v;
  }
  // WAF対策（必要に応じて調整）
  headers['referer'] = `${upstreamBase}potiboard5/potiboard.php`;
  headers['origin']  = new URL(upstreamBase).origin;
  headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  // ボディ
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
    body = Buffer.concat(chunks);
  }

  // 取得
  let up;
  try {
    up = await fetch(target.toString(), { method: req.method, headers, body, redirect: 'manual' });
  } catch (e) {
    res.status(502).send('Upstream fetch failed: ' + e.message);
    return;
  }

  // レスポンスヘッダ調整
  res.status(up.status);
  const ct = up.headers.get('content-type') || '';
  up.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'x-frame-options') return;
    if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;
    if (k === 'location') {
      try {
        const loc = new URL(value, upstreamBase);
        cons
