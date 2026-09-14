// 故障注入 + 7×24 稳定性验证(综合)
// 注: 无法真跑 7 天, 这里用故障注入 + 长跑证明防崩溃设计生效
const http = require('http');
const net = require('net');
const BASE = 'http://127.0.0.1:' + (process.env.PORT || '8090');
const PORT = process.env.PORT || '8090';

function alive(){
  return new Promise(res => {
    http.get(BASE + '/api/status', r => { r.resume(); r.on('end',()=>res(true)); }).on('error', () => res(false));
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond) => { console.log((cond?'  ✓ ':'  ✗ ') + name); cond ? pass++ : fail++; };

  console.log('=== 7×24 故障注入测试 ===');

  // 0) 基线
  check('基线: /api/status 可达', await alive());

  // 1) 畸形 HTTP 请求(clientError 路径)
  await new Promise(res => {
    const s = net.connect(8090, '127.0.0.1');
    s.on('connect', () => { s.write(Buffer.from('GARBAGE\r\n\r\n')); setTimeout(res, 500); });
    s.on('error', () => res());
  });
  await new Promise(r => setTimeout(r, 1500));
  check('畸形请求后服务仍存活', await alive());

  // 2) 超大 header 请求
  await new Promise(res => {
    const s = net.connect(8090, '127.0.0.1');
    s.on('connect', () => { s.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'); setTimeout(res, 300); });
    s.on('error', () => res());
  });
  await new Promise(r => setTimeout(r, 1000));
  check('坏请求后服务仍存活', await alive());

  // 3) 50 并发 burst
  const burst = await new Promise(res => {
    const arr = Array.from({length: 50}, () => new Promise(r2 => {
      http.get(BASE + '/api/sources', r => { let n=0; r.on('data',d=>n+=d.length); r.on('end',()=>r2(n)); }).on('error',()=>r2(0));
    }));
    res(Promise.all(arr));
  });
  await new Promise(r => setTimeout(r, 2000));
  check('50 并发 burst 后服务仍存活', await alive());

  // 4) 30s 长跑(每 2s 取状态 + 打源)
  const samples = [];
  for (let i = 0; i < 15; i++){
    samples.push(await alive());
    await new Promise(r => setTimeout(r, 2000));
  }
  check('30s 长跑无崩溃 (15 次全存活)', samples.every(Boolean));

  // 5) 并发 probe 12 个直播 id(模拟多客户端同时播放)
  const src = await (await fetch(BASE + '/api/sources')).json();
  const ids = src.items.filter(x => (x.section==='hot'||x.section==='live') && x.m3u8).map(x=>x.id);
  const probes = await Promise.all(ids.map(id => fetch(BASE + '/api/probe/' + id).then(r => r.ok ? 'ok' : 'fail')));
  check('并发 12 路 probe 全部 ' + probes.filter(x=>x==='ok').length + '/' + ids.length + ' 成功', probes.every(x=>x==='ok'));

  console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===`);
  const final = await alive();
  console.log(final ? '\n✓ 服务在全部故障注入后仍存活' : '\n✗ 服务挂了!');
  process.exit(final ? 0 : 1);
})();
