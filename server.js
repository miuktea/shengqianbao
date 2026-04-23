const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_SYMBOLS = ["AAPL", "TSLA", "MSFT", "NVDA", "BABA"];
const userScores = new Map();
const KNOWN_US_STOCKS = {
  AAPL: { symbol: "AAPL", name: "苹果", quoteId: "105.AAPL", exchange: "NASDAQ" },
  TSLA: { symbol: "TSLA", name: "特斯拉", quoteId: "105.TSLA", exchange: "NASDAQ" },
  MSFT: { symbol: "MSFT", name: "微软", quoteId: "105.MSFT", exchange: "NASDAQ" },
  NVDA: { symbol: "NVDA", name: "英伟达", quoteId: "105.NVDA", exchange: "NASDAQ" },
  BABA: { symbol: "BABA", name: "阿里巴巴", quoteId: "106.BABA", exchange: "NYSE" },
  AMZN: { symbol: "AMZN", name: "亚马逊", quoteId: "105.AMZN", exchange: "NASDAQ" },
  META: { symbol: "META", name: "Meta", quoteId: "105.META", exchange: "NASDAQ" },
  GOOGL: { symbol: "GOOGL", name: "谷歌", quoteId: "105.GOOGL", exchange: "NASDAQ" },
  NFLX: { symbol: "NFLX", name: "奈飞", quoteId: "105.NFLX", exchange: "NASDAQ" }
};

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function searchStocksByKeyword(keyword) {
  const k = String(keyword || "").trim();
  if (!k) return [];
  const alias = {
    tesla: "TSLA",
    apple: "AAPL",
    microsoft: "MSFT",
    nvidia: "NVDA",
    google: "GOOGL",
    amazon: "AMZN",
    meta: "META",
    alibaba: "BABA",
    netflix: "NFLX",
    特斯拉: "TSLA",
    苹果: "AAPL",
    微软: "MSFT",
    英伟达: "NVDA",
    阿里: "BABA",
    谷歌: "GOOGL",
    亚马逊: "AMZN"
  };
  const normalized = alias[k.toLowerCase()] || k.toUpperCase();
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(
    normalized
  )}&type=14&count=20`;
  const { data } = await axios.get(url, { timeout: 8000 });
  const rows = data?.QuotationCodeTable?.Data || [];
  const usRows = rows
    .filter((row) => row.Classify === "UsStock" && row.QuoteID)
    .map((row) => ({
      symbol: row.Code,
      name: row.Name,
      quoteId: row.QuoteID,
      exchange: row.JYS || "-"
    }));
  if (usRows.length) return usRows;
  return rows
    .filter((row) => row.QuoteID)
    .map((row) => ({
      symbol: row.Code,
      name: row.Name,
      quoteId: row.QuoteID,
      exchange: row.JYS || "-"
    }))
    .slice(0, 10);
}

async function resolveSymbols(symbols) {
  const out = {};
  const unresolved = [];
  symbols.forEach((symbol) => {
    if (KNOWN_US_STOCKS[symbol]) out[symbol] = KNOWN_US_STOCKS[symbol];
    else unresolved.push(symbol);
  });
  await Promise.all(
    unresolved.map(async (symbol) => {
      try {
        const result = await searchStocksByKeyword(symbol);
        const exact = result.find((r) => r.symbol.toUpperCase() === symbol);
        if (exact) out[symbol] = exact;
      } catch {
        // Ignore single symbol lookup failure to keep partial success
      }
    })
  );
  return out;
}

async function fetchEastmoneyQuotes(symbols) {
  const resolved = await resolveSymbols(symbols);
  const secids = symbols
    .map((s) => resolved[s]?.quoteId)
    .filter(Boolean)
    .join(",");

  if (!secids) return [];

  const fields = "f12,f14,f2,f3,f4,f13";
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${encodeURIComponent(
    secids
  )}`;
  const { data } = await axios.get(url, { timeout: 12000 });
  const diff = data?.data?.diff || [];

  const mappedBySymbol = {};
  diff.forEach((item) => {
    const symbol = String(item.f12 || "").toUpperCase();
    mappedBySymbol[symbol] = {
      symbol,
      name: item.f14 || resolved[symbol]?.name || symbol,
      price: safeNumber(item.f2),
      change: safeNumber(item.f4),
      changePercent: safeNumber(item.f3),
      currency: "USD",
      marketState: "REGULAR",
      exchange: resolved[symbol]?.exchange || "US"
    };
  });

  return symbols
    .map((s) => mappedBySymbol[s])
    .filter(Boolean);
}

app.get("/api/search", async (req, res) => {
  try {
    const keyword = String(req.query.keyword || "").trim();
    if (!keyword) return res.json({ items: [] });
    const items = await searchStocksByKeyword(keyword);
    res.json({ items: items.slice(0, 10) });
  } catch (error) {
    res.status(500).json({ error: "搜索股票失败", detail: error.message });
  }
});

app.get("/api/quotes", async (req, res) => {
  try {
    const rawSymbols = String(req.query.symbols || DEFAULT_SYMBOLS.join(","));
    const symbols = rawSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 20);
    if (!symbols.length) {
      return res.status(400).json({ error: "请提供至少一个股票代码" });
    }
    const quotes = await fetchEastmoneyQuotes(symbols);
    if (!quotes.length) {
      return res.status(502).json({ error: "行情源暂不可用，请稍后刷新" });
    }
    res.json({ updatedAt: Date.now(), quotes });
  } catch (error) {
    res.status(500).json({
      error: "获取行情失败，请稍后重试",
      detail: error.message
    });
  }
});

app.get("/api/trends", async (req, res) => {
  try {
    const symbol = String(req.query.symbol || "AAPL").toUpperCase();
    const resolved = await resolveSymbols([symbol]);
    const quoteId = resolved[symbol]?.quoteId;
    if (!quoteId) return res.status(404).json({ error: "未找到该股票趋势数据" });
    const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(
      quoteId
    )}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const trends = data?.data?.trends || [];
    const points = trends.map((line) => {
      const parts = String(line).split(",");
      return {
        time: parts[0],
        price: safeNumber(parts[2] || parts[1]),
        avgPrice: safeNumber(parts[7]),
        volume: safeNumber(parts[5])
      };
    });
    res.json({ symbol, points });
  } catch (error) {
    res.status(500).json({ error: "获取趋势失败", detail: error.message });
  }
});

app.get("/api/trends/compare", async (req, res) => {
  try {
    const rawSymbols = String(req.query.symbols || DEFAULT_SYMBOLS.join(","));
    const days = Math.min(5, Math.max(1, safeNumber(req.query.days, 1)));
    const symbols = rawSymbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 6);
    if (!symbols.length) return res.status(400).json({ error: "请至少提供1个股票代码" });

    const resolved = await resolveSymbols(symbols);
    const outputs = await Promise.all(
      symbols.map(async (symbol) => {
        const quoteId = resolved[symbol]?.quoteId;
        if (!quoteId) return null;
        const url = `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(
          quoteId
        )}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=${days}`;
        const { data } = await axios.get(url, { timeout: 12000 });
        const trends = data?.data?.trends || [];
        const points = trends
          .map((line) => {
            const parts = String(line).split(",");
            return {
              time: parts[0],
              price: safeNumber(parts[2] || parts[1])
            };
          })
          .filter((x) => x.price > 0);
        if (!points.length) return null;
        return {
          symbol,
          name: resolved[symbol]?.name || symbol,
          points
        };
      })
    );

    const series = outputs.filter(Boolean);
    if (!series.length) {
      return res.status(502).json({ error: "暂无可用对比曲线数据" });
    }
    res.json({ days, series });
  } catch (error) {
    res.status(500).json({ error: "获取对比曲线失败", detail: error.message });
  }
});

app.post("/api/ai-advice", async (req, res) => {
  const { riskLevel, profile, cash, holdingsValue, totalValue, topHoldings } = req.body || {};
  const profileText = `年龄段:${profile?.ageGroup || "unknown"};目标:${profile?.goalType || "unknown"};回撤承受:${profile?.drawdownLevel || "unknown"};周期:${profile?.horizon || "unknown"}`;
  const prompt = `你是面向中国年轻投资者的新手理财教练。请给6条分点建议，必须个性化，不要空话，中文。
风险偏好: ${riskLevel || "medium"}
投资者画像: ${profileText}
现金: ${safeNumber(cash)}
持仓市值: ${safeNumber(holdingsValue)}
总资产: ${safeNumber(totalValue)}
当前持仓: ${Array.isArray(topHoldings) ? topHoldings.join("、") : "无"}`;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const advice = [];
    if (profile?.ageGroup === "student") {
      advice.push("你处在资金积累初期，先把每月可投资金额固定下来，哪怕金额小，也要先形成纪律。");
    } else if (profile?.ageGroup === "young") {
      advice.push("你是职场成长期，建议做“核心仓+卫星仓”：核心仓长期，卫星仓做主题尝试。");
    } else {
      advice.push("你更适合稳健复利，优先保证本金波动可控，再追求收益。");
    }
    if (profile?.goalType === "growth") advice.push("目标是增长时，建议把模拟仓位分成 60%趋势龙头 + 40%分散配置。");
    if (profile?.goalType === "balanced") advice.push("目标是平衡时，把现金比例控制在 25%-40%，防止满仓被动。");
    if (profile?.goalType === "capital") advice.push("目标是保本时，单只股票不超过总资产 15%，并设置止损线。");
    if (profile?.horizon === "long") advice.push("你是长期周期，重点看公司盈利质量，不要被短期波动干扰。");
    if (profile?.horizon === "short") advice.push("短周期更看纪律：入场前先写明止盈止损，不做临场冲动决策。");
    if (profile?.drawdownLevel === "low") advice.push("你回撤承受低，建议总仓位上限先控制在 40%-50%。");
    if (profile?.drawdownLevel === "high") advice.push("你能承受波动，但要避免重仓单票，波动大不等于收益高。");
    advice.push("每周做一次复盘：记录买入理由、持有逻辑是否仍成立、下一步动作。");
    advice.push("把“少亏”放在“多赚”前面，能长期活下来才有复利。");
    return res.json({
      source: "rule",
      text: advice.slice(0, 6)
    });
  }

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );
    const content = data?.choices?.[0]?.message?.content || "";
    const lines = content
      .split("\n")
      .map((s) => s.trim().replace(/^[\d\-*.、\s]+/, ""))
      .filter(Boolean)
      .slice(0, 6);
    res.json({ source: "llm", text: lines });
  } catch {
    res.json({
      source: "rule-fallback",
      text: [
        "先保证你能坚持记录交易，再考虑提高仓位。",
        "遇到连续亏损时，先暂停交易，复盘后再行动。",
        "优先关注你能解释清楚的公司，不懂的不碰。"
      ]
    });
  }
});

app.post("/api/leaderboard/submit", (req, res) => {
  const username = String(req.body?.username || "").trim().slice(0, 20);
  const totalValue = safeNumber(req.body?.totalValue);
  if (!username) return res.status(400).json({ error: "用户名不能为空" });
  const prev = userScores.get(username) || 0;
  userScores.set(username, Math.max(prev, totalValue));
  res.json({ ok: true });
});

app.get("/api/leaderboard", (req, res) => {
  const ranking = [...userScores.entries()]
    .map(([username, totalValue]) => ({ username, totalValue }))
    .sort((a, b) => b.totalValue - a.totalValue)
    .slice(0, 20);
  res.json({ ranking });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`生钱宝已启动：http://localhost:${PORT}`);
});
