// ============================================================
// Esfera v3 — Sub-componente DiagnosticModal (Linear SaaS Style)
// Modal de diagnóstico do barramento USB e servidor ADB
// ============================================================

import { useState, useEffect } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { api } from "../../tauri";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";

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

export function DiagnosticModal({ isOpen, onClose }: DiagnosticModalProps) {
  const [diagnostic, setDiagnostic] = useState<AdbDiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);

  const runDiagnostic = async () => {
    setLoading(true);
    try {
      const result = await api<AdbDiagnosticResult>("run_adb_diagnostic");
      setDiagnostic(result);
    } catch (err) {
      console.error("Erro no diagnóstico ADB:", err);
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
      title="Diagnóstico do Barramento USB & Servidor ADB"
      size="md"
      footer={
        <div className="flex justify-between items-center w-full text-xs">
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={runDiagnostic} disabled={loading}>
            Re-escanear Barramento
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            Fechar
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-xs">
        {loading ? (
          <div className="py-6 flex flex-col items-center justify-center text-zinc-400">
            <RefreshCw size={20} className="animate-spin text-[#828DF7] mb-2" />
            <span>Escaneando barramentos USB e daemon ADB...</span>
          </div>
        ) : (
          diagnostic && (
            <div className="space-y-2.5">
              <div className="p-3 rounded-lg bg-[#141418] border border-white/[0.07] space-y-2">
                <div className="flex items-center gap-2">
                  {diagnostic.has_any_usb_device ? (
                    <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
                  ) : (
                    <XCircle size={16} className="text-red-400 shrink-0" />
                  )}
                  <div>
                    <h5 className="font-semibold text-zinc-100">Barramento USB Nativo</h5>
                    <p className="text-[11px] text-zinc-400">{diagnostic.diagnostic_msg}</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="p-2.5 rounded-lg bg-[#141418] border border-white/[0.07] flex items-center justify-between">
                  <span className="text-zinc-400">Servidor ADB:</span>
                  <span className={`font-mono font-semibold ${diagnostic.is_adb_process_running ? "text-emerald-400" : "text-red-400"}`}>
                    {diagnostic.is_adb_process_running ? "Ativo" : "Inativo"}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-[#141418] border border-white/[0.07] flex items-center justify-between">
                  <span className="text-zinc-400">Dispositivos USB:</span>
                  <span className="font-mono font-semibold text-zinc-200">{diagnostic.detected_usb_count}</span>
                </div>
              </div>
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
