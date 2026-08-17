import os
import sqlite3

base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA')
path = os.path.join(base, 'esfera_v3', 'esfera_v3.db')
con = sqlite3.connect(path)
cur = con.cursor()

devices = [
    ('ESF-MMULT000', '1', 1, 'MMULT0003016521', 'Multilaser'),
    ('ESF-52005950', '2', 2, '192.168.1.75:5555', 'Samsung'),
    ('ESF-5A323K71', '6', 6, '192.168.1.58:5555', 'Positivo'),
    ('ESF-42000D48', '3', 3, '192.168.1.68:5555', 'Samsung'),
    ('ESF-4200DA85', '7', 7, '192.168.1.151:5555', 'Samsung'),
    ('ESF-00829256', '10', 10, '192.168.1.83:5555', 'Motorola'),
    ('ESF-0N14619I', '11', 11, '192.168.1.100:5555', 'Realme'),
    ('ESF-EH428L00', '12', 12, '192.168.1.82:5555', 'Redmi'),
]

cur.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%'")
cur.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%'")

for esf_id, name, num, serial, model in devices:
    cur.execute("""
        INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
        VALUES (?, ?, 'junior', ?, ?, datetime('now'))
        ON CONFLICT(EsferaDeviceId) DO UPDATE SET
            CustomName = excluded.CustomName,
            DeviceNumber = excluded.DeviceNumber,
            UpdatedAt = excluded.UpdatedAt
    """, (esf_id, name, num, model))

    cur.execute("""
        UPDATE ESF_Device SET
            DeviceName = ?,
            DeviceNumber = ?,
            Sector = 'junior'
        WHERE EsferaDeviceId = ? OR AdbDeviceId = ?
    """, (name, num, esf_id, serial))

con.commit()

print('=== ESF_DeviceIdentity ===')
for r in cur.execute('SELECT EsferaDeviceId, CustomName, DeviceNumber FROM ESF_DeviceIdentity').fetchall():
    print(r)

print('\n=== ESF_Device ===')
for r in cur.execute('SELECT EsferaDeviceId, DeviceName, DeviceNumber, CurrentAdbAddress, Status FROM ESF_Device').fetchall():
    print(r)
