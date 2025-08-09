// api/proxy.js
// Vercel Node (CommonJS)
// - HTMLだけサーバ側でUTF-8に再エンコード（EUC-JP/CP932/ISO-2022-JP対応）
// - <meta charset> を正しい書式で utf-8 に統一
// - href/src/action などの相対URLを /api/proxy?u=... に書き換え（CSS/JSも効く）
// - XFO/CSP, content-length, content-encoding 削除（iframe & 非圧縮前提）
// - 30x Location を可能な範囲でプロキシへ書き換え

const iconv = require('iconv-lite');
require('iconv-lite/encodings'); // ISO-2022-JP など有効化

// ★上流のルート（最後に / を付ける）
const UPSTREAM_ORIGIN = 'https://sush1h4mst3r.stars.ne.jp/';

// ---- 文字コードユーティリティ ----
const ALIAS = new Map([
  ['utf8', 'utf-8'], ['utf-8', 'utf-8'],
  ['eucjp', 'euc-jp'], ['euc-jp', 'euc-jp'], ['euc_jp', 'euc-jp'],
  ['shift_jis', 'cp932'], ['shift-jis', 'cp932'], ['sjis', 'cp932'],
  ['cp932', 'cp932'], ['ms932', 'cp932'],
  ['iso-2022-jp', 'iso-2022-jp'], ['jis', 'iso-2022-jp'], ['iso2022jp', 'iso-2022-jp']
]);
function normCharset(v = '') {
  const k = v.toLowerCase().trim();
  return ALIAS.get(k) || k;
}
function detectFromContentType(ct = '') {
  const m = /charset\s*=\s*([^;\s]+)/i.exec(ct);
  return m ? normCharset(m[1]) : null;
}
function detectFromMeta(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 32768)).toString('latin1');
  const m1 = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'>\s;]+)/i);
  if (m1) return normCharset(m1[1]);
  const m2 = head.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([^"'>\s;]+)/i);
  if (m2) return normCharset(m2[1]);
  return null;
}
function detectFromBytes(buf) {
  const s = buf.toString('latin1');
  if (/\x1B\$[@B]|\x1B\(B|\x1B\(J/.test(s)) return 'iso-2022-jp'; // JIS
  if (buf.includes(0x8E) || buf.includes(0x8F)) return 'euc-jp'; // EUC傾向
  return 'cp932'; // 最終フォールバック
}
function isHtmlLike(contentType, pathname) {
  if (contentType && /text\/html/i.test(contentType)) return true;
  const p = (pathname || '').toLowerCase();
  return p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.php') || p.endsWith('/');
}

// ---- ヘッダ整形 ----
function sanitizeHeaders(h, { isHtml, finalCharset }) {
  const out = new Headers();
  for (const [k, v] of h.entries()) out.set(k, v);
  ['x-frame-options', 'content-security-policy', 'content-length', 'content-encoding', 'transfer-encoding']
    .forEach(k => out.delete(k));
  if (isHtml) out.set('content-type', `text/html; charset=${finalCharset || 'utf-8'}`);
  out.set('access-control-allow-origin', '*');
  return out;
}

// ---- meta charset を確実に utf-8 へ ----
function rewriteMetaToUtf8(html) {
  let out = html;

  // 1) 既存の charset=... を厳密に utf-8 へ（クォート有無に対応）
  out = out.replace(
    /<meta([^>]*?)\bcharset\s*=\s*(['"]?)[^"'>\s;]+(\2)([^>]*)>/ig,
    '<meta$1charset="utf-8"$4>'
  );

  // 2) http-equiv=content-type の charset も utf-8 へ
  out = out.replace(
    /<meta([^>]*?\bhttp-equiv\s*=\s*(['"])content-type\2[^>]*?\bcontent\s*=\s*(['"][^"']*?\bcharset=))[^"'>\s;]+([^>]*?)>/ig,
    '<meta$1utf-8$4>'
  );

  // 3) head 内に charset が無ければ追記
  if (!/charset\s*=\s*["']?utf-8/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="utf-8">');
  }
  return out;
}

// ---- 相対パス → プロキシURL 化（CSS/JS/画像/フォーム等がちゃんと取れるように）----
function absolutizeToUpstream(u, baseAbs) {
  // u: 属性に書かれているURL（相対/絶対混在）
  // baseAbs: 現在のHTMLの絶対URL（上流側）
  try {
    return new URL(u, baseAbs).toString();
  } catch {
    return null;
  }
}
function buildSelfOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function toProxyUrl(selfOrigin, absUpstreamUrl) {
  // absUpstreamUrl が UPSTREAM_ORIGIN 配下なら相対パス抽出して u= に入れる
  const base = new URL(UPSTREAM_ORIGIN);
  const abs = new URL(absUpstreamUrl);
  let next = abs.href;
  if (abs.origin === base.origin) {
    next = abs.href.replace(UPSTREAM_ORIGIN, '');
  }
  const uParam = encodeURIComponent(next.replace(/^\//, ''));
  return `${selfOrigin}/api/proxy?u=${uParam}`;
}

// HTML文字列中の URL 属性を一括でプロキシ化
function rewriteAssetUrls(html, htmlAbsUrl, req) {
  const selfOrigin = buildSelfOrigin(req);

  // 対象属性: href, src, action, data, poster
  // javascript:, mailto:, data:, about: は除外
  const ATTRS = ['href', 'src', 'action', 'data', 'poster'];
  const SKIP_SCHEMES = /^(data:|javascript:|mailto:|about:)/i;

  return html.replace(
    /\b(href|src|action|data|poster)\s*=\s*("([^"]+)"|'([^']+)'|([^"'=\s>]+))/ig,
    (m, attr, _qv, dq, sq, bare) => {
      const val = dq || sq || bare || '';
      if (!val || SKIP_SCHEMES.test(val)) return m;

      const abs = absolutizeToUpstream(val, htmlAbsUrl);
      if (!abs) return m;

      const proxied = toProxyUrl(selfOrigin, abs);

      // 元のクォートを保ちつつ書き換え
      const quote = dq != null ? '"' : (sq != null ? "'" : '');
      return `${attr}=${quote}${proxied}${quote}`;
    }
  );
}

// ---- URL 補助 ----
function buildUpstreamUrl(u) {
  try { return new URL(u).toString(); }
  catch { return new URL(u.replace(/^\//, ''), UPSTREAM_ORIGIN).toString(); }
}
function buildProxyUrl(req, nextPathname) {
  const origin = buildSelfOrigin(req);
  const uParam = encodeURIComponent(nextPathname.replace(/^\//, ''));
  return `${origin}/api/proxy?u=${uParam}`;
}

// ---- メインハンドラ ----
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const u = url.searchParams.get('u');
    if (!u) { res.statusCode = 400; res.end('Missing ?u='); return; }

    const force = normCharset(url.searchParams.get('force') || '');
    const passthru = url.searchParams.get('passthru') === '1';   // 1なら変換せず素通し
    const rewrite = url.searchParams.get('rewrite') !== '0';     // 既定: 相対→プロキシに書換える

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
      redirect: 'manual'
    });

    // 30x → Location を可能な限りプロキシ化
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

    // HTML以外は素通し（バイナリ対応）
    if (!isHtml || passthru) {
      const headers = sanitizeHeaders(upstreamRes.headers, { isHtml: false });
      for (const [k, v] of headers.entries()) res.setHeader(k, v);
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

    // ---- HTML: 全バイト収集 → 文字コード判定 → UTF-8 へ ----
    const chunks = [];
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);

    let srcCharset =
      (force) ||
      detectFromContentType(ct) ||
      detectFromMeta(buf) ||
      detectFromBytes(buf);

    if (!['utf-8', 'euc-jp', 'cp932', 'iso-2022-jp'].includes(srcCharset)) {
      srcCharset = 'euc-jp';
    }

    let htmlUtf8;
    try {
      htmlUtf8 = (srcCharset === 'utf-8') ? buf.toString('utf8') : iconv.decode(buf, srcCharset);
    } catch {
      try { htmlUtf8 = iconv.decode(buf, 'cp932'); }
      catch { htmlUtf8 = iconv.decode(buf, 'euc-jp'); }
    }

    // <meta> を安全に utf-8 へ統一
    htmlUtf8 = rewriteMetaToUtf8(htmlUtf8);

    // 相対パス → プロキシURL に書き換え（CSS/JS/画像/フォーム等が壊れない）
    if (rewrite) {
      htmlUtf8 = rewriteAssetUrls(htmlUtf8, upstreamUrl, req);
    }

    const headers = sanitizeHeaders(upstreamRes.headers, { isHtml: true, finalCharset: 'utf-8' });
    for (const [k, v] of headers.entries()) res.setHeader(k, v);
    res.statusCode = upstreamRes.status;
    res.end(htmlUtf8);

  } catch (err) {
    console.error('proxy error:', err && err.stack || err);
    res.statusCode = 502;
    res.end('proxy error');
  }
};
