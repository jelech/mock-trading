/* Scoring: return − drawdown penalty − overtrading penalty */
(function (global) {
  "use strict";

  function maxDrawdown(equityCurve) {
    let peak = equityCurve[0];
    let maxDd = 0;
    for (const v of equityCurve) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
    return maxDd; // 0..1
  }

  function winRate(trades) {
    const sells = trades.filter((t) => t.side === "sell");
    if (sells.length === 0) return null;
    const wins = sells.filter((t) => t.pnl > 0).length;
    return wins / sells.length;
  }

  /**
   * @returns {{returnPct:number, maxDd:number, winRate:number|null, tradeCount:number, score:number, grade:string, breakdown:string[]}}
   */
  function scoreGame({ equityCurve, initialCash, trades, stockReturnPct }) {
    const final = equityCurve[equityCurve.length - 1];
    const returnPct = ((final - initialCash) / initialCash) * 100;
    const maxDd = maxDrawdown(equityCurve);
    const tradeCount = trades.length;
    const wr = winRate(trades);

    // Penalties
    const ddPenalty = maxDd * 100 * 0.55; // 10% drawdown → −5.5 pts
    const excessTrades = Math.max(0, tradeCount - 12);
    const tradePenalty = excessTrades * 0.12;
    // Reward for actually closing positions (realized activity)
    const sellCount = trades.filter((t) => t.side === "sell").length;
    const activityBonus = Math.min(2, sellCount * 0.25);

    // Beat buy-and-hold of the same stock over the challenge window
    let alphaBonus = 0;
    let alphaLine = null;
    if (stockReturnPct != null && Number.isFinite(stockReturnPct)) {
      const alpha = returnPct - stockReturnPct;
      alphaBonus = Math.max(-3, Math.min(4, alpha * 0.12));
      alphaLine = `跑赢个股 <code>${alpha >= 0 ? "+" : ""}${alpha.toFixed(2)}%</code>（个股区间 ${stockReturnPct >= 0 ? "+" : ""}${stockReturnPct.toFixed(2)}%）`;
    }

    const score =
      Math.round(
        (returnPct - ddPenalty - tradePenalty + activityBonus + alphaBonus) * 100
      ) / 100;

    let grade = "C";
    if (score >= 15) grade = "S";
    else if (score >= 8) grade = "A";
    else if (score >= 2) grade = "B";
    else if (score >= -5) grade = "C";
    else grade = "D";

    const breakdown = [
      `收益率贡献 <code>${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%</code>`,
      `回撤惩罚 <code>−${ddPenalty.toFixed(2)}</code>（最大回撤 ${(maxDd * 100).toFixed(2)}%）`,
      `交易惩罚 <code>−${tradePenalty.toFixed(2)}</code>（${tradeCount} 笔，免罚额度 12 笔）`,
      `活跃奖励 <code>+${activityBonus.toFixed(2)}</code>（完成卖出 ${sellCount} 次）`,
    ];
    if (alphaLine) {
      breakdown.push(
        `个股对照 <code>${alphaBonus >= 0 ? "+" : ""}${alphaBonus.toFixed(2)}</code>（${alphaLine}）`
      );
    }
    breakdown.push(`综合得分 <code>${score.toFixed(2)}</code>`);

    return {
      returnPct,
      maxDd,
      winRate: wr,
      tradeCount,
      finalEquity: final,
      score,
      grade,
      stockReturnPct: stockReturnPct == null ? null : stockReturnPct,
      alphaPct:
        stockReturnPct == null ? null : returnPct - stockReturnPct,
      alphaBonus,
      breakdown,
    };
  }

  global.Scoring = { scoreGame, maxDrawdown, winRate };
})(window);
