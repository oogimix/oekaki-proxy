// api/proxy.js — 文字コードしつこめ判定 + 変換（CommonJS）
const iconv = require('iconv-lite');

module.exports = async function handler(req, res) {
  try {
    const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';
    const u = ((req.query && req.query.u) ? String(req.query.u) : '').replace(/^\//, '');
    if (!u) { res.status(400).send('missing ?u='); return; }

    // ?u以外のクエリを引き継ぐ
    const reqUrl = new URL(req.url, 'http://local');
    const sp = new URLSearchParams(reqUrl.search);
    sp.delete('u');
    const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

    // 最低限の転送ヘッダ（壊れやすいのは除去）
    const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!hop.has(k.toLowerCase())) headers[k] = v;
    }
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

    // ステータス & ヘッダ（埋め込み阻害/壊れやすいものは落とす）
    res.status(up.status);
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    up.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') return;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;
      if (k === 'content-encoding') return; // ブランク対策
      if (k === 'content-length') return;
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

    // ---- HTML は文字コードを判定して UTF-8 に変換して返す ----
    if (ct.includes('text/html')) {
      // 1) Content-Type から推定
      let src = 'utf-8';
      if (/(shift[_-]?jis|sjis|cp932|windows-31j)/i.test(ct)) src = 'cp932';
      else if (/euc[_-]?jp/i.test(ct)) src = 'euc-jp';
      else if (/iso[-_]?2022[-_]?jp/i.test(ct)) src = 'iso-2022-jp';

      // 2) 先頭2KBの <meta charset=...> を見る
      const headAscii = buf.slice(0, 2048).toString('ascii');
      if (/charset\s*=\s*utf-?8/i.test(headAscii)) src = 'utf-8';
      else if (/charset\s*=\s*(shift[_-]?jis|sjis|cp932|windows-31j)/i.test(headAscii)) src = 'cp932';
      else if (/charset\s*=\s*euc[_-]?jp/i.test(headAscii)) src = 'euc-jp';
      else if (/charset\s*=\s*iso[-_]?2022[-_]?jp/i.test(headAscii)) src = 'iso-2022-jp';

      // 3) まだ不明なら日本語サイトは cp932 に寄せる
      if (src === 'utf-8' && /�/.test(buf.toString('utf8').slice(0, 200))) src = 'cp932';

      let html = (src === 'utf-8') ? buf.toString('utf8') : iconv.decode(buf, src);

      // 相対リンクを自プロキシに
      html = html
        .replace(/(href|src|action)=["']\/(potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`)
        .replace(/(href|src|action)=["'](potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`);

      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    // ---- 非HTMLはそのまま ----
    res.send(buf);
  } catch (e) {
    res.status(500).send('proxy error: ' + (e && e.message ? e.message : String(e)));
  }
};
