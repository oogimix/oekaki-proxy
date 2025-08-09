// api/proxy.js
// CommonJS on Vercel Node runtime

const UPSTREAM_ORIGIN = 'https://sush1h4mst3r.stars.ne.jp/';

// ヘッダをクリーンアップする（iframe許可＆圧縮系を外す）
function sanitizeHeaders(h, { forceCharset, isHtml }) {
  // コピー（case-insensitive 対応のため一旦 Map に落とす）
  const out = new Headers();
  for (const [k, v] of h.entries()) out.set(k, v);

  // 追い出すヘッダ
  const stripKeys = [
    'x-frame-options',
    'content-security-policy',
    'content-length',
    'content-encoding', // 圧縮ヘッダは除去（bodyは非圧縮を取ってくる前提）
    'transfer-encoding',
  ];
  for (const key of stripKeys) out.delete(key);

  // HTML の場合、charset を必ず明示
  if (isHtml) {
    // 既存の Content-Type を見て、text/html に差し替え or 上書き
    const current = out.get('content-type') || '';
    // 既に text/html; charset=... が付いていても、force 指定があれば上書き
    const charset = (forceCharset || '').trim().toLowerCase() || detectCharsetFromContentType(current) || 'euc-jp';
    out.set('content-type', `text/html; charset=${charset}`);
  }

  // CORS（iframe には不要だが一応許容）
  out.set('access-control-allow-origin', '*');

  return out;
}

function detectCharsetFromContentType(ct) {
  // 例: "text/html; charset=Shift_JIS"
  const m = /charset\s*=\s*([^;]+)/i.exec(ct || '');
  if (m) return m[1].trim();
  return null;
}

function isHtmlLike(contentType, pathname) {
  if (contentType && /text\/html/i.test(contentType)) return true;
  // 一部サーバが Content-Type を正しく返さない対策（拡張子/パスで推測）
  if (pathname) {
    const p = pathname.toLowerCase();
    if (p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.php') || p.endsWith('/')) return true;
  }
  return false;
}

function buildUpstreamUrl(u) {
  try {
    // 絶対URLならそのまま
    const test = new URL(u);
    return test.toString();
  } catch {
    // 相対パス → 上流オリジンと結合
    return new URL(u.replace(/^\//, ''), UPSTREAM_ORIGIN).toString();
  }
}

function buildProxyUrl(req, nextPathname) {
  // Location をプロキシ経由に書き換える（可能な範囲）
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const origin = `${proto}://${host}`;
  const uParam = encodeURIComponent(nextPathname.replace(/^\//, ''));
  // 追加のクエリは最小限（必要なら引き継ぎを検討）
  return `${origin}/api/proxy?u=${uParam}`;
}

module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const u = url.searchParams.get('u');
    if (!u) {
      res.statusCode = 400;
      res.end('Missing ?u=');
      return;
    }

    const forceCharset = (url.searchParams.get('force') || '').toLowerCase(); // 例: euc-jp / cp932 / shift_jis
    const upstreamUrl = buildUpstreamUrl(u);

    // 圧縮を避ける（content-encoding を落とすので、非圧縮を取りに行く）
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        // 上流が WAF 厳しめでも通るように最低限
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': UPSTREAM_ORIGIN,
        'Accept-Encoding': 'identity',
      },
      redirect: 'manual', // 30x を自前で扱う
    });

    // リダイレクトは Location を可能ならプロキシに書き換え
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl); // 相対→絶対
        // できるだけ /potiboard5/.. のパスを抽出して u= に戻す
        const nextPathname = abs.href.replace(UPSTREAM_ORIGIN, '');
        const proxied = buildProxyUrl(req, nextPathname);
        res.statusCode = upstreamRes.status;
        res.setHeader('Location', proxied);
        res.end();
        return;
      }
    }

    // Content-Type とリクエスト u から HTML か判定
    const ct = upstreamRes.headers.get('content-type') || '';
    const isHtml = isHtmlLike(ct, new URL(upstreamUrl).pathname);

    // レスポンスヘッダ整形
    const headers = sanitizeHeaders(upstreamRes.headers, { forceCharset, isHtml });
    for (const [k, v] of headers.entries()) res.setHeader(k, v);
    res.statusCode = upstreamRes.status;

    // ストリーム転送（本文は素通し。= 変換しない）
    // ここで Body は 'identity' で非圧縮なので、encoding を落としても OK
    const reader = upstreamRes.body.getReader();
    const encoder = new TextEncoder(); // バイナリそのまま流すので未使用でもOK
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    await pump();
  } catch (err) {
    console.error('proxy error:', err && err.stack || err);
    res.statusCode = 502;
    res.end('proxy error');
  }
};
