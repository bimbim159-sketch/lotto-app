(() => {
  "use strict";

  const TOTAL_NUMBERS = 45;
  const PICK_COUNT = 6;
  const MAX_EXCLUDED = TOTAL_NUMBERS - PICK_COUNT; // 39
  const STORAGE_KEY = "lotto-excluded";

  const grid = document.getElementById("number-grid");
  const excludedCountEl = document.getElementById("excluded-count");
  const clearBtn = document.getElementById("clear-btn");
  const drawBtn = document.getElementById("draw-btn");
  const gameCountSelect = document.getElementById("game-count-select");
  const resultCard = document.getElementById("result-card");
  const resultsEl = document.getElementById("results");
  const copyBtn = document.getElementById("copy-btn");
  const toastEl = document.getElementById("toast");

  let excluded = loadExcluded();
  let lastResults = [];
  let toastTimer = null;

  function loadExcluded() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(saved)) {
        return new Set(
          saved.filter((n) => Number.isInteger(n) && n >= 1 && n <= TOTAL_NUMBERS)
        );
      }
    } catch (e) {
      /* 저장값이 손상된 경우 무시 */
    }
    return new Set();
  }

  function saveExcluded() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...excluded]));
  }

  function ballColorClass(n) {
    if (n <= 10) return "c1";
    if (n <= 20) return "c2";
    if (n <= 30) return "c3";
    if (n <= 40) return "c4";
    return "c5";
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2000);
  }

  function updateExcludedCount() {
    excludedCountEl.textContent = `${excluded.size}개 제외`;
  }

  // 번호판 생성
  function renderGrid() {
    grid.innerHTML = "";
    for (let n = 1; n <= TOTAL_NUMBERS; n++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "num-btn" + (excluded.has(n) ? " excluded" : "");
      btn.textContent = n;
      btn.setAttribute("aria-pressed", excluded.has(n));
      btn.addEventListener("click", () => toggleNumber(n, btn));
      grid.appendChild(btn);
    }
    updateExcludedCount();
  }

  function toggleNumber(n, btn) {
    if (excluded.has(n)) {
      excluded.delete(n);
    } else {
      if (excluded.size >= MAX_EXCLUDED) {
        showToast(`제외수는 최대 ${MAX_EXCLUDED}개까지 가능해요`);
        return;
      }
      excluded.add(n);
    }
    btn.classList.toggle("excluded");
    btn.setAttribute("aria-pressed", excluded.has(n));
    saveExcluded();
    updateExcludedCount();
  }

  // 암호학적 난수로 균등하게 뽑기 (Fisher–Yates 부분 셔플)
  function drawNumbers(pool) {
    const arr = [...pool];
    const picked = [];
    for (let i = 0; i < PICK_COUNT; i++) {
      const j = i + randomInt(arr.length - i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
      picked.push(arr[i]);
    }
    return picked.sort((a, b) => a - b);
  }

  function randomInt(max) {
    // 0 이상 max 미만의 균등 난수
    const limit = Math.floor(0xffffffff / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % max;
  }

  function handleDraw() {
    const pool = [];
    for (let n = 1; n <= TOTAL_NUMBERS; n++) {
      if (!excluded.has(n)) pool.push(n);
    }
    if (pool.length < PICK_COUNT) {
      showToast("남은 번호가 6개 미만입니다. 제외수를 줄여주세요.");
      return;
    }

    const gameCount = parseInt(gameCountSelect.value, 10);
    lastResults = [];
    resultsEl.innerHTML = "";

    const labels = ["A", "B", "C", "D", "E"];
    for (let g = 0; g < gameCount; g++) {
      const numbers = drawNumbers(pool);
      lastResults.push(numbers);

      const row = document.createElement("div");
      row.className = "result-row";

      const label = document.createElement("span");
      label.className = "result-label";
      label.textContent = labels[g];
      row.appendChild(label);

      const balls = document.createElement("div");
      balls.className = "balls";
      for (const n of numbers) {
        const ball = document.createElement("span");
        ball.className = `ball ${ballColorClass(n)}`;
        ball.textContent = n;
        balls.appendChild(ball);
      }
      row.appendChild(balls);
      resultsEl.appendChild(row);
    }

    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function handleCopy() {
    if (lastResults.length === 0) return;
    const text = lastResults
      .map((nums, i) => `${String.fromCharCode(65 + i)}: ${nums.join(", ")}`)
      .join("\n");
    navigator.clipboard
      .writeText(text)
      .then(() => showToast("번호가 복사되었습니다"))
      .catch(() => showToast("복사에 실패했습니다"));
  }

  function handleClear() {
    excluded.clear();
    saveExcluded();
    renderGrid();
    showToast("제외수를 초기화했습니다");
  }

  clearBtn.addEventListener("click", handleClear);
  drawBtn.addEventListener("click", handleDraw);
  copyBtn.addEventListener("click", handleCopy);

  renderGrid();
})();
