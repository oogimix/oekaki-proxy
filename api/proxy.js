// api/proxy.js
// Vercel Node (CommonJS) – HTMLだけサーバ側でUTF-8へ再エンコード

const iconv = require('iconv-lite');
require('iconv-lite/encodings'); // ISO-2022-JP 等を有効化

const UPSTREAM_ORIGIN = 'https://sush1h4mst3r.stars.ne.jp/';

// 正規化エイリアス
const ALIAS = new Map([
  ['utf8', 'utf-8'], ['utf-8', 'utf-8'],
  ['eucjp', 'euc-jp'], ['euc-jp', 'euc-jp'], ['euc_jp', 'euc-jp'],
  ['shift_jis', 'cp932'], ['shift-jis', 'cp932'], ['sjis', 'cp932'], ['cp932','cp932'], ['ms932','cp932'],
  ['iso-2022-jp', 'iso-2022-jp'], ['jis','iso-2022-jp'], ['iso2022jp','iso-2022-jp']
]);

function normCharset(v='') {
  const k = v.toLowerCase().trim();
  return ALIAS.get(k) || k;
}

function isHtmlLike(contentType, pathname) {
  if (contentType && /text\/html/i.test(contentType)) return true;
  const p = (pathname || '').toLowerCase();
  return p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.php') || p.endsWith('/');
}

function detectFromContentType(ct='') {
  const m = /charset\s*=\s*([^;\s]+)/i.exec(ct);
  return m ? normCharset(m[1]) : null;
}

function detectFromMeta(buf) {
  // 先頭32KBだけ見る
  const head = buf.subarray(0, Math.min(buf.length, 32768)).toString('latin1');
  const m1 = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'>\s;]+)/i);
  if (m1) return normCharset(m1[1]);
  // http-equiv 形式
  const m2 = head.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([^"'>\s;]+)/i);
  if (m2) return normCharset(m2[1]);
  return null;
}

function detectFromBytes(buf) {
  // とりあえず簡易ヒューリスティック
  // JIS の ESC シーケンス
  if (/\x1B\$[@B]|\x1B\(B|\x1B\(J/.test(buf.toString('latin1'))) return 'iso-2022-jp';
  // EUC-JP でよく出る 0x8E (半角カナ) or 0x8F
  const has8E = buf.includes(0x8E) || buf.includes(0x8F);
  if (has8E) return 'euc-jp';
  // 迷ったら CP932 に寄せる（Windows系で多い）
  return 'cp932';
}

function sanitizeHeaders(h, { isHtml, finalCharset }) {
  const out = new Headers();
  for (const [k, v] of h.entries()) out.set(k, v);

  ['x-frame-options','content-security-policy','content-length','content-encoding','transfer-encoding']
    .forEach(k => out.delete(k));

  if (isHtml) {
    out.set('content-type', `text/html; charset=${finalCharset || 'utf-8'}`);
  }
  out.set('access-control-allow-origin', '*');
  return out;
}

function rewriteMetaToUtf8(html) {
  // meta の charset を強制的に utf-8 に
  let out = html.replace(/(<meta[^>]+charset\s*=\s*)["']?[^"'>\s;]+/i, '$1utf-8');
  out = out.replace(
    /(<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=\s*["'][^"']*charset=)[^"']+/i,
    '$1utf-8'
  );
  return out;
}

function buildUpstreamUrl(u) {
  try { return new URL(u).toString(); }
  catch { return new URL(u.replace(/^\//,''), UPSTREAM_ORIGIN).toString(); }
}

function buildProxyUrl(req, nextPathname) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const origin = `${proto}://${host}`;
  const uParam = encodeURIComponent(nextPathname.replace(/^\//,''));
  return `${origin}/api/proxy?u=${uParam}`;
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const u = url.searchParams.get('u');
    if (!u) { res.statusCode = 400; res.end('Missing ?u='); return; }

    const force = normCharset(url.searchParams.get('force') || '');
    const passthru = url.searchParams.get('passthru'); // デバッグ用: 1 なら変換せず素通し

    const upstreamUrl = buildUpstreamUrl(u);
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': UPSTREAM_ORIGIN,
        'Accept-Encoding': 'identity'
      },
      redirect: 'manual',
    });

    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        const nextPathname = abs.href.replace(UPSTREAM_ORIGIN, '');
        const proxied = buildProxyUrl(req, nextPathname);
        res.statusCode = upstreamRes.status;
        res.setHeader('Location', proxied);
        res.end();
        return;
      }
    }

    const ct = upstreamRes.headers.get('content-type') || '';
    const pathname = new URL(upstreamUrl).pathname;
    const isHtml = isHtmlLike(ct, pathname);

    // ---- HTML以外は素通し（バイナリ対応）----
    if (!isHtml || passthru === '1') {
      const headers = sanitizeHeaders(upstreamRes.headers, { isHtml: false });
      for (const [k,v] of headers.entries()) res.setHeader(k,v);
      res.statusCode = upstreamRes.status;

      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    // ---- HTML はバイトを全部集めて文字コード判定→UTF-8へ変換 ----
    const chunks = [];
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);

    // 判定
    let srcCharset =
      (force && force) ||
      detectFromContentType(ct) ||
      detectFromMeta(buf) ||
      detectFromBytes(buf);

    // 安全策：iconv-lite が知らない名前を弾く
    if (!['utf-8','euc-jp','cp932','iso-2022-jp'].includes(srcCharset)) {
      srcCharset = 'euc-jp'; // 既定（POTI既定に寄せる）
    }

    let htmlUtf8;
    try {
      if (srcCharset === 'utf-8') {
        htmlUtf8 = buf.toString('utf8');
      } else {
        htmlUtf8 = iconv.decode(buf, srcCharset);
      }
    } catch (e) {
      // フォールバック：CP932→ダメならEUC-JP
      try { htmlUtf8 = iconv.decode(buf, 'cp932'); }
      catch { htmlUtf8 = iconv.decode(buf, 'euc-jp'); }
    }

    // meta の charset も utf-8 に書き換え
    htmlUtf8 = rewriteMetaToUtf8(htmlUtf8);

    const headers = sanitizeHeaders(upstreamRes.headers, { isHtml: true, finalCharset: 'utf-8' });
    for (const [k,v] of headers.entries()) res.setHeader(k,v);
    res.statusCode = upstreamRes.status;
    res.end(htmlUtf8);

  } catch (err) {
    console.error('proxy error:', err && err.stack || err);
    res.statusCode = 502;
    res.end('proxy error');
  }
};
