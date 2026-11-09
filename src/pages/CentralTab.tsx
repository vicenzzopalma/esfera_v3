// ============================================================
// Esfera v3 — Central
// Tudo das automações num lugar só: como cada uma está (Disparo, Maiara, ponte,
// Marcela, Konfiansa, Repasse), a lista "Precisa de você" com o botão de resolver
// e a busca de devedor com tudo que aconteceu com ele.
// Atualiza sozinha a cada 20 s, menos enquanto alguém digita num campo.
// Ações "local:*" são tratadas aqui; as outras vão para o comando central_action.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import { confirmDialog } from "../components/ui/Modal";
import PageHeader from "../components/ui/PageHeader";
import EmptyState from "../components/ui/EmptyState";
import Field from "../components/ui/Field";
import { toast } from "../components/ui/ToastContainer";
import { api, centralAction, centralDevedor, getCentral } from "../tauri";
import { apiErrorText, formatDbDate, parseDbDate } from "../hooks/useQueries";
import type { Central, CentralAcao, CentralAutomacao, CentralEvento, CentralPendencia } from "../types";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  History,
  Info,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Search,
  UserSearch,
  Wrench,
  X,
} from "lucide-react";

type Variant = "success" | "warning" | "danger" | "info" | "neutral";

const REFRESH_MS = 20_000;

const ESTADO_INFO: Record<string, { label: string; variant: Variant }> = {
  ok: { label: "Funcionando", variant: "success" },
  pausado: { label: "Pausado", variant: "warning" },
  teste: { label: "Em teste", variant: "info" },
  caido: { label: "Parado", variant: "danger" },
  desconhecido: { label: "Sem notícia", variant: "neutral" },
};

const GRAVIDADE_INFO: Record<string, { label: string; order: number; variant: Variant }> = {
  alta: { label: "Urgente", order: 0, variant: "danger" },
  media: { label: "Atenção", order: 1, variant: "warning" },
  baixa: { label: "Quando puder", order: 2, variant: "neutral" },
};

/** Nome curto de cada origem (automação) para as etiquetas. */
const ORIGEM_LABEL: Record<string, string> = {
  disparo: "Disparo",
  aparelho: "Aparelhos",
  maiara: "Maiara",
  ponte: "Ponte da Maiara",
  marcela: "Marcela",
  konfiansa: "Konfiansa",
  konfiansa_pc: "Konfiansa no PC",
  konfiansa_hist: "Históricos Konfiansa",
  repasse: "Repasse",
};

/** Ordem dos cartões; quem não está aqui vai para o fim, na ordem que chegou. */
const AUTOMACAO_ORDEM = ["disparo", "maiara", "ponte", "marcela", "konfiansa_pc", "konfiansa_hist", "repasse"];

/** Tela onde se resolve à mão cada origem, quando a ação local não tem o que precisa. */
const ROTA_POR_ORIGEM: Record<string, string> = {
  disparo: "/campaigns",
  aparelho: "/devices",
  konfiansa_hist: "/dispatch-numbers",
  repasse: "/dispatch-numbers",
};

/** A partir de quantas pendências do mesmo tipo elas viram um item só na lista. */
const GRUPO_MIN = 3;

/** Título do grupo para os tipos conhecidos; os outros usam o texto genérico. */
const GRUPO_TITULO: Record<string, (n: number) => string> = {
  "maiara:sem_responsavel": (n) => `Maiara: ${n} devedores responderam e estão sem responsável`,
  "marcela:pedido": (n) => `Marcela: ${n} pedidos esperando você`,
};

// ---- Regras puras ----

/** Foco num campo de texto: a atualização automática espera. */
function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function origemLabel(origem: string): string {
  return ORIGEM_LABEL[origem] ?? (origem ? origem.charAt(0).toUpperCase() + origem.slice(1).replace(/_/g, " ") : "—");
}

function timeOf(iso?: string | null): number {
  return parseDbDate(iso)?.getTime() ?? 0;
}

/** "há 12 s", "há 15 min", "há 3 h"; mais de um dia vira data e hora. */
function relativeTime(iso?: string | null, now = Date.now()): string {
  const d = parseDbDate(iso);
  if (!d) return "";
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 5) return "agora";
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  return formatDbDate(iso);
}

/** (47) 99627-1722; aceita com ou sem 55 e sem o 9 do celular antigo. */
function formatPhone(raw: string): string {
  let d = (raw || "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d || "—";
}

/** CPF 000.000.000-00, CNPJ 00.000.000/0000-00; outro tamanho fica como veio. */
function formatDocumento(raw: string): string {
  const d = (raw || "").replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return d || raw;
}

/** CPF (11), CNPJ (14) ou telefone com DDD (10/11, ou 12/13 com o 55). */
function validDevedorQuery(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 14;
}

function gravidadeOrder(g: string): number {
  return GRAVIDADE_INFO[g]?.order ?? 3;
}

/** Tipo da pendência = os dois primeiros pedaços do id ("maiara:sem_responsavel:12" → "maiara:sem_responsavel"). */
function tipoPendencia(id: string): string {
  return String(id ?? "").split(":").slice(0, 2).join(":");
}

type PendenciaEntrada =
  | { tipo: "item"; item: CentralPendencia; ordem: number; tempo: number }
  | { tipo: "grupo"; chave: string; origem: string; itens: CentralPendencia[]; gravidade: string; quando: string | null; ordem: number; tempo: number };

/**
 * Junta num item só as pendências do mesmo tipo quando são GRUPO_MIN ou mais.
 * Recebe a lista já ordenada (gravidade, depois data); o grupo fica com a maior
 * gravidade e a data mais recente, e a lista final segue a mesma ordenação.
 */
function agruparPendencias(sorted: CentralPendencia[]): PendenciaEntrada[] {
  const porTipo = new Map<string, CentralPendencia[]>();
  for (const p of sorted) {
    const t = tipoPendencia(p.id);
    const lista = porTipo.get(t);
    if (lista) lista.push(p);
    else porTipo.set(t, [p]);
  }
  const entradas: PendenciaEntrada[] = [];
  for (const [chave, itens] of porTipo) {
    if (itens.length < GRUPO_MIN) {
      for (const item of itens) entradas.push({ tipo: "item", item, ordem: gravidadeOrder(item.gravidade), tempo: timeOf(item.quando) });
      continue;
    }
    // Itens já vêm ordenados: o primeiro tem a maior gravidade.
    const gravidade = itens[0].gravidade;
    let quando: string | null = null;
    let tempo = 0;
    for (const it of itens) {
      const t = timeOf(it.quando);
      if (quando === null || t > tempo) {
        tempo = t;
        quando = it.quando ?? null;
      }
    }
    entradas.push({ tipo: "grupo", chave, origem: itens[0].origem, itens, gravidade, quando, ordem: gravidadeOrder(gravidade), tempo });
  }
  return entradas.sort((a, b) => a.ordem - b.ordem || b.tempo - a.tempo);
}

function tituloGrupo(chave: string, origem: string, n: number): string {
  const f = GRUPO_TITULO[chave];
  return f ? f(n) : `${origemLabel(origem || chave.split(":")[0])}: ${n} pendências parecidas`;
}

function formatValor(v: number | string): string {
  return typeof v === "number" ? v.toLocaleString("pt-BR") : String(v);
}

function acaoIcon(acao: CentralAcao): ReactNode {
  const a = acao.acao.toLowerCase();
  if (a === "local:abrir") return <ExternalLink size={13} />;
  if (a.includes("pausar")) return <Pause size={13} />;
  if (a.includes("retomar") || a.includes("religar") || a.includes("reconectar")) return <Play size={13} />;
  return <Wrench size={13} />;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Só rotas internas do app ("/devices", "/campaigns"...). */
function safeRoute(v: unknown): string | null {
  const r = str(v);
  return r && r.startsWith("/") && !r.startsWith("//") ? r : null;
}

const errorBox = "rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[0.8125rem] text-red-600 dark:text-red-400";

interface DevedorBusca {
  q: string;
  loading: boolean;
  eventos: CentralEvento[] | null;
  /** Partes da busca que não responderam. */
  falhas: string[];
  error: string | null;
}

// ============================================================
// Página
// ============================================================

export default function CentralTab() {
  const navigate = useNavigate();
  // Mesma empresa escolhida que as outras telas usam; sem empresa, o backend decide.
  const { selectedCompanyId } = useAuth();
  const [central, setCentral] = useState<Central | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [devedorInput, setDevedorInput] = useState("");
  const [devedor, setDevedor] = useState<DevedorBusca | null>(null);
  const aliveRef = useRef(true);
  const loadingRef = useRef(false);
  const busyRef = useRef(false);
  const devedorSeq = useRef(0);
  const devedorRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    try {
      const data = await getCentral(selectedCompanyId);
      if (!aliveRef.current) return;
      setCentral({
        geradoEm: data?.geradoEm ?? null,
        automacoes: Array.isArray(data?.automacoes) ? data.automacoes : [],
        pendencias: Array.isArray(data?.pendencias) ? data.pendencias : [],
        falhas: Array.isArray(data?.falhas) ? data.falhas.filter(Boolean) : [],
      });
      setError(null);
    } catch (err) {
      if (aliveRef.current) setError(apiErrorText(err, "Não foi possível ler a Central."));
    } finally {
      loadingRef.current = false;
      if (aliveRef.current) {
        setRefreshing(false);
        setLastRefresh(new Date());
      }
    }
  }, [selectedCompanyId]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // A cada 20 s, com a janela visível, ninguém digitando e nenhuma ação em curso.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!document.hidden && !isTyping() && !busyRef.current) load();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load]);

  // ---- Busca de devedor ----

  const searchDevedor = useCallback(async (raw: string) => {
    const q = raw.replace(/\D/g, "");
    if (!validDevedorQuery(q)) {
      setDevedor({ q, loading: false, eventos: null, falhas: [], error: "Digite um CPF (11 números), um CNPJ (14) ou um telefone com DDD." });
      return;
    }
    const seq = ++devedorSeq.current;
    setDevedor({ q, loading: true, eventos: null, falhas: [], error: null });
    try {
      const r = await centralDevedor(q, selectedCompanyId);
      if (!aliveRef.current || seq !== devedorSeq.current) return;
      const eventos = (Array.isArray(r?.eventos) ? r.eventos : []).slice().sort((a, b) => timeOf(b.quando) - timeOf(a.quando));
      const falhas = Array.isArray(r?.falhas) ? r.falhas.filter(Boolean) : [];
      setDevedor({ q, loading: false, eventos, falhas, error: null });
    } catch (err) {
      if (!aliveRef.current || seq !== devedorSeq.current) return;
      setDevedor({ q, loading: false, eventos: null, falhas: [], error: apiErrorText(err, "Não foi possível buscar o devedor.") });
    }
  }, [selectedCompanyId]);

  const openDevedor = useCallback(
    (valor: string) => {
      setDevedorInput(valor);
      searchDevedor(valor);
      devedorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [searchDevedor],
  );

  const clearDevedor = () => {
    devedorSeq.current++;
    setDevedorInput("");
    setDevedor(null);
  };

  // ---- Ações ----

  /**
   * Ações que o próprio Esfera resolve (aparelhos, campanhas, abrir outra tela).
   * Devolve true quando executou algo (aí a Central recarrega); false quando só mudou de tela.
   */
  const runLocal = useCallback(
    async (acao: CentralAcao, origem: string): Promise<boolean> => {
      const p = acao.params ?? {};
      const nome = acao.acao.slice("local:".length);
      let fallback = safeRoute(p.rota) ?? ROTA_POR_ORIGEM[origem] ?? null;

      let call: (() => Promise<unknown>) | null = null;
      let okTitle = "Feito.";
      if (nome === "reconectar_aparelho") {
        // Sem serial ou sem empresa não chuta a empresa: abre a tela de aparelhos.
        const serial = str(p.serial);
        const companyId = num(p.companyId) ?? num(p.company_id);
        if (serial && companyId !== null) {
          call = () => api<string>("force_adb_connect_device", { serial, companyId });
          okTitle = "Aparelho reconectado.";
        } else {
          fallback = "/devices";
        }
      } else if (nome === "reconectar_todos") {
        call = () => api<string>("force_reconnect_all_adb", {});
        okTitle = "Reconexão dos aparelhos pedida.";
      } else if (nome === "pausar_campanha" && num(p.campaignId ?? p.campanha_id) !== null) {
        const campaignId = num(p.campaignId ?? p.campanha_id);
        call = () => api("pause_campaign", { campaignId });
        okTitle = "Campanha pausada.";
      } else if (nome === "retomar_campanha" && num(p.campaignId ?? p.campanha_id) !== null) {
        const campaignId = num(p.campaignId ?? p.campanha_id);
        call = () => api("start_campaign", { campaignId });
        okTitle = "Campanha retomada.";
      }

      if (!call) {
        // "local:abrir" e qualquer ação local sem atalho aqui: vai para a tela certa.
        if (fallback) navigate(fallback);
        else toast.warning("Não deu para resolver por aqui.", "Abra a tela da automação para resolver.");
        return false;
      }

      const r = await call();
      const detalhe = typeof r === "string" && r.trim() ? r.trim().slice(0, 300) : undefined;
      toast.success(okTitle, detalhe);
      return true;
    },
    [navigate],
  );

  const runAction = useCallback(
    async (acao: CentralAcao, origem: string, key: string) => {
      // Trava antes da confirmação: duplo clique não abre duas perguntas nem manda duas vezes.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(key);
      let ran = false;
      try {
        if (acao.perigosa || acao.confirmar) {
          const ok = await confirmDialog({
            title: `${acao.rotulo}?`,
            message: acao.confirmar || "Tem certeza? Isso muda o que a automação está fazendo agora.",
            confirmLabel: acao.rotulo,
            danger: !!acao.perigosa,
          });
          if (!ok) return;
        }

        if (acao.acao.startsWith("local:")) {
          ran = await runLocal(acao, origem);
          return;
        }

        ran = true;
        const r = await centralAction(acao.acao, (acao.params ?? {}) as Record<string, unknown>);
        if (r && r.ok === false) toast.error("Não deu certo.", r.mensagem || "A automação recusou o pedido.");
        else toast.success(r?.mensagem || "Feito.");
      } catch (err) {
        ran = true;
        toast.error("Não foi possível concluir.", apiErrorText(err, "Tente de novo em instantes."));
      } finally {
        busyRef.current = false;
        if (aliveRef.current) setBusy(null);
        if (ran && aliveRef.current) load();
      }
    },
    [runLocal, load],
  );

  const falhas = central?.falhas ?? [];

  return (
    <div className="space-y-8 animate-fade-in">
      <PageHeader
        title="Central"
        description="Como cada automação está agora, o que precisa de você e tudo que aconteceu com um devedor."
        icon={<Radar size={18} />}
        actions={
          <>
            {lastRefresh && (
              <span className="text-xs text-tertiary tabular-nums">Atualizado às {lastRefresh.toLocaleTimeString("pt-BR")}</span>
            )}
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} loading={refreshing} onClick={load}>
              Atualizar
            </Button>
          </>
        }
      />

      {error && <ErrorBanner message={error} hasData={central !== null} onRetry={load} />}
      {falhas.length > 0 && <FalhasNotice falhas={falhas} />}

      <AutomacoesSection automacoes={central?.automacoes ?? null} loading={central === null && !error} busy={busy} onAction={runAction} />

      <PendenciasSection
        pendencias={central?.pendencias ?? null}
        loading={central === null && !error}
        busy={busy}
        onAction={runAction}
        onDevedor={openDevedor}
      />

      <DevedorSection
        sectionRef={devedorRef}
        input={devedorInput}
        onInput={setDevedorInput}
        busca={devedor}
        onSearch={() => searchDevedor(devedorInput)}
        onClear={clearDevedor}
      />
    </div>
  );
}

// ============================================================
// Peças comuns
// ============================================================

function SectionHeader({ icon, title, description, actions }: { icon: ReactNode; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
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
          {hasData ? "A última atualização falhou; mostrando os dados anteriores." : "Não foi possível carregar a Central."}
          <span className="block text-xs opacity-80">{message}</span>
        </span>
      </span>
      <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onRetry}>
        Tentar de novo
      </Button>
    </div>
  );
}

/** Fonte que não respondeu: aviso discreto, o resto da tela continua valendo. */
function FalhasNotice({ falhas }: { falhas: string[] }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-700 dark:text-amber-400">
      <Info size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p>Algumas informações não chegaram agora; o resto está atualizado.</p>
        <ul className="mt-0.5 text-xs opacity-90">
          {falhas.map((f, i) => (
            <li key={`${i}-${f}`} className="break-words">
              · {f}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AcaoButton({
  acao,
  actionKey,
  busy,
  primary,
  onRun,
}: {
  acao: CentralAcao;
  actionKey: string;
  busy: string | null;
  primary?: boolean;
  onRun: () => void;
}) {
  const variant = acao.perigosa ? "danger" : primary ? "primary" : "secondary";
  return (
    <Button
      size="sm"
      variant={variant}
      icon={acaoIcon(acao)}
      loading={busy === actionKey}
      disabled={busy !== null && busy !== actionKey}
      onClick={onRun}
    >
      {acao.rotulo}
    </Button>
  );
}

// ============================================================
// Estado de cada automação
// ============================================================

type RunAction = (acao: CentralAcao, origem: string, key: string) => void;

function AutomacoesSection({
  automacoes,
  loading,
  busy,
  onAction,
}: {
  automacoes: CentralAutomacao[] | null;
  loading: boolean;
  busy: string | null;
  onAction: RunAction;
}) {
  const sorted = useMemo(() => {
    const rank = (id: string) => {
      const i = AUTOMACAO_ORDEM.indexOf(id);
      return i < 0 ? AUTOMACAO_ORDEM.length : i;
    };
    return [...(automacoes ?? [])].sort((a, b) => rank(a.id) - rank(b.id));
  }, [automacoes]);
  const paradas = sorted.filter((a) => a.estado === "caido").length;

  return (
    <section className="space-y-3" aria-label="Automações">
      <SectionHeader
        icon={<Radar size={16} />}
        title="Automações"
        description={
          automacoes
            ? paradas > 0
              ? `${paradas} de ${sorted.length} ${paradas === 1 ? "está parada" : "estão paradas"}. Veja abaixo o que fazer.`
              : `${sorted.length} ${sorted.length === 1 ? "automação" : "automações"} acompanhadas.`
            : "Como cada automação está agora."
        }
      />

      {automacoes === null ? (
        loading && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-32 rounded-xl border border-border bg-card skeleton" />
            ))}
          </div>
        )
      ) : sorted.length === 0 ? (
        <EmptyState icon={<Radar size={18} />} title="Nenhuma automação para mostrar" description="Quando houver automação ligada a esta empresa, o estado dela aparece aqui." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((a) => (
            <AutomacaoCard key={a.id} item={a} busy={busy} onAction={onAction} />
          ))}
        </div>
      )}
    </section>
  );
}

function AutomacaoCard({ item, busy, onAction }: { item: CentralAutomacao; busy: string | null; onAction: RunAction }) {
  const st = ESTADO_INFO[item.estado] ?? ESTADO_INFO.desconhecido;
  const numeros = item.numeros ?? [];
  const acoes = item.acoes ?? [];

  return (
    <Card padding="sm" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-[0.9375rem] font-semibold text-primary" title={item.nome}>
          {item.nome || origemLabel(item.id)}
        </p>
        <Badge variant={st.variant} dot>
          {st.label}
        </Badge>
      </div>

      {item.detalhe && (
        <p className={`text-[0.8125rem] ${item.estado === "caido" ? "text-red-600 dark:text-red-400" : "text-secondary"}`}>{item.detalhe}</p>
      )}

      {numeros.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {numeros.map((n, i) => (
            <div key={`${i}-${n.rotulo}`} className="min-w-0">
              <dt className="truncate text-xs text-tertiary">{n.rotulo}</dt>
              <dd className="text-[0.8125rem] font-medium tabular-nums text-primary">{formatValor(n.valor)}</dd>
            </div>
          ))}
        </dl>
      )}

      {acoes.length > 0 && (
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {acoes.map((acao, i) => {
            const key = `auto:${item.id}:${i}:${acao.acao}`;
            return <AcaoButton key={key} acao={acao} actionKey={key} busy={busy} onRun={() => onAction(acao, item.id, key)} />;
          })}
        </div>
      )}
    </Card>
  );
}

// ============================================================
// Precisa de você
// ============================================================

function PendenciasSection({
  pendencias,
  loading,
  busy,
  onAction,
  onDevedor,
}: {
  pendencias: CentralPendencia[] | null;
  loading: boolean;
  busy: string | null;
  onAction: RunAction;
  onDevedor: (valor: string) => void;
}) {
  // Mais grave primeiro; na mesma gravidade, a mais recente primeiro.
  const sorted = useMemo(
    () => [...(pendencias ?? [])].sort((a, b) => gravidadeOrder(a.gravidade) - gravidadeOrder(b.gravidade) || timeOf(b.quando) - timeOf(a.quando)),
    [pendencias],
  );
  // Muitas do mesmo tipo viram um item só, com "Ver todos".
  const entradas = useMemo(() => agruparPendencias(sorted), [sorted]);
  // Grupos abertos, pela chave do tipo: a atualização de 20 s não fecha o que está aberto.
  const [abertos, setAbertos] = useState<Set<string>>(() => new Set());
  const toggleGrupo = useCallback((chave: string) => {
    setAbertos((prev) => {
      const next = new Set(prev);
      if (next.has(chave)) next.delete(chave);
      else next.add(chave);
      return next;
    });
  }, []);
  const urgentes = sorted.filter((p) => p.gravidade === "alta").length;
  const now = Date.now();

  return (
    <section className="space-y-3" aria-label="Precisa de você">
      <SectionHeader
        icon={<AlertTriangle size={16} />}
        title={
          <span className="inline-flex items-center gap-2">
            Precisa de você
            {pendencias && <span className="tabular-nums text-tertiary">({sorted.length})</span>}
            {urgentes > 0 && (
              <Badge variant="danger">
                {urgentes} {urgentes === 1 ? "urgente" : "urgentes"}
              </Badge>
            )}
          </span>
        }
        description="Cada item tem o botão para resolver aqui mesmo."
      />

      {pendencias === null ? (
        loading && (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 rounded-xl border border-border bg-card skeleton" />
            ))}
          </div>
        )
      ) : sorted.length === 0 ? (
        <EmptyState icon={<CheckCircle2 size={18} />} title="Nada esperando por você" description="Quando alguma automação precisar de uma decisão, ela aparece aqui." />
      ) : (
        <Card padding="none" className="divide-y divide-border">
          {entradas.map((e) =>
            e.tipo === "item" ? (
              <PendenciaRow key={e.item.id} item={e.item} now={now} busy={busy} onAction={onAction} onDevedor={onDevedor} />
            ) : (
              <PendenciaGrupo
                key={`grupo:${e.chave}`}
                grupo={e}
                aberto={abertos.has(e.chave)}
                onToggle={() => toggleGrupo(e.chave)}
                now={now}
                busy={busy}
                onAction={onAction}
                onDevedor={onDevedor}
              />
            ),
          )}
        </Card>
      )}
    </section>
  );
}

function PendenciaRow({
  item,
  now,
  busy,
  onAction,
  onDevedor,
}: {
  item: CentralPendencia;
  now: number;
  busy: string | null;
  onAction: RunAction;
  onDevedor: (valor: string) => void;
}) {
  const grav = GRAVIDADE_INFO[item.gravidade] ?? GRAVIDADE_INFO.baixa;
  const acoes = item.acoes ?? [];
  const doc = item.devedor?.documento ? String(item.devedor.documento) : "";
  const tel = item.devedor?.telefone ? String(item.devedor.telefone) : "";
  const devedorBusca = doc || tel;
  const devedorTexto = doc ? formatDocumento(doc) : tel ? formatPhone(tel) : "";
  const iconColor = grav.variant === "danger" ? "text-red-500" : grav.variant === "warning" ? "text-amber-500" : "text-tertiary";

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        {grav.variant === "neutral" ? (
          <Info size={15} className={`mt-0.5 shrink-0 ${iconColor}`} />
        ) : (
          <AlertTriangle size={15} className={`mt-0.5 shrink-0 ${iconColor}`} />
        )}
        <div className="min-w-0">
          <p className="break-words text-[0.8125rem] font-medium text-primary">{item.titulo}</p>
          {item.detalhe && <p className="mt-0.5 break-words text-[0.8125rem] text-secondary">{item.detalhe}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
            <Badge variant={grav.variant}>{grav.label}</Badge>
            <Badge variant="neutral">{origemLabel(item.origem)}</Badge>
            {item.quando && (
              <span className="tabular-nums" title={formatDbDate(item.quando)}>
                {relativeTime(item.quando, now)}
              </span>
            )}
            {devedorBusca && (
              <button
                type="button"
                onClick={() => onDevedor(devedorBusca)}
                className="inline-flex items-center gap-1 rounded-md px-1 text-[var(--color-accent-light)] hover:underline cursor-pointer"
                title="Ver tudo que aconteceu com este devedor"
              >
                <UserSearch size={12} />
                <span className="tabular-nums">{devedorTexto}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {acoes.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {acoes.map((acao, i) => {
            const key = `pend:${item.id}:${i}:${acao.acao}`;
            return (
              <AcaoButton key={key} acao={acao} actionKey={key} busy={busy} primary={i === 0} onRun={() => onAction(acao, item.origem, key)} />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Várias pendências do mesmo tipo num item só; "Ver todos" abre cada uma com seus botões. */
function PendenciaGrupo({
  grupo,
  aberto,
  onToggle,
  now,
  busy,
  onAction,
  onDevedor,
}: {
  grupo: Extract<PendenciaEntrada, { tipo: "grupo" }>;
  aberto: boolean;
  onToggle: () => void;
  now: number;
  busy: string | null;
  onAction: RunAction;
  onDevedor: (valor: string) => void;
}) {
  const grav = GRAVIDADE_INFO[grupo.gravidade] ?? GRAVIDADE_INFO.baixa;
  const iconColor = grav.variant === "danger" ? "text-red-500" : grav.variant === "warning" ? "text-amber-500" : "text-tertiary";
  const n = grupo.itens.length;
  const listaId = `central-grupo-${grupo.chave.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <div>
      <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          {grav.variant === "neutral" ? (
            <Info size={15} className={`mt-0.5 shrink-0 ${iconColor}`} />
          ) : (
            <AlertTriangle size={15} className={`mt-0.5 shrink-0 ${iconColor}`} />
          )}
          <div className="min-w-0">
            <p className="break-words text-[0.8125rem] font-medium text-primary">{tituloGrupo(grupo.chave, grupo.origem, n)}</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-tertiary">
              <Badge variant={grav.variant}>{grav.label}</Badge>
              <Badge variant="neutral">{origemLabel(grupo.origem)}</Badge>
              {grupo.quando && (
                <span className="tabular-nums" title={formatDbDate(grupo.quando)}>
                  mais recente {relativeTime(grupo.quando, now)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Button
            size="sm"
            variant="secondary"
            icon={aberto ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            onClick={onToggle}
            aria-expanded={aberto}
            aria-controls={listaId}
          >
            {aberto ? "Recolher" : `Ver todos (${n})`}
          </Button>
        </div>
      </div>

      {aberto && (
        <div id={listaId} className="ml-4 mb-2 mr-2 divide-y divide-border rounded-lg border border-border bg-secondary">
          {grupo.itens.map((p) => (
            <PendenciaRow key={p.id} item={p} now={now} busy={busy} onAction={onAction} onDevedor={onDevedor} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Buscar devedor
// ============================================================

function DevedorSection({
  sectionRef,
  input,
  onInput,
  busca,
  onSearch,
  onClear,
}: {
  sectionRef: RefObject<HTMLElement | null>;
  input: string;
  onInput: (v: string) => void;
  busca: DevedorBusca | null;
  onSearch: () => void;
  onClear: () => void;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch();
  };
  const eventos = busca?.eventos ?? null;

  return (
    <section ref={sectionRef} className="scroll-mt-16 space-y-3" aria-label="Buscar devedor">
      <SectionHeader
        icon={<UserSearch size={16} />}
        title="Buscar devedor"
        description="Tudo que aconteceu com ele nas automações que você acompanha, do mais novo para o mais antigo."
      />

      <Card padding="sm" className="space-y-4">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="CPF, CNPJ ou telefone" htmlFor="central-devedor" className="flex-1" hint="Só os números já bastam. Telefone com DDD, com ou sem 55.">
            <input
              id="central-devedor"
              type="search"
              inputMode="numeric"
              autoComplete="off"
              value={input}
              onChange={(e) => onInput(e.target.value)}
              placeholder="Ex.: 123.456.789-00 ou (47) 99999-8888"
              className="w-full"
            />
          </Field>
          <div className="flex gap-2 sm:mb-[1.375rem]">
            <Button type="submit" icon={<Search size={14} />} loading={busca?.loading}>
              Buscar
            </Button>
            {busca && (
              <Button type="button" variant="ghost" icon={<X size={14} />} onClick={onClear}>
                Limpar
              </Button>
            )}
          </div>
        </form>

        {busca?.error && (
          <p role="alert" className={errorBox}>
            {busca.error}
          </p>
        )}

        {busca?.loading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-10 rounded-lg skeleton" />
            ))}
          </div>
        )}

        {busca && !busca.loading && busca.falhas.length > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[0.8125rem] text-amber-700 dark:text-amber-400">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">Parte da busca não respondeu: {busca.falhas.join("; ")}.</span>
          </div>
        )}

        {eventos && eventos.length === 0 && busca && busca.falhas.length > 0 && (
          <EmptyState
            icon={<History size={18} />}
            title="Não deu para consultar tudo"
            description="No que respondeu não há nada com esse CPF, CNPJ ou telefone. Tente de novo em instantes para ver o resto."
          />
        )}

        {eventos && eventos.length === 0 && busca && busca.falhas.length === 0 && (
          <EmptyState
            icon={<History size={18} />}
            title="Nada encontrado"
            description="Nenhuma automação registrou algo com esse CPF, CNPJ ou telefone."
          />
        )}

        {eventos && eventos.length > 0 && <Timeline eventos={eventos} />}
      </Card>
    </section>
  );
}

function Timeline({ eventos }: { eventos: CentralEvento[] }) {
  const now = Date.now();
  return (
    <div className="space-y-2">
      <p className="text-xs text-tertiary">
        {eventos.length} {eventos.length === 1 ? "acontecimento" : "acontecimentos"}, do mais novo para o mais antigo.
      </p>
      <ol className="relative ml-1.5 border-l border-border">
        {eventos.map((ev, i) => (
          <li key={`${i}-${ev.quando ?? ""}-${ev.titulo}`} className="relative pb-3 pl-4 last:pb-0">
            <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full bg-[var(--color-accent-light)]" />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge variant="neutral">{origemLabel(ev.origem)}</Badge>
              {ev.quando && (
                <span className="text-xs tabular-nums text-tertiary" title={relativeTime(ev.quando, now)}>
                  {formatDbDate(ev.quando)}
                </span>
              )}
            </div>
            <p className="mt-1 break-words text-[0.8125rem] font-medium text-primary">{ev.titulo}</p>
            {ev.detalhe && <p className="mt-0.5 whitespace-pre-line break-words text-[0.8125rem] text-secondary">{ev.detalhe}</p>}
          </li>
        ))}
      </ol>
    </div>
  );
}
