// api/proxy.js — 本番版（?u=... を中継・XFO/CSP除去・HTMLの相対リンク書換）
export default async function handler(req, res) {
  try {
    const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';

    // ?u=potiboard5/xxx 必須
    const u = (req.query.u || '').toString().replace(/^\//, '');
    if (!u) return res.status(400).send('missing ?u=');

    // 上流URL（?u 以外のクエリは転送）
    const reqUrl = new URL(req.url, 'http://local');
    const sp = new URLSearchParams(reqUrl.search);
    sp.delete('u');
    const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

    // 転送ヘッダ（hop-by-hop除去）
    const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!hop.has(k.toLowerCase())) headers[k] = v;
    }
    // 必要最低限の偽装（厳しければ調整）
    headers['referer'] = `${upstreamBase}potiboard5/potiboard.php`;
    headers['origin']  = new URL(upstreamBase).origin;
    headers['user-agent'] ||= 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

    // ボディ（GET/HEAD以外）
    let body;
    if (!['GET','HEAD'].includes(req.method)) {
      const chunks = [];
      await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
      body = Buffer.concat(chunks);
    }

    const up = await fetch(target.toString(), { method: req.method, headers, body, redirect: 'manual' });

    // ステータス & ヘッダ
    res.status(up.status);
    const ct = up.headers.get('content-type') || '';

    up.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') return;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;

      if (k === 'location') {
        // 上流のリダイレクトを自分経由に
        try {
          const loc = new URL(value, upstreamBase);
          const proxied = `/api/proxy?u=${encodeURIComponent(loc.pathname.replace(/^\//,''))}${loc.search || ''}${loc.hash || ''}`;
          res.setHeader('Location', proxied);
        } catch { res.setHeader('Location', value); }
        return;
      }
      res.setHeader(key, value);
    });

    // Set-Cookie（環境差吸収）
    if (typeof up.headers.getSetCookie === 'function') {
      const cookies = up.headers.getSetCookie();
      if (cookies && cookies.length) res.setHeader('Set-Cookie', cookies);
    } else if (up.headers.has('set-cookie')) {
      res.setHeader('Set-Cookie', up.headers.get('set-cookie'));
    }

    const buf = Buffer.from(await up.arrayBuffer());

    // HTMLなら相対リンクを自プロキシに書換
    if (ct.includes('text/html')) {
      let html = buf.toString('utf8');
      html = html
        // /potiboard5/... → /api/proxy?u=potiboard5/...
        .replace(/(href|src|action)=["']\/(potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`)
        .replace(/(href|src|action)=["'](potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // それ以外は素通し
    res.send(buf);
  } catch (e) {
    res.status(500).send('proxy error: ' + (e?.message || e));
  }
}
