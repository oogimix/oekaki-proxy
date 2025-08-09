// 中継先: StarServer上のPOTI-board
const ORIGIN_BASE = 'https://sush1h4mst3r.stars.ne.jp';
const DEFAULT_PATH = '/potiboard5/potiboard.php';

export default async function handler(req, res) {
  try {
    // u= が空ならデフォルトへ
    const u = (req.query.u || '').toString().replace(/^\//, '');
    const upstreamUrl = new URL('/' + (u || DEFAULT_PATH), ORIGIN_BASE);

    // リクエストボディ（multipart/binary対応）
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    // 転送ヘッダ（hop-by-hop 除去）
    const headers = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];

    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers,
      body: ['GET','HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual'
    });

    // ---- レスポンスヘッダ整形 ----
    const out = {};
    upstreamRes.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'x-frame-options') out[k] = v; // 埋め込み拒否は剥がす
    });

    // iframe 許可（親は GitHub Pages 本体）
    out['content-security-policy'] = 'frame-ancestors https://sushihamster.com';
    // 必要ならCORS（iframe内でfetchするなら）
    out['access-control-allow-origin'] = 'https://sushihamster.com';
    out['access-control-allow-credentials'] = 'true';

    // Set-Cookie を自サブドメイン用に付け替え + クロスサイト許可
    const setCookies = upstreamRes.headers.getSetCookie?.()
      || upstreamRes.headers.raw?.()['set-cookie'] || [];
    if (setCookies.length) {
      out['set-cookie'] = setCookies.map(sc =>
        sc.replace(/;?\s*Domain=[^;]+/i, '') +
        `; Domain=${req.headers.host}; SameSite=None; Secure`
      );
    }

    // リダイレクトは Location を書き換え（常に oekaki.* 経由に）
    if ([301,302,303,307,308].includes(upstreamRes.status)) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, ORIGIN_BASE);
        out['location'] = new URL(abs.pathname + abs.search, `https://${req.headers.host}`).toString();
      }
      res.writeHead(upstreamRes.status, out);
      return res.end();
    }

    // 本体
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    const ct = upstreamRes.headers.get('content-type') || '';

    // HTML のときだけ最低限の書き換え（相対リンク/target）
    if (ct.includes('text/html')) {
      let html = buf.toString('utf8'); // 文字化けしたら後でiconv対応する
      html = html.replace(/target=["']?_blank["']?/gi, ''); // 新規タブ回避
      html = html.replace(
        /(href|src|action)=["'](?!https?:\/\/|data:|mailto:)([^"']+)["']/gi,
        (_, a, p) => `${a}="${new URL('/' + p.replace(/^\.?\//,''), `https://${req.headers.host}`).toString()}"`
      );
      out['content-type'] = 'text/html; charset=utf-8';
      res.writeHead(200, out);
      return res.end(html);
    }

    out['content-type'] = ct || 'application/octet-stream';
    res.writeHead(upstreamRes.status, out);
    res.end(buf);
  } catch (e) {
    console.error(e);
    res.status(502).send('proxy error: ' + e.message);
  }
}
