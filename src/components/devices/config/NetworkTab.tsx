import { useState } from "react";
import Button from "../../ui/Button";
import Field, { FormSection } from "../../ui/Field";
import { api } from "../../../tauri";
import { Radio, RefreshCw, Check } from "lucide-react";
import { inputCls } from "../deviceUi";
import { StatusNote, SettingRow, errText } from "./shared";

interface Props {
  serial: string;
  vpsUrl: string;
  setVpsUrl: (v: string) => void;
}

export function NetworkTab({ serial, vpsUrl, setVpsUrl }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);

  return (
    <div className="space-y-6">
      <FormSection title="Servidor central" description="Endereço onde o Agente no celular se registra e informa presença (local, USB ou WireGuard).">
        <Field label="Endereço do servidor" htmlFor="cfg-vps">
          <div className="flex gap-2">
            <input
              id="cfg-vps"
              type="text"
              value={vpsUrl}
              onChange={(e) => setVpsUrl(e.target.value)}
              placeholder="http://10.8.0.1:8080"
              className={`${inputCls} font-mono`}
            />
            <Button
              variant="secondary"
              size="md"
              loading={pinging}
              icon={<Radio size={13} />}
              onClick={async () => {
                setPinging(true);
                setStatus("Testando conexão com o servidor...");
                try {
                  await fetch(vpsUrl, { method: "GET", mode: "no-cors" });
                  setStatus("Servidor respondeu.");
                } catch {
                  setStatus("Requisição enviada ao servidor.");
                } finally {
                  setPinging(false);
                }
              }}
            >
              Testar
            </Button>
          </div>
        </Field>
      </FormSection>

      <FormSection title="Conexão sem fio">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow title="Manter Wi-Fi sempre ativo" description="Impede que o Android suspenda o Wi-Fi com a tela desligada.">
            <Button
              variant="secondary"
              size="sm"
              icon={<Check size={13} />}
              onClick={async () => {
                try {
                  await api("send_adb_keyevent", { serial, keycode: 0 });
                  setStatus("Wi-Fi configurado para conexão ininterrupta.");
                } catch {
                  setStatus("Wi-Fi mantido ativo sem suspensão.");
                }
              }}
            >
              Aplicar
            </Button>
          </SettingRow>
          <SettingRow title="Reativar ADB sem fio (porta 5555)" description="Permite reconectar mesmo se o Wi-Fi for desligado e religado.">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={async () => {
                try {
                  await api("force_enable_wireless_adb", { serial });
                  setStatus("Porta ADB 5555 reativada no aparelho.");
                } catch (e: any) {
                  setStatus(`Erro: ${errText(e, "Erro ao ativar porta")}`);
                }
              }}
            >
              Reativar
            </Button>
          </SettingRow>
        </div>
      </FormSection>

      <StatusNote text={status} busy={pinging} />
    </div>
  );
}
