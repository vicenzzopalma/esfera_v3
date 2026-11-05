// ============================================================
// Esfera v3 — Números de disparo
// WhatsApp que dispara (instâncias da Evolution na VPS, via hub), quem recebe as
// respostas dos devedores (repasse) e os históricos gravados no Konfiansa.
// Atualiza sozinho a cada 30 s, menos enquanto alguém digita num campo.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Modal, { confirmDialog } from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import EmptyState from "../components/ui/EmptyState";
import Field from "../components/ui/Field";
import { SegmentedControl } from "../components/ui/Tabs";
import { toast } from "../components/ui/ToastContainer";
import { api } from "../tauri";
import { apiErrorText, formatDbDate } from "../hooks/useQueries";
import { AlertTriangle, FileText, Loader2, MessageCircle, Plus, QrCode, RefreshCw, Send, Smartphone, Trash2 } from "lucide-react";

// ---- Tipos (respostas do backend) ----

interface DispatchNumber {
  name: string;
  /** Dígitos do número (vazio se nunca conectou). */
  number: string;
  profileName: string;
  /** open | close | connecting */
  state: string;
  disconnectionCode: number | null;
  disconnectionAt: string | null;
  updatedAt: string | null;
}

interface QrTarget {
  name: string;
  number: string;
}

interface QrResult {
  conectado: boolean;
  qr?: string | null;
  pairingCode?: string | null;
}

interface CreateResult {
  ok: boolean;
  instancia: string;
  numero: string;
}

interface RepasseDestino {
  numero: string;
  exibicao?: string;
  nome?: string;
  criado_em?: string;
}

interface Repasse {
  destinos: RepasseDestino[];
  padrao: { numero: string; exibicao?: string } | null;
}

interface KonfiansaHistory {
  historyId: number;
  phone: string;
  campaignId: number;
  motivo: string;
  mensagens: number;
  status: string;
  processos: string;
  erro: string;
  tentativas: number;
  createdAt: string;
  gravadoEm: string | null;
}

type Variant = "success" | "warning" | "danger" | "info" | "neutral";
type HistFilter = "all" | "pendente" | "gravado" | "erro" | "sem_processo";

const REFRESH_MS = 30_000;
const QR_REFRESH_MS = 20_000;
const QR_STATE_MS = 5_000;
const HISTORY_LIMIT = 200;

const STATE_INFO: Record<string, { label: string; variant: Variant; order: number }> = {
  open: { label: "Conectado", variant: "success", order: 0 },
  connecting: { label: "Conectando", variant: "warning", order: 1 },
  close: { label: "Desconectado", variant: "danger", order: 2 },
};

const HIST_STATUS: Record<string, { label: string; variant: Variant }> = {
  pendente: { label: "Pendente", variant: "warning" },
  gravado: { label: "Gravado", variant: "success" },
  erro: { label: "Erro", variant: "danger" },
  sem_processo: { label: "Sem processo", variant: "neutral" },
};

// ---- Regras puras ----

/** (47) 99627-1722; celular antigo sem o 9 (12 dígitos com 55) aparece com o 9. */
function formatPhone(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d || "—";
}

/** DDD + número (10/11 dígitos) ou já com 55 (12/13). Mesma regra do backend. */
function validPhone(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  const n = d.length === 10 || d.length === 11 ? `55${d}` : d;
  return (n.length === 12 || n.length === 13) && n.startsWith("55") && n[2] !== "0";
}

const INVALID_PHONE = "Número inválido: informe DDD + número (ex.: 47 99999-8888).";

function disconnectReason(code: number | null): string {
  if (code === 403) return "O WhatsApp recusou a conexão — possível bloqueio do número";
  if (code === 401) return "Desconectado no celular";
  if (code) return `Desconectado (código ${code})`;
  return "Desconectado";
}

/** Prévia do nome da conexão nova (o hub confirma e acrescenta -2 se já existir). */
function previewInstanceName(numero: string, apelido: string): string {
  const slug = apelido
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const digits = numero.replace(/\D/g, "");
  return `disparo-${slug || (digits.length >= 4 ? digits.slice(-4) : "XXXX")}`;
}

/** "2600064562#12+ext13;..." -> "2600064562 · hist. 12 · ext. 13". */
function formatProcessos(raw: string): string[] {
  return (raw || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^(\d+)#(\d+)(?:\+ext(\d+))?$/.exec(item);
      return m ? `${m[1]} · hist. ${m[2]}${m[3] ? ` · ext. ${m[3]}` : ""}` : item;
    });
}

/** Foco num campo de texto: a atualização automática espera. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

const errorBox = "rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[0.8125rem] text-red-600 dark:text-red-400";

// ============================================================
// Página
// ============================================================

export default function DispatchNumbersTab() {
  const [numbers, setNumbers] = useState<DispatchNumber[] | null>(null);
  const [numbersError, setNumbersError] = useState<string | null>(null);
  const [repasse, setRepasse] = useState<Repasse | null>(null);
  const [repasseError, setRepasseError] = useState<string | null>(null);
  const [histories, setHistories] = useState<KonfiansaHistory[] | null>(null);
  const [historiesError, setHistoriesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [qrTarget, setQrTarget] = useState<QrTarget | null>(null);
  const aliveRef = useRef(true);
  const busyRef = useRef(false);

  const loadNumbers = useCallback(async () => {
    try {
      const data = await api<DispatchNumber[]>("get_dispatch_numbers");
      if (!aliveRef.current) return;
      setNumbers(Array.isArray(data) ? data : []);
      setNumbersError(null);
    } catch (err) {
      if (aliveRef.current) setNumbersError(apiErrorText(err, "Não foi possível ler os números de disparo."));
    }
  }, []);

  const loadRepasse = useCallback(async () => {
    try {
      const data = await api<Repasse>("get_repasse_destinos");
      if (!aliveRef.current) return;
      setRepasse({ destinos: data?.destinos ?? [], padrao: data?.padrao ?? null });
      setRepasseError(null);
    } catch (err) {
      if (aliveRef.current) setRepasseError(apiErrorText(err, "Não foi possível ler quem recebe as respostas."));
    }
  }, []);

  const loadHistories = useCallback(async () => {
    try {
      const data = await api<KonfiansaHistory[]>("get_konfiansa_histories", { limit: HISTORY_LIMIT });
      if (!aliveRef.current) return;
      setHistories(Array.isArray(data) ? data : []);
      setHistoriesError(null);
    } catch (err) {
      if (aliveRef.current) setHistoriesError(apiErrorText(err, "Não foi possível ler os históricos do Konfiansa."));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefreshing(true);
    await Promise.all([loadNumbers(), loadRepasse(), loadHistories()]);
    busyRef.current = false;
    if (aliveRef.current) {
      setRefreshing(false);
      setLastRefresh(new Date());
    }
  }, [loadNumbers, loadRepasse, loadHistories]);

  useEffect(() => {
    aliveRef.current = true;
    refreshAll();
    return () => {
      aliveRef.current = false;
    };
  }, [refreshAll]);

  // A cada 30 s, com a janela visível e ninguém digitando.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!document.hidden && !isTyping()) refreshAll();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refreshAll]);

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        title="Números de disparo"
        description="WhatsApp que faz os disparos, quem recebe as respostas dos devedores e o que foi gravado no Konfiansa."
        icon={<MessageCircle size={18} />}
        actions={
          <>
            {lastRefresh && (
              <span className="text-xs text-tertiary tabular-nums">
                Atualizado às {lastRefresh.toLocaleTimeString("pt-BR")}
              </span>
            )}
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} loading={refreshing} onClick={refreshAll}>
              Atualizar
            </Button>
          </>
        }
      />

      <NumbersSection
        numbers={numbers}
        error={numbersError}
        onRetry={loadNumbers}
        onAdd={() => setAddOpen(true)}
        onConnect={(n) => setQrTarget({ name: n.name, number: n.number })}
      />

      <RepasseSection repasse={repasse} error={repasseError} onRetry={loadRepasse} onChange={setRepasse} />

      <HistoriesSection histories={histories} error={historiesError} onRetry={loadHistories} />

      <AddNumberModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(target) => {
          setAddOpen(false);
          setQrTarget(target);
          loadNumbers();
        }}
      />

      <QrModal
        target={qrTarget}
        onClose={() => {
          setQrTarget(null);
          loadNumbers();
        }}
        onConnected={() => {
          setQrTarget(null);
          loadNumbers();
        }}
      />
    </div>
  );
}

// ============================================================
// Peças comuns
// ============================================================

function SectionHeader({ icon, title, description, actions }: { icon: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-tertiary">{icon}</span>
        <div className="min-w-0">
          <h2 className="text-[0.9375rem] font-semibold leading-tight text-primary">{title}</h2>
          {description && <p className="mt-1 text-[0.8125rem] text-secondary">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

function ErrorBanner({ message, hasData, onRetry }: { message: string; hasData: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3">
      <span className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-red-600 dark:text-red-400">
        <AlertTriangle size={15} className="shrink-0" />
        <span className="break-words">
          {hasData ? "A última atualização falhou; mostrando os dados anteriores." : "Não foi possível carregar."}
          <span className="block text-xs opacity-80">{message}</span>
        </span>
      </span>
      <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}

// ============================================================
// Números conectados
// ============================================================

function NumbersSection({
  numbers,
  error,
  onRetry,
  onAdd,
  onConnect,
}: {
  numbers: DispatchNumber[] | null;
  error: string | null;
  onRetry: () => void;
  onAdd: () => void;
  onConnect: (n: DispatchNumber) => void;
}) {
  // Conectados primeiro, depois conectando e desconectados.
  const sorted = useMemo(
    () =>
      [...(numbers ?? [])].sort(
        (a, b) => (STATE_INFO[a.state]?.order ?? 3) - (STATE_INFO[b.state]?.order ?? 3) || a.name.localeCompare(b.name, "pt-BR"),
      ),
    [numbers],
  );
  const online = sorted.filter((n) => n.state === "open").length;

  return (
    <section className="space-y-3" aria-label="Números conectados">
      <SectionHeader
        icon={<Smartphone size={16} />}
        title="Números conectados"
        description={
          numbers
            ? `${online} de ${numbers.length} ${numbers.length === 1 ? "número conectado" : "números conectados"}. As respostas destes números chegam ao Esfera e ao repasse.`
            : "WhatsApp de cada número de disparo, ligado à VPS para receber as respostas."
        }
        actions={
          <Button size="sm" icon={<Plus size={14} />} onClick={onAdd}>
            Adicionar número
          </Button>
        }
      />

      {error && <ErrorBanner message={error} hasData={numbers !== null} onRetry={onRetry} />}

      {numbers === null ? (
        !error && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1].map((i) => (
              <div key={i} className="h-36 rounded-xl border border-border bg-card skeleton" />
            ))}
          </div>
        )
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={18} />}
          title="Nenhum número de disparo"
          description="Adicione o número e leia o QR no celular para receber as respostas dos devedores."
          action={
            <Button icon={<Plus size={14} />} onClick={onAdd}>
              Adicionar número
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((n) => (
            <NumberCard key={n.name} item={n} onConnect={() => onConnect(n)} />
          ))}
        </div>
      )}
    </section>
  );
}

function NumberCard({ item, onConnect }: { item: DispatchNumber; onConnect: () => void }) {
  const st = STATE_INFO[item.state] ?? STATE_INFO.close;
  const down = item.state !== "open" && item.state !== "connecting";
  const blocked = down && item.disconnectionCode === 403;

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[0.9375rem] font-semibold tabular-nums text-primary">
            {item.number ? formatPhone(item.number) : "Número ainda não conectado"}
          </p>
          <p className="mt-0.5 truncate text-xs text-tertiary" title={`Conexão ${item.name}`}>
            {item.profileName || "Sem nome de perfil"} · <span className="font-mono">{item.name}</span>
          </p>
        </div>
        <Badge variant={st.variant} dot pulse={item.state === "connecting"}>
          {st.label}
        </Badge>
      </div>

      {down && (
        <div className={blocked ? errorBox : "rounded-lg border border-border bg-secondary px-3 py-2 text-[0.8125rem] text-secondary"}>
          <p>{disconnectReason(item.disconnectionCode)}</p>
          {item.disconnectionAt && <p className="mt-0.5 text-xs opacity-80">Desde {formatDbDate(item.disconnectionAt)}</p>}
        </div>
      )}
      {item.state === "connecting" && (
        <p className="text-[0.8125rem] text-secondary">Aguardando a leitura do QR no celular.</p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="truncate text-xs text-tertiary">
          {item.updatedAt ? `Atualizado em ${formatDbDate(item.updatedAt)}` : ""}
        </span>
        {item.state !== "open" && (
          <Button size="sm" variant={down ? "primary" : "secondary"} icon={<QrCode size={14} />} onClick={onConnect}>
            Conectar (QR)
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---- Modal: adicionar número ----

function AddNumberModal({ isOpen, onClose, onCreated }: { isOpen: boolean; onClose: () => void; onCreated: (t: QrTarget) => void }) {
  const [numero, setNumero] = useState("");
  const [apelido, setApelido] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setNumero("");
      setApelido("");
      setError(null);
    }
  }, [isOpen]);

  const close = () => {
    if (!saving) onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validPhone(numero)) {
      setError(INVALID_PHONE);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await api<CreateResult>("create_dispatch_number", { numero, nome: apelido.trim() || null });
      toast.success("Número adicionado", `Conexão ${r.instancia} criada. Agora leia o QR no celular.`);
      onCreated({ name: r.instancia, number: r.numero });
    } catch (err) {
      setError(apiErrorText(err, "Não foi possível adicionar o número."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title="Adicionar número de disparo"
      description="Cria a conexão do WhatsApp na VPS. As respostas deste número entram no repasse e no histórico do Konfiansa."
      size="sm"
      closeOnOverlayClick={!saving}
      closeOnEsc={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" form="add-dispatch-number" loading={saving} icon={<QrCode size={14} />}>
            Adicionar e conectar
          </Button>
        </>
      }
    >
      <form id="add-dispatch-number" onSubmit={submit} className="space-y-4">
        <Field label="Número do WhatsApp" required htmlFor="dn-numero" hint="DDD + número, ex.: 47 99627-1722">
          <input
            id="dn-numero"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            data-autofocus
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            placeholder="(47) 99999-8888"
            className="w-full"
          />
        </Field>
        <Field
          label="Apelido"
          htmlFor="dn-apelido"
          hint={
            <>
              Opcional. Nome da conexão: <span className="font-mono">{previewInstanceName(numero, apelido)}</span>
            </>
          }
        >
          <input
            id="dn-apelido"
            type="text"
            autoComplete="off"
            maxLength={40}
            value={apelido}
            onChange={(e) => setApelido(e.target.value)}
            placeholder="Ex.: Cobrança Ana"
            className="w-full"
          />
        </Field>
        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ---- Modal: QR (atualiza a cada 20 s e fecha sozinho ao conectar) ----

function QrModal({ target, onClose, onConnected }: { target: QrTarget | null; onClose: () => void; onConnected: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const name = target?.name ?? null;

  useEffect(() => {
    if (!name) return;
    let alive = true;
    let done = false;
    let fetching = false;
    let checking = false;
    let qrTimer: number | undefined;
    setQr(null);
    setPairing(null);
    setError(null);
    setNextAt(null);

    const finish = () => {
      if (done || !alive) return;
      done = true;
      toast.success("Número conectado", `A conexão ${name} está ligada ao WhatsApp.`);
      onConnectedRef.current();
    };

    const schedule = (ms: number) => {
      window.clearTimeout(qrTimer);
      if (!alive || done) return;
      qrTimer = window.setTimeout(fetchQr, ms);
      setNextAt(Date.now() + ms);
    };

    async function fetchQr() {
      if (fetching || done || !alive) return;
      fetching = true;
      try {
        const r = await api<QrResult>("get_dispatch_number_qr", { instancia: name });
        if (!alive) return;
        if (r?.conectado) {
          finish();
          return;
        }
        setQr(r?.qr ?? null);
        setPairing(r?.pairingCode ?? null);
        setError(null);
        // Sem QR ainda (a Evolution está gerando): tenta logo de novo.
        schedule(r?.qr ? QR_REFRESH_MS : 3_000);
      } catch (err) {
        if (!alive) return;
        setError(apiErrorText(err, "Não foi possível gerar o QR."));
        schedule(QR_REFRESH_MS);
      } finally {
        fetching = false;
      }
    }

    // Confere o estado mais vezes que o QR, para fechar logo depois da leitura.
    const stateTimer = window.setInterval(async () => {
      if (done || checking || document.hidden) return;
      checking = true;
      try {
        const list = await api<DispatchNumber[]>("get_dispatch_numbers");
        if (alive && Array.isArray(list) && list.some((i) => i.name === name && i.state === "open")) finish();
      } catch {
        /* o QR segue tentando */
      } finally {
        checking = false;
      }
    }, QR_STATE_MS);

    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    fetchQr();

    return () => {
      alive = false;
      window.clearTimeout(qrTimer);
      window.clearInterval(stateTimer);
      window.clearInterval(clock);
    };
  }, [name]);

  const secs = nextAt ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : 0;
  const pairingText = pairing && pairing.length === 8 ? `${pairing.slice(0, 4)}-${pairing.slice(4)}` : pairing;

  return (
    <Modal
      isOpen={!!target}
      onClose={onClose}
      title="Conectar número pelo QR"
      description={target ? `${target.number ? `${formatPhone(target.number)} · ` : ""}conexão ${target.name}` : undefined}
      size="sm"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-[0.8125rem] text-secondary">
          <li>No celular deste número, abra o WhatsApp.</li>
          <li>
            Vá em <span className="font-medium text-primary">Dispositivos conectados</span> ›{" "}
            <span className="font-medium text-primary">Conectar dispositivo</span>.
          </li>
          <li>Aponte a câmera para o QR abaixo.</li>
        </ol>

        <div className="flex flex-col items-center gap-2">
          {/* Fundo branco nos dois temas: QR escuro em fundo escuro não lê. */}
          <div className="flex h-64 w-64 items-center justify-center rounded-xl border border-border bg-white p-3">
            {qr ? (
              <img src={qr} alt="QR para conectar o WhatsApp" className="h-full w-full object-contain" />
            ) : error ? (
              <AlertTriangle size={28} className="text-red-500" />
            ) : (
              <Loader2 size={28} className="animate-spin text-zinc-400" />
            )}
          </div>
          <p className="text-xs tabular-nums text-tertiary" aria-live="polite">
            {qr ? `O QR muda a cada 20 s · novo em ${secs} s` : error ? `Tentando de novo em ${secs} s` : "Gerando o QR…"}
          </p>
          {pairingText && (
            <p className="text-center text-[0.8125rem] text-secondary">
              Ou em <span className="font-medium text-primary">Conectar com número de telefone</span>, digite o código{" "}
              <span className="font-mono font-semibold tracking-widest text-primary">{pairingText}</span>
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className={errorBox}>
            {error}
          </p>
        )}
        <p className="text-xs text-tertiary">A janela fecha sozinha quando o número conectar.</p>
      </div>
    </Modal>
  );
}

// ============================================================
// Quem recebe as respostas (destinos do repasse)
// ============================================================

function RepasseSection({
  repasse,
  error,
  onRetry,
  onChange,
}: {
  repasse: Repasse | null;
  error: string | null;
  onRetry: () => void;
  onChange: (r: Repasse) => void;
}) {
  const [numero, setNumero] = useState("");
  const [nome, setNome] = useState("");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const destinos = repasse?.destinos ?? [];
  const padrao = destinos.length === 0 ? repasse?.padrao ?? null : null;

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!validPhone(numero)) {
      setFormError(INVALID_PHONE);
      return;
    }
    setAdding(true);
    setFormError(null);
    try {
      const r = await api<Repasse & { numero?: string }>("add_repasse_destino", { numero, nome: nome.trim() });
      onChange({ destinos: r?.destinos ?? [], padrao: r?.padrao ?? null });
      setNumero("");
      setNome("");
      toast.success("Destino adicionado", `${formatPhone(r?.numero ?? numero)} passa a receber as respostas.`);
    } catch (err) {
      setFormError(apiErrorText(err, "Não foi possível adicionar o destino."));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (d: RepasseDestino) => {
    if (destinos.length <= 1) {
      toast.warning("Precisa ficar ao menos 1 destino", "Sem destino as respostas param de ser repassadas. Adicione outro antes de remover este.");
      return;
    }
    const ok = await confirmDialog({
      title: "Remover destino",
      message: `${formatPhone(d.numero)}${d.nome ? ` (${d.nome})` : ""} deixa de receber as respostas dos devedores. Precisa ficar ao menos 1 destino na lista.`,
      confirmLabel: "Remover",
      danger: true,
    });
    if (!ok) return;
    setRemoving(d.numero);
    try {
      const r = await api<Repasse>("remove_repasse_destino", { numero: d.numero });
      onChange({ destinos: r?.destinos ?? [], padrao: r?.padrao ?? null });
      toast.success("Destino removido", `${formatPhone(d.numero)} não recebe mais as respostas.`);
    } catch (err) {
      toast.error("Não foi possível remover", apiErrorText(err));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="space-y-3" aria-label="Quem recebe as respostas">
      <SectionHeader
        icon={<Send size={16} />}
        title="Quem recebe as respostas"
        description="As respostas dos devedores são repassadas para estes números no WhatsApp. Precisa ficar ao menos 1."
      />

      {error && <ErrorBanner message={error} hasData={repasse !== null} onRetry={onRetry} />}

      {repasse === null ? (
        !error && <div className="h-28 rounded-xl border border-border bg-card skeleton" />
      ) : (
        <Card padding="none">
          <ul className="divide-y divide-border">
            {destinos.map((d) => (
              <li key={d.numero} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[0.8125rem] font-medium tabular-nums text-primary">{formatPhone(d.numero)}</p>
                  <p className="truncate text-xs text-tertiary">
                    {d.nome || "Sem nome"}
                    {d.criado_em ? ` · desde ${formatDbDate(d.criado_em, { day: "2-digit", month: "2-digit", year: "numeric" })}` : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  loading={removing === d.numero}
                  disabled={removing !== null || destinos.length <= 1}
                  title={destinos.length <= 1 ? "Precisa ficar ao menos 1 destino." : "Remover destino"}
                  aria-label={`Remover ${formatPhone(d.numero)}`}
                  onClick={() => remove(d)}
                >
                  Remover
                </Button>
              </li>
            ))}
            {padrao && (
              <li className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[0.8125rem] font-medium tabular-nums text-primary">{formatPhone(padrao.numero)}</p>
                  <p className="text-xs text-tertiary">
                    Número padrão: recebe enquanto ninguém for adicionado (entra na lista ao adicionar o primeiro).
                  </p>
                </div>
                <Badge variant="neutral">Padrão</Badge>
              </li>
            )}
            {destinos.length === 0 && !padrao && (
              <li className="px-4 py-3 text-[0.8125rem] text-secondary">Nenhum destino. Adicione quem deve receber as respostas.</li>
            )}
          </ul>

          <form onSubmit={add} className="space-y-2 border-t border-border p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="tel"
                inputMode="tel"
                autoComplete="off"
                aria-label="Número do destino"
                placeholder="Número (ex.: 47 99999-8888)"
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                className="w-full sm:max-w-[16rem]"
              />
              <input
                type="text"
                autoComplete="off"
                aria-label="Nome do destino"
                placeholder="Nome (ex.: Marcela)"
                maxLength={80}
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                className="w-full sm:max-w-[16rem]"
              />
              <Button type="submit" icon={<Plus size={14} />} loading={adding} className="h-9 shrink-0">
                Adicionar
              </Button>
            </div>
            {formError && (
              <p role="alert" className={errorBox}>
                {formError}
              </p>
            )}
          </form>
        </Card>
      )}
    </section>
  );
}

// ============================================================
// Históricos no Konfiansa
// ============================================================

function HistoriesSection({ histories, error, onRetry }: { histories: KonfiansaHistory[] | null; error: string | null; onRetry: () => void }) {
  const [filter, setFilter] = useState<HistFilter>("all");
  const list = useMemo(() => histories ?? [], [histories]);
  const count = (f: HistFilter) => (f === "all" ? list.length : list.filter((h) => h.status === f).length);
  const shown = filter === "all" ? list : list.filter((h) => h.status === filter);
  const thCls = "sticky top-0 z-10 border-b border-border bg-card px-4 py-2.5 font-medium";

  return (
    <section className="space-y-3" aria-label="Históricos no Konfiansa">
      <SectionHeader
        icon={<FileText size={16} />}
        title="Históricos no Konfiansa"
        description={`Conversas gravadas no processo do devedor (as ${HISTORY_LIMIT} mais recentes). A conversa vai depois de 1 h parada ou logo após o SAIR.`}
        actions={
          <SegmentedControl
            ariaLabel="Filtrar por status"
            value={filter}
            onChange={setFilter}
            items={[
              { id: "all", label: "Todos", count: count("all") },
              { id: "pendente", label: "Pendente", count: count("pendente") },
              { id: "gravado", label: "Gravado", count: count("gravado") },
              { id: "erro", label: "Erro", count: count("erro") },
              { id: "sem_processo", label: "Sem processo", count: count("sem_processo") },
            ]}
          />
        }
      />

      {error && <ErrorBanner message={error} hasData={histories !== null} onRetry={onRetry} />}

      {histories === null ? (
        !error && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 rounded-lg border border-border bg-card skeleton" />
            ))}
          </div>
        )
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<FileText size={18} />}
          title={list.length === 0 ? "Nenhum histórico ainda" : "Nenhum histórico com este status"}
          description={
            list.length === 0
              ? "Quando um devedor disparado conversar e a conversa fechar, ela aparece aqui."
              : "Escolha outro filtro para ver os demais."
          }
        />
      ) : (
        <Card padding="none">
          <div className="max-h-[60vh] overflow-auto custom-scrollbar">
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead>
                <tr className="text-xs font-medium text-tertiary">
                  <th className={`${thCls} w-40`}>Data</th>
                  <th className={`${thCls} w-48`}>Telefone</th>
                  <th className={`${thCls} w-36`}>Status</th>
                  <th className={thCls}>Processos</th>
                  <th className={thCls}>Erro</th>
                </tr>
              </thead>
              <tbody className="text-[0.8125rem]">
                {shown.map((h) => {
                  const st = HIST_STATUS[h.status] ?? { label: h.status || "—", variant: "neutral" as Variant };
                  const procs = formatProcessos(h.processos);
                  return (
                    <tr key={h.historyId} className="align-top transition-colors hover:bg-hover">
                      <td className="whitespace-nowrap border-b border-border px-4 py-2 text-xs tabular-nums text-secondary">
                        {formatDbDate(h.createdAt)}
                        {h.gravadoEm && h.status === "gravado" && (
                          <span className="block text-tertiary">gravado {formatDbDate(h.gravadoEm, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                        )}
                      </td>
                      <td className="border-b border-border px-4 py-2">
                        <span className="tabular-nums text-primary">{formatPhone(h.phone)}</span>
                        <span className="block text-xs text-tertiary">
                          {h.motivo === "recusa" ? "Pediu SAIR" : "1 h sem mensagens"} · {h.mensagens} {h.mensagens === 1 ? "mensagem" : "mensagens"}
                        </span>
                      </td>
                      <td className="border-b border-border px-4 py-2">
                        <Badge variant={st.variant} dot>
                          {st.label}
                        </Badge>
                        {h.status === "erro" && h.tentativas > 1 && (
                          <span className="mt-1 block text-xs text-tertiary">{h.tentativas} tentativas</span>
                        )}
                      </td>
                      <td className="border-b border-border px-4 py-2 font-mono text-xs text-secondary" title={h.processos || undefined}>
                        {procs.length > 0 ? procs.map((p) => <span key={p} className="block">{p}</span>) : "—"}
                      </td>
                      <td className="break-words border-b border-border px-4 py-2 text-xs text-red-600 dark:text-red-400">
                        {h.erro || <span className="text-tertiary">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}
