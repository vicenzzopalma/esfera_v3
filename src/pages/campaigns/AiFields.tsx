// Configuração de IA por campanha (provedor, modelo, instrução) + teste de reescrita.
import { useState } from "react";
import { AlertCircle, Sparkles } from "lucide-react";
import Field from "../../components/ui/Field";
import Toggle from "../../components/ui/Toggle";
import Button from "../../components/ui/Button";
import { api } from "../../tauri";
import { getAiProviderInfo } from "../../constants/aiProviders";
import { ProviderOptions, InlineAlert } from "./shared";
import { ChatBubble } from "./WhatsAppPreview";

export interface AiValue {
  useAI: boolean;
  aiProvider: string;
  aiModel: string;
  aiPrompt: string;
}

export function ModelSuggestions({ provider, model, onPick }: { provider: string; model: string; onPick: (id: string) => void }) {
  const info = getAiProviderInfo(provider);
  if (!info || info.suggestedModels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {info.suggestedModels.map((m) => {
        const active = model === m.id;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onPick(m.id)}
            aria-pressed={active}
            className={`rounded-md border px-2 py-1 text-[0.75rem] transition-colors cursor-pointer ${
              active
                ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-primary"
                : "border-border text-secondary hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
            }`}
          >
            {m.name} <span className="text-tertiary">· {m.tag}</span>
          </button>
        );
      })}
    </div>
  );
}

export default function AiFields({
  value,
  onChange,
  companyId,
  messageForTest,
}: {
  value: AiValue;
  onChange: (patch: Partial<AiValue>) => void;
  companyId: number | null;
  messageForTest: string;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; text: string } | null>(null);

  const handleTest = async () => {
    const msg = messageForTest.trim();
    if (!msg) {
      setResult({ success: false, text: "Escreva a mensagem antes de testar a reescrita com IA." });
      return;
    }
    setTesting(true);
    setResult(null);
    try {
      const rewritten = await api<string>("rewrite_message_ai", {
        message: msg,
        contactName: "Maria",
        companyId,
        model: value.aiModel,
        prompt: value.aiPrompt,
        provider: value.aiProvider,
      });
      setResult({ success: true, text: rewritten });
    } catch (error) {
      setResult({ success: false, text: String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-medium text-primary">Reescrever mensagens com IA</p>
          <p className="text-[0.75rem] text-tertiary">
            A IA reescreve o texto para cada contato de forma humanizada, reduzindo o risco de bloqueio por spam. Se a IA falhar, o texto original é enviado.
          </p>
        </div>
        <Toggle checked={value.useAI} onChange={(v) => onChange({ useAI: v })} />
      </div>

      {value.useAI && (
        <div className="space-y-4 animate-fade-in">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Provedor" htmlFor="cmp-ai-provider" hint="Use o padrão da empresa ou escolha um específico para esta campanha.">
              <select
                id="cmp-ai-provider"
                value={value.aiProvider}
                onChange={(e) => {
                  const val = e.target.value;
                  const info = getAiProviderInfo(val);
                  onChange({ aiProvider: val, aiModel: info ? info.defaultModel : "" });
                }}
              >
                <ProviderOptions includeDefault />
              </select>
            </Field>
            <Field label="Modelo" htmlFor="cmp-ai-model" hint={value.aiProvider ? undefined : "Vazio usa o modelo padrão da empresa."}>
              <input
                id="cmp-ai-model"
                type="text"
                value={value.aiModel}
                onChange={(e) => onChange({ aiModel: e.target.value })}
                placeholder="openrouter/free"
                className="font-mono"
              />
            </Field>
          </div>
          <ModelSuggestions provider={value.aiProvider} model={value.aiModel} onPick={(id) => onChange({ aiModel: id })} />

          <Field label="Instrução para a IA" htmlFor="cmp-ai-prompt" hint="Opcional. Diga o tom e o que não pode mudar.">
            <textarea
              id="cmp-ai-prompt"
              rows={3}
              value={value.aiPrompt}
              onChange={(e) => onChange({ aiPrompt: e.target.value })}
              placeholder="Reescreva com tom coloquial e direto, mantendo links e chave PIX intactos."
              className="resize-y"
            />
          </Field>

          <div className="space-y-3 rounded-lg border border-border bg-[var(--color-bg-hover)] p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">Testar reescrita</p>
                <p className="text-[0.75rem] text-tertiary">Gera uma versão da sua mensagem para o contato de exemplo "Maria".</p>
              </div>
              <Button size="sm" variant="secondary" icon={<Sparkles size={13} />} onClick={handleTest} loading={testing}>
                {testing ? "Gerando…" : "Testar"}
              </Button>
            </div>
            {result &&
              (result.success ? (
                <ChatBubble text={result.text} />
              ) : (
                <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Não foi possível gerar">
                  <span className="break-words font-mono text-[0.75rem]">{result.text}</span>
                </InlineAlert>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
