#!/usr/bin/env node
// server.js — 91cg1 实时监控直播聚合播放器 v3 (7×24 常驻版)
// 核心特性:
//   1. 双档常驻刷新: 直播 fast(180s) + 回放 replay(30min) 独立定时器, 不互相阻塞
//   2. 流探测端点 /api/probe/:id → 轻量子集(末尾 KEEP 片), 秒播
//   3. 健康自愈: 播放中 m3u8 403 → 单条重爬(--single, 秒级) → 重试, 不打全量
//   4. 进程级防线: uncaughtException / unhandledRejection / server error 全兜底, 永不崩
//   5. 静态资源 + API

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8090', 10);
const ROOT = __dirname;
const SOURCES = path.join(ROOT, 'live_sources.json');
const CRAWLER = path.join(ROOT, 'crawl_91cg1.js');
const REFRESH_SEC = parseInt(process.env.REFRESH_SEC || '180', 10);    // 直播快刷间隔
const REPLAY_REFRESH_SEC = parseInt(process.env.REPLAY_REFRESH_SEC || '1800', 10); // 回放刷 30min
const PROBE_KEEP = parseInt(process.env.PROBE_KEEP || '6', 10);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

// ---------- m3u8 缓存: 避免每次探测都重新拉全量 128KB ----------
const M3U8_CACHE = new Map(); // id -> { text, ts, fullCount, targetDuration, encrypted, keyLine, tsUrls, segCount, seq }
const M3U8_TTL_MS = 60000;    // 60s 内复用: 直播 auth_key 有效期远大于 60s, 回放 m3u8 不滚动

function m3u8CacheGet(id, m3u8Url){
  // 必须按 m3u8Url 匹配: 常驻爬虫每次刷新 auth_key, url 变化即视为失效
  const c = M3U8_CACHE.get(String(id));
  if (c && c.m3u8Url === m3u8Url && Date.now() - c.ts < M3U8_TTL_MS) return c;
  M3U8_CACHE.delete(String(id));
  return null;
}
function m3u8CacheSet(id, entry){
  M3U8_CACHE.set(String(id), { ...entry, ts: Date.now() });
  if (M3U8_CACHE.size > 128) M3U8_CACHE.delete(M3U8_CACHE.keys().next().value);
}
function parseM3U8(full, id){
  const lines = full.split(/\r?\n/);
  const seg = [];
  let lastDur = 0;
  for (const ln of lines){
    const mDur = ln.match(/^#EXTINF:([\d.]+),/);
    if (mDur){ lastDur = parseFloat(mDur[1]); continue; }
    if (ln.startsWith('http')){ seg.push({ dur:lastDur, url:ln }); lastDur=0; }
  }
  const targetM = full.match(/#EXT-X-TARGETDURATION:(\d+)/);
  const target = targetM ? parseInt(targetM[1],10) : Math.max(2, Math.round(lastDur||5));
  const keyM = full.match(/#EXT-X-KEY:METHOD=(\S+?),URI="([^"]+)"/);
  const mediaSeq = (full.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)||[])[1];
  return {
    seg, target,
    encrypted: !!keyM,
    keyLine: keyM ? `#EXT-X-KEY:METHOD=${keyM[1]},URI="${keyM[2]}"` : null,
    mediaSeq: mediaSeq ? parseInt(mediaSeq,10) : 0,
  };
}

// 在途去重: 同一 m3u8Url 并发只发一次
const inflight = new Map(); // m3u8Url -> Promise
async function fetchM3U8Cached(id, m3u8Url, referer, retries = 2){
  const cached = m3u8CacheGet(id, m3u8Url);
  if (cached) return cached;                       // 命中缓存(同 URL, 20s 内) → 毫秒级
  if (inflight.has(m3u8Url)) return inflight.get(m3u8Url);
  const p = (async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++){
      try {
        const r = await fetch(m3u8Url, { headers:{ 'User-Agent':UA, 'Referer': referer||'https://www.91cg1.com/' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP '+r.status);
        const full = await r.text();
        if (!full.trim().startsWith('#EXTM3U')) throw new Error('m3u8 内容异常');
        const parsed = parseM3U8(full, id);
        const entry = { m3u8Url, ...parsed };
        m3u8CacheSet(id, entry);
        return entry;
      } catch (e) {
        lastErr = e;
        // 源站签名 URL 的 m3u8/key/分片带一次性 auth_key, 过期 403/404 时
        // 重试同一 URL 无意义(签名已死), 立即抛出交给上层重爬拿新签名
        if (/HTTP (403|404)/.test(String(e.message))) break;
        // 其余(CDN 偶发 400/5xx/超时): 同 URL 重试, 间隔 800ms
        if (i < retries){ await sleep(800 * (i + 1)); }
      }
    }
    throw lastErr;
  })().finally(() => inflight.delete(m3u8Url));
  inflight.set(m3u8Url, p);
  return p;
}

const crawlState = {
  running: false,
  timer: null,
  replayTimer: null,
  lastRun: null,
  lastSuccess: null,
  nextRefreshAt: 0,
  singleId: null,          // runCrawl('single') 用的目标 id
  log: [],
};
// 单条重爬去重 + 冷却: 同一路 10s 内只触发一次(多客户端同时 403 不堆叠)
const singleReCrawl = new Map(); // id -> ts
function singleReCrawlAllowed(id){
  const ts = singleReCrawl.get(String(id));
  if (ts && Date.now() - ts < 10000) return false;
  singleReCrawl.set(String(id), Date.now());
  if (singleReCrawl.size > 256) singleReCrawl.delete(singleReCrawl.keys().next().value);
  return true;
}
function log(msg){
  crawlState.log.push(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${msg}`);
  if (crawlState.log.length > 600) crawlState.log.splice(0, crawlState.log.length - 600);
}

function readSources(){
  try { return JSON.parse(fs.readFileSync(SOURCES, 'utf8')); }
  catch (e) {
    return { source:'https://www.91cg1.com/category/sstp/live/', crawledAt:null, total:0, online:0, items:[], error:String(e.message||e) };
  }
}
function writeSources(obj){ fs.writeFileSync(SOURCES, JSON.stringify(obj, null, 2), 'utf8'); }

// ---------- 爬虫 ----------
// fast: 只抓直播(热门+监控, ~12 条, ~10s)  /  replay: 回放列表+详情(30min 一轮)
// single: 单条重抓(播放自愈, 秒级)  /  full: 全部三栏目
function runCrawl(mode){
  if (crawlState.running){ return { ok:false, message:'正在爬取中', busy:true }; }
  crawlState.running = true;
  const startedAt = new Date().toISOString();
  log(`开始爬取(${mode}) …`);
  const args = [CRAWLER, SOURCES];
  if (mode === 'full') args.push('--full');
  else if (mode === 'replay') args.push('--replay');
  else if (mode === 'fast') args.push('--live-only');
  else if (mode === 'single'){
    args.push('--single', String(crawlState.singleId || ''));
  }
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio:['ignore','pipe','pipe'] });
  let out = '';
  let crawlTimer = null;
  const timeoutMs = mode==='full' ? 60*60*1000 : mode==='replay' ? 30*60*1000 : 5*60*1000;
  // 爬虫子进程挂死防护: 超时强杀(7×24 关键: 不能让 running 永远卡 true)
  crawlTimer = setTimeout(() => {
    if (crawlState.running){
      log(`爬取超时(${Math.round(timeoutMs/1000)}s) 强杀`);
      try { child.kill('SIGKILL'); } catch(_){}
      crawlState.running = false;
      crawlState.lastRun = { startedAt, finishedAt:new Date().toISOString(), exitCode:-1, mode, output:out.slice(-2000)+'\n[timeout kill]' };
    }
  }, timeoutMs);
  child.stdout.on('data', d => out += d.toString());
  child.stderr.on('data', d => out += d.toString());
  child.on('close', code => {
    clearTimeout(crawlTimer);
    crawlState.running = false;
    const summary = (out.match(/合计 \d+\/\d+/)||[])[0] || (out.match(/在线可播 \d+\/\d+/)||[])[0] || '';
    crawlState.lastRun = { startedAt, finishedAt:new Date().toISOString(), exitCode:code, mode, summary, output: out.slice(-3000) };
    if (code === 0) crawlState.lastSuccess = new Date().toISOString();
    log(`爬取结束 exit=${code} ${summary||''}`);
    if (code !== 0) log('注意: 爬取失败, 页面将沿用上一次成功的源。');
  });
  child.on('error', e => {
    clearTimeout(crawlTimer);
    crawlState.running = false;
    crawlState.lastRun = { startedAt, finishedAt:new Date().toISOString(), exitCode:-1, mode, output:'spawn error: '+e.message };
    log('爬取进程错误: '+e.message);
  });
  return { ok:true, message:'爬取已启动('+mode+')', startedAt, mode };
}

// ---------- 流探测: 末尾子集 m3u8 秒播(这些流是准直播 VOD: 固定片 + ENDLIST + 不滚动) ----------
async function probeStream(id){
  const data = readSources();
  const it = (data.items||[]).find(x => String(x.id)===String(id));
  if (!it || !it.m3u8){ return { ok:false, message:'未找到该直播源 id='+id, http:404 }; }

  let entry;
  try {
    entry = await fetchM3U8Cached(id, it.m3u8, it.detailUrl);
  } catch(e){
    // m3u8 抓取失败: 403/404=签名失效(快失败, 需重爬新签名); 其余(CDN 偶发 400/超时)=重试
    const stale = /HTTP (403|404)/.test(String(e.message));
    if (stale && singleReCrawlAllowed(id)){
      // 签名死了 → 单条重爬(--single, 秒级)拿新 m3u8, 不打全量, 不阻塞定时器
      log("探测 m3u8 签名失效(#"+id+") → 单条重爬");
      crawlState.singleId = id;
      runCrawl('single');
      await sleep(2500);
      const data2 = readSources();
      const it2 = (data2.items||[]).find(x => String(x.id)===String(id));
      if (it2 && it2.m3u8 && it2.m3u8 !== it.m3u8){
        try {
          entry = await fetchM3U8Cached(id, it2.m3u8, it2.detailUrl);
          it.m3u8 = it2.m3u8; writeSources(data2);
        } catch(e2){ return { ok:false, message:'单条重爬后重试失败: '+e2.message, http:502 }; }
      } else {
        // 单条重爬没拿到新 m3u8(源站可能临时下线): 原 URL 再试一次
        try {
          M3U8_CACHE.delete(String(id));
          entry = await fetchM3U8Cached(id, it.m3u8, it.detailUrl);
        } catch(e2){ return { ok:false, message:'签名失效且单条重爬无新源', http:502 }; }
      }
    } else {
      // 非签名失效(CDN 偶发/超时): 清缓存重试一次
      log("探测 m3u8 失败(#"+id+", "+e.message+") → 重试");
      M3U8_CACHE.delete(String(id));
      try {
        entry = await fetchM3U8Cached(id, it.m3u8, it.detailUrl);
      } catch(e2){ return { ok:false, message:'重试失败: '+e2.message, http:502 }; }
    }
  }

  const seg = entry.seg;
  if (!seg || !seg.length) return { ok:false, message:'m3u8 内无分片', http:502 };

  const keep = Math.min(PROBE_KEEP, seg.length);
  const tail = seg.slice(seg.length - keep);
  const sub = [];
  sub.push('#EXTM3U');
  sub.push('#EXT-X-VERSION:3');
  sub.push(`#EXT-X-MEDIA-SEQUENCE:${entry.mediaSeq + seg.length - keep}`);
  sub.push(`#EXT-X-TARGETDURATION:${entry.target}`);
  if (entry.keyLine) sub.push(entry.keyLine);
  for (const s of tail) sub.push(`#EXTINF:${s.dur},`, s.url);
  // 关键修复: 这些流是准直播 VOD(固定片不滚动), 子集必须带 ENDLIST,
  // 否则 hls.js 当作无限直播一直等新分片 → 永远转圈播不了
  sub.push('#EXT-X-ENDLIST');
  const subText = sub.join('\n') + '\n';

  return {
    ok:true,
    id,
    title: it.title,
    status: it.status,
    fullCount: seg.length,
    keepCount: keep,
    targetDuration: entry.target,
    lastSequence: seg.length - 1,
    vodLike: true,               // 准直播 VOD: 固定片 + 不滚动
    m3u8: it.m3u8,
    probeM3u8: subText,
    probeUrl: '',
    encrypted: entry.encrypted,
    detailUrl: it.detailUrl,
    cover: it.cover,
  };
}

// 把 probeM3u8 提供成可 GET 的 data/inline 端点: /api/stream/:id
function httpRespond(res, status, type, body){
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin':'*',
    'Cache-Control':'no-store, max-age=0',
  });
  res.end(body);
}

const sleep = ms => new Promise(r=>setTimeout(r, ms));

const INDEX_HTML = () => { try { return fs.readFileSync(path.join(ROOT,'index.html'),'utf8'); } catch(e){ return '<h1>index.html 缺失</h1>'; } };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':'*',
    });
    return res.end();
  }

  (async () => {
    try {
      if (req.method === 'GET' && p === '/'){
        return httpRespond(res, 200, 'text/html; charset=utf-8', INDEX_HTML());
      }
      if (req.method === 'GET' && p === '/api/sources'){
        const data = readSources();
        const nextRefreshAt = crawlState.nextRefreshAt ? new Date(crawlState.nextRefreshAt).toISOString() : null;
        // 7×24 加固: 响应头加 ETag + 短缓存, 客户端 60s 内不重复拉全量(前端 60s 轮询时省带宽)
        let etag = '"0"';
        try {
          const hash = data.crawledAt ? String(data.crawledAt).length : '0';
          etag = JSON.stringify([data.total, hash, String(data.items||[]).length]);
        } catch(e){}
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch && ifNoneMatch === etag){
          res.writeHead(304, { 'ETag': etag, 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*' });
          return res.end();
        }
        const body = JSON.stringify({ ...data, nextRefreshAt, refreshSec: REFRESH_SEC });
        res.writeHead(200, {
          'Content-Type':'application/json; charset=utf-8',
          'Access-Control-Allow-Origin':'*',
          'Cache-Control':'no-store, max-age=0',
          'ETag': etag,
        });
        return res.end(body);
      }
      if (req.method === 'POST' && p === '/api/refresh'){
        // ?full=1 抓全部三栏目(含回放 680 条); 默认 fast(热门+监控, 保直播流新鲜)
        const mode = url.searchParams.get('full') ? 'full' : 'fast';
        const r = runCrawl(mode);
        return httpRespond(res, 200, 'application/json', JSON.stringify(r));
      }
      if (req.method === 'GET' && p === '/api/status'){
        // 剔除不可序列化的 timer / log 之外的内部对象
        const snap = {
          running: crawlState.running,
          lastRun: crawlState.lastRun,
          lastSuccess: crawlState.lastSuccess,
          nextRefreshAt: crawlState.nextRefreshAt ? new Date(crawlState.nextRefreshAt).toISOString() : null,
          refreshSec: REFRESH_SEC,
          logTail: crawlState.log.slice(-40),
        };
        return httpRespond(res, 200, 'application/json', JSON.stringify(snap));
      }
      if (req.method === 'GET' && p.startsWith('/api/probe/')){
        const id = p.replace('/api/probe/','');
        const out = await probeStream(id);
        const status = out.ok ? 200 : (out.http || 500);
        return httpRespond(res, status, 'application/json; charset=utf-8', JSON.stringify(out));
      }
      if (req.method === 'GET' && p.startsWith('/api/stream/')){
        // 返回可播放的 inline m3u8 (应用层, 给 hls.js 当 URL 拉取也支持)
        const id = p.replace('/api/stream/','');
        const out = await probeStream(id);
        if (out.ok){
          return httpRespond(res, 200, 'application/vnd.apple.mpegurl; charset=utf-8', out.probeM3u8);
        }
        return httpRespond(res, out.http||500, 'application/json', JSON.stringify({ok:false, message:out.message}));
      }
      // 静态资源
      if (req.method === 'GET'){
        const rel = p.replace(/^\/+/,'');
        const fpath = path.join(ROOT, rel || 'index.html');
        if (fpath.startsWith(ROOT) && fs.existsSync(fpath) && fs.statSync(fpath).isFile()){
          const ext = path.extname(fpath).toLowerCase();
          const types = {
            '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
            '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
            '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml',
            '.ico':'image/x-icon','.mp4':'video/mp4','.m3u8':'application/vnd.apple.mpegurl'
          };
          res.writeHead(200, { 'Content-Type': types[ext]||'application/octet-stream', 'Cache-Control':'no-cache','Access-Control-Allow-Origin':'*' });
          return fs.createReadStream(fpath).pipe(res);
        }
      }
      return httpRespond(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
    } catch (e) {
      return httpRespond(res, 500, 'text/plain; charset=utf-8', '500 '+(e.message||String(e)));
    }
  })();
});

server.listen(PORT, () => {
  console.log(`\n  91cg1 实时监控播放器 v3 (7×24 常驻版)`);
  console.log(`  界面:    http://localhost:${PORT}/`);
  console.log(`  源:      http://localhost:${PORT}/api/sources`);
  console.log(`  探测:    http://localhost:${PORT}/api/probe/:id`);
  console.log(`  流:      http://localhost:${PORT}/api/stream/:id`);
  console.log(`  刷新:    POST /api/refresh (fast=直播快刷)  /api/refresh?full=1 (全量) /api/refresh?replay=1 (回放)`);
  console.log(`  状态:    http://localhost:${PORT}/api/status`);
  console.log(`  直播快刷: 每 ${REFRESH_SEC}s (--live-only, ~10s/轮)`);
  console.log(`  回放刷新: 每 ${REPLAY_REFRESH_SEC}s (--replay, 独立周期)`);
  console.log(`  自愈:    播放 403 → 单条重爬(--single, 秒级, 10s 冷却去重)`);
  console.log(`  (按 Ctrl+C 退出)\n`);
  scheduleRefresh();
  // 启动: 已有 live_sources.json(含回放) → 立即快刷直播 + 排程回放; 否则全量抓一次
  const existing = (()=>{ try{ const d=JSON.parse(fs.readFileSync(SOURCES,'utf8')); return (d.items||[]).some(x=>x.section==='replay'); }catch(e){ return false; } })();
  if (existing){
    log('检测到已含回放的数据, 启动时快刷直播, 回放走独立 30min 周期');
    runCrawl('fast');
  } else {
    log('无历史数据, 启动全量爬取(直播+回放 680+条)');
    runCrawl('full');
  }
});

// ---------- 双档常驻刷新定时器: 直播快刷(180s) + 回放刷新(30min) 独立, 不互相阻塞 ----------
function scheduleRefresh(){
  if (crawlState.timer) clearInterval(crawlState.timer);
  crawlState.timer = setInterval(() => {
    if (crawlState.running) return; // 上一次还在跑就跳过, 不叠加
    runCrawl('fast');
  }, REFRESH_SEC * 1000);
  crawlState.nextRefreshAt = Date.now() + REFRESH_SEC*1000;
  // 回放刷新: 独立周期(默认 30min), 只刷回放签名, 不碰直播快刷
  if (crawlState.replayTimer) clearInterval(crawlState.replayTimer);
  crawlState.replayTimer = setInterval(() => {
    if (crawlState.running) return;
    log('回放签名周期刷新…');
    runCrawl('replay');
  }, REPLAY_REFRESH_SEC * 1000);
}
// ---------- 看门狗: 定时器意外失效(被异常吞掉)时 5min 兜底重启 ----------
const watchdog = setInterval(() => {
  if (!crawlState.timer || !crawlState.replayTimer){
    log('[watchdog] 定时器失效, 重启 scheduleRefresh');
    scheduleRefresh();
  }
}, 5*60*1000);

// ---------- 进程级防线: 7×24 常驻关键, 任何未捕获异常都不能杀死进程 ----------
process.on('uncaughtException', (e) => {
  log('[FATAL-GUARD] uncaughtException: ' + (e && e.stack ? e.stack : String(e)));
  // 不退出: 记录后继续。若连续异常由 watchdog 兜底重启。
});
process.on('unhandledRejection', (reason) => {
  log('[FATAL-GUARD] unhandledRejection: ' + String(reason && reason.stack ? reason.stack : reason));
});
// HTTP server 自身错误(如 EADDRINUSE / 文件句柄耗尽)兜底, 不让进程崩
server.on('error', (e) => {
  log('[SERVER-ERROR] ' + e.code + ': ' + e.message);
  if (e.code === 'EADDRINUSE'){
    console.error('[server] 端口 ' + PORT + ' 被占用, 请检查是否有旧实例未退出。');
    // 不 exit: 记录后保持进程, 由外部 supervisor 决定重启; 避免端口占用即崩。
  }
});
// 客户端发送畸形请求触发 clientError, 默认会 destroy socket; 显式处理避免冒泡成 error
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
});

process.on('SIGINT', () => { log('收到 SIGINT, 退出'); if(crawlState.timer) clearInterval(crawlState.timer); if(crawlState.replayTimer) clearInterval(crawlState.replayTimer); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM, 退出'); if(crawlState.timer) clearInterval(crawlState.timer); if(crawlState.replayTimer) clearInterval(crawlState.replayTimer); process.exit(0); });
