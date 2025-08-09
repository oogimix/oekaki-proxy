export default async function handler(req, res) {
  const upstreamBase = "https://sush1h4mst3r.stars.ne.jp/potiboard5";

  // 現在のリクエストURLからパスとクエリを抽出
  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace(/^\/+/, "");
  const target = `${upstreamBase}/${path}${url.search}`;

  // 本文（POSTなど）をバッファ
  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await buffer(req);

  // 上流へ転送
  const r = await fetch(target, {
    method: req.method,
    headers: filterHeaders(req.headers),
    body,
    redirect: "manual"
  });

  // ヘッダ調整：iframeブロックを解除し、親を許可
  const headers = new Headers(r.headers);
  headers.delete("x-frame-options");
  headers.set(
    "content-security-policy",
    "frame-ancestors 'self' https://sushihamster.com https://www.sushihamster.com"
  );

  // 本文をそのまま返す
  const buf = Buffer.from(await r.arrayBuffer());
  headers.set("content-length", String(buf.length));
  res.writeHead(r.status, Object.fromEntries(headers));
  res.end(buf);
}

function filterHeaders(incoming) {
  // 転送時に不要/邪魔なヘッダを除去
  const skip = new Set([
    "host", "content-length", "accept-encoding", "connection"
  ]);
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!skip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function buffer(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
