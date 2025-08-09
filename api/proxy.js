// api/proxy.js
// 中継先（HTTPSでトライしてダメならHTTPにフォールバック）
const ORIGIN_HOST = 'sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

// ---- helpers -------------------------------------------------
const isRedirect = (s) => [301,302,303,307,308].includes(s);
const getSetCookies = (h) => (h.raw && h.raw()['set-cookie']) || [];

function rewriteHtml(html, host) {
  html = html.replace(/target=["']?_blank["']?/gi, '');
  html = html.replace(
    /(href|src|action)=["'](?!https?:\/\/|data:|mailto:)([^"']+)["']/gi,
    (_, a, p) => {
      const clean = ('/' + p).replace(/\/{2,}/g, '/').replace(/^\/\.\//, '/');
      return `${a}="${new URL(clean, `https://${host}`).toString()}"`;
    }
  );
  return html;
}

async function forward(req, upstreamUrl, headers, body) {
  return fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: ['GET','HEAD'].includes(req.method) ? undefined : body,
    redirect: 'manual'
  });
}

module.exports = async (req, res) => {
  try {
    const u = ((req.query && req.query.u) || '').toString().replace(/^\//, '');
    const path = '/' + (u || DEFAULT_PATH);

    // 受信ボディ
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // 転送ヘッダ（hop-by-hop除去＋補完）
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];
    const originHttps = `https://${ORIGIN_HOST}`;
    headers['referer']    = headers['referer'] || `${originHttps}/potiboard5/`;
    headers['origin']     = headers['origin']  || originHttps;
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';

    // まず HTTPS で試す → 失敗したら HTTP にフォールバック
    let upstreamRes;
    let upstreamUrl = `https://${ORIGIN_HOST}${path}`;
    try {
      upstreamRes = await forward(req, upstreamUrl, headers, body);
    } catch (e) {
      // HTTPS がダメな環境向けの退避（共有レンタル鯖あるある）
      upstreamUrl = `http://${ORIGIN_HOST}${path}`;
      headers['origin']  = `http://${ORIGIN_HOST}`;
      headers['referer'] = `http://${ORIGIN_HOST}/potiboard5/`;
      upstreamRes = await forward(req, upstreamUrl, headers, body);
    }

    // レスポンスヘッダ整形
    const out = {};
    upstreamRes.headers.forEach((v,k) => {
      const key = k.toLowerCase();
      if (key === 'x-frame-options') return;            // 埋め込み拒否は除去
      if (key === 'content-security-policy') return;    // CSPは付け直す
      out[k] = v;
    });
    out['content-security-policy'] = 'frame-ancestors https://sushihamster.com';
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    out['cache-control'] = 'no-store';

    // Cookie ドメイン補正 + SameSite=None; Secure
    const sc = getSetCookies(upstreamRes.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map(
        s => s.replace(/;?\s*Domain=[^;]+/i,'') + `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // リダイレクトは自ドメインへ書き換え
    if (isRedirect(upstreamRes.status)) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(upstreamRes.status, out);
      return res.end();
    }

    // 本体
    const ct = upstreamRes.headers.get('content-type') || '';
    const buf = Buffer.from(await upstreamRes.arrayBuffer());

    // HTMLはリンク書き換え
    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8'); // 文字化けしたら後でiconv対応可
      html = rewriteHtml(html, req.headers.host);
      out['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(200, out); return res.end(html);
    }

    out['content-type'] = ct || 'application/octet-stream';
    res.writeHead(upstreamRes.status, out);
    res.end(buf);

  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type','text/plain; charset=utf-8');
    res.end(`proxy error: ${e?.name || ''} ${e?.code || ''} ${e?.message || e}`);
  }
};
