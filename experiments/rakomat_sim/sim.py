"""Monte Carlo: one vending machine, 12 cells (1 cell = 1 pack), shelf life 5 days, Poisson demand in packs/day.
Policy: every T days top up to N packs (FIFO, expired packs removed). Reports write-off % of loaded packs and lost sales %."""
import random, math, itertools, json
SHELF, CELLS, DAYS, RUNS = 5, 12, 365, 40
def poisson(l, r):
    L, k, p = math.exp(-l), 0, 1.0
    while True:
        p *= r.random()
        if p <= L: return k
        k += 1
def sim(lam, T, N, seed=1):
    r = random.Random(seed); stock = []; sold = waste = lost = loaded = 0
    for d in range(DAYS * RUNS):
        stock = [a for a in stock]
        expired = [a for a in stock if d - a >= SHELF]; waste += len(expired); stock = [a for a in stock if d - a < SHELF]
        if d % T == 0:
            add = max(0, min(N, CELLS) - len(stock)); stock += [d] * add; loaded += add
        dem = poisson(lam, r); stock.sort()
        s = min(dem, len(stock)); sold += s; lost += dem - s; stock = stock[s:]
    return {"waste_pct": round(100 * waste / max(loaded, 1), 1), "lost_pct": round(100 * lost / max(sold + lost, 1), 1), "sold_day": round(sold / (DAYS * RUNS), 2)}
if __name__ == "__main__":
    rows = []
    for lam in [1, 2, 3, 5, 8]:
        best = None
        for T, N in itertools.product([1, 2, 3, 5], range(2, 13)):
            x = sim(lam, T, N); x.update(lam=lam, T=T, N=N)
            if x["waste_pct"] <= 5 and (best is None or x["sold_day"] > best["sold_day"]): best = x
        full5 = sim(lam, 5, 12); full5.update(lam=lam, T=5, N=12)
        full2 = sim(lam, 2, 12); full2.update(lam=lam, T=2, N=12)
        rows.append({"lam": lam, "full_every5": full5, "full_every2": full2, "best_waste_le5": best})
    print(json.dumps(rows, ensure_ascii=False, indent=1))
