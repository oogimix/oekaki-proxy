// api/proxy.js
const ORIGIN_HOST = 'sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

const isRedirect = s => [301,302,303,307,308].includes(s);
const getSetCookies = h => (h.raw && h.raw()['set-cookie']) || [];
const asText = async (r) => {
  try { return await r.text(); } catch { return ''; }
};

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
  const start = Date.now();
  const q = req.query || {};
  const debug = ('__debug' in q) || ('debug' in q);
  try {
    // 受信ボディ
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // 上流URLを構築（__alt で任意URLをテスト可能）
    let upstreamUrl = q.__alt
      ? q.__alt.toString()
      : `https://${ORIGIN_HOST}/${((q.u||'').toString().replace(/^\//,'') || DEFAULT_PATH.replace(/^\//,''))}`;

    // 転送ヘッダ整備
    const headers = { ...req.headers };
    delete headers.host; delete headers['accept-encoding'];
    const httpsOrigin = `https://${ORIGIN_HOST}`;
    headers['referer']    = headers['referer'] || `${httpsOrigin}/potiboard5/`;
    headers['origin']     = headers['origin']  || httpsOrigin;
    headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';

    // まず HTTPS
    let r, schemeTried = 'https';
    try {
      r = await doFetch(req, upstreamUrl, headers, body);
    } catch (e) {
      // HTTPS失敗 → HTTPで再試行
      if (!q.__alt) {
        upstreamUrl = `http://${ORIGIN_HOST}/${((q.u||'').toString().replace(/^\//,'') || DEFAULT_PATH.replace(/^\//,''))}`;
        headers['origin']  = `http://${ORIGIN_HOST}`;
        headers['referer'] = `http://${ORIGIN_HOST}/potiboard5/`;
        r = await doFetch(req, upstreamUrl, headers, body);
        schemeTried = 'http';
      } else {
        throw e;
      }
    }

    // 出力ヘッダ（共通）
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

    // Cookie補正
    const sc = getSetCookies(r.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map(
        s => s.replace(/;?\s*Domain=[^;]+/i,'') + `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // リダイレクトなら Location を自ドメインへ
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
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);

    // --- デバッグ: 何も出ない問題を可視化 ---
    if (debug) {
      const headDump = [];
      r.headers.forEach((v,k)=>headDump.push(`${k}: ${v}`));
      let sample = '';
      if (/^text\/|json|javascript|xml|svg/i.test(ct)) {
        const txt = buf.toString('utf8');
        sample = txt.slice(0, 500);
      } else {
        sample = `(binary ${buf.length} bytes)`;
      }
      const report = [
        `DEBUG proxy`,
        `tried: ${schemeTried}`,
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
    // --------------------

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
