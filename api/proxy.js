// api/proxy.js
// 中継先: StarServer 上の POTI-board
const ORIGIN_BASE = 'https://sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

// ---- util ----------------------------------------------------
function getSetCookies(h) {
  // Vercel/Node fetch で set-cookie 複数対応
  return (h.raw && h.raw()['set-cookie']) || [];
}
function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}
function rewriteHtml(html, host) {
  // target=_blank を削除（iframe外遷移を防ぐ）
  html = html.replace(/target=["']?_blank["']?/gi, '');

  // href/src/action の相対URL → このプロキシ経由の絶対URLへ
  // （data:, mailto:, http(s) は除外）
  html = html.replace(
    /(href|src|action)=["'](?!https?:\/\/|data:|mailto:)([^"']+)["']/gi,
    (_, attr, p) => {
      const clean = ('/' + p).replace(/\/{2,}/g, '/').replace(/^\/\.\//, '/');
      const abs = new URL(clean, `https://${host}`).toString();
      return `${attr}="${abs}"`;
    }
  );
  return html;
}

// ---- handler -------------------------------------------------
module.exports = async (req, res) => {
  try {
    const debug = 'debug' in (req.query || {}) || '__debug' in (req.query || {});
    const u = ((req.query && req.query.u) || '').toString().replace(/^\//, '');
    const upstreamUrl = new URL('/' + (u || DEFAULT_PATH), ORIGIN_BASE);

    // 受信ボディ（multipart/binary対応）
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // 転送ヘッダ（hop-by-hop 除去）
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];

    // 共有レンタルサーバー対策：Referer/Origin/UA を補完
    try {
      const origin = new URL(ORIGIN_BASE).origin;
      headers['referer'] = headers['referer'] || origin + '/potiboard5/';
      headers['origin'] = headers['origin'] || origin;
      headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';
    } catch {}

    // そのまま転送
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });

    // レスポンスヘッダ整形
    const out = {};
    upstreamRes.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (key === 'x-frame-options') return; // 埋め込み拒否は剥がす
      if (key === 'content-security-policy') return; // 上流CSPは無効化（後で付け直す）
      // hop-by-hop 的なものは返さない（transfer-encoding 等は fetch が面倒見てる）
      out[k] = v;
    });

    // クリックジャッキング対策を “許可” 側で明示（親：GitHub Pages）
    out['content-security-policy'] = 'frame-ancestors https://sushihamster.com';
    // CORS（iframe内でのXHRがある場合に備えて）
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    // キャッシュしない（開発中は特に）
    out['cache-control'] = 'no-store';

    // Set-Cookie を自ドメイン化＋クロスサイト許可
    const sc = getSetCookies(upstreamRes.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map((line) =>
        line.replace(/;?\s*Domain=[^;]+/i, '') +
        `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // リダイレクトは Location を自ドメインに張り替える
    if (isRedirect(upstreamRes.status)) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, ORIGIN_BASE); // 相対でもOKに
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(upstreamRes.status, out);
      return res.end();
    }

    // 本体
    const ct = upstreamRes.headers.get('content-type') || '';
    const buf = Buffer.from(await upstreamRes.arrayBuffer());

    // デバッグ：空レスなら理由が見えるように
    if (!ct && buf.length === 0 && debug) {
      out['content-type'] = 'text/plain; charset=utf-8';
      res.writeHead(upstreamRes.status, out);
      return res.end(
        `empty body from upstream\nstatus=${upstreamRes.status}\nurl=${upstreamUrl.toString()}`
      );
    }

    // HTML の場合は書き換え
    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8'); // ※要SJIS対応なら後でiconvを足す
      html = rewriteHtml(html, req.headers.host);
      out['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(200, out);
      return res.end(html);
    }

    // それ以外は素通し
    out['content-type'] = ct || 'application/octet-stream';
    res.writeHead(upstreamRes.status, out);
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.status(502).send('proxy error: ' + e.message);
  }
};
