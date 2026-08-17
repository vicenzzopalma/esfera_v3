import os
import sqlite3

base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA')
path = os.path.join(base, 'esfera_v3', 'esfera_v3.db')
con = sqlite3.connect(path)
cur = con.cursor()

print("=== EXECUTANDO AUDITORIA E DEDUPLICAÇÃO COMPLETA ===")

# 1. Deletar todos os IDs temporários/fantasmas ESFERA_DEV_
cur.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%'")
cur.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%' OR EsferaDeviceId IS NULL")

# 2. Aparelhos oficiais mapeados
devices = [
    ('ESF-1P924A80', '4', 4, '1P924A802201272', '192.168.1.42:5555', '192.168.1.42', 'Multilaser'),
    ('ESF-MMULT000', '1', 1, 'MMULT0003016521', 'MMULT0003016521', '192.168.1.185', 'Multilaser'),
    ('ESF-52005950', '2', 2, '192.168.1.75:5555', '192.168.1.75:5555', '192.168.1.75', 'Samsung'),
    ('ESF-42000D48', '3', 3, '42000d4801386585', '192.168.1.68:5555', '192.168.1.68', 'Samsung'),
    ('ESF-420012CA', '5', 5, '420012cad28ca5c7', '192.168.1.73:5555', '192.168.1.73', 'Samsung'),
    ('ESF-5A323K71', '6', 6, '5A323K71N', '192.168.1.58:5555', '192.168.1.58', 'Positivo'),
    ('ESF-4200DA85', '7', 7, '192.168.1.151:5555', '192.168.1.151:5555', '192.168.1.151', 'Samsung'),
    ('ESF-00829256', '10', 10, '192.168.1.83:5555', '192.168.1.83:5555', '192.168.1.83', 'Motorola'),
    ('ESF-0N14619I', '11', 11, '0N14619I241030D7', '192.168.1.100:5555', '192.168.1.100', 'Realme'),
    ('ESF-EH428L00', '12', 12, '192.168.1.82:5555', '192.168.1.82:5555', '192.168.1.82', 'Redmi'),
]

# 3. Limpa duplicatas de IP
cur.execute("DELETE FROM ESF_Device WHERE AdbDeviceId LIKE '192.168.1.%' AND AdbDeviceId IN ('192.168.1.42:5555', '192.168.1.68:5555', '192.168.1.73:5555', '192.168.1.100:5555')")

for esf_id, name, num, usb_serial, adb_addr, ip, model in devices:
    cur.execute("""
        INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
        VALUES (?, ?, 'junior', ?, ?, datetime('now'))
        ON CONFLICT(EsferaDeviceId) DO UPDATE SET
            CustomName = excluded.CustomName,
            DeviceNumber = excluded.DeviceNumber,
            UpdatedAt = excluded.UpdatedAt
    """, (esf_id, name, num, model))

    cur.execute("""
        INSERT INTO ESF_Device (AdbDeviceId, DeviceName, Brand, Model, DeviceIp, DevicePort, Status, BatteryLevel, CompanyId, DeviceNumber, Sector, EsferaDeviceId, CurrentAdbAddress, LastSeenUTC)
        VALUES (?, ?, 'Android', ?, ?, 5555, 'online', 100, 1, ?, 'junior', ?, ?, datetime('now'))
        ON CONFLICT(AdbDeviceId) DO UPDATE SET
            DeviceName = excluded.DeviceName,
            DeviceNumber = excluded.DeviceNumber,
            EsferaDeviceId = excluded.EsferaDeviceId,
            CurrentAdbAddress = excluded.CurrentAdbAddress,
            DeviceIp = excluded.DeviceIp,
            Status = excluded.Status
    """, (usb_serial, name, model, ip, num, esf_id, adb_addr))

con.commit()

print("\n=== TABELA ESF_DeviceIdentity APÓS AUDITORIA ===")
for r in cur.execute('SELECT EsferaDeviceId, CustomName, DeviceNumber FROM ESF_DeviceIdentity').fetchall():
    print(r)

print("\n=== TABELA ESF_Device APÓS AUDITORIA ===")
for r in cur.execute('SELECT rowid, AdbDeviceId, DeviceName, DeviceNumber, EsferaDeviceId, CurrentAdbAddress, Status FROM ESF_Device').fetchall():
    print(r)
