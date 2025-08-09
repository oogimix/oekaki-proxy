// api/proxy.js
// StarServer 上の POTI-board を Vercel 経由で中継する完全版プロキシ
// - iframe許可 (CSP frame-ancestors)
// - X-Frame-Options/CSP 剥がし
// - 相対URLの絶対化（“そのページの上流URL”基準）
// - gzip無効化（content-encoding/content-length除去）
// - Set-Cookie を自ドメイン化 + Path=/ + SameSite=None; Secure
// - 302 の Location を自ドメインに張替
// - NEO の saveimage(POST) は 200 'ok' を返して成功扱いに正規化
// - HTTPS→失敗時HTTPフォールバック
// - OPTIONS(CORS) 即応答
// - デバッグ: __debug=1 でテキスト出力（必要なら）

const ORIGIN_HOST = 'sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

const isRedirect = s => [301, 302, 303, 307, 308].includes(s);

// Set-Cookie を実装差異に関係なく確実に取り出す
const getSetCookies = (h) => {
  if (typeof h.raw === 'function' && h.raw()['set-cookie']) {
    return h.raw()['set-cookie'];
  }
  const one = h.get && h.get('set-cookie');
  return one ? [one] : [];
};

// 相対URLを “そのページの上流URL” 基準で解決し、プロキシ経由の絶対URLへ
function rewriteHtml(html, host, upstreamPageUrl) {
  let base;
  try { base = new URL(upstreamPageUrl); } catch { return html; }

  // 新規タブ抑止
  html = html.replace(/target=["']?_blank["']?/gi, '');

  // href/src/action の相対を base で解決 → プロキシの同パスへ
  html = html.replace(
    /(href|src|action)=["'](?!https?:\/\/|data:|mailto:|javascript:)([^"']+)["']/gi,
    (_, attr, p) => {
      const absOnOrigin = new URL(p, base); // ex) https://stars.ne.jp/potiboard5/potiboard.php
      const proxied = new URL(absOnOrigin.pathname + absOnOrigin.search, `https://${host}`).toString();
      return `${attr}="${proxied}"`;
    }
  );

  return html;
}

async function doFetch(req, url, headers, body) {
  return fetch(url, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body,
    redirect: 'manual',
  });
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const debug = '__debug' in q || 'debug' in q;

  // CORS preflight（念のため）
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-origin', 'https://sushihamster.com');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET,POST,HEAD,OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type, *');
    return res.end();
  }

  try {
    // 受信ボディ
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // 上流URL（__alt があればそれを優先）
    const fromU = (q.u || '').toString().replace(/^\//, '');
    let upstreamUrl = q.__alt
      ? q.__alt.toString()
      : `https://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//, '')}`;

    // 転送ヘッダ（gzip拒否・UA・参照元補完）
    const headers = { ...req.headers };
    delete headers.host;
    headers['accept-encoding'] = 'identity'; // 圧縮不可（書き換えのため）
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';
    // 重要：毎回そのリクエスト先を参照元に
    headers['origin']  = upstreamUrl.startsWith('https://') ? `https://${ORIGIN_HOST}` : `http://${ORIGIN_HOST}`;
    headers['referer'] = upstreamUrl;

    // まず HTTPS → 失敗なら HTTP フォールバック
    let r;
    let tried = 'https';
    try {
      r = await doFetch(req, upstreamUrl, headers, body);
    } catch (e) {
      if (!q.__alt) {
        upstreamUrl = `http://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//, '')}`;
        headers['origin']  = `http://${ORIGIN_HOST}`;
        headers['referer'] = upstreamUrl;
        r = await doFetch(req, upstreamUrl, headers, body);
        tried = 'http';
      } else {
        throw e;
      }
    }

    // レスポンスヘッダ（上流コピー→調整）
    const out = {};
    r.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (key === 'x-frame-options') return;         // 埋め込み拒否は剥がす
      if (key === 'content-security-policy') return; // CSP は付け直す
      if (key === 'content-encoding') return;        // 圧縮ヘッダは外す
      if (key === 'content-length') return;          // 長さは付け直さない
      out[k] = v;
    });

    // 親オリジン許可（開発含む）& キャッシュ無効
    out['content-security-policy'] =
      "frame-ancestors https://sushihamster.com https://*.sushihamster.com https://*.github.io http://localhost:* http://127.0.0.1:*";
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    out['cache-control'] = 'no-store';

    // Set-Cookie → 自ドメインに（Path=/ 強制 & SameSite=None; Secure）
    const sc = getSetCookies(r.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map((line) => {
        let v = line
          .replace(/;?\s*Domain=[^;]+/i, '')
          .replace(/;?\s*Path=[^;]+/i, '');
        v += `; Domain=${req.headers.host}; Path=/; SameSite=None; Secure`;
        return v;
      });
    }

    // ---- ここが NEO 特有：saveimage POST は 200 'ok' に正規化 ----
 const urlObj = new URL(upstreamUrl);
 const isSaveImagePost =
   req.method === 'POST' &&
   /potiboard\.php$/i.test(urlObj.pathname) &&
   (urlObj.searchParams.get('mode') === 'saveimage');

    if (isSaveImagePost && isRedirect(r.status)) {
      // 上流の Set-Cookie などは out に反映済み。本文は 'ok' を返す
      res.writeHead(200, { ...out, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }
    // ------------------------------------------------------------

    // デバッグ時：リダイレクト内容を可視化
    const redir = isRedirect(r.status);
    if (debug && redir) {
      const loc = r.headers.get('location') || '(none)';
      const abs = new URL(loc, upstreamUrl);
      const rewritten = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      res.statusCode = r.status;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(
        `DEBUG proxy (redirect)\ntried: ${tried}\nupstream: ${upstreamUrl}\nstatus: ${r.status}\nlocation (upstream): ${loc}\nlocation (rewritten): ${rewritten}\n`
      );
    }

    // 本番：Location を自ドメインへ張替
    if (redir) {
      const loc = r.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(r.status, out);
      return res.end();
    }

    // 本体
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());

    if (debug) {
      res.statusCode = r.status || 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(
        `DEBUG proxy\nstatus: ${r.status}\ntried: ${tried}\nupstream: ${upstreamUrl}\ncontent-type: ${ct || '(none)'}\ncontent-length: ${buf.length}\n`
      );
    }

    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8');
      html = rewriteHtml(html, req.headers.host, upstreamUrl);
      out['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(200, out);
      return res.end(html);
    }

    out['content-type'] = ct || 'application/octet-stream';
    res.writeHead(r.status, out);
    res.end(buf);

  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`proxy error: ${e?.name || ''} ${e?.code || ''} ${e?.message || e}`);
  }
};
