/* Candlestick + volume chart: MA / BOLL(13,2), trade marks, crosshair */
(function (global) {
  "use strict";

  const COLORS = {
    // A股习惯：红涨绿跌
    up: "#f6465d",
    down: "#2ebd85",
    upFill: "rgba(246,70,93,0.85)",
    downFill: "rgba(46,189,133,0.85)",
    grid: "rgba(36,48,65,0.7)",
    axis: "#7d8fa3",
    ma5: "#fbbf24",
    ma10: "#60a5fa",
    ma20: "#c084fc",
    bollMid: "#c084fc",
    bollUp: "rgba(96,165,250,0.9)",
    bollDn: "rgba(246,70,93,0.75)",
    bollFill: "rgba(96,165,250,0.08)",
    cross: "rgba(34,211,238,0.55)",
    crossLabelBg: "rgba(15,23,32,0.92)",
    eq: "#22d3ee",
    eqFill: "rgba(34,211,238,0.12)",
    idx: "#fbbf24",
    idxFill: "rgba(251,191,36,0.12)",
    buyMark: "#f6465d",
    sellMark: "#2ebd85",
  };

  const BOLL_PERIOD = 13;
  const BOLL_MULT = 2;

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function bollinger(values, period = BOLL_PERIOD, mult = BOLL_MULT) {
    const mid = sma(values, period);
    const up = new Array(values.length).fill(null);
    const dn = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      const slice = values.slice(i - period + 1, i + 1);
      const m = mid[i];
      let variance = 0;
      for (const v of slice) variance += (v - m) * (v - m);
      const sd = Math.sqrt(variance / period);
      up[i] = m + mult * sd;
      dn[i] = m - mult * sd;
    }
    return { mid, up, dn };
  }

  /** Layout shared by draw + hit-test */
  function layout(cssW, cssH, n, opts) {
    const isNarrow = cssW < 480;
    const padL = isNarrow ? 44 : 56;
    const padR = isNarrow ? 48 : 56;
    const padT = 10;
    const volH = Math.round(cssH * (isNarrow ? 0.16 : 0.18));
    const padB = 20;
    const priceH = cssH - padT - volH - padB - 6;
    const plotW = cssW - padL - padR;
    const slot = n > 0 ? plotW / n : plotW;
    return {
      isNarrow,
      padL,
      padR,
      padT,
      padB,
      volH,
      priceH,
      plotW,
      slot,
      bodyW: Math.max(Math.min(slot * 0.62, 14), 1.5),
      volTop: padT + priceH + 6,
      n,
    };
  }

  function drawTradeMarks(ctx, bars, trades, L, yAt, xAt) {
    if (!trades || !trades.length) return;
    const dayIndex = new Map();
    for (let i = 0; i < bars.length; i++) dayIndex.set(bars[i].d, i);

    // Semi-transparent boxes for completed buy→sell operations
    const zones = buildTradeZones(trades);
    for (const z of zones) {
      const i0 = dayIndex.get(z.fromDay);
      const i1 = dayIndex.get(z.toDay);
      if (i0 == null || i1 == null) continue;
      const xa = xAt(Math.min(i0, i1));
      const xb = xAt(Math.max(i0, i1));
      const y1 = yAt(z.priceHigh);
      const y2 = yAt(z.priceLow);
      const top = Math.min(y1, y2);
      const bot = Math.max(y1, y2);
      const profit = z.pct >= 0;
      ctx.fillStyle = profit ? "rgba(246,70,93,0.12)" : "rgba(46,189,133,0.12)";
      ctx.strokeStyle = profit ? "rgba(246,70,93,0.45)" : "rgba(46,189,133,0.45)";
      ctx.lineWidth = 1;
      ctx.fillRect(xa - 6, top - 4, (xb - xa) + 12, (bot - top) + 8);
      ctx.strokeRect(xa - 6, top - 4, (xb - xa) + 12, (bot - top) + 8);

      const label = `${z.pct >= 0 ? "+" : ""}${z.pct.toFixed(1)}%`;
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(label).width;
      const lx = (xa + xb) / 2 - tw / 2 - 6;
      const ly = top - 22;
      ctx.fillStyle = profit ? "rgba(246,70,93,0.92)" : "rgba(46,189,133,0.92)";
      ctx.fillRect(lx, ly, tw + 12, 18);
      ctx.fillStyle = "#0b0f14";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 6, ly + 9);
    }

    for (const t of trades) {
      const i = dayIndex.get(t.day);
      if (i == null) continue;
      const x = xAt(i);
      const y = yAt(t.price);
      const isBuy = t.side === "buy";
      const color = isBuy ? COLORS.buyMark : COLORS.sellMark;
      const r = 8;

      // horizontal tick at trade price
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - r * 1.6, y);
      ctx.lineTo(x + r * 1.6, y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // stem
      const markY = isBuy ? y + r + 8 : y - r - 8;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, markY);
      ctx.stroke();

      // triangle
      ctx.fillStyle = color;
      ctx.beginPath();
      if (isBuy) {
        ctx.moveTo(x, markY - r);
        ctx.lineTo(x - r * 0.95, markY + r * 0.75);
        ctx.lineTo(x + r * 0.95, markY + r * 0.75);
      } else {
        ctx.moveTo(x, markY + r);
        ctx.lineTo(x - r * 0.95, markY - r * 0.75);
        ctx.lineTo(x + r * 0.95, markY - r * 0.75);
      }
      ctx.closePath();
      ctx.fill();
      // outline for contrast
      ctx.strokeStyle = "rgba(11,15,20,0.85)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // letter
      ctx.fillStyle = "#0b0f14";
      ctx.font = "bold 9px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(isBuy ? "B" : "S", x, markY + (isBuy ? 1 : -1));
    }
  }

  /** Pair FIFO buys with sells → completed operation zones with return % */
  function buildTradeZones(trades) {
    const zones = [];
    const open = [];
    for (const t of trades) {
      if (t.side === "buy") {
        open.push({ day: t.day, price: t.price, qty: t.qty });
        continue;
      }
      let remaining = t.qty;
      let cost = 0;
      let firstDay = null;
      let priceHigh = t.price;
      let priceLow = t.price;
      while (remaining > 0 && open.length) {
        const lot = open[0];
        const take = Math.min(lot.qty, remaining);
        cost += take * lot.price;
        if (!firstDay) firstDay = lot.day;
        priceHigh = Math.max(priceHigh, lot.price);
        priceLow = Math.min(priceLow, lot.price);
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 0) open.shift();
      }
      if (cost > 0 && firstDay) {
        const proceeds = t.qty * t.price;
        const pct = ((proceeds - cost) / cost) * 100;
        zones.push({
          fromDay: firstDay,
          toDay: t.day,
          pct,
          priceHigh,
          priceLow,
        });
      }
    }
    return zones;
  }

  function drawKline(canvas, bars, opts = {}) {
    const showMA = opts.showMA !== false;
    const showBOLL = !!opts.showBOLL;
    const trades = opts.trades || [];
    const cross = opts.cross || null; // {x, y} in css pixels, or null
    const hideDates = !!opts.hideDates;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || canvas.width;
    const isNarrow = cssW < 480;
    const cssH =
      opts.height ||
      Math.round(
        isNarrow
          ? Math.min(cssW * 0.68, window.innerHeight * 0.32)
          : Math.min(cssW * 0.52, 560)
      );
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!bars || bars.length === 0) {
      ctx.fillStyle = COLORS.axis;
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("暂无数据", cssW / 2, cssH / 2);
      return;
    }

    const n = bars.length;
    const L = layout(cssW, cssH, n, opts);
    const { padL, padR, padT, padB, volH, priceH, bodyW, volTop, slot } = L;

    let min = Infinity;
    let max = -Infinity;
    for (const b of bars) {
      if (b.l < min) min = b.l;
      if (b.h > max) max = b.h;
    }
    const closes = bars.map((b) => b.c);
    let bb = null;
    if (showBOLL) {
      bb = bollinger(closes, BOLL_PERIOD, BOLL_MULT);
      for (let i = 0; i < n; i++) {
        if (bb.up[i] != null) max = Math.max(max, bb.up[i]);
        if (bb.dn[i] != null) min = Math.min(min, bb.dn[i]);
      }
    }
    // include trade prices in range
    for (const t of trades) {
      if (t.price > max) max = t.price;
      if (t.price < min) min = t.price;
    }
    const range = Math.max(max - min, max * 0.02, 0.01);
    min -= range * 0.06;
    max += range * 0.06;

    const xAt = (i) => padL + slot * i + slot / 2;
    const yAt = (p) => padT + ((max - p) / (max - min)) * priceH;
    const yPriceFromY = (y) => min + ((padT + priceH - y) / priceH) * (max - min);

    // grid + y labels
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = COLORS.axis;
    ctx.font = `${isNarrow ? 10 : 11}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const p = min + ((max - min) * i) / gridLines;
      const y = yAt(p);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      ctx.fillText(p.toFixed(p > 100 ? 1 : 2), cssW - padR + 4, y);
    }

    let volMax = 0;
    for (const b of bars) volMax = Math.max(volMax, b.v || 0);
    const volFromY = (y) => {
      const rel = 1 - (y - volTop) / Math.max(volH, 1);
      return Math.max(0, rel) * volMax;
    };

    // candles + volume
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const x = xAt(i);
      const isUp = b.c >= b.o;
      const col = isUp ? COLORS.up : COLORS.down;
      const fill = isUp ? COLORS.upFill : COLORS.downFill;

      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, bodyW * 0.15);
      ctx.beginPath();
      ctx.moveTo(x, yAt(b.h));
      ctx.lineTo(x, yAt(b.l));
      ctx.stroke();

      const yO = yAt(b.o);
      const yC = yAt(b.c);
      const top = Math.min(yO, yC);
      const h = Math.max(Math.abs(yO - yC), 1);
      ctx.fillStyle = fill;
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);

      if (b.v != null && volMax > 0) {
        const vh = (b.v / volMax) * (volH - 4);
        ctx.fillStyle = isUp ? "rgba(246,70,93,0.35)" : "rgba(46,189,133,0.35)";
        ctx.fillRect(x - bodyW / 2, volTop + volH - vh, bodyW, vh);
      }
    }

    // BOLL
    if (showBOLL && bb) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (bb.up[i] == null) continue;
        const x = xAt(i);
        const y = yAt(bb.up[i]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= 0; i--) {
        if (bb.dn[i] == null) continue;
        ctx.lineTo(xAt(i), yAt(bb.dn[i]));
      }
      ctx.closePath();
      ctx.fillStyle = COLORS.bollFill;
      ctx.fill();

      const series = [
        { data: bb.up, color: COLORS.bollUp },
        { data: bb.mid, color: COLORS.bollMid },
        { data: bb.dn, color: COLORS.bollDn },
      ];
      for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        let ok = false;
        for (let i = 0; i < n; i++) {
          if (s.data[i] == null) continue;
          const x = xAt(i);
          const y = yAt(s.data[i]);
          if (!ok) {
            ctx.moveTo(x, y);
            ok = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // MAs
    if (showMA && !showBOLL) {
      const mas = [
        { period: 5, color: COLORS.ma5 },
        { period: 10, color: COLORS.ma10 },
        { period: 20, color: COLORS.ma20 },
      ];
      for (const ma of mas) {
        const line = sma(closes, ma.period);
        ctx.strokeStyle = ma.color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          if (line[i] == null) continue;
          const x = xAt(i);
          const y = yAt(line[i]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // trade marks
    drawTradeMarks(ctx, bars, trades, L, yAt, xAt);

    // x labels (hidden while playing so the date doesn’t leak)
    if (!hideDates) {
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const step = Math.max(1, Math.floor(n / (isNarrow ? 4 : 6)));
      for (let i = 0; i < n; i += step) {
        ctx.fillText(bars[i].d.slice(5), xAt(i), cssH - padB + 3);
      }
    }

    // last price line
    const last = bars[n - 1];
    const ly = yAt(last.c);
    ctx.strokeStyle = COLORS.cross;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, ly);
    ctx.lineTo(cssW - padR, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    const tag = last.c.toFixed(2);
    ctx.fillStyle = last.c >= last.o ? COLORS.up : COLORS.down;
    const tw = ctx.measureText(tag).width + 10;
    ctx.fillRect(cssW - padR + 2, ly - 10, tw, 20);
    ctx.fillStyle = "#0b0f14";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `11px ui-monospace, Menlo, monospace`;
    ctx.fillText(tag, cssW - padR + 7, ly);

    // ---- crosshair + tooltip ----
    if (cross && cross.x >= padL && cross.x <= cssW - padR) {
      const idx = Math.max(
        0,
        Math.min(n - 1, Math.floor((cross.x - padL) / slot))
      );
      const cx = xAt(idx);
      const b = bars[idx];
      const inPrice = cross.y >= padT && cross.y <= padT + priceH;
      const inVol = cross.y > volTop && cross.y <= volTop + volH;

      // vertical line (full plot height)
      ctx.strokeStyle = "rgba(34,211,238,0.75)";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, cssH - padB);
      ctx.stroke();

      // horizontal line
      if (inPrice || inVol) {
        ctx.beginPath();
        ctx.moveTo(padL, cross.y);
        ctx.lineTo(cssW - padR, cross.y);
        ctx.stroke();
      }

      // axis labels
      ctx.setLineDash([]);
      ctx.font = `${isNarrow ? 10 : 11}px ui-monospace, Menlo, monospace`;
      if (inPrice) {
        const price = yPriceFromY(cross.y);
        const pl = price.toFixed(2);
        const pw = ctx.measureText(pl).width + 10;
        ctx.fillStyle = "#22d3ee";
        ctx.fillRect(cssW - padR + 2, cross.y - 10, pw, 20);
        ctx.fillStyle = "#0b0f14";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(pl, cssW - padR + 7, cross.y);
      }
      if (inVol) {
        const vol = volFromY(cross.y);
        const vl = fmtVol(vol);
        const vw = ctx.measureText(vl).width + 10;
        ctx.fillStyle = "#22d3ee";
        ctx.fillRect(cssW - padR + 2, cross.y - 10, vw, 20);
        ctx.fillStyle = "#0b0f14";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(vl, cssW - padR + 7, cross.y);
      }

      // tooltip — always include this bar's OHLCV
      const lines = [
        hideDates ? `第 ${idx + 1} 根` : b.d,
        `开 ${b.o.toFixed(2)}  高 ${b.h.toFixed(2)}`,
        `低 ${b.l.toFixed(2)}  收 ${b.c.toFixed(2)}`,
      ];
      // emphasize volume
      lines.push(`量 ${fmtVol(b.v)}`);
      if (inPrice) lines.push(`游标价 ${yPriceFromY(cross.y).toFixed(2)}`);
      if (inVol) lines.push(`游标量 ${fmtVol(volFromY(cross.y))}`);

      const pad = 10;
      let textW = 0;
      for (const line of lines) {
        textW = Math.max(textW, ctx.measureText(line).width);
      }
      const boxW = textW + pad * 2;
      const boxH = lines.length * 16 + pad * 2 - 4;
      let bx = cx + 14;
      let by = padT + 8;
      if (bx + boxW > cssW - 4) bx = cx - boxW - 14;
      if (bx < 4) bx = 4;
      if (by + boxH > cssH - 4) by = Math.max(4, cssH - boxH - 4);

      ctx.fillStyle = "rgba(10,15,20,0.94)";
      ctx.strokeStyle = "rgba(34,211,238,0.55)";
      ctx.lineWidth = 1;
      roundRect(ctx, bx, by, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      lines.forEach((line, i) => {
        if (i === 0) ctx.fillStyle = "#22d3ee";
        else if (i === 3) ctx.fillStyle = "#fbbf24"; // volume line
        else if (i >= 4) ctx.fillStyle = "#a8b8c8";
        else ctx.fillStyle = "#e6edf3";
        ctx.fillText(line, bx + pad, by + pad - 2 + i * 16);
      });
    }

    // expose hit helpers for external tooltip DOM if needed
    canvas.__kchart = {
      xAt,
      yAt,
      yPriceFromY,
      volFromY,
      volMax,
      volTop,
      volH,
      padL,
      padR,
      padT,
      padB,
      priceH,
      slot,
      n,
      bars,
      cssW,
      cssH,
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fmtVol(v) {
    if (v == null) return "—";
    if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
    if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
    return Math.round(v).toString();
  }

  function drawLineStrip(canvas, points, opts = {}) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = opts.height || 72;
    canvas.style.height = cssH + "px";
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const label = opts.label || "";
    if (label) {
      ctx.fillStyle = COLORS.axis;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(label, 6, 4);
    }

    // Filter points but keep original indices so time axis can stay aligned
    const indexed = [];
    for (let i = 0; i < points.length; i++) {
      if (points[i] == null || Number.isNaN(points[i])) continue;
      indexed.push({ i, v: points[i] });
    }
    if (indexed.length < 2) {
      ctx.fillStyle = COLORS.axis;
      ctx.font = "11px sans-serif";
      ctx.fillText("暂无数据", 8, cssH / 2);
      return;
    }

    // Optional time-axis alignment with the K-line chart
    const n = opts.n || points.length;
    const padL = opts.padL != null ? opts.padL : 6;
    const padR = opts.padR != null ? opts.padR : 6;
    const padT = opts.label ? 16 : 8;
    const padB = 8;
    const cssW2 = cssW;
    const plotW = cssW2 - padL - padR;
    const slot = n > 0 ? plotW / n : plotW;
    // Match kline: xAt(i) = padL + slot*i + slot/2
    const xAt = (i) =>
      opts.alignToKline
        ? padL + slot * i + slot / 2
        : padL + (i / Math.max(1, points.length - 1)) * plotW;

    let min = Infinity;
    let max = -Infinity;
    for (const p of indexed) {
      min = Math.min(min, p.v);
      max = Math.max(max, p.v);
    }
    if (opts.baseline != null) {
      min = Math.min(min, opts.baseline);
      max = Math.max(max, opts.baseline);
    }
    const pad = (max - min) * 0.12 || Math.max(1, Math.abs(max) * 0.002);
    min -= pad;
    max += pad;
    const h = cssH - padT - padB;
    const yAt = (v) => padT + ((max - v) / (max - min)) * h;

    if (opts.baseline != null) {
      const y0 = yAt(opts.baseline);
      ctx.strokeStyle = "rgba(125,143,163,0.35)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, y0);
      ctx.lineTo(cssW - padR, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // fill + stroke using original indices (gaps OK — move to next segment)
    ctx.beginPath();
    let started = false;
    for (const p of indexed) {
      const x = xAt(p.i);
      const y = yAt(p.v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    const last = indexed[indexed.length - 1];
    const first = indexed[0];
    ctx.lineTo(xAt(last.i), cssH - padB);
    ctx.lineTo(xAt(first.i), cssH - padB);
    ctx.closePath();
    ctx.fillStyle = opts.fill || COLORS.eqFill;
    ctx.fill();

    ctx.beginPath();
    started = false;
    for (const p of indexed) {
      const x = xAt(p.i);
      const y = yAt(p.v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = opts.color || COLORS.eq;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // hover / shared crosshair
    const cross = opts.cross || null;
    if (cross && cross.x >= padL && cross.x <= cssW - padR) {
      const idx = opts.alignToKline
        ? Math.min(n - 1, Math.max(0, Math.floor((cross.x - padL) / slot)))
        : Math.min(
            points.length - 1,
            Math.max(0, Math.round(((cross.x - padL) / plotW) * (points.length - 1)))
          );
      const v = points[idx];
      const cx = xAt(idx);
      ctx.strokeStyle = COLORS.cross;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, padT);
      ctx.lineTo(cx, cssH - padB);
      ctx.stroke();

      if (v != null && !Number.isNaN(v)) {
        const cy = yAt(v);
        ctx.fillStyle = opts.color || COLORS.eq;
        ctx.beginPath();
        ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
        ctx.fill();
        const text = (opts.fmtValue || ((x) => x.toFixed(2)))(v);
        ctx.font = "11px ui-monospace, Menlo, monospace";
        const tw = ctx.measureText(text).width;
        let bx = cx + 8;
        if (bx + tw + 10 > cssW - padR) bx = cx - tw - 16;
        ctx.fillStyle = COLORS.crossLabelBg;
        ctx.fillRect(bx, cy - 10, tw + 10, 20);
        ctx.fillStyle = "#e6edf3";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, bx + 5, cy);
      }
    }
  }

  function drawEquity(canvas, points, initial, opts = {}) {
    drawLineStrip(canvas, points, {
      height: opts.height || (canvas.clientWidth < 480 ? 64 : 80),
      baseline: initial,
      label: opts.label || "净值曲线",
      color: COLORS.eq,
      fill: COLORS.eqFill,
      n: opts.n,
      padL: opts.padL,
      padR: opts.padR,
      alignToKline: opts.alignToKline !== false,
      cross: opts.cross,
      fmtValue:
        opts.fmtValue ||
        ((v) =>
          v.toLocaleString("zh-CN", {
            maximumFractionDigits: 0,
          })),
    });
    canvas.__eqchart = { n: opts.n || points.length };
  }

  global.KChart = {
    drawKline,
    drawEquity,
    drawLineStrip,
    buildTradeZones,
    sma,
    bollinger,
    COLORS,
    BOLL_PERIOD,
    BOLL_MULT,
    fmtVol,
  };
})(window);
