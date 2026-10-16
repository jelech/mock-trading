# 自定义标的 CSV

把个股日线 CSV 放在本目录，文件名 = 股票代码，例如：

- `600519.SH.csv`
- `000001.SZ.csv`

列名需包含（顺序不限）：

```
trade_date,open,high,low,close,volume
```

`volume` 可选。日期格式 `YYYY-MM-DD`。

然后重新生成游戏数据：

```bash
python3 tools/build_data.py
```

本目录的标的会**优先**并入 `data/stocks.json`，再用 akline 热门池补齐。
