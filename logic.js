/*
 * 제외수_v2.py 의 분석/필터 로직 자바스크립트 이식판.
 * 브라우저(window.LottoLogic)와 Node(module.exports) 양쪽에서 동작한다.
 */
(function (global) {
  "use strict";

  const HOT_WINDOW = 16;   // 핫넘버 집계 기간 (주)
  const COLD_WINDOW = 15;  // 이 기간 이상 미출이면 '장기 미출수'
  const MIN_EXCLUDE = 5;   // 제외수 하한
  const MAX_EXCLUDE = 8;   // 제외수 상한
  const MAX_FIXED = 2;     // 고정수 상한
  const PICK_COUNT = 6;
  const MAX_TRIES = 30000; // 게임당 리젝션 샘플링 시도 상한

  // ----------------------------------------------------------
  // 필터 스택: 넓은 필터 → 좁은 필터 순서
  // ----------------------------------------------------------
  function acValue(combo) {
    const s = [...combo].sort((a, b) => a - b);
    const diffs = new Set();
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) diffs.add(s[j] - s[i]);
    }
    return diffs.size - 5;
  }

  function maxConsecutive(combo) {
    const s = [...combo].sort((a, b) => a - b);
    let best = 1;
    let run = 1;
    for (let i = 1; i < s.length; i++) {
      run = s[i] === s[i - 1] + 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }

  const FILTER_STACK = [
    { name: "총합 100~175", fn: (c) => { const s = c.reduce((a, b) => a + b, 0); return s >= 100 && s <= 175; } },
    { name: "홀짝 2:4~4:2", fn: (c) => { const odd = c.filter((n) => n % 2).length; return odd >= 2 && odd <= 4; } },
    { name: "고저 2:4~4:2", fn: (c) => { const low = c.filter((n) => n <= 22).length; return low >= 2 && low <= 4; } },
    { name: "AC값 7 이상", fn: (c) => acValue(c) >= 7 },
    { name: "동끝수 2개 이하", fn: (c) => {
      const cnt = new Array(10).fill(0);
      let max = 0;
      for (const n of c) { const t = ++cnt[n % 10]; if (t > max) max = t; }
      return max <= 2;
    } },
    { name: "연번 2연속 이하", fn: (c) => maxConsecutive(c) <= 2 },
  ];

  function passesStack(combo) {
    return FILTER_STACK.every((f) => f.fn(combo));
  }

  // 비인기 조합 필터: 32~45 최소 2개 (생일수 몰빵 배제)
  function unpopularOk(combo) {
    return combo.filter((n) => n >= 32).length >= 2;
  }

  // ----------------------------------------------------------
  // 분석: 핫넘버 / 미출수 / 이월 / 추천 풀 / 제외수
  // rows: [{ no, nums: number[], set: Set }] 회차 오름차순
  // ----------------------------------------------------------
  function buildPool(hist, freq, absence, lastNums, cold) {
    const alltime = new Array(46).fill(0);
    for (const r of hist) for (const n of r.nums) alltime[n]++;

    const range = [];
    for (let n = 1; n <= 45; n++) range.push(n);

    const topAlltime = range
      .filter((n) => alltime[n] > 0)
      .sort((a, b) => alltime[b] - alltime[a] || a - b)
      .slice(0, 8);

    const pool = new Map();

    // 1) 핫넘버: 최근 창에서 4회 이상
    const byFreq = range
      .filter((n) => freq[n] > 0)
      .sort((a, b) => freq[b] - freq[a] || a - b);
    for (const n of byFreq) {
      if (freq[n] >= 4) pool.set(n, `핫넘버 (최근${HOT_WINDOW}주 ${freq[n]}회)`);
    }

    // 2) 이월 후보: 직전 회차 출현 + 최근 3회 이상
    for (const n of [...lastNums].sort((a, b) => a - b)) {
      if (!pool.has(n) && freq[n] >= 3) {
        pool.set(n, `이월 후보 (직전 회차 출현 + 최근 ${freq[n]}회)`);
      }
    }

    // 3) 역대 다출현 중 최근 냉각 → 반등 후보
    for (const n of topAlltime) {
      if (!pool.has(n) && freq[n] <= 1 && pool.size < 11) {
        pool.set(n, `역대 다출현 ${alltime[n]}회 + 최근 냉각 → 반등`);
      }
    }

    // 4) 장기 미출수 상위 3개
    const colds = [...cold].sort((a, b) => absence[b] - absence[a] || a - b).slice(0, 3);
    for (const n of colds) {
      if (!pool.has(n)) pool.set(n, `장기 미출 (${absence[n]}주째)`);
    }

    // 5) 이웃수: 직전 번호 ±1 중 최근 2회 이상, 풀 15개까지
    const lastSet = new Set(lastNums);
    const neigh = new Set();
    for (const n of lastNums) { neigh.add(n - 1); neigh.add(n + 1); }
    const neighArr = [...neigh]
      .filter((n) => n >= 1 && n <= 45 && !lastSet.has(n))
      .sort((a, b) => freq[b] - freq[a] || a - b);
    for (const n of neighArr) {
      if (pool.size >= 15) break;
      if (!pool.has(n) && freq[n] >= 2) {
        pool.set(n, `이웃수 (직전 번호 ±1 + 최근 ${freq[n]}회)`);
      }
    }

    return pool;
  }

  function analyze(rows) {
    const hist = rows;
    const recent = hist.slice(-HOT_WINDOW);
    const last = hist[hist.length - 1];

    const freq = new Array(46).fill(0);
    for (const r of recent) for (const n of r.nums) freq[n]++;

    // 각 번호의 '마지막 출현 후 경과 주'
    const absence = new Array(46).fill(0);
    for (let n = 1; n <= 45; n++) {
      let gap = 0;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].set.has(n)) break;
        gap++;
      }
      absence[n] = gap;
    }

    const cold = [];
    for (let n = 1; n <= 45; n++) if (absence[n] >= COLD_WINDOW) cold.push(n);

    const hot = [];
    for (let n = 1; n <= 45; n++) if (freq[n] > 0) hot.push(n);
    hot.sort((a, b) => freq[b] - freq[a] || a - b);
    hot.length = Math.min(hot.length, 6);

    const carryover = [...last.nums].sort((a, b) => a - b);

    // 추천 풀을 먼저 확정 (제외수와의 모순 방지)
    const pool = buildPool(hist, freq, absence, last.nums, cold);

    // 제외수 후보: 과열 후 냉각 번호.
    // 미출수·최근 4주 출현·추천 풀 번호는 제외수 금지.
    const seen4 = new Set();
    for (const r of hist.slice(-4)) for (const n of r.nums) seen4.add(n);
    const coldSet = new Set(cold);

    const candidates = [];
    for (let n = 1; n <= 45; n++) {
      if (coldSet.has(n) || seen4.has(n) || pool.has(n)) continue;
      candidates.push([freq[n] * 10 + absence[n], n]);
    }
    candidates.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const exclude = candidates
      .slice(0, MIN_EXCLUDE + 1)
      .map((x) => x[1])
      .sort((a, b) => a - b)
      .slice(0, MAX_EXCLUDE);

    // 고정수: 핫넘버 최상위, 제외수와 겹치면 스킵
    const exSet = new Set(exclude);
    const fixed = hot.filter((n) => !exSet.has(n)).slice(0, MAX_FIXED);

    return {
      lastRound: last.no,
      hot, cold, carryover, exclude, fixed,
      pool, freq, absence,
    };
  }

  // ----------------------------------------------------------
  // 균등 난수 + 조합 샘플링
  // ----------------------------------------------------------
  function randomInt(max) {
    const limit = Math.floor(0xffffffff / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do {
      (globalThis.crypto || require("crypto").webcrypto).getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % max;
  }

  function sampleCombo(allowed) {
    const arr = [...allowed];
    const picked = [];
    for (let i = 0; i < PICK_COUNT; i++) {
      const j = i + randomInt(arr.length - i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
      picked.push(arr[i]);
    }
    return picked.sort((a, b) => a - b);
  }

  // ----------------------------------------------------------
  // 게임 생성: 가설 분산 (풀3+ / 미출포함 / 자동)
  // 리젝션 샘플링 = 조건을 만족하는 전체 조합에서 균등 추첨과 동일
  // ----------------------------------------------------------
  function pickGames(allowed, info, count) {
    const games = [];
    const used = new Set();

    const poolSet = info ? new Set(info.pool.keys()) : new Set();
    const coldSet = info ? new Set(info.cold) : new Set();
    const allowedSet = new Set(allowed);
    const fixed = info ? info.fixed.filter((n) => allowedSet.has(n)) : [];

    const poolCount = (c) => c.filter((n) => poolSet.has(n)).length;
    const hasFixed = (c) => fixed.length > 0 && fixed.every((n) => c.includes(n));

    function pickOne(chain) {
      for (const { label, pred } of chain) {
        for (let t = 0; t < MAX_TRIES; t++) {
          const c = sampleCombo(allowed);
          if (pred && !pred(c)) continue;
          if (!passesStack(c) || !unpopularOk(c)) continue;
          const key = c.join(",");
          if (used.has(key)) continue;
          used.add(key);
          return { label, numbers: c };
        }
      }
      // 최후 수단: 필터 없이 중복만 피해서 추첨
      for (let t = 0; t < MAX_TRIES; t++) {
        const c = sampleCombo(allowed);
        const key = c.join(",");
        if (used.has(key)) continue;
        used.add(key);
        return { label: "자동", numbers: c };
      }
      return null;
    }

    // 게임 수 배분: 5게임 = 풀3+ ×3, 미출포함 ×1, 자동 ×1
    const cCount = count >= 3 ? 1 : 0;
    const bCount = count >= 2 ? 1 : 0;
    const aCount = count - bCount - cCount;

    const aChain = info
      ? [
          { label: "풀3+", pred: (c) => hasFixed(c) && poolCount(c) >= 3 },
          { label: "풀3+", pred: (c) => poolCount(c) >= 3 },
          { label: "자동", pred: null },
        ]
      : [{ label: "자동", pred: null }];
    const bChain = info && info.cold.length > 0
      ? [
          { label: "미출포함", pred: (c) => c.some((n) => coldSet.has(n)) },
          { label: "자동", pred: null },
        ]
      : [{ label: "자동", pred: null }];
    const cChain = [{ label: "자동", pred: null }];

    const plan = [];
    for (let i = 0; i < aCount; i++) plan.push(aChain);
    for (let i = 0; i < bCount; i++) plan.push(bChain);
    for (let i = 0; i < cCount; i++) plan.push(cChain);

    for (const chain of plan) {
      const g = pickOne(chain);
      if (g) games.push(g);
    }
    return games;
  }

  // ----------------------------------------------------------
  // 데이터 정규화: all.json → rows
  // ----------------------------------------------------------
  function toRows(data) {
    const rows = data.map((it) => ({
      no: it.draw_no,
      nums: it.numbers,
      set: new Set(it.numbers),
    }));
    rows.sort((a, b) => a.no - b.no);
    return rows;
  }

  const LottoLogic = {
    HOT_WINDOW, COLD_WINDOW, MIN_EXCLUDE, MAX_EXCLUDE, MAX_FIXED, PICK_COUNT,
    FILTER_STACK, acValue, maxConsecutive, passesStack, unpopularOk,
    analyze, buildPool, pickGames, sampleCombo, randomInt, toRows,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = LottoLogic;
  } else {
    global.LottoLogic = LottoLogic;
  }
})(typeof window !== "undefined" ? window : globalThis);
