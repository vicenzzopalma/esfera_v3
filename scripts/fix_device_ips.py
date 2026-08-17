import os, sqlite3

base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA')
path = os.path.join(base, 'esfera_v3', 'esfera_v3.db')
con = sqlite3.connect(path)
cur = con.cursor()

print("=== LIMPEZA E UNIFICACAO DO BANCO ===")

# 1. Remove todas as linhas fantasma (IDs invalidos ou duplicatas por IP)
cur.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%'")
cur.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESF-192.%'")
cur.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESF-LEGACY%'")
cur.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%'")
cur.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESF-192.%'")
cur.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESF-LEGACY%'")

# 2. Mapa definitivo: (EsferaDeviceId, Nome, Numero, AdbDeviceId, CurrentAdbAddress, IP)
devices = [
    ('ESF-MMULT000', '1', 1, 'MMULT0003016521', 'MMULT0003016521', '192.168.1.185'),  # Device 1 - offline, plugar USB
    ('ESF-52005950', '2', 2, '192.168.1.75:5555', '192.168.1.75:5555', '192.168.1.75'),
    ('ESF-42000D48', '3', 3, '42000d4801386585', '192.168.1.68:5555', '192.168.1.68'),
    ('ESF-1P924A80', '4', 4, '1P924A802201272', '192.168.1.42:5555', '192.168.1.42'),
    ('ESF-420012CA', '5', 5, '420012cad28ca5c7', '192.168.1.73:5555', '192.168.1.73'),
    ('ESF-5A323K71', '6', 6, '5A323K71N',        '192.168.1.63:5555', '192.168.1.63'),  # Device 6 - novo IP .63
    ('ESF-4200DA85', '7', 7, '192.168.1.151:5555','192.168.1.151:5555', '192.168.1.151'),
    ('ESF-5A337TP0', '9', 9, '5A337TP07',         '192.168.1.63:5555', '192.168.1.63'),  # Positivo Twist diferente
    ('ESF-00829256', '10',10,'192.168.1.83:5555',  '192.168.1.83:5555', '192.168.1.83'),
    ('ESF-0N14619I', '11',11,'0N14619I241030D7',  '192.168.1.100:5555','192.168.1.100'),
    ('ESF-EH428L00', '12',12,'192.168.1.82:5555',  '192.168.1.82:5555', '192.168.1.82'),
]

for esf_id, name, num, adb_id, adb_addr, ip in devices:
    # Atualiza identidade
    cur.execute("""
        INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
        VALUES (?, ?, 'junior', ?, 'Smartphone', datetime('now'))
        ON CONFLICT(EsferaDeviceId) DO UPDATE SET
            CustomName = excluded.CustomName,
            DeviceNumber = excluded.DeviceNumber,
            UpdatedAt = excluded.UpdatedAt
    """, (esf_id, name, num))

    # Atualiza dispositivo (pelo AdbDeviceId principal)
    cur.execute("""
        UPDATE ESF_Device SET
            DeviceName = ?,
            DeviceNumber = ?,
            EsferaDeviceId = ?,
            CurrentAdbAddress = ?,
            DeviceIp = ?,
            LastSeenUTC = datetime('now')
        WHERE AdbDeviceId = ?
    """, (name, num, esf_id, adb_addr, ip, adb_id))

# 3. Corrige o Positivo (Aparelho 6) - adb id e 5A323K71N mas o novo IP e .63
cur.execute("""
    UPDATE ESF_Device SET
        CurrentAdbAddress = '192.168.1.63:5555',
        DeviceIp = '192.168.1.63',
        Status = 'online',
        LastSeenUTC = datetime('now')
    WHERE AdbDeviceId = '5A323K71N' OR EsferaDeviceId = 'ESF-5A323K71'
""")

con.commit()

print("\n=== ESF_DeviceIdentity ===")
for r in cur.execute('SELECT EsferaDeviceId, CustomName, DeviceNumber FROM ESF_DeviceIdentity ORDER BY DeviceNumber').fetchall():
    print(r)

print("\n=== ESF_Device ===")
for r in cur.execute('SELECT AdbDeviceId, DeviceName, DeviceNumber, EsferaDeviceId, CurrentAdbAddress, Status FROM ESF_Device ORDER BY DeviceNumber').fetchall():
    print(r)
