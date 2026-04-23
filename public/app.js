const STORAGE_KEY = "shengqianbao_account";
const USER_KEY = "shengqianbao_user";
const WATCHLIST_KEY = "shengqianbao_watchlist";
const TASK_KEY = "shengqianbao_tasks";
const INITIAL_CASH = 100000;
const DEFAULT_WATCHLIST = ["AAPL", "TSLA", "MSFT", "NVDA", "BABA"];

let marketQuotes = [];
let searchResults = [];
let compareSymbols = [];
let compareSeries = [];
let selectedTrendSymbol = "AAPL";
let tipIndex = 0;
let isFetchingQuotes = false;
let isFetchingCompare = false;
let isFetchingTrend = false;
let account = loadAccount();
let username = localStorage.getItem(USER_KEY) || "";
let watchlist = loadWatchlist();

const cashValue = document.getElementById("cashValue");
const holdingsValue = document.getElementById("holdingsValue");
const totalValue = document.getElementById("totalValue");
const marketList = document.getElementById("marketList");
const symbolSelect = document.getElementById("symbolSelect");
const qtyInput = document.getElementById("qtyInput");
const holdingsTableWrap = document.getElementById("holdingsTableWrap");
const lotTableWrap = document.getElementById("lotTableWrap");

function loadAccount() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { cash: INITIAL_CASH, positions: {}, trades: [] };
  try {
    const parsed = JSON.parse(raw);
    if (parsed.positions) {
      return {
        cash: Number(parsed.cash) || INITIAL_CASH,
        positions: parsed.positions || {},
        trades: parsed.trades || []
      };
    }
    // 兼容老版本 holdings: {symbol: qty}
    const positions = {};
    Object.entries(parsed.holdings || {}).forEach(([symbol, qty]) => {
      positions[symbol] = [{
        id: `${symbol}-${Date.now()}`,
        qty: Number(qty) || 0,
        buyPrice: 0,
        buyAt: new Date().toISOString()
      }];
    });
    return { cash: Number(parsed.cash) || INITIAL_CASH, positions, trades: [] };
  } catch {
    return { cash: INITIAL_CASH, positions: {}, trades: [] };
  }
}

function loadWatchlist() {
  const raw = localStorage.getItem(WATCHLIST_KEY);
  if (!raw) return [...DEFAULT_WATCHLIST];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return [...DEFAULT_WATCHLIST];
    return arr.slice(0, 30).map((s) => String(s).toUpperCase());
  } catch {
    return [...DEFAULT_WATCHLIST];
  }
}

function saveAccount() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
}
function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
}
function money(n) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(n || 0);
}
function quoteBySymbol(symbol) {
  return marketQuotes.find((q) => q.symbol === symbol);
}

function downsamplePoints(points, maxPoints = 260) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  const step = points.length / maxPoints;
  const sampled = [];
  for (let i = 0; i < maxPoints; i += 1) {
    sampled.push(points[Math.floor(i * step)]);
  }
  return sampled;
}

function isMarketTabActive() {
  return document.getElementById("market")?.classList.contains("active");
}
function allLots() {
  const lots = [];
  Object.entries(account.positions).forEach(([symbol, arr]) => {
    arr.forEach((lot) => lots.push({ symbol, ...lot }));
  });
  return lots;
}
function daysBetween(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
function calcHoldingsValue() {
  return allLots().reduce((sum, lot) => {
    const q = quoteBySymbol(lot.symbol);
    return sum + (q ? q.price * lot.qty : 0);
  }, 0);
}

function renderAssetSummary() {
  const hv = calcHoldingsValue();
  cashValue.textContent = money(account.cash);
  holdingsValue.textContent = money(hv);
  totalValue.textContent = money(account.cash + hv);
}

function renderMarket() {
  marketList.innerHTML = marketQuotes.map((q) => {
    const up = q.change >= 0;
    const inCompare = compareSymbols.includes(q.symbol);
    return `<div class="stock-card" data-symbol="${q.symbol}">
      <h4>${q.symbol} <small>${q.name}</small></h4>
      <div><strong>${money(q.price)}</strong></div>
      <div class="${up ? "green" : "red"}">${up ? "+" : ""}${q.change.toFixed(2)} (${up ? "+" : ""}${q.changePercent.toFixed(2)}%)</div>
      <div class="muted">${q.exchange} / ${q.marketState}</div>
      <div class="card-actions">
        <button class="btn" data-compare="${q.symbol}">${inCompare ? "移出对比" : "加入对比"}</button>
      </div>
    </div>`;
  }).join("");

  document.querySelectorAll(".stock-card").forEach((el) => {
    el.addEventListener("click", () => {
      selectedTrendSymbol = el.dataset.symbol;
      renderTrend();
    });
  });
  document.querySelectorAll("button[data-compare]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = btn.dataset.compare;
      if (compareSymbols.includes(s)) compareSymbols = compareSymbols.filter((x) => x !== s);
      else if (compareSymbols.length < 6) compareSymbols.push(s);
      renderMarket();
      renderCompareChart();
    });
  });
}

async function renderCompareChart() {
  if (isFetchingCompare) return;
  const canvas = document.getElementById("compareCanvas");
  const legend = document.getElementById("compareLegend");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!compareSymbols.length) {
    legend.textContent = "还没有加入对比的股票。";
    ctx.fillStyle = "#64748b";
    ctx.font = "14px sans-serif";
    ctx.fillText("请选择要对比的股票（最多6支）", 20, 40);
    return;
  }
  try {
    isFetchingCompare = true;
    const days = Number(document.getElementById("compareRange").value || 1);
    const res = await fetch(`/api/trends/compare?symbols=${encodeURIComponent(compareSymbols.join(","))}&days=${days}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "获取对比曲线失败");
    compareSeries = data.series || [];
    if (!compareSeries.length) throw new Error("暂无对比曲线");
    const colors = ["#2563eb", "#dc2626", "#059669", "#7c3aed", "#f59e0b", "#0891b2"];
    const pad = 28;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;

    // 用归一化涨跌幅做比较，避免价格量级差异导致看不见
    const normalized = compareSeries.map((s) => {
      const sampled = downsamplePoints(s.points, 240);
      const base = sampled[0]?.price || 1;
      return {
        symbol: s.symbol,
        points: sampled.map((p) => ({ time: p.time, v: ((p.price - base) / base) * 100 }))
      };
    });
    const values = normalized.flatMap((s) => s.points.map((p) => p.v));
    const min = Math.min(...values);
    const max = Math.max(...values);

    normalized.forEach((series, idx) => {
      const pts = series.points;
      ctx.strokeStyle = colors[idx % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = pad + (i / (pts.length - 1 || 1)) * w;
        const y = pad + ((max - p.v) / (max - min || 1)) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    const timeStart = compareSeries[0].points[0]?.time || "-";
    const timeEnd = compareSeries[0].points[compareSeries[0].points.length - 1]?.time || "-";
    legend.innerHTML = normalized
      .map((s, i) => `<span style="margin-right:10px;color:${colors[i % colors.length]}">${s.symbol}</span>`)
      .join("") + `<span> | 时间: ${timeStart} ~ ${timeEnd} | 实时刷新: 60秒</span>`;
  } catch (error) {
    legend.textContent = `对比曲线失败：${error.message}`;
    ctx.fillStyle = "#dc2626";
    ctx.font = "14px sans-serif";
    ctx.fillText(`加载失败：${error.message}`, 20, 40);
  } finally {
    isFetchingCompare = false;
  }
}

function renderSymbolOptions() {
  symbolSelect.innerHTML = watchlist
    .map((s) => {
      const q = quoteBySymbol(s);
      return `<option value="${s}">${s} - ${q?.name || "未加载"}</option>`;
    })
    .join("");
}

function aggregatePositions() {
  const map = {};
  allLots().forEach((lot) => {
    map[lot.symbol] = (map[lot.symbol] || 0) + lot.qty;
  });
  return map;
}

function renderHoldingsTable() {
  const rows = Object.entries(aggregatePositions());
  if (!rows.length) {
    holdingsTableWrap.innerHTML = `<p class="muted">暂无持仓，快去买入第一支股票试试吧。</p>`;
    lotTableWrap.innerHTML = `<p class="muted">暂无交易记录。</p>`;
    return;
  }
  holdingsTableWrap.innerHTML = `<table><thead><tr><th>代码</th><th>总数量</th><th>现价</th><th>市值</th></tr></thead>
    <tbody>${rows.map(([symbol, qty]) => {
      const q = quoteBySymbol(symbol);
      const price = q?.price || 0;
      return `<tr><td>${symbol}</td><td>${qty}</td><td>${money(price)}</td><td>${money(price * qty)}</td></tr>`;
    }).join("")}</tbody></table>`;

  const lots = allLots().sort((a, b) => new Date(b.buyAt) - new Date(a.buyAt));
  lotTableWrap.innerHTML = `<table><thead><tr><th>买入时间</th><th>股票</th><th>数量</th><th>买入成本</th><th>当前市值</th><th>持有天数</th><th>盈亏</th></tr></thead>
  <tbody>${lots.map((lot) => {
    const q = quoteBySymbol(lot.symbol);
    const nowPrice = q?.price || 0;
    const invest = lot.buyPrice * lot.qty;
    const now = nowPrice * lot.qty;
    const pnl = now - invest;
    return `<tr>
      <td>${new Date(lot.buyAt).toLocaleString()}</td>
      <td>${lot.symbol}</td><td>${lot.qty}</td>
      <td>${money(invest)}</td><td>${money(now)}</td>
      <td>${daysBetween(lot.buyAt)}天</td>
      <td class="${pnl >= 0 ? "green" : "red"}">${money(pnl)} (${invest > 0 ? ((pnl / invest) * 100).toFixed(2) : "0.00"}%)</td>
    </tr>`;
  }).join("")}</tbody></table>`;
}

async function fetchQuotes() {
  if (isFetchingQuotes) return;
  marketList.innerHTML = "<p>行情加载中...</p>";
  try {
    isFetchingQuotes = true;
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(watchlist.join(","))}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "行情请求失败");
    marketQuotes = data.quotes || [];
    renderMarket();
    if (isMarketTabActive()) renderCompareChart();
    renderWatchlist();
    renderSymbolOptions();
    renderHoldingsTable();
    renderAssetSummary();
    if (!watchlist.includes(selectedTrendSymbol) && watchlist.length) selectedTrendSymbol = watchlist[0];
    if (isMarketTabActive()) renderTrend();
  } catch (error) {
    marketList.innerHTML = `<p class="red">加载失败：${error.message}</p>`;
  } finally {
    isFetchingQuotes = false;
  }
}

async function renderTrend() {
  if (isFetchingTrend) return;
  const canvas = document.getElementById("trendCanvas");
  const ctx = canvas.getContext("2d");
  document.getElementById("chartTitle").textContent = `${selectedTrendSymbol} 分时走势`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    isFetchingTrend = true;
    const res = await fetch(`/api/trends?symbol=${selectedTrendSymbol}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "获取趋势失败");
    const points = downsamplePoints((data.points || []).filter((p) => Number.isFinite(p.price)), 220);
    if (!points.length) throw new Error("暂无曲线数据");
    const prices = points.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const pad = 24;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = pad + (i / (points.length - 1 || 1)) * w;
      const y = pad + ((max - p.price) / (max - min || 1)) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = "#64748b";
    ctx.font = "12px sans-serif";
    ctx.fillText(`最低 ${min.toFixed(2)} / 最高 ${max.toFixed(2)}`, pad, canvas.height - 8);
  } catch (error) {
    ctx.fillStyle = "#dc2626";
    ctx.font = "14px sans-serif";
    ctx.fillText(`趋势加载失败：${error.message}`, 20, 40);
  } finally {
    isFetchingTrend = false;
  }
}

function trade(type) {
  const symbol = symbolSelect.value;
  const qty = Number(qtyInput.value);
  const quote = quoteBySymbol(symbol);
  if (!symbol || !quote) return alert("请选择有效股票");
  if (!Number.isInteger(qty) || qty <= 0) return alert("数量需要是正整数");
  const cost = quote.price * qty;

  if (!account.positions[symbol]) account.positions[symbol] = [];
  if (type === "buy") {
    if (account.cash < cost) return alert("现金不足，买入失败");
    account.cash -= cost;
    account.positions[symbol].push({
      id: `${symbol}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      qty,
      buyPrice: quote.price,
      buyAt: new Date().toISOString()
    });
    account.trades.unshift({ type: "buy", symbol, qty, price: quote.price, at: new Date().toISOString() });
  } else {
    let need = qty;
    const lots = account.positions[symbol];
    const totalQty = lots.reduce((s, l) => s + l.qty, 0);
    if (totalQty < qty) return alert("持仓不足，卖出失败");
    for (let i = 0; i < lots.length && need > 0; i += 1) {
      const lot = lots[i];
      const used = Math.min(lot.qty, need);
      lot.qty -= used;
      need -= used;
    }
    account.positions[symbol] = lots.filter((l) => l.qty > 0);
    if (!account.positions[symbol].length) delete account.positions[symbol];
    account.cash += quote.price * qty;
    account.trades.unshift({ type: "sell", symbol, qty, price: quote.price, at: new Date().toISOString() });
  }
  saveAccount();
  renderHoldingsTable();
  renderAssetSummary();
  submitScore();
}

function buildAdvice() {
  const risk = document.getElementById("riskLevel").value;
  const hv = calcHoldingsValue();
  const total = account.cash + hv;
  const adviceText = document.getElementById("adviceText");
  const profile = {
    ageGroup: document.getElementById("ageGroup").value,
    goalType: document.getElementById("goalType").value,
    drawdownLevel: document.getElementById("drawdownLevel").value,
    horizon: document.getElementById("horizon").value
  };
  adviceText.innerHTML = "<p>AI 正在根据你的画像生成建议...</p>";

  fetch("/api/ai-advice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      riskLevel: risk,
      profile,
      cash: account.cash,
      holdingsValue: hv,
      totalValue: total,
      topHoldings: Object.keys(aggregatePositions())
    })
  })
    .then((r) => r.json())
    .then((data) => {
      const text = Array.isArray(data.text) ? data.text : [];
      adviceText.innerHTML = text.length
        ? text.map((t, i) => `<p>${i + 1}) ${t}</p>`).join("")
        : "<p>暂无建议，请稍后再试。</p>";
    })
    .catch(() => {
      adviceText.innerHTML = "<p>建议生成失败，请稍后重试。</p>";
    });
}

function forecast() {
  const rate = Number(document.getElementById("rateInput").value) / 100;
  const years = Number(document.getElementById("yearsInput").value);
  const now = account.cash + calcHoldingsValue();
  if (!Number.isFinite(rate) || !Number.isInteger(years) || years < 1) return alert("请输入正确参数");
  const future = now * (1 + rate) ** years;
  document.getElementById("forecastText").textContent =
    `如果你现在有 ${money(now)}，按年化 ${(rate * 100).toFixed(1)}% 模拟 ${years} 年，理论可到 ${money(future)}。`;
}

function renderWatchlist() {
  const wrap = document.getElementById("watchlistWrap");
  wrap.innerHTML = watchlist.map((s) => `<span class="pill">${s}<button data-remove="${s}" title="移除">x</button></span>`).join("");
  wrap.querySelectorAll("button[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const symbol = btn.dataset.remove;
      watchlist = watchlist.filter((s) => s !== symbol);
      compareSymbols = compareSymbols.filter((s) => s !== symbol);
      if (!watchlist.length) watchlist = [...DEFAULT_WATCHLIST];
      saveWatchlist();
      fetchQuotes();
    });
  });
}

function renderSearchResults() {
  const wrap = document.getElementById("searchResultWrap");
  if (!searchResults.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML = searchResults.map((item) => `
    <div class="search-item">
      <div><strong>${item.symbol}</strong> <span class="muted">${item.name}</span></div>
      <button class="btn" data-add="${item.symbol}">加入自选</button>
    </div>
  `).join("");
  wrap.querySelectorAll("button[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const symbol = btn.dataset.add;
      if (!watchlist.includes(symbol)) watchlist.unshift(symbol);
      watchlist = watchlist.slice(0, 30);
      saveWatchlist();
      fetchQuotes();
    });
  });
}

async function handleSearch() {
  const input = document.getElementById("searchInput");
  const keyword = String(input.value || "").trim();
  if (!keyword) return alert("请输入代码或名称");
  try {
    const res = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    const data = await res.json();
    searchResults = data.items || [];
    renderSearchResults();
    if (!searchResults.length) alert("没找到对应股票");
  } catch {
    alert("搜索失败，请稍后重试");
  }
}

function handleLogin() {
  const input = document.getElementById("usernameInput");
  const name = String(input.value || "").trim();
  if (!name) return alert("请输入昵称");
  username = name.slice(0, 20);
  localStorage.setItem(USER_KEY, username);
  document.getElementById("currentUser").textContent = `当前玩家：${username}`;
  input.value = "";
  submitScore();
  renderRanking();
}

async function submitScore() {
  if (!username) return;
  const total = account.cash + calcHoldingsValue();
  await fetch("/api/leaderboard/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, totalValue: total })
  });
}

async function renderRanking() {
  const wrap = document.getElementById("rankWrap");
  wrap.innerHTML = "<p>排行榜加载中...</p>";
  try {
    await submitScore();
    const res = await fetch("/api/leaderboard");
    const data = await res.json();
    const rows = data.ranking || [];
    if (!rows.length) {
      wrap.innerHTML = "<p class='muted'>暂无玩家上榜。</p>";
      return;
    }
    wrap.innerHTML = `<table><thead><tr><th>排名</th><th>昵称</th><th>总资产</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${r.username}</td><td>${money(r.totalValue)}</td></tr>`).join("")}
    </tbody></table>`;
  } catch {
    wrap.innerHTML = "<p class='red'>排行榜加载失败</p>";
  }
}

function renderDailyLearn() {
  const tips = [
    "年轻投资者的核心优势是时间，优先形成长期复利习惯。",
    "遇到连续亏损时，先减仓并复盘，不要靠加仓赌反弹。",
    "你最好的投资策略，必须是你能长期执行的策略。",
    "投资不是比谁赚得快，而是比谁活得久。",
    "当你说不清公司怎么赚钱时，先别买。",
    "先学风控再学进攻：每次交易先设最大亏损，再设目标收益。",
    "分散不是买很多，而是避免仓位高度同涨同跌。",
    "不要把短期上涨当成能力，要看一个月后的回撤控制。",
    "看不懂财报时，优先关注营收增长、利润率、现金流三个指标。",
    "连续三次冲动交易后，强制休息一天再操作。",
    "赚钱时少自满，亏钱时少自责，坚持复盘才会进步。",
    "你不需要每次都交易，不交易也是一种决策。",
    "投资记录里要写‘为什么买’，否则无法复盘和提升。",
    "看到大涨想追高时，先问自己：如果明天回撤5%，我能接受吗？",
    "把仓位当弹药，留现金就是给未来机会留余地。"
  ];
  tipIndex = Math.floor(Date.now() / 86400000) % tips.length;
  document.getElementById("dailyTipText").textContent = tips[tipIndex];
  document.getElementById("prevTipBtn").onclick = () => {
    tipIndex = (tipIndex - 1 + tips.length) % tips.length;
    document.getElementById("dailyTipText").textContent = tips[tipIndex];
  };
  document.getElementById("nextTipBtn").onclick = () => {
    tipIndex = (tipIndex + 1) % tips.length;
    document.getElementById("dailyTipText").textContent = tips[tipIndex];
  };
  const defaultTasks = ["完成一次真实搜索并加入自选", "建立至少2笔买入记录", "观察一笔持仓3天以上收益变化", "完成一次投资者测评并生成建议", "比较至少3支股票涨跌"];
  const stored = JSON.parse(localStorage.getItem(TASK_KEY) || "{}");
  const list = document.getElementById("taskList");
  list.innerHTML = defaultTasks.map((task, i) => {
    const done = Boolean(stored[i]);
    return `<div class="task-item ${done ? "done" : ""}">
      <div>${task}</div>
      <button class="task-done-btn" data-task-btn="${i}" ${done ? "disabled" : ""}>${done ? "已完成" : "完成任务"}</button>
    </div>`;
  }).join("");
  list.querySelectorAll("button[data-task-btn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.taskBtn;
      if (stored[id]) return;
      stored[id] = true;
      localStorage.setItem(TASK_KEY, JSON.stringify(stored));
      btn.textContent = "已完成";
      btn.disabled = true;
      btn.closest(".task-item")?.classList.add("done");
      celebrateTaskDone();
      showToast("任务完成！恭喜你离理财高手更近一步！");
    });
  });
}

function celebrateTaskDone() {
  const layer = document.getElementById("moneyRainLayer");
  const icons = ["💰", "🧧", "🪙", "💴", "💵"];
  for (let i = 0; i < 26; i += 1) {
    const chip = document.createElement("span");
    chip.className = "money-chip";
    chip.textContent = icons[Math.floor(Math.random() * icons.length)];
    chip.style.left = `${Math.random() * 100}%`;
    chip.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    chip.style.animationDelay = `${Math.random() * 0.35}s`;
    layer.appendChild(chip);
    setTimeout(() => chip.remove(), 4200);
  }
}

function showToast(text) {
  const toast = document.createElement("div");
  toast.textContent = text;
  toast.style.position = "fixed";
  toast.style.bottom = "24px";
  toast.style.left = "50%";
  toast.style.transform = "translateX(-50%)";
  toast.style.background = "#b45309";
  toast.style.color = "#fff";
  toast.style.padding = "10px 14px";
  toast.style.borderRadius = "10px";
  toast.style.zIndex = "10000";
  toast.style.boxShadow = "0 8px 20px rgba(0,0,0,0.15)";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1900);
}

function bindEvents() {
  document.getElementById("refreshBtn").addEventListener("click", fetchQuotes);
  document.getElementById("buyBtn").addEventListener("click", () => trade("buy"));
  document.getElementById("sellBtn").addEventListener("click", () => trade("sell"));
  document.getElementById("adviceBtn").addEventListener("click", buildAdvice);
  document.getElementById("forecastBtn").addEventListener("click", forecast);
  document.getElementById("searchBtn").addEventListener("click", handleSearch);
  document.getElementById("loadDefaultBtn").addEventListener("click", () => {
    watchlist = [...DEFAULT_WATCHLIST];
    saveWatchlist();
    fetchQuotes();
  });
  document.getElementById("loginBtn").addEventListener("click", handleLogin);
  document.getElementById("refreshRankBtn").addEventListener("click", renderRanking);
  document.getElementById("compareRefreshBtn").addEventListener("click", renderCompareChart);
  document.getElementById("compareRange").addEventListener("change", renderCompareChart);
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (!window.confirm("确定重置账户吗？")) return;
    account = { cash: INITIAL_CASH, positions: {}, trades: [] };
    saveAccount();
    renderHoldingsTable();
    renderAssetSummary();
    submitScore();
  });
  document.getElementById("themeBtn").addEventListener("click", () => document.body.classList.toggle("dark"));
  document.getElementById("uiBtn").addEventListener("click", () => document.body.classList.toggle("fancy"));
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "market") {
        renderCompareChart();
        renderTrend();
      }
    });
  });
}

function init() {
  bindEvents();
  document.getElementById("currentUser").textContent = username ? `当前玩家：${username}` : "未登录";
  renderDailyLearn();
  renderWatchlist();
  renderRanking();
  renderAssetSummary();
  renderHoldingsTable();
  fetchQuotes();
  setInterval(() => {
    if (!isMarketTabActive()) return;
    fetchQuotes();
  }, 90000);
}
init();
