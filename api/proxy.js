// api/proxy.js
// Vercel Node (CommonJS)
//
// ✔ 上流(EUC-JP/CP932/ISO-2022-JP)→UTF-8再エンコード
// ✔ <meta charset> を安全に utf-8 へ統一
// ✔ href/src/action 等を /api/proxy?u=... に書き換え（静的）
// ✔ POST/マルチパートのボディ中継（PAINT対策）
// ✔ Set-Cookie を vercel 側に変換 (SameSite=None; Secure; Partitioned)
// ✔ Referer/Origin を上流に合わせる
// ✔ ★ 実行時に form/fetch/XHR をフックして送信先を強制プロキシ化（動的）

const iconv = require('iconv-lite');
require('iconv-lite/encodings'); // ISO-2022-JP 有効化

const UPSTREAM_ORIGIN = 'https://sush1h4mst3r.stars.ne.jp/';

// ---------- 基本ユーティリティ ----------
function buildSelfOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function buildUpstreamUrl(u) {
  try { return new URL(u).toString(); }
  catch { return new URL(u.replace(/^\//, ''), UPSTREAM_ORIGIN).toString(); }
}
function buildProxyUrl(req, nextPathname) {
  const origin = buildSelfOrigin(req);
  const uParam = encodeURIComponent(nextPathname.replace(/^\//, ''));
  return `${origin}/api/proxy?u=${uParam}`;
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- エンコード判定 ----------
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
  const p = (pathname||'').toLowerCase();
  return p.endsWith('.html') || p.endsWith('.htm') || p.endsWith('.php') || p.endsWith('/');
}

// ---------- レスポンスヘッダ整形 ----------
function sanitizeHeaders(h, { isHtml, finalCharset }) {
  const out = new Headers();
  for (const [k,v] of h.entries()) out.set(k, v);
  ['x-frame-options','content-security-policy','content-length','content-encoding','transfer-encoding']
    .forEach(k => out.delete(k));
  if (isHtml) out.set('content-type', `text/html; charset=${finalCharset || 'utf-8'}`);
  out.set('access-control-allow-origin', '*');
  return out;
}

// ---------- Set-Cookie 書き換え（Partitioned） ----------
function rewriteSetCookieHeaders(upstreamRes, req, res) {
  const raw = upstreamRes.headers.raw?.() || {};
  const setCookies = raw['set-cookie'] || [];
  if (!setCookies.length) return;

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

  const rewritten = setCookies.map(line => {
    let s = line;

    // Domain → vercel 側（無ければ付与）
    if (/;\s*Domain=/i.test(s)) s = s.replace(/;\s*Domain=[^;]*/i, `; Domain=${host}`);
    else s += `; Domain=${host}`;

    // Path は /
    if (/;\s*Path=/i.test(s)) s = s.replace(/;\s*Path=[^;]*/i, `; Path=/`);
    else s += `; Path=/`;

    // 3rd-party iframe で有効化
    if (!/;\s*SameSite=/i.test(s))   s += '; SameSite=None';
    if (!/;\s*Secure/i.test(s))      s += '; Secure';
    if (!/;\s*Partitioned/i.test(s)) s += '; Partitioned';

    return s;
  });

  res.setHeader('Set-Cookie', rewritten);
}

// ---------- meta charset 補正 ----------
function rewriteMetaToUtf8(html) {
  let out = html;
  out = out.replace(
    /<meta([^>]*?)\bcharset\s*=\s*(['"]?)[^"'>\s;]+(\2)([^>]*)>/ig,
    '<meta$1charset="utf-8"$4>'
  );
  out = out.replace(
    /<meta([^>]*?\bhttp-equiv\s*=\s*(['"])content-type\2[^>]*?\bcontent\s*=\s*(['"][^"']*?\bcharset=))[^"'>\s;]+([^>]*?)>/ig,
    '<meta$1utf-8$4>'
  );
  if (!/charset\s*=\s*["']?utf-8/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, '<head$1>\n<meta charset="utf-8">');
  }
  return out;
}

// ---------- 相対URL → プロキシURL（静的置換） ----------
function absolutizeToUpstream(u, baseAbs){
  try { return new URL(u, baseAbs).toString(); } catch { return null; }
}
function toProxyUrl(selfOrigin, absUpstreamUrl){
  const base = new URL(UPSTREAM_ORIGIN);
  const abs  = new URL(absUpstreamUrl);
  let next = abs.href;
  if (abs.origin === base.origin) next = abs.href.replace(UPSTREAM_ORIGIN, '');
  const uParam = encodeURIComponent(next.replace(/^\//, ''));
  return `${selfOrigin}/api/proxy?u=${uParam}`;
}
function rewriteAssetUrls(html, htmlAbsUrl, req){
  const selfOrigin = buildSelfOrigin(req);
  const SKIP = /^(data:|javascript:|mailto:|about:)/i;
  return html.replace(
    /\b(href|src|action|data|poster)\s*=\s*("([^"]+)"|'([^']+)'|([^"'=\s>]+))/ig,
    (m, attr, _qv, dq, sq, bare) => {
      const val = dq ?? sq ?? bare ?? '';
      if (!val || SKIP.test(val)) return m;
      const abs = absolutizeToUpstream(val, htmlAbsUrl);
      if (!abs) return m;
      const proxied = toProxyUrl(selfOrigin, abs);
      const quote = dq != null ? '"' : (sq != null ? "'" : '');
      return `${attr}=${quote}${proxied}${quote}`;
    }
  );
}

// ---------- ランタイムの送信先強制プロキシ化（動的置換） ----------
function injectRuntimeRewriter(html, upstreamAbs, req) {
  const selfOrigin = buildSelfOrigin(req);
  const up = new URL(upstreamAbs);
  const upBase = up.origin + up.pathname.replace(/[^/]*$/, ''); // ディレクトリ

  const js = `
<script>
(function(){
  var SELF=${JSON.stringify(selfOrigin)};
  var UP_ORIGIN=${JSON.stringify(up.origin)};
  var UP_BASE=${JSON.stringify(upBase)};

  function toProxy(u){
    try{
      var abs=new URL(u, UP_BASE).toString();
      if(abs.startsWith(UP_ORIGIN)){
        var rel=abs.replace(UP_ORIGIN+"/","");
        return SELF+"/api/proxy?u="+encodeURIComponent(rel);
      }
      return abs;
    }catch(e){ return u; }
  }

  function fixAll(){
    document.querySelectorAll("a[href]").forEach(function(a){
      var h=a.getAttribute("href");
      if(h && !/^https?:|^data:|^mailto:|^javascript:/i.test(h)){
        a.setAttribute("href", toProxy(h));
      }
    });
    document.querySelectorAll("form").forEach(function(f){
      var act=f.getAttribute("action")||"potiboard.php";
      if(!/^https?:/i.test(act)) f.setAttribute("action", toProxy(act));
      f.addEventListener("submit", function(){
        var a=f.getAttribute("action")||f.action||"potiboard.php";
        try{ f.action = toProxy(a); }catch(_){}
      }, true);
    });
  }

  if (window.fetch){
    var _fetch=window.fetch;
    window.fetch=function(input, init){
      try{
        if (typeof input==="string") input=toProxy(input);
        else if (input && input.url){ var u=toProxy(input.url); input=new Request(u, input); }
      }catch(e){}
      return _fetch(input, init);
    };
  }
  if (window.XMLHttpRequest){
    var _open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
      try{ u=toProxy(u); }catch(e){}
      return _open.apply(this, [m,u].concat([].slice.call(arguments,2)));
    };
  }

  var mo=new MutationObserver(function(muts){
    muts.forEach(function(m){
      m.addedNodes && m.addedNodes.forEach(function(n){
        if(n.nodeType!==1) return;
        if(n.matches && n.matches("a[href]")){
          var h=n.getAttribute("href");
          if(h && !/^https?:|^data:|^mailto:|^javascript:/i.test(h)) n.setAttribute("href", toProxy(h));
        }
        n.querySelectorAll && n.querySelectorAll("a[href],form").forEach(function(el){
          if(el.tagName==="A"){
            var h2=el.getAttribute("href");
            if(h2 && !/^https?:|^data:|^mailto:|^javascript:/i.test(h2)) el.setAttribute("href", toProxy(h2));
          }else if(el.tagName==="FORM"){
            var a2=el.getAttribute("action")||"potiboard.php";
            if(!/^https?:/i.test(a2)) el.setAttribute("action", toProxy(a2));
            el.addEventListener("submit", function(){
              var a3=el.getAttribute("action")||el.action||"potiboard.php";
              try{ el.action = toProxy(a3); }catch(_){}
            }, true);
          }
        });
      });
    });
  });
  mo.observe(document.documentElement, {subtree:true, childList:true});

  if(document.readyState!=="loading") fixAll();
  else document.addEventListener("DOMContentLoaded", fixAll, {once:true});
})();
</script>`;
  return html.replace(/<\/body/i, js + "\n</body");
}

// ---------- メイン ----------
module.exports = async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const u = url.searchParams.get('u');
    if (!u) { res.statusCode = 400; res.end('Missing ?u='); return; }

    const force    = normCharset(url.searchParams.get('force') || '');
    const passthru = url.searchParams.get('passthru') === '1';
    const rewrite  = url.searchParams.get('rewrite') !== '0';

    const upstreamUrl = buildUpstreamUrl(u);
    const upstreamOrigin = new URL(upstreamUrl).origin;

    // メソッド/ボディ中継（PAINT/投稿用）
    const method = req.method || 'GET';
    let upstreamBody;
    if (!['GET','HEAD'].includes(method)) upstreamBody = await readRawBody(req);

    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Accept': req.headers['accept'] || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'ja,en-US;q=0.9,en;q=0.8',
        'Referer': upstreamUrl,              // 押下元ページに合わせる
        'Origin':  upstreamOrigin,
        'Accept-Encoding': 'identity',
        ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
        ...(req.headers['cookie']       ? { 'Cookie': req.headers['cookie'] } : {})
      },
      body: upstreamBody,
      redirect: 'manual'
    });

    // 30x: Location をプロキシ化
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const loc = upstreamRes.headers.get('location');
      if (loc) {
        const abs = new URL(loc, upstreamUrl);
        const nextPathname = abs.href.replace(UPSTREAM_ORIGIN, '');
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

    // Set-Cookie を vercel 側に保存できるよう書き換え
    rewriteSetCookieHeaders(upstreamRes, req, res);

    if (!isHtml || passthru) {
      const headers = sanitizeHeaders(upstreamRes.headers, { isHtml: false });
      for (const [k,v] of headers.entries()) res.setHeader(k, v);
      res.statusCode = upstreamRes.status;
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    // ---- HTML：UTF-8化 ----
    const chunks = [];
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);

    let srcCharset = force || detectFromContentType(ct) || detectFromMeta(buf) || detectFromBytes(buf);
    if (!['utf-8','euc-jp','cp932','iso-2022-jp'].includes(srcCharset)) srcCharset = 'euc-jp';

    let htmlUtf8;
    try {
      htmlUtf8 = (srcCharset === 'utf-8') ? buf.toString('utf8') : iconv.decode(buf, srcCharset);
    } catch {
      try { htmlUtf8 = iconv.decode(buf, 'cp932'); }
      catch { htmlUtf8 = iconv.decode(buf, 'euc-jp'); }
    }

    htmlUtf8 = rewriteMetaToUtf8(htmlUtf8);
    if (rewrite) htmlUtf8 = rewriteAssetUrls(htmlUtf8, upstreamUrl, req);
    // ★ 実行時の action/fetch/XHR も強制プロキシ化
    htmlUtf8 = injectRuntimeRewriter(htmlUtf8, upstreamUrl, req);

    const headers = sanitizeHeaders(upstreamRes.headers, { isHtml: true, finalCharset: 'utf-8' });
    for (const [k,v] of headers.entries()) res.setHeader(k, v);
    res.statusCode = upstreamRes.status;
    res.end(htmlUtf8);

  } catch (err) {
    console.error('proxy error:', err && err.stack || err);
    res.statusCode = 502;
    res.end('proxy error');
  }
};
