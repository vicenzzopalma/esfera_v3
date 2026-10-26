// Visão de detalhe de uma campanha: execução, contatos, aparelhos e configurações.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  LayoutDashboard,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Settings2,
  Smartphone,
  Square,
  Upload,
  Users,
  XCircle,
} from "lucide-react";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import StatCard from "../../components/ui/StatCard";
import { Tabs } from "../../components/ui/Tabs";
import { FormSection } from "../../components/ui/Field";
import type { Campaign, Contact, Device } from "../../types";
import { api } from "../../tauri";
import ActionMenu from "./ActionMenu";
import ConfirmDialog from "./ConfirmDialog";
import ContactsPanel from "./ContactsPanel";
import DevicePicker, { deviceSelectionStats } from "./DevicePicker";
import MessageFields from "./MessageFields";
import WhatsAppPreview from "./WhatsAppPreview";
import AiFields from "./AiFields";
import DelayFields, { delayError } from "./DelayFields";
import LogConsole, { type LogLevel, type LogLine } from "./LogConsole";
import { InlineAlert, ProgressBar, campaignUsesAi, countsFromContacts, delaySummary, formatDuration, formatNumber, joinMessage, statusInfo } from "./shared";

export type DetailTab = "overview" | "contacts" | "devices" | "settings";

interface Draft {
  greeting: string;
  body: string;
  closing: string;
  useSpintax: boolean;
  delayMin: number;
  delayMax: number;
  useAI: boolean;
  aiProvider: string;
  aiModel: string;
  aiPrompt: string;
  deviceIds: string[];
}

function draftFrom(c: Campaign): Draft {
  return {
    greeting: c.greeting || "",
    body: c.message || "",
    closing: c.closing || "",
    useSpintax: c.useSpintax ?? true,
    delayMin: c.delayMin || 30,
    delayMax: c.delayMax || 90,
    useAI: campaignUsesAi(c),
    aiProvider: c.aiProvider || "",
    aiModel: c.aiModel || "",
    aiPrompt: c.aiPrompt || "",
    deviceIds: c.deviceIds || [],
  };
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

export default function CampaignDetail({
  campaign,
  syncRevision,
  importRevision,
  initialTab = "overview",
  logs,
  onLog,
  onClearLogs,
  onBack,
  onEdit,
  onImport,
  onUpdateCampaign,
}: {
  campaign: Campaign;
  syncRevision: number;
  importRevision: number;
  initialTab?: DetailTab;
  logs: LogLine[];
  onLog: (level: LogLevel, text: string) => void;
  onClearLogs: () => void;
  onBack: () => void;
  onEdit: () => void;
  onImport: () => void;
  onUpdateCampaign: (updated: Campaign) => void;
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(campaign));
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "start" | "pause" | "stop" | "retry" | "reset" | "save" | "saveDevices">("");
  const [savedFlash, setSavedFlash] = useState<"" | "settings" | "devices">("");
  const [confirm, setConfirm] = useState<"" | "stop" | "reset">("");

  // Ressincroniza o rascunho ao trocar de campanha ou após edição pelo assistente.
  useEffect(() => {
    setDraft(draftFrom(campaign));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign.id, syncRevision]);

  useEffect(() => {
    setTab(initialTab);
  }, [campaign.id, initialTab]);

  const loadContacts = useCallback(() => {
    setContactsLoading(true);
    return api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id })
      .then((data) => setContacts(data))
      .catch(() => {})
      .finally(() => setContactsLoading(false));
  }, [campaign.id]);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const data = await api<Device[]>("get_devices", { companyId: campaign.companyId });
      setDevices(data || []);
    } catch {
      /* mantém lista */
    } finally {
      setDevicesLoading(false);
    }
  }, [campaign.companyId]);

  useEffect(() => {
    loadContacts();
    loadDevices();
  }, [loadContacts, loadDevices]);

  useEffect(() => {
    if (importRevision > 0) loadContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRevision]);

  // Atualiza a fila a cada evento do motor de disparo para esta campanha.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ campaign_id: number; status: string }>("campaign-progress", (event) => {
      if (event.payload.campaign_id !== campaign.id) return;
      api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id }).then(setContacts).catch(() => {});
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [campaign.id]);

  const { total, sent, failed, pending, progress } = countsFromContacts(campaign, contacts);
  const isRunning = campaign.status === "running";
  const status = statusInfo(campaign.status);
  const devStats = deviceSelectionStats(devices, draft.deviceIds);

  const base = draftFrom(campaign);
  const devicesDirty = !sameIds(draft.deviceIds, base.deviceIds);
  const settingsDirty =
    draft.greeting !== base.greeting ||
    draft.body !== base.body ||
    draft.closing !== base.closing ||
    draft.useSpintax !== base.useSpintax ||
    draft.delayMin !== base.delayMin ||
    draft.delayMax !== base.delayMax ||
    draft.useAI !== base.useAI ||
    draft.aiProvider !== base.aiProvider ||
    draft.aiModel !== base.aiModel ||
    draft.aiPrompt !== base.aiPrompt;

  // Estimativa: média dos intervalos observados no log (se houver) ou do ritmo configurado.
  const avgDelaySec = useMemo(() => {
    const observed = logs.filter((l) => l.delayMs).slice(-20);
    if (observed.length >= 3) return observed.reduce((a, l) => a + (l.delayMs || 0), 0) / observed.length / 1000;
    return (draft.delayMin + draft.delayMax) / 2;
  }, [logs, draft.delayMin, draft.delayMax]);
  const etaSeconds = pending * avgDelaySec;

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const flash = (which: "settings" | "devices") => {
    setSavedFlash(which);
    setTimeout(() => setSavedFlash(""), 2500);
  };

  const buildUpdated = (extra?: Partial<Campaign>): Campaign => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { useAI: _d1, useAi: _d2, ...rest } = campaign;
    return {
      ...rest,
      greeting: draft.greeting,
      message: draft.body,
      closing: draft.closing,
      useSpintax: draft.useSpintax,
      delayMin: draft.delayMin,
      delayMax: draft.delayMax,
      useAi: draft.useAI,
      aiProvider: draft.aiProvider,
      aiModel: draft.aiModel,
      aiPrompt: draft.aiPrompt,
      deviceIds: draft.deviceIds,
      ...extra,
    };
  };

  const saveConfiguration = async (): Promise<boolean> => {
    if (!draft.body.trim()) {
      setError("Informe o corpo da mensagem.");
      setTab("settings");
      return false;
    }
    if (draft.delayMin < 1 || draft.delayMax < draft.delayMin) {
      setError("Confira o intervalo de envio.");
      setTab("settings");
      return false;
    }
    const updated = buildUpdated();
    try {
      await api("update_campaign", { campaign: updated });
      onUpdateCampaign(updated);
      setError("");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  const handleSaveSettings = async () => {
    setBusy("save");
    const ok = await saveConfiguration();
    setBusy("");
    if (ok) flash("settings");
  };

  const handleSaveDevices = async () => {
    setBusy("saveDevices");
    const ok = await saveConfiguration();
    setBusy("");
    if (ok) flash("devices");
  };

  const handleRunBatch = async () => {
    if (!draft.deviceIds.length) {
      setError("Selecione ao menos um aparelho.");
      setTab("devices");
      return;
    }
    if (!pending) {
      setError("Importe destinos pendentes antes de iniciar.");
      setTab("contacts");
      return;
    }
    setBusy("start");
    try {
      if (!(await saveConfiguration())) return;
      await api("start_campaign", { campaignId: campaign.id });
      onUpdateCampaign(buildUpdated({ status: "running" }));
      onLog("info", campaign.status === "paused" ? "Disparo retomado." : "Campanha iniciada no motor de disparo.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const handlePause = async () => {
    setBusy("pause");
    try {
      await api("pause_campaign", { campaignId: campaign.id });
      onUpdateCampaign({ ...campaign, status: "paused" });
      onLog("info", "Campanha pausada.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const handleStop = async () => {
    setBusy("stop");
    try {
      await api("stop_campaign", { campaignId: campaign.id });
      onUpdateCampaign({ ...campaign, status: "paused" });
      onLog("warning", "Disparo interrompido pelo operador.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      setConfirm("");
    }
  };

  const handleRetryFailures = async () => {
    setBusy("retry");
    try {
      const count = await api<number>("retry_failed_campaign_contacts", { campaignId: campaign.id });
      setContacts(await api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id }));
      onUpdateCampaign({ ...campaign, failedCount: 0, status: "paused" });
      onLog("info", `${count} falhas devolvidas à fila para nova tentativa.`);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const handleResetQueue = async () => {
    setBusy("reset");
    try {
      const count = await api<number>("reset_campaign_contacts", { campaignId: campaign.id });
      setContacts(await api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id }));
      onUpdateCampaign({ ...campaign, sentCount: 0, failedCount: 0, status: "draft" });
      onLog("info", `Fila reiniciada: ${count} contatos prontos para novo envio.`);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      setConfirm("");
    }
  };

  const canReset = !isRunning && total > 0 && pending === 0;
  const canRetry = !isRunning && failed > 0;
  const resumeLabel = campaign.status === "paused" || (campaign.status as string) === "stopped" ? "Retomar disparo" : "Iniciar disparo";

  const checklist: { ok: boolean; label: string; detail?: string; action?: ReactNode }[] = [
    {
      ok: Boolean(draft.body.trim()),
      label: "Mensagem escrita",
      action: !draft.body.trim() && <LinkButton onClick={() => setTab("settings")}>Escrever</LinkButton>,
    },
    {
      ok: pending > 0,
      label: pending > 0 ? `${formatNumber(pending)} contatos na fila` : "Contatos pendentes",
      detail: pending > 0 ? undefined : total > 0 ? "Todos já foram processados" : "Nenhum contato importado",
      action: pending === 0 && (total > 0 ? <LinkButton onClick={() => setConfirm("reset")}>Reiniciar fila</LinkButton> : <LinkButton onClick={onImport}>Importar</LinkButton>),
    },
    {
      ok: draft.deviceIds.length > 0,
      label: draft.deviceIds.length > 0 ? `${draft.deviceIds.length} aparelhos selecionados` : "Aparelhos selecionados",
      action: draft.deviceIds.length === 0 && <LinkButton onClick={() => setTab("devices")}>Selecionar</LinkButton>,
    },
    {
      ok: devStats.selectedOnline > 0,
      label: "Ao menos um aparelho online",
      detail: draft.deviceIds.length > 0 && !devicesLoading ? `${devStats.selectedOnline} de ${draft.deviceIds.length} online agora` : undefined,
      action: draft.deviceIds.length > 0 && devStats.selectedOnline === 0 && <LinkButton onClick={() => setTab("devices")}>Ver aparelhos</LinkButton>,
    },
  ];

  const menuActions = [
    { label: "Importar contatos", icon: <Upload size={14} />, onSelect: onImport },
    { label: "Reprocessar falhas", icon: <RotateCcw size={14} />, onSelect: handleRetryFailures, disabled: !canRetry },
    { label: "Reiniciar fila", icon: <RotateCcw size={14} />, onSelect: () => setConfirm("reset"), disabled: isRunning || total === 0 },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Cabeçalho */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md text-[0.8125rem] text-secondary hover:text-[var(--color-text-primary)] cursor-pointer"
        >
          <ArrowLeft size={14} /> Campanhas
        </button>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-[1.25rem] font-semibold leading-tight tracking-tight text-primary">{campaign.name}</h1>
              <Badge variant={status.variant} dot pulse={isRunning}>
                {status.label}
              </Badge>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-secondary">
              <span className="inline-flex items-center gap-1.5"><Users size={13} className="text-tertiary" />{formatNumber(total)} contatos</span>
              <span className="inline-flex items-center gap-1.5"><Smartphone size={13} className="text-tertiary" />{(campaign.deviceIds || []).length} aparelhos</span>
              <span className="inline-flex items-center gap-1.5"><Clock size={13} className="text-tertiary" />{delaySummary(campaign.delayMin || 30, campaign.delayMax || 90)}</span>
              {campaignUsesAi(campaign) && <Badge variant="purple">IA</Badge>}
              {campaign.useSpintax && <Badge variant="neutral">Variações</Badge>}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="secondary" icon={<Pencil size={14} />} onClick={onEdit}>
              Editar
            </Button>
            {isRunning ? (
              <>
                <Button variant="secondary" icon={<Square size={13} />} onClick={() => setConfirm("stop")} disabled={!!busy}>
                  Parar
                </Button>
                <Button variant="primary" icon={<Pause size={14} />} onClick={handlePause} loading={busy === "pause"} disabled={!!busy && busy !== "pause"}>
                  Pausar
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                icon={<Play size={14} />}
                onClick={handleRunBatch}
                loading={busy === "start"}
                disabled={pending === 0 || (!!busy && busy !== "start")}
                title={pending === 0 ? "Não há contatos pendentes" : undefined}
              >
                {resumeLabel}
              </Button>
            )}
            <ActionMenu actions={menuActions} />
          </div>
        </div>
      </div>

      {error && (
        <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Não foi possível concluir a ação" onDismiss={() => setError("")}>
          {error}
        </InlineAlert>
      )}

      <Tabs<DetailTab>
        value={tab}
        onChange={setTab}
        items={[
          { id: "overview", label: "Visão geral", icon: <LayoutDashboard size={14} /> },
          { id: "contacts", label: "Contatos", icon: <Users size={14} />, count: total },
          { id: "devices", label: devicesDirty ? "Aparelhos •" : "Aparelhos", icon: <Smartphone size={14} />, count: draft.deviceIds.length },
          { id: "settings", label: settingsDirty ? "Configurações •" : "Configurações", icon: <Settings2 size={14} /> },
        ]}
      />

      {tab === "overview" && (
        <div className="space-y-6">
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-5 xl:col-span-2">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-[0.8125rem] text-secondary">Progresso</p>
                  <p className="mt-1 text-[2rem] font-semibold leading-none tracking-tight text-primary tabular-nums">{progress}%</p>
                </div>
                <p className="text-right text-[0.8125rem] text-secondary tabular-nums">
                  {formatNumber(sent + failed)} de {formatNumber(total)} processados
                </p>
              </div>
              <div className="mt-4">
                <ProgressBar total={total} sent={sent} failed={failed} size="lg" completed={campaign.status === "completed"} />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard label="Enviados" value={formatNumber(sent)} icon={<Send size={14} />} tone="success" />
                <StatCard
                  label="Falhas"
                  value={formatNumber(failed)}
                  icon={<XCircle size={14} />}
                  tone={failed > 0 ? "danger" : "neutral"}
                  hint={canRetry ? <LinkButton onClick={handleRetryFailures}>{busy === "retry" ? "Reprocessando…" : "Reprocessar"}</LinkButton> : undefined}
                />
                <StatCard label="Restantes" value={formatNumber(pending)} icon={<Users size={14} />} tone="info" />
                <StatCard
                  label="Tempo estimado"
                  value={pending > 0 ? `~${formatDuration(etaSeconds)}` : "—"}
                  icon={<Clock size={14} />}
                  hint={pending > 0 ? (isRunning ? "no ritmo atual" : "se iniciar agora") : undefined}
                />
              </div>
              {canReset && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3">
                  <p className="text-[0.8125rem] text-secondary">Todos os contatos já foram processados. Reinicie a fila para enviar de novo à mesma lista.</p>
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => setConfirm("reset")}>
                    Reiniciar fila
                  </Button>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-primary">{isRunning ? "Disparo em andamento" : "Antes de disparar"}</h3>
              <p className="mt-0.5 text-[0.75rem] text-tertiary">
                {isRunning ? "As mensagens estão saindo pelos aparelhos selecionados." : "Tudo marcado? Então é só iniciar."}
              </p>
              <ul className="mt-4 space-y-3">
                {checklist.map((item) => (
                  <li key={item.label} className="flex items-start gap-2.5">
                    {item.ok ? (
                      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Circle size={16} className="mt-0.5 shrink-0 text-tertiary" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`text-[0.8125rem] ${item.ok ? "text-primary" : "text-secondary"}`}>{item.label}</p>
                      {item.detail && <p className="text-[0.75rem] text-tertiary">{item.detail}</p>}
                    </div>
                    {!item.ok && item.action}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <LogConsole lines={logs} onClear={onClearLogs} />
        </div>
      )}

      {tab === "contacts" && <ContactsPanel contacts={contacts} loading={contactsLoading} onImport={onImport} onReload={loadContacts} />}

      {tab === "devices" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-primary">Aparelhos autorizados</h2>
            <p className="mt-0.5 text-[0.8125rem] text-secondary">
              O motor distribui as mensagens de forma balanceada entre os aparelhos selecionados que estiverem online.
            </p>
          </div>
          <DevicePicker
            devices={devices}
            loading={devicesLoading && devices.length === 0}
            selected={draft.deviceIds}
            onChange={(ids) => patch({ deviceIds: ids })}
            onRefresh={loadDevices}
            refreshing={devicesLoading}
            listClassName="max-h-[min(520px,55vh)]"
          />
          <StickyBar>
            <p className="text-[0.8125rem] text-secondary">
              <strong className="text-primary tabular-nums">{devStats.selectedCount}</strong> selecionados ·{" "}
              <span className={devStats.selectedOnline > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-tertiary"}>
                {devStats.selectedOnline} online
              </span>
              {devicesDirty && <span className="ml-2 text-amber-700 dark:text-amber-300">Alterações não salvas</span>}
            </p>
            <div className="flex items-center gap-2">
              {devicesDirty && (
                <Button variant="ghost" onClick={() => patch({ deviceIds: base.deviceIds })}>
                  Descartar
                </Button>
              )}
              <Button
                onClick={handleSaveDevices}
                loading={busy === "saveDevices"}
                disabled={!devicesDirty && savedFlash !== "devices"}
                icon={savedFlash === "devices" ? <Check size={14} /> : undefined}
              >
                {savedFlash === "devices" ? "Seleção salva" : "Salvar seleção"}
              </Button>
            </div>
          </StickyBar>
        </div>
      )}

      {tab === "settings" && (
        <div className="space-y-6">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <div className="space-y-10">
              <FormSection title="Mensagem" description="Saudação, corpo e encerramento são enviados juntos, nesta ordem.">
                <MessageFields
                  value={draft}
                  onChange={(p) => patch(p)}
                  bodyError={!draft.body.trim() ? "Escreva a mensagem que será enviada." : undefined}
                />
              </FormSection>
              <FormSection title="Personalização com IA" description="Opcional. Usa a configuração de IA da empresa quando o provedor fica no padrão.">
                <AiFields
                  value={draft}
                  onChange={(p) => patch(p)}
                  companyId={campaign.companyId}
                  messageForTest={joinMessage(draft.greeting, draft.body, draft.closing)}
                />
              </FormSection>
              <FormSection title="Ritmo de envio" description="Intervalos aleatórios entre mensagens deixam o disparo mais natural.">
                <DelayFields min={draft.delayMin} max={draft.delayMax} onChange={(p) => patch(p)} pendingContacts={pending} />
              </FormSection>
            </div>
            <div className="lg:sticky lg:top-4 lg:self-start">
              <WhatsAppPreview greeting={draft.greeting} body={draft.body} closing={draft.closing} useSpintax={draft.useSpintax} aiNote={draft.useAI} />
            </div>
          </div>
          <StickyBar>
            <p className="text-[0.8125rem] text-secondary">
              {settingsDirty ? (
                <span className="text-amber-700 dark:text-amber-300">Alterações não salvas</span>
              ) : savedFlash === "settings" ? (
                <span className="text-emerald-600 dark:text-emerald-400">Configurações salvas</span>
              ) : (
                "Tudo salvo"
              )}
              {isRunning && settingsDirty && <span className="ml-2 text-tertiary">As mudanças valem para os próximos envios.</span>}
            </p>
            <div className="flex items-center gap-2">
              {settingsDirty && (
                <Button variant="ghost" onClick={() => setDraft((d) => ({ ...draftFrom(campaign), deviceIds: d.deviceIds }))}>
                  Descartar
                </Button>
              )}
              <Button onClick={handleSaveSettings} loading={busy === "save"} disabled={!settingsDirty || !!delayError(draft.delayMin, draft.delayMax)}>
                Salvar configurações
              </Button>
            </div>
          </StickyBar>
        </div>
      )}

      <ConfirmDialog
        isOpen={confirm === "stop"}
        title="Parar o disparo?"
        confirmLabel="Parar disparo"
        loading={busy === "stop"}
        onConfirm={handleStop}
        onClose={() => setConfirm("")}
      >
        Os envios param imediatamente. Os contatos que ainda não receberam continuam na fila e você pode retomar depois.
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === "reset"}
        title="Reiniciar a fila?"
        confirmLabel="Reiniciar fila"
        loading={busy === "reset"}
        onConfirm={handleResetQueue}
        onClose={() => setConfirm("")}
      >
        Todos os {formatNumber(total)} contatos voltam para "pendente" e os contadores de enviados e falhas são zerados. Ao iniciar de novo, a mesma lista
        recebe a mensagem outra vez.
      </ConfirmDialog>
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 text-[0.75rem] font-medium text-[var(--color-accent-light)] hover:underline cursor-pointer">
      {children}
    </button>
  );
}

function StickyBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-1 flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}
