export default async function handler(req, res) {
  const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

  // 入力 ?u=potiboard5/xxx
  const u = (req.query.u || '').toString().replace(/^\//, '');
  if (!u) return res.status(400).send('missing ?u=');

  // CORS（あとで必要ならOriginを絞る）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // 上流URL（?u以外のクエリはそのまま転送）
  const orig = new URL(req.url, 'https://dummy.local');
  const sp = new URLSearchParams(orig.search);
  sp.delete('u');
  const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

  // 転送ヘッダ
  const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
  const headers = {};
  for (const [k,v] of Object.entries(req.headers)) if (!hop.has(k.toLowerCase())) headers[k] = v;

  // WAF回避寄りのヘッダ
  headers['referer'] = `${upstreamBase}potiboard5/potiboard.php`;
  headers['origin']  = new URL(upstreamBase).origin;
  headers['user-agent'] ||= 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

  // ボディ
  let body;
  if (!['GET','HEAD'].includes(req.method)) {
    const chunks=[]; await new Promise((ok,ng)=>{req.on('data',c=>chunks.push(c));req.on('end',ok);req.on('error',ng);});
    body = Buffer.concat(chunks);
  }

  // 上流へ
  let up; try {
    up = await fetch(target.toString(), { method:req.method, headers, body, redirect:'manual' });
  } catch(e) { return res.status(502).send('Upstream fetch failed: '+e.message); }

  // レスポンスヘッダ調整
  res.status(up.status);
  const ct = up.headers.get('content-type') || '';
  up.headers.forEach((value,key)=>{
    const k = key.toLowerCase();
    if (k==='x-frame-options') return;
    if (k==='content-security-policy' || k==='content-security-policy-report-only') return;
    if (k==='location') {
      try {
        const loc = new URL(value, upstreamBase);
        const proxied = `/api/proxy?u=${encodeURIComponent(loc.pathname.replace(/^\//,''))}${loc.search||''}${loc.hash||''}`;
        res.setHeader('Location', proxied);
      } catch { res.setHeader('Location', value); }
      return;
    }
    if (k==='set-cookie') {
      const cookies = up.headers.getSetCookie ? up.headers.getSetCookie() : [value];
      if (cookies) res.setHeader('Set-Cookie', cookies);
      return;
    }
    res.setHeader(key, value);
  });

  const buf = Buffer.from(await up.arrayBuffer());

  // HTMLなら相対リンクを書き換え（/potiboard5/... → /api/proxy?u=...）
  if (ct.includes('text/html')) {
    let html = buf.toString('utf8');
    html = html
      .replace(/(href|src|action)=["']\/(potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`)
      .replace(/(href|src|action)=["'](potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  res.send(buf);
}
