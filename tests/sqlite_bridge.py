"""Local D1-shaped test adapter backed by real SQLite transactions.
Not a substitute for Cloudflare integration testing. Requires Python 3.
"""
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
db = sqlite3.connect(payload["path"])
db.row_factory = sqlite3.Row
try:
    if "script" in payload:
        db.executescript(payload["script"])
        result = []
    else:
        result = []
        with db:
            for s in payload["statements"]:
                cur = db.execute(s["sql"], s.get("values", []))
                rows = [dict(r) for r in cur.fetchall()] if cur.description else []
                result.append({
                    "results": rows,
                    "meta": {
                        "changes": db.execute("SELECT changes()").fetchone()[0],
                        "last_row_id": cur.lastrowid,
                    },
                    "success": True,
                })
    print(json.dumps({"result": result}))
except Exception as exc:
    db.rollback()
    print(json.dumps({"error": str(exc)}))
    sys.exit(1)
finally:
    db.close()
