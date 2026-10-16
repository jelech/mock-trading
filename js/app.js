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

  const state = {
    stocks: [],
    index: [],
    indexName: "样本等权指数",
    selectedCode: null,
    blind: false, // 随机盲猜：对局中隐藏标的
    mode: "classic",
    days: 40,
    capital: 100000,
    rule: "t0",
    range: "random",
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
  };

  // ---------- boot ----------
  async function boot() {
    try {
      const res = await fetch("data/stocks.json");
      const data = await res.json();
      state.stocks = data.stocks;
      state.index = data.index || [];
      state.indexName = data.index_name || "样本等权指数";
      renderStockList();
    } catch (err) {
      $("#stock-list").innerHTML =
        '<div class="board-empty">数据加载失败，请用本地服务器打开（python3 -m http.server）</div>';
      console.error(err);
    }
    bindSetup();
    bindGame();
    bindModals();
  }

  // ---------- setup UI ----------
  function renderStockList() {
    const box = $("#stock-list");
    const blindRow = `
      <button class="stock-item blind-item${state.blind ? " selected" : ""}" data-code="__blind__">
        <div>
          <div class="name">🎲 随机盲猜</div>
          <div class="code">对局中隐藏标的名，结束后揭晓</div>
        </div>
        <div class="range">神秘挑战</div>
      </button>`;
    box.innerHTML =
      blindRow +
      state.stocks
        .map(
          (s, i) => `
      <button class="stock-item${!state.blind && i === 0 ? " selected" : ""}" data-code="${s.code}">
        <div>
          <div class="name">${s.name}</div>
          <div class="code">${s.code}</div>
        </div>
        <div class="range">${s.start} → ${s.end}<br/>${s.bars.length} 根</div>
      </button>`
        )
        .join("");
    if (!state.blind) state.selectedCode = state.stocks[0].code;

    $$(".stock-item", box).forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".stock-item", box).forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        const code = btn.dataset.code;
        if (code === "__blind__") {
          state.blind = true;
          state.selectedCode = null;
        } else {
          state.blind = false;
          state.selectedCode = code;
        }
      });
    });
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
    bindChipGroup("#range-group", (chip) => {
      state.range = chip.dataset.value;
    });

    $("#btn-start").addEventListener("click", startGame);
    $("#btn-howto").addEventListener("click", () => openModal("modal-howto"));
    $("#btn-board").addEventListener("click", () => {
      renderBoard();
      openModal("modal-board");
    });
  }

  // ---------- game ----------
  function startGame() {
    let stock;
    if (state.blind) {
      stock = state.stocks[Math.floor(Math.random() * state.stocks.length)];
    } else {
      stock = state.stocks.find((s) => s.code === state.selectedCode);
    }
    if (!stock) return;
    // keep resolved code for scoring/reveal; hide UI when blind
    state.activeCode = stock.code;

    const bars = stock.bars;
    const totalDays = Math.min(state.days, bars.length - 10);
    if (totalDays < 5) {
      alert("该标的数据太短，无法开局");
      return;
    }

    // window: need room for MA warmup before start
    const warmup = 25;
    let startIdx;
    if (state.range === "start") {
      startIdx = warmup;
    } else {
      const minStart = warmup;
      const maxStart = bars.length - totalDays - 1;
      startIdx = minStart + Math.floor(Math.random() * Math.max(1, maxStart - minStart + 1));
    }
    // reveal includes warmup for MA
    const revealFrom = Math.max(0, startIdx - warmup);
    state.bars = bars.slice(revealFrom, startIdx + totalDays);
    state.startIdx = warmup; // index within state.bars where challenge starts
    state.cursor = state.startIdx;
    state.endIdx = state.bars.length - 1;

    state.engine = new TradeEngine({
      initialCash: state.capital,
      rule: state.rule,
    });
    state.snapshots = [];
    state.running = true;
    state.cross = null;

    // UI labels
    const s = stock;
    if (state.blind) {
      $("#g-stock-name").textContent = "神秘标的";
      $("#g-stock-code").textContent = "结束后揭晓";
    } else {
      $("#g-stock-name").textContent = s.name;
      $("#g-stock-code").textContent = s.code;
    }
    $("#g-day-total").textContent = String(totalDays);
    showScreen("screen-game");

    // timer visibility
    const isSpeed = state.mode === "speed";
    $("#g-timer").classList.toggle("hidden", !isSpeed);
    $("#btn-back").classList.toggle("hidden", isSpeed);

    renderGame();
    if (isSpeed) startSpeedClock();
  }

  function currentBar() {
    return state.bars[state.cursor];
  }

  function visibleBars() {
    // show some pre-challenge context + played days
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
    $("#g-date").textContent = bar.d;
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

  function renderLog() {
    const box = $("#trade-log");
    const trades = state.engine.trades;
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
    if (!state.running) return;
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
    if (!state.running || state.mode === "speed") return;
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

  // ---------- end / result ----------
  function endGame() {
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
    });

    // grade class
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
    $("#r-subtitle").textContent = state.blind
      ? `揭晓：${displayName}（${displayCode}） · ${MODE_LABEL[state.mode]} · ${challengeDayNumber()} 个交易日`
      : `${displayName} · ${MODE_LABEL[state.mode]} · ${challengeDayNumber()} 个交易日`;

    setMetric("#r-return", `${result.returnPct >= 0 ? "+" : ""}${result.returnPct.toFixed(2)}%`, result.returnPct);
    setMetric("#r-score", result.score.toFixed(2), result.score);
    setMetric("#r-dd", `-${(result.maxDd * 100).toFixed(2)}%`, -result.maxDd);
    const idxRet = indexReturnOverWindow();
    setMetric(
      "#r-index",
      idxRet == null ? "—" : `${idxRet >= 0 ? "+" : ""}${idxRet.toFixed(2)}%`,
      idxRet
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
    $("#r-breakdown").innerHTML =
      result.breakdown.join("<br/>") +
      alpha +
      `<br/>成交笔数 <code>${result.tradeCount}</code>（含期末清仓）`;

    saveScore({
      name: state.blind ? `盲猜·${displayName}` : displayName,
      code: displayCode,
      mode: state.mode,
      modeLabel: MODE_LABEL[state.mode] + (state.blind ? "·盲猜" : ""),
      days: challengeDayNumber(),
      returnPct: result.returnPct,
      score: result.score,
      grade: result.grade,
      date: new Date().toISOString().slice(0, 10),
    });

    showScreen("screen-result");
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

    // keyboard
    document.addEventListener("keydown", (e) => {
      if (!$("#screen-game").classList.contains("active")) return;
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

    // crosshair on K-line — only redraw the chart for smooth hover
    const chartEl = $("#chart");
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
    };
    chartEl.addEventListener("mousemove", (e) => {
      if (!state.engine) return;
      const rect = chartEl.getBoundingClientRect();
      state.cross = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      redrawChartOnly();
    });
    chartEl.addEventListener("mouseleave", () => {
      if (!state.cross) return;
      state.cross = null;
      redrawChartOnly();
    });
    chartEl.addEventListener(
      "touchmove",
      (e) => {
        if (!state.engine || !e.touches[0]) return;
        const rect = chartEl.getBoundingClientRect();
        state.cross = {
          x: e.touches[0].clientX - rect.left,
          y: e.touches[0].clientY - rect.top,
        };
        redrawChartOnly();
      },
      { passive: true }
    );
    chartEl.addEventListener("touchend", () => {
      state.cross = null;
      redrawChartOnly();
    });

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
