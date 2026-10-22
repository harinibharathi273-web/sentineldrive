"""SQLite storage.

Each table keeps a few indexed columns (id, created_at, status, kind, lat, lng)
plus the full record as JSON. That keeps the schema stable while the record
shape evolves, and it needs no database server: the file lives at
backend/data/sentinel.db and survives restarts.
"""

import json
import math
import sqlite3
import threading
import time

from .config import DB_PATH

TABLES = ("potholes", "incidents", "talkbacks")

_lock = threading.RLock()
_conn = None


def now_ms():
    return int(time.time() * 1000)


def _connect():
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA synchronous=NORMAL")
        for t in TABLES:
            _conn.execute(
                f"""CREATE TABLE IF NOT EXISTS {t} (
                    id TEXT PRIMARY KEY,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    kind TEXT,
                    status TEXT,
                    lat REAL,
                    lng REAL,
                    data TEXT NOT NULL
                )"""
            )
            _conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{t}_created ON {t}(created_at)")
            _conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{t}_status ON {t}(status)")
        _conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        _conn.commit()
    return _conn


def reset_for_tests(path):
    """Point the store at a different file (used by the test-suite)."""
    global _conn, DB_PATH
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn = None
        DB_PATH = path


def put(table, record):
    """Insert or replace a record. `record` must contain id and created_at."""
    assert table in TABLES
    rec = dict(record)
    rec.setdefault("created_at", now_ms())
    rec["updated_at"] = now_ms()
    with _lock:
        c = _connect()
        c.execute(
            f"""INSERT INTO {table} (id, created_at, updated_at, kind, status, lat, lng, data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, kind=excluded.kind,
                  status=excluded.status, lat=excluded.lat, lng=excluded.lng, data=excluded.data""",
            (
                rec["id"],
                rec["created_at"],
                rec["updated_at"],
                rec.get("kind"),
                rec.get("status"),
                rec.get("lat"),
                rec.get("lng"),
                json.dumps(rec, separators=(",", ":")),
            ),
        )
        c.commit()
    return rec


def get(table, rid):
    assert table in TABLES
    with _lock:
        row = _connect().execute(f"SELECT data FROM {table} WHERE id=?", (rid,)).fetchone()
    return json.loads(row["data"]) if row else None


def delete(table, rid):
    assert table in TABLES
    with _lock:
        c = _connect()
        cur = c.execute(f"DELETE FROM {table} WHERE id=?", (rid,))
        c.commit()
        return cur.rowcount > 0


def query(table, *, status=None, kind=None, since=None, limit=500):
    assert table in TABLES
    sql = f"SELECT data FROM {table} WHERE 1=1"
    args = []
    if status:
        statuses = [status] if isinstance(status, str) else list(status)
        sql += f" AND status IN ({','.join('?' * len(statuses))})"
        args += statuses
    if kind:
        sql += " AND kind=?"
        args.append(kind)
    if since:
        sql += " AND created_at>=?"
        args.append(since)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    with _lock:
        rows = _connect().execute(sql, args).fetchall()
    return [json.loads(r["data"]) for r in rows]


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def nearest(table, lat, lng, radius_m, *, exclude_status=()):
    """Closest record within radius_m (bounding-box prefilter, exact haversine)."""
    dlat = radius_m / 111_320.0
    dlng = radius_m / (111_320.0 * max(0.01, math.cos(math.radians(lat))))
    with _lock:
        rows = _connect().execute(
            f"SELECT data FROM {table} WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?",
            (lat - dlat, lat + dlat, lng - dlng, lng + dlng),
        ).fetchall()
    best, best_d = None, None
    for r in rows:
        rec = json.loads(r["data"])
        if rec.get("status") in exclude_status:
            continue
        d = haversine_m(lat, lng, rec["lat"], rec["lng"])
        if d <= radius_m and (best_d is None or d < best_d):
            best, best_d = rec, d
    return best, best_d


def kv_get(key, default=None):
    with _lock:
        row = _connect().execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def kv_set(key, value):
    with _lock:
        c = _connect()
        c.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        c.commit()
