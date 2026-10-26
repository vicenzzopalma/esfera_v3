// Parâmetros de IA da empresa (padrão para todas as campanhas).
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, PlugZap } from "lucide-react";
import Modal from "../../components/ui/Modal";
import Button from "../../components/ui/Button";
import Field, { FormSection } from "../../components/ui/Field";
import { useAuth } from "../../context/AuthContext";
import type { AiConfig } from "../../types";
import { api } from "../../tauri";
import { getAiProviderInfo } from "../../constants/aiProviders";
import { InlineAlert, ProviderOptions } from "./shared";
import { ModelSuggestions } from "./AiFields";

type ProviderKeys = Record<string, { apiKey: string; endpoint: string; model: string }>;

export default function GlobalAiConfigModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { selectedCompanyId } = useAuth();
  const [provider, setProvider] = useState("openrouter");
  const [endpoint, setEndpoint] = useState("https://openrouter.ai/api/v1/chat/completions");
  const [model, setModel] = useState("openrouter/free");
  const [temperature, setTemperature] = useState(0.7);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(
    "Você é um assistente comercial brasileiro experiente. Redija mensagens diretas, simpáticas e humanizadas para o WhatsApp."
  );
  const [savedProviderKeys, setSavedProviderKeys] = useState<ProviderKeys>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingAi, setTestingAi] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!isOpen || !selectedCompanyId) return;
    setLoading(true);
    setStatus(null);
    setShowKey(false);
    api<AiConfig>("get_ai_config", { companyId: selectedCompanyId })
      .then((cfg) => {
        if (!cfg) return;
        setProvider(cfg.provider === "ollama_local" ? "ollama" : cfg.provider || "openrouter");
        setEndpoint(cfg.endpoint || "https://openrouter.ai/api/v1/chat/completions");
        setModel(cfg.model || "openrouter/free");
        setTemperature(cfg.temperature ?? 0.7);
        setApiKey(cfg.apiKey || "");
        setSystemPrompt(cfg.systemPrompt || "");
        setTestResult(null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    api<ProviderKeys>("get_ai_provider_keys", { companyId: selectedCompanyId })
      .then((keys) => {
        if (keys) setSavedProviderKeys(keys);
      })
      .catch(() => {});
  }, [isOpen, selectedCompanyId]);

  const info = getAiProviderInfo(provider);
  const isLocal = provider === "ollama" || provider === "lmstudio";

  const changeProvider = (next: string) => {
    setProvider(next);
    setTestResult(null);
    const pInfo = getAiProviderInfo(next);
    if (savedProviderKeys[next]) {
      setEndpoint(savedProviderKeys[next].endpoint || pInfo?.defaultEndpoint || "");
      setModel(savedProviderKeys[next].model || pInfo?.defaultModel || "");
      setApiKey(savedProviderKeys[next].apiKey || "");
    } else if (pInfo) {
      setEndpoint(pInfo.defaultEndpoint);
      setModel(pInfo.defaultModel);
      setApiKey("");
    }
  };

  const handleSave = async () => {
    if (!selectedCompanyId) return;
    setSaving(true);
    try {
      await api("save_ai_config", {
        companyId: selectedCompanyId,
        config: { companyId: selectedCompanyId, provider, model, temperature, systemPrompt, apiKey, endpoint },
      });
      setSavedProviderKeys((prev) => ({ ...prev, [provider]: { apiKey, endpoint, model } }));
      setStatus({ ok: true, text: "Configuração de IA salva." });
      setTimeout(() => onClose(), 1200);
    } catch {
      setStatus({ ok: false, text: "Não foi possível salvar a configuração de IA. Tente de novo." });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!selectedCompanyId) return;
    setTestingAi(true);
    setTestResult(null);
    try {
      const rewritten = await api<string>("rewrite_message_ai", {
        message: "Olá {nome}! Seu boleto de R$ 89,90 vence hoje. Pague via PIX financeiro@empresa.com ou no link https://empresa.com/fatura",
        contactName: "Mariana",
        companyId: selectedCompanyId,
        provider,
        model,
        prompt: systemPrompt,
        apiKey,
        endpoint,
      });
      setTestResult({ success: true, text: rewritten });
    } catch (err) {
      setTestResult({ success: false, text: String(err) });
    } finally {
      setTestingAi(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Configurar IA"
      description="Padrão da empresa para reescrever mensagens. Cada campanha pode usar outro provedor ou modelo."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={loading}>
            Salvar
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-10 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {status && (
            <InlineAlert tone={status.ok ? "success" : "danger"} icon={status.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />} title={status.text} />
          )}

          <FormSection title="Provedor e modelo">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Provedor" htmlFor="ai-provider">
                <select id="ai-provider" value={provider} onChange={(e) => changeProvider(e.target.value)}>
                  <ProviderOptions />
                </select>
              </Field>
              <Field label="Modelo" htmlFor="ai-model">
                <input id="ai-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="openrouter/free" className="font-mono" />
              </Field>
            </div>
            <ModelSuggestions provider={provider} model={model} onPick={setModel} />
          </FormSection>

          <FormSection title="Conexão" description={isLocal ? "Provedor local: não precisa de chave, apenas do endereço do servidor." : undefined}>
            <Field label="Endereço da API" htmlFor="ai-endpoint">
              <input
                id="ai-endpoint"
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://openrouter.ai/api/v1/chat/completions"
                className="font-mono"
              />
            </Field>
            {!isLocal && (
              <Field
                label="Chave de API"
                htmlFor="ai-key"
                hint={info?.keyHint}
              >
                <div className="relative">
                  <input
                    id="ai-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={info?.keyPlaceholder || "sk-..."}
                    autoComplete="off"
                    spellCheck={false}
                    className="input-with-icon-right font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    aria-label={showKey ? "Ocultar chave" : "Mostrar chave"}
                    className="input-icon-right rounded-md p-1 text-tertiary hover:text-[var(--color-text-primary)] cursor-pointer"
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </Field>
            )}
            <div className="space-y-2.5 rounded-lg border border-border px-3.5 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[0.8125rem] font-medium text-primary">Testar conexão</p>
                  <p className="text-[0.75rem] text-tertiary">Envia uma mensagem de exemplo com os dados acima, sem salvar.</p>
                </div>
                <Button size="sm" variant="secondary" icon={<PlugZap size={13} />} onClick={handleTest} loading={testingAi}>
                  {testingAi ? "Testando…" : "Testar"}
                </Button>
              </div>
              {testResult && (
                <InlineAlert
                  tone={testResult.success ? "success" : "danger"}
                  icon={testResult.success ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                  title={testResult.success ? "Conexão funcionando" : "O teste falhou"}
                >
                  <span className="whitespace-pre-wrap break-words text-[0.75rem]">{testResult.text}</span>
                </InlineAlert>
              )}
            </div>
          </FormSection>

          <FormSection title="Comportamento">
            <Field
              label="Temperatura"
              htmlFor="ai-temp"
              aside={<span className="tabular-nums text-primary">{temperature.toFixed(2)}</span>}
              hint="Valores entre 0,3 e 0,7 mantêm links e números intactos. Valores altos deixam o texto mais criativo."
            >
              <input id="ai-temp" type="range" min="0" max="1" step="0.05" value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label="Instrução padrão" htmlFor="ai-prompt" hint="Regras que a IA segue ao reescrever qualquer mensagem da empresa.">
              <textarea
                id="ai-prompt"
                rows={4}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Você é um assistente comercial brasileiro. Seja simpático, breve e direto. Nunca invente informações."
                className="resize-y"
              />
            </Field>
          </FormSection>
        </div>
      )}
    </Modal>
  );
}
