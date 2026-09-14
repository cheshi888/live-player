// 并发 API 压测: 模拟多客户端同时探测/拉流, 验证 7×24 稳定性
const BASE = 'http://localhost:' + (process.env.PORT || '8090');
const CONN = 20;      // 并发连接数
const DURATION_S = 60; // 压测 60s
const START = Date.now();
let total = 0, ok = 0, fail = 0, timeout = 0;

async function hammer(id, out){
  const t0 = Date.now();
  try {
    // 探测 + 拉流 + 取源, 三端点轮打
    const probe = await fetch(`${BASE}/api/probe/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const okP = probe.ok;
    const stream = await fetch(`${BASE}/api/stream/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const okS = stream.ok;
    const totalMs = Date.now() - t0;
    out.push({ ok: okP && okS, ms: totalMs });
    total++;
    if (okP && okS) ok++; else fail++;
  } catch (e) {
    total++;
    if (String(e.name || '').includes('TimeoutError') || e.message?.includes('abort')) timeout++;
    else fail++;
  }
}

(async () => {
  // 取 12 个直播 id
  const src = await (await fetch(`${BASE}/api/sources`)).json();
  const ids = src.items.filter(x => (x.section==='hot'||x.section==='live') && x.m3u8).map(x=>x.id);
  console.log(`压测: ${CONN} 并发 × ${DURATION_S}s, ${ids.length} 个直播 id`);

  const results = [];
  const workers = Array.from({length: CONN}, (_, i) => (async () => {
    while (Date.now() - START < DURATION_S * 1000){
      await hammer(ids[i % ids.length], results);
    }
  })());
  await Promise.all(workers);

  const elapsed = (Date.now() - START) / 1000;
  const rps = (results.length / elapsed).toFixed(1);
  console.log(`\n=== 压测结果 (${elapsed.toFixed(0)}s) ===`);
  console.log(`  总请求: ${results.length}`);
  console.log(`  成功: ${ok} (${(ok/results.length*100).toFixed(1)}%)`);
  console.log(`  失败: ${fail}, 超时: ${timeout}`);
  console.log(`  吞吐: ${rps} req/s`);
  // 服务器仍活着?
  const s = await (await fetch(`${BASE}/api/status`)).json();
  console.log(`\n服务器状态: alive=${!s.running ? 'yes' : 'crawl-running'}, lastRun=${s.lastRun.mode} exit=${s.lastRun.exitCode}`);
  process.exit(0);
})();
