// vercel-proxy.js
// EUC-JP/ISO-2022-JP対応
const iconv = require('iconv-lite');
require('iconv-lite/encodings');

module.exports = async function handler(req, res) {
  try {
    // 元のURLをクエリ ?u= に入れる方式
    const upstreamBase = req.query.u;
    if (!upstreamBase) {
      res.status(400).send('Missing u param');
      return;
    }

    const upstreamUrl = decodeURIComponent(upstreamBase);
    const urlObj = new URL(upstreamUrl);

    // ヘッダーコピー
    const headers = { ...req.headers };
    delete headers['host'];

    // POSTデータ処理
    let body;
    if (req.method === 'POST') {
      body = await new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });
    }

    // Referer補正：saveimage の場合は potiboard.php に固定
    const isSaveImagePost =
      req.method === 'POST' &&
      /potiboard\.php$/i.test(urlObj.pathname) &&
      urlObj.searchParams.get('mode') === 'saveimage';

    if (isSaveImagePost) {
      const paintPage = upstreamUrl.replace(/\?.*$/, '');
      headers['referer'] = paintPage;
    } else {
      headers['referer'] = upstreamUrl;
    }

    // 上流へ投げる
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: body,
      redirect: 'manual'
    });

    // ヘッダー整形
    const outHeaders = {};
    upstreamRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        const cookies = Array.isArray(value) ? value : [value];
        const reqHasUsercode = /\busercode=/.test(req.headers.cookie || '');

        const filtered = cookies.filter(line => {
          // 既にusercodeを持っていれば上書き禁止
          if (reqHasUsercode && /^usercode=/i.test(line)) return false;
          return true;
        }).map(line => {
          return line
            .replace(/;?\s*Domain=[^;]+/i, '')
            .replace(/;?\s*Path=[^;]+/i, '') +
            `; Domain=${req.headers.host}; Path=/; SameSite=None; Secure`;
        });

        if (filtered.length > 0) {
          outHeaders['set-cookie'] = filtered;
        }
      } else if (!['content-encoding'].includes(key.toLowerCase())) {
        outHeaders[key] = value;
      }
    });

    // saveimage POST の場合、302などは強制200 'ok'
    if (isSaveImagePost && [301, 302, 303, 307, 308].includes(upstreamRes.status)) {
      res.writeHead(200, { ...outHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    // ボディ取得（エンコード変換）
    const arrayBuffer = await upstreamRes.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    let contentType = upstreamRes.headers.get('content-type') || '';
    if (/euc-jp/i.test(contentType)) {
      const text = iconv.decode(buf, 'EUC-JP');
      res.writeHead(upstreamRes.status, { ...outHeaders, 'content-type': 'text/html; charset=UTF-8' });
      res.end(iconv.encode(text, 'UTF-8'));
      return;
    } else if (/iso-2022-jp/i.test(contentType)) {
      const text = iconv.decode(buf, 'ISO-2022-JP');
      res.writeHead(upstreamRes.status, { ...outHeaders, 'content-type': 'text/html; charset=UTF-8' });
      res.end(iconv.encode(text, 'UTF-8'));
      return;
    }

    // 通常バイナリ/UTF-8
    res.writeHead(upstreamRes.status, outHeaders);
    res.end(buf);

  } catch (err) {
    console.error(err);
    res.status(500).send('Proxy error: ' + err.message);
  }
};
