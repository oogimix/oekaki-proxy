// api/proxy.js
// 中継先: StarServer 上の POTI-board
// 必要に応じて http に変えて疎通確認: 'http://sush1h4mst3r.stars.ne.jp'
const ORIGIN_BASE = 'https://sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

const { Agent, setGlobalDispatcher, RequestAbortedError } = require('undici');
// IPv4 強制 + タイムアウト
setGlobalDispatcher(new Agent({ connect: { family: 4, timeout: 10_000 } }));

function getSetCookies(h) { return (h.raw && h.raw()['set-cookie']) || []; }
function isRedirect(s) { return [301,302,303,307,308].includes(s); }
function rewriteHtml(html, host) {
  html = html.replace(/target=["']?_blank["']?/gi, '');
  html = html.replace(
    /(href|src|action)=["'](?!https?:\/\/|data:|mailto:)([^"']+)["']/gi,
    (_, a, p) => `${a}="${new URL(('/'+p).replace(/\/{2,}/g,'/').replace(/^\/\.\//,'/'), `https://${host}`).toString()}"`
  );
  return html;
}

module.exports = async (req, res) => {
  try {
    const debug = ('debug' in (req.query||{})) || ('__debug' in (req.query||{}));
    const u = ((req.query && req.query.u) || '').toString().replace(/^\//, '');
    const upstreamUrl = new URL('/' + (u || DEFAULT_PATH), ORIGIN_BASE);

    // 受信ボディ
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // 転送ヘッダ
    const headers = { ...req.headers };
    delete headers.host; delete headers['accept-encoding'];
    try {
      const origin = new URL(ORIGIN_BASE).origin;
      headers['referer'] = headers['referer'] || origin + '/potiboard5/';
      headers['origin']  = headers['origin']  || origin;
      headers['user-agent'] = headers['user-agent'] || 'Mozilla/5.0 (oekaki-proxy)';
    } catch {}

    // fetch（IPv4強制は上の Agent で指定済）
    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: ['GET','HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
      // 念のためのアプリ層タイムアウト（15s）
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });

    // ヘッダ整形
    const out = {};
    upstreamRes.headers.forEach((v,k)=>{
      const key = k.toLowerCase();
      if (key==='x-frame-options') return;
      if (key==='content-security-policy') return;
      out[k]=v;
    });
    out['content-security-policy'] = 'frame-ancestors https://sushihamster.com';
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';
    out['cache-control'] = 'no-store';

    // Cookie 補正
    const sc = getSetCookies(upstreamRes.headers);
    if (sc.length) {
      out['set-cookie'] = sc.map(
        s => s.replace(/;?\s*Domain=[^;]+/i,'') + `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // リダイレクト
    if (isRedirect(upstreamRes.status)) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, ORIGIN_BASE);
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(upstreamRes.status, out);
      return res.end();
    }

    // 本体
    const ct = upstreamRes.headers.get('content-type') || '';
    const buf = Buffer.from(await upstreamRes.arrayBuffer());

    if (!ct && buf.length===0 && debug) {
      out['content-type'] = 'text/plain; charset=utf-8';
      res.writeHead(upstreamRes.status, out);
      return res.end(`empty body from upstream\nstatus=${upstreamRes.status}\nurl=${upstreamUrl}`);
    }

    if (/text\/html/i.test(ct)) {
      let html = buf.toString('utf8');
      html = rewriteHtml(html, req.headers.host);
      out['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(200, out); return res.end(html);
    }

    out['content-type'] = ct || 'application/octet-stream';
    res.writeHead(upstreamRes.status, out); res.end(buf);

  } catch (e) {
    // 失敗詳細を返す（開発中のみ）
    res.statusCode = 502;
    res.setHeader('content-type','text/plain; charset=utf-8');
    const code = e?.code || e?.cause?.code || '';
    const name = e?.name || '';
    const msg  = e?.message || '';
    res.end(`proxy error: ${name} ${code} ${msg}`);
  }
};
