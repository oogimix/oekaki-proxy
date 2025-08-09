// api/proxy.js
const ORIGIN_HOST = 'sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

const isRedirect = s => [301,302,303,307,308].includes(s);
const getSetCookies = h => (h.raw && h.raw()['set-cookie']) || [];

function rewriteHtml(html, host) {
  html = html.replace(/target=["']?_blank["']?/gi, '');
  html = html.replace(
    /(href|src|action)=["'](?!https?:\/\/|data:|mailto:)([^"']+)["']/gi,
    (_, a, p) =>
      `${a}="${new URL(
        ('/' + p).replace(/\/{2,}/g, '/').replace(/^\/\.\//, '/'),
        `https://${host}`
      ).toString()}"`
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

  // --- CORS preflight (iframe 内の fetch 用に念のため) ---
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('access-control-allow-origin', 'https://sushihamster.com');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET,POST,HEAD,OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type, *');
    return res.end();
  }

  try {
    // body
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // upstream URL
    const fromU = (q.u || '').toString().replace(/^\//, '');
    let upstreamUrl = q.__alt
      ? q.__alt.toString()
      : `https://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//, '')}`;

    // headers
    const headers = { ...req.headers };
    delete headers.host;
    // 圧縮を明示的に拒否（これ超重要）
    headers['accept-encoding'] = 'identity';
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';
    headers['origin'] = headers['origin'] || `https://${ORIGIN_HOST}`;
    headers['referer'] = headers['referer'] || `https://${ORIGIN_HOST}/potiboard5/`;

    // try HTTPS → fallback HTTP
    let r;
    let tried = 'https';
    try {
      r = await doFetch(req, upstreamUrl, headers, body);
    } catch (e) { // ← ここが重要（e を受け取る）
      if (!q.__alt) {
        upstreamUrl = `http://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//, '')}`;
        headers['origin'] = `http://${ORIGIN_HOST}`;
        headers['referer'] = `http://${ORIGIN_HOST}/potiboard5/`;
        r = await doFetch(req, upstreamUrl, headers, body);
        tried = 'http';
      } else {
        throw e; // ← 正しく再throw
      }
    }

    // 共通レスポンスヘッダ（上流をコピーしつつ調整）
    const out = {};
    r.headers.forEach((v, k) => {
      const key = k.toLowerCase();
      if (key === 'x-frame-options') return;            // 埋め込み拒否は剥がす
      if (key === 'content-security-policy') return;    // CSPは付け直す
      if (key === 'content-encoding') return;           // 圧縮ヘッダは常に外す
      if (key === 'content-length') return;             // 長さも付け直さない
      out[k] = v;
    });
    // 自前ヘッダ
    out['content-security-policy'] =
      "frame-ancestors " +
      "https://sushihamster.com " +
      "https://*.sushihamster.com " +
      "https://*.github.io " +
      "http://localhost:* http://127.0.0.1:*";
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    out['cache-control'] = 'no-store';

    // Cookie 補正
    const sc = getSetCookies(r.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map(
        s => s.replace(/;?\s*Domain=[^;]+/i, '') + `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // デバッグ時はリダイレクト内容を可視化
    const isRedir = isRedirect(r.status);
    if (debug && isRedir) {
      const headDump = [];
      r.headers.forEach((v, k) => headDump.push(`${k}: ${v}`));
      const loc = r.headers.get('location') || '(none)';
      const abs = new URL(loc, upstreamUrl);
      const rewritten = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      res.statusCode = r.status;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(
        `DEBUG proxy (redirect)\ntried: ${tried}\nupstream: ${upstreamUrl}\nstatus: ${r.status}\nlocation (upstream): ${loc}\nlocation (rewritten): ${rewritten}\n`
      );
    }

    // 本番リダイレクト処理
    if (isRedir) {
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
        `DEBUG proxy\ntried: ${tried}\nupstream: ${upstreamUrl}\nstatus: ${r.status}\ncontent-type: ${ct || '(none)'}\ncontent-length: ${buf.length}\n`
      );
    }

    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8');
      html = rewriteHtml(html, req.headers.host);
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
