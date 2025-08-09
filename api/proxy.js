// api/proxy.js — 素通し版（文字コードは一切いじらない）
// ・?u=potiboard5/xxx を上流へそのまま中継
// ・X-Frame-Options / CSP / content-encoding / content-length を落として送る
// ・本文は Buffer のまま返す（= EUC-JP でもそのまま。ブラウザが正しく描画）

module.exports = async function handler(req, res) {
  try {
    const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';
    const u = ((req.query && req.query.u) ? String(req.query.u) : '').replace(/^\//, '');
    if (!u) { res.status(400).send('missing ?u='); return; }

    // ?u 以外のクエリを引き継ぎ
    const reqUrl = new URL(req.url, 'http://local');
    const sp = new URLSearchParams(reqUrl.search);
    sp.delete('u');
    const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

    // hop-by-hop系は除外（accept-encoding は送らない＝サーバ側で圧縮させない）
    const hop = new Set([
      'host','connection','keep-alive','proxy-authenticate','proxy-authorization',
      'te','trailer','transfer-encoding','upgrade','content-length','accept-encoding'
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!hop.has(k.toLowerCase())) headers[k] = v;
    }
    // 軽いWAF回避
    headers['referer'] = `${upstreamBase}potiboard5/potiboard.php`;
    headers['origin']  = new URL(upstreamBase).origin;
    if (!headers['user-agent']) {
      headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
    }

    // ボディ（GET/HEAD以外）
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
      body = Buffer.concat(chunks);
    }

    const up = await fetch(target.toString(), { method: req.method, headers, body, redirect: 'manual' });

    // 上流ヘッダを調整してそのまま返す（本文は触らない）
    res.status(up.status);
    up.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') return;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;
      if (k === 'content-encoding') return; // ブランク防止
      if (k === 'content-length') return;   // 再計算させる
      if (k === 'transfer-encoding') return;

      if (k === 'location') {
        // リダイレクトはプロキシ経由に変換（必要に応じて）
        try {
          const loc = new URL(value, upstreamBase);
          const proxied = `/api/proxy?u=${encodeURIComponent(loc.pathname.replace(/^\//,''))}${loc.search||''}${loc.hash||''}`;
          res.setHeader('Location', proxied);
        } catch { res.setHeader('Location', value); }
        return;
      }
      res.setHeader(key, value);
    });

    const buf = Buffer.from(await up.arrayBuffer());
    res.send(buf); // ← 文字コードは上流のまま（EUC-JP等）。ブラウザがそのまま描画
  } catch (e) {
    res.status(500).send('proxy error: ' + (e && e.message ? e.message : String(e)));
  }
};
