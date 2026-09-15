// 每日烘焙（GitHub Actions 运行）：拉取线上看板 → 解密提取同一份评分代码 → 全量计算 → 写 analysis_data.json
// 原则：与网页端同一套函数、同一份数据源（腾讯），只预算不编造；样本不足则放弃本次写入，绝不覆盖旧数据。
const fs = require('fs');
const { webcrypto } = require('crypto');
const vm = require('vm');

const SITE = 'https://123hjc123.github.io/nirvana-dashboard/';
const PASSWORD = '123';
const CONCURRENCY = 16;
const MIN_STOCKS = 400; // 评分成功数低于此值视为数据源异常，放弃写入

async function decryptSite() {
  const html = await (await fetch(SITE)).text();
  const m = html.match(/const PAYLOAD = (\{[\s\S]*?\});/);
  if (!m) throw new Error('未找到加密载荷');
  const P = JSON.parse(m[1]);
  const b64d = s => new Uint8Array(Buffer.from(s, 'base64'));
  const km = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(PASSWORD), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(P.s), iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(P.i) }, key, b64d(P.d)));
}

function makeCtx() {
  const ctx = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, createElement: () => ({ style: {}, remove() {}, click() {} }), head: { appendChild() {} }, addEventListener() {}, querySelectorAll: () => [] },
    window: {}, navigator: {}, location: { href: '' }, console,
    setTimeout, setInterval: () => 0, clearInterval: () => 0,
    fetch: (...a) => fetch(...a),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

(async () => {
  console.log('1/4 拉取并解密线上看板…');
  const src = await decryptSite();
  const blocks = src.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const big = blocks.map(x => x.replace(/<\/?script>/g, '')).sort((a, b) => b.length - a.length)[0];
  const ctx = makeCtx();
  vm.runInContext(big, ctx);
  vm.runInContext('analysisData={generated_at:null,stocks:[],indices:[],etfs:[]};', ctx);
  console.log('   解密成功，评分代码就绪');

  console.log('2/4 计算板块灯（70个板块，与网页同口径）…');
  const secDefs = vm.runInContext('stSECTORS', ctx);
  let secOk = 0;
  const secQueue = secDefs.slice();
  async function secWorker() {
    while (secQueue.length) {
      const [name, kind, codes] = secQueue.shift();
      try {
        const kl = kind === 'etf' ? await vm.runInContext(`stGetK('${codes[0]}')`, ctx) : await vm.runInContext(`stSynth(${JSON.stringify(codes)})`, ctx);
        if (kl && kl.length >= 60) {
          const m = vm.runInContext(`stMetrics(${JSON.stringify(kl.map(x => x.c))},${JSON.stringify(kl.map(x => x.d))})`, ctx);
          const adv = vm.runInContext(`stAdvice(${JSON.stringify(m)},false)`, ctx);
          vm.runInContext(`(window.stSectorLights=window.stSectorLights||{})['${name}']={light:${JSON.stringify(m.red ? 'red' : m.yellow ? 'yellow' : m.gWatch ? 'green' : 'none')},adv:${JSON.stringify(adv.a)}}`, ctx);
          secOk++;
        }
      } catch (e) {}
    }
  }
  await Promise.all(Array.from({ length: 6 }, secWorker));
  console.log(`   板块灯 ${secOk}/${secDefs.length}`);

  console.log('3/4 全量评分（指数+ETF+个股池）…');
  const tasks = vm.runInContext(`(()=>{const t=[];INDICES.forEach(x=>t.push({meta:x,kind:'indices'}));ETFS.forEach(x=>t.push({meta:x,kind:'etfs'}));getWatchlist().forEach(x=>t.push({meta:{name:x.name,code:x.code,prefix:x.prefix},kind:'stocks'}));return t;})()`, ctx);
  let done = 0; const failed = [];
  const queue = tasks.slice();
  async function worker() {
    while (queue.length) {
      const tk = queue.shift();
      const ok = await vm.runInContext(`computeOne(${JSON.stringify(tk.meta)},'${tk.kind}')`, ctx).catch(() => false);
      if (!ok) failed.push(tk);
      if (++done % 50 === 0) console.log(`   ${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // 失败补拉一轮
  for (const tk of failed.splice(0)) {
    const ok = await vm.runInContext(`computeOne(${JSON.stringify(tk.meta)},'${tk.kind}')`, ctx).catch(() => false);
    if (ok) done++;
  }
  console.log(`   完成，失败 ${failed.length} 只`);

  console.log('4/4 校验并写入 analysis_data.json …');
  const data = vm.runInContext('analysisData', ctx);
  // 瘦身：剥离渲染端不用的 K 线与指标中间量
  data.stocks.forEach(s => { delete s._kl; delete s._ind; });
  const scored = data.stocks.filter(s => s.score != null).length;
  console.log(`   个股 ${data.stocks.length} 只有评分 ${scored} · 指数 ${data.indices.length} · ETF ${data.etfs.length}`);
  if (scored < MIN_STOCKS) { console.error(`评分成功数 ${scored} < ${MIN_STOCKS}，数据源异常，放弃写入（保留旧文件）`); process.exit(1); }
  data.generated_at = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  fs.writeFileSync('analysis_data.json', JSON.stringify(data));
  console.log('   写入成功:', (fs.statSync('analysis_data.json').size / 1024).toFixed(0) + 'KB');
})().catch(e => { console.error('烘焙失败:', e.message); process.exit(1); });
