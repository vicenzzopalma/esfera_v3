import sqlite3
import os

localappdata = os.environ.get("LOCALAPPDATA", "")
db_path = os.path.join(localappdata, "esfera_v3", "esfera_v3.db")
conn = sqlite3.connect(db_path)
cur = conn.cursor()
for t in ["ESF_Company", "ESF_User", "ESF_Device", "ESF_DeviceIdentity"]:
    cur.execute(f"SELECT count(*) FROM {t}")
    cnt = cur.fetchone()[0]
    print(f"\n--- Table {t} (total: {cnt}) ---")
    cur.execute(f"SELECT * FROM {t} LIMIT 10")
    for r in cur.fetchall():
        print(r)
conn.close()
