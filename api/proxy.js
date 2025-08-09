// api/proxy.js
// Vercel Serverless (Node / CommonJS) — SAFE baseline, no runtime injection

const iconv = require('iconv-lite');
require('iconv-lite/encodings');

const UPSTREAM_ORIGIN = 'https://sush1h4mst3r.stars.ne.jp/';

// --- unwrap nested proxy?u=... once and for all (up to 3 layers)
function unwrapProxyParam(uRaw) {
  let s = String(uRaw || '');
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^proxy\?u=(.+)$/);
    if (m) { s = decodeURIComponent(m[1]); continue; }
    try {
      const tmp = new URL(s, 'https://dummy.local/');
      const path = tmp.pathname.replace(/^\/+/, '');
      if ((path === 'api/proxy' || path === 'proxy') && tmp.searchParams.has('u')) {
        s = decodeURIComponent(tmp.searchParams.get('u'));
        continue;
      }
    } catch {}
    break;
  }
  return s;
}

// ---------- helpers ----------
function buildSelfOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function buildUpstreamUrl(u) {
  try { return new URL(u).toString(); }
  catch { return new URL(u.replace(/^\//,''), UPSTREAM_ORIGIN).toString(); }
}
function buildProxyUrl(req, nextPathname) {
  const origin = buildSelfOrigin(req);
  const uParam = encodeURIComponent(nextPathname.replace(/^\//,''));
  return `${origin}/api/proxy?u=${uParam}`;
}
function readRawBody(req){
  return new Promise((resolve,reject)=>{
    const chunks=[]; req.on('data',c=>chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c)));
    req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject);
  });
}
function getSetCookiesArray(res) {
  if (typeof res.headers.getSetCookie === 'function') {
    try { return res.headers.getSetCookie(); } catch {}
  }
  const sc = res.headers.get('set-cookie');
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
}

// ---------- charset detect ----------
const ALIAS = new Map([
  ['utf8','utf-8'], ['utf-8','utf-8'],
  ['eucjp','euc-jp'], ['euc-jp','euc-jp'], ['euc_jp','euc-jp'],
  ['shift_jis','cp932'], ['shift-jis','cp932'], ['sjis','cp932'],
  ['cp932','cp932'], ['ms932','cp932'],
  ['iso-2022-jp','iso-2022-jp'], ['jis','iso-2022-jp'], ['iso2022jp','iso-2022-jp']
]);
function normCharset(v=''){ const k=v.toLowerCase().trim(); return ALIAS.get(k)||k; }
function detectFromContentType(ct=''){ const m=/charset\s*=\s*([^;\s]+)/i.exec(ct); return m?normCharset(m[1]):null; }
function detectFromMeta(buf){
  const head = buf.subarray(0, Math.min(buf.length, 32768)).toString('latin1');
  const m1 = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'>\s;]+)/i);
  if (m1) return normCharset(m1[1]);
  const m2 = head.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]*content=["'][^"']*charset=([^"'>\s;]+)/i);
  if (m2) return normCharset(m2[1]);
  return null;
}
function detectFromBytes(buf){
  const s = buf.toString('latin1');
  if (/\x1B\$[@B]|\x1B\(B|\x1B\(J/.test(s)) return 'iso-2022-jp';
  if (buf.includes(0x8E) || buf.includes(0x8F)) return 'euc-jp';
  return 'cp932';
}
function isHtmlLike(contentType, pathname){
  if (contentType && /text\/html/i.test(contentType)) return true;
  const p=(pathname||'').toLowerCase();
  return p.endsWith('.html')||p.endsWith('.htm')||p.endsWith('.php')||p.endsWith('/');
}

// ---------- headers util ----------
function copyResponseHeaders(srcHeaders, {isHtml, finalCharset}) {
  const out = {};
  for (const [k,v] of srcHeaders.entries()) out[k.toLowerCase()] = v;
  ['x-frame-options','content-security-policy','content-length','content-encoding','transfer-encoding']
    .forEach(k=>{ delete out[k]; });
  if (isHtml) out['content-type'] = `text/html; charset=${finalCharset||'utf-8'}`;
  out['access-control-allow-origin'] = '*';
  return out;
}

// ---------- Set-Cookie rewrite + jar ----------
function rewriteSetCookieHeaders(upstreamRes, req, res) {
  const setCookies = getSetCookiesArray(upstreamRes);
  if (!setCookies.length) return;

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

  const rewritten = setCookies.map(line=>{
    let s = String(line);
    s = /;\s*Domain=/i.test(s) ? s.replace(/;\s*Domain=[^;]*/i, `; Domain=${host}`) : `${s}; Domain=${host}`;
    s = /;\s*Path=/i.test(s)   ? s.replace(/;\s*Path=[^;]*/i, `; Path=/`)      : `${s}; Path=/`;
    if (!/;\s*SameSite=/i.test(s))   s += '; SameSite=None';
    if (!/;\s*Secure/i.test(s))      s += '; Secure';
    if (!/;\s*Partitioned/i.test(s)) s += '; Partitioned';
    return s;
  });

  // 代理ジャー pb_up にも上流クッキーを同梱
  const pairs = setCookies.map(c=>String(c).split(';',1)[0]).filter(Boolean);
  if (pairs.length){
    const jarValue = encodeURIComponent(pairs.join('; '));
    rewritten.push(`pb_up=${jarValue}; Path=/; Max-Age=31536000; SameSite=None; Secure; Partitioned; Domain=${host}`);
  }

  res.setHeader('Set-Cookie', rewritten);
}

// ---------- meta & URL rewriting (静的) ----------
function rewriteMetaToUtf8(html){
  let out = html;
  out = out.replace(/<meta([^>]*?)\bcharset\s*=\s*(['"]?)[^"'>\s;]+(\2)([^>]*)>/ig, '<meta$1charset="utf-8"$4>');
  out = out.replace(/<meta([^>]*?\bhttp-equiv\s*=\s*(['"])content-type\2[^>]*?\bcontent\s*=\s*(['"][^"']*?\bcharset=))[^"'>\s;]+([^>]*?)>/ig, '<meta$1utf-8$4>');
  if (!/charset\s*=\s*["']?utf-8/i.test(out)) out = out.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="utf-8">');
  return out;
}
function absolutizeToUpstream(u, baseAbs){ try { return new URL(u, baseAbs).toString(); } catch { return null; } }
function toProxyUrl(selfOrigin, absUpstreamUrl){
  const base = new URL(UPSTREAM_ORIGIN);
  const abs  = new URL(absUpstreamUrl);
  let next = abs.href;
  if (abs.origin === base.origin) next = abs.href.replace(UPSTREAM_ORIGIN,'').replace(/^\/+/,'');
  const uParam = encodeURIComponent(next);
  return `${selfOrigin}/api/proxy?u=${uParam}`;
}
function rewriteAssetUrls(html, htmlAbsUrl, req){
  const selfOrigin = buildSelfOrigin(req);
  const SKIP=/^(data:|javascript:|mailto:|about:)/i;
  // フォーム action は触らない（JSで上流がいじるので）
  return html.replace(/\b(href|src|data|poster)\s*=\s*("([^"]+)"|'([^']+)'|([^"'=\s>]+))/ig,
    (m,attr,_qv,dq,sq,bare)=>{
      const val = dq ?? sq ?? bare ?? '';
      if (!val || SKIP.test(val)) return m;
      const abs = absolutizeToUpstream(val, htmlAbsUrl);
      if (!abs) return m;
      const prox = toProxyUrl(selfOrigin, abs);
      const quote = dq!=null?'"':(sq!=null?"'":'');
      return `${attr}=${quote}${prox}${quote}`;
    });
}

// ---------- main ----------
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    // ★ ネスト解除してから扱う（404元凶の二重包みを解消）
    const u = unwrapProxyParam(url.searchParams.get('u'));
    if (!u) { res.statusCode = 400; res.end('Missing ?u='); return; }

    const force    = normCharset(url.searchParams.get('force') || '');
    const passthru = url.searchParams.get('passthru') === '1';
    const rewrite  = url.searchParams.get('rewrite') !== '0';

    const upstreamUrl = buildUpstreamUrl(u);
    const upstreamOrigin = new URL(upstreamUrl).origin;

    const method = req.method || 'GET';
    let upstreamBody;
    if (!['GET','HEAD'].includes(method)) upstreamBody = await readRawBody(req);

    // ---- 代理ジャー（pb_up）を取り出して必ず同封 ----
    function pickCookie(name, cookieHeader) {
      if (!cookieHeader) return null;
      const esc = name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g,'\\$&');
      const m = cookieHeader.match(new RegExp('(?:^|;\\s*)'+esc+'=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    const clientCookieHeader = req.headers['cookie'] || '';
    const jar = pickCookie('pb_up', clientCookieHeader);
    let mergedCookieForUpstream = clientCookieHeader || '';
    if (jar) {
      const upstreamPairs = decodeURIComponent(jar); // "usercode=...; PHPSESSID=..."
      mergedCookieForUpstream = mergedCookieForUpstream
        ? `${mergedCookieForUpstream}; ${upstreamPairs}`
        : upstreamPairs;
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': upstreamUrl,
        'Origin': upstreamOrigin,
        'Accept-Encoding': 'identity',
        ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
        ...(mergedCookieForUpstream ? { 'Cookie': mergedCookieForUpstream } : {})
      },
      body: upstreamBody,
      redirect: 'manual'
    });

    // 30x redirect → プロキシ化
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        const nextPathname = abs.href.replace(UPSTREAM_ORIGIN,'').replace(/^\/+/,'');
        const proxied = buildProxyUrl(req, nextPathname);
        res.statusCode = upstreamRes.status;
        res.setHeader('Location', proxied);
        rewriteSetCookieHeaders(upstreamRes, req, res);
        res.end();
        return;
      }
    }

    const ct = upstreamRes.headers.get('content-type') || '';
    const pathname = new URL(upstreamUrl).pathname;
    const isHtml = isHtmlLike(ct, pathname);

    rewriteSetCookieHeaders(upstreamRes, req, res);

    if (!isHtml || passthru) {
      const headers = copyResponseHeaders(upstreamRes.headers, {isHtml:false});
      for (const k in headers) res.setHeader(k, headers[k]);
      res.statusCode = upstreamRes.status;
      const reader = upstreamRes.body.getReader();
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    // HTML: collect & transcode
    const chunks=[]; const reader = upstreamRes.body.getReader();
    while(true){ const {done,value}=await reader.read(); if(done)break; chunks.push(Buffer.from(value)); }
    const buf = Buffer.concat(chunks);

    let srcCharset = force || detectFromContentType(ct) || detectFromMeta(buf) || detectFromBytes(buf);
    if (!['utf-8','euc-jp','cp932','iso-2022-jp'].includes(srcCharset)) srcCharset = 'euc-jp';

    let htmlUtf8;
    try { htmlUtf8 = (srcCharset==='utf-8') ? buf.toString('utf8') : iconv.decode(buf, srcCharset); }
    catch { try { htmlUtf8 = iconv.decode(buf,'cp932'); } catch { htmlUtf8 = iconv.decode(buf,'euc-jp'); } }

    htmlUtf8 = rewriteMetaToUtf8(htmlUtf8);
    if (rewrite) htmlUtf8 = rewriteAssetUrls(htmlUtf8, upstreamUrl, req);

    const headers = copyResponseHeaders(upstreamRes.headers, {isHtml:true, finalCharset:'utf-8'});
    for (const k in headers) res.setHeader(k, headers[k]);
    res.statusCode = upstreamRes.status;
    res.end(htmlUtf8);

  } catch (err) {
    console.error('proxy error:', err && (err.stack||err));
    res.statusCode = 502;
    res.end('proxy error');
  }
};
