// api/proxy.js — デバッグ版
export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x'); // 解析用ダミー
    const path = new URLSearchParams(u.search).get('u');
    if (!path) return res.status(400).json({ ok:false, error:'missing ?u=' });

    const url = 'https://sush1h4mst3r.stars.ne.jp/' + path.replace(/^\/+/, '');
    const up = await fetch(url);

    // 先頭だけ嗅いで、数値を返す（中身は返さない）
    const ab = await up.arrayBuffer();
    const sniff = Buffer.from(ab).subarray(0, 200).toString('utf8');

    return res.status(200).json({
      ok: true,
      target: url,
      status: up.status,
      contentType: up.headers.get('content-type'),
      length: ab.byteLength,
      preview: sniff
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
