// 验证回放单条快速自愈 + 诊断端点
(async () => {
  const base = 'http://localhost:8090';
  const src = await (await fetch(base + '/api/sources')).json();
  const replay = src.items.find(x => x.section==='replay' && x.m3u8);
  const live = src.items.find(x => (x.section==='hot'||x.section==='live') && x.m3u8);
  console.log('回放 id:', replay?.id, '| 直播 id:', live?.id);

  // 1) 诊断端点
  const dr = await (await fetch(base + '/api/diag/' + replay.id)).json();
  console.log('\n[回放诊断]', JSON.stringify({
    m3u8Reachable: dr.m3u8Reachable, m3u8Status: dr.m3u8Status,
    keyReachable: dr.keyReachable, keyStatus: dr.keyStatus,
    segReachable: dr.segReachable, authAgeSec: dr.authAgeSec,
    crawlAgeSec: dr.crawlAgeSec,
  }));

  const dl = await (await fetch(base + '/api/diag/' + live.id)).json();
  console.log('[直播诊断]', JSON.stringify({
    m3u8Reachable: dl.m3u8Reachable, m3u8Status: dl.m3u8Status,
    keyReachable: dl.keyReachable, segReachable: dl.segReachable,
  }));

  // 2) 单条自愈: 触发回放单条重抓(秒级)
  const t0 = Date.now();
  const rr = await (await fetch(base + '/api/refresh?id=' + replay.id, { method: 'POST' })).json();
  console.log('\n[单条自愈 POST /api/refresh?id=回放]', JSON.stringify(rr), '耗时 ' + ((Date.now()-t0)/1000).toFixed(1) + 's');

  // 3) 等爬完再探一次
  await new Promise(r => setTimeout(r, 3000));
  const probe = await (await fetch(base + '/api/probe/' + replay.id)).json();
  console.log('[回放 probe 自愈后]', probe.ok ? '✓ 可播 ' + probe.fullCount + ' 片' : '✗ ' + probe.message);

  process.exit(0);
})();
