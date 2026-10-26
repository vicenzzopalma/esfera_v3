// Assistente em etapas para criar ou editar uma campanha.
import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, ArrowLeft, ArrowRight } from "lucide-react";
import Modal from "../../components/ui/Modal";
import Button from "../../components/ui/Button";
import Field, { FormSection } from "../../components/ui/Field";
import { useAuth } from "../../context/AuthContext";
import type { Campaign, Device } from "../../types";
import { api } from "../../tauri";
import { getAiProviderInfo } from "../../constants/aiProviders";
import Stepper, { type StepDef } from "./Stepper";
import MessageFields, { type MessageValue } from "./MessageFields";
import WhatsAppPreview from "./WhatsAppPreview";
import AiFields, { type AiValue } from "./AiFields";
import DelayFields, { delayError } from "./DelayFields";
import DevicePicker, { deviceSelectionStats } from "./DevicePicker";
import { InlineAlert, campaignUsesAi, delaySummary, joinMessage } from "./shared";

type StepId = "basics" | "message" | "ai" | "sending" | "review";

const STEPS: StepDef<StepId>[] = [
  { id: "basics", label: "Básico" },
  { id: "message", label: "Mensagem" },
  { id: "ai", label: "IA", optional: true },
  { id: "sending", label: "Envio" },
  { id: "review", label: "Revisão" },
];

interface FormState extends MessageValue, AiValue {
  name: string;
  delayMin: number;
  delayMax: number;
  deviceIds: string[];
}

function initialForm(c: Campaign | null): FormState {
  if (c) {
    return {
      name: c.name || "",
      greeting: c.greeting || "",
      body: c.message || "",
      closing: c.closing || "",
      useSpintax: c.useSpintax ?? true,
      useAI: campaignUsesAi(c),
      aiProvider: c.aiProvider || "",
      aiModel: c.aiModel || "",
      aiPrompt: c.aiPrompt || "",
      delayMin: c.delayMin || 30,
      delayMax: c.delayMax || 90,
      deviceIds: c.deviceIds || [],
    };
  }
  return {
    name: "",
    greeting: "{Olá|Oi|Bom dia} {nome}, tudo bem?",
    body: "Temos uma condição especial disponível para você hoje!",
    closing: "Atenciosamente, {Equipe REALESS|Setor Financeiro}",
    useSpintax: true,
    useAI: false,
    aiProvider: "",
    aiModel: "",
    aiPrompt: "",
    delayMin: 30,
    delayMax: 90,
    deviceIds: [],
  };
}

const autoName = () =>
  `Campanha ${new Date().toLocaleDateString("pt-BR")} ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

export default function CampaignWizard({
  isOpen,
  onClose,
  campaign,
  onSaved,
  initialStep = "basics",
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onSaved: (campaign: Campaign, meta: { created: boolean; openAfter: boolean }) => void;
  initialStep?: StepId;
}) {
  const { selectedCompanyId } = useAuth();
  const isEdit = Boolean(campaign?.id);
  const [form, setForm] = useState<FormState>(() => initialForm(campaign));
  const [step, setStep] = useState<StepId>(initialStep);
  const [visited, setVisited] = useState<number>(0);
  const [showErrors, setShowErrors] = useState<Partial<Record<StepId, boolean>>>({});
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setForm(initialForm(campaign));
    setStep(initialStep);
    setVisited(isEdit ? STEPS.length - 1 : STEPS.findIndex((s) => s.id === initialStep));
    setShowErrors({});
    setSaveError("");
    // Reinicia só ao abrir ou trocar de campanha (a lista atualiza ao vivo durante o disparo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, campaign?.id]);

  const loadDevices = async () => {
    if (!selectedCompanyId) return;
    setDevicesLoading(true);
    try {
      const data = await api<Device[]>("get_devices", { companyId: selectedCompanyId });
      setDevices(data || []);
    } catch {
      /* mantém lista */
    } finally {
      setDevicesLoading(false);
      setDevicesLoaded(true);
    }
  };

  useEffect(() => {
    if (isOpen && (step === "sending" || step === "review") && !devicesLoaded) loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, step, devicesLoaded]);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  const errors: Partial<Record<StepId, string>> = {
    message: form.body.trim() ? undefined : "Escreva a mensagem que será enviada.",
    sending: delayError(form.delayMin, form.delayMax),
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const isLast = stepIndex === STEPS.length - 1;

  const goTo = (id: StepId) => {
    const idx = STEPS.findIndex((s) => s.id === id);
    setStep(id);
    setVisited((v) => Math.max(v, idx));
  };

  const next = () => {
    if (errors[step]) {
      setShowErrors((s) => ({ ...s, [step]: true }));
      return;
    }
    if (!isLast) goTo(STEPS[stepIndex + 1].id);
  };

  const save = async (mode: "draft" | "final") => {
    if (!selectedCompanyId) return;
    // Rascunho só exige intervalo válido; criar/salvar exige mensagem também.
    const required: StepId[] = mode === "draft" ? ["sending"] : ["message", "sending"];
    const firstInvalid = required.find((id) => errors[id]);
    if (firstInvalid) {
      setShowErrors((s) => ({ ...s, [firstInvalid]: true }));
      goTo(firstInvalid);
      return;
    }
    setSaving(true);
    setSaveError("");
    const payload = {
      id: campaign?.id || 0,
      name: form.name.trim() || autoName(),
      greeting: form.greeting,
      message: form.body,
      closing: form.closing,
      delayMin: parseInt(String(form.delayMin), 10) || 30,
      delayMax: parseInt(String(form.delayMax), 10) || 90,
      useSpintax: form.useSpintax,
      useAi: form.useAI,
      aiModel: form.aiModel,
      aiProvider: form.aiProvider,
      aiPrompt: form.aiPrompt,
      deviceIds: form.deviceIds,
      status: campaign?.status || "draft",
      contactsCount: campaign?.contactsCount || 0,
      sentCount: campaign?.sentCount || 0,
      failedCount: campaign?.failedCount || 0,
      companyId: selectedCompanyId,
      updatedAt: new Date().toISOString().split("T")[0],
    };
    try {
      if (campaign?.id) {
        await api("update_campaign", { campaign: payload });
      } else {
        const newId = await api<number>("create_campaign", { campaign: payload });
        if (newId) payload.id = newId;
      }
      onSaved(payload as unknown as Campaign, { created: !campaign?.id, openAfter: !campaign?.id && mode === "final" });
      onClose();
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const fullMessage = joinMessage(form.greeting, form.body, form.closing);
  const invalidSteps = (Object.keys(showErrors) as StepId[]).filter((id) => showErrors[id] && errors[id]);
  const devStats = deviceSelectionStats(devices, form.deviceIds);
  const providerName = form.aiProvider ? getAiProviderInfo(form.aiProvider)?.name || form.aiProvider : "Padrão da empresa";

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <Button variant="ghost" onClick={onClose} disabled={saving}>
        Cancelar
      </Button>
      <div className="flex items-center gap-2">
        {!isEdit && !isLast && (
          <Button variant="ghost" onClick={() => save("draft")} disabled={saving}>
            Salvar rascunho
          </Button>
        )}
        {stepIndex > 0 && (
          <Button variant="secondary" icon={<ArrowLeft size={14} />} onClick={() => goTo(STEPS[stepIndex - 1].id)} disabled={saving}>
            Voltar
          </Button>
        )}
        {isEdit ? (
          <>
            {!isLast && (
              <Button variant="secondary" onClick={next} disabled={saving}>
                Avançar <ArrowRight size={14} />
              </Button>
            )}
            <Button onClick={() => save("final")} loading={saving}>
              Salvar alterações
            </Button>
          </>
        ) : isLast ? (
          <Button onClick={() => save("final")} loading={saving}>
            Criar campanha
          </Button>
        ) : (
          <Button onClick={next}>
            Avançar <ArrowRight size={14} />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? "Editar campanha" : "Nova campanha"}
      description={isEdit ? campaign?.name : undefined}
      size="2xl"
      footer={footer}
    >
      <div className="space-y-6">
        <Stepper steps={STEPS} current={step} onSelect={goTo} invalid={invalidSteps} reachable={(_, i) => isEdit || i <= visited} />

        {saveError && (
          <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Não foi possível salvar" onDismiss={() => setSaveError("")}>
            {saveError}
          </InlineAlert>
        )}

        {step === "basics" && (
          <FormSection title="Como esta campanha vai se chamar?" description="Um nome que você reconheça na lista. Dá para mudar depois." className="max-w-xl">
            <Field label="Nome da campanha" htmlFor="cmp-name" hint={`Se ficar em branco, usaremos "${autoName()}".`}>
              <input
                id="cmp-name"
                type="text"
                autoFocus
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && next()}
                placeholder="Promoção de julho"
              />
            </Field>
          </FormSection>
        )}

        {step === "message" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <FormSection title="Mensagem" description="Saudação, corpo e encerramento são enviados juntos, nesta ordem.">
              <MessageFields
                value={form}
                onChange={(p) => patch(p)}
                bodyError={showErrors.message ? errors.message : undefined}
              />
            </FormSection>
            <div className="lg:sticky lg:top-0 lg:self-start">
              <WhatsAppPreview greeting={form.greeting} body={form.body} closing={form.closing} useSpintax={form.useSpintax} aiNote={form.useAI} />
            </div>
          </div>
        )}

        {step === "ai" && (
          <FormSection
            title="Personalização com IA"
            description="Opcional. Sem IA, a mensagem é enviada como escrita (com as variações, se ativas)."
            className="max-w-3xl"
          >
            <AiFields value={form} onChange={(p) => patch(p)} companyId={selectedCompanyId} messageForTest={fullMessage} />
          </FormSection>
        )}

        {step === "sending" && (
          <div className="space-y-8">
            <FormSection title="Ritmo de envio" description="Intervalos aleatórios entre mensagens deixam o disparo mais natural." className="max-w-3xl">
              <DelayFields min={form.delayMin} max={form.delayMax} onChange={(p) => patch(p)} />
            </FormSection>
            <FormSection
              title="Aparelhos"
              description="Quais celulares podem enviar esta campanha. Os envios são distribuídos entre os selecionados que estiverem online. Você também pode definir isso depois."
            >
              <DevicePicker
                devices={devices}
                loading={devicesLoading && !devicesLoaded}
                selected={form.deviceIds}
                onChange={(ids) => patch({ deviceIds: ids })}
                onRefresh={loadDevices}
                refreshing={devicesLoading}
                listClassName="max-h-[300px]"
              />
            </FormSection>
          </div>
        )}

        {step === "review" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <div className="space-y-4">
              <dl className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-border">
                <ReviewRow label="Nome" onEdit={() => goTo("basics")}>
                  {form.name.trim() || <span className="text-tertiary">{autoName()} (automático)</span>}
                </ReviewRow>
                <ReviewRow label="Mensagem" onEdit={() => goTo("message")}>
                  {form.body.trim() ? (
                    <>
                      {fullMessage.length} caracteres · {form.useSpintax ? "com variações" : "sem variações"}
                    </>
                  ) : (
                    <span className="text-red-600 dark:text-red-400">Mensagem vazia</span>
                  )}
                </ReviewRow>
                <ReviewRow label="IA" onEdit={() => goTo("ai")}>
                  {form.useAI ? `${providerName}${form.aiModel ? ` · ${form.aiModel}` : ""}` : "Desativada"}
                </ReviewRow>
                <ReviewRow label="Ritmo" onEdit={() => goTo("sending")}>
                  {errors.sending ? <span className="text-red-600 dark:text-red-400">{errors.sending}</span> : delaySummary(form.delayMin, form.delayMax)}
                </ReviewRow>
                <ReviewRow label="Aparelhos" onEdit={() => goTo("sending")}>
                  {form.deviceIds.length === 0 ? (
                    <span className="text-amber-700 dark:text-amber-300">Nenhum selecionado</span>
                  ) : (
                    <>
                      {form.deviceIds.length} selecionado{form.deviceIds.length > 1 ? "s" : ""}
                      {devicesLoaded && <span className="text-tertiary"> · {devStats.selectedOnline} online agora</span>}
                    </>
                  )}
                </ReviewRow>
              </dl>
              {!isEdit && (
                <InlineAlert tone="info" title="Próximo passo: contatos">
                  Depois de criar, você vai direto para a campanha para importar a lista de contatos e iniciar o disparo.
                </InlineAlert>
              )}
            </div>
            <WhatsAppPreview greeting={form.greeting} body={form.body} closing={form.closing} useSpintax={form.useSpintax} aiNote={form.useAI} />
          </div>
        )}
      </div>
    </Modal>
  );
}

function ReviewRow({ label, children, onEdit }: { label: string; children: ReactNode; onEdit: () => void }) {
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <dt className="w-24 shrink-0 text-[0.8125rem] text-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 text-[0.8125rem] text-primary">{children}</dd>
      <button type="button" onClick={onEdit} className="shrink-0 text-[0.75rem] text-[var(--color-accent-light)] hover:underline cursor-pointer">
        Alterar
      </button>
    </div>
  );
}
