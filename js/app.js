/* K线竞技场 — app flow */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const MODE_LABEL = {
    classic: "经典赛",
    sprint: "闪电赛",
    speed: "限时竞速",
    marathon: "马拉松",
  };

  const REGIME_LABEL = {
    random: "随机行情",
    bull: "牛市",
    bear: "熊市",
    side: "震荡市",
  };

  const REGIME_DESC = {
    random: "从标的池中随机截取一段历史区间，不限涨跌节奏。",
    bull: "只匹配区间明显上行的窗口，练习持股待涨与止盈。",
    bear: "只匹配区间明显下行的窗口，练习止损、空仓与抢反弹。",
    side: "只匹配涨跌有限、来回拉锯的窗口，练习高抛低吸做差价。",
  };

  const state = {
    stocks: [],
    index: [],
    indexName: "样本等权指数",
    poolInfo: null,
    regimeCounts: null,
    blind: true, // 对局中始终隐藏标的名，结束后揭晓
    mode: "classic",
    days: 40,
    capital: 100000,
    rule: "t0",
    regime: "random",
    indicator: "ma", // 'ma' | 'boll'
    cross: null, // {x,y} mouse on kline
    // game
    engine: null,
    bars: [],
    startIdx: 0,
    cursor: 0, // index into bars of "today" (revealed)
    endIdx: 0,
    snapshots: [],
    speedTimer: null,
    speedDeadline: 0,
    speedDuration: 8000,
    running: false,
    finished: false, // 对局结束 → 回看模式
    lastResult: null,
  };

  // ---------- boot ----------
  async function boot() {
    try {
      const res = await fetch("data/stocks.json");
      const data = await res.json();
      state.stocks = data.stocks || [];
      state.index = data.index || [];
      state.indexName = data.index_name || "样本等权指数";
      state.poolInfo = data.pool_info || null;
      state.regimeCounts = data.regime_counts_40d || null;
      renderPoolInfo();
      renderRegimeDesc();
    } catch (err) {
      const pool = $("#pool-info");
      if (pool) {
        pool.innerHTML =
          '<div class="board-empty">数据加载失败，请用本地服务器打开（python3 -m http.server）</div>';
      }
      console.error(err);
    }
    bindSetup();
    bindGame();
    bindModals();
  }

  // ---------- setup UI ----------
  function renderPoolInfo() {
    const box = $("#pool-info");
    const stats = $("#regime-stats");
    if (!box) return;
    if (!state.stocks.length) {
      box.textContent = "标的池为空";
      return;
    }
    const info = state.poolInfo || {};
    const dMin = info.date_min || state.stocks[0].start;
    const dMax = info.date_max || state.stocks[0].end;
    const barsMin = Math.min(...state.stocks.map((s) => s.bars.length));
    const barsMax = Math.max(...state.stocks.map((s) => s.bars.length));
    box.innerHTML = `
      <div class="pool-line"><span>数量</span><strong>${state.stocks.length} 只热门标的</strong></div>
      <div class="pool-line"><span>区间</span><strong>${dMin} → ${dMax}</strong></div>
      <div class="pool-line"><span>K线</span><strong>约 ${barsMin}–${barsMax} 根 / 股</strong></div>
      <div class="pool-line"><span>指数</span><strong>${state.indexName}</strong></div>
    `;
    if (stats && state.regimeCounts) {
      const c = state.regimeCounts;
      const total = (c.bull || 0) + (c.bear || 0) + (c.side || 0);
      stats.innerHTML = `
        <span class="regime-pill bull">牛市窗口 ${c.bull || 0}</span>
        <span class="regime-pill bear">熊市 ${c.bear || 0}</span>
        <span class="regime-pill side">震荡 ${c.side || 0}</span>
        <span class="muted">共约 ${total} 个可截取窗口</span>
      `;
    }
  }

  function renderRegimeDesc() {
    const el = $("#regime-desc");
    if (el) el.textContent = REGIME_DESC[state.regime] || REGIME_DESC.random;
  }

  function bindChipGroup(groupId, onPick) {
    const box = $(groupId);
    box.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      $$(".chip", box).forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      onPick(chip);
    });
  }

  function bindSetup() {
    $("#mode-list").addEventListener("click", (e) => {
      const card = e.target.closest(".mode-card");
      if (!card) return;
      $$(".mode-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      state.mode = card.dataset.mode;
      state.days = parseInt(card.dataset.days, 10);
    });

    bindChipGroup("#capital-group", (chip) => {
      state.capital = parseInt(chip.dataset.value, 10);
    });
    bindChipGroup("#rule-group", (chip) => {
      state.rule = chip.dataset.value;
    });
    bindChipGroup("#regime-group", (chip) => {
      state.regime = chip.dataset.value;
      renderRegimeDesc();
    });

    $("#btn-start").addEventListener("click", () => startGame());
    const seedStart = $("#btn-seed-start");
    if (seedStart) {
      seedStart.addEventListener("click", () => {
        const raw = $("#seed-input") && $("#seed-input").value;
        if (!raw || !String(raw).trim()) {
          alert("请先粘贴挑战种子");
          return;
        }
        startGame(raw);
      });
    }
    const seedInput = $("#seed-input");
    if (seedInput) {
      seedInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (seedStart) seedStart.click();
        }
      });
    }
    $("#btn-howto").addEventListener("click", () => openModal("modal-howto"));
    $("#btn-board").addEventListener("click", () => {
      renderBoard();
      openModal("modal-board");
    });
  }

  // ---------- window / regime ----------
  function classifyWindow(bars, startIdx, days) {
    const j = Math.min(startIdx + days - 1, bars.length - 1);
    if (j <= startIdx) return "side";
    const r = (bars[j].c / bars[startIdx].c - 1) * 100;
    const thr = 6 + 0.12 * days;
    if (r >= thr) return "bull";
    if (r <= -thr) return "bear";
    return "side";
  }

  function pickChallengeWindow(stock, totalDays, regime, warmup) {
    const bars = stock.bars;
    const minStart = warmup;
    const maxStart = bars.length - totalDays - 1;
    if (maxStart < minStart) return null;

    const candidates = [];
    const step = Math.max(1, Math.floor((maxStart - minStart + 1) / 24));
    for (let i = minStart; i <= maxStart; i += step) {
      candidates.push(i);
    }
    if (!candidates.includes(maxStart)) candidates.push(maxStart);
    if (!candidates.includes(minStart)) candidates.unshift(minStart);

    if (regime !== "random") {
      const matched = candidates.filter(
        (i) => classifyWindow(bars, i, totalDays) === regime
      );
      if (matched.length) {
        return matched[Math.floor(Math.random() * matched.length)];
      }
      return null;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  function resolveGameWindow(totalDays, warmup) {
    const regime = state.regime;
    const attempts = 80;
    const pool = state.stocks.slice();
    // shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    let fallback = null;
    for (let a = 0; a < attempts; a++) {
      const stock = pool[a % pool.length];
      const days = Math.min(totalDays, stock.bars.length - warmup - 2);
      if (days < 5) continue;
      const startIdx = pickChallengeWindow(stock, days, regime, warmup);
      if (startIdx == null) continue;
      const label = classifyWindow(stock.bars, startIdx, days);
      const found = { stock, startIdx, days, label };
      if (regime === "random" || label === regime) return found;
      if (!fallback) fallback = found;
    }
    return fallback;
  }

  // ---------- share seed ----------
  // K2~<base64url> carries an obfuscated payload so the stock code is not
  // readable from the token itself (old K1~CODE~START~DAYS still accepted).
  const SEED_KEY = "kline-arena-2026";

  function seedXor(text) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      out += String.fromCharCode(
        text.charCodeAt(i) ^ SEED_KEY.charCodeAt(i % SEED_KEY.length)
      );
    }
    return out;
  }

  function encodeSeed(code, startIdx, days) {
    const text = `${code}|${startIdx}|${days}`;
    const b64 = btoa(seedXor(text))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return `K2~${b64}`;
  }

  function parseSeed(raw) {
    if (!raw) return null;
    const s = String(raw).trim();

    // legacy plaintext
    const legacy = s.match(/^K1~(.+?)~(\d+)~(\d+)$/i);
    if (legacy) {
      return {
        code: legacy[1],
        startIdx: parseInt(legacy[2], 10),
        days: parseInt(legacy[3], 10),
      };
    }

    const m = s.match(/^K2~([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    try {
      let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const text = seedXor(atob(b64));
      const parts = text.split("|");
      if (parts.length !== 3) return null;
      const startIdx = parseInt(parts[1], 10);
      const days = parseInt(parts[2], 10);
      if (!parts[0] || !Number.isFinite(startIdx) || !Number.isFinite(days)) return null;
      return { code: parts[0], startIdx, days };
    } catch {
      return null;
    }
  }

  function resolveFromSeed(seed) {
    const warmup = 25;
    const stock = state.stocks.find((s) => s.code === seed.code);
    if (!stock) return { error: `标的池里没有 ${seed.code}，请用同一份数据开局` };
    const bars = stock.bars;
    const { startIdx, days } = seed;
    if (days < 5) return { error: "种子天数无效" };
    if (startIdx < warmup) return { error: "种子起点太靠前，历史数据不足" };
    if (startIdx + days > bars.length) return { error: "种子区间超出该标的数据范围" };
    const label = classifyWindow(bars, startIdx, days);
    return { stock, startIdx, days, label };
  }

  function copyText(text, okMsg) {
    const done = () => renderHint(okMsg || "已复制", "ok");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      prompt("手动复制种子：", text);
    }
    document.body.removeChild(ta);
  }

  // ---------- game ----------
  function startGame(fromSeed) {
    const warmup = 25;
    let hit = null;

    if (fromSeed) {
      const parsed = parseSeed(fromSeed);
      if (!parsed) {
        alert("种子格式不正确，请粘贴对方分享的挑战种子");
        return;
      }
      const resolved = resolveFromSeed(parsed);
      if (resolved.error) {
        alert(resolved.error);
        return;
      }
      hit = resolved;
    } else {
      hit = resolveGameWindow(state.days, warmup);
      if (!hit) {
        alert("未能匹配到合适的行情区间，试试换成「随机」或其他行情环境");
        return;
      }
    }

    const stock = hit.stock;
    state.activeCode = stock.code;

    const bars = stock.bars;
    const startIdx = hit.startIdx;
    const days = hit.days;
    const revealFrom = Math.max(0, startIdx - warmup);
    state.bars = bars.slice(revealFrom, startIdx + days);
    state.startIdx = warmup;
    state.cursor = state.startIdx;
    state.endIdx = state.bars.length - 1;

    state.engine = new TradeEngine({
      initialCash: state.capital,
      rule: state.rule,
    });
    state.snapshots = [];
    state.running = true;
    state.finished = false;
    state.lastResult = null;
    state.cross = null;
    state.windowRegime = hit.label;
    state.challengeSeed = encodeSeed(stock.code, startIdx, days);
    // keep days in state so result text matches the actual window
    state.days = days;

    // 对局中始终隐藏标的，只在结算/揭晓时显示
    $("#g-stock-name").textContent = "神秘标的";
    $("#g-stock-code").textContent = "结束后揭晓";
    $("#g-day-total").textContent = String(days);
    const seedEl = $("#g-seed");
    if (seedEl) seedEl.textContent = state.challengeSeed;

    // review banner / trade controls
    setReviewMode(false);

    showScreen("screen-game");

    const isSpeed = state.mode === "speed";
    $("#g-timer").classList.toggle("hidden", !isSpeed);
    $("#btn-back").classList.toggle("hidden", isSpeed);

    renderGame();
    if (isSpeed) startSpeedClock();
    renderHint("可点顶部「种子」复制，分享给朋友同场对比", "ok");
  }

  function currentBar() {
    return state.bars[state.cursor];
  }

  function visibleBars() {
    // review: show the whole session; live: sliding window with context
    if (state.finished) {
      return state.bars.slice(Math.max(0, state.startIdx - 30), state.endIdx + 1);
    }
    const from = Math.max(0, state.cursor - 79);
    return state.bars.slice(from, state.cursor + 1);
  }

  function challengeDayNumber() {
    return state.cursor - state.startIdx + 1;
  }

  function renderGame() {
    const bar = currentBar();
    if (!bar) return;
    const prev =
      state.cursor > state.startIdx
        ? state.bars[state.cursor - 1]
        : state.bars[state.startIdx - 1] || bar;

    $("#g-day").textContent = String(challengeDayNumber());
    const dateEl = $("#g-date");
    const regimeTag = state.windowRegime
      ? ` · ${REGIME_LABEL[state.windowRegime] || state.windowRegime}`
      : "";
    dateEl.textContent = bar.d + regimeTag;
    $("#t-price").textContent = bar.c.toFixed(2);

    const chg = ((bar.c - prev.c) / prev.c) * 100;
    const chgEl = $("#t-change");
    chgEl.textContent = `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
    chgEl.classList.toggle("up", chg >= 0);
    chgEl.classList.toggle("down", chg < 0);

    const eng = state.engine;
    const equity = eng.equity(bar.c);
    const pnlPct = ((equity - eng.initialCash) / eng.initialCash) * 100;
    $("#g-equity").textContent = fmtMoney(equity);
    const pnlEl = $("#g-pnl");
    pnlEl.textContent = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
    pnlEl.classList.toggle("up", pnlPct >= 0);
    pnlEl.classList.toggle("down", pnlPct < 0);

    // position
    const shares = eng.shares;
    const mv = shares * bar.c;
    const posPct = equity > 0 ? Math.min(100, (mv / equity) * 100) : 0;
    $("#pos-fill").style.width = posPct.toFixed(1) + "%";
    $("#pos-text").textContent =
      shares === 0
        ? "空仓 0%"
        : `仓位 ${posPct.toFixed(0)}% · ${shares} 股 · 均价 ${eng.avgCost.toFixed(2)}`;

    // account panel
    $("#a-cash").textContent = fmtMoney(eng.cash);
    $("#a-shares").textContent = `${shares} 股`;
    $("#a-cost").textContent = shares ? eng.avgCost.toFixed(2) : "—";
    $("#a-mv").textContent = fmtMoney(mv);
    const fp = eng.floatPnl(bar.c);
    const fpEl = $("#a-float");
    fpEl.textContent = shares ? `${fp >= 0 ? "+" : ""}${fmtMoney(fp)}` : "—";
    fpEl.classList.toggle("up", fp > 0);
    fpEl.classList.toggle("down", fp < 0);
    const reEl = $("#a-realized");
    reEl.textContent = `${eng.realized >= 0 ? "+" : ""}${fmtMoney(eng.realized)}`;
    reEl.classList.toggle("up", eng.realized > 0);
    reEl.classList.toggle("down", eng.realized < 0);
    $("#a-day-trades").textContent = `${eng.dayTrades} 次`;

    // charts
    const barsVis = visibleBars();
    // trades that fall inside the visible window (by date)
    const visDates = new Set(barsVis.map((b) => b.d));
    const tradesVis = eng.trades.filter((t) => visDates.has(t.day));
    KChart.drawKline($("#chart"), barsVis, {
      showMA: state.indicator === "ma",
      showBOLL: state.indicator === "boll",
      trades: tradesVis,
      cross: state.cross,
    });
    // live equity series: keep daily marks but pin the last point to current MTM
    const eqSeries = eng.equityCurve.slice();
    const curEq = eng.equity(bar.c);
    if (eqSeries.length < 2) eqSeries.push(curEq);
    else eqSeries[eqSeries.length - 1] = curEq;
    KChart.drawEquity($("#equity-chart"), eqSeries, eng.initialCash);
    renderIndexStrip(barsVis);
    updateIndLegend(barsVis);

    renderLog();
    renderHint();
  }

  function renderIndexStrip(barsVis) {
    const elName = $("#index-name");
    if (elName) elName.textContent = state.indexName;
    if (!state.index.length) return;

    // map date → index close
    const idxMap = new Map(state.index.map((x) => [x.d, x.c]));
    const series = [];
    const dates = [];
    for (const b of barsVis) {
      const v = idxMap.get(b.d);
      if (v != null) {
        series.push(v);
        dates.push(b.d);
      }
    }
    KChart.drawLineStrip($("#index-chart"), series, {
      height: 56,
      label: state.indexName,
      color: KChart.COLORS.idx,
      fill: KChart.COLORS.idxFill,
    });

    if (series.length >= 1) {
      const last = series[series.length - 1];
      const prev = series.length >= 2 ? series[series.length - 2] : last;
      const chg = ((last - prev) / prev) * 100;
      $("#index-val").textContent = last.toFixed(2);
      const chgEl = $("#index-chg");
      chgEl.textContent = `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`;
      chgEl.classList.toggle("up", chg >= 0);
      chgEl.classList.toggle("down", chg < 0);
    }

    // window change from first visible index point
    const startBar = state.bars[state.startIdx];
    const endBar = currentBar();
    if (startBar && endBar && series.length) {
      const s = idxMap.get(startBar.d);
      const e = idxMap.get(endBar.d);
      if (s != null && e != null) {
        const win = ((e - s) / s) * 100;
        $("#index-win-chg").textContent = `${win >= 0 ? "+" : ""}${win.toFixed(2)}%`;
      }
    }
  }

  function indexReturnOverWindow() {
    const startBar = state.bars[state.startIdx];
    const endBar = currentBar();
    if (!startBar || !endBar || !state.index.length) return null;
    const idxMap = new Map(state.index.map((x) => [x.d, x.c]));
    const s = idxMap.get(startBar.d);
    const e = idxMap.get(endBar.d);
    if (s == null || e == null) return null;
    return ((e - s) / s) * 100;
  }

  /** Buy-and-hold return of the traded stock over the challenge window */
  function stockReturnOverWindow() {
    const startBar = state.bars[state.startIdx];
    const endBar = state.bars[state.endIdx];
    if (!startBar || !endBar || !startBar.c) return null;
    return ((endBar.c / startBar.c) - 1) * 100;
  }

  function updateIndLegend(barsVis) {
    if (!barsVis || !barsVis.length) return;
    // Prefer the crosshair bar; otherwise the latest visible bar.
    let idx = barsVis.length - 1;
    if (state.cross) {
      const chartEl = $("#chart");
      const k = chartEl && chartEl.__kchart;
      const padL = (k && k.padL) || 56;
      const slot = (k && k.slot) || 0;
      if (slot > 0 && state.cross.x != null) {
        idx = Math.min(barsVis.length - 1, Math.max(0, Math.floor((state.cross.x - padL) / slot)));
      }
    }
    const closes = barsVis.map((b) => b.c);
    const bb = KChart.bollinger(closes, KChart.BOLL_PERIOD, KChart.BOLL_MULT);
    const fmt = (v) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(2));
    const up = $("#boll-up");
    const mid = $("#boll-mid");
    const dn = $("#boll-dn");
    if (up) up.textContent = fmt(bb.up[idx]);
    if (mid) mid.textContent = fmt(bb.mid[idx]);
    if (dn) dn.textContent = fmt(bb.dn[idx]);
  }

  function renderLog() {
    const box = $("#trade-log");
    const trades = state.engine.trades;
    const countEl = $("#log-count");
    if (countEl) {
      countEl.textContent = trades.length ? `· ${trades.length} 笔` : "";
    }
    if (!trades.length) {
      box.className = "trade-log empty";
      box.textContent = "暂无成交";
      return;
    }
    box.className = "trade-log";
    // newest first in flex-column-reverse => append chronological
    box.innerHTML = trades
      .map((t) => {
        const sideCls = t.side === "buy" ? "buy" : "sell";
        const sideTxt = t.note || (t.side === "buy" ? "买入" : "卖出");
        const extra =
          t.side === "sell"
            ? ` 盈亏 ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}`
            : "";
        return `<div class="log-row ${sideCls}">
          <span class="muted">${t.day}</span>
          <span class="side-tag">${sideTxt}</span>
          <span>${t.qty} 股</span>
          <span>@ ${t.price.toFixed(2)}</span>
          <span class="muted">费 ${t.fee.toFixed(2)}${extra}</span>
        </div>`;
      })
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  function renderHint(msg, cls) {
    const el = $("#trade-hint");
    if (msg) {
      el.textContent = msg;
      el.className = "hint " + (cls || "");
      return;
    }
    const eng = state.engine;
    if (eng.rule === "t1") {
      const sellable = eng.sellableShares();
      el.textContent = `T+1：今日可卖 ${sellable} 股`;
      el.className = "hint";
    } else {
      el.textContent = "T+0：可当日回转，支持部分加减仓";
      el.className = "hint";
    }
  }

  function pushSnapshot() {
    state.snapshots.push({
      cursor: state.cursor,
      engine: state.engine.snapshot(),
    });
    if (state.snapshots.length > 80) state.snapshots.shift();
  }

  function nextDay() {
    if (!state.running || state.finished) return;
    if (state.cursor >= state.endIdx) {
      endGame();
      return;
    }
    pushSnapshot();
    state.cursor += 1;
    state.engine.beginDay(currentBar().d);
    state.engine.markEquity(currentBar().c);
    if (state.mode === "speed") resetSpeedClock();
    renderGame();
    if (state.cursor >= state.endIdx) endGame();
  }

  function undoStep() {
    if (!state.running || state.finished || state.mode === "speed") return;
    if (!state.snapshots.length) {
      renderHint("没有可撤销的步骤", "warn");
      return;
    }
    const snap = state.snapshots.pop();
    state.cursor = snap.cursor;
    state.engine.restore(snap.engine);
    renderGame();
    renderHint("已撤销上一步", "ok");
  }

  function doBuy() {
    if (!state.running || state.finished) return;
    const bar = currentBar();
    const qty = parseInt($("#t-qty").value, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      renderHint("请输入有效数量", "err");
      return;
    }
    pushSnapshot();
    const result = state.engine.buy(qty, bar.c, bar.d);
    if (!result.ok) {
      state.snapshots.pop();
      renderHint(result.error, "err");
      return;
    }
    renderHint(`买入 ${qty} 股 @ ${bar.c.toFixed(2)}`, "ok");
    renderGame();
  }

  function doSell() {
    if (!state.running || state.finished) return;
    const bar = currentBar();
    const qty = parseInt($("#t-qty").value, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      renderHint("请输入有效数量", "err");
      return;
    }
    pushSnapshot();
    const result = state.engine.sell(qty, bar.c, bar.d);
    if (!result.ok) {
      state.snapshots.pop();
      renderHint(result.error, "err");
      return;
    }
    renderHint(
      `卖出 ${qty} 股 @ ${bar.c.toFixed(2)}，盈亏 ${result.trade.pnl >= 0 ? "+" : ""}${result.trade.pnl.toFixed(0)}`,
      "ok"
    );
    renderGame();
  }

  function setQtyByPct(pct) {
    const bar = currentBar();
    const eng = state.engine;
    const buyable = Math.max(
      0,
      Math.floor(eng.cash / (bar.c * 1.002) / 100) * 100
    );
    const sellable = eng.sellableShares();
    // Prefer scaling the larger side: position when holding, cash when flat.
    if (sellable >= buyable && sellable > 0) {
      let qty = Math.floor(sellable * pct);
      if (pct === 1) qty = sellable;
      $("#t-qty").value = String(Math.max(1, qty));
      return;
    }
    let qty = Math.floor((buyable * pct) / 100) * 100;
    if (qty < 100) qty = buyable > 0 ? 100 : 100;
    $("#t-qty").value = String(qty);
  }

  // ---------- speed mode ----------
  function startSpeedClock() {
    stopSpeedClock();
    state.speedDeadline = Date.now() + state.speedDuration;
    state.speedTimer = setInterval(tickSpeed, 100);
  }

  function resetSpeedClock() {
    if (state.mode !== "speed") return;
    startSpeedClock();
  }

  function stopSpeedClock() {
    if (state.speedTimer) {
      clearInterval(state.speedTimer);
      state.speedTimer = null;
    }
  }

  function tickSpeed() {
    const remain = Math.max(0, state.speedDeadline - Date.now());
    const sec = remain / 1000;
    $("#g-timer-num").textContent = String(Math.ceil(sec));
    const frac = remain / state.speedDuration;
    const fg = $("#timer-fg");
    const C = 2 * Math.PI * 15;
    fg.style.strokeDashoffset = String(C * (1 - frac));
    fg.classList.toggle("warn", sec <= 4 && sec > 2);
    fg.classList.toggle("danger", sec <= 2);
    if (remain <= 0 && state.running) {
      nextDay();
    }
  }

  function setReviewMode(on) {
    state.finished = on;
    const screen = $("#screen-game");
    if (screen) screen.classList.toggle("review", on);
    const banner = $("#review-banner");
    if (banner) banner.classList.toggle("hidden", !on);

    const dis = (sel, disabled) => {
      const el = $(sel);
      if (el) el.disabled = disabled;
    };
    dis("#btn-buy", on);
    dis("#btn-sell", on);
    dis("#btn-flatten", on);
    dis("#btn-next", on);
    dis("#btn-back", on);
    dis("#t-qty", on);
    $$("#qty-preset .chip").forEach((c) => {
      c.disabled = on;
    });

    const settle = $("#btn-settle");
    if (settle) settle.classList.toggle("hidden", !on);
    const nextBtn = $("#btn-next");
    if (nextBtn) nextBtn.classList.toggle("hidden", on);
    const backBtn = $("#btn-back");
    if (backBtn && on) backBtn.classList.add("hidden");

    if (on) {
      stopSpeedClock();
      const t = $("#g-timer");
      if (t) t.classList.add("hidden");
    }
  }

  function fillResultScreen(result) {
    const gradeEl = $("#r-grade");
    gradeEl.textContent = result.grade;
    gradeEl.className = "result-grade " + result.grade.toLowerCase();

    const stock = state.stocks.find((s) => s.code === state.activeCode);
    if (state.blind && stock) {
      $("#g-stock-name").textContent = stock.name;
      $("#g-stock-code").textContent = stock.code;
    }
    const displayName = stock ? stock.name : "未知标的";
    const displayCode = stock ? stock.code : "";
    $("#r-title").textContent =
      result.score >= 8 ? "操作漂亮！" : result.score >= 2 ? "稳中有进" : "继续磨练";
    const regimeTxt = state.windowRegime
      ? ` · ${REGIME_LABEL[state.windowRegime] || ""}`
      : "";
    $("#r-subtitle").textContent = state.blind
      ? `揭晓：${displayName}（${displayCode}） · ${MODE_LABEL[state.mode]} · ${challengeDayNumber()} 个交易日${regimeTxt}`
      : `${displayName} · ${MODE_LABEL[state.mode]} · ${challengeDayNumber()} 个交易日${regimeTxt}`;

    setMetric("#r-return", `${result.returnPct >= 0 ? "+" : ""}${result.returnPct.toFixed(2)}%`, result.returnPct);
    setMetric("#r-score", result.score.toFixed(2), result.score);
    setMetric("#r-dd", `-${(result.maxDd * 100).toFixed(2)}%`, -result.maxDd);
    const idxRet = indexReturnOverWindow();
    setMetric(
      "#r-index",
      idxRet == null ? "—" : `${idxRet >= 0 ? "+" : ""}${idxRet.toFixed(2)}%`,
      idxRet
    );
    const stockRet = result.stockReturnPct;
    setMetric(
      "#r-stock",
      stockRet == null ? "—" : `${stockRet >= 0 ? "+" : ""}${stockRet.toFixed(2)}%`,
      stockRet
    );
    const beat = result.alphaPct;
    setMetric(
      "#r-beat",
      beat == null ? "—" : `${beat >= 0 ? "+" : ""}${beat.toFixed(2)}%`,
      beat
    );
    setMetric(
      "#r-winrate",
      result.winRate == null ? "—" : `${(result.winRate * 100).toFixed(0)}%`,
      result.winRate == null ? 0 : result.winRate - 0.5
    );
    setMetric("#r-equity", fmtMoney(result.finalEquity), result.finalEquity - state.engine.initialCash);

    const alpha =
      idxRet == null
        ? ""
        : `<br/>相对大盘超额 <code>${(result.returnPct - idxRet >= 0 ? "+" : "")}${(result.returnPct - idxRet).toFixed(2)}%</code>`;
    const vsStock =
      result.alphaPct == null
        ? ""
        : `<br/>跑赢个股（买入持有） <code>${(result.alphaPct >= 0 ? "+" : "")}${result.alphaPct.toFixed(2)}%</code>`;
    $("#r-breakdown").innerHTML =
      result.breakdown.join("<br/>") +
      alpha +
      vsStock +
      `<br/>成交笔数 <code>${result.tradeCount}</code>（含期末清仓）` +
      (state.challengeSeed
        ? `<br/>挑战种子 <code>${state.challengeSeed}</code>`
        : "");
  }

  function enterReviewBanner(result) {
    const el = $("#review-summary");
    if (el) {
      const ret = result.returnPct;
      el.innerHTML = `收益 <code class="${ret >= 0 ? "up" : "down"}">${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%</code> · 得分 <code>${result.score.toFixed(2)}</code> · ${result.grade} 级`;
    }
  }

  // ---------- end / result ----------
  function endGame() {
    if (state.finished) {
      // already finished — just (re)show settlement
      if (state.lastResult) fillResultScreen(state.lastResult);
      showScreen("screen-result");
      return;
    }
    stopSpeedClock();
    state.running = false;

    // Force-close remaining positions at last close so win-rate / realized PnL are complete
    const lastBar = currentBar();
    const eng = state.engine;
    if (eng.shares > 0) {
      const prevRule = eng.rule;
      eng.rule = "t0"; // allow closing even same-day lots at game end
      const qty = eng.shares;
      const result = eng.sell(qty, lastBar.c, lastBar.d);
      eng.rule = prevRule;
      if (result.ok) {
        eng.trades[eng.trades.length - 1].note = "期末清仓";
      }
    }
    state.engine.markEquity(lastBar.c);

    const result = Scoring.scoreGame({
      equityCurve: state.engine.equityCurve,
      initialCash: state.engine.initialCash,
      trades: state.engine.trades,
      stockReturnPct: stockReturnOverWindow(),
    });
    state.lastResult = result;

    const stock = state.stocks.find((s) => s.code === state.activeCode);
    const displayName = stock ? stock.name : "未知标的";
    const displayCode = stock ? stock.code : "";
    // 结束后揭晓标的
    if (stock) {
      $("#g-stock-name").textContent = stock.name;
      $("#g-stock-code").textContent = stock.code;
    }
    saveScore({
      name: `盲猜·${displayName}`,
      code: displayCode,
      mode: state.mode,
      modeLabel: MODE_LABEL[state.mode] + "·盲猜",
      days: challengeDayNumber(),
      returnPct: result.returnPct,
      score: result.score,
      grade: result.grade,
      date: new Date().toISOString().slice(0, 10),
    });

    // Stay on the game screen in review mode: full chart + trade log remain,
    // only further trading is disabled.
    setReviewMode(true);
    enterReviewBanner(result);
    renderGame();
  }

  function setMetric(sel, text, signRef) {
    const el = $(sel);
    el.textContent = text;
    el.classList.remove("up", "down");
    if (signRef > 0) el.classList.add("up");
    else if (signRef < 0) el.classList.add("down");
  }

  // ---------- leaderboard ----------
  function loadBoard() {
    try {
      return JSON.parse(localStorage.getItem("kline-arena-board") || "[]");
    } catch {
      return [];
    }
  }

  function saveScore(entry) {
    const board = loadBoard();
    board.push(entry);
    board.sort((a, b) => b.score - a.score);
    localStorage.setItem("kline-arena-board", JSON.stringify(board.slice(0, 50)));
  }

  function renderBoard() {
    const board = loadBoard();
    const box = $("#board-list");
    if (!board.length) {
      box.innerHTML = '<div class="board-empty">还没有战绩，打完一局再来</div>';
      return;
    }
    box.innerHTML = board
      .map(
        (r, i) => `
      <div class="board-row${i < 3 ? " top" : ""}">
        <div class="rank">#${i + 1}</div>
        <div>
          <div>${r.name} <span class="muted">${r.modeLabel}</span></div>
          <div class="muted">${r.date} · ${r.days} 日 · ${r.grade}</div>
        </div>
        <div class="ret ${r.returnPct >= 0 ? "up" : "down"}">${r.returnPct >= 0 ? "+" : ""}${r.returnPct.toFixed(1)}%</div>
        <div class="score">${r.score.toFixed(1)}</div>
      </div>`
      )
      .join("");
  }

  // ---------- modals / nav ----------
  function openModal(id) {
    $("#" + id).classList.add("open");
  }
  function closeModal(id) {
    $("#" + id).classList.remove("open");
  }

  function bindModals() {
    $$(".modal-close").forEach((btn) => {
      btn.addEventListener("click", () => {
        const modal = btn.closest(".modal");
        if (modal) modal.classList.remove("open");
      });
    });
    $$(".modal").forEach((modal) => {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.remove("open");
      });
    });
    $("#btn-clear-board").addEventListener("click", () => {
      localStorage.removeItem("kline-arena-board");
      renderBoard();
    });
  }

  function showScreen(id) {
    $$(".screen").forEach((s) => s.classList.remove("active"));
    $("#" + id).classList.add("active");
    window.scrollTo(0, 0);
  }

  // ---------- game bindings ----------
  function bindGame() {
    $("#btn-next").addEventListener("click", nextDay);
    $("#btn-back").addEventListener("click", undoStep);
    $("#btn-buy").addEventListener("click", doBuy);
    $("#btn-sell").addEventListener("click", doSell);

    const seedBtn = $("#btn-seed");
    if (seedBtn) {
      seedBtn.addEventListener("click", () => {
        if (!state.challengeSeed) return;
        copyText(state.challengeSeed, `已复制种子 ${state.challengeSeed}`);
      });
    }

    // MA / BOLL toggle
    $$(".ind-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        $$(".ind-chip").forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
        state.indicator = chip.dataset.ind;
        $("#ma-legend").classList.toggle("hidden", state.indicator !== "ma");
        $("#boll-legend").classList.toggle("hidden", state.indicator !== "boll");
        if (state.engine) renderGame();
      });
    });

    $("#btn-flatten").addEventListener("click", () => {
      if (!state.running || state.finished) return;
      const eng = state.engine;
      const qty = eng.sellableShares();
      if (qty <= 0) {
        renderHint("没有可卖持仓", "warn");
        return;
      }
      $("#t-qty").value = String(qty);
      doSell();
    });

    $("#qty-preset").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      $$("#qty-preset .chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      setQtyByPct(parseFloat(chip.dataset.pct));
    });

    $("#btn-quit").addEventListener("click", () => {
      $("#confirm-title").textContent = "退出本局？";
      $("#confirm-text").textContent = "当前进度不会保存到排行榜。";
      openModal("modal-confirm");
      $("#btn-confirm-ok").onclick = () => {
        stopSpeedClock();
        state.running = false;
        closeModal("modal-confirm");
        showScreen("screen-setup");
      };
    });

    $("#btn-confirm-cancel").addEventListener("click", () => {
      closeModal("modal-confirm");
    });

    $("#btn-again").addEventListener("click", () => {
      closeModal("modal-confirm");
      startGame();
    });
    $("#btn-change").addEventListener("click", () => showScreen("screen-setup"));
    $("#btn-result-board").addEventListener("click", () => {
      renderBoard();
      openModal("modal-board");
    });

    // review / settlement
    const openSettle = () => {
      if (state.lastResult) {
        fillResultScreen(state.lastResult);
        showScreen("screen-result");
      } else {
        endGame();
        if (state.lastResult) {
          fillResultScreen(state.lastResult);
          showScreen("screen-result");
        }
      }
    };
    const settleBtns = ["#btn-settle", "#btn-review-settle"];
    settleBtns.forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener("click", openSettle);
    });
    const againBtn = $("#btn-review-again");
    if (againBtn) againBtn.addEventListener("click", () => startGame());
    const exitBtn = $("#btn-review-exit");
    if (exitBtn) {
      exitBtn.addEventListener("click", () => {
        setReviewMode(false);
        showScreen("screen-setup");
      });
    }
    const resultReview = $("#btn-result-review");
    if (resultReview) {
      resultReview.addEventListener("click", () => {
        setReviewMode(true);
        if (state.lastResult) enterReviewBanner(state.lastResult);
        showScreen("screen-game");
        renderGame();
      });
    }

    // keyboard
    document.addEventListener("keydown", (e) => {
      if (!$("#screen-game").classList.contains("active")) return;
      if (state.finished) return;
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        nextDay();
      } else if (e.key === "ArrowLeft" || (e.key.toLowerCase() === "z" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        undoStep();
      } else if (e.key.toLowerCase() === "b") {
        doBuy();
      } else if (e.key.toLowerCase() === "s") {
        doSell();
      }
    });

    // ---- crosshair (pointer events: mouse / touch / pen) ----
    const chartEl = $("#chart");

    const designSize = () => {
      const rect = chartEl.getBoundingClientRect();
      const k = chartEl.__kchart;
      const designW = (k && k.cssW) || chartEl.clientWidth || rect.width;
      const designH = (k && k.cssH) || parseFloat(chartEl.style.height) || rect.height;
      return { rect, designW, designH };
    };

    const pointFromEvent = (e) => {
      const { rect, designW, designH } = designSize();
      if (!rect.width || !rect.height) return null;
      const x = ((e.clientX - rect.left) * designW) / rect.width;
      const y = ((e.clientY - rect.top) * designH) / rect.height;
      return { x, y, inside: x >= 0 && y >= 0 && x <= designW && y <= designH };
    };

    const redrawChartOnly = () => {
      if (!state.engine) return;
      const barsVis = visibleBars();
      const visDates = new Set(barsVis.map((b) => b.d));
      const tradesVis = state.engine.trades.filter((t) => visDates.has(t.day));
      KChart.drawKline(chartEl, barsVis, {
        showMA: state.indicator === "ma",
        showBOLL: state.indicator === "boll",
        trades: tradesVis,
        cross: state.cross,
      });
      updateIndLegend(barsVis);
    };

    const updateCrossFromEvent = (e, sticky) => {
      if (!state.engine) return;
      const pt = pointFromEvent(e);
      if (!pt || !pt.inside) return;
      state.cross = { x: pt.x, y: pt.y, sticky: !!sticky };
      redrawChartOnly();
    };

    chartEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") chartEl.setPointerCapture(e.pointerId);
      updateCrossFromEvent(e, e.pointerType !== "mouse");
    });
    chartEl.addEventListener("pointermove", (e) => {
      // mouse: hover; touch/pen: drag
      updateCrossFromEvent(e, e.pointerType !== "mouse");
    });
    chartEl.addEventListener("pointerup", (e) => {
      // keep crosshair sticky for touch so it stays after finger up
      if (e.pointerType !== "mouse") updateCrossFromEvent(e, true);
    });
    chartEl.addEventListener("pointerleave", (e) => {
      // mouse leaves → clear; touch capture ends → keep sticky
      if (e.pointerType === "mouse" && state.cross) {
        state.cross = null;
        redrawChartOnly();
      }
    });
    chartEl.addEventListener(
      "touchmove",
      (e) => {
        // stop page scroll while dragging on chart
        if (e.cancelable) e.preventDefault();
      },
      { passive: false }
    );

    // redraw charts on resize
    let resizeT;
    window.addEventListener("resize", () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if ($("#screen-game").classList.contains("active") && state.engine) {
          renderGame();
        }
      }, 120);
    });
  }

  // ---------- utils ----------
  function fmtMoney(n) {
    return (
      n.toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  // go
  document.addEventListener("DOMContentLoaded", boot);
})();
