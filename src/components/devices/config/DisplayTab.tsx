import { useState } from "react";
import Button from "../../ui/Button";
import Toggle from "../../ui/Toggle";
import Field, { FormSection } from "../../ui/Field";
import { SegmentedControl } from "../../ui/Tabs";
import { api } from "../../../tauri";
import { Sliders } from "lucide-react";
import { inputCls } from "../deviceUi";
import { StatusNote, SettingRow, errText } from "./shared";

export function DisplayTab({ serial }: { serial: string }) {
  const [stayAwake, setStayAwake] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [showTouches, setShowTouches] = useState(false);
  const [animScale, setAnimScale] = useState<number>(0);
  const [customDpi, setCustomDpi] = useState<number>(0);
  const [status, setStatus] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    setApplying(true);
    setStatus("Aplicando ajustes de tela...");
    try {
      await api("apply_device_settings", {
        serial,
        stayAwake,
        darkMode,
        showTouches,
        animationScale: animScale,
        dpi: customDpi > 0 ? customDpi : null,
      });
      setStatus("Ajustes aplicados no aparelho.");
    } catch (e: any) {
      setStatus(`Erro: ${errText(e, "Falha ao aplicar")}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-6">
      <FormSection title="Tela e interface">
        <div className="divide-y divide-border rounded-xl border border-border px-4">
          <SettingRow title="Modo escuro do Android" description="Ativa o tema escuro no sistema do celular.">
            <Toggle checked={darkMode} onChange={setDarkMode} />
          </SettingRow>
          <SettingRow title="Manter tela ligada no carregador" description="Impede que a tela apague enquanto estiver na energia.">
            <Toggle checked={stayAwake} onChange={setStayAwake} />
          </SettingRow>
          <SettingRow title="Exibir toques na tela" description="Mostra onde o operador ou a automação está tocando.">
            <Toggle checked={showTouches} onChange={setShowTouches} />
          </SettingRow>
        </div>
      </FormSection>

      <FormSection title="Animações" description="0x remove transições e acelera a automação.">
        <SegmentedControl<string>
          items={[
            { id: "0", label: "0x (máximo desempenho)" },
            { id: "0.5", label: "0,5x" },
            { id: "1", label: "1x (padrão)" },
          ]}
          value={String(animScale)}
          onChange={(v) => setAnimScale(parseFloat(v))}
        />
      </FormSection>

      <FormSection title="Densidade de tela (DPI)">
        <Field label="DPI personalizado" htmlFor="cfg-dpi" hint="Deixe vazio para manter o padrão do aparelho.">
          <div className="flex gap-2">
            <input
              id="cfg-dpi"
              type="number"
              value={customDpi || ""}
              onChange={(e) => setCustomDpi(parseInt(e.target.value, 10) || 0)}
              placeholder="Padrão"
              className={inputCls}
            />
            <Button variant="secondary" size="md" onClick={() => setCustomDpi(0)}>
              Restaurar padrão
            </Button>
          </div>
        </Field>
      </FormSection>

      <div className="space-y-3">
        <Button variant="primary" size="md" onClick={apply} loading={applying} icon={<Sliders size={14} />}>
          Aplicar no aparelho
        </Button>
        <StatusNote text={status} busy={applying} />
      </div>
    </div>
  );
}
