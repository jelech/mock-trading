# K线竞技场 · 历史盘交易练习

在真实历史日线里练习买卖的小游戏。支持部分仓位、做 T（当日回转）、分批加减仓，比单纯「满仓进 / 清仓出」更接近实战。

纯静态页面，无构建步骤，直接开 GitHub Pages 就能玩。

**在线试玩：** https://jelech.github.io/mock-trading/

## 玩法

1. 选一个标的、一种模式（经典 / 闪电 / 限时竞速 / 马拉松）
2. 系统从历史区间随机截取一段 K 线，只展示「已经走出来」的部分
3. 按当前收盘价下单（买入 / 卖出，支持 1/4、1/2、3/4、全仓）
4. 点「下一根」推进一天；限时模式每根只有 8 秒
5. 最后一根走完后**系统强制按收盘价清仓**，进入结算

计分：`得分 = 收益率 − 回撤惩罚 − 过度交易惩罚`，并给出相对大盘超额。

### 指标

- **MA**：MA5 / MA10 / MA20
- **BOLL**：布林带（20 日，±2σ）
- 下方对照：净值曲线 + **样本等权指数**（由库内标的等权合成，当大盘看）

### 快捷键

| 按键 | 动作 |
|------|------|
| `空格` / `→` | 下一根 |
| `←` / `Cmd+Z` | 撤销上一步 |
| `B` | 买入 |
| `S` | 卖出 |

## 本地运行

```bash
python3 -m http.server 8080
# 打开 http://127.0.0.1:8080
```

> 需要本地服务器（要 `fetch` JSON）；直接双击 `index.html` 可能被 CORS 拦。

## GitHub Pages 部署

本仓库根目录就是站点根目录，打开 Pages 即可：

1. 仓库 **Settings → Pages**
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`
4. Save，约 1 分钟后访问 `https://jelech.github.io/mock-trading/`

若 Pages 已启用却 404，先确认根目录有 `index.html`，再等 1–2 分钟或在 Actions 里看 `pages build and deployment`。

## 更新行情数据

原始 CSV 在 `vibe-trading/standalone/backtest/data/`（列名 `trade_date,open,high,low,close,volume`，列顺序可不同）：

```bash
python3 tools/build_data.py
```

会重新生成 `data/stocks.json`（含个股 + 样本等权指数）。名称映射在 `tools/build_data.py` 的 `NAMES`。

## 目录

```
index.html          # 页面结构
css/style.css       # 深色交易终端风格 + 手机端一页布局
js/chart.js         # Canvas K线 / MA / BOLL / 净值 / 大盘
js/engine.js        # 账户 / 分批持仓 / T+0·T+1 / 手续费
js/scoring.js       # 计分与评级
js/app.js           # 流程、UI、本地排行榜
data/stocks.json    # 行情数据
tools/build_data.py # CSV → JSON
```

## 相对「单仓买卖」多出来的能力

- **部分仓位**：1/4 仓试水，分批加减仓
- **做 T**：默认 T+0；可切 T+1
- **手续费**：佣金 + 卖出印花税
- **风险计分**：回撤、过度交易都会扣分
- **BOLL / 大盘对照**：看相对强弱
- **期末强平**：按最后收盘清仓，胜率与已实现盈亏完整
- **限时竞速**：每根 8 秒，练盘感
