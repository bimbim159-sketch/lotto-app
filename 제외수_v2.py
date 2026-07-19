# -*- coding: utf-8 -*-
"""
제외수 v2 — 필터 스택 + 보존율 검증 통합판
=============================================
전략 5가지 통합:
  [1] 제외수 5~8개 제한 + 장기 미출수 제외 금지 (자동 가드)
  [2] 넓은 필터 → 좁은 필터 순서 스택 (총합→홀짝→고저→AC→동끝수→연번)
  [3] 고정수 최대 2개 + 제외수 중심 구조
  [4] 가설별 게임 분산 (핫/이월 3게임 + 미출포함 1게임 + 자동 1게임)
  [5] 비인기 조합 가중 (32~45 최소 2개, 생일수 몰빵 배제)

추가 기능:
  - 필터별 조합 감소량 + "역대 1등 보존율" 동시 출력
  - 최근 20회 롤링 백테스트: 매회 '그 직전까지 데이터'로 파이프라인을
    돌렸다면 정답이 살아남았는지 기록 → 보존율_로그.csv 누적
"""

import os
import json
import random
import urllib.request
from itertools import combinations
from collections import Counter

# ============================================================
# 설정
# ============================================================
DATA_URLS = [
    "https://smok95.github.io/lotto/results/all.json",
    "https://raw.githubusercontent.com/smok95/lotto/master/results/all.json",
]
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(BASE_DIR, "lotto_all.json")
LOG_PATH = os.path.join(BASE_DIR, "보존율_로그.csv")

HOT_WINDOW = 16          # 핫넘버 집계 기간 (주)
COLD_WINDOW = 15         # 이 기간 이상 미출이면 '장기 미출수'
MAX_EXCLUDE = 8          # 제외수 상한 (전략1)
MIN_EXCLUDE = 5          # 제외수 하한
MAX_FIXED = 2            # 고정수 상한 (전략3)
BACKTEST_ROUNDS = 20     # 롤링 백테스트 회차 수
GAMES = 5                # 최종 생성 게임 수
SEED = None              # 재현 원하면 정수 입력 (예: 42)

# 필터 스택 (전략2): 넓은 것 → 좁은 것 순서
FILTER_STACK = [
    ("총합 100~175",  lambda c: 100 <= sum(c) <= 175),
    ("홀짝 2:4~4:2",  lambda c: 2 <= sum(1 for n in c if n % 2) <= 4),
    ("고저 2:4~4:2",  lambda c: 2 <= sum(1 for n in c if n <= 22) <= 4),
    ("AC값 7 이상",   lambda c: ac_value(c) >= 7),
    ("동끝수 2개 이하", lambda c: max(Counter(n % 10 for n in c).values()) <= 2),
    ("연번 2연속 이하", lambda c: max_consecutive(c) <= 2),
]


def ac_value(combo):
    diffs = {b - a for a, b in combinations(sorted(combo), 2)}
    return len(diffs) - 5


def max_consecutive(combo):
    s = sorted(combo)
    best = run = 1
    for i in range(1, 6):
        run = run + 1 if s[i] == s[i - 1] + 1 else 1
        best = max(best, run)
    return best


# ============================================================
# [1] 데이터 로드
# ============================================================
def load_data():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        print(f"캐시 로드: {len(data)}회차 (최신 {data[-1]['draw_no']}회)")
        # 캐시가 오래됐으면 갱신 시도
        return refresh_if_stale(data)
    return fetch_all()


def fetch_all():
    for url in DATA_URLS:
        try:
            print(f"다운로드 중: {url}")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            with open(CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(data, f)
            print(f"  ✓ {len(data)}회차 수신 (최신 {data[-1]['draw_no']}회)")
            return data
        except Exception as e:
            print(f"  ! 실패: {e}")
    raise SystemExit("[중단] 데이터 수집 실패")


def refresh_if_stale(cached):
    try:
        fresh = fetch_all()
        if fresh[-1]["draw_no"] > cached[-1]["draw_no"]:
            print(f"  → {fresh[-1]['draw_no']}회로 갱신됨")
            return fresh
    except SystemExit:
        pass
    return cached


def to_rows(data):
    """[(round, set(6개), bonus), ...] 오름차순"""
    rows = []
    for it in data:
        rows.append((it["draw_no"], frozenset(it["numbers"]), it["bonus_no"]))
    rows.sort(key=lambda x: x[0])
    return rows


# ============================================================
# [2] 분석: 핫넘버 / 미출수 / 이월 / 제외수 후보
# ============================================================
def analyze(rows, upto_idx=None):
    """upto_idx: 이 인덱스 '이전'까지만 사용 (백테스트용). None이면 전체."""
    hist = rows[:upto_idx] if upto_idx is not None else rows
    recent = hist[-HOT_WINDOW:]
    last_draw = hist[-1]

    freq_recent = Counter()
    for _, nums, _ in recent:
        freq_recent.update(nums)

    # 각 번호의 '마지막 출현 후 경과 주'
    absence = {}
    for n in range(1, 46):
        gap = 0
        for _, nums, _ in reversed(hist):
            if n in nums:
                break
            gap += 1
        absence[n] = gap

    cold = sorted([n for n in range(1, 46) if absence[n] >= COLD_WINDOW])
    hot = [n for n, _ in freq_recent.most_common(6)]
    carryover = sorted(last_draw[1])  # 직전 회차 번호 (이월 후보)

    # 추천 풀을 먼저 확정 (제외수와의 모순 방지)
    pool = build_pool(hist, freq_recent, absence, carryover, cold)

    # 제외수 후보 (전략1): "최근에 많이 나왔다가 최근 4주는 식은 번호"
    #  = 과열 후 냉각. 미출수(cold)와 추천 풀 번호는 절대 넣지 않음.
    recent4 = hist[-4:]
    seen4 = set()
    for _, nums, _ in recent4:
        seen4 |= nums
    candidates = []
    for n in range(1, 46):
        if n in cold or n in seen4 or n in pool:
            continue  # 미출수·최근4주 출현·추천 풀 번호는 제외수 금지
        # 최근 창에서 2회 이상 나왔지만 4주째 안 나오는 번호 우선
        score = freq_recent[n] * 10 + absence[n]
        candidates.append((score, n))
    candidates.sort(reverse=True)
    exclude = sorted(n for _, n in candidates[:MIN_EXCLUDE + 1])[:MAX_EXCLUDE]
    exclude = exclude[:max(MIN_EXCLUDE, min(len(exclude), MAX_EXCLUDE))]

    # 고정수 (전략3): 핫넘버 최상위 2개, 단 제외수와 겹치면 스킵
    fixed = [n for n in hot if n not in exclude][:MAX_FIXED]

    return {
        "hot": hot, "cold": cold, "carryover": carryover,
        "exclude": exclude, "fixed": fixed,
        "freq_recent": freq_recent, "absence": absence,
        "last_round": last_draw[0], "pool": pool,
    }


# ============================================================
# [2.5] 추천 번호 풀 (이유 포함) — 매주 이것만 봐도 됨
# ============================================================
def build_pool(hist, freq, absence, last_nums, cold):
    """추천 풀 {번호: 이유} 계산. 제외수 선정보다 먼저 실행됨."""
    alltime = Counter()
    for _, nums, _ in hist:
        alltime.update(nums)
    top_alltime = [n for n, _ in alltime.most_common(8)]

    pool = {}

    # 1) 핫넘버: 최근 창에서 4회 이상
    for n in sorted(freq, key=lambda x: -freq[x]):
        if freq[n] >= 4:
            pool[n] = f"핫넘버 (최근{HOT_WINDOW}주 {freq[n]}회)"

    # 2) 이월 후보: 직전 회차 출현 + 최근 3회 이상
    for n in sorted(last_nums):
        if n not in pool and freq[n] >= 3:
            pool[n] = f"이월 후보 (직전 회차 출현 + 최근 {freq[n]}회)"

    # 3) 역대 다출현 중 최근 냉각 → 반등 후보
    for n in top_alltime:
        if n not in pool and freq[n] <= 1 and len(pool) < 11:
            pool[n] = f"역대 다출현 {alltime[n]}회 + 최근 냉각 → 반등"

    # 4) 장기 미출수 상위 3개
    colds = sorted(cold, key=lambda x: -absence[x])[:3]
    for n in colds:
        if n not in pool:
            pool[n] = f"장기 미출 ({absence[n]}주째)"

    # 5) 이웃수: 직전 번호 ±1 중 최근 2회 이상, 풀 15개까지 채움
    neigh = set()
    for n in last_nums:
        neigh |= {n - 1, n + 1}
    neigh = {n for n in neigh if 1 <= n <= 45} - set(last_nums)
    for n in sorted(neigh, key=lambda x: -freq[x]):
        if len(pool) >= 15:
            break
        if n not in pool and freq[n] >= 2:
            pool[n] = f"이웃수 (직전 번호 ±1 + 최근 {freq[n]}회)"

    return pool


def print_pool(info):
    pool = info["pool"]
    print(f"\n[{info['last_round'] + 1}회 추천 풀 {len(pool)}개]")
    for n in sorted(pool):
        print(f"  {n:>2} — {pool[n]}")


# ============================================================
# [3] 필터 스택 적용 + 보존율 측정 (전략2)
# ============================================================
def run_filter_stack(rows, exclude):
    """전체 조합에 스택을 순서대로 적용.
    각 단계에서 (남은 조합 수, 역대 1등 보존율)을 출력."""
    winners = [nums for _, nums, _ in rows]
    ex = set(exclude)

    print("\n[필터 스택] 넓은 필터 → 좁은 필터 순서 적용")
    print(f"{'단계':<14}{'남은 조합':>12}{'역대1등 보존율':>14}")

    # 0단계: 제외수 적용
    pool_nums = [n for n in range(1, 46) if n not in ex]
    combos = list(combinations(pool_nums, 6))
    surv = [w for w in winners if not (w & ex)]
    print(f"{'제외수 적용':<14}{len(combos):>12,}{len(surv)/len(winners)*100:>13.1f}%")

    for name, fn in FILTER_STACK:
        combos = [c for c in combos if fn(c)]
        surv = [w for w in surv if fn(tuple(sorted(w)))]
        print(f"{name:<14}{len(combos):>12,}{len(surv)/len(winners)*100:>13.1f}%")

    return combos


# ============================================================
# [4] 게임 생성 (전략4 + 전략5)
# ============================================================
def unpopular_ok(combo):
    """전략5: 32~45 최소 2개 + 생일수(1~31)만으로 구성 금지"""
    high = sum(1 for n in combo if n >= 32)
    return high >= 2


def pick_games(pool, info, rng):
    hot_set = set(info["hot"])
    carry = set(info["carryover"])
    cold = set(info["cold"])
    fixed = set(info["fixed"])

    up = [c for c in pool if unpopular_ok(c)]
    print(f"\n[비인기 필터] 32~45 두 개 이상 조합: {len(up):,}개")

    games, used = [], set()

    def grab(cands, label, need=1):
        got = 0
        rng.shuffle(cands)
        for c in cands:
            if c in used:
                continue
            games.append((label, c))
            used.add(c)
            got += 1
            if got >= need:
                return True
        return False

    # A. 추천 풀 중심 3게임: 고정수 포함 + 풀 번호 3개 이상
    #    (나머지 자리는 풀 밖 번호로 자유롭게 → 놓친 수 커버)
    pool_set = set(info["pool"])
    a = [c for c in up if fixed <= set(c) and len(set(c) & pool_set) >= 3]
    grab(a, "풀3+", 3)

    # B. 미출수 포함 1게임: cold 1개 이상 포함
    b = [c for c in up if set(c) & cold]
    grab(b, "미출포함", 1)

    # C. 자동 1게임: 풀 전체에서 무작위
    grab(list(up), "자동", 1)

    return games


# ============================================================
# [5] 롤링 백테스트 → 보존율 로그 (핵심 추가 기능)
# ============================================================
def backtest(rows):
    """최근 BACKTEST_ROUNDS회에 대해:
    그 회차 '직전까지' 데이터로 제외수/필터를 만들었다면
    정답 6개 중 몇 개가 살아남았는지 + 정답 조합이 스택을 통과했는지."""
    print(f"\n[백테스트] 최근 {BACKTEST_ROUNDS}회 롤링 검증")
    print(f"{'회차':>6}{'제외수에 걸린 정답':>16}{'스택 통과':>10}{'생존/6':>8}")

    lines = ["round,killed_by_exclude,stack_pass,survived"]
    kill_counter = Counter()
    stack_pass_cnt = 0

    for i in range(len(rows) - BACKTEST_ROUNDS, len(rows)):
        rnd, answer, _ = rows[i]
        info = analyze(rows, upto_idx=i)
        ex = set(info["exclude"])

        killed = sorted(answer & ex)
        combo = tuple(sorted(answer))
        stack_ok = not killed and all(fn(combo) for _, fn in FILTER_STACK)
        survived = 6 - len(killed)

        kill_counter[len(killed)] += 1
        stack_pass_cnt += stack_ok
        mark = "통과" if stack_ok else "탈락"
        killed_str = ",".join(map(str, killed)) if killed else "-"
        print(f"{rnd:>6}{killed_str:>16}{mark:>9}{survived:>7}/6")
        lines.append(f"{rnd},{killed_str.replace(',', ' ')},{int(stack_ok)},{survived}")

    with open(LOG_PATH, "w", encoding="utf-8-sig") as f:
        f.write("\n".join(lines))

    n = BACKTEST_ROUNDS
    print(f"\n  제외수 무손실(정답 0개 제거): {kill_counter[0]}/{n}회 "
          f"({kill_counter[0]/n*100:.0f}%)")
    print(f"  전체 스택 통과(1등 가능 상태 유지): {stack_pass_cnt}/{n}회 "
          f"({stack_pass_cnt/n*100:.0f}%)")
    print(f"  로그 저장: {LOG_PATH}")


# ============================================================
# 메인
# ============================================================
def main():
    rng = random.Random(SEED)
    print("=" * 52)
    print(" 제외수 v2 — 필터 스택 + 보존율 검증")
    print("=" * 52)

    data = load_data()
    rows = to_rows(data)
    info = analyze(rows)
    nxt = info["last_round"] + 1

    print(f"\n[분석 기준] {info['last_round']}회까지 → {nxt}회 예측")
    print(f"  핫넘버(최근{HOT_WINDOW}주): {info['hot']}")
    print(f"  장기 미출수({COLD_WINDOW}주+): {info['cold']}  ← 제외 금지 대상")
    print(f"  이월 후보(직전 회차): {info['carryover']}")
    print(f"  고정수(최대{MAX_FIXED}개): {info['fixed']}")
    print(f"  제외수({len(info['exclude'])}개, 과열 후 냉각 번호): {info['exclude']}")

    # 가드: 제외수에 미출수 섞였는지 최종 확인 (전략1)
    bad = set(info["exclude"]) & set(info["cold"])
    if bad:
        raise SystemExit(f"[가드 발동] 제외수에 장기 미출수 포함: {sorted(bad)}")

    print_pool(info)

    pool = run_filter_stack(rows, info["exclude"])
    games = pick_games(pool, info, rng)

    print(f"\n[{nxt}회 추천 {GAMES}게임] (가설 분산)")
    for label, c in games:
        print(f"  [{label:<4}] {' '.join(f'{n:>2}' for n in sorted(c))}"
              f"  (합 {sum(c)}, AC {ac_value(c)})")

    backtest(rows)

    print("\n※ 조합당 1등 확률은 여전히 1/8,145,060입니다.")
    print("  이 스크립트가 하는 일은 '정답 보존율을 지키며 풀을 줄이고,")
    print("  당첨 시 나눠 갖지 않을 조합을 고르는 것'까지입니다.")


if __name__ == "__main__":
    main()
