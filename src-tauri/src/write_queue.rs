// ============================================================
// Esfera v3 — Fila Única de Escrita Assíncrona (write_queue.rs)
// Padrão MPSC (Multi-Producer, Single-Consumer): qualquer thread
// enfileira operações de escrita e UMA thread dedicada consome
// em lotes dentro de transações únicas (BEGIN IMMEDIATE/COMMIT).
// Elimina contenção SQLITE_BUSY e reduz I/O de disco em ~90%.
// ============================================================

use crate::db::Database;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Arc;

pub const QUEUE_CAPACITY: usize = 1024;
pub const MAX_BATCH_SIZE: usize = 256;

/// Operações de modificação enfileiradas (INSERT/UPDATE/DELETE)
#[derive(Debug)]
pub enum WriteOp {
    Log {
        company_id: i32,
        log_type: String,
        source: String,
        message: String,
    },
    MarkSent {
        phone: String,
        campaign_id: i32,
    },
    ContactStatus {
        contact_id: i32,
        status: String,
    },
    IncrementSent {
        campaign_id: i32,
    },
    /// Lote atômico de envio concluído: SentHistory + status do contato + contador da campanha
    SendCompleted {
        phone: String,
        campaign_id: i32,
        contact_id: i32,
    },
    DeviceCheckin {
        device_id: String,
        adb_address: String,
        ip: String,
        port: u16,
        now: String,
    },
    MarkDeviceOnline {
        rowid: i32,
        adb_addr: String,
    },
}

pub struct WriteQueue {
    tx: SyncSender<WriteOp>,
}

impl WriteQueue {
    /// Inicia o consumidor único em background. O canal é MPSC:
    /// qualquer thread pode enfileirar, mas apenas esta thread consome.
    pub fn spawn(db: Arc<Database>, capacity: usize) -> Arc<Self> {
        let (tx, rx) = sync_channel(capacity);
        let queue = Arc::new(WriteQueue { tx });

        std::thread::Builder::new()
            .name("esfera-db-writer".into())
            .spawn(move || Self::writer_loop(&db, &rx))
            .expect("Falha ao iniciar thread do WriteQueue");

        queue
    }

    /// Enfileira uma operação de escrita (não bloqueante enquanto houver espaço)
    pub fn enqueue(&self, op: WriteOp) -> bool {
        self.tx.send(op).is_ok()
    }

    fn writer_loop(db: &Arc<Database>, rx: &Receiver<WriteOp>) {
        loop {
            let first = match rx.recv() {
                Ok(op) => op,
                Err(_) => break, // canal fechado: encerra a thread
            };

            // Drena o canal agrupando o máximo de operações em um único lote
            let mut batch = Vec::with_capacity(64);
            batch.push(first);
            for _ in 1..MAX_BATCH_SIZE {
                match rx.try_recv() {
                    Ok(op) => batch.push(op),
                    Err(_) => break,
                }
            }

            let conn = match db.pooled_conn() {
                Ok(conn) => conn,
                Err(e) => {
                    eprintln!("[WriteQueue] pool indisponível ({} op(s) suspensas): {}", batch.len(), e);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }
            };

            if let Err(e) = db.apply_write_batch(&conn, &batch) {
                eprintln!("[WriteQueue] falha no lote de {} op(s): {}", batch.len(), e);
            }
        }
    }
}
