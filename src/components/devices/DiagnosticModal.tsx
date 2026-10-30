// ============================================================
// Esfera v3 — Diagnóstico do USB e do servidor ADB
// ============================================================

import { useState, useEffect } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { api } from "../../tauri";
import { CheckCircle2, XCircle, RefreshCw, AlertTriangle } from "lucide-react";
import { errorText } from "./deviceUi";

interface AdbDiagnosticResult {
  has_any_usb_device: boolean;
  has_android_usb_device: boolean;
  is_adb_process_running: boolean;
  detected_usb_count: number;
  diagnostic_msg: string;
}

interface DiagnosticModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function Item({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-3.5">
      {ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-red-500" />}
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-primary">{title}</p>
        <p className="text-[0.75rem] text-secondary">{detail}</p>
      </div>
    </div>
  );
}

export function DiagnosticModal({ isOpen, onClose }: DiagnosticModalProps) {
  const [diagnostic, setDiagnostic] = useState<AdbDiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runDiagnostic = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<AdbDiagnosticResult>("run_adb_diagnostic");
      setDiagnostic(result);
    } catch (err: any) {
      console.error("Erro no diagnóstico ADB:", err);
      setError(errorText(err, "Não foi possível executar o diagnóstico."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) runDiagnostic();
  }, [isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Diagnóstico da conexão USB"
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={runDiagnostic} loading={loading} className="mr-auto">
            Verificar novamente
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Fechar
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-[0.8125rem] text-secondary">
          <RefreshCw size={18} className="animate-spin" />
          Verificando as portas USB e o serviço de conexão (ADB)...
        </div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[0.8125rem] text-red-600 dark:text-red-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : (
        diagnostic && (
          <div className="space-y-3">
            <Item ok={diagnostic.has_any_usb_device} title="Portas USB" detail={diagnostic.diagnostic_msg} />
            <Item
              ok={diagnostic.is_adb_process_running}
              title="Serviço de conexão (ADB)"
              detail={
                diagnostic.is_adb_process_running
                  ? "Em execução."
                  : "Parado. Clique em Verificar novamente; se continuar parado, feche e abra o Esfera."
              }
            />
            <Item
              ok={diagnostic.detected_usb_count > 0}
              title="Aparelhos no USB"
              detail={
                diagnostic.detected_usb_count > 0
                  ? `${diagnostic.detected_usb_count} ${diagnostic.detected_usb_count === 1 ? "aparelho detectado" : "aparelhos detectados"}.`
                  : "Nenhum aparelho. Use um cabo de dados (não só de carga) e ative a depuração USB nas opções do desenvolvedor."
              }
            />
          </div>
        )
      )}
    </Modal>
  );
}
