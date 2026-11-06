// ============================================================
// Esfera v3 — Atendimento pelo Celular (Ponte ADB PA FIXA)
// Conecta o WhatsApp Business do celular no ADB ao robô da VPS.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import PageHeader from "../components/ui/PageHeader";
import EmptyState from "../components/ui/EmptyState";
import Field from "../components/ui/Field";
import { toast } from "../components/ui/ToastContainer";
import { api } from "../tauri";
import { apiErrorText } from "../hooks/useQueries";
import type { AdbDeviceInfo, Device } from "../types";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Save,
  ScrollText,
  Send,
  Settings2,
  Smartphone,
  Square,
  XCircle,
} from "lucide-react";

const DEFAULT_ROBOT_DIR = "E:\\PAFIXA-ATENDIMENTO";
const DEFAULT_PYTHON_PATH =
  "C:\\Users\\vicenzzo.palma\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\python.exe";
const LOG_POLL_MS = 5_000;

interface AtendimentoCelularConfig {
  robotDir: string;
  pythonPath: string;
  serial: string;
}

interface AtendimentoLogLine {
  timestamp: string | null;
  kind: "enviada" | "cancelada" | "recebida" | "lista" | "falha" | "sistema" | "info" | string;
  text: string;
  raw: string;
}

interface AtendimentoLogSummary {
  sentToday: number;
  cancelledToday: number;
  receivedToday: number;
  failedToday: number;
  lastActivityAt: string | null;
  lastActivityText: string | null;
  secondsSinceLastActivity: number | null;
  inactiveAlert: boolean;
  lastListScan: string | null;
  lastStartedSerial: string | null;
  lastStartedAt: string | null;
}

interface AtendimentoAdbDevice {
  serial: string;
  name: string;
  model: string;
  state: string;
  online: boolean;
}

interface AtendimentoCelularStatus {
  running: boolean;
  /** Não deu para consultar os processos do Windows: "desligado" não é confiável. */
  detectionError: string | null;
  pids: number[];
  startedAt: string | null;
  activeSerial: string | null;
  activeDeviceName: string | null;
  config: AtendimentoCelularConfig;
  adbPath: string;
  summary: AtendimentoLogSummary;
  logLines: AtendimentoLogLine[];
  devices: AtendimentoAdbDevice[];
}

interface AtendimentoStartResult {
  alreadyRunning: boolean;
  status: AtendimentoCelularStatus;
}

interface AtendimentoStopResult {
  stopped: boolean;
  waitedSeconds: number;
  stoppedOnSafeLine: boolean;
  warning: string | null;
  status: AtendimentoCelularStatus;
}

type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

const KIND_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  enviada: { label: "Enviada", variant: "success" },
  cancelada: { label: "Cancelada", variant: "warning" },
  recebida: { label: "Recebida", variant: "info" },
  lista: { label: "Lista", variant: "neutral" },
  falha: { label: "Falha", variant: "danger" },
  sistema: { label: "Ponte", variant: "info" },
  info: { label: "Info", variant: "neutral" },
};

function formatElapsed(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  if (seconds < 60) return `há ${seconds} s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `há ${hours}h ${remMins}min` : `há ${hours}h`;
}

function formatBrDateTime(raw: string | null | undefined): string {
  if (!raw) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  if (m) {
    return `${m[3]}/${m[2]}/${m[1]} às ${m[4]}`;
  }
  return raw;
}

export default function AtendimentoCelularTab() {
  const { selectedCompanyId } = useAuth();

  const [status, setStatus] = useState<AtendimentoCelularStatus | null>(null);
  const [usbDevices, setUsbDevices] = useState<AdbDeviceInfo[]>([]);
  const [companyDevices, setCompanyDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopWarning, setStopWarning] = useState<string | null>(null);

  const [selectedSerial, setSelectedSerial] = useState<string>("");
  const [robotDir, setRobotDir] = useState<string>(DEFAULT_ROBOT_DIR);
  const [pythonPath, setPythonPath] = useState<string>(DEFAULT_PYTHON_PATH);
  const [configDirty, setConfigDirty] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopElapsed, setStopElapsed] = useState(0);
  const [savingConfig, setSavingConfig] = useState(false);

  const aliveRef = useRef(true);
  const busyPollRef = useRef(false);
  const configInitializedRef = useRef(false);

  const applyStatus = useCallback(
    (data: AtendimentoCelularStatus, forceConfigSync = false) => {
      setStatus(data);
      setError(null);
      setLastRefresh(new Date());

      if (!configInitializedRef.current || forceConfigSync || !configDirty) {
        setRobotDir(data.config?.robotDir || DEFAULT_ROBOT_DIR);
        setPythonPath(data.config?.pythonPath || DEFAULT_PYTHON_PATH);
        configInitializedRef.current = true;
      }

      setSelectedSerial((prev) => {
        if (data.running && data.activeSerial) return data.activeSerial;
        if (prev) return prev;
        if (data.config?.serial) return data.config.serial;
        const firstOnline = data.devices?.find((d) => d.online);
        return firstOnline?.serial || data.devices?.[0]?.serial || "";
      });
    },
    [configDirty],
  );

  const fetchAll = useCallback(
    async (showSpinner = false) => {
      if (busyPollRef.current) return;
      busyPollRef.current = true;
      if (showSpinner) setRefreshing(true);
      try {
        const [st, usb, devs] = await Promise.all([
          api<AtendimentoCelularStatus>("get_atendimento_celular_status"),
          api<AdbDeviceInfo[]>("list_usb_devices").catch(() => [] as AdbDeviceInfo[]),
          selectedCompanyId != null
            ? api<Device[]>("get_devices", { companyId: selectedCompanyId }).catch(() => [] as Device[])
            : Promise.resolve([] as Device[]),
        ]);
        if (!aliveRef.current) return;
        if (Array.isArray(usb)) setUsbDevices(usb);
        if (Array.isArray(devs)) setCompanyDevices(devs);
        applyStatus(st);
      } catch (err) {
        if (aliveRef.current) {
          setError(apiErrorText(err, "Não foi possível carregar o estado do atendimento pelo celular."));
        }
      } finally {
        busyPollRef.current = false;
        if (aliveRef.current && showSpinner) setRefreshing(false);
      }
    },
    [selectedCompanyId, applyStatus],
  );

  useEffect(() => {
    aliveRef.current = true;
    fetchAll(true);
    return () => {
      aliveRef.current = false;
    };
  }, [fetchAll]);

  // Atualiza estado, resumo de hoje e últimas ~30 linhas do log a cada 5 s
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !starting && !stopping) {
        fetchAll(false);
      }
    }, LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [fetchAll, starting, stopping]);

  // Cronômetro visual durante o desligamento seguro (até 60 s)
  useEffect(() => {
    if (!stopping) {
      setStopElapsed(0);
      return;
    }
    const started = Date.now();
    const t = window.setInterval(() => {
      setStopElapsed(Math.min(60, Math.floor((Date.now() - started) / 1000)));
    }, 500);
    return () => window.clearInterval(t);
  }, [stopping]);

  // Lista unificada de aparelhos no ADB com nome soberano do Esfera + serial
  const mergedDevices = useMemo<AtendimentoAdbDevice[]>(() => {
    const map = new Map<string, AtendimentoAdbDevice>();

    for (const d of status?.devices ?? []) {
      map.set(d.serial, { ...d });
    }

    const findCompanyDev = (serial: string): Device | undefined => {
      const s = serial.trim().toLowerCase();
      const ipOnly = s.split(":")[0];
      return companyDevices.find(
        (cd) =>
          cd.serial.toLowerCase() === s ||
          (cd.currentAdbAddress && cd.currentAdbAddress.toLowerCase() === s) ||
          (ipOnly.includes(".") && cd.ip && cd.ip.toLowerCase() === ipOnly),
      );
    };

    for (const u of usbDevices) {
      const serial = (u.serial || "").trim();
      if (!serial || serial.startsWith("*")) continue;
      const cd = findCompanyDev(serial);
      const existing = map.get(serial);
      const esferaName =
        cd?.name?.trim() ||
        existing?.name?.trim() ||
        (cd?.deviceNumber ? `Aparelho ${cd.deviceNumber}` : "") ||
        u.model ||
        serial;
      map.set(serial, {
        serial,
        name: esferaName,
        model: cd?.model || existing?.model || u.model || "Android",
        state: u.state || existing?.state || "device",
        online: (u.state || existing?.state) === "device",
      });
    }

    // Garante que o serial ativo/selecionado apareça mesmo se desconectou momentaneamente
    const ensureSerial = status?.activeSerial || selectedSerial;
    if (ensureSerial && !map.has(ensureSerial)) {
      const cd = findCompanyDev(ensureSerial);
      map.set(ensureSerial, {
        serial: ensureSerial,
        name:
          cd?.name?.trim() ||
          status?.activeDeviceName?.trim() ||
          (cd?.deviceNumber ? `Aparelho ${cd.deviceNumber}` : ensureSerial),
        model: cd?.model || "ADB",
        state: "offline",
        online: false,
      });
    }

    return Array.from(map.values()).sort(
      (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "pt-BR"),
    );
  }, [status?.devices, status?.activeSerial, status?.activeDeviceName, usbDevices, companyDevices, selectedSerial]);

  const handleStart = async () => {
    const targetSerial = selectedSerial.trim();
    if (!targetSerial) {
      toast.warning("Escolha um aparelho", "Selecione um aparelho conectado no ADB antes de ligar o atendimento.");
      return;
    }
    setStarting(true);
    setStopWarning(null);
    try {
      const res = await api<AtendimentoStartResult>("start_atendimento_celular", {
        serial: targetSerial,
        robotDir: robotDir.trim() || DEFAULT_ROBOT_DIR,
        pythonPath: pythonPath.trim() || DEFAULT_PYTHON_PATH,
      });
      setConfigDirty(false);
      applyStatus(res.status, true);
      if (res.alreadyRunning) {
        toast.info(
          "Atendimento já estava ligado",
          "Já existe uma ponte ADB em execução. O estado foi sincronizado sem abrir outra instância.",
        );
      } else {
        toast.success("Atendimento ligado", `Ponte ADB iniciada no aparelho ${targetSerial}.`);
      }
    } catch (err) {
      toast.error("Não foi possível ligar", apiErrorText(err));
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setStopWarning(null);
    try {
      const res = await api<AtendimentoStopResult>("stop_atendimento_celular");
      applyStatus(res.status, false);
      if (!res.stopped) {
        setStopWarning(res.warning || "Não foi possível confirmar que a ponte foi encerrada.");
        toast.error("Atendimento pode continuar ligado", res.warning || undefined);
      } else if (res.warning) {
        setStopWarning(res.warning);
        toast.warning("Atendimento desligado após 60 s", res.warning);
      } else {
        toast.success(
          "Atendimento desligado",
          res.waitedSeconds > 0
            ? `Ponte encerrada com segurança após ${res.waitedSeconds} s.`
            : "Ponte ADB encerrada com segurança.",
        );
      }
    } catch (err) {
      toast.error("Erro ao desligar atendimento", apiErrorText(err));
    } finally {
      setStopping(false);
    }
  };

  const handleSaveConfig = async (e: FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const saved = await api<AtendimentoCelularConfig>("save_atendimento_celular_config", {
        robotDir: robotDir.trim() || DEFAULT_ROBOT_DIR,
        pythonPath: pythonPath.trim() || DEFAULT_PYTHON_PATH,
        serial: selectedSerial.trim() || null,
      });
      setRobotDir(saved.robotDir);
      setPythonPath(saved.pythonPath);
      if (saved.serial) setSelectedSerial(saved.serial);
      setConfigDirty(false);
      toast.success("Configuração salva", "Caminhos e aparelho padrão foram gravados no Esfera.");
    } catch (err) {
      toast.error("Erro ao salvar configuração", apiErrorText(err));
    } finally {
      setSavingConfig(false);
    }
  };

  const running = Boolean(status?.running);
  const summary = status?.summary;
  const activeDeviceLabel = useMemo(() => {
    const ser = status?.activeSerial || selectedSerial;
    if (!ser) return "Nenhum aparelho selecionado";
    const found = mergedDevices.find((d) => d.serial === ser);
    if (found && found.name && found.name !== ser) {
      return `${found.name} (${ser})`;
    }
    if (status?.activeDeviceName && status.activeDeviceName !== ser) {
      return `${status.activeDeviceName} (${ser})`;
    }
    return ser;
  }, [status?.activeSerial, status?.activeDeviceName, selectedSerial, mergedDevices]);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Atendimento pelo Celular"
        description="Conecta o WhatsApp Business do celular pelo ADB ao robô da VPS para ler conversas novas e enviar as respostas da fila."
        icon={<Smartphone size={18} />}
        actions={
          <>
            {lastRefresh && (
              <span className="text-xs text-tertiary tabular-nums">
                Atualizado às {lastRefresh.toLocaleTimeString("pt-BR")} (a cada 5 s)
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={14} />}
              loading={refreshing}
              onClick={() => fetchAll(true)}
            >
              Atualizar
            </Button>
          </>
        }
      />

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[0.8125rem] text-red-600 dark:text-red-400"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle size={16} className="shrink-0" />
            <span>{error}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => fetchAll(true)}>
            Tentar novamente
          </Button>
        </div>
      )}

      {status?.detectionError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-[0.8125rem] text-red-600 dark:text-red-400"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Não consegui verificar se a ponte está rodando, então o estado abaixo pode estar errado e o botão
            Ligar fica bloqueado (para não abrir uma segunda ponte). Detalhe: {status.detectionError}
          </span>
        </div>
      )}

      {/* Alerta se ligado e sem linha nova no log há mais de 10 minutos */}
      {running && summary?.inactiveAlert && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[0.8125rem] text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="space-y-0.5">
            <p className="font-semibold">
              Alerta de inatividade: nenhuma linha nova no log há mais de 10 minutos
            </p>
            <p className="text-xs opacity-90">
              O processo da ponte está ligado, mas a última atividade registrada foi{" "}
              {summary.lastActivityAt
                ? `${formatBrDateTime(summary.lastActivityAt)} (${formatElapsed(summary.secondsSinceLastActivity)})`
                : "não encontrada no log"}
              . Verifique se o cabo/ADB do celular continua conectado e se a tela do aparelho está acessível.
            </p>
          </div>
        </div>
      )}

      {/* Aviso quando o desligamento atingiu o limite de 60 s */}
      {stopWarning && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[0.8125rem] text-amber-700 dark:text-amber-300"
        >
          <span className="flex items-start gap-2.5">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
            <span>{stopWarning}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setStopWarning(null)}>
            Fechar aviso
          </Button>
        </div>
      )}

      {/* Painel Principal: Estado Atual + Botão Grande Ligar / Desligar */}
      <Card padding="lg" className="border-2 border-border">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge variant={running ? "success" : "neutral"} dot pulse={running}>
                {running ? "ATENDIMENTO LIGADO" : "ATENDIMENTO DESLIGADO"}
              </Badge>
              {running && status?.pids && status.pids.length > 0 && (
                <span className="text-xs font-mono text-tertiary">
                  PID {status.pids.join(", ")}
                </span>
              )}
            </div>

            <h2 className="text-lg font-semibold text-primary">
              {running
                ? `Respondendo pelo aparelho ${activeDeviceLabel}`
                : "Fluxo de atendimento pelo celular parado"}
            </h2>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.8125rem] text-secondary">
              <span className="flex items-center gap-1.5">
                <Clock size={14} className="text-tertiary" />
                <span>
                  {running
                    ? `Ligado desde: ${formatBrDateTime(status?.startedAt || summary?.lastStartedAt)}`
                    : "Pronto para iniciar quando desejar"}
                </span>
              </span>
              <span className="flex items-center gap-1.5">
                <Smartphone size={14} className="text-tertiary" />
                <span>
                  Aparelho: <strong className="font-medium text-primary">{activeDeviceLabel}</strong>
                </span>
              </span>
            </div>

            {stopping && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
                <Loader2 size={14} className="animate-spin shrink-0" />
                <span>
                  Aguardando conclusão do envio atual no log para não duplicar mensagem… ({stopElapsed} s / 60 s)
                </span>
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col sm:flex-row items-stretch sm:items-center gap-3">
            {running ? (
              <Button
                variant="danger"
                size="lg"
                icon={<Square size={18} />}
                loading={stopping}
                onClick={handleStop}
                className="min-w-[240px] h-12 text-base font-semibold shadow-sm"
              >
                {stopping ? `Desligando (${stopElapsed}s)…` : "Desligar Atendimento"}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="lg"
                icon={<Play size={18} />}
                loading={starting}
                disabled={!selectedSerial.trim() || !status || Boolean(status.detectionError)}
                onClick={handleStart}
                className="min-w-[240px] h-12 text-base font-semibold shadow-sm"
              >
                {starting ? "Iniciando ponte…" : "Ligar Atendimento"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Resumo de Hoje lido do log */}
      <section className="space-y-3" aria-label="Resumo de hoje">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-tertiary" />
          <h2 className="text-[0.9375rem] font-semibold text-primary">Resumo de hoje (lido do log)</h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card padding="sm" className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-tertiary">Enviadas hoje</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">
                {summary ? summary.sentToday : "—"}
              </p>
              <p className="mt-0.5 text-xs text-tertiary">Respostas confirmadas no celular</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 shrink-0">
              <Send size={18} />
            </div>
          </Card>

          <Card padding="sm" className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-tertiary">Canceladas hoje</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">
                {summary ? summary.cancelledToday : "—"}
              </p>
              <p className="mt-0.5 text-xs text-tertiary">Já respondidas / 90 dias / CPF enviado</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 shrink-0">
              <XCircle size={18} />
            </div>
          </Card>

          <Card padding="sm" className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-tertiary">Recebidas hoje</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">
                {summary ? summary.receivedToday : "—"}
              </p>
              <p className="mt-0.5 text-xs text-tertiary">Mensagens entregues ao robô da VPS</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10 text-sky-500 shrink-0">
              <MessageSquare size={18} />
            </div>
          </Card>

          <Card padding="sm" className="flex flex-col justify-between gap-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wider text-tertiary">Última atividade</p>
              {summary?.lastActivityAt && (
                <Badge variant={summary.inactiveAlert ? "warning" : "info"}>
                  {formatElapsed(summary.secondsSinceLastActivity)}
                </Badge>
              )}
            </div>
            <p className="text-sm font-semibold tabular-nums text-primary truncate">
              {summary?.lastActivityAt ? formatBrDateTime(summary.lastActivityAt) : "Sem registros no log"}
            </p>
            <p
              className="text-xs text-secondary truncate"
              title={summary?.lastActivityText || undefined}
            >
              {summary?.lastActivityText || "Aguardando atividade da ponte ADB"}
            </p>
          </Card>
        </div>
      </section>

      {/* Seleção do Aparelho no ADB */}
      <section className="space-y-3" aria-label="Aparelhos conectados no ADB">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Smartphone size={16} className="text-tertiary" />
            <h2 className="text-[0.9375rem] font-semibold text-primary">
              Aparelho do atendimento (ADB)
            </h2>
          </div>
          <span className="text-xs text-tertiary">
            {running
              ? "Para trocar de aparelho, desligue o atendimento atual primeiro."
              : "Escolha o aparelho conectado no ADB que fará o atendimento."}
          </span>
        </div>

        {mergedDevices.length === 0 ? (
          <EmptyState
            icon={<Smartphone size={18} />}
            title="Nenhum aparelho detectado no ADB"
            description="Conecte o celular por cabo USB ou Wi-Fi ADB e clique em Atualizar."
            action={
              <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} onClick={() => fetchAll(true)}>
                Verificar ADB
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {mergedDevices.map((dev) => {
              const isSelected = selectedSerial === dev.serial;
              const isRunningHere = running && status?.activeSerial === dev.serial;
              return (
                <button
                  key={dev.serial}
                  type="button"
                  disabled={running && !isRunningHere}
                  onClick={() => {
                    if (!running) {
                      setSelectedSerial(dev.serial);
                    }
                  }}
                  className={`text-left rounded-xl border p-4 transition-all cursor-pointer ${
                    isSelected || isRunningHere
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)] shadow-sm"
                      : "border-border bg-card hover:bg-hover"
                  } ${running && !isRunningHere ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[0.9375rem] font-semibold text-primary truncate">
                        {dev.name}
                      </p>
                      <p className="mt-0.5 text-xs font-mono text-secondary truncate">
                        Serial: {dev.serial}
                      </p>
                      {dev.model && dev.model !== dev.name && (
                        <p className="mt-0.5 text-xs text-tertiary truncate">
                          Modelo: {dev.model}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      <Badge variant={dev.online ? "success" : "danger"} dot>
                        {dev.online ? "Conectado" : dev.state}
                      </Badge>
                      {isRunningHere && (
                        <Badge variant="info">Em atendimento</Badge>
                      )}
                      {!isRunningHere && isSelected && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent-light)]">
                          <CheckCircle2 size={13} />
                          Selecionado
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Últimas ~30 linhas do log (atualizando a cada 5 s) */}
      <section className="space-y-3" aria-label="Últimas linhas do log">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ScrollText size={16} className="text-tertiary" />
            <h2 className="text-[0.9375rem] font-semibold text-primary">
              Últimas 30 linhas do log (%LOCALAPPDATA%\pafixa_ponte_adb.log)
            </h2>
          </div>
          {summary?.lastListScan && (
            <span className="text-xs text-tertiary truncate max-w-md" title={summary.lastListScan}>
              Última leitura da lista: {summary.lastListScan}
            </span>
          )}
        </div>

        <Card padding="none" className="overflow-hidden">
          {!status?.logLines || status.logLines.length === 0 ? (
            <div className="p-6 text-center text-sm text-tertiary">
              Nenhuma linha encontrada em <span className="font-mono">pafixa_ponte_adb.log</span>.
            </div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto divide-y divide-border font-mono text-xs custom-scrollbar">
              {status.logLines.map((line, idx) => {
                const badge = KIND_BADGE[line.kind] || KIND_BADGE.info;
                return (
                  <div
                    key={`${line.timestamp ?? "no-ts"}-${idx}`}
                    className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-2 hover:bg-hover/60 transition-colors"
                  >
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-tertiary tabular-nums">
                        {line.timestamp || "—"}
                      </span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <span className="text-primary break-all leading-relaxed">
                      {line.text}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      {/* Configuração Guardada */}
      <section className="space-y-3" aria-label="Configuração da ponte ADB">
        <div className="flex items-center gap-2">
          <Settings2 size={16} className="text-tertiary" />
          <h2 className="text-[0.9375rem] font-semibold text-primary">
            Configuração da ponte ADB
          </h2>
        </div>

        <Card padding="md">
          <form onSubmit={handleSaveConfig} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Caminho da pasta do robô (diretório de trabalho)"
                htmlFor="ponte-robot-dir"
                hint="Padrão: E:\PAFIXA-ATENDIMENTO (onde fica bot\ponte_adb.py)"
              >
                <input
                  id="ponte-robot-dir"
                  type="text"
                  value={robotDir}
                  onChange={(e) => {
                    setRobotDir(e.target.value);
                    setConfigDirty(true);
                  }}
                  placeholder={DEFAULT_ROBOT_DIR}
                  className="w-full font-mono text-xs"
                />
              </Field>

              <Field
                label="Caminho do executável Python"
                htmlFor="ponte-python-path"
                hint="Executa: python -m bot.ponte_adb com PYTHONIOENCODING=utf-8"
              >
                <input
                  id="ponte-python-path"
                  type="text"
                  value={pythonPath}
                  onChange={(e) => {
                    setPythonPath(e.target.value);
                    setConfigDirty(true);
                  }}
                  placeholder={DEFAULT_PYTHON_PATH}
                  className="w-full font-mono text-xs"
                />
              </Field>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-2 border-t border-border">
              <div className="text-xs text-tertiary space-y-0.5">
                <p>
                  <span className="font-medium text-secondary">ADB do Esfera (PONTE_ADB):</span>{" "}
                  <span className="font-mono">{status?.adbPath || "src-tauri/binaries/adb.exe"}</span>
                </p>
                <p>
                  <span className="font-medium text-secondary">Salvo em:</span>{" "}
                  <span className="font-mono">%APPDATA%\esfera_v3\atendimento_celular.json</span>
                </p>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRobotDir(DEFAULT_ROBOT_DIR);
                    setPythonPath(DEFAULT_PYTHON_PATH);
                    setConfigDirty(true);
                  }}
                >
                  Restaurar padrão
                </Button>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  icon={<Save size={14} />}
                  loading={savingConfig}
                >
                  Salvar configuração
                </Button>
              </div>
            </div>
          </form>
        </Card>
      </section>
    </div>
  );
}
