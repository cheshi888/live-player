#!/usr/bin/env node
// crawl_91cg1.js — 抓取 91cg1.com 实时偷拍全部视频 m3u8 播放地址（三栏目）
//   热门推荐 /category/sstp/        (单页, 在线直播)
//   实时监控 /category/sstp/live/   (单页, 在线直播)
//   精彩回放 /category/sstp/replay/ (多页, 回放 VOD)
// 输出 JSON: F:\zq\live_sources.json 带 section 字段
// 用法：node crawl_91cg1.js [输出json路径] [--replay]  (--replay 才抓回放多页, 默认只抓热门推荐+实时监控, 快)

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const BASE = 'https://www.91cg1.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SECTIONS = [
  { key:'hot',    label:'热门推荐', url:`${BASE}/category/sstp/` },
  { key:'live',   label:'实时监控', url:`${BASE}/category/sstp/live/` },
  { key:'replay', label:'精彩回放', url:`${BASE}/category/sstp/replay/`, pages:true },
];

function cleanUrl(u){
  if(!u) return '';
  let s = u;
  const q = s.indexOf('?');
  let base = q>=0 ? s.slice(0,q) : s;
  let qs   = q>=0 ? s.slice(q) : '';
  base = base.replace(/^[hH][tT][tT][pP][sS]?[:]*\/+/, '');
  base = base.replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  const scheme = /^https/i.test(u) ? 'https' : 'http';
  return scheme + '://' + base + qs;
}

async function get(url, retry=2){
  let last;
  for (let i=0;i<=retry;i++){
    try {
      // 超时防护: 源站挂死时整轮 crawl 不卡死(7×24 常驻关键)
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept':'text/html,application/xhtml+xml' }, redirect:'follow', signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.text();
    } catch (e) {
      last = e;
      if (i<retry){ await sleep(1500*(i+1)); }
    }
  }
  throw last;
}

// 原子写: 先写 .tmp 再 rename, 防止写一半进程被杀导致 live_sources.json 损坏
function atomicWriteJSON(file, obj){
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// 解析列表页: 卡片 <a ... href="/category/sstp/video/ID/"> ... 在线/离线 ... </a>
function parseListPage(html, section){
  const cards = [];
  // 热门推荐页: <a class="realtime-card" aria-label="标题" href="/category/sstp/video/ID/">
  //   <img class="realtime-card__cover" data-xkrkllgl="真实封面">
  //   <span class="realtime-card__status realtime-card__status--online|offline">在线/离线</span>
  // 监控/回放页: <a class="card-item" href="..."> <img> <div>标题</div> <span>在线/离线</span>
  const cardsRe = /<a[^>]+href="\/category\/sstp\/video\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  const seenLocal = new Set();
  while ((m = cardsRe.exec(html)) !== null) {
    const id = m[1];
    const inner = m[2];
    if (seenLocal.has(id)) continue;
    seenLocal.add(id);
    // 标题: aria-label(热推) 或 img alt(回放/监控)
    let title = '';
    const aTag = inner.match(/<a[^>]+aria-label="([^"]+)"/);
    if (aTag) title = aTag[1].trim();
    if (!title){
      const altM = inner.match(/<img[^>]+alt="([^"]+)"/);
      if (altM) title = altM[1].trim();
    }
    if (!title){
      title = inner.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
                   .replace(/^(在线|离线|已离线|离线中)\s*/,'').replace(/\s*(在线|离线|已离线|离线中)$/,'');
    }
    // 封面: data-xkrkllgl(热推真实图) 或 img src
    const covM = inner.match(/<img[^>]+data-xkrkllgl="([^"]+)"/) || inner.match(/<img[^>]+src="([^"]+)"/);
    const cover = covM ? covM[1] : '';
    // 状态: class --online/--offline(热推) 或 文字 在线/离线(回放/监控)
    const stM = inner.match(/realtime-card__status--(online|offline)/) || inner.match(/\b(在线|离线|已离线|离线中)\b/);
    let status = 'online';
    if (stM){ status = /offline|离线/.test(stM[0]) ? 'offline' : 'online'; }
    cards.push({ id, title, status, cover, url:`${BASE}/category/sstp/video/${id}/`, section: section.key, sectionLabel: section.label });
  }
  return cards;
}

function nextReplayPage(html, cur){
  const m = html.match(new RegExp('<a[^>]+href="\\/category\\/sstp\\/replay\\/(\\d+)\\/"[^>]*>下一页'));
  if (m) return parseInt(m[1],10);
  return null;
}

function parseDetail(html, id){
  const titleM = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)/);
  const title = titleM ? titleM[1].replace(/\s*-\s*偷拍视频.*$/,'').trim() : '';
  const statusM = html.match(/data-video_status="(\w+)"/);
  const status = statusM ? statusM[1] : 'unknown';
  const descM = html.match(/data-video_description="([^"]*)"/);
  const description = descM ? descM[1].trim() : '';
  let m3u8 = '';
  const cfgM = html.match(/data-config='([\s\S]*?)'<\/div>/) || html.match(/data-config='([\s\S]*?)'/);
  if (cfgM) {
    const cfgJson = cfgM[1].replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#x26;/g,'&');
    const uM = cfgJson.match(/"video"\s*:\s*{\s*"url"\s*:\s*"([^"]+)"/);
    if (uM) m3u8 = uM[1].replace(/\\\//g,'/').replace(/\\\\/g,'');
  }
  if (!m3u8){
    const m3 = html.match(/(https?:\/\/[^\s"']+?\.m3u8[^"'<]*)/);
    if (m3) m3u8 = m3[1].replace(/\\\//g,'/');
  }
  m3u8 = cleanUrl(m3u8);
  const coverM = html.match(/<meta property="og:image" content="([^"]+)"/);
  const cover = coverM ? coverM[1] : '';
  const detailUrl = `${BASE}/category/sstp/video/${id}/`;
  const isLive = /"live":\s*true/.test(html);
  return { id, title, status, description, m3u8, cover, detailUrl, isLive };
}

// 并发池
async function pool(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  async function worker(){
    while (i < items.length){
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({length:n}, worker));
  return out;
}

// ---------- 参数 ----------
// 模式: 默认 fast(直播 12 条) | --replay(回放列表+详情) | --full(全部) | --single <id>(单条)
// 7×24 设计: fast 只刷直播签名(快, 180s 一轮); 回放 30min 一轮(--replay);
// 播放中单条 403 时按需 --single 重抓一条(秒级)。
const OUT_ARG = process.argv[2] || path.join(__dirname,'live_sources.json');
const ARGS = process.argv.slice(2).filter(a => !/^\d+$/.test(a) && a !== OUT_ARG);
const isSingle = ARGS.includes('--single');
const SINGLE_ID = isSingle ? process.argv[process.argv.indexOf('--single') + 1] : null;
const includeReplay = ARGS.includes('--replay') || ARGS.includes('--full');
const liveOnly = ARGS.includes('--live-only') || (ARGS.length === 0 && !includeReplay);

(async () => {
  // 解析参数: 输出路径 = 第一个非开关参数, 默认 live_sources.json
  const outPath = OUT_ARG;

  // ---------- 单条模式快速通道: 跳过 3 个列表页, 直抓 1 个详情页(秒级) ----------
  // 旧版 --single 仍走全列表(3s+), 现在只抓该条详情, 沿用 prior JSON 的元数据
  if (isSingle && SINGLE_ID){
    console.log(`[crawl] 单条快速重抓 #${SINGLE_ID} (跳过列表页, 直抓详情) …`);
    let prior = null;
    try { if (fs.existsSync(outPath)) prior = JSON.parse(fs.readFileSync(outPath,'utf8')); } catch(e){}
    const priorItem = (prior && prior.items || []).find(x => String(x.id) === String(SINGLE_ID));
    const target = {
      id: SINGLE_ID,
      section: priorItem ? priorItem.section : 'replay',
      status: priorItem ? priorItem.status : 'unknown',
      url: `${BASE}/category/sstp/video/${SINGLE_ID}/`,
      sectionLabel: priorItem ? priorItem.sectionLabel : '',
    };
    let rec;
    try {
      const html = await get(target.url, 2);
      rec = parseDetail(html, SINGLE_ID);
      rec.status = target.status;
      rec.section = target.section;
      rec.sectionLabel = target.sectionLabel;
      if (priorItem){
        // 沿用旧条目的元数据(标题/封面/alsoLive), 新抓的 m3u8 覆盖
        rec.title = priorItem.title || rec.title;
        rec.cover = priorItem.cover || rec.cover;
        if (priorItem.alsoLive) rec.alsoLive = true;
      }
      rec.hasM3u8 = !!rec.m3u8;
      if (!rec.m3u8 && priorItem && priorItem.m3u8){
        rec.m3u8 = priorItem.m3u8; rec.hasM3u8 = true; rec.m3u8From = 'prior';
        console.log(`[crawl]   #${SINGLE_ID} 新抓无 m3u8, 沿用 prior 旧 m3u8`);
      }
    } catch(e){
      console.log(`[crawl]   #${SINGLE_ID} 详情抓取失败: ${e.message}, 沿用 prior`);
      rec = { ...target, m3u8: priorItem ? priorItem.m3u8 : '', hasM3u8: !!(priorItem && priorItem.m3u8),
              title: priorItem ? priorItem.title : '', error: String(e.message||e),
              m3u8From: priorItem && priorItem.m3u8 ? 'prior' : undefined };
    }
    // 合并回 prior(替换该条), 原子写
    const priorItems = (prior && prior.items) ? prior.items.slice() : [];
    const idx = priorItems.findIndex(x => String(x.id) === String(SINGLE_ID));
    if (idx >= 0) priorItems[idx] = { ...priorItems[idx], ...rec };
    else priorItems.push({ ...target, ...rec, detailUrl: target.url });
    const out = {
      source: SECTIONS.map(s=>s.url).join(' ; '),
      crawledAt: new Date().toISOString(),
      total: priorItems.length,
      bySection: {},
      online: priorItems.filter(r=>r.status==='online' && r.hasM3u8).length,
      items: priorItems,
    };
    for (const r of priorItems){
      out.bySection[r.section] = out.bySection[r.section]||{ total:0, online:0 };
      out.bySection[r.section].total++;
      if (r.status==='online' && r.hasM3u8) out.bySection[r.section].online++;
      if (r.alsoLive){
        out.bySection.live = out.bySection.live||{ total:0, online:0 };
        out.bySection.live.total++;
        if (r.status==='online' && r.hasM3u8) out.bySection.live.online++;
      }
    }
    atomicWriteJSON(outPath, out);
    console.log(`[crawl] 单条完成 #${SINGLE_ID}: ${rec.hasM3u8?'✓ m3u8 已刷新':'沿用旧 m3u8'} (${rec.m3u8From||'new'})`);
    process.exit(rec.hasM3u8 ? 0 : 1);
  }

  const seen = new Set();
  const allCards = [];

  // 顺序: 先建栏目卡片(allCards + seen), 再断点续抓复用旧 m3u8(跳过已在 allCards 的 id), 最后详情并发。
  // 热门循环放最前, 让热门 4 条先以 section=hot + alsoLive=true 进入 allCards;
  // 监控循环对已存在的 hot 条目补 alsoLive; 断点续抓只补 allCards 里没有的 id。

  // --- 热门推荐 (单页, 最先建, 让 hot 标记权威) ---
  console.log('[crawl] 热门推荐');
  let hotHtml = await get(SECTIONS[0].url);
  const hotCards = parseListPage(hotHtml, SECTIONS[0]);
  for (const c of hotCards){
    const ex = allCards.find(x=>String(x.id)===String(c.id));
    if (ex){ ex.section='hot'; ex.sectionLabel='热门推荐'; ex.alsoLive=true; ex.status=c.status; ex.cover=c.cover||ex.cover; }
    else { seen.add(c.id); allCards.push({ ...c, alsoLive:true }); }
  }
  console.log(`[crawl]   → ${hotCards.length} 条`);

  // --- 实时监控 (单页) ---
  console.log('[crawl] 实时监控');
  let liveHtml = await get(SECTIONS[1].url);
  const livePageCards = parseListPage(liveHtml, SECTIONS[1]);
  for (const c of livePageCards){
    const ex = allCards.find(x=>String(x.id)===String(c.id));
    if (ex){
      if (ex.section==='hot'){ ex.alsoLive=true; }
      else { ex.section='live'; ex.sectionLabel='实时监控'; ex.status=c.status; ex.cover=c.cover||ex.cover; }
    } else {
      seen.add(c.id); allCards.push(c);
    }
  }
  console.log(`[crawl]   → 监控页 ${livePageCards.length} 条, 热门 ${hotCards.length} 条, 去重后总 ${allCards.length}`);

  // 断点续抓: 若旧 JSON 含回放条目, 无论是否 --replay 都保留它们(避免 fast 刷新把回放数据清掉);
  // --replay 时还会额外重扫回放多页列表 + 抓新回放详情页
  let prior = null;
  const hotIds = new Set(hotCards.map(c=>String(c.id)));
  if (fs.existsSync(outPath)){
    try {
      prior = JSON.parse(fs.readFileSync(outPath,'utf8'));
      let merged=0;
      for (const it of (prior.items||[])){
        // 保留旧的回放条目(以及任何未在 allCards 的已抓 m3u8)
        if (it.hasM3u8 && it.m3u8 && !seen.has(String(it.id))){
          seen.add(String(it.id));
          allCards.push({
            id:String(it.id), title:it.title, status:it.status, url:it.detailUrl,
            section: it.section||'replay', sectionLabel: it.sectionLabel||'精彩回放',
            alsoLive:false, cover: it.cover||'',
          });
          merged++;
        }
      }
      // 热门修复: 旧数据里 id 命中当前热门页的条目强制改回 hot + alsoLive
      let hotFixed=0;
      for (const c of allCards){
        if (hotIds.has(String(c.id)) && c.section!=='hot'){
          c.section='hot'; c.sectionLabel='热门推荐'; c.alsoLive=true; hotFixed++;
        }
      }
      if (merged || hotFixed) console.log(`[crawl] 断点续抓: 保留 ${merged} 条旧 m3u8(含回放), 热门修复 ${hotFixed} 条, allCards=${allCards.length}`);
    } catch(e){ prior = null; }
  }

  // --- 精彩回放 (多页, 可选; 每页 20 卡, 最多 ~37 页 ~680 条) ---
  if (includeReplay) {
    console.log('[crawl] 精彩回放 (多页 …)');
    let page = 1;
    let replaySeen = new Set();
    let guard = 0;
    while (guard++ < 200) {
      const purl = page===1 ? SECTIONS[2].url : SECTIONS[2].url.replace(/\/$/, '') + '/' + page + '/';
      let phtml;
      try { phtml = await get(purl); } catch (e) {
        console.log(`[crawl]   第${page}页 404/失败 (${e.message}), 停止`);
        break;
      }
      const cards = parseListPage(phtml, SECTIONS[2]);
      let newCount = 0;
      for (const c of cards){
        if (replaySeen.has(c.id)) continue;
        replaySeen.add(c.id);
        if (!seen.has(c.id)){ seen.add(c.id); allCards.push(c); newCount++; }
      }
      const nextPage = nextReplayPage(phtml, page);
      console.log(`[crawl]   第${page}页: ${cards.length} 卡, 新增 ${newCount}, 累计 ${allCards.length}`);
      if (cards.length===0 || !nextPage || nextPage===page) break;
      page = nextPage;
      if (page > 200) break;
      await sleep(400);
    }
    console.log(`[crawl]   回放共 ${replaySeen.size} 条 (栏目内去重), 总计 ${allCards.length}`);
  } else {
    console.log('[crawl] 精彩回放: 跳过 (加 --replay 抓取)');
  }

  // --- 并发抓详情提取 m3u8 ---
  // 按模式筛选待抓详情(7×24 关键: 不能每 180s 全量重抓 700+ 条回放, 会打垮源站且卡死定时器):
  //   live-only(默认/fast): 只重抓直播(热门+监控, ~12 条)刷新 auth_key; 回放条目保留旧 m3u8
  //   replay: 只重抓回放条目刷新签名(独立 30min 周期, 不影响直播快刷)
  //   full:   全部重抓
  //   single: 只重抓指定 id 一条(播放中按需自愈)
  let toFetch;
  if (isSingle && SINGLE_ID){
    toFetch = allCards.filter(c => String(c.id) === String(SINGLE_ID));
    if (!toFetch.length){
      // 该 id 可能不在列表页(回放旧条目): 直接用 detailUrl 构造一条
      toFetch = [{ id: SINGLE_ID, section:'replay', status:'offline', url:`${BASE}/category/sstp/video/${SINGLE_ID}/` }];
    }
    console.log(`[crawl] 单条重抓 #${SINGLE_ID} …`);
  } else if (liveOnly){
    toFetch = allCards.filter(c => c.section==='hot' || c.section==='live' || c.alsoLive === true);
    console.log(`[crawl] 直播快刷: 重抓 ${toFetch.length} 条直播详情(回放保留旧签名) …`);
  } else if (includeReplay && !ARGS.includes('--full')){
    toFetch = allCards.filter(c => c.section==='replay');
    console.log(`[crawl] 回放刷新: 重抓 ${toFetch.length} 条回放详情 …`);
  } else {
    toFetch = allCards;
    console.log(`[crawl] 全量重抓 ${toFetch.length} 条 …`);
  }
  const CONC = liveOnly || isSingle ? 6 : (includeReplay ? 4 : 6);
  const results = await pool(toFetch, CONC, async (card) => {
    try {
      const html = await get(card.url, 3);
      const rec = parseDetail(html, card.id);
      rec.status = card.status;            // 列表页状态为准
      rec.section = card.section;
      rec.sectionLabel = card.sectionLabel;
      if (card.alsoLive) rec.alsoLive = true;
      // 列表页封面优先(真实图), 详情页 og:image 兜底
      rec.cover = (card.cover && /https?:\/\//.test(card.cover)) ? card.cover : (rec.cover || card.cover || '');
      rec.hasM3u8 = !!rec.m3u8;
      return rec;
    } catch (e) {
      console.log(`[crawl]   #${card.id} 失败: ${e.message}`);
      return { ...card, m3u8:'', hasM3u8:false, error:String(e.message||e) };
    }
  });
  // 合并: priorItems(旧 m3u8 数据) + results(本次新抓)
  // live-only / single 模式: 未抓到的条目(如回放)沿用 prior 的旧记录(含旧 m3u8),
  // 不让本轮空结果把它们清掉。
  const priorItems = prior ? prior.items : [];
  const newIds = new Set(toFetch.map(c=>String(c.id)));
  const resultsAll = [
    ...priorItems.filter(x => !newIds.has(String(x.id))),
    ...results,
  ];
  // 热门/alsoLive 修复: 旧数据里 id 命中当前热门页的条目, 强制 section=hot + alsoLive=true
  // (旧 JSON 里那 4 条的 section 可能已被前次跑成 live, 这里纠正, 让 hot 栏可见)
  for (const r of resultsAll){
    if (hotIds.has(String(r.id)) && r.section!=='hot'){
      r.section='hot'; r.sectionLabel='热门推荐'; r.alsoLive=true;
    } else if (hotIds.has(String(r.id)) && r.section==='hot'){
      r.alsoLive = true;   // 已是 hot 也补 alsoLive, 让监控栏能看
    }
  }
  // 单条模式: 新抓无 m3u8 时沿用 prior 旧 m3u8(签名可能只是 CDN 瞬时抽风), 不清空
  if (isSingle){
    for (let i=0;i<results.length;i++){
      if (!results[i].m3u8){
        const priorItem = priorItems.find(x => String(x.id) === String(results[i].id));
        if (priorItem && priorItem.m3u8){
          results[i] = { ...results[i], m3u8: priorItem.m3u8, hasM3u8: true, m3u8From: 'prior' };
          console.log(`[crawl]   #${results[i].id} 新抓无 m3u8, 沿用 prior 旧 m3u8`);
        }
      }
    }
  }
  resultsAll.sort((a,b)=> (a.section||'').localeCompare(b.section||'') || String(a.id).localeCompare(String(b.id), undefined, {numeric:true}));

  const out = {
    source: SECTIONS.map(s=>s.url).join(' ; '),
    crawledAt: new Date().toISOString(),
    total: resultsAll.length,
    bySection: {},
    online: resultsAll.filter(r=>r.status==='online' && r.hasM3u8).length,
    items: resultsAll,
  };
  for (const r of resultsAll){
    // 按 r.section 归组; alsoLive 的热门条目额外计入 live(让监控栏统计也含它们)
    out.bySection[r.section] = out.bySection[r.section]||{ total:0, online:0 };
    out.bySection[r.section].total++;
    if (r.status==='online' && r.hasM3u8) out.bySection[r.section].online++;
    if (r.alsoLive){
      out.bySection.live = out.bySection.live||{ total:0, online:0 };
      out.bySection.live.total++;
      if (r.status==='online' && r.hasM3u8) out.bySection.live.online++;
    }
  }
  // 原子写: 防止写一半进程被杀导致 JSON 损坏(7×24 常驻关键)
  atomicWriteJSON(outPath, out);
  const hot = out.bySection['hot']||{online:0,total:0};
  const live = out.bySection['live']||{online:0,total:0};
  const rep = out.bySection['replay']||{online:0,total:0};
  console.log(`\n[crawl] 完成(${isSingle?'single':liveOnly?'live-only':includeReplay?'replay/full':'default'})：`);
  console.log(`  热门推荐 ${hot.online}/${hot.total} 在线`);
  console.log(`  实时监控 ${live.online}/${live.total} 在线`);
  console.log(`  精彩回放 ${rep.online}/${rep.total} (回放标记离线, m3u8 可用)`);
  console.log(`  合计 ${out.online}/${out.total}, 已写入 ${outPath}`);
  process.exit(0);
})().catch(e => { console.error('[crawl] 失败:', e); process.exit(1); });
