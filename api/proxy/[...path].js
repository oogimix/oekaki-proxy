export default function handler(req, res) {
  res.status(200).json({
    ok: true,
    path: req.query.path,   // ← ["abc","def"] みたいに配列で返る
    url: req.url
  });
}
