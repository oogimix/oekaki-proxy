// api/proxy.js
export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    u: req.query.u || null,
    url: req.url
  });
}
