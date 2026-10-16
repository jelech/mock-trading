/* Trading engine: cash, position lots, T+0/T+1, trade log, equity marks */
(function (global) {
  "use strict";

  class TradeEngine {
    /**
     * @param {object} opts
     * @param {number} opts.initialCash
     * @param {'t0'|'t1'} opts.rule
     */
    constructor(opts) {
      this.initialCash = opts.initialCash;
      this.cash = opts.initialCash;
      this.rule = opts.rule || "t0";
      /** @type {{qty:number, cost:number, day:string}[]} */
      this.lots = [];
      this.realized = 0;
      this.trades = [];
      this.dayTrades = 0;
      this.currentDay = null;
      this.equityCurve = [opts.initialCash];
    }

    get shares() {
      return this.lots.reduce((s, l) => s + l.qty, 0);
    }

    get avgCost() {
      const sh = this.shares;
      if (sh <= 0) return 0;
      return this.lots.reduce((s, l) => s + l.cost * l.qty, 0) / sh;
    }

    get costBasis() {
      return this.lots.reduce((s, l) => s + l.cost * l.qty, 0);
    }

    /** Mark-to-market equity at price */
    equity(price) {
      return this.cash + this.shares * price;
    }

    floatPnl(price) {
      return this.shares * price - this.costBasis;
    }

    /** Opening a new trading day resets the day-trade counter */
    beginDay(day) {
      if (this.currentDay !== day) {
        this.currentDay = day;
        this.dayTrades = 0;
      }
    }

    /** Shares sellable today under the current rule */
    sellableShares() {
      if (this.rule === "t0") return this.shares;
      // T+1: lots bought today cannot be sold
      return this.lots
        .filter((l) => l.day !== this.currentDay)
        .reduce((s, l) => s + l.qty, 0);
    }

    /**
     * Market order at given price.
     * @returns {{ok:boolean, error?:string, trade?:object}}
     */
    buy(qty, price, day) {
      qty = Math.floor(qty);
      if (qty < 100) return { ok: false, error: "最少买入 100 股" };
      if (qty % 100 !== 0) return { ok: false, error: "买入需为 100 股整数倍" };
      const cost = qty * price;
      const fee = this._fee("buy", qty, price);
      const total = cost + fee;
      if (total > this.cash + 1e-6) {
        return { ok: false, error: "现金不足（含手续费）" };
      }
      this.cash -= total;
      this.lots.push({ qty, cost: price, day });
      this.dayTrades += 1;
      const trade = {
        side: "buy",
        qty,
        price,
        day,
        fee,
        cashDelta: -total,
      };
      this.trades.push(trade);
      return { ok: true, trade };
    }

    sell(qty, price, day) {
      qty = Math.floor(qty);
      const sellable = this.sellableShares();
      if (qty <= 0) return { ok: false, error: "请输入卖出数量" };
      // Buying stays in board lots (100); selling can be any amount up to
      // sellable shares so partial / odd-lot exits work for practice.
      if (qty > sellable) {
        return {
          ok: false,
          error:
            this.rule === "t1"
              ? `T+1 规则下今日可卖 ${sellable} 股`
              : `持仓不足（可卖 ${sellable} 股）`,
        };
      }
      // FIFO consume lots
      let remaining = qty;
      let costOut = 0;
      while (remaining > 0 && this.lots.length) {
        const lot = this.lots[0];
        const take = Math.min(lot.qty, remaining);
        costOut += take * lot.cost;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 0) this.lots.shift();
      }
      const proceeds = qty * price;
      const fee = this._fee("sell", qty, price);
      this.cash += proceeds - fee;
      const pnl = proceeds - costOut - fee;
      this.realized += pnl;
      this.dayTrades += 1;
      const trade = {
        side: "sell",
        qty,
        price,
        day,
        fee,
        pnl,
        cashDelta: proceeds - fee,
      };
      this.trades.push(trade);
      return { ok: true, trade };
    }

    /** Approximate A-share fees: commission + stamp on sell */
    _fee(side, qty, price) {
      const amount = qty * price;
      const commission = Math.max(amount * 0.00025, 5);
      const stamp = side === "sell" ? amount * 0.0005 : 0;
      return commission + stamp;
    }

    markEquity(price) {
      this.equityCurve.push(this.equity(price));
    }

    /** Snapshot for undo (simple deep copy) */
    snapshot() {
      return JSON.parse(
        JSON.stringify({
          cash: this.cash,
          lots: this.lots,
          realized: this.realized,
          trades: this.trades,
          dayTrades: this.dayTrades,
          currentDay: this.currentDay,
          equityCurve: this.equityCurve,
        })
      );
    }

    restore(snap) {
      this.cash = snap.cash;
      this.lots = snap.lots;
      this.realized = snap.realized;
      this.trades = snap.trades;
      this.dayTrades = snap.dayTrades;
      this.currentDay = snap.currentDay;
      this.equityCurve = snap.equityCurve;
    }
  }

  global.TradeEngine = TradeEngine;
})(window);
