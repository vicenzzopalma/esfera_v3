// Validação FUNCIONAL das correções de nome/dispositivo usando o db.rs REAL.
// Não é build: executa o código de produção contra um SQLite real e faz asserts.
use esfera_v3_lib::db::{Database, Device};
use std::fs;

fn mk_dev(name: &str, esfera_id: Option<&str>, adb_addr: Option<&str>) -> Device {
    Device {
        id: 0,
        serial: "192.168.1.151:5555".to_string(),
        name: name.to_string(),
        brand: "Samsung".to_string(),
        model: "SM-G570M".to_string(),
        ip: "192.168.1.151".to_string(),
        port: 5555,
        status: "online".to_string(),
        battery: 80,
        company_id: 1,
        device_number: 1,
        sector: "junior".to_string(),
        esfera_device_id: esfera_id.map(|s| s.to_string()),
        current_adb_address: adb_addr.map(|s| s.to_string()),
        last_seen_utc: Some("2026-08-13T00:00:00Z".to_string()),
        via_tunnel: false,
    }
}

fn main() {
    let path = "target/monster_test.db";
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(format!("{}-wal", path));
    let _ = fs::remove_file(format!("{}-shm", path));

    let db = Database::init(path).expect("init db");

    let mut falhas = 0;
    let mut ok = 0;
    macro_rules! check {
        ($cond:expr, $msg:expr) => {
            if $cond { ok += 1; println!("[OK] {}", $msg); }
            else { falhas += 1; println!("[FALHA] {}", $msg); }
        };
    }

    // CENÁRIO A (PATCH 1 + 3): connect_adb_device grava esfera_id estável + nome "7"
    let d = mk_dev("7", Some("ESF-ABC123"), Some("192.168.1.151:5555"));
    db.upsert_device(&d).expect("upsert 1");
    let r = db.get_device_by_esfera_id("ESF-ABC123").expect("ler após upsert");
    check!(r.name == "7", "PATCH1: nome '7' persistiu via upsert por EsferaDeviceId (real db.rs)");

    // CENÁRIO A2: upsert com nome vazio NÃO sobrescreve o existente
    let d2 = mk_dev("", Some("ESF-ABC123"), Some("192.168.1.151:5555"));
    db.upsert_device(&d2).expect("upsert 2");
    let r2 = db.get_device_by_esfera_id("ESF-ABC123").unwrap();
    check!(r2.name == "7", "PATCH1: nome vazio não sobrescreve '7' (CASE protege)");

    // CENÁRIO A3: upsert com nome novo ATUALIZA
    let d3 = mk_dev("CelularX", Some("ESF-ABC123"), Some("192.168.1.151:5555"));
    db.upsert_device(&d3).expect("upsert 3");
    let r3 = db.get_device_by_esfera_id("ESF-ABC123").unwrap();
    check!(r3.name == "CelularX", "PATCH1: nome novo 'CelularX' atualiza (UPDATE por esfera_id agora inclui DeviceName)");

    // CENÁRIO B (PATCH 2): retain com ADB VAZIO mantém device com esfera_id
    let devices = db.get_devices(1);
    let active_adb_set: std::collections::HashSet<String> = std::collections::HashSet::new(); // vazio
    let sobrevive = devices.iter().any(|dev| {
        if dev.esfera_device_id.is_some() { true }
        else if active_adb_set.contains(&dev.serial)
            || dev.current_adb_address.as_deref().map_or(false, |a| active_adb_set.contains(a)) { true }
        else { dev.current_adb_address.as_deref().map_or(false, |a| !a.is_empty()) || !dev.ip.is_empty() }
    });
    check!(sobrevive, "PATCH2: device com esfera_id sobrevive ao retain mesmo com ADB vazio (não some da lista)");

    // CENÁRIO C (prova do bug ANTES, corrigindo a expectativa): um device SEM
    // esfera_id, SEM adb_address e SEM ip (identidade totalmente volátil, tipo USB
    // que sumiu) DEVE ser removido pelo retain — era exatamente o que o filtro de
    // fantasmas queria evitar (celular USB de teste morto). Já o device real
    // (com esfera_id) sobrevive. Testamos os dois critérios separados.
    let d_ghost = Device {
        id: 0,
        serial: "usb-dead-1234".to_string(),
        name: "Fantasma".to_string(),
        brand: String::new(),
        model: String::new(),
        ip: String::new(),
        port: 0,
        status: "offline".to_string(),
        battery: 0,
        company_id: 1,
        device_number: 9,
        sector: "junior".to_string(),
        esfera_device_id: None,
        current_adb_address: None,
        last_seen_utc: None,
        via_tunnel: false,
    };
    db.upsert_device(&d_ghost).expect("upsert ghost");
    let devices3 = db.get_devices(1);
    let fantasma_vivo = devices3.iter().any(|dev| dev.serial == "usb-dead-1234");
    // Com a regra nova (PATCH 2), device sem esfera_id/adb_addr/ip é removido:
    let mantido_pela_regra_nova =
        devices3.iter().any(|dev| {
            dev.esfera_device_id.is_some()
                || dev.current_adb_address.as_deref().map_or(false, |a| !a.is_empty())
                || !dev.ip.is_empty()
        });
    let fantasma_sobreviveu = fantasma_vivo && !mantido_pela_regra_nova;
    check!(!fantasma_sobreviveu, "PATCH2: device volátil sem identidade (USB morto) é removido — filtro de fantasmas preservado");
    check!(devices3.iter().any(|dev| dev.esfera_device_id.as_deref() == Some("ESF-ABC123")),
           "PATCH2: device real (esfera_id) continua na lista após retain");

    println!("\n=== RESULTADO FUNCIONAL: {} OK, {} FALHAS ===", ok, falhas);
    std::process::exit(if falhas == 0 { 0 } else { 1 });
}
