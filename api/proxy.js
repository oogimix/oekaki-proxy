// api/proxy.js — 完成版（CommonJS）
// ・?u=potiboard5/xxx を上流へ中継
// ・X-Frame-Options / CSP を除去（iframe可）
// ・HTMLは EUC-JP / CP932(Shift_JIS) / ISO-2022-JP 等を UTF-8 に変換して返す
// ・相対リンク（/potiboard5/... / potiboard5/...）は自プロキシに書き換え
// ・?force=euc-jp / cp932 / iso-2022-jp で手動強制も可

const iconv = require('iconv-lite');
require('iconv-lite/encodings'); // ← EUC-JP / ISO-2022-JP など拡張エンコを有効化

// エンコ名のゆらぎを吸収して iconv-lite が読める名前へ正規化
function normalizeEncoding(name) {
  if (!name) return 'utf-8';
  const n = String(name).toLowerCase().replace(/[_\s]/g, '-');
  if (['shift-jis','sjis','cp932','windows-31j'].includes(n)) return 'cp932';
  if (['euc-jp','eucjp'].includes(n)) return 'euc-jp';
  if (['iso-2022-jp','iso2022jp','jis'].includes(n)) return 'ISO-2022-JP'; // ★大文字で渡すのが安定
  if (['utf-8','utf8'].includes(n)) return 'utf-8';
  return n;
}

module.exports = async function handler(req, res) {
  try {
    const upstreamBase = 'https://sush1h4mst3r.stars.ne.jp/';
    const u = ((req.query && req.query.u) ? String(req.query.u) : '').replace(/^\//, '');
    if (!u) { res.status(400).send('missing ?u='); return; }

    // ?u 以外のクエリは引き継ぎ
    const reqUrl = new URL(req.url, 'http://local');
    const sp = new URLSearchParams(reqUrl.search);
    sp.delete('u');
    const target = new URL('/' + u + (sp.toString() ? `?${sp}` : ''), upstreamBase);

    // 転送ヘッダ（壊れやすい/不要系は除外）
    const hop = new Set([
      'host','connection','keep-alive','proxy-authenticate','proxy-authorization',
      'te','trailer','transfer-encoding','upgrade','content-length','accept-encoding'
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!hop.has(k.toLowerCase())) headers[k] = v;
    }
    // WAFゆるめ（最低限）
    headers['referer'] = `${upstreamBase}potiboard5/potiboard.php`;
    headers['origin']  = new URL(upstreamBase).origin;
    if (!headers['user-agent']) {
      headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
    }

    // ボディ（GET/HEAD以外）
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      await new Promise((ok, ng) => { req.on('data', c => chunks.push(c)); req.on('end', ok); req.on('error', ng); });
      body = Buffer.concat(chunks);
    }

    // 上流へ
    const up = await fetch(target.toString(), { method: req.method, headers, body, redirect: 'manual' });

    // ステータス & ヘッダ（埋め込み阻害/壊れやすいものは落とす）
    res.status(up.status);
    const ct = (up.headers.get('content-type') || '').toLowerCase();
    up.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'x-frame-options') return;
      if (k === 'content-security-policy' || k === 'content-security-policy-report-only') return;
      if (k === 'content-encoding') return; // ブランク対策（自分で再送）
      if (k === 'content-length') return;   // 再計算させる
      if (k === 'transfer-encoding') return;
      if (k === 'location') {
        try {
          const loc = new URL(value, upstreamBase);
          const proxied = `/api/proxy?u=${encodeURIComponent(loc.pathname.replace(/^\//,''))}${loc.search || ''}${loc.hash || ''}`;
          res.setHeader('Location', proxied);
        } catch { res.setHeader('Location', value); }
        return;
      }
      res.setHeader(key, value);
    });

    const buf = Buffer.from(await up.arrayBuffer());

    // ---------- HTML は UTF-8 にして返す ----------
    if (ct.includes('text/html')) {
      // 1) Content-Type から推定
      let src = 'utf-8';
      if (/(shift[_-]?jis|sjis|cp932|windows-31j)/i.test(ct)) src = 'cp932';
      else if (/euc[_-]?jp/i.test(ct)) src = 'euc-jp';
      else if (/iso[-_]?2022[-_]?jp/i.test(ct)) src = 'ISO-2022-JP';

      // 2) <meta charset=...>（先頭2KB）で追加判定
      const headAscii = buf.slice(0, 2048).toString('ascii');
      if (/charset\s*=\s*utf-?8/i.test(headAscii)) src = 'utf-8';
      else if (/charset\s*=\s*(shift[_-]?jis|sjis|cp932|windows-31j)/i.test(headAscii)) src = 'cp932';
      else if (/charset\s*=\s*euc[_-]?jp/i.test(headAscii)) src = 'euc-jp';
      else if (/charset\s*=\s*iso[-_]?2022[-_]?jp/i.test(headAscii)) src = 'ISO-2022-JP';

      // 3) 手動強制（?force=...）
      if (req.query && req.query.force) src = String(req.query.force);

      // 4) 正規化してから decode
      const useEnc = normalizeEncoding(src);
      let html = (useEnc === 'utf-8') ? buf.toString('utf8') : iconv.decode(buf, useEnc);

      // 5) 相対リンクを /api/proxy?u=... に差し替え
      html = html
        .replace(/(href|src|action)=["']\/(potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`)
        .replace(/(href|src|action)=["'](potiboard5\/[^"']*)["']/gi, `$1="/api/proxy?u=$2"`);

      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }

    // ---------- 非HTMLはそのまま ----------
    res.send(buf);
  } catch (e) {
    res.status(500).send('proxy error: ' + (e && e.message ? e.message : String(e)));
  }
};
