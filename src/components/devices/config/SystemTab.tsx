import { useState } from "react";
import Button from "../../ui/Button";
import { FormSection } from "../../ui/Field";
import type { Device } from "../../../types";
import { api } from "../../../tauri";
import { RefreshCw, Package, Power, Trash2, AlertTriangle } from "lucide-react";
import { StatusNote, SettingRow, errText } from "./shared";

interface Props {
  device: Device;
  serial: string;
  vpsUrl: string;
  displayName: string;
  onRemove?: (device: Device) => void;
  onClose: () => void;
}

export function SystemTab({ device, serial, vpsUrl, displayName, onRemove, onClose }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [installingApk, setInstallingApk] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const reprovision = async () => {
    setProvisioning(true);
    setMsg("Gravando a identidade e configurando o Agente Esfera...");
    try {
      const res = await api<string>("provision_device", { serial, server_url: vpsUrl.trim() || null });
      setMsg(res);
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Falha no provisionamento")}`);
    } finally {
      setProvisioning(false);
    }
  };

  const installApk = async () => {
    setInstallingApk(true);
    setMsg("Instalando a versão mais recente do Agente...");
    try {
      const res = await api<string>("install_agent_apk", { serial });
      setMsg(res);
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Falha na instalação do APK")}`);
    } finally {
      setInstallingApk(false);
    }
  };

  const reboot = async () => {
    if (!confirm("Reiniciar este aparelho agora?")) return;
    setRebooting(true);
    setMsg("Enviando comando de reinicialização...");
    try {
      await api("reboot_adb_device", { serial });
      setMsg("Celular reiniciando. Ele reconecta automaticamente.");
    } catch (e: any) {
      setMsg(`Erro: ${errText(e, "Falha ao reiniciar")}`);
    } finally {
      setRebooting(false);
    }
  };

  const executeRemove = async () => {
    setRemoving(true);
    try {
      if (onRemove) {
        onRemove(device);
      } else {
        await api("disconnect_adb_device", { serial });
        await api("delete_device", { serial: device.esferaDeviceId || serial });
        onClose();
      }
    } catch (e: any) {
      alert(`Erro ao remover: ${errText(e, "Erro desconhecido")}`);
    } finally {
      setRemoving(false);
      setConfirmDeleteOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Agente Esfera">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow
            title="Provisionar agente"
            description={`Grava a identidade ${device.esferaDeviceId || device.serial} no aparelho e inicia o serviço do Agente apontando para o servidor.`}
          >
            <Button variant="primary" size="sm" onClick={reprovision} loading={provisioning} icon={<RefreshCw size={13} />}>
              Provisionar
            </Button>
          </SettingRow>
          <SettingRow title="Reinstalar APK do Agente" description="Envia e instala a versão mais recente do Agente via ADB.">
            <Button variant="secondary" size="sm" onClick={installApk} loading={installingApk} icon={<Package size={13} />}>
              Reinstalar
            </Button>
          </SettingRow>
          <SettingRow title="Reiniciar aparelho" description="Reinicia o celular remotamente; ele reconecta sozinho.">
            <Button variant="secondary" size="sm" onClick={reboot} loading={rebooting} icon={<Power size={13} />}>
              Reiniciar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <StatusNote text={msg} busy={provisioning || installingApk || rebooting} />

      <FormSection title="Zona de perigo">
        <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-500" />
            <p className="text-[0.8125rem] text-secondary">
              Desconecta o celular da rede ADB e remove sua identidade do sistema. Para reconectar será preciso plugá-lo no USB ou informar o IP.
            </p>
          </div>
          {!confirmDeleteOpen ? (
            <Button variant="danger" size="sm" onClick={() => setConfirmDeleteOpen(true)} icon={<Trash2 size={13} />}>
              Remover {displayName}
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-red-500/40 bg-card p-3 animate-scale-in">
              <p className="text-[0.8125rem] font-medium text-primary">Remover este aparelho permanentemente?</p>
              <div className="flex items-center gap-2">
                <Button variant="danger" size="sm" onClick={executeRemove} loading={removing} icon={<Trash2 size={13} />}>
                  Sim, remover
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteOpen(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>
      </FormSection>
    </div>
  );
}
