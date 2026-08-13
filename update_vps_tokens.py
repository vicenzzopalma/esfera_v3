import sqlite3
import hashlib

def hash_pw(pw):
    salt = 'esfera_v3_salt_2026'
    return hashlib.sha256(f'{salt}:{pw}'.encode()).hexdigest()

dbs = [
    '/home/vicenzzoconstantine/esfera_v3/esfera_cloud.db',
    '/home/vicenzzoconstantine/esfera_v3/hub-standalone/esfera_cloud.db'
]

master_hash = hash_pw('root123')
empresa_hash = hash_pw('Ope@2025')

for path in dbs:
    try:
        conn = sqlite3.connect(path)
        c = conn.cursor()
        c.execute("INSERT INTO ESF_CompanyToken (CompanyId, TokenHash, Role) VALUES (0, ?, 'master') ON CONFLICT(CompanyId) DO UPDATE SET TokenHash=excluded.TokenHash, Role=excluded.Role", (master_hash,))
        c.execute("INSERT INTO ESF_CompanyToken (CompanyId, TokenHash, Role) VALUES (1, ?, 'empresa') ON CONFLICT(CompanyId) DO UPDATE SET TokenHash=excluded.TokenHash, Role=excluded.Role", (empresa_hash,))
        conn.commit()
        print(f'Updated {path}')
        c.execute("SELECT * FROM ESF_CompanyToken")
        print(c.fetchall())
        conn.close()
    except Exception as e:
        print(f'Error on {path}: {e}')
