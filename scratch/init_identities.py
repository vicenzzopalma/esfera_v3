import sqlite3

db_path = r'C:\Users\vicenzzo.palma\AppData\Local\esfera_v3\esfera_v3.db'
conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS ESF_DeviceIdentity (
    EsferaDeviceId TEXT PRIMARY KEY,
    CustomName TEXT NOT NULL,
    Sector TEXT NOT NULL DEFAULT 'junior',
    DeviceNumber INTEGER NOT NULL DEFAULT 1,
    Model TEXT DEFAULT '',
    UpdatedAt TEXT NOT NULL
);
""")

# Mapear e ancorar os 4 aparelhos reais
devices = [
    ("ESF-4200DA85", "Aparelho 1", "junior", 1, "Samsung SM-G570M"),
    ("ESF-52005950", "Aparelho 2", "junior", 2, "Samsung SM-G610M"),
    ("ESF-EH428L00", "Aparelho 3", "junior", 3, "Xiaomi 24044RN32L"),
    ("ESF-00829256", "Aparelho 4", "junior", 4, "Motorola Moto G22"),
]

for did, name, sec, num, model in devices:
    cur.execute("""
    INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(EsferaDeviceId) DO UPDATE SET
        CustomName=excluded.CustomName,
        Sector=excluded.Sector,
        DeviceNumber=excluded.DeviceNumber,
        Model=excluded.Model,
        UpdatedAt=excluded.UpdatedAt;
    """, (did, name, sec, num, model))
    
    # Atualiza na ESF_Device também
    cur.execute("""
    UPDATE ESF_Device SET
        DeviceName=?,
        Sector=?,
        DeviceNumber=?,
        Model=?
    WHERE EsferaDeviceId=?;
    """, (name, sec, num, model, did))

conn.commit()

cur.execute("SELECT rowid, AdbDeviceId, DeviceName, Model, DeviceIp, Status, EsferaDeviceId, Sector, DeviceNumber FROM ESF_Device")
print("--- ESF_Device ---")
for r in cur.fetchall():
    print(r)

cur.execute("SELECT * FROM ESF_DeviceIdentity")
print("--- ESF_DeviceIdentity ---")
for r in cur.fetchall():
    print(r)

conn.close()
