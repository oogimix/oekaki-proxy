// api/proxy.js — CommonJS 版（VercelのNode関数で安全）
// ?u=potiboard5/xxx を上流に中継。XFO/CSP除去、HTML内リンクを自プロキシに書き換え。

module.exports = async function handler(req, res) {
  try {
    const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

    // ?u= 必須
    const u = ((req.query && req.query.u) ? String(req.query.u) : '').replace(/^\//, '');
    if (!u) { res.status(400).send('missing ?u='); return; }

    // ?u 以外のクエリは転送
    const reqUrl = new URL(req.url, 'http://local');
    const sp = new URLSearchParams(reqUrl.search);
    sp.delete('u');
    const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

    // hop-by-hop 除外
    const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!hop.has(k.toLowerCase())) headers[k] = v;
    }

    // WAFゆるめ（必要最低限）
    headers['referer'] = `${upstreamBase}potiboard5/potiboard.php`;
    headers['origin']  = new URL(upstreamBase).origin;
    if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

    // ボディ（GET/HEAD以外）
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
      body = Buffer.concat(chunks);
    }

    const up = await fetch(target.toString(), { method: req.method, headers, body, redirect: 'manual' });

    // ステータス & ヘッダ（壊れ要因は落とす）
    res.status(up.status);
    const ct = up.headers.get('content-type') || '';

    up.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') return;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;
      if (k === 'content-encoding') return;  // ★ ブランク対策
      if (k === 'content-length') return;    // ★ 再計算させる
      if (k === 'transfer-encoding') return;

      if (k === 'location') {
        try {
          const loc = new URL(value, upstreamBase);
          const proxied = `/api/proxy?u=${encodeURIComponent(loc.pathname.replace(/^\//,''))}${loc.search || ''}${loc.hash || ''}`;
          res.setHeader('Location', proxied);
        } catch { res.setHeader('Location', value); }
        return;
      }
      res.setHeader(key, value);
    });

    const buf = Buffer.from(await up.arrayBuffer());

    // HTMLなら相対リンクを自プロキシへ書き換え
    if (ct.includes('text/html')) {
      let html = buf.toString('utf8');
      html = html
        .replace(/(href|src|action)=["']\/(potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`)
        .replace(/(href|src|action)=["'](potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    // 非HTMLはそのまま
    res.send(buf);
  } catch (e) {
    res.status(500).send('proxy error: ' + (e && e.message ? e.message : String(e)));
  }
};
