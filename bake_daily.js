// 每日烘焙 v2（GitHub Actions 运行）：拉取线上看板 → 解密提取同一份策略代码 → 全量计算 → 写 analysis_data.json
// 原则：与网页端同一套函数、同一份数据源，只预算不编造；样本不足则放弃本次写入，绝不覆盖旧数据。
// v2 新增：大盘状态机+缠论预案 / 板块雷达全字段（灯/生命周期/买点/回测/结论）/ 动量引擎Top5 /
//          情绪引擎（涨停池+六变量+打法）/ 个股评级与否决链（grade/veto/banner/_nv）/ 中长线个股行（slt）
// 跨日状态（情绪历史/行业表/涨停自动入池/小节点快照）持久化在 _bake_state.json，随仓库提交。
const fs = require('fs');
const { webcrypto } = require('crypto');
const vm = require('vm');

const SITE = 'https://123hjc123.github.io/nirvana-dashboard/';
const PASSWORD = '123';
const CONCURRENCY = 16;
const MIN_STOCKS = 400; // 评分成功数低于此值视为数据源异常，放弃写入
const STATE_FILE = '_bake_state.json';

// ---- 文件持久化的 localStorage（nirvana_history / stock_industry / stock_auto_lb / nirvana_xjd 跨日延续） ----
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};

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

// ---- 腾讯报价 Node fetch 版（替代浏览器 JSONP script；GBK 解码，批 60） ----
async function txQuotes(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 60) {
    const batch = codes.slice(i, i + 60);
    try {
      const buf = await (await fetch('https://qt.gtimg.cn/q=' + batch.join(','))).arrayBuffer();
      const txt = new TextDecoder('gbk').decode(buf);
      const re = /v_([A-Za-z0-9]+)="([^"]*)"/g; let mm;
      while ((mm = re.exec(txt))) {
        const d = mm[2].split('~');
        if (d.length >= 45) out[mm[1]] = {
          name: d[1], price: parseFloat(d[3]) || 0, pre_close: parseFloat(d[4]) || 0,
          open: parseFloat(d[5]) || 0, volume: parseFloat(d[36]) || 0, amount: parseFloat(d[37]) || 0,
          change_pct: parseFloat(d[32]) || 0, high: parseFloat(d[33]) || 0, low: parseFloat(d[34]) || 0,
          date: (d[30] || '').slice(0, 8),
        };
      }
    } catch (e) {}
    if (i + 60 < codes.length) await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

function makeCtx() {
  const ctx = {
    localStorage: {
      getItem: k => (k in state ? state[k] : null),
      setItem: (k, v) => { state[k] = String(v); },
      removeItem: k => { delete state[k]; },
    },
    document: { getElementById: () => null, createElement: () => ({ style: {}, remove() {}, click() {} }), head: { appendChild() {}, removeChild() {} }, addEventListener() {}, querySelectorAll: () => [] },
    window: {}, navigator: {}, location: { href: '' }, console,
    setTimeout, setInterval: () => 0, clearInterval: () => 0, clearTimeout,
    fetch: (...a) => fetch(...a),
    __txQuotes: txQuotes,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

(async () => {
  console.log('1/8 拉取并解密线上看板…');
  const src = await decryptSite();
  const blocks = src.match(/<script>([\s\S]*?)<\/script>/g) || [];
  const big = blocks.map(x => x.replace(/<\/?script>/g, '')).sort((a, b) => b.length - a.length)[0];
  const ctx = makeCtx();
  vm.runInContext(big, ctx);
  vm.runInContext('analysisData={generated_at:null,stocks:[],indices:[],etfs:[]};', ctx);
  // 浏览器 JSONP 报价 → Node fetch 报价（同一 qt.gtimg.cn 数据源）
  vm.runInContext(`loadTencentQuotes = function(codes, callback) { __txQuotes(codes).then(q => callback(q)).catch(() => callback({})); };`, ctx);
  console.log('   解密成功，策略代码就绪');

  // ---------- 2/8 大盘状态机 + 缠论预案 ----------
  console.log('2/8 大盘状态机 + 缠论结构…');
  const idxKl = await vm.runInContext(`stGetK('sh000001')`, ctx);
  if (!idxKl) throw new Error('上证指数K线获取失败，放弃本次烘焙');
  vm.runInContext(`window.stIdxKl = ${JSON.stringify(idxKl)}; window.stMarket = stMarketState(window.stIdxKl);`, ctx);
  await vm.runInContext(`stEnsureIdx300()`, ctx);
  await vm.runInContext(`stEnsureMktHist()`, ctx).catch(() => {});
  const chanIdx = [];
  for (const [sym, nm] of [['sh000001', '上证'], ['sz399006', '创业板'], ['sh000688', '科创50']]) {
    const k2 = sym === 'sh000001' ? idxKl : await vm.runInContext(`stGetK('${sym}')`, ctx);
    const ca = k2 ? vm.runInContext(`chanAnalyze(${JSON.stringify(k2)})`, ctx) : null;
    if (ca) chanIdx.push({ nm, sig: ca.sig || null, beichi: ca.beichi || null, zonePos: ca.zonePos || null, zg: ca.zone ? +ca.zone.zg.toFixed(0) : null, zd: ca.zone ? +ca.zone.zd.toFixed(0) : null });
  }
  const market = vm.runInContext('window.stMarket', ctx);
  market.chan = chanIdx;
  market.plan = chanIdx.length ? vm.runInContext(`stChanPlan(${JSON.stringify(chanIdx[0])})`, ctx) : '';
  console.log(`   ${market.label} ${market.grade}级 · 已持续${market.days}天 · 缠论${chanIdx.map(x => x.nm + (x.sig || x.zonePos || '-')).join('/')}`);

  // ---------- 3/8 板块雷达全量 ----------
  console.log('3/8 板块雷达（' + '70±个板块，灯/生命周期/买点/回测/结论，与网页同口径）…');
  const secDefs = vm.runInContext('stSECTORS', ctx);
  const secRows = []; const secLcK = {};
  {
    const queue = secDefs.slice();
    async function worker() {
      while (queue.length) {
        const [name, kind, codes, note] = queue.shift();
        try {
          const kl = kind === 'etf' ? await vm.runInContext(`stGetK('${codes[0]}')`, ctx) : await vm.runInContext(`stSynth(${JSON.stringify(codes)})`, ctx);
          if (kl && kl.length >= 60) {
            const row = vm.runInContext(`(() => {
              const kl = ${JSON.stringify(kl)};
              const rel = window.stIdxKl ? stRel(kl, window.stIdxKl) : null;
              const buySig = stBuySignal(kl);
              const chan = chanAnalyze(kl);
              return { name: ${JSON.stringify(name)}, kind: ${JSON.stringify(kind)}, note: ${JSON.stringify(note || null)}, kl,
                rel, buySig, relLabel: rel ? rel.label : null,
                chan: chan ? { sig: chan.sig || null, beichi: chan.beichi || null, zonePos: chan.zonePos || null } : null,
                ...stMetrics(kl.map(x => x.c), kl.map(x => x.d)) };
            })()`, ctx);
            secRows.push(row);
          } else secRows.push({ name, kind, note: note || null, fail: true });
        } catch (e) { secRows.push({ name, kind, note: note || null, fail: true }); }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
  }
  // top10 标记 + 灯缓存（computeOne/评级链依赖 window.stSectorLights）
  const ranked = secRows.filter(r => !r.fail).sort((a, b) => b.chg - a.chg);
  ranked.forEach((r, ix) => { r.top10 = ix < 10; });
  const lights = {};
  secRows.forEach(r => {
    if (r.fail) return;
    const calc = vm.runInContext(`(() => {
      const r = ${JSON.stringify({ ...r, kl: undefined })};
      const adv = stAdvice(r, ${r.top10}, r);
      const lc = stLifecycle(r);
      return { light: r.red ? 'red' : r.yellow ? 'yellow' : r.gWatch ? 'green' : 'none', adv: adv.a, lc: lc.t, lcK: lc.k,
        grade: stSectorGrade(r, adv, lc), rel: r.relLabel || null, advTxt: stDecisionTxt(r, adv, lc), concl: stConclusion(r) };
    })()`, ctx);
    lights[r.name] = { ...calc, ts: Date.now() };
    secLcK[r.name] = calc.lcK;
    Object.assign(r, calc);
    // 回合回测（只留统计+近12回合，控制体积）
    const bt = vm.runInContext(`stBacktest(${JSON.stringify(r.kl)})`, ctx);
    const dn = bt.filter(x => x.xd);
    r.bt = {
      stats: dn.length >= 5 ? { n: dn.length, win: Math.round(dn.filter(x => x.ret > 0).length / dn.length * 100), avg: +(dn.reduce((a, x) => a + x.ret, 0) / dn.length).toFixed(1), best: +Math.max(...dn.map(x => x.ret)).toFixed(1), worst: +Math.min(...dn.map(x => x.ret)).toFixed(1) } : { n: dn.length },
      holding: bt.length > dn.length,
      trades: bt.slice(-12).map(x => ({ di: x.di, sig: x.sig, xd: x.xd, ret: +x.ret.toFixed(1), rs: x.reason })),
    };
  });
  vm.runInContext(`window.stSectorLights = ${JSON.stringify(lights)};`, ctx);
  vm.runInContext(`window.__secLcK = ${JSON.stringify(secLcK)};`, ctx);
  // 动量引擎（同一 stMomentumData 函数）
  const momentum = vm.runInContext(`stMomentumData(${JSON.stringify(secRows)}, window.stIdxKl)`, ctx);
  console.log(`   板块 ${ranked.length}/${secDefs.length} 成功 · 动量引擎${momentum ? (momentum.above ? '进攻模式' : '防守模式') : '数据不足'}`);
  // 板块输出剥离 K 线
  const sectorsOut = secRows.map(r => { const { kl, ...rest } = r; return rest; });

  // ---------- 4/8 全量评分（指数+ETF+个股池） ----------
  console.log('4/8 全量评分（指数+ETF+个股池）…');
  const tasks = vm.runInContext(`(()=>{const t=[];INDICES.forEach(x=>t.push({meta:x,kind:'indices'}));ETFS.forEach(x=>t.push({meta:x,kind:'etfs'}));getWatchlist().forEach(x=>t.push({meta:{name:x.name,code:x.code,prefix:x.prefix},kind:'stocks'}));return t;})()`, ctx);
  let done = 0; const failed = [];
  const queue = tasks.slice();
  async function worker() {
    while (queue.length) {
      const tk = queue.shift();
      const ok = await vm.runInContext(`computeOne(${JSON.stringify(tk.meta)},'${tk.kind}')`, ctx).catch(() => false);
      if (!ok) failed.push(tk);
      if (++done % 100 === 0) console.log(`   ${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  for (const tk of failed.splice(0)) {
    const ok = await vm.runInContext(`computeOne(${JSON.stringify(tk.meta)},'${tk.kind}')`, ctx).catch(() => false);
    if (ok) done++;
  }
  console.log(`   完成，失败 ${failed.length} 只`);

  // ---------- 5/8 实时报价（供情绪溢价/个股判定用同一收盘口径） ----------
  console.log('5/8 腾讯实时报价（个股判定用）…');
  const wlCodes = vm.runInContext(`getWatchlist().map(s => s.prefix + s.code)`, ctx);
  const quotes = await txQuotes(wlCodes);
  vm.runInContext(`realtimeQuotes = ${JSON.stringify(quotes)};`, ctx);
  console.log(`   报价 ${Object.keys(quotes).length}/${wlCodes.length}`);

  // ---------- 6/8 情绪引擎（涨停池/六变量/打法/市场地位/买卖点判定，与网页同一 computeNirvana） ----------
  console.log('6/8 情绪引擎（东财涨停池+溢价+六变量+地位判定）…');
  await vm.runInContext(`computeNirvana()`, ctx).catch(e => console.warn('   情绪引擎降级：', e.message));
  const emotion = vm.runInContext(`(() => {
    const e = nirvanaData.emo; if (!e) return null;
    const d = nirvanaData.dash || null;
    const pool = (e.pools && e.pools.zt && e.pools.zt.pool) || [];
    const hy = {}; Object.entries(e.hyLadder || {}).forEach(([k, v]) => hy[k] = v.map(x => ({ n: x.n, c: x.c, lbc: x.lbc || 1 })));
    return { date: nirvanaData.poolsDate, isToday: nirvanaData.poolsIsToday,
      stage: e.stage, icon: e.icon, pos: e.pos, tactic: e.tactic, risks: e.risks, metrics: e.metrics, hyLadder: hy,
      dash: d ? { curSpec: d.curSpec, curMkt: d.curMkt, curBoard: d.curBoard, allSpec: d.allSpec, allMkt: d.allMkt, allBoard: d.allBoard, yaoJiQiang: d.yaoJiQiang, topHy: d.topHy, sum3: d.sum3, shChg: d.shChg, play: d.play, pos: d.pos, premium: d.premium || null } : null,
      ztPool: pool.map(x => ({ n: x.n, c: x.c, lbc: x.lbc || 1, zbc: x.zbc || 0, fund: x.fund || 0, hybk: x.hybk || '其他' })),
      history: loadHistory() };
  })()`, ctx);
  console.log(emotion ? `   ${emotion.icon}${emotion.stage} · 涨停${emotion.metrics.ztCount} 最高${emotion.metrics.maxLbc}板 炸板率${(emotion.metrics.blastRate * 100).toFixed(0)}% · 打法：${emotion.dash ? emotion.dash.play : '-'}` : '   ⚠️ 涨停池未获取（东财源异常），情绪层本次留空');

  // ---------- 7/8 个股评级链 + 中长线个股行 + 板块个股推荐 ----------
  console.log('7/8 个股评级（grade/veto/banner）+ 中长线个股行 + 板块个股推荐…');
  vm.runInContext(`analysisData.stocks.forEach(s => {
    if (s.score == null) return;
    try {
      s._veto = vetoOf(s);
      s._banner = buyBannerState(s, s._veto);
      s._grade = stockGrade(s, s._veto);
      s._sector = stPrimarySector(s.code);
    } catch (e) {}
  });`, ctx);
  vm.runInContext(`
  window.bakeSltOne = async function(code, name, g, core) {
    const r = { g: g || '未分班', core: !!core, name };
    try {
      let kl = null;
      const e = analysisData.stocks.find(x => x.code === code);
      if (e && e._kl && e._kl.length >= 30) kl = e._kl.map(k => ({ d: k.date, o: k.open, c: k.close, h: k.high, l: k.low }));
      else { const sym = (e ? e.prefix : (/^(6|9)/.test(code) ? 'sh' : (/^(4|8)/.test(code) ? 'bj' : 'sz'))) + code; kl = await stGetK(sym); }
      if (!kl || kl.length < 30) { r.fail = true; return r; }
      const dates = kl.map(x => x.d), cl = kl.map(x => x.c);
      const m = stMetrics(cl, dates);
      let buySig = kl.length >= 120 ? stBuySignal(kl) : null;
      const buySigRaw = buySig;
      const gEff = (typeof stSecOverride !== 'undefined' && stSecOverride[code]) || r.g;
      r.g = gEff;
      let secVeto = null;
      if (buySig && stSECTORS.find(d => d[0] === gEff)) {
        const lk = (window.__secLcK || {})[gEff];
        if (lk === 'decline' || lk === 'bottom') { secVeto = lk === 'decline' ? '📉 退潮' : '💀 磨底'; buySig = null; }
      }
      const adv = stAdvice(m, false, { buySig });
      const lc = stLifecycle(m);
      const bt = stBacktest(kl);
      const chan = kl.length >= 40 ? chanAnalyze(kl) : null;
      r.m = { price: m.price, chg: +m.chg.toFixed(2), pos60: +m.pos60.toFixed(1), rsi: m.rsi != null ? +m.rsi.toFixed(1) : null, ytd: m.ytd != null ? +m.ytd.toFixed(1) : null, dd: +m.dd.toFixed(1) };
      r.buySig = buySig; r.buySigRaw = buySigRaw; r.secVeto = secVeto;
      r.advA = adv.a; r.advC = adv.c; r.lcK = lc.k; r.lcT = lc.t;
      const dn = bt.filter(x => x.xd);
      r.btStats = dn.length >= 5 ? { n: dn.length, win: Math.round(dn.filter(x => x.ret > 0).length / dn.length * 100), avg: +(dn.reduce((a, x) => a + x.ret, 0) / dn.length).toFixed(1) } : { n: dn.length };
      r.btHold = bt.length > dn.length;
      r.trades = bt.slice(-10).map(x => ({ di: x.di, sig: x.sig, xd: x.xd, ret: +x.ret.toFixed(1), rs: x.reason }));
      r.chan = chan ? { sig: chan.sig || null, beichi: chan.beichi || null, zonePos: chan.zonePos || null } : null;
      r.shortHist = kl.length < 200;
    } catch (e2) { r.fail = true; }
    return r;
  };`, ctx);
  const sltList = vm.runInContext(`(() => {
    const core = [];
    ST_LT_GROUPS.forEach(([g, arr]) => arr.forEach(([sym, name]) => core.push({ code: sym.slice(2), name, g, core: true })));
    const coreCodes = new Set(core.map(x => x.code));
    const sync = getWatchlist().filter(s => !coreCodes.has(s.code) && !s._auto)
      .map(s => ({ code: s.code, name: s.name, g: stPrimarySector(s.code) || '未分班', core: false }));
    return core.concat(sync);
  })()`, ctx);
  const slt = {}; let sltDone = 0;
  {
    const q2 = sltList.slice();
    async function w2() {
      while (q2.length) {
        const it = q2.shift();
        const r = await vm.runInContext(`bakeSltOne(${JSON.stringify(it.code)},${JSON.stringify(it.name)},${JSON.stringify(it.g)},${it.core})`, ctx).catch(() => ({ fail: true, name: it.name, g: it.g, core: it.core }));
        slt[it.code] = r;
        if (++sltDone % 100 === 0) console.log(`   中长线个股 ${sltDone}/${sltList.length}`);
      }
    }
    await Promise.all(Array.from({ length: 8 }, w2));
  }
  // 板块 → 池内个股推荐（含评级）
  const subs = vm.runInContext(`(() => {
    const out = {};
    stSECTORS.forEach(([name]) => {
      const list = analysisData.stocks.filter(x => stSectorsOf(x.code).includes(name) && x.score != null)
        .sort((a, b) => b.score - a.score).slice(0, 8)
        .map(x => ({ code: x.code, name: x.name, score: x.score, grade: x._grade || null }));
      if (list.length) out[name] = list;
    });
    return out;
  })()`, ctx);
  sectorsOut.forEach(r => { if (!r.fail && subs[r.name]) r.subs = subs[r.name]; });
  console.log(`   中长线个股 ${Object.keys(slt).length} 只 · 板块推荐 ${Object.keys(subs).length} 个板块`);

  // ---------- 8/8 校验并写入 ----------
  console.log('8/8 校验并写入 analysis_data.json …');
  const data = vm.runInContext('analysisData', ctx);
  // 附带 K线包（Widget 端实时重算用）：近180根 收/高/低 + 末根开/日期 + 近10根量
  const KL_BARS = 180, KL_VOLS = 10;
  data.stocks.forEach(s => {
    if (s._kl && s._kl.length >= 30) {
      const kl = s._kl.slice(-KL_BARS);
      s.k = { d: kl[kl.length - 1].date, o: kl[kl.length - 1].open,
        c: kl.map(x => x.close), h: kl.map(x => x.high), l: kl.map(x => x.low),
        v: kl.slice(-KL_VOLS).map(x => x.vol) };
    }
    delete s._kl; delete s._ind;
  });
  const scored = data.stocks.filter(s => s.score != null).length;
  console.log(`   个股 ${data.stocks.length} 只有评分 ${scored} · 指数 ${data.indices.length} · ETF ${data.etfs.length}`);
  if (scored < MIN_STOCKS) { console.error(`评分成功数 ${scored} < ${MIN_STOCKS}，数据源异常，放弃写入（保留旧文件）`); process.exit(1); }
  data.generated_at = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  data.v = 2;
  data.market = market;
  data.momentum = momentum;
  data.emotion = emotion;
  data.sectors = sectorsOut;
  data.slt = slt;
  data.meta = vm.runInContext(`(() => { const p = stPARENT, order = stSECTORS.map(x => x[0]); const lt = {}; ST_LT_GROUPS.forEach(([g, arr]) => lt[g] = arr.map(x => x[0].slice(2))); return { parents: p, sectorOrder: order, ltGroups: lt }; })()`, ctx);
  fs.writeFileSync('analysis_data.json', JSON.stringify(data));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log('   写入成功:', (fs.statSync('analysis_data.json').size / 1024).toFixed(0) + 'KB · 状态文件', (fs.statSync(STATE_FILE).size / 1024).toFixed(0) + 'KB');
})().catch(e => { console.error('烘焙失败:', e.message); process.exit(1); });
