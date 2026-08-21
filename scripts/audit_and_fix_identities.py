import os
import sqlite3

print("=== EXECUTANDO AUDITORIA E DEDUPLICAÇÃO DE DISPOSITIVOS FANTASMAS ===")

devices_map = [
    ('ESF-MMULT000', '1', 1, 'MMULT0003016521', '192.168.1.41:5555', '192.168.1.41', 'Multilaser'),
    ('ESF-52005950', '2', 2, '192.168.1.75:5555', '192.168.1.75:5555', '192.168.1.75', 'Samsung'),
    ('ESF-42000D48', '3', 3, '42000d4801386585', '192.168.1.56:5555', '192.168.1.56', 'Samsung'),
    ('ESF-1P924A80', '4', 4, '1P924A802201272', '192.168.1.42:5555', '192.168.1.42', 'Multilaser'),
    ('ESF-420012CA', '5', 5, '420012cad28ca5c7', '192.168.1.73:5555', '192.168.1.73', 'Samsung'),
    ('ESF-5A323K71', '6', 6, '5A323K71N', '192.168.1.63:5555', '192.168.1.63', 'Positivo'),
    ('ESF-4200DA85', '7', 7, '192.168.1.151:5555', '192.168.1.151:5555', '192.168.1.151', 'Samsung'),
    ('ESF-5A337TP0', '9', 9, '5A337TP07', '192.168.1.63:5555', '192.168.1.63', 'Positivo'),
    ('ESF-00829256', '10', 10, '192.168.1.83:5555', '192.168.1.83:5555', '192.168.1.83', 'Motorola'),
    ('ESF-0N14619I', '11', 11, '0N14619I241030D7', '192.168.1.100:5555', '192.168.1.100', 'Realme'),
    ('ESF-EH428L00', '12', 12, '192.168.1.82:5555', '192.168.1.82:5555', '192.168.1.82', 'Redmi'),
]

db_paths = [
    os.path.join(os.environ.get('LOCALAPPDATA', ''), 'esfera_v3', 'esfera_v3.db'),
    os.path.join(os.environ.get('APPDATA', ''), 'esfera_v3', 'esfera_v3.db'),
    os.path.join(os.getcwd(), 'esfera_v3.db'),
    os.path.join(os.getcwd(), 'esfera_cloud.db'),
    os.path.join(os.getcwd(), 'hub-standalone', 'esfera_cloud.db'),
]

for p in db_paths:
    if not os.path.exists(p):
        continue
    print(f"\n--- Limpando banco: {p} ---")
    try:
        con = sqlite3.connect(p)
        cur = con.cursor()
        
        tables = [t[0] for t in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        
        # 1. Deletar IDs fantasmas/temporários/legados
        if 'ESF_DeviceIdentity' in tables:
            cur.execute("DELETE FROM ESF_DeviceIdentity WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%' OR EsferaDeviceId LIKE 'ESF-LEGACY-%'")
            
        if 'ESF_Device' in tables:
            cur.execute("DELETE FROM ESF_Device WHERE EsferaDeviceId LIKE 'ESFERA_DEV_%' OR EsferaDeviceId LIKE 'ESF-LEGACY-%' OR EsferaDeviceId IS NULL")
            # Deletar duplicatas por IP
            cur.execute("DELETE FROM ESF_Device WHERE AdbDeviceId LIKE '192.168.1.%'")
            
        # 2. Inserir/Atualizar os 11 aparelhos oficiais
        for esf_id, name, num, usb_serial, adb_addr, ip, model in devices_map:
            if 'ESF_DeviceIdentity' in tables:
                cur.execute("""
                    INSERT INTO ESF_DeviceIdentity (EsferaDeviceId, CustomName, Sector, DeviceNumber, Model, UpdatedAt)
                    VALUES (?, ?, 'junior', ?, ?, datetime('now'))
                    ON CONFLICT(EsferaDeviceId) DO UPDATE SET
                        CustomName = excluded.CustomName,
                        DeviceNumber = excluded.DeviceNumber,
                        UpdatedAt = excluded.UpdatedAt
                """, (esf_id, name, num, model))
                
            if 'ESF_Device' in tables:
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
        print("Limpeza concluída com sucesso.")
        
        if 'ESF_Device' in tables:
            print("Status atual da ESF_Device:")
            for r in cur.execute("SELECT AdbDeviceId, DeviceName, DeviceNumber, EsferaDeviceId, CurrentAdbAddress, Status FROM ESF_Device").fetchall():
                print(" ", r)
        con.close()
    except Exception as e:
        print("Erro limpando", p, ":", e)
