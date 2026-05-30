"""
Performance / load harness for the ERP backend.

Runs a *real* uvicorn server against an isolated, freshly-seeded SQLite DB,
then measures two things that matter for a self-hosted LAN ERP:

  1. LATENCY  — sequential timing of representative endpoints (p50/p95/p99/max).
  2. THROUGHPUT — concurrent workers hammering a read endpoint and a write
                  endpoint, reporting requests/sec, error rate and tail latency.

This is intentionally standalone (not a pytest file) so it never runs in CI by
accident and never touches the suite's _test_erp.db.

Usage:
    cd backend
    python perf_harness.py                 # defaults
    python perf_harness.py --seed 200 --duration 5 --concurrency 16
"""
import argparse
import os
import statistics
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

# ── Isolate BEFORE importing the backend (database.py reads DB_PATH at import) ─
_HERE   = os.path.dirname(os.path.abspath(__file__))
_PERFDB = os.path.join(_HERE, "_perf_erp.db")
os.environ["DB_PATH"]       = _PERFDB
os.environ.setdefault("SECRET_KEY", "perf-only-secret-key-not-for-production-0123456789")
os.environ["COOKIE_SECURE"] = "false"
os.environ.setdefault("TOKEN_EXPIRE_HOURS", "24")
sys.path.insert(0, _HERE)

import httpx       # noqa: E402  (ships with fastapi.testclient)
import uvicorn     # noqa: E402


def _wipe_db():
    for s in ("", "-wal", "-shm", "-journal"):
        p = _PERFDB + s
        if os.path.exists(p):
            try:
                os.unlink(p)
            except OSError:
                pass


def _pct(values, p):
    if not values:
        return 0.0
    values = sorted(values)
    k = max(0, min(len(values) - 1, int(round((p / 100.0) * (len(values) - 1)))))
    return values[k]


def _fmt_ms(s):
    return f"{s * 1000:9.2f}ms"


class _Server:
    """Run uvicorn in a background thread on an ephemeral port."""
    def __init__(self, app, port):
        self.config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        self.server = uvicorn.Server(self.config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self):
        self.thread.start()
        for _ in range(100):
            if self.server.started:
                return
            time.sleep(0.05)
        raise RuntimeError("server failed to start")

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=5)


def _login(base, username="admin", password="Perf1234!"):
    c = httpx.Client(base_url=base, timeout=30)
    r = c.post("/api/auth/login", json={"username": username, "password": password})
    r.raise_for_status()
    return c


def _seed(base, n_clients):
    """Create N clients + an invoice each so list/report endpoints have real rows."""
    c = _login(base)
    c.put("/api/settings/", json={"tax_enabled": "1", "default_tax_rate": "11"})
    rid = next(r["id"] for r in c.get("/api/tax-rates/").json() if r["is_default"])
    t0 = time.perf_counter()
    for i in range(n_clients):
        cid = c.post("/api/clients/", json={"name": f"Perf Client {i}"}).json()["id"]
        c.post("/api/invoices/", json={
            "client_id": cid,
            "items": [{"name": "Line", "quantity": 2, "unit_price": 100, "tax_rate_id": rid}],
        })
    dt = time.perf_counter() - t0
    c.close()
    return rid, dt


# ── Phase 1: sequential latency ───────────────────────────────────────────────
def latency_phase(base, rid, iterations):
    c = _login(base)
    endpoints = [
        ("GET  /api/auth/me",                "GET",  "/api/auth/me",                None),
        ("GET  /api/dashboard/",             "GET",  "/api/dashboard/",             None),
        ("GET  /api/clients/",               "GET",  "/api/clients/",               None),
        ("GET  /api/invoices/",              "GET",  "/api/invoices/",              None),
        ("GET  /api/inventory/",             "GET",  "/api/inventory/",             None),
        ("GET  /api/finance/range-summary",  "GET",  "/api/finance/range-summary",  None),
        ("GET  /api/reports/vat",            "GET",  "/api/reports/vat",            None),
    ]
    print(f"\n=== LATENCY (sequential, {iterations} iterations/endpoint) ===")
    print(f"{'endpoint':<34}{'p50':>11}{'p95':>11}{'p99':>11}{'max':>11}  errors")
    results = {}
    for label, method, path, body in endpoints:
        samples, errors = [], 0
        params = {"start": "2000-01-01", "end": "2100-12-31"} if "range-summary" in path else None
        for _ in range(iterations):
            t0 = time.perf_counter()
            r = c.request(method, path, params=params, json=body)
            samples.append(time.perf_counter() - t0)
            if r.status_code >= 400:
                errors += 1
        results[label] = samples
        print(f"{label:<34}{_fmt_ms(_pct(samples,50))}{_fmt_ms(_pct(samples,95))}"
              f"{_fmt_ms(_pct(samples,99))}{_fmt_ms(max(samples))}  {errors}")
    c.close()
    return results


# ── Phase 2: concurrent throughput ────────────────────────────────────────────
def throughput_phase(base, rid, concurrency, duration):
    print(f"\n=== THROUGHPUT (concurrency={concurrency}, duration={duration}s/scenario) ===")
    scenarios = [
        ("read  GET /api/invoices/", lambda c: c.get("/api/invoices/")),
        ("write POST /api/clients/", lambda c: c.post("/api/clients/",
                                                      json={"name": f"L{uuid.uuid4().hex[:8]}"})),
        ("write POST /api/invoices/", lambda c: c.post("/api/invoices/", json={
            "client_id": 1,
            "items": [{"name": "L", "quantity": 1, "unit_price": 100, "tax_rate_id": rid}]})),
    ]
    print(f"{'scenario':<30}{'req/s':>10}{'reqs':>8}{'errors':>8}{'p50':>11}{'p95':>11}{'p99':>11}")
    for label, call in scenarios:
        stop_at = time.perf_counter() + duration

        def worker(wid):
            """Each worker logs in as its OWN user (single-session-per-user means
            sharing one account would revoke siblings' sessions and falsify the
            error rate). Returns (latencies, errors)."""
            c = _login(base, username=f"perf_user_{wid}")
            lat, err = [], 0
            try:
                while time.perf_counter() < stop_at:
                    t0 = time.perf_counter()
                    try:
                        ok = call(c).status_code < 400
                    except Exception:
                        ok = False
                    lat.append(time.perf_counter() - t0)
                    if not ok:
                        err += 1
            finally:
                c.close()
            return lat, err

        t_start = time.perf_counter()
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futures = [ex.submit(worker, i) for i in range(concurrency)]
            results = [f.result() for f in futures]
        elapsed = time.perf_counter() - t_start

        latencies = [x for lat, _ in results for x in lat]
        errors = sum(err for _, err in results)
        total = len(latencies)
        rps = total / elapsed if elapsed else 0
        print(f"{label:<30}{rps:>10.1f}{total:>8}{errors:>8}"
              f"{_fmt_ms(_pct(latencies,50))}{_fmt_ms(_pct(latencies,95))}{_fmt_ms(_pct(latencies,99))}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=150, help="clients+invoices to pre-seed")
    ap.add_argument("--iterations", type=int, default=50, help="latency samples per endpoint")
    ap.add_argument("--concurrency", type=int, default=8, help="parallel workers")
    ap.add_argument("--duration", type=float, default=4.0, help="seconds per throughput scenario")
    ap.add_argument("--port", type=int, default=8799)
    args = ap.parse_args()

    _wipe_db()

    import database
    database.init_db()
    # Give the seeded superadmin a known password (init_db randomises it), and
    # create one superadmin per worker so the load phase isn't throttled by the
    # single-active-session-per-user rule.
    import sqlite3
    from auth_utils import hash_password
    pw = hash_password("Perf1234!")
    conn = sqlite3.connect(_PERFDB)
    conn.execute("UPDATE users SET password_hash=?, must_change_password=0 WHERE username='admin'",
                 (pw,))
    for i in range(args.concurrency):
        conn.execute(
            "INSERT OR IGNORE INTO users "
            "(username, password_hash, full_name, role, is_active, is_superadmin, "
            " must_change_password, created_at) "
            "VALUES (?,?,?,?,1,1,0,datetime('now'))",
            (f"perf_user_{i}", pw, f"Perf User {i}", "superadmin"),
        )
    conn.commit()
    conn.close()

    import main
    srv = _Server(main.app, args.port)
    srv.start()
    base = f"http://127.0.0.1:{args.port}"
    print(f"Server up on {base}  (DB={_PERFDB})")

    try:
        rid, seed_dt = _seed(base, args.seed)
        print(f"Seeded {args.seed} clients+invoices in {seed_dt:.2f}s "
              f"({args.seed / seed_dt:.1f} writes/s, 2 inserts each)")
        latency_phase(base, rid, args.iterations)
        throughput_phase(base, rid, args.concurrency, args.duration)
    finally:
        srv.stop()
        _wipe_db()
    print("\nDone.")


if __name__ == "__main__":
    main()
