// api/proxy.js — CommonJS + 文字コード自動変換
// ?u=potiboard5/xxx を中継。XFO/CSPを除去し、HTMLは Shift_JIS/EUC-JP → UTF-8 に変換して返す。

const iconv = require('iconv-lite');

module.exports = async function handler(req, res) {
  try {
    const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';
    const u = ((req.query && req.query.u) ? String(req.query.u) : '').replace(/^\//, '');
    if (!u) { res.status(400).send('missing ?u='); return; }

    // ?u 以外のクエリはそのまま付け替え
    const reqUrl = new URL(req.url, 'http://local');
    const sp = new URLSearchParams(reqUrl.search);
    sp.delete('u');
    const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

    // 転送ヘッダ（hop-by-hop除去）
    const hop = new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','accept-encoding']);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!hop.has(k.toLowerCase())) headers[k] = v;
    }
    // WAFゆるめ（最低限）
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

    // ステータス & ヘッダ
    res.status(up.status);
    const ct = (up.headers.get('content-type') || '').toLowerCase();

    // 埋め込み阻害・壊れやすいヘッダは除去（encoding/lengthは再計算させる）
    up.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') return;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;
      if (k === 'content-encoding') return;
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

    // HTMLなら文字コードをUTF-8へ。charset検出（簡易）
    if (ct.includes('text/html')) {
      // Content-Type / meta charset を見て変換元を推定
      let srcCharset = 'utf-8';
      if (ct.includes('shift_jis') || ct.includes('shift-jis') || ct.includes('sjis')) srcCharset = 'shift_jis';
      if (ct.includes('euc-jp')) srcCharset = 'euc-jp';

      // metaタグからの追加検出
      const headSniff = buf.slice(0, 2048).toString('ascii');
      if (/charset\s*=\s*shift[_-]?jis/i.test(headSniff)) srcCharset = 'shift_jis';
      if (/charset\s*=\s*euc[_-]?jp/i.test(headSniff)) srcCharset = 'euc-jp';

      let html;
      if (srcCharset === 'utf-8') {
        html = buf.toString('utf8');
        res.setHeader('content-type', 'text/html; charset=utf-8');
      } else {
        html = iconv.decode(buf, srcCharset);
        // 相対リンクを自プロキシに書き換え（/potiboard5/... と potiboard5/...）
        res.setHeader('content-type', 'text/html; charset=utf-8');
      }

      // リンク書き換え
      html = html
        .replace(/(href|src|action)=["']\/(potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`)
        .replace(/(href|src|action)=["'](potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`);

      res.send(html);
      return;
    }

    // HTML以外はそのまま
    res.send(buf);
  } catch (e) {
    res.status(500).send('proxy error: ' + (e && e.message ? e.message : String(e)));
  }
};
