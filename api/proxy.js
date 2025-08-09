// api/proxy.js
// Vercel Serverless (Node / CommonJS)
// --- add: nested proxy?u= ... un-wrapper ---
function unwrapProxyParam(uRaw) {
  let s = String(uRaw || '');
  // 3回まで剥がす（十分）
  for (let i = 0; i < 3; i++) {
    // 形式A: "proxy?u=...."
    const m = s.match(/^proxy\?u=(.+)$/);
    if (m) { s = decodeURIComponent(m[1]); continue; }

    // 形式B: "/api/proxy?u=...." など
    try {
      const tmp = new URL(s, 'https://dummy.local/');
      const path = tmp.pathname.replace(/^\/+/, '');
      if ((path === 'api/proxy' || path === 'proxy') && tmp.searchParams.has('u')) {
        s = decodeURIComponent(tmp.searchParams.get('u'));
        continue;
      }
    } catch {
      // s が相対でもOK、次へ
    }
    break;
  }
  return s;
}
const iconv = require('iconv-lite');
require('iconv-lite/encodings');

const UPSTREAM_ORIGIN = 'https://sush1h4mst3r.stars.ne.jp/';

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

  const pairs = setCookies.map(c=>String(c).split(';',1)[0]).filter(Boolean);
  if (pairs.length){
    const jarValue = encodeURIComponent(pairs.join('; '));
    rewritten.push(`pb_up=${jarValue}; Path=/; Max-Age=31536000; SameSite=None; Secure; Partitioned; Domain=${host}`);
  }

  res.setHeader('Set-Cookie', rewritten);
}

// ---------- meta & URL rewriting ----------
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
  // ★ action は書き換えない（動的フックでやる）←二重包み対策
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
function injectRuntimeRewriter(html, upstreamAbs, req){
  const selfOrigin = buildSelfOrigin(req);
  const up = new URL(upstreamAbs);
  const upBase = up.origin + up.pathname.replace(/[^/]*$/,'');
  const js = `
<script>(function(){
  var SELF=${JSON.stringify(selfOrigin)};
  var UP_ORIGIN=${JSON.stringify(up.origin)};
  var UP_BASE=${JSON.stringify(upBase)};
  function toProxy(u){
    try{
      // 既に proxy?u=... 形式なら二重包みしない（相対ならSELFを付与）
      var raw=String(u);
      if (/^(?:\\/??api\\/)?proxy\\?u=/.test(raw)) {
        return raw.startsWith('http') ? raw : (raw.startsWith('/') ? (SELF+raw) : (SELF+'/'+raw));
      }

      var abs=new URL(u,UP_BASE).toString();
      if(abs.startsWith(UP_ORIGIN)){
        var rel=abs.replace(UP_ORIGIN+"/","");
        return SELF+"/api/proxy?u="+encodeURIComponent(rel);
      }
      if(abs.startsWith(SELF+"/api/")){
        var path=abs.substring((SELF+"/api/").length);
        var upGuess=new URL(path,UP_BASE).toString();
        if(upGuess.startsWith(UP_ORIGIN)){
          var rel2=upGuess.replace(UP_ORIGIN+"/","");
          return SELF+"/api/proxy?u="+encodeURIComponent(rel2);
        }
      }
      return abs;
    }catch(e){ return u; }
  }
  function fixAll(){
    document.querySelectorAll("a[href]").forEach(function(a){
      var h=a.getAttribute("href");
      if(h && !/^https?:|^data:|^mailto:|^javascript:/i.test(h)) a.setAttribute("href",toProxy(h));
    });
    document.querySelectorAll("form").forEach(function(f){
      var act=f.getAttribute("action")||"potiboard.php";
      if(!/^https?:/i.test(act)) f.setAttribute("action",toProxy(act));
      f.addEventListener("submit",function(){
        var a=f.getAttribute("action")||f.action||"potiboard.php";
        try{ f.action=toProxy(a); }catch(_){}
      },true);
    });
  }
  if(window.fetch){
    var _f=window.fetch;
    window.fetch=function(input,init){
      try{
        if(typeof input==="string") input=toProxy(input);
        else if (input && input.url){ var u=toProxy(input.url); input=new Request(u,input); }
      }catch(e){}
      return _f(input,init);
    };
  }
  if(window.XMLHttpRequest){
    var _o=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(m,u){
      try{ u=toProxy(u);}catch(e){}
      return _o.apply(this,[m,u].concat([].slice.call(arguments,2)));
    };
  }
  var mo=new MutationObserver(function(ms){
    ms.forEach(function(m){
      (m.addedNodes||[]).forEach(function(n){
        if(n.nodeType!==1) return;
        if(n.matches&&n.matches("a[href]")){
          var h=n.getAttribute("href");
          if(h && !/^https?:|^data:|^mailto:|^javascript:/i.test(h)) n.setAttribute("href",toProxy(h));
        }
        n.querySelectorAll&&n.querySelectorAll("a[href],form").forEach(function(el){
          if(el.tagName==="A"){
            var h2=el.getAttribute("href");
            if(h2 && !/^https?:|^data:|^mailto:|^javascript:/i.test(h2)) el.setAttribute("href",toProxy(h2));
          }else if(el.tagName==="FORM"){
            var a2=el.getAttribute("action")||"potiboard.php";
            if(!/^https?:/i.test(a2)) el.setAttribute("action",toProxy(a2));
            el.addEventListener("submit",function(){
              var a3=el.getAttribute("action")||el.action||"potiboard.php";
              try{ el.action=toProxy(a3);}catch(_){}
            },true);
          }
        });
      });
    });
  });
  mo.observe(document.documentElement,{subtree:true,childList:true});
  if(document.readyState!=="loading") fixAll();
  else document.addEventListener("DOMContentLoaded",fixAll,{once:true});
})();</script>`;
  return html.replace(/<\/body/i, js + "\n</body");
}

// ---------- main ----------
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

    const method = req.method || 'GET';
    let upstreamBody;
    if (!['GET','HEAD'].includes(method)) upstreamBody = await readRawBody(req);

    // ---- merge cookie with jar(pb_up) ----
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
      const upstreamPairs = decodeURIComponent(jar);
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

    // 30x redirect
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
    htmlUtf8 = injectRuntimeRewriter(htmlUtf8, upstreamUrl, req);

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
