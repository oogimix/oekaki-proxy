// api/potiboard.php.js
// If something posts to /api/potiboard.php, keep method and 307 to the proxy.

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const qs = url.search || '';
    const loc = `/api/proxy?u=${encodeURIComponent('potiboard5/potiboard.php')}${qs.replace(/^\?/, '&')}`;
    res.statusCode = 307; // keep method and body
    res.setHeader('Location', loc);
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end('redirect shim error');
  }
};
