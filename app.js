(() => {
  "use strict";

  const L = window.LottoLogic;

  const DATA_URLS = [
    "https://smok95.github.io/lotto/results/all.json",
    "https://raw.githubusercontent.com/smok95/lotto/master/results/all.json",
  ];
  const CACHE_KEY = "lotto-data-v2";
  const FILTER_KEY = "lotto-filters-v1";
  const TOTAL_NUMBERS = 45;

  const grid = document.getElementById("number-grid");
  const excludedCountEl = document.getElementById("excluded-count");
  const autoBtn = document.getElementById("auto-btn");
  const clearBtn = document.getElementById("clear-btn");
  const drawBtn = document.getElementById("draw-btn");
  const gameCountSelect = document.getElementById("game-count-select");
  const resultCard = document.getElementById("result-card");
  const resultsEl = document.getElementById("results");
  const copyBtn = document.getElementById("copy-btn");
  const toastEl = document.getElementById("toast");
  const dataStatusEl = document.getElementById("data-status");
  const analysisBody = document.getElementById("analysis-body");
  const poolListEl = document.getElementById("pool-list");
  const filterListEl = document.getElementById("filter-list");
  const filterCountEl = document.getElementById("filter-count");
  const filterAllBtn = document.getElementById("filter-all-btn");
  const filterNoneBtn = document.getElementById("filter-none-btn");

  let rows = null;      // 당첨 이력
  let info = null;      // analyze() 결과
  let excluded = new Set();
  let enabledFilters = loadFilters();
  let lastResults = [];
  let toastTimer = null;

  // ----------------------------------------------------------
  // 필터 조건 on/off
  // ----------------------------------------------------------
  function loadFilters() {
    const all = L.FILTER_STACK.map((f) => f.id);
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY));
      if (Array.isArray(saved)) {
        return new Set(saved.filter((id) => all.includes(id)));
      }
    } catch (e) { /* 손상된 저장값 무시 */ }
    return new Set(all); // 기본: 전체 켜짐
  }

  function saveFilters() {
    localStorage.setItem(FILTER_KEY, JSON.stringify([...enabledFilters]));
  }

  function renderFilters() {
    filterListEl.innerHTML = "";
    for (const f of L.FILTER_STACK) {
      const label = document.createElement("label");
      label.className = "filter-item";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = enabledFilters.has(f.id);
      cb.addEventListener("change", () => {
        if (cb.checked) enabledFilters.add(f.id);
        else enabledFilters.delete(f.id);
        saveFilters();
        updateFilterCount();
      });

      const body = document.createElement("span");
      body.className = "filter-text";
      body.innerHTML = `<strong>${f.name}</strong><small>${f.desc}</small>`;

      label.appendChild(cb);
      label.appendChild(body);
      filterListEl.appendChild(label);
    }
    updateFilterCount();
  }

  function updateFilterCount() {
    filterCountEl.textContent = `${enabledFilters.size}/${L.FILTER_STACK.length}개 적용`;
  }

  function setAllFilters(on) {
    enabledFilters = on ? new Set(L.FILTER_STACK.map((f) => f.id)) : new Set();
    saveFilters();
    renderFilters();
    showToast(on ? "모든 조건을 켰습니다" : "모든 조건을 껐습니다 — 순수 랜덤 추첨");
  }

  // ----------------------------------------------------------
  // 데이터 로드: 캐시 즉시 반영 → 온라인 갱신
  // ----------------------------------------------------------
  function loadCache() {
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (Array.isArray(saved) && saved.length > 0) {
        return L.toRows(saved.map(([no, nums, bonus]) => ({ draw_no: no, numbers: nums, bonus_no: bonus })));
      }
    } catch (e) { /* 손상된 캐시 무시 */ }
    return null;
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(data.map((it) => [it.draw_no, it.numbers, it.bonus_no])));
    } catch (e) { /* 저장 공간 부족 시 무시 */ }
  }

  async function fetchData() {
    for (const url of DATA_URLS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0 && data[data.length - 1].numbers) {
          return data;
        }
      } catch (e) { /* 다음 URL 시도 */ }
    }
    return null;
  }

  async function initData() {
    dataStatusEl.textContent = "당첨 데이터 불러오는 중…";

    const cached = loadCache();
    if (cached) applyData(cached, "캐시");

    const fresh = await fetchData();
    if (fresh) {
      const freshRows = L.toRows(fresh);
      if (!rows || freshRows[freshRows.length - 1].no > rows[rows.length - 1].no) {
        saveCache(fresh);
        applyData(freshRows, "온라인");
      } else {
        dataStatusEl.textContent = statusText("최신");
      }
    } else if (!rows) {
      // 데이터 없음: 수동 모드 (필터 스택은 그대로 적용됨)
      dataStatusEl.textContent = "데이터 수신 실패 — 수동 모드로 동작해요";
      analysisBody.innerHTML =
        '<p class="hint">당첨 이력을 불러오지 못해 자동 분석 없이 동작합니다. ' +
        "제외수를 직접 선택하면 필터 스택을 통과한 조합에서 추첨해 드려요.</p>";
      renderGrid();
    }
  }

  function statusText(tag) {
    return `${info.lastRound}회까지 분석 · ${tag}`;
  }

  function applyData(newRows, tag) {
    rows = newRows;
    info = L.analyze(rows);
    excluded = new Set(info.exclude);
    dataStatusEl.textContent = statusText(tag);
    renderAnalysis();
    renderGrid();
    resultCard.hidden = true;
  }

  // ----------------------------------------------------------
  // 렌더링
  // ----------------------------------------------------------
  function ballColorClass(n) {
    if (n <= 10) return "c1";
    if (n <= 20) return "c2";
    if (n <= 30) return "c3";
    if (n <= 40) return "c4";
    return "c5";
  }

  function miniBalls(nums) {
    return nums
      .map((n) => `<span class="ball mini ${ballColorClass(n)}">${n}</span>`)
      .join("");
  }

  function renderAnalysis() {
    const nxt = info.lastRound + 1;
    const rowsHtml = [
      ["예측 회차", `<strong>${nxt}회</strong> (${info.lastRound}회까지 반영)`],
      [`핫넘버 <small>최근 ${L.HOT_WINDOW}주</small>`, miniBalls(info.hot)],
      [`장기 미출수 <small>${L.COLD_WINDOW}주+ · 제외 금지</small>`,
        info.cold.length ? miniBalls(info.cold) : '<span class="none">없음</span>'],
      ["이월 후보 <small>직전 회차</small>", miniBalls(info.carryover)],
      ["고정수", info.fixed.length ? miniBalls(info.fixed) : '<span class="none">없음</span>'],
      ["자동 제외수 <small>과열 후 냉각</small>", miniBalls(info.exclude)],
    ]
      .map(
        ([label, value]) =>
          `<div class="analysis-row"><span class="analysis-label">${label}</span><span class="analysis-value">${value}</span></div>`
      )
      .join("");
    analysisBody.innerHTML = rowsHtml;

    poolListEl.innerHTML = [...info.pool.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([n, reason]) =>
          `<li><span class="ball mini ${ballColorClass(n)}">${n}</span><span class="pool-reason">${reason}</span></li>`
      )
      .join("");
  }

  function renderGrid() {
    const autoSet = info ? new Set(info.exclude) : new Set();
    const coldSet = info ? new Set(info.cold) : new Set();
    grid.innerHTML = "";
    for (let n = 1; n <= TOTAL_NUMBERS; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      let cls = "num-btn";
      if (excluded.has(n)) cls += autoSet.has(n) ? " excluded auto" : " excluded";
      if (coldSet.has(n)) cls += " cold";
      btn.className = cls;
      btn.textContent = n;
      btn.setAttribute("aria-pressed", excluded.has(n));
      if (coldSet.has(n)) btn.title = "장기 미출수 — 제외 불가";
      btn.addEventListener("click", () => toggleNumber(n));
      grid.appendChild(btn);
    }
    updateExcludedCount();
  }

  function updateExcludedCount() {
    excludedCountEl.textContent = `${excluded.size}개 제외`;
  }

  function toggleNumber(n) {
    if (excluded.has(n)) {
      excluded.delete(n);
    } else {
      if (info && info.cold.includes(n)) {
        showToast("장기 미출수는 제외할 수 없어요 (전략 가드)");
        return;
      }
      if (excluded.size >= L.MAX_EXCLUDE) {
        showToast(`전략상 제외수는 최대 ${L.MAX_EXCLUDE}개까지예요`);
        return;
      }
      if (info && info.pool.has(n)) {
        showToast("추천 풀 번호예요 — 제외는 비권장이지만 반영할게요");
      }
      excluded.add(n);
    }
    renderGrid();
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  // ----------------------------------------------------------
  // 추첨
  // ----------------------------------------------------------
  function handleDraw() {
    const allowed = [];
    for (let n = 1; n <= TOTAL_NUMBERS; n++) if (!excluded.has(n)) allowed.push(n);
    if (allowed.length < L.PICK_COUNT) {
      showToast("남은 번호가 6개 미만입니다. 제외수를 줄여주세요.");
      return;
    }

    const gameCount = parseInt(gameCountSelect.value, 10);
    const games = L.pickGames(allowed, info, gameCount, enabledFilters);

    lastResults = games;
    resultsEl.innerHTML = "";
    for (const g of games) {
      const row = document.createElement("div");
      row.className = "result-row";

      const label = document.createElement("span");
      label.className = "result-label";
      label.textContent = g.label;
      row.appendChild(label);

      const wrap = document.createElement("div");
      wrap.className = "result-body";

      const balls = document.createElement("div");
      balls.className = "balls";
      for (const n of g.numbers) {
        const ball = document.createElement("span");
        ball.className = `ball ${ballColorClass(n)}`;
        ball.textContent = n;
        balls.appendChild(ball);
      }
      wrap.appendChild(balls);

      const meta = document.createElement("span");
      meta.className = "result-meta";
      meta.textContent = `합 ${g.numbers.reduce((a, b) => a + b, 0)} · AC ${L.acValue(g.numbers)}`;
      wrap.appendChild(meta);

      row.appendChild(wrap);
      resultsEl.appendChild(row);
    }

    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function handleCopy() {
    if (lastResults.length === 0) return;
    const text = lastResults
      .map((g) => `[${g.label}] ${g.numbers.join(", ")}`)
      .join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => showToast("번호가 복사되었습니다"))
      .catch(() => showToast("복사에 실패했습니다"));
  }

  function handleAuto() {
    if (!info) {
      showToast("당첨 데이터가 없어 자동 제외수를 만들 수 없어요");
      return;
    }
    excluded = new Set(info.exclude);
    renderGrid();
    showToast("자동 제외수를 다시 적용했습니다");
  }

  function handleClear() {
    excluded.clear();
    renderGrid();
    showToast("제외수를 모두 해제했습니다");
  }

  autoBtn.addEventListener("click", handleAuto);
  clearBtn.addEventListener("click", handleClear);
  drawBtn.addEventListener("click", handleDraw);
  copyBtn.addEventListener("click", handleCopy);
  filterAllBtn.addEventListener("click", () => setAllFilters(true));
  filterNoneBtn.addEventListener("click", () => setAllFilters(false));

  renderFilters();
  renderGrid();
  initData();
})();
