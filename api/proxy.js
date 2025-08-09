// api/proxy.js
const ORIGIN_HOST = 'sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

const isRedirect = s => [301,302,303,307,308].includes(s);
const getSetCookies = h => (h.raw && h.raw()['set-cookie']) || [];

// 相対URLを「そのページの上流URL」を基準に絶対化し、プロキシ経由URLへ置換
function rewriteHtml(html, host, upstreamPageUrl) {
  try {
    const base = new URL(upstreamPageUrl);
    html = html.replace(/target=["']?_blank["']?/gi, '');
    html = html.replace(
      /(href|src|action)=["'](?!https?:\/\/|data:|mailto:|javascript:)([^"']+)["']/gi,
      (_, attr, p) => {
        // p をそのページの上流URL(base)基準で解決
        const absOnOrigin = new URL(p, base); // 例: https://stars.ne.jp/potiboard5/potiboard.php
        // それをプロキシの同パスへ
        const proxied = new URL(absOnOrigin.pathname + absOnOrigin.search, `https://${host}`).toString();
        return `${attr}="${proxied}"`;
      }
    );
    return html;
  } catch {
    return html;
  }
}

async function doFetch(req, url, headers, body) {
  return fetch(url, {
    method: req.method,
    headers,
    body: ['GET','HEAD','OPTIONS'].includes(req.method) ? undefined : body,
    redirect: 'manual'
  });
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const debug = '__debug' in q || 'debug' in q;

  // CORS (preflight)
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
    const fromU = (q.u || '').toString().replace(/^\//,'');
    let upstreamUrl = q.__alt
      ? q.__alt.toString()
      : `https://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//,'')}`;

    // headers （gzip拒否 & UA・参照元補完）
    const headers = { ...req.headers };
    delete headers.host;
    headers['accept-encoding'] = 'identity'; // 圧縮は受けない
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';
    headers['origin']  = upstreamUrl.startsWith('https://') ? `https://${ORIGIN_HOST}` : `http://${ORIGIN_HOST}`;
    headers['referer'] = upstreamUrl; // ★ 毎回、そのリクエスト先を参照元に

    // fetch（HTTPS → 失敗時 HTTP）
    let r;
    let tried = 'https';
    try {
      r = await doFetch(req, upstreamUrl, headers, body);
    } catch (e) {
      if (!q.__alt) {
        upstreamUrl = `http://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//,'')}`;
        headers['origin']  = `http://${ORIGIN_HOST}`;
        headers['referer'] = upstreamUrl;
        r = await doFetch(req, upstreamUrl, headers, body);
        tried = 'http';
      } else {
        throw e;
      }
    }

    // out headers（上流コピー＋調整）
    const out = {};
    r.headers.forEach((v,k)=>{
      const key = k.toLowerCase();
      if (key==='x-frame-options') return;
      if (key==='content-security-policy') return;
      if (key==='content-encoding') return;
      if (key==='content-length') return;
      out[k]=v;
    });
    out['content-security-policy'] =
      "frame-ancestors https://sushihamster.com https://*.sushihamster.com https://*.github.io http://localhost:* http://127.0.0.1:*";
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    out['cache-control'] = 'no-store';

    // cookie 補正
    const sc = getSetCookies(r.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map(
        s => s.replace(/;?\s*Domain=[^;]+/i,'') + `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // debug: redirect 可視化
    const isRedir = [301,302,303,307,308].includes(r.status);
    if (debug && isRedir) {
      const loc = r.headers.get('location') || '(none)';
      const abs = new URL(loc, upstreamUrl);
      const rewritten = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      res.statusCode = r.status;
      res.setHeader('content-type','text/plain; charset=utf-8');
      return res.end(
        `DEBUG proxy (redirect)\ntried: ${tried}\nupstream: ${upstreamUrl}\nstatus: ${r.status}\nlocation (upstream): ${loc}\nlocation (rewritten): ${rewritten}\n`
      );
    }

    // 本番のリダイレクト処理（Location張り替え）
    if (isRedir) {
      const loc = r.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(r.status, out);
      return res.end();
    }

    // body
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());

    if (debug) {
      res.statusCode = r.status || 200;
      res.setHeader('content-type','text/plain; charset=utf-8');
      return res.end(`DEBUG proxy\nstatus: ${r.status}\ntried: ${tried}\nupstream: ${upstreamUrl}\ncontent-type: ${ct || '(none)'}\ncontent-length: ${buf.length}\n`);
    }

    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8');
      // ★ ここが修正点：そのページの上流URLを基準に相対リンクを解決
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
    res.setHeader('content-type','text/plain; charset=utf-8');
    res.end(`proxy error: ${e?.name || ''} ${e?.code || ''} ${e?.message || e}`);
  }
};
