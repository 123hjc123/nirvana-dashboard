# -*- coding: utf-8 -*-
"""
双水位计月度更新（GitHub Actions，零Token，全公开数据源）
更新 gauge_data.json：追加最近一个完整月份的
  A = 住户存款月末(万亿) / 沪深A股总市值月末(万亿)
  C = 沪深300 PE(TTM) 月末
数据源与回退：
  总市值   : ① 上交所commonQuery + 深交所ShowReport（月末交易日） ② 东财push2快照(标注口径)
  沪深300PE: ① 中证指数官网OSS估值表  ② 失败→保持上月值并标注stale
  住户存款 : ① 央行《金融统计数据报告》住户存款月度增量累加(基线2026-09=175.30万亿,Wind口径)
             ② 失败→保持上月值并标注stale
任何单源失败都不会让脚本崩溃；状态写入 meta.update_status。
"""
import json, re, sys, time, io
from datetime import date, datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "gauge_data.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://www.csindex.com.cn/"}

def log(*a): print("[gauge]", *a, flush=True)

def prev_month(today=None):
    d = today or date.today()
    y, m = (d.year, d.month - 1) if d.month > 1 else (d.year - 1, 12)
    return f"{y:04d}-{m:02d}"

# ---------- 1) 沪深A股总市值（月末，万亿元） ----------
def mcap_from_exchanges(ym):
    """上交所每日概况 + 深交所市场概况，取该月最后一个交易日"""
    y, m = int(ym[:4]), int(ym[5:7])
    last_day = date(y + (m == 12), m % 12 + 1, 1).toordinal() - 1
    end = date.fromordinal(last_day).strftime("%Y-%m-%d")
    beg = f"{ym}-01"
    # 上交所：每日股票概况（总市值字段 TOTAL_VALUE，单位亿元）
    r = requests.get("https://query.sse.com.cn/commonQuery.do", params={
        "sqlId": "COMMON_SSE_SJ_GPSJ_CJGK_MRGP_L", "beginDate": beg, "endDate": end,
        "pageHelp.pageSize": "40", "pageHelp.pageNo": "1", "pageHelp.cacheSize": "1"},
        headers={**UA, "Referer": "https://www.sse.com.cn/"}, timeout=20)
    r.raise_for_status()
    rows = r.json().get("pageHelp", {}).get("data", [])
    sh = None
    for row in rows:  # 取月末最后一条 A股总市值（含主板+科创板，按TRADE_DATE升序）
        sh = row  # 数据通常升序，最后一条即月末
    if sh is None:
        raise ValueError("SSE empty")
    sh_val = None
    for k in ("TOTAL_VALUE", "totalValue", "TOTAL_VALUE_A"):
        if k in sh:
            sh_val = float(str(sh[k]).replace(",", ""))
            break
    if sh_val is None:
        # 兼容字段：LISTED_A_VALUE 等
        for k, v in sh.items():
            if "VALUE" in k.upper():
                try: sh_val = float(str(v).replace(",", "")); break
                except Exception: pass
    if sh_val is None:
        raise ValueError("SSE field not found: " + ",".join(sh.keys()))
    # 深交所：市场总貌（月度），CATALOGID=1803
    r2 = requests.get("https://www.szse.cn/api/report/ShowReport", params={
        "SHOWTYPE": "JSON", "CATALOGID": "1803", "TABKEY": "tab1",
        "txtQueryDate": end, "random": str(time.time())},
        headers={**UA, "Referer": "https://www.szse.cn/market/overview/index.html"}, timeout=20)
    r2.raise_for_status()
    j2 = r2.json()
    sz_val = None
    for tab in (j2 if isinstance(j2, list) else [j2]):
        for row in (tab.get("data") or []):
            txt = json.dumps(row, ensure_ascii=False)
            if "总市值" in txt:
                for k, v in row.items():
                    if "总市值" in str(row.get("mc", "")) or "zsz" in k.lower():
                        try: sz_val = float(str(v).replace(",", "")); break
                        except Exception: pass
    if sz_val is None:
        raise ValueError("SZSE parse failed")
    return (sh_val + sz_val) / 10000.0  # 亿元→万亿元（深所单位若为亿元）

def mcap_from_eastmoney():
    """回退：东财全市场快照（运行日口径，非月末，会标注）"""
    total = 0.0
    fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
    for pn in range(1, 9):
        r = requests.get("https://push2.eastmoney.com/api/qt/clist/get", params={
            "pn": pn, "pz": 1000, "po": 1, "np": 1, "fltt": 2, "invt": 2,
            "fid": "f3", "fs": fs, "fields": "f12,f20"}, headers=UA, timeout=20)
        r.raise_for_status()
        d = (r.json().get("data") or {})
        diff = d.get("diff") or []
        for it in diff:
            v = it.get("f20")
            if isinstance(v, (int, float)):
                total += v
        if len(diff) < 1000:
            break
    if total <= 0:
        raise ValueError("EM empty")
    return total / 1e12  # 元→万亿元

# ---------- 2) 沪深300 PE(TTM) 月末 ----------
def hs300_pe(ym):
    url = "https://csi-web-dev.oss-cn-shanghai-finance-1-pub.aliyuncs.com/static/html/csindex/public/uploads/file/autofile/indicator/000300indicator.xls"
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    import pandas as pd
    df = pd.read_excel(io.BytesIO(r.content))
    df.columns = [str(c).strip() for c in df.columns]
    dcol = [c for c in df.columns if "日期" in c or "Date" in c][0]
    pcol = [c for c in df.columns if "滚动市盈" in c or "PE2" in c.upper() or "PE-TTM" in c.upper() or "PE_TTM" in c.upper()]
    if not pcol:
        pcol = [c for c in df.columns if "PE" in c.upper() or "市盈" in c]
    df[dcol] = pd.to_datetime(df[dcol])
    sub = df[df[dcol].dt.strftime("%Y-%m") == ym]
    if sub.empty:
        raise ValueError("no rows for " + ym)
    return float(sub.iloc[-1][pcol[0]])

# ---------- 3) 住户存款月末（万亿元，基线累加法） ----------
BASELINE = {"month": "2026-09", "dep_wy": 175.30}  # Wind: M0001613 = 175.30万亿 @2026-09
def dep_increment(ym):
    """央行《XXXX年X月金融统计数据报告》中住户存款月度增量(亿元)，正=增加"""
    y = ym[:4]
    mname = str(int(ym[5:7]))
    lst = requests.get("http://www.pbc.gov.cn/diaochatongjisi/116219/116225/11871/index.html",
                       headers=UA, timeout=20)
    lst.raise_for_status()
    lst.encoding = lst.apparent_encoding or "utf-8"
    links = re.findall(r'href="([^"]+)"[^>]*>([^<]*' + y + r'年' + mname + r'月金融统计数据报告[^<]*)<', lst.text)
    if not links:
        raise ValueError("PBOC list: report not found for " + ym)
    href = links[0][0]
    if href.startswith("./"):
        href = "http://www.pbc.gov.cn/diaochatongjisi/116219/116225/11871/" + href[2:]
    elif href.startswith("/"):
        href = "http://www.pbc.gov.cn" + href
    art = requests.get(href, headers=UA, timeout=20)
    art.raise_for_status()
    art.encoding = art.apparent_encoding or "utf-8"
    txt = re.sub(r"<[^>]+>", "", art.text)
    txt = txt.replace("\u3000", "").replace(" ", "").replace(",", "")
    m = re.search(r"住户存款(增加|减少)([\d.]+)(万亿|亿)元", txt)
    if not m:
        raise ValueError("PBOC article: pattern not found")
    val = float(m.group(2)) * (10000 if m.group(3) == "万亿" else 1)
    return val if m.group(1) == "增加" else -val  # 亿元

# ---------- 主流程 ----------
def main():
    g = json.loads(DATA.read_text(encoding="utf-8"))
    target = prev_month()
    if g["months"][-1] >= target:
        log("已是最新:", g["months"][-1], ">=", target)
        return
    status = {"month": target, "run_at": datetime.utcnow().isoformat() + "Z",
              "mcap": None, "pe": None, "dep": None, "notes": []}

    # 总市值
    mcap = None
    try:
        mcap = mcap_from_exchanges(target); status["mcap"] = "交易所月度数据(月末)"
    except Exception as e:
        log("交易所口径失败:", e)
        try:
            mcap = mcap_from_eastmoney(); status["mcap"] = "东财快照(运行日,非月末)"
            status["notes"].append("总市值为运行日快照而非月末值")
        except Exception as e2:
            log("东财口径也失败:", e2)
    # PE
    pe = None
    try:
        pe = hs300_pe(target); status["pe"] = "中证指数官网"
    except Exception as e:
        log("PE获取失败:", e)
        pe = g["pe"][-1]; status["pe"] = "stale:沿用上月"
        status["notes"].append("沪深300PE沿用上月")
    # 住户存款：基线累加
    dep = None
    try:
        base_m, base_v = BASELINE["month"], BASELINE["dep_wy"]
        if g["months"][-1] > base_m:
            base_v = g["dep_wy"][-1]; base_m = g["months"][-1]
        if base_m >= target:
            dep = g["dep_wy"][-1]
            status["dep"] = "已存在"
        else:
            # 逐月累加 base_m+1 .. target
            cur = base_m
            while cur < target:
                y, m = int(cur[:4]), int(cur[5:7])
                m += 1
                if m > 12: y, m = y + 1, 1
                cur = f"{y:04d}-{m:02d}"
                inc = dep_increment(cur)  # 亿元
                base_v += inc / 10000.0
                time.sleep(1)
            dep = round(base_v, 2); status["dep"] = "央行报告增量累加(基线" + BASELINE["month"] + ")"
    except Exception as e:
        log("存款获取失败:", e)
        dep = g["dep_wy"][-1]; status["dep"] = "stale:沿用上月"
        status["notes"].append("住户存款沿用上月")

    if mcap is None:
        log("总市值两路均失败，本月不追加，避免污染序列")
        g.setdefault("meta", {})["update_status"] = status
        DATA.write_text(json.dumps(g, ensure_ascii=False), encoding="utf-8")
        sys.exit(1)

    a = round(dep / mcap, 4)
    g["months"].append(target)
    g["a_ratio"].append(a)
    g["pe"].append(round(pe, 2))
    g["dep_wy"].append(round(dep, 2))
    g["mcap_wy"].append(round(mcap, 2))
    g["meta"]["updated"] = target + "(月末)"
    g["meta"]["update_status"] = status
    DATA.write_text(json.dumps(g, ensure_ascii=False), encoding="utf-8")
    log("追加", target, "dep=", dep, "mcap=", round(mcap, 2), "A=", a, "PE=", pe, "|", status)

if __name__ == "__main__":
    main()
