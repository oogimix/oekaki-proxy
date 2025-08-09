// api/proxy.js
const ORIGIN_HOST = 'sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

const isRedirect = s => [301,302,303,307,308].includes(s);
const getSetCookies = h => (h.raw && h.raw()['set-cookie']) || [];

function rewriteHtml(html, host) {
  html = html.replace(/target=["']?_blank["']?/gi, '');
  html = html.replace(
    /(href|src|action)=["'](?!https?:\/\/|data:|mailto:)([^"']+)["']/gi,
    (_, a, p) => `${a}="${new URL(('/'+p).replace(/\/{2,}/g,'/').replace(/^\/\.\//,'/'), `https://${host}`).toString()}"`
  );
  return html;
}
async function doFetch(req, url, headers, body) {
  return fetch(url, {
    method: req.method,
    headers,
    body: ['GET','HEAD'].includes(req.method) ? undefined : body,
    redirect: 'manual'
  });
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const debug = ('__debug' in q) || ('debug' in q);
  try {
    // body
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // upstream URL
    const fromU = (q.u || '').toString().replace(/^\//,'');
    let upstreamUrl = q.__alt
      ? q.__alt.toString()
      : `https://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//,'')}`;

    // headers
    const headers = { ...req.headers };
    delete headers.host; delete headers['accept-encoding'];
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';
    headers['origin']  = headers['origin']  || `https://${ORIGIN_HOST}`;
    headers['referer'] = headers['referer'] || `https://${ORIGIN_HOST}/potiboard5/`;

    // try HTTPS → fallback HTTP
    let r, tried = 'https';
    try {
      r = await doFetch(req, upstreamUrl, headers, body);
    } catch {
      if (!q.__alt) {
        upstreamUrl = `http://${ORIGIN_HOST}/${fromU || DEFAULT_PATH.replace(/^\//,'')}`;
        headers['origin']  = `http://${ORIGIN_HOST}`;
        headers['referer'] = `http://${ORIGIN_HOST}/potiboard5/`;
        r = await doFetch(req, upstreamUrl, headers, body);
        tried = 'http';
      } else {
        throw e;
      }
    }

    // common out headers（上流XFO/CSPは剥がして付け直す）
    const out = {};
    r.headers.forEach((v,k)=>{
      const key = k.toLowerCase();
      if (key==='x-frame-options') return;
      if (key==='content-security-policy') return;
      out[k]=v;
    });
    out['content-security-policy'] = 'frame-ancestors https://sushihamster.com';
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    out['cache-control'] = 'no-store';

    // set-cookie補正
    const sc = getSetCookies(r.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map(
        s => s.replace(/;?\s*Domain=[^;]+/i,'') + `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // --- デバッグ時はリダイレクトも可視化して返す ---
    if (debug && isRedirect(r.status)) {
      const headDump = [];
      r.headers.forEach((v,k)=>headDump.push(`${k}: ${v}`));
      const loc = r.headers.get('location') || '(none)';
      const abs = new URL(loc, upstreamUrl);
      const rewritten = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();

      const report = [
        `DEBUG proxy (redirect)`,
        `tried: ${tried}`,
        `upstream: ${upstreamUrl}`,
        `status: ${r.status}`,
        `location (upstream): ${loc}`,
        `location (rewritten): ${rewritten}`,
        `headers:\n${headDump.join('\n')}`
      ].join('\n');

      res.statusCode = r.status;
      res.setHeader('content-type','text/plain; charset=utf-8');
      return res.end(report);
    }
    // ------------------------------------------------------

    // 本番挙動：リダイレクトは location を自ドメインに書き換えて返す
    if (isRedirect(r.status)) {
      const loc = r.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(r.status, out); return res.end();
    }

    // 本体
    const ct = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());

    if (debug) {
      const headDump = []; r.headers.forEach((v,k)=>headDump.push(`${k}: ${v}`));
      const sample = /^text\/|json|javascript|xml|svg/i.test(ct) ? buf.toString('utf8').slice(0,500) : `(binary ${buf.length} bytes)`;
      const report = [
        `DEBUG proxy`,
        `tried: ${tried}`,
        `upstream: ${upstreamUrl}`,
        `status: ${r.status}`,
        `content-type: ${ct || '(none)'}`,
        `content-length: ${buf.length}`,
        `headers:\n${headDump.join('\n')}`,
        `--- body sample ---`,
        sample
      ].join('\n');
      res.statusCode = r.status || 200;
      res.setHeader('content-type','text/plain; charset=utf-8');
      return res.end(report);
    }

    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8');
      html = rewriteHtml(html, req.headers.host);
      out['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(200, out); return res.end(html);
    }

    out['content-type'] = ct || 'application/octet-stream';
    res.writeHead(r.status, out); res.end(buf);

  } catch (e) {
    res.statusCode = 502;
    res.setHeader('content-type','text/plain; charset=utf-8');
    res.end(`proxy error: ${e?.name||''} ${e?.code||''} ${e?.message||e}`);
  }
};
