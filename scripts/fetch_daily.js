// GitHub Actions 每日数据存档脚本（node 20，无依赖）
// 拉取板块K线（腾讯）→ 计算信号灯/生命周期 → 写 data/YYYY-MM-DD.json 与 data/latest.json
const fs = require('fs');
const path = require('path');

const SECTORS = [
 ['CXO','synth',['sh603259','sz300759','sh603127','sh688202']],
 ['安评','synth',['sh603127','sh688202','sh688710']],
 ['创新药','etf',['sz159992']],
 ['MLCC','synth',['sz300408','sz002138','sh603678']],
 ['工业金属','etf',['sh512400']],
 ['电网设备','etf',['sz159326']],
 ['电力','etf',['sh561560']],
 ['电池','etf',['sz159755']],
 ['先进封装','synth',['sh600584','sz002156','sh603005']],
 ['商业航天','etf',['sz159227']],
 ['机器人','etf',['sh562500']],
 ['光通信','etf',['sh515880']],
 ['证券','etf',['sh512880']],
 ['算力','etf',['sh516510']],
 ['半导体','etf',['sh512480']],
 ['保险','etf',['sh512070']],
 ['银行','etf',['sh512800']],
 ['传媒','etf',['sh512980']],
 ['农用机械','etf',['sz159825']],
 ['电子','etf',['sh515260']],
 ['消费电子','etf',['sz159732']],
 ['游戏','etf',['sz159869']],
 ['种业','etf',['sz159825']],
 ['猪肉','etf',['sh516670']],
 ['贵金属','etf',['sh517520']],
 ['有色','etf',['sh512400']],
 ['航空机场','synth',['sh601111','sh600009','sh600115']],
 ['医药','etf',['sh512010']],
 ['化纤','etf',['sz159870']],
 ['化工','etf',['sz159870']],
 ['造纸','synth',['sz002078','sh600567']],
 ['元器件','etf',['sh515260']],
 ['钢铁','etf',['sh515210']],
 ['CPO','etf',['sh515880']],
 ['液冷服务器','synth',['sz002837','sz300499','sz301018']],
 ['输变电设备','synth',['sh600089','sz002028','sh600406']],
 ['无人驾驶','etf',['sh516520']],
 ['固态电池','etf',['sz159755']],
 ['存储芯片','synth',['sh603986','sh688525','sz301308']],
 ['火力发电','etf',['sh561560']],
 ['电力设备','etf',['sz159611']],
 ['一般零售','synth',['sh601933','sh600655']],
 ['通信设备','etf',['sh515880']],
 ['软件服务','etf',['sh515230']],
 ['食品饮料','etf',['sh515170']],
 ['汽车','etf',['sh516110']],
 ['农林牧渔','etf',['sz159825']],
 ['AI智能体','etf',['sh515070']],
 ['酿酒','etf',['sh512690']],
 ['旅游','etf',['sh562510']],
 ['房地产','etf',['sh512200']],
 ['建筑','etf',['sh516950']],
 ['煤炭','etf',['sh515220']],
 ['家用电器','etf',['sz159996']],
 ['石油','etf',['sh561360']],
 ['6G','etf',['sh515880']],
];

const r1 = v => Math.round(v * 10) / 10;
function sma(a, n) { return a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null; }
function rsi14(cl) { if (cl.length < 15) return null; let g = 0, l = 0; for (let i = cl.length - 14; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; } return l === 0 ? 100 : g / (g + l) * 100; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchKline(symbol, bars = 250, tries = 3) {
  const param = `param=${symbol},day,,,${bars},qfq`;
  const urls = [
    `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?${param}`,
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?${param}`,
  ];
  for (let t = 0; t < tries; t++) {
    for (const u of urls) {
      try {
        const j = await fetch(u).then(r => r.json());
        const d = j && j.data && j.data[symbol];
        const a = d && (d.qfqday || d.day);
        if (a && a.length >= 60) return a.map(x => ({ d: x[0], c: +x[2] }));
      } catch (e) { /* next */ }
    }
    await sleep(1000);
  }
  return null;
}

const cache = {};
async function getK(sym) { if (!cache[sym]) cache[sym] = await fetchKline(sym); return cache[sym]; }
async function synthKline(codes) {
  const ks = (await Promise.all(codes.map(getK))).filter(Boolean);
  if (!ks.length) return null;
  const dateSet = {}; ks.forEach(k => k.forEach(x => dateSet[x.d] = 1));
  const dates = Object.keys(dateSet).sort();
  const maps = ks.map(k => { const m = {}; k.forEach(x => m[x.d] = x.c); return m; });
  const base = {};
  const out = [];
  dates.forEach(d => {
    let s = 0, n = 0;
    maps.forEach((m, ix) => { if (m[d] != null) { if (base[ix] == null) base[ix] = m[d]; s += m[d] / base[ix] * 100; n++; } });
    if (n) out.push({ d, c: s / n });
  });
  return out.length >= 60 ? out : null;
}

function metrics(cl, dates) {
  const i = cl.length - 1, price = cl[i];
  const ma10 = sma(cl, 10), ma20 = sma(cl, 20), ma60 = sma(cl, 60);
  const ma20p = sma(cl.slice(0, -1), 20);
  const lo = Math.min(...cl.slice(-60)), hi = Math.max(...cl.slice(-60));
  const pos60 = hi > lo ? (price - lo) / (hi - lo) * 100 : 50;
  const bias = (price / ma10 - 1) * 100;
  const rsi = rsi14(cl);
  const yr = dates[0].slice(0, 4) + '-01-01';
  const iY = dates.findIndex(d => d >= yr);
  const ytd = iY > 0 ? (price / cl[iY - 1] - 1) * 100 : null;
  const clY = cl.slice(Math.max(iY, 0));
  const peak = Math.max(...clY), dd = (price / peak - 1) * 100;
  const chg = i > 0 ? (cl[i] / cl[i - 1] - 1) * 100 : 0;
  let hot99 = 0;
  for (let k = Math.max(0, i - 4); k <= i; k++) {
    const l2 = Math.min(...cl.slice(Math.max(0, k - 59), k + 1)), h2 = Math.max(...cl.slice(Math.max(0, k - 59), k + 1));
    if (h2 > l2 && (cl[k] - l2) / (h2 - l2) * 100 >= 99) hot99++;
  }
  const red = rsi != null && rsi >= 85 && pos60 >= 95;
  const yellow = !red && hot99 >= 3 && bias < 0;
  const gWatch = pos60 <= 30 && rsi != null && rsi <= 35 && dd <= -25;
  const light = red ? 'red' : yellow ? 'yellow' : (gWatch ? 'green' : 'none');
  return { date: dates[i], price: r1(price * 100) / 100, ytd: ytd == null ? null : r1(ytd), dd: r1(dd), chg: r1(chg * 10) / 10, rsi: rsi == null ? null : r1(rsi), pos60: r1(pos60), bias: r1(bias * 10) / 10, ma20up: ma20 > ma20p, above20: price > ma20, above60: ma60 ? price > ma60 : null, light };
}

(async () => {
  const out = { ts: new Date().toISOString(), sectors: [], errors: [] };
  for (const [name, kind, codes] of SECTORS) {
    try {
      const kl = kind === 'etf' ? await getK(codes[0]) : await synthKline(codes);
      if (kl) out.sectors.push({ name, kind, ...metrics(kl.map(x => x.c), kl.map(x => x.d)) });
      else out.errors.push(name);
    } catch (e) { out.errors.push(name + ':' + e.message.slice(0, 40)); }
    await sleep(300);
  }
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, day + '.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(out));
  console.log('sectors:', out.sectors.length, 'errors:', out.errors.length, out.errors.join(','));
})();
