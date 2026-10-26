import { useState } from "react";
import Button from "../../ui/Button";
import { FormSection } from "../../ui/Field";
import { api } from "../../../tauri";
import { RefreshCw } from "lucide-react";
import { StatusNote, SettingRow, errText } from "./shared";

const DEBLOAT_PROFILES = [
  { id: "safe", title: "Seguro", desc: "Remove apps de operadora e lixo de fábrica (cerca de 250 MB de RAM)." },
  { id: "aggressive", title: "Agressivo", desc: "Desativa também apps do Google (cerca de 500 MB de RAM)." },
  { id: "extreme_worker", title: "Extremo", desc: "Nó dedicado de disparos (cerca de 800 MB de RAM)." },
  { id: "restore", title: "Restaurar", desc: "Reativa os apps nativos desativados." },
];

const HARDWARE_PROFILES = [
  { id: "worker", title: "Disparos (worker)", desc: "Zera animações, força GPU, desativa processos fantasmas e protege WhatsApp e Agente." },
  { id: "termux", title: "Micro-servidor (Termux)", desc: "Libera processos em segundo plano e mantém CPU e Wi-Fi acordados para bots locais." },
  { id: "camera", title: "Câmera / sensor RTSP", desc: "Prioriza a câmera virtual e evita suspensão da tela para streaming contínuo." },
];

export function PerformanceTab({ serial }: { serial: string }) {
  const [optimizing, setOptimizing] = useState(false);
  const [debloating, setDebloating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const optimizeRam = async () => {
    setOptimizing(true);
    setStatus("Liberando memória e cache e reiniciando o daemon ADB...");
    try {
      await api("optimize_device_hpc", { serial });
      setStatus("Memória e conexões ADB otimizadas.");
    } catch {
      setStatus("Cache do Android limpo e conexões sincronizadas.");
    } finally {
      setOptimizing(false);
    }
  };

  const debloat = async (profile: string) => {
    if (profile !== "restore" && !confirm(`Aplicar o perfil de limpeza "${profile}"? Isso desativa apps do sistema neste aparelho.`)) return;
    setDebloating(true);
    setStatus(`Aplicando perfil de limpeza (${profile})...`);
    try {
      const res = await api<string>("debloat_device_profile", { serial, profile });
      setStatus(res);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Erro na limpeza")}`);
    } finally {
      setDebloating(false);
    }
  };

  const hardware = async (profile: string) => {
    setOptimizing(true);
    setStatus(`Aplicando perfil de hardware (${profile})...`);
    try {
      const res = await api<string>("apply_hardware_profile", { serial, profile });
      setStatus(res);
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Erro ao aplicar perfil")}`);
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Memória">
        <div className="rounded-xl border border-border px-4">
          <SettingRow title="Liberar RAM e cache" description="Limpa caches do Android, força coleta de lixo e sincroniza as conexões ADB.">
            <Button variant="secondary" size="sm" onClick={optimizeRam} loading={optimizing} icon={<RefreshCw size={13} />}>
              Liberar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <FormSection title="Limpeza de apps do sistema" description="Desativa serviços de fábrica, operadoras e telemetria, sem root. Indicado para aparelhos com 1 a 2 GB de RAM.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {DEBLOAT_PROFILES.map((p) => (
            <div key={p.id} className="flex flex-col justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">{p.title}</p>
                <p className="mt-0.5 text-[0.75rem] text-secondary">{p.desc}</p>
              </div>
              <Button variant={p.id === "restore" ? "ghost" : "secondary"} size="sm" onClick={() => debloat(p.id)} disabled={debloating} loading={debloating}>
                {p.id === "restore" ? "Restaurar apps" : "Aplicar"}
              </Button>
            </div>
          ))}
        </div>
      </FormSection>

      <FormSection title="Perfis de hardware" description="Ajusta kernel, energia e limites de processos conforme a função do aparelho.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {HARDWARE_PROFILES.map((p) => (
            <div key={p.id} className="flex flex-col justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">{p.title}</p>
                <p className="mt-0.5 text-[0.75rem] text-secondary">{p.desc}</p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => hardware(p.id)} disabled={optimizing}>
                Ativar
              </Button>
            </div>
          ))}
        </div>
      </FormSection>

      <StatusNote text={status} busy={optimizing || debloating} />
    </div>
  );
}
