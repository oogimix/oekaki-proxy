// api/proxy.js  — 超簡易版（GETのみ）
export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x'); // 解析用ダミー
    const path = new URLSearchParams(u.search).get('u');
    if (!path) return res.status(400).send('missing ?u=');

    const url = 'https://sush1h4mst3r.stars.ne.jp/' + path.replace(/^\/+/, '');
    const up = await fetch(url);
    const buf = Buffer.from(await up.arrayBuffer());

    res.status(up.status);
    const ct = up.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('content-type', ct);
    res.send(buf);
  } catch (e) {
    res.status(500).send('mini-proxy failed: ' + (e?.message || e));
  }
}
