// ============================================================
// Esfera v3 — Campanhas
// Lista de campanhas, assistente de criação/edição, detalhe com
// execução ao vivo, contatos, aparelhos e configurações.
// Componentes em ./campaigns/
// ============================================================

import { type ReactNode, useEffect, useRef, useState, useMemo, useDeferredValue, useCallback, useId, useSyncExternalStore } from "react";
import { Search, X, MoreHorizontal, Check, CheckCheck, ChevronLeft, ChevronRight, Shuffle, AlertCircle, Sparkles, ChevronDown, UserRound, Clock, AlertTriangle, Battery, RefreshCw, Smartphone, ArrowDown, Terminal, Upload, Users, FileUp, CheckCircle2, Eye, EyeOff, PlugZap, ArrowLeft, ArrowRight, Circle, LayoutDashboard, Pause, Pencil, Play, RotateCcw, Send, Settings2, Square, XCircle, Brain, Building2, Megaphone, Plus, Ban, Trash2, Download, Info } from "lucide-react";
import type { Campaign, CampaignStatus, Contact, Device, AiConfig } from "../types";
import { AI_PROVIDERS, DEFAULT_WHATSAPP_SYSTEM_PROMPT, getAiProviderInfo } from "../constants/aiProviders";
import Modal from "../components/ui/Modal";
import Button from "../components/ui/Button";
import { api } from "../tauri";
import Field, { FormSection } from "../components/ui/Field";
import Toggle from "../components/ui/Toggle";
import EmptyState from "../components/ui/EmptyState";
import { SegmentedControl, Tabs } from "../components/ui/Tabs";
import Badge from "../components/ui/Badge";
import { useAuth } from "../context/AuthContext";
import { listen } from "@tauri-apps/api/event";
import StatCard from "../components/ui/StatCard";
import PageHeader from "../components/ui/PageHeader";
import { toast } from "../components/ui/ToastContainer";

// ============================================================
// shared
// ============================================================

// Utilitários e peças pequenas compartilhadas pela tela de Campanhas.

export type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral" | "purple";

export const STATUS_CONFIG: Record<CampaignStatus | "stopped", { variant: BadgeVariant; label: string }> = {
  running: { variant: "success", label: "Em andamento" },
  paused: { variant: "warning", label: "Pausada" },
  stopped: { variant: "warning", label: "Interrompida" },
  completed: { variant: "info", label: "Concluída" },
  draft: { variant: "neutral", label: "Rascunho" },
  error: { variant: "danger", label: "Erro" },
};

export function statusInfo(status: string) {
  return STATUS_CONFIG[status as CampaignStatus] || STATUS_CONFIG.draft;
}

export const nowTime = () => new Date().toLocaleTimeString("pt-BR");

export function campaignUsesAi(c?: Campaign | null): boolean {
  return Boolean(c?.useAi ?? c?.useAI ?? false);
}

// ---------- Contagens ----------
export interface CampaignCounts {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  /** Pulados sem envio: descadastrados, sem WhatsApp e quem já recebeu. */
  skipped: number;
  /** Envio parcial: conferir no celular antes de qualquer reenvio. */
  review: number;
  /** Processados / total (pulados e parciais contam como processados). */
  progress: number;
}

// Da lista de campanhas: o banco guarda total, enviados e falhas. Na campanha concluída o resto não está
// pendente: são os pulados (descadastrados, sem WhatsApp, já recebeu) e os parciais.
export function countsFromCampaign(c: Campaign): CampaignCounts {
  const total = c.contactsCount || 0;
  const sent = c.sentCount || 0;
  const failed = c.failedCount || 0;
  const rest = Math.max(0, total - sent - failed);
  const done = c.status === "completed";
  const pending = done ? 0 : rest;
  const progress = total > 0 ? Math.min(100, Math.round(((total - pending) / total) * 100)) : 0;
  return { total, sent, failed, pending, skipped: done ? rest : 0, review: 0, progress };
}

// Da fila real de contatos (detalhe): contagem exata por status.
export function countsFromContacts(c: Campaign, contacts: Contact[]): CampaignCounts {
  if (!contacts.length) return countsFromCampaign(c);
  let sent = 0;
  let failed = 0;
  let pending = 0;
  let skipped = 0;
  let review = 0;
  for (const x of contacts) {
    const s = x.status as string;
    if (s === "sent" || s === "replied") sent++;
    else if (s === "failed") failed++;
    else if (s === "partial") review++;
    else if (s === "opt_out" || s === "no_whatsapp" || s === "already_sent") skipped++;
    else pending++;
  }
  const total = contacts.length;
  return { total, sent, failed, pending, skipped, review, progress: Math.min(100, Math.round(((total - pending) / total) * 100)) };
}

export function formatNumber(n: number) {
  return n.toLocaleString("pt-BR");
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

export function formatDate(value?: string): string {
  if (!value) return "—";
  // O SQLite grava CURRENT_TIMESTAMP em UTC sem fuso ("2026-10-26 20:30:42"): trata como UTC.
  const sqliteUtc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value);
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : sqliteUtc ? `${value.replace(" ", "T")}Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  const hasTime = value.length > 10;
  return hasTime
    ? d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// Telefone legível ("+5575988052539" -> "(75) 98805-2539"). Fica como texto no Excel.
export function formatPhoneBr(phone: string) {
  let d = phone.replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return phone;
}

// CSV para o Excel brasileiro: separador ";", BOM UTF-8 e todas as células entre aspas. Célula que
// começa com = + - @ ganha um apóstrofo, para o Excel não tratar como fórmula.
export function downloadCsv(fileName: string, header: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const s = String(v ?? "");
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const csv = [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function delaySummary(min: number, max: number) {
  return min === max ? `${min}s entre mensagens` : `entre ${min}s e ${max}s por mensagem`;
}

// ---------- Contatos (importação) ----------
// Números no padrão Brasil (DDI +55). NÃO inventa DDD: com DDD (10-11 dígitos) recebe +55; já com
// 55 (12-13 dígitos) fica como está; sem DDD (8-9 dígitos) não entra, a não ser que o operador informe o DDD.

// DDDs em uso no Brasil (Anatel). Número que não começa por DDD válido (ex.: nº de processo) não é telefone.
const BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function isValidDdd(ddd: string) {
  return /^\d{2}$/.test(ddd) && BR_DDD.has(Number(ddd));
}

export type PhoneKind = "mobile" | "landline" | "local" | "invalid";

// Celular: DDD + 9 + 8 dígitos (ou 8 dígitos antigos começando em 6-9). Fixo: DDD + 8 dígitos começando em 2-5.
// "local": 8-9 dígitos sem DDD. NÃO entra na fila: sem DDD o número viraria um DDI estrangeiro
// (98805-2539 -> +98...). Só vira telefone se o operador informar o DDD para completar.
export function classifyPhone(raw: string, ddd?: string): { phone: string; kind: PhoneKind } {
  let clean = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (ddd && isValidDdd(ddd) && (clean.length === 8 || clean.length === 9)) clean = ddd + clean;
  const d = (clean.length === 12 || clean.length === 13) && clean.startsWith("55") ? clean.slice(2) : clean;
  if (d.length === 10 || d.length === 11) {
    const local = d.slice(2);
    if (!BR_DDD.has(Number(d.slice(0, 2)))) return { phone: "", kind: "invalid" };
    if (local.length === 9) return local[0] === "9" ? { phone: "+55" + d, kind: "mobile" } : { phone: "", kind: "invalid" };
    if ("2345".includes(local[0])) return { phone: "+55" + d, kind: "landline" };
    if ("6789".includes(local[0])) return { phone: "+55" + d, kind: "mobile" };
    return { phone: "", kind: "invalid" };
  }
  if (clean.length === 8 || clean.length === 9) return { phone: "", kind: "local" };
  return { phone: "", kind: "invalid" };
}

// Célula com mais de um telefone ("(75) 98805-2539 / (75) 3221-1234"): separa antes de classificar.
function phoneCandidates(cell: string, ddd?: string): string[] {
  if (cell.replace(/\D/g, "").length <= 13) return [cell];
  const strong = (v: string) => {
    const k = classifyPhone(v, ddd).kind;
    return k === "mobile" || k === "landline";
  };
  const out: string[] = [];
  for (const piece of cell.split(/\s*(?:[;,/|]|\s+e\s+|\s{2,})\s*/i)) {
    if (piece.replace(/\D/g, "").length <= 13) {
      out.push(piece);
      continue;
    }
    // Sem separador ("75988052539 7532211234"): junta os pedaços até formar um telefone completo.
    let acc = "";
    for (const tok of piece.split(/\s+/)) {
      const next = acc ? `${acc} ${tok}` : tok;
      if (acc && strong(acc) && !strong(next)) {
        out.push(acc);
        acc = tok;
      } else acc = next;
    }
    if (acc) out.push(acc);
  }
  const phones = out.map((p) => p.trim()).filter((p) => p.replace(/\D/g, "").length >= 8);
  return phones.length ? phones : [cell];
}

export type PhoneMode = "all" | "one";

export interface ImportOptions {
  phoneMode: PhoneMode;
  includeLandlines: boolean;
  /** DDD (2 dígitos) para completar números sem DDD. Só quando o operador informa. */
  ddd?: string;
  /** Coluna do nome escolhida pelo operador (-1 = sem nome). Sem valor: automático. */
  nameCol?: number;
  /** Colunas de telefone escolhidas pelo operador. Sem valor: automático. */
  phoneCols?: number[];
  /** Separador já conhecido (planilha .xlsx vira texto com tabulação). */
  delimiter?: string;
}

export interface ParsedRow {
  line: number;
  raw: string;
  name: string;
  phone: string;
  valid: boolean;
  warning?: string;
  reason?: string;
  /** Pulado por regra (outro número do devedor, repetido, fixo), não por erro na lista. */
  skipped?: boolean;
}

export interface ParsedColumn {
  index: number;
  label: string;
  sample: string;
}

export interface ParsedImport {
  rows: ParsedRow[];
  lines: number;
  columns: string;
  multiPhone: boolean;
  landlines: number;
  /** Números com 8-9 dígitos (sem DDD) nas colunas de telefone. */
  localCount: number;
  allColumns: ParsedColumn[];
  nameCol: number;
  phoneCols: number[];
  hasHeader: boolean;
}

// Cabeçalho comparado sem acento, caixa, "_" ou "-", e com espaço entre letra e número ("TEL1" -> "tel 1").
function headerKey(s: string) {
  return plainText(s)
    .replace(/[_\-./]+/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

const PHONE_HEADER = /\b(telefones?|tel|fones?|celular(es)?|cel|whatsapp|whats|zap)\b|^(numero|contato \d+)$/;
// Telefone de terceiro (referência, recado, cônjuge, trabalho...) ou número que não é telefone: cobrar
// por ele expõe o devedor (CDC art. 42). O operador ainda pode marcar a coluna à mão na prévia.
const PHONE_HEADER_EXCLUDE = /\b(refer\w*|recado|conjuge|pai|mae|avalista|fiador|parente|comercial|trabalho|empresa|contrato|processo|parcela|cpf|cnpj|cep)\b/;
const NAME_EXCLUDE = /\b(mae|pai|conjuge|refer\w*|credor|avalista|fiador|parente|vendedor|operador|cobrador|endereco|logradouro|rua|bairro|cidade|uf|estado|cep|email|observ\w*|obs|situacao|status|produto|carteira)\b/;
const HEADER_WORD = /\b(nome|name|devedor|razao|cliente|contato|telefones?|fones?|tel|celular|cel|whatsapp|whats|numero|processo|codigo|cpf|cnpj|documento|email|sacado|destinatario|titular|cidade|uf|endereco)\b/;

// Prioridade da coluna de nome: devedor/sacado/razão social > nome > cliente/contato (que pode ser o credor).
function nameScore(h: string) {
  if (!h || NAME_EXCLUDE.test(h) || PHONE_HEADER.test(h)) return 0;
  if (/\b(devedor|sacado|razao|titular|consumidor)\b/.test(h)) return 3;
  if (/\b(nome|name)\b/.test(h)) return 2;
  if (/\b(cliente|contato|destinatario|empresa)\b/.test(h)) return 1;
  return 0;
}

function plainText(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function detectDelimiter(lines: string[]) {
  let best: string | null = null;
  let bestScore = 0;
  for (const d of [";", "\t", ","]) {
    const score = lines.slice(0, 50).filter((l) => l.includes(d)).length;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

// Linha sem separador no formato "Maria Silva 75 98805-2539": nome e telefone.
const NAME_THEN_PHONE = /^(.*?[A-Za-zÀ-ÿ][^\d]*?)[\s:;,.\-–]*(\+?\(?\d[\d\s().-]{7,})$/;

// Divide a linha pelo separador, respeitando campos entre aspas ("SILVA, JOÃO";...).
function splitCells(line: string, delim: string | null): string[] {
  if (!delim) {
    const m = /[A-Za-zÀ-ÿ]/.test(line) ? line.match(NAME_THEN_PHONE) : null;
    return m ? [m[1].trim(), m[2].trim()] : [line.trim()];
  }
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cur.trim() === "") {
      quoted = true;
      cur = "";
    } else if (ch === delim) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function listLabels(labels: string[]) {
  return labels.length > 3 ? `${labels[0]} … ${labels[labels.length - 1]} (${labels.length})` : labels.join(", ");
}

// Lê a lista colada ou o arquivo (CSV/TXT/planilha). Aceita "Nome, Telefone", só o telefone, ou colunas
// com cabeçalho (ex.: PROCESSO; NOME DEVEDOR; TELEFONE 1..10). Sem cabeçalho, deduz pelo conteúdo: a coluna
// de nome tem letras; as de telefone têm números com DDD válido (nº de processo antes do nome não passa).
// Cada telefone vira um contato; fixo só entra se pedido; número repetido entra uma vez.
export function parseContactsText(text: string, opts: ImportOptions = { phoneMode: "all", includeLandlines: false }): ParsedImport {
  const source = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, raw: l.trim() }))
    .filter((l) => l.raw !== "");
  if (!source.length) {
    return { rows: [], lines: 0, columns: "", multiPhone: false, landlines: 0, localCount: 0, allColumns: [], nameCol: -1, phoneCols: [], hasHeader: false };
  }

  const ddd = opts.ddd && isValidDdd(opts.ddd) ? opts.ddd : undefined;
  const classify = (v: string) => classifyPhone(v, ddd);
  const isStrongPhone = (v: string) => phoneCandidates(v, ddd).some((p) => {
    const k = classify(p).kind;
    return k === "mobile" || k === "landline";
  });

  const delim = opts.delimiter ?? detectDelimiter(source.map((l) => l.raw));
  const table = source.map((l) => ({ ...l, cells: splitCells(l.raw, delim) }));
  const width = table.reduce((w, r) => Math.max(w, r.cells.length), 0);
  const firstCells = table[0].cells;
  const hasHeader = !firstCells.some(isStrongPhone) && firstCells.filter((c) => HEADER_WORD.test(headerKey(c))).length >= 2;
  const header = hasHeader ? Array.from({ length: width }, (_, j) => headerKey(firstCells[j] ?? "")) : null;
  const data = hasHeader ? table.slice(1) : table;

  const stats = Array.from({ length: width }, () => ({ filled: 0, letters: 0, strong: 0, mobile: 0, local: 0, local9: 0, sample: "" }));
  for (const r of data) {
    r.cells.forEach((c, j) => {
      if (!c) return;
      const st = stats[j];
      st.filled++;
      if (!st.sample) st.sample = c;
      if (/[a-zA-ZÀ-ÿ]/.test(c)) st.letters++;
      else {
        const kinds = phoneCandidates(c, ddd).map((p) => classify(p).kind);
        if (kinds.includes("mobile")) st.mobile++;
        if (kinds.includes("mobile") || kinds.includes("landline")) st.strong++;
        else if (kinds.includes("local")) {
          st.local++;
          // 9 dígitos começando em 9: celular sem DDD (CEP e outros códigos têm 8).
          if (/^9\d{8}$/.test(c.replace(/\D/g, "").replace(/^0+/, ""))) st.local9++;
        }
      }
    });
  }
  const textual = (j: number) => stats[j].filled > 0 && stats[j].letters * 2 >= stats[j].filled;

  let autoName = -1;
  if (header) {
    let best = 0;
    header.forEach((h, j) => {
      const s = nameScore(h);
      if (s > best && textual(j)) {
        best = s;
        autoName = j;
      }
    });
  }
  if (autoName < 0) {
    let best = 0;
    stats.forEach((st, j) => {
      if (header && (PHONE_HEADER.test(header[j]) || NAME_EXCLUDE.test(header[j]))) return;
      if (st.letters > best && textual(j)) {
        best = st.letters;
        autoName = j;
      }
    });
  }
  const nameCol = opts.nameCol !== undefined ? (opts.nameCol < width ? opts.nameCol : -1) : autoName;

  let autoPhones: number[] = [];
  if (header) {
    // Coluna com nome de telefone ainda precisa ter telefones no conteúdo.
    autoPhones = header
      .map((h, j) => {
        if (j === nameCol || !PHONE_HEADER.test(h) || PHONE_HEADER_EXCLUDE.test(h)) return -1;
        const st = stats[j];
        return !st.filled || (st.strong + st.local) / st.filled >= 0.3 ? j : -1;
      })
      .filter((j) => j >= 0);
  }
  if (!autoPhones.length) {
    autoPhones = stats
      .map((st, j) => {
        if (j === nameCol || !st.filled) return -1;
        if (header && PHONE_HEADER_EXCLUDE.test(header[j])) return -1;
        // Antes da coluna de nome (ex.: código/processo) só conta celular com DDD na maioria. Depois dela,
        // celular sem DDD também conta, para a prévia pedir o DDD em vez de dizer "sem telefone".
        const share = (nameCol >= 0 && j < nameCol ? st.mobile : st.strong + st.local9) / st.filled;
        return share >= 0.6 ? j : -1;
      })
      .filter((j) => j >= 0);
  }
  const phoneCols = opts.phoneCols !== undefined ? opts.phoneCols.filter((j) => j < width && j !== nameCol) : autoPhones;

  const label = (j: number) => (hasHeader && firstCells[j]?.trim()) || `Coluna ${j + 1}`;
  const allColumns = stats
    .map((st, j) => ({ index: j, label: label(j), sample: st.sample }))
    .filter((c) => stats[c.index].filled > 0);
  const ignored = stats.map((st, j) => (st.filled && j !== nameCol && !phoneCols.includes(j) ? label(j) : "")).filter(Boolean);
  const columns = [
    nameCol >= 0 ? `Nome: ${label(nameCol)}` : "Nome: nenhuma coluna (a mensagem sai sem o nome)",
    phoneCols.length ? `Telefone: ${listLabels(phoneCols.map(label))}` : "Telefone: nenhuma coluna reconhecida",
    ignored.length ? `Ignorada: ${listLabels(ignored)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  // "Só 1": números de cada devedor já lido, para reconhecer a mesma pessoa em outra linha.
  const debtorOf = new Map<string, { line: number; name: string }>();
  let multiPhone = false;
  let landlines = 0;
  let localCount = 0;
  for (const r of data) {
    // Linha só com o telefone (sem separador) numa lista "Nome, Telefone": sem nome.
    const single = r.cells.length === 1;
    const name = (!single && nameCol >= 0 ? r.cells[nameCol] ?? "" : "").trim();
    const values = (single ? [r.cells[0]] : phoneCols.map((j) => (r.cells[j] ?? "").trim()))
      .filter(Boolean)
      .flatMap((v) => phoneCandidates(v, ddd));
    if (!values.length) {
      rows.push({ line: r.line, raw: r.raw, name, phone: "", valid: false, reason: "Sem telefone" });
      continue;
    }
    const found = values.map((v) => ({ v, ...classify(v) }));
    const usable = found.filter((c) => c.kind === "mobile" || c.kind === "landline");
    if (usable.length > 1) multiPhone = true;
    landlines += found.filter((c) => c.kind === "landline").length;
    localCount += found.filter((c) => c.kind === "local").length;
    const nameKey = plainText(name).replace(/\s+/g, " ");
    if (opts.phoneMode === "one") {
      // Mesma pessoa em outra linha (mesmo nome e um número em comum): não recebe de novo por outro número.
      const same = usable.map((c) => debtorOf.get(optOutKey(c.phone))).find((d) => d !== undefined && d.name === nameKey);
      if (same) {
        for (const c of found) {
          rows.push({ line: r.line, raw: r.raw, name, phone: c.phone || c.v, valid: false, skipped: true, reason: `Mesmo devedor da linha ${same.line}` });
        }
        continue;
      }
    }
    // "Só 1": o 1º celular ainda não usado; sem celular, o 1º número aceito.
    const pool = usable.filter((c) => (c.kind !== "landline" || opts.includeLandlines) && !seen.has(optOutKey(c.phone)));
    const chosen = opts.phoneMode === "one" ? pool.find((c) => c.kind === "mobile") ?? pool[0] : undefined;
    for (const c of found) {
      const base = { line: r.line, raw: r.raw, name, phone: c.phone || c.v };
      if (c.kind === "invalid") {
        rows.push({ ...base, valid: false, reason: "Número inválido" });
        continue;
      }
      if (c.kind === "local") {
        rows.push({ ...base, valid: false, reason: "Sem DDD" });
        continue;
      }
      if (c.kind === "landline" && !opts.includeLandlines) {
        rows.push({ ...base, valid: false, skipped: true, reason: "Fixo (ignorado)" });
        continue;
      }
      const key = optOutKey(c.phone);
      const firstLine = seen.get(key);
      if (firstLine !== undefined) {
        rows.push({ ...base, valid: false, skipped: true, reason: firstLine === r.line ? "Repetido na mesma linha" : `Repetido (linha ${firstLine})` });
        continue;
      }
      if (opts.phoneMode === "one" && c !== chosen) {
        rows.push({ ...base, valid: false, skipped: true, reason: "Outro número do devedor" });
        continue;
      }
      seen.set(key, r.line);
      rows.push({ ...base, valid: true, warning: c.kind === "landline" ? "Fixo" : undefined });
    }
    if (opts.phoneMode === "one") {
      for (const c of usable) {
        const k = optOutKey(c.phone);
        if (!debtorOf.has(k)) debtorOf.set(k, { line: r.line, name: nameKey });
      }
    }
  }
  return { rows, lines: data.length, columns, multiPhone, landlines, localCount, allColumns, nameCol, phoneCols, hasHeader };
}

// Nome em CAIXA ALTA vira "Maria da Silva" (siglas de empresa como LTDA, ME e S/A ficam como estão).
const NAME_PARTICLES = new Set(["da", "das", "de", "do", "dos", "e"]);
const COMPANY_TOKENS = new Set(["LTDA", "LTDA.", "ME", "MEI", "EPP", "EIRELI", "S/A", "S.A.", "SA", "S.A", "CIA", "CIA."]);
export function tidyName(name: string) {
  const letters = name.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (!letters || letters !== letters.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i) => {
      if (/^\s+$/.test(w) || !w) return w;
      if (COMPANY_TOKENS.has(w.toUpperCase())) return w.toUpperCase();
      if (i > 0 && NAME_PARTICLES.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join("");
}

export function isShoutedName(name: string) {
  const letters = name.replace(/[^A-Za-zÀ-ÿ]/g, "");
  return letters.length > 1 && letters === letters.toUpperCase();
}

// ---------- Planilha .xlsx ----------
// Leitura sem dependências: o .xlsx é um zip de XMLs. Usa a 1ª aba, textos compartilhados e números.
type ZipEntry = { method: number; offset: number; size: number };

function zipIndex(buf: Uint8Array): Map<string, ZipEntry> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("O arquivo não é uma planilha .xlsx válida.");
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  for (let k = 0; k < total && p + 46 <= buf.length && dv.getUint32(p, true) === 0x02014b50; k++) {
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    out.set(names.decode(buf.subarray(p + 46, p + 46 + nameLen)), {
      method: dv.getUint16(p + 10, true),
      offset: local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true),
      size: dv.getUint32(p + 20, true),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

async function zipText(buf: Uint8Array, zip: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const e = zip.get(name);
  if (!e) return null;
  const data = buf.slice(e.offset, e.offset + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error("Compressão da planilha não suportada.");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlDecode(s: string) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
      const k = e.toLowerCase();
      if (k[0] !== "#") return XML_ENTITIES[k];
      return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function xmlTexts(xml: string) {
  let t = "";
  for (const m of xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)) t += m[1];
  return xmlDecode(t);
}

function xlsxColumn(ref: string) {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Telefone salvo como número no Excel vem como "64981805000" ou "6.4981805E10": volta para dígitos.
function xlsxNumber(raw: string) {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return raw;
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
}

export async function parseXlsx(buf: Uint8Array): Promise<string[][]> {
  const zip = zipIndex(buf);
  const workbook = (await zipText(buf, zip, "xl/workbook.xml")) ?? "";
  const rels = (await zipText(buf, zip, "xl/_rels/workbook.xml.rels")) ?? "";
  // 1ª aba na ordem do arquivo: workbook.xml -> rels -> worksheets/sheetN.xml
  let sheetPath = "xl/worksheets/sheet1.xml";
  const rid = workbook.match(/<(?:\w+:)?sheet\b[^>]*?\s(?:\w+:)?id="([^"]+)"/)?.[1];
  if (rid) {
    const rel = Array.from(rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g), (m) => m[0]).find((r) => r.includes(`Id="${rid}"`));
    const target = rel?.match(/\bTarget="([^"]+)"/)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = await zipText(buf, zip, sheetPath);
  if (sheet == null) throw new Error("Não encontrei a primeira aba da planilha.");
  const shared: string[] = [];
  const sst = await zipText(buf, zip, "xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) {
      shared.push(xmlTexts((m[1] ?? "").replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "")));
    }
  }
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const cm of (rm[1] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+)\d*"/)?.[1];
      const col = ref ? xlsxColumn(ref) : next;
      next = col + 1;
      const type = attrs.match(/\bt="(\w+)"/)?.[1] ?? "n";
      const v = inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1] ?? "";
      cells[col] =
        type === "s"
          ? shared[Number(v)] ?? ""
          : type === "inlineStr"
            ? xmlTexts(inner)
            : type === "b"
              ? v === "1"
                ? "VERDADEIRO"
                : v
                  ? "FALSO"
                  : ""
              : type === "n"
                ? xlsxNumber(v)
                : xmlDecode(v);
    }
    const filled = Array.from(cells, (c) => c ?? "");
    if (filled.some((c) => c.trim() !== "")) rows.push(filled);
  }
  return rows;
}

// Linhas da planilha -> texto separado por tabulação (o mesmo caminho da lista colada e do CSV).
export function rowsToText(rows: string[][]) {
  return rows
    .map((r) => {
      const cells = r.map((c) => c.replace(/[\t\r\n]+/g, " ").trim());
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      return cells.join("\t");
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
}

// UTF-16 ("Texto Unicode" do Excel, Export-Csv do PowerShell), UTF-8 (com ou sem BOM) ou, se não for
// UTF-8 válido, Windows-1252 (CSV salvo pelo Excel no Windows).
export function decodeTextFile(buf: ArrayBuffer) {
  const b = new Uint8Array(buf);
  const utf16 = (le: boolean) => new TextDecoder(le ? "utf-16le" : "utf-16be").decode(buf).replace(/\u0000/g, "");
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return utf16(true);
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16(false);
  // Sem BOM, mas com um byte nulo a cada dois: também é UTF-16.
  const sample = b.subarray(0, Math.min(b.length, 4096));
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) i % 2 ? oddZeros++ : evenZeros++;
  if (sample.length >= 4 && Math.max(evenZeros, oddZeros) > sample.length / 4) return utf16(oddZeros > evenZeros);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

// ---------- Spintax ----------
export function resolveSpintaxLocal(text: string) {
  let resolved = text;
  const spintaxRegex = /\{([^{}]+)\}/g;
  let match;
  let maxIterations = 100;
  while ((match = spintaxRegex.exec(resolved)) !== null && maxIterations-- > 0) {
    const options = match[1].split("|");
    const chosen = options[Math.floor(Math.random() * options.length)];
    resolved = resolved.replace(match[0], chosen);
    spintaxRegex.lastIndex = 0;
  }
  return resolved;
}

// Conta combinações possíveis (blocos internos primeiro). Limitado para não explodir.
export function spintaxCombinations(text: string): number {
  let work = text;
  let total = 1;
  const re = /\{([^{}]*)\}/;
  let guard = 200;
  let m: RegExpExecArray | null;
  while ((m = re.exec(work)) && guard-- > 0) {
    const n = m[1].split("|").length;
    total = Math.min(total * n, 1_000_000_000);
    work = work.slice(0, m.index) + "x" + work.slice(m.index + m[0].length);
  }
  return total;
}

// Variáveis de nome: {nome} e o nome da coluna da planilha ({NOME DEVEDOR}, {Razão Social}, {cliente}...).
// Igual ao backend (AiEngine::normalize_name_variables): compara sem acento, caixa, espaço ou "_".
const NAME_ALIASES = new Set([
  "nome", "name", "nomedevedor", "nomedodevedor", "devedor", "razaosocial", "razao", "nomefantasia",
  "cliente", "nomecliente", "nomedocliente", "contato", "nomecontato", "nomedocontato", "nomecompleto", "destinatario",
]);
const BRACE_BLOCK = /\{([^{}|]+)\}/g;

export function isNameVariable(inner: string) {
  return NAME_ALIASES.has(plainText(inner).replace(/[^a-z0-9]/g, ""));
}

export function hasNameVariable(text: string) {
  return Array.from(text.matchAll(BRACE_BLOCK)).some((m) => isNameVariable(m[1]));
}

export function fillSampleName(text: string, sample = "Maria") {
  return text.replace(BRACE_BLOCK, (block, inner: string) => (isNameVariable(inner) ? sample : block));
}

// {X} sem "|" que não é variável conhecida: o spintax devolveria o texto "X" (ex.: {PROCESSO} sai "PROCESSO").
export function unknownVariables(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(BRACE_BLOCK)).filter((m) => !isNameVariable(m[1])).map((m) => m[0])));
}

// ---------- Regras da mensagem ----------
// A mensagem sai sempre em 3 partes (saudação, corpo e encerramento), cada parte como uma mensagem do
// WhatsApp. Estas regras bloqueiam salvar e iniciar; o motor repete as principais antes de cada envio.

export interface MessageValue {
  greeting: string;
  body: string;
  closing: string;
  useSpintax: boolean;
}

export type MessageField = "greeting" | "body" | "closing";
const MESSAGE_FIELDS: MessageField[] = ["greeting", "body", "closing"];
const FIELD_LABEL: Record<MessageField, string> = { greeting: "Saudação", body: "Mensagem", closing: "Encerramento" };

export const WHATSAPP_LIMIT = 4096;
export const OPT_OUT_TEXT = "Para deixar de receber mensagens por este canal, responda SAIR.";
const OPT_OUT_WORD = /\bsair\b/i;

// Link: protocolo, www. ou domínio (empresa.com.br, wa.me/...). E-mail também conta (o motor bloqueia igual).
const LINK_RE = /(?:https?:\/\/|www\.)\S*|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/\S*)?/i;

// Regra da empresa: mensagens não podem citar valores. Mesma base do backend (AiEngine::has_money): R$, reais,
// %, "R 350", "valor/saldo/parcela... 350", 350,00 e 350.00 (data 10.10.26 não conta). A tela também barra
// 1.500 e 1.234,56, "2 mil" e "10x de 50".
const MONEY_RE =
  /R\$|RS\$|\bBRL\b|\breais\b|\bcentavos\b|\d+\s*%|\bpor\s*cento\b|\bR\s+\d|\b(valor|valores|saldo|parcelas?|d[ií]vida|d[ée]bito|total|quantia|montante|pre[çc]o|desconto|juros|multa|pague|pagar|pagamento|custa)\b[:\s]*(\S+\s+){0,2}?\d|\d,\d{2}(?![\d./])|(?<!\.\d{1,2})\d\.\d{2}(?![\d./])|\b\d{1,3}(?:\.\d{3})+(?:,\d{2})?\b(?![.,/-]\d)|\b\d+(?:[.,]\d+)?\s*(?:mil|milh[õo]es|milh[ãa]o)\b|\b\d{1,2}\s*x\s*(?:de\s*)?\d{2,}/i;
// Cobrança + número de 3+ dígitos: "você deve 300", "pendência de 1500", "acordo por 900". Substantivo seguido
// direto do número é identificação ("acordo 123456", "boleto nº 4567"); telefone (0800...) também não conta.
const MONEY_CONTEXT_RE = /\b(pend[êe]ncias?|acordos?|entrada|vista|quitar|quita[çc][ãa]o|boletos?|faturas?|deve|devendo|d[ée]bitos?)\b((?:\s+\S+){0,3})/gi;
const MONEY_VERB_RE = /^(deve|devendo|quitar)$/i;
const MONEY_PREP_RE = /^(de|por|com|em|a|à)$/i;
const ID_MARKER_RE = /^(n[º°o.]?|n[úu]mero|protocolo|c[óo]digo|contrato|processo|#)$/i;

// Trecho encontrado, estendido até as palavras inteiras ("0.00" -> "350.00"), para o aviso mostrar o que tirar.
function wholeWords(text: string, start: number, end: number) {
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  while (end < text.length && !/\s/.test(text[end])) end++;
  return text.slice(start, end).trim().replace(/[.,;:!?)]+$/, "");
}

export function findLink(text: string): string | undefined {
  const m = LINK_RE.exec(text);
  return m ? wholeWords(text, m.index, m.index + m[0].length) : undefined;
}

export function findMoney(text: string): string | undefined {
  const m = MONEY_RE.exec(text);
  if (m) return wholeWords(text, m.index, m.index + m[0].length);
  for (const k of text.matchAll(MONEY_CONTEXT_RE)) {
    const words = k[2].trim().split(/\s+/).filter(Boolean);
    const verb = MONEY_VERB_RE.test(k[1]);
    for (let i = 0; i < words.length; i++) {
      if (!/^[1-9]\d{2,}/.test(words[i].replace(/^[^\d]+/, ""))) continue;
      const prev = i > 0 ? words[i - 1] : "";
      if (ID_MARKER_RE.test(prev)) break;
      if (verb || MONEY_PREP_RE.test(prev)) return `${k[1]} ${words.slice(0, i + 1).join(" ")}`.replace(/[.,;:!?)]+$/, "");
    }
  }
  return undefined;
}

// Bloco de variações mais interno ({a|b}, sem chaves dentro).
const SPIN_BLOCK = /\{[^{}]*\|[^{}]*\}/;

// O termo aparece em todas as variações? Resolve cada bloco escolhendo uma opção SEM o termo, se houver.
function alwaysHas(text: string, re: RegExp) {
  let out = text;
  let guard = 200;
  let m: RegExpExecArray | null;
  while ((m = SPIN_BLOCK.exec(out)) && guard-- > 0) {
    const options = m[0].slice(1, -1).split("|");
    const pick = options.find((o) => !re.test(o)) ?? options[0];
    out = out.slice(0, m.index) + pick + out.slice(m.index + m[0].length);
  }
  return re.test(out);
}

// Correções de um clique.
export function fixFirstOption(text: string) {
  let out = text;
  let guard = 200;
  let m: RegExpExecArray | null;
  while ((m = SPIN_BLOCK.exec(out)) && guard-- > 0) out = out.slice(0, m.index) + m[0].slice(1, -1).split("|")[0] + out.slice(m.index + m[0].length);
  return out;
}

export function stripUnknownBraces(text: string) {
  return text.replace(BRACE_BLOCK, (block, inner: string) => (isNameVariable(inner) ? block : inner));
}

export function withOptOut(closing: string) {
  const t = closing.trim();
  return t ? `${t}${/[.!?]$/.test(t) ? "" : "."} ${OPT_OUT_TEXT}` : OPT_OUT_TEXT;
}

// Texto como o motor monta: partes separadas por linha em branco (cada uma vira uma mensagem).
export function buildMessageText(greeting: string, body: string, closing: string) {
  return [greeting, body, closing].filter((t) => t.trim()).join("\n\n");
}

// Mesma divisão do envio (AdbManager::split_human_parts): linha em branco separa mensagens; quebra simples vira espaço.
export function splitHumanParts(message: string): string[] {
  const parts = message
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((p) => p.split(/\s+/).filter(Boolean).join(" "))
    .filter((p) => p !== "");
  return parts.length ? parts : message.trim() ? [message.trim()] : [];
}

export function messagePartCount(v: MessageValue) {
  return splitHumanParts(resolveFirst(buildMessageText(v.greeting, v.body, v.closing))).length;
}

export interface FieldIssue {
  text: string;
  fix?: "firstOption" | "stripBraces" | "optOut";
}
export type MessageIssues = Partial<Record<MessageField, FieldIssue>>;

// partLimit: teto da rede (o menor entre hora e dia). Mensagem com mais partes nunca caberia numa janela.
export function messageIssues(v: MessageValue, partLimit?: number): MessageIssues {
  const out: MessageIssues = {};
  const set = (f: MessageField, issue: FieldIssue) => {
    if (!out[f]) out[f] = issue;
  };
  if (!v.greeting.trim()) set("greeting", { text: "Preencha a saudação: a mensagem sai sempre em 3 partes." });
  if (!v.body.trim()) set("body", { text: "Escreva a mensagem que será enviada." });
  if (!v.closing.trim()) set("closing", { text: "Preencha o encerramento: a mensagem sai sempre em 3 partes." });
  for (const f of MESSAGE_FIELDS) {
    const text = v[f];
    if (!text.trim()) continue;
    const link = findLink(text);
    if (link)
      set(f, {
        text: `Remova “${link}”: a primeira mensagem para contatos novos não pode ter links nem e-mails (inclusive wa.me). Se não for link, coloque um espaço depois do ponto.`,
      });
    const money = findMoney(text);
    if (money) set(f, { text: `Não é permitido falar de valores: “${money}”. Tire a quantia e direcione o cliente ao canal de negociação.` });
    if (!v.useSpintax && SPIN_BLOCK.test(text))
      set(f, {
        text: "Há variações entre chaves, mas as variações automáticas estão desligadas: o contato receberia as chaves. Ative as variações ou fique com uma opção.",
        fix: "firstOption",
      });
    const unknown = unknownVariables(text);
    if (unknown.length)
      set(f, {
        text: `${unknown.join(", ")} sairia como texto: o sistema só preenche o nome do contato ({nome} ou o nome da coluna, como {NOME DEVEDOR}).`,
        fix: "stripBraces",
      });
    if (text.replace(/\r\n/g, "\n").split("\n\n").some((p) => p.length > WHATSAPP_LIMIT))
      set(f, { text: `Uma parte passa de ${formatNumber(WHATSAPP_LIMIT)} caracteres, o limite de uma mensagem do WhatsApp.` });
  }
  if (v.closing.trim() && !out.closing && !alwaysHas(v.closing, OPT_OUT_WORD))
    set("closing", { text: `Inclua a opção de descadastro em todas as variações, em texto neutro: “${OPT_OUT_TEXT}”`, fix: "optOut" });
  if (partLimit !== undefined && v.greeting.trim() && v.body.trim() && v.closing.trim()) {
    const n = messagePartCount(v);
    if (n > partLimit)
      set("body", {
        text: `A mensagem sai em ${n} partes e o teto da rede é de ${partLimit}: ela nunca caberia numa janela de envio. Junte parágrafos (tire linhas em branco) ou aumente o teto em Configurações.`,
      });
  }
  return out;
}

// Primeiro problema, com o nome do campo (para avisos fora do formulário).
export function messageError(v: MessageValue, partLimit?: number): string | undefined {
  const issues = messageIssues(v, partLimit);
  const f = MESSAGE_FIELDS.find((k) => issues[k]);
  return f ? `${FIELD_LABEL[f]}: ${issues[f]?.text}` : undefined;
}

// Junta saudação + corpo + encerramento numa linha (contagem e resumos).
export function joinMessage(greeting: string, body: string, closing: string) {
  let full = "";
  if (greeting.trim()) full += greeting + " ";
  full += body;
  if (closing.trim()) full += " " + closing;
  return full.trim();
}

// Teto da rede (Configurações → Rede e ritmo), lido uma vez por minuto no máximo.
export interface NetworkLimits {
  hourly: number;
  daily: number;
}
let networkLimitsCache: NetworkLimits | null = null;
let networkLimitsAt = 0;
let networkLimitsLoading: Promise<NetworkLimits | null> | null = null;

function loadNetworkLimits(): Promise<NetworkLimits | null> {
  if (networkLimitsCache && Date.now() - networkLimitsAt < 60_000) return Promise.resolve(networkLimitsCache);
  if (!networkLimitsLoading) {
    networkLimitsLoading = api<NetworkLimits>("get_network_limits")
      .then((v) => {
        networkLimitsCache = v && v.hourly > 0 && v.daily > 0 ? v : null;
        networkLimitsAt = Date.now();
        return networkLimitsCache;
      })
      .catch(() => null)
      .finally(() => {
        networkLimitsLoading = null;
      });
  }
  return networkLimitsLoading;
}

export function useNetworkLimits() {
  const [limits, setLimits] = useState<NetworkLimits | null>(networkLimitsCache);
  useEffect(() => {
    let alive = true;
    loadNetworkLimits().then((v) => {
      if (alive) setLimits(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return limits;
}

export const partLimitOf = (l: NetworkLimits | null) => (l ? Math.min(l.hourly, l.daily) : undefined);

// ---------- Aparelhos ----------
export const deviceKey = (d: Device) => d.esferaDeviceId || d.serial;
export const isDeviceOnline = (d: Device) => d.status === "online";
// Nome do aparelho é soberano: nunca gerar nome; usa o que existe.
export const deviceLabel = (d: Device) => d.name || d.model || d.serial;

export function sortDevices(devices: Device[]) {
  return [...devices].sort((a, b) => {
    const aOnline = isDeviceOnline(a) ? 1 : 0;
    const bOnline = isDeviceOnline(b) ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    const aNum = typeof a.deviceNumber === "number" ? a.deviceNumber : 9999;
    const bNum = typeof b.deviceNumber === "number" ? b.deviceNumber : 9999;
    if (aNum !== bNum) return aNum - bNum;
    return (a.name || a.model || "").localeCompare(b.name || b.model || "", undefined, { numeric: true });
  });
}

// ---------- IA ----------
export function ProviderOptions({ includeDefault }: { includeDefault?: boolean }) {
  return (
    <>
      {includeDefault && <option value="">Padrão da empresa</option>}
      <optgroup label="Servidor próprio">
        {AI_PROVIDERS.filter((p) => p.category === "own_server").map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </optgroup>
      <optgroup label="Nuvem gratuita">
        {AI_PROVIDERS.filter((p) => p.category === "cloud_free").map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </optgroup>
      <optgroup label="Local (offline)">
        {AI_PROVIDERS.filter((p) => p.category === "local_free").map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </optgroup>
      <optgroup label="Pagas e personalizadas">
        {AI_PROVIDERS.filter((p) => p.category === "paid_custom").map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </optgroup>
    </>
  );
}

// ---------- Peças visuais ----------
// Barra: enviados (accent/verde), falhas (vermelho) e pulados ou parciais (cinza). O resto está pendente.
export function ProgressBar({
  total,
  sent,
  failed,
  skipped = 0,
  size = "sm",
  completed,
}: {
  total: number;
  sent: number;
  failed: number;
  skipped?: number;
  size?: "sm" | "lg";
  completed?: boolean;
}) {
  const sentPct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  const failPct = total > 0 ? Math.min(100 - sentPct, (failed / total) * 100) : 0;
  const skipPct = total > 0 ? Math.min(100 - sentPct - failPct, (skipped / total) * 100) : 0;
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-secondary ${size === "lg" ? "h-2.5" : "h-1.5"}`}
      role="progressbar"
      aria-label="Contatos processados"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(sentPct + failPct + skipPct)}
    >
      <div
        className={`h-full transition-[width] duration-500 ${completed ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`}
        style={{ width: `${sentPct}%` }}
      />
      {failPct > 0 && <div className="h-full bg-red-500/80 transition-[width] duration-500" style={{ width: `${failPct}%` }} />}
      {skipPct > 0 && <div className="h-full bg-[var(--color-border-strong)] transition-[width] duration-500" style={{ width: `${skipPct}%` }} />}
    </div>
  );
}

export function InlineAlert({
  tone = "danger",
  title,
  children,
  icon,
  action,
  onDismiss,
}: {
  tone?: "danger" | "warning" | "info" | "success";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    danger: "border-red-500/25 bg-red-500/[0.07] text-red-500 dark:text-red-300",
    warning: "border-amber-500/25 bg-amber-500/[0.07] text-amber-600 dark:text-amber-300",
    info: "border-sky-500/25 bg-sky-500/[0.07] text-sky-600 dark:text-sky-300",
    success: "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-600 dark:text-emerald-300",
  } as const;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-start gap-3 rounded-lg border px-3.5 py-3 text-[0.8125rem] ${tones[tone]}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={`${title ? "mt-0.5" : ""} text-secondary`}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Fechar aviso" className="shrink-0 rounded-md p-0.5 text-tertiary hover:text-[var(--color-text-primary)] cursor-pointer">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className = "",
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={`relative flex items-center ${className}`}>
      <Search size={15} aria-hidden className="input-icon-left text-tertiary" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        className="input-with-icon-left !h-9"
      />
    </div>
  );
}

// ============================================================
// ActionMenu
// ============================================================

// Menu de "mais ações" (popover simples, fecha ao clicar fora ou Esc).

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

function ActionMenu({ actions, label = "Mais ações" }: { actions: MenuAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] cursor-pointer"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg animate-fade-in"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              type="button"
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-[0.8125rem] transition-colors disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer ${
                a.danger ? "text-red-500 hover:bg-red-500/10 dark:text-red-400" : "text-primary hover:bg-[var(--color-bg-hover)]"
              }`}
            >
              {a.icon && <span className={a.danger ? "" : "text-tertiary"}>{a.icon}</span>}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ConfirmDialog
// ============================================================

// Confirmação explícita para ações destrutivas.

function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  danger = true,
  loading = false,
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[0.8125rem] leading-relaxed text-secondary">{children}</div>
    </Modal>
  );
}

// ============================================================
// Stepper
// ============================================================

// Indicador de etapas do assistente de campanha.

export interface StepDef<T extends string> {
  id: T;
  label: string;
  optional?: boolean;
}

function Stepper<T extends string>({
  steps,
  current,
  reachable,
  onSelect,
  invalid = [],
}: {
  steps: StepDef<T>[];
  current: T;
  reachable: (id: T, index: number) => boolean;
  onSelect: (id: T) => void;
  invalid?: T[];
}) {
  const currentIndex = steps.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Etapas">
      {steps.map((s, i) => {
        const done = i < currentIndex;
        const active = s.id === current;
        const canGo = reachable(s.id, i);
        const hasError = invalid.includes(s.id);
        return (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1">
            <button
              type="button"
              disabled={!canGo}
              onClick={() => onSelect(s.id)}
              aria-current={active ? "step" : undefined}
              className={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors enabled:hover:bg-[var(--color-bg-hover)] disabled:cursor-default cursor-pointer`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.75rem] font-semibold tabular-nums ${
                  hasError
                    ? "border-red-500/50 bg-red-500/10 text-red-500 dark:text-red-400"
                    : active
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                    : done
                    ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-primary"
                    : "border-border bg-secondary text-tertiary"
                }`}
              >
                {done && !hasError ? <Check size={13} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-[0.8125rem] font-medium ${active ? "text-primary" : "text-secondary"}`}>{s.label}</span>
                {s.optional && <span className="block text-[0.6875rem] text-tertiary">Opcional</span>}
              </span>
            </button>
            {i < steps.length - 1 && <span className={`h-px min-w-3 flex-1 ${done ? "bg-[var(--color-border-accent)]" : "bg-[var(--color-border)]"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

// ============================================================
// WhatsAppPreview
// ============================================================

// Pré-visualização estilo conversa de WhatsApp: uma bolha por mensagem, como o contato recebe.

const SAMPLE_NAME = "Maria";

// Primeira opção de cada bloco: prévia estável enquanto o usuário digita.
function resolveFirst(text: string) {
  let out = text;
  let guard = 200;
  const re = /\{([^{}]*)\}/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) && guard-- > 0) {
    out = out.slice(0, m.index) + m[1].split("|")[0] + out.slice(m.index + m[0].length);
  }
  return out;
}

export function ChatBubble({ text, time, muted }: { text: string; time?: string; muted?: boolean }) {
  return (
    <div className="flex justify-end">
      <div
        className={`relative max-w-[92%] rounded-xl rounded-tr-sm border px-3 py-2 text-[0.8125rem] leading-relaxed shadow-sm ${
          muted ? "border-border bg-card text-tertiary italic" : "border-emerald-500/20 bg-emerald-500/[0.12] text-primary"
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>
        {!muted && (
          <span className="mt-1 flex items-center justify-end gap-1 text-[0.6875rem] text-tertiary">
            {time || "agora"}
            <CheckCheck size={13} className="text-sky-500" />
          </span>
        )}
      </div>
    </div>
  );
}

function WhatsAppPreview({
  greeting,
  body,
  closing,
  useSpintax,
  aiNote,
}: {
  greeting: string;
  body: string;
  closing: string;
  useSpintax: boolean;
  aiNote?: boolean;
}) {
  // Montada como o motor monta: partes separadas por linha em branco, cada uma vira uma mensagem.
  const full = buildMessageText(greeting, body, closing);
  const withName = fillSampleName(full, SAMPLE_NAME);
  const combos = useMemo(() => (useSpintax ? spintaxCombinations(withName) : 1), [useSpintax, withName]);
  const live = useSpintax ? resolveFirst(withName) : withName;

  const [variants, setVariants] = useState<string[]>([]);
  const [variantsFor, setVariantsFor] = useState("");
  const [index, setIndex] = useState(0);
  const [generating, setGenerating] = useState(false);
  const stale = variants.length > 0 && variantsFor !== withName;

  // Mesmo fluxo do "Simular Spintax" original: até 5 variações distintas via backend, com fallback local.
  const generate = async () => {
    setGenerating(true);
    const count = Math.min(5, combos);
    const seen = new Set<string>();
    const list: string[] = [];
    let guard = 0;
    while (list.length < count && guard++ < 200) {
      let v = resolveSpintaxLocal(withName);
      try {
        const resolved = await api<string>("resolve_spintax", { text: withName });
        if (resolved) v = resolved;
      } catch {
        /* fallback: resolução local */
      }
      if (!seen.has(v)) {
        seen.add(v);
        list.push(v);
      }
    }
    setVariants(list);
    setVariantsFor(withName);
    setIndex(0);
    setGenerating(false);
  };

  const showing = variants.length > 0 && !stale ? variants[index] : live;
  const parts = showing.trim() ? splitHumanParts(showing) : [];
  const chars = parts.reduce((n, p) => n + p.length, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-secondary">
      <div className="flex items-center gap-2.5 border-b border-border bg-card px-3.5 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-[0.75rem] font-semibold text-secondary">M</span>
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-medium text-primary">{SAMPLE_NAME}</p>
          <p className="text-[0.6875rem] text-tertiary">Pré-visualização</p>
        </div>
      </div>

      <div className="flex-1 space-y-1.5 p-3.5">
        {parts.length ? parts.map((p, i) => <ChatBubble key={i} text={p} />) : <ChatBubble text="Sua mensagem aparecerá aqui." muted />}
        {aiNote && (
          <p className="pt-1 text-center text-[0.75rem] text-tertiary">
            Com IA ativa, cada parte é reescrita por contato. As versões ficam prontas aos poucos; até lá, ou se a IA falhar, sai este texto com as variações.
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-border bg-card px-3.5 py-3">
        <div className="flex items-center justify-between gap-2 text-[0.75rem] text-secondary">
          <span className="tabular-nums" title="Cada parte é uma mensagem do WhatsApp e conta uma vez no teto da rede.">
            {parts.length
              ? `${parts.length} ${parts.length === 1 ? "mensagem" : "mensagens seguidas"} · ${formatNumber(chars)} caracteres`
              : "0 caracteres"}
          </span>
          {useSpintax && (
            <span className="tabular-nums">
              {combos > 1 ? `${combos >= 1_000_000_000 ? "+1 bi" : formatNumber(combos)} variações possíveis` : "Sem variações"}
            </span>
          )}
        </div>
        {parts.length > 3 && (
          <p className="text-[0.75rem] text-amber-700 dark:text-amber-300">
            Linhas em branco no corpo viram mensagens separadas: cada contato gasta {parts.length} do teto da rede em vez de 3.
          </p>
        )}
        {useSpintax && (
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="secondary" icon={<Shuffle size={13} />} onClick={generate} loading={generating} disabled={!full}>
              {variants.length && !stale ? "Gerar outras" : "Gerar variações"}
            </Button>
            {variants.length > 1 && !stale && (
              <div className="flex items-center gap-1 text-[0.75rem] tabular-nums text-secondary">
                <button
                  type="button"
                  aria-label="Variação anterior"
                  onClick={() => setIndex((i) => (i - 1 + variants.length) % variants.length)}
                  className="rounded-md p-1 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
                >
                  <ChevronLeft size={14} />
                </button>
                {index + 1} de {variants.length}
                <button
                  type="button"
                  aria-label="Próxima variação"
                  onClick={() => setIndex((i) => (i + 1) % variants.length)}
                  className="rounded-md p-1 hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        )}
        {stale && <p className="text-[0.75rem] text-tertiary">O texto mudou. Gere as variações de novo.</p>}
      </div>
    </div>
  );
}

// ============================================================
// AiFields
// ============================================================

// Configuração de IA por campanha (provedor, modelo, instrução) + teste de reescrita.

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

// Partes como o motor manda para a IA: nome vira {nome}, variações resolvidas, linha em branco separa.
function aiTestParts(m: MessageValue) {
  const full = buildMessageText(m.greeting, m.body, m.closing).replace(BRACE_BLOCK, (block, inner: string) => (isNameVariable(inner) ? "{nome}" : block));
  const mark = "\u0001NOME\u0001";
  const resolved = m.useSpintax ? resolveSpintaxLocal(full.split("{nome}").join(mark)).split(mark).join("{nome}") : full;
  return resolved
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

type TestPart = { text?: string; error?: string; lostName?: boolean };

function AiFields({
  value,
  onChange,
  companyId,
  message,
}: {
  value: AiValue;
  onChange: (patch: Partial<AiValue>) => void;
  companyId: number | null;
  message: MessageValue;
}) {
  const uid = useId();
  const [testing, setTesting] = useState(false);
  // "Parar" só esconde a resposta: o pedido continua na IA até terminar. Até lá o próximo teste espera.
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [result, setResult] = useState<TestPart[] | null>(null);
  const [testError, setTestError] = useState("");
  // Cada teste ganha um número; "Parar" troca o número e a resposta atrasada é descartada.
  const testRun = useRef(0);

  const stopTest = () => {
    testRun.current += 1;
    setTesting(false);
    setStopping(true);
    setStopped(true);
  };

  const handleTest = async () => {
    setStopped(false);
    setTestError("");
    if (!message.body.trim()) {
      setResult(null);
      setTestError("Escreva a mensagem antes de testar a reescrita com IA.");
      return;
    }
    const parts = aiTestParts(message);
    const run = ++testRun.current;
    setTesting(true);
    setResult(null);
    const settled = await Promise.allSettled(
      parts.map((part) =>
        api<string>("rewrite_message_ai", {
          message: part,
          contactName: "{nome}",
          companyId,
          model: value.aiModel,
          prompt: value.aiPrompt,
          provider: value.aiProvider,
        })
      )
    );
    if (run !== testRun.current) {
      setStopping(false);
      return;
    }
    setResult(
      settled.map((s, i) =>
        s.status === "fulfilled"
          ? { text: s.value.split(/\s+/).filter(Boolean).join(" "), lostName: parts[i].includes("{nome}") && !s.value.includes("{nome}") }
          : { error: String(s.reason) }
      )
    );
    setTesting(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-medium text-primary">Reescrever mensagens com IA</p>
          <p className="text-[0.75rem] text-tertiary">
            A IA reescreve cada parte da mensagem com outras palavras para cada contato, o que reduz o risco de bloqueio por spam. As versões ficam
            prontas aos poucos; até lá, ou se a IA falhar, sai o texto com as variações.
          </p>
        </div>
        <Toggle checked={value.useAI} onChange={(v) => onChange({ useAI: v })} />
      </div>

      {value.useAI && (
        <div className="space-y-4 animate-fade-in">
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Provedor"
              htmlFor={`${uid}-provider`}
              hint="Use o padrão da empresa ou escolha um para esta campanha. No disparo, se ele falhar, o sistema tenta os outros provedores com chave salva."
            >
              <select
                id={`${uid}-provider`}
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
            <Field label="Modelo" htmlFor={`${uid}-model`} hint={value.aiProvider ? undefined : "Vazio usa o modelo padrão da empresa."}>
              <input
                id={`${uid}-model`}
                type="text"
                value={value.aiModel}
                onChange={(e) => onChange({ aiModel: e.target.value })}
                placeholder="openai/gpt-oss-120b"
                className="font-mono"
              />
            </Field>
          </div>
          <ModelSuggestions provider={value.aiProvider} model={value.aiModel} onPick={(id) => onChange({ aiModel: id })} />

          <Field
            label="Instrução para a IA"
            htmlFor={`${uid}-prompt`}
            hint="Opcional. Substitui a instrução padrão da empresa nesta campanha; as regras fixas (sem valores, CDC e LGPD) continuam valendo."
          >
            <textarea
              id={`${uid}-prompt`}
              rows={3}
              value={value.aiPrompt}
              onChange={(e) => onChange({ aiPrompt: e.target.value })}
              placeholder="Ex.: tom cordial e direto, frases curtas, sem gírias."
              className="resize-y"
            />
          </Field>

          <div className="space-y-3 rounded-lg border border-border bg-[var(--color-bg-hover)] p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[0.8125rem] font-medium text-primary">Testar reescrita</p>
                <p className="text-[0.75rem] text-tertiary">
                  Reescreve cada parte separadamente, como no disparo, para o contato de exemplo “{SAMPLE_NAME}”. O teste usa só o provedor escolhido.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="sm" variant="secondary" icon={<Sparkles size={13} />} onClick={handleTest} loading={testing} disabled={stopping}>
                  {testing ? "Gerando…" : stopping ? "Encerrando…" : "Testar"}
                </Button>
                {testing && (
                  <Button size="sm" variant="ghost" onClick={stopTest}>
                    Parar
                  </Button>
                )}
              </div>
            </div>
            {stopped && !testing && (
              <p className="text-[0.75rem] text-tertiary">
                Teste interrompido.{stopping ? " O pedido ainda está terminando na IA; o próximo teste fica liberado em seguida." : ""}
              </p>
            )}
            {testError && (
              <InlineAlert tone="warning" icon={<AlertTriangle size={15} />}>
                {testError}
              </InlineAlert>
            )}
            {result && (
              <div className="space-y-1.5">
                {result.map((r, i) =>
                  r.error ? (
                    <InlineAlert key={i} tone="danger" icon={<AlertCircle size={15} />} title={`Parte ${i + 1}: não foi possível gerar`}>
                      <span className="break-words font-mono text-[0.75rem]">{r.error}</span>
                    </InlineAlert>
                  ) : (
                    <div key={i}>
                      <ChatBubble text={(r.text || "").split("{nome}").join(SAMPLE_NAME)} />
                      {r.lostName && (
                        <p className="mt-1 text-right text-[0.6875rem] text-amber-700 dark:text-amber-300">
                          A IA tirou o nome do contato desta parte; no disparo, esta versão seria descartada.
                        </p>
                      )}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// MessageFields
// ============================================================

// Campos de mensagem (saudação / corpo / encerramento) com spintax, ajuda e correções de um clique.

function Counter({ value, limit }: { value: number; limit?: number }) {
  const over = limit && value > limit;
  return <span className={`tabular-nums ${over ? "text-red-500 dark:text-red-400" : ""}`}>{limit ? `${value} / ${limit}` : value}</span>;
}

const FIX_LABEL: Record<NonNullable<FieldIssue["fix"]>, string> = {
  firstOption: "Ficar com a 1ª opção de cada bloco",
  stripBraces: "Tirar as chaves",
  optOut: "Inserir texto padrão",
};

function MessageFields({
  value,
  onChange,
  showErrors = true,
  partLimit,
}: {
  value: MessageValue;
  onChange: (patch: Partial<MessageValue>) => void;
  /** false: esconde só os avisos de campo vazio (aparecem ao tentar avançar). */
  showErrors?: boolean;
  partLimit?: number;
}) {
  const uid = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const greetingRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const closingRef = useRef<HTMLInputElement>(null);
  const lastField = useRef<MessageField>("body");
  const issues = messageIssues(value, partLimit);
  const shown = (f: MessageField) => (showErrors || value[f].trim() ? issues[f] : undefined);

  // Insere {nome} no campo em que o operador estava (a saudação é o lugar mais comum).
  const insertName = () => {
    const f = lastField.current;
    const el = f === "greeting" ? greetingRef.current : f === "closing" ? closingRef.current : bodyRef.current;
    const token = "{nome}";
    const text = value[f];
    if (!el) {
      onChange({ [f]: text + token } as Partial<MessageValue>);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    onChange({ [f]: text.slice(0, start) + token + text.slice(end) } as Partial<MessageValue>);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const applyFix = (f: MessageField, fix: NonNullable<FieldIssue["fix"]>) => {
    const text = value[f];
    const next = fix === "firstOption" ? fixFirstOption(text) : fix === "stripBraces" ? stripUnknownBraces(text) : withOptOut(text);
    onChange({ [f]: next } as Partial<MessageValue>);
  };

  const errorNode = (f: MessageField) => {
    const issue = shown(f);
    if (!issue) return undefined;
    const fix = issue.fix;
    return (
      <>
        {issue.text}
        {fix && (
          <>
            {" "}
            <button type="button" onClick={() => applyFix(f, fix)} className="font-medium text-[var(--color-accent-light)] underline-offset-2 hover:underline cursor-pointer">
              {FIX_LABEL[fix]}
            </button>
          </>
        )}
      </>
    );
  };

  const bodyParts = value.body.replace(/\r\n/g, "\n").split("\n\n").filter((p) => p.trim()).length;

  return (
    <div className="space-y-4">
      <Field
        label="Saudação"
        htmlFor={`${uid}-greeting`}
        required
        error={errorNode("greeting")}
        aside={<Counter value={value.greeting.length} />}
        hint="1ª mensagem, antes do corpo."
      >
        <input
          id={`${uid}-greeting`}
          ref={greetingRef}
          type="text"
          value={value.greeting}
          onFocus={() => (lastField.current = "greeting")}
          onChange={(e) => onChange({ greeting: e.target.value })}
          placeholder="{Olá|Oi|Bom dia} {nome}, tudo bem?"
          aria-invalid={Boolean(shown("greeting"))}
        />
      </Field>

      <Field
        label="Mensagem"
        htmlFor={`${uid}-body`}
        required
        error={errorNode("body")}
        aside={
          <span className="tabular-nums">
            {bodyParts > 1 ? `${bodyParts} mensagens · ` : ""}
            <Counter value={value.body.length} />
          </span>
        }
        hint="Sem links nem e-mails na primeira mensagem para contatos novos. Não cite valores (R$, reais, %, quantias): a mensagem é bloqueada. Linha em branco separa mensagens."
      >
        <textarea
          id={`${uid}-body`}
          ref={bodyRef}
          rows={6}
          value={value.body}
          onFocus={() => (lastField.current = "body")}
          onChange={(e) => onChange({ body: e.target.value })}
          placeholder="Identificamos uma {pendência|condição especial} no seu cadastro. Podemos conversar sobre a melhor forma de regularizar?"
          className="resize-y"
          aria-invalid={Boolean(shown("body"))}
        />
      </Field>
      <div className="-mt-2">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={insertName}
          title="Insere {nome} no campo em que você está escrevendo"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[0.75rem] text-secondary transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] cursor-pointer"
        >
          <UserRound size={12} /> Inserir nome do contato
        </button>
      </div>

      <Field
        label="Encerramento"
        htmlFor={`${uid}-closing`}
        required
        error={errorNode("closing")}
        aside={<Counter value={value.closing.length} />}
        hint={`Assinatura e a opção de descadastro, em texto neutro: “${OPT_OUT_TEXT}” Nunca associe o SAIR a reconhecimento de dívida ou renúncia a contestação.`}
      >
        <input
          id={`${uid}-closing`}
          ref={closingRef}
          type="text"
          value={value.closing}
          onFocus={() => (lastField.current = "closing")}
          onChange={(e) => onChange({ closing: e.target.value })}
          placeholder={`Atenciosamente, {Equipe REALESS|Setor Financeiro}. ${OPT_OUT_TEXT}`}
          aria-invalid={Boolean(shown("closing"))}
        />
      </Field>

      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-[0.8125rem] font-medium text-primary">Variações automáticas (spintax)</p>
            <p className="text-[0.75rem] text-tertiary">Cada contato recebe uma combinação diferente do texto. Desligadas, as chaves sairiam no texto.</p>
          </div>
          <Toggle size="sm" checked={value.useSpintax} onChange={(v) => onChange({ useSpintax: v })} />
        </div>
        <button
          type="button"
          onClick={() => setHelpOpen((v) => !v)}
          aria-expanded={helpOpen}
          className="flex w-full items-center justify-between border-t border-border px-3.5 py-2 text-[0.75rem] text-secondary hover:text-[var(--color-text-primary)] cursor-pointer"
        >
          Como escrever variações
          <ChevronDown size={14} className={`transition-transform ${helpOpen ? "rotate-180" : ""}`} />
        </button>
        {helpOpen && (
          <div className="space-y-2 border-t border-border px-3.5 py-3 text-[0.75rem] text-secondary">
            <p>
              Coloque as opções entre chaves, separadas por barra: <code className="rounded bg-secondary px-1 py-0.5 font-mono text-primary">{"{Olá|Oi|Bom dia}"}</code>. Uma delas
              é sorteada a cada envio.
            </p>
            <p>
              Use <code className="rounded bg-secondary px-1 py-0.5 font-mono text-primary">{"{nome}"}</code> para o nome do contato. Também vale o
              nome da coluna da planilha, como <code className="rounded bg-secondary px-1 py-0.5 font-mono text-primary">{"{NOME DEVEDOR}"}</code>.
              Outras chaves sem barra não são preenchidas.
            </p>
            <p>Dá para combinar blocos: quanto mais opções, mais natural fica o disparo e menor o risco de bloqueio.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// DelayFields
// ============================================================

// Intervalo entre mensagens, com o ritmo real: intervalo, teto da rede, limite dos chips e janela de envio.

// Janela de envio (igual ao motor): seg–sex 8h–20h, sáb 8h–14h, domingo não.
function sendWindowOf(d: Date): [number, number] | null {
  const wd = d.getDay();
  if (wd === 0) return null;
  return wd === 6 ? [8, 14] : [8, 20];
}

export function withinSendWindow(now = new Date()) {
  const w = sendWindowOf(now);
  const h = now.getHours();
  return Boolean(w) && h >= (w as [number, number])[0] && h < (w as [number, number])[1];
}

// Próxima abertura da janela (ou agora, se já está aberta).
export function nextWindowOpen(now = new Date()): Date {
  for (let i = 0; i < 8; i++) {
    const day = new Date(now);
    day.setDate(now.getDate() + i);
    const w = sendWindowOf(day);
    if (!w) continue;
    const open = new Date(day);
    open.setHours(w[0], 0, 0, 0);
    const close = new Date(day);
    close.setHours(w[1], 0, 0, 0);
    if (now < open) return open;
    if (now < close) return now;
  }
  return now;
}

const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

// "hoje 15:00", "amanhã 08:00", "seg 08:00" ou "12/11 08:00".
export function formatWhen(d: Date, now = new Date()) {
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayD = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((dayD - day0) / 86_400_000);
  if (diff <= 0) return `hoje ${time}`;
  if (diff === 1) return `amanhã ${time}`;
  if (diff < 7) return `${WEEKDAY[d.getDay()]} ${time}`;
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${time}`;
}

// Limites padrão de cada chip no motor (ESF_ChipAttempt): 10 tentativas por hora e até 60 por dia, menos
// nos primeiros dias (aquecimento: 15 no dia do cadastro, +5 por dia).
const CHIP_HOURLY = 10;
const CHIP_DAILY = 60;

export interface PaceEstimate {
  perHour: number;
  perDay: number;
  limit: "intervalo" | "teto" | "chips";
  finish: Date | null;
}

// Ritmo real de UMA campanha: um contato por vez (o motor não envia em paralelo por aparelhos), com a
// pausa sorteada entre o mínimo e max(máximo, 2× mínimo), o teto da rede contado por parte e o limite dos chips.
export function estimatePace(o: {
  pending: number;
  delayMin: number;
  delayMax: number;
  parts: number;
  devices: number;
  limits: NetworkLimits | null;
  observedCycleSec?: number;
  now?: Date;
}): PaceEstimate | null {
  if (!(o.delayMin > 0) || !(o.delayMax > 0)) return null;
  const low = Math.max(1, o.delayMin);
  const high = Math.max(o.delayMax, low * 2);
  // + ~20 s por contato para preparar e digitar tecla a tecla (estimativa).
  const cycle = o.observedCycleSec && o.observedCycleSec > 0 ? o.observedCycleSec : (low + high) / 2 + 20;
  const parts = Math.max(1, o.parts);
  const byInterval = 3600 / cycle;
  const byCap = o.limits ? o.limits.hourly / parts : Infinity;
  const byChips = o.devices > 0 ? CHIP_HOURLY * o.devices : Infinity;
  const perHour = Math.max(0.1, Math.min(byInterval, byCap, byChips));
  const limit: PaceEstimate["limit"] = perHour === byCap ? "teto" : perHour === byChips ? "chips" : "intervalo";
  const perDay = Math.min(o.limits ? o.limits.daily / parts : Infinity, o.devices > 0 ? CHIP_DAILY * o.devices : Infinity);
  // Término: percorre os dias com janela aberta, respeitando o ritmo por hora e o teto do dia.
  let finish: Date | null = null;
  if (o.pending > 0) {
    const now = o.now ?? new Date();
    let left = o.pending;
    for (let day = 0; day < 180 && !finish; day++) {
      const d = new Date(now);
      d.setDate(now.getDate() + day);
      const w = sendWindowOf(d);
      if (!w) continue;
      const open = new Date(d);
      open.setHours(w[0], 0, 0, 0);
      const close = new Date(d);
      close.setHours(w[1], 0, 0, 0);
      const start = day === 0 ? new Date(Math.max(now.getTime(), open.getTime())) : open;
      if (start >= close) continue;
      const capacity = Math.min(perHour * ((close.getTime() - start.getTime()) / 3_600_000), perDay);
      if (left <= capacity) finish = new Date(start.getTime() + (left / perHour) * 3_600_000);
      else left -= capacity;
    }
  }
  return { perHour, perDay, limit, finish };
}

export function paceLimitText(p: PaceEstimate, limits: NetworkLimits | null, parts: number) {
  if (p.limit === "teto" && limits) return `limitado pelo teto da rede (${limits.hourly} mensagens por hora, ${parts} por contato)`;
  if (p.limit === "chips") return `limitado pelo limite de cada chip (${CHIP_HOURLY} por hora)`;
  return "limitado pelo intervalo configurado";
}

const perHourText = (n: number) => (n >= 10 ? formatNumber(Math.round(n)) : n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));

// Abaixo de 15 s o chip bate o limite por hora em minutos e a campanha pausa.
export const MIN_DELAY = 15;

export function delayError(min: number, max: number): string | undefined {
  if (!min || min < MIN_DELAY) return `O intervalo mínimo é de ${MIN_DELAY} segundos: abaixo disso o chip bate o limite por hora em minutos e a campanha pausa.`;
  if (max < min) return "O intervalo máximo não pode ser menor que o mínimo.";
  return undefined;
}

const PRESETS = [
  { label: "Cauteloso", min: 60, max: 180, title: "Menor risco de bloqueio" },
  { label: "Equilibrado", min: 30, max: 90, title: "Recomendado" },
  { label: "Rápido", min: 15, max: 45, title: "Maior risco de bloqueio: use com chips aquecidos" },
];

function DelayFields({
  min,
  max,
  onChange,
  pendingContacts,
  parts = 3,
  devices = 0,
}: {
  min: number;
  max: number;
  onChange: (patch: { delayMin?: number; delayMax?: number }) => void;
  pendingContacts?: number;
  /** Mensagens por contato (cada parte conta no teto da rede). */
  parts?: number;
  /** Aparelhos selecionados (cada chip tem limite por hora). */
  devices?: number;
}) {
  const uid = useId();
  const limits = useNetworkLimits();
  const err = delayError(min, max);
  const high = Math.max(max, min * 2);
  const pace = err ? null : estimatePace({ pending: pendingContacts ?? 0, delayMin: min, delayMax: max, parts, devices, limits });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const active = p.min === min && p.max === max;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={active}
              title={p.title}
              onClick={() => onChange({ delayMin: p.min, delayMax: p.max })}
              className={`rounded-lg border px-3 py-1.5 text-[0.8125rem] transition-colors cursor-pointer ${
                active
                  ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-primary"
                  : "border-border text-secondary hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
              }`}
            >
              {p.label} <span className="text-tertiary tabular-nums">{p.min}–{p.max}s</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Mínimo (segundos)" htmlFor={`${uid}-min`}>
          <input
            id={`${uid}-min`}
            type="number"
            min={MIN_DELAY}
            value={min || ""}
            onChange={(e) => onChange({ delayMin: parseInt(e.target.value, 10) || 0 })}
            className="tabular-nums"
            aria-invalid={Boolean(err)}
          />
        </Field>
        <Field label="Máximo (segundos)" htmlFor={`${uid}-max`}>
          <input
            id={`${uid}-max`}
            type="number"
            min={MIN_DELAY}
            value={max || ""}
            onChange={(e) => onChange({ delayMax: parseInt(e.target.value, 10) || 0 })}
            className="tabular-nums"
            aria-invalid={Boolean(err)}
          />
        </Field>
      </div>

      {err ? (
        <p className="text-[0.75rem] text-red-600 dark:text-red-400">{err}</p>
      ) : (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-[var(--color-bg-hover)] px-3.5 py-3 text-[0.8125rem] text-secondary">
          <Clock size={15} className="mt-0.5 shrink-0 text-tertiary" />
          <div className="space-y-1">
            <p>
              Cada contato sai entre <strong className="text-primary">{min}s</strong> e <strong className="text-primary">{high}s</strong> depois do anterior,
              em intervalos aleatórios{high !== max ? ` (o motor usa no mínimo o dobro do mínimo como máximo)` : ""}, um contato por vez.
            </p>
            {pace && (
              <p>
                Na prática, cerca de <strong className="text-primary tabular-nums">{perHourText(pace.perHour)}</strong> contatos por hora,{" "}
                {paceLimitText(pace, limits, parts)}
                {pendingContacts && pace.finish ? (
                  <>
                    . Os {formatNumber(pendingContacts)} pendentes terminam por volta de <strong className="text-primary">{formatWhen(pace.finish)}</strong>, só no horário de envio
                  </>
                ) : null}
                .
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// DevicePicker
// ============================================================

// Seleção de aparelhos autorizados para a campanha.

type DeviceFilter = "all" | "online" | "selected";

export function deviceSelectionStats(devices: Device[], selected: string[]) {
  const selectedOnline = devices.filter((d) => selected.includes(deviceKey(d)) && isDeviceOnline(d)).length;
  const totalOnline = devices.filter(isDeviceOnline).length;
  return { selectedCount: selected.length, selectedOnline, totalOnline };
}

function DevicePicker({
  devices,
  loading,
  selected,
  onChange,
  onRefresh,
  refreshing,
  listClassName = "max-h-[420px]",
}: {
  devices: Device[];
  loading?: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  listClassName?: string;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<DeviceFilter>("all");

  const sorted = useMemo(() => sortDevices(devices), [devices]);
  const { selectedCount, selectedOnline, totalOnline } = deviceSelectionStats(devices, selected);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return sorted.filter((d) => {
      const key = deviceKey(d);
      if (filter === "online" && !isDeviceOnline(d)) return false;
      if (filter === "selected" && !selected.includes(key)) return false;
      if (!q) return true;
      return (
        (d.name || "").toLowerCase().includes(q) ||
        (d.model || "").toLowerCase().includes(q) ||
        (d.brand || "").toLowerCase().includes(q) ||
        String(d.deviceNumber ?? "").includes(q) ||
        (d.sector || "").toLowerCase().includes(q)
      );
    });
  }, [sorted, filter, search, selected]);

  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter((id) => id !== key) : [...selected, key]);
  const selectOnline = () => onChange(devices.filter(isDeviceOnline).map(deviceKey));
  const selectAll = () => onChange(devices.map(deviceKey));
  const clear = () => onChange([]);

  // Seleciona/desmarca só os itens visíveis no filtro atual.
  const visibleKeys = filtered.map(deviceKey);
  const allVisibleSelected = visibleKeys.length > 0 && visibleKeys.every((k) => selected.includes(k));
  const toggleVisible = () =>
    onChange(allVisibleSelected ? selected.filter((k) => !visibleKeys.includes(k)) : Array.from(new Set([...selected, ...visibleKeys])));

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-14 rounded-lg" />
        ))}
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <EmptyState
        icon={<Smartphone size={18} />}
        title="Nenhum aparelho cadastrado"
        description="Conecte celulares na aba Dispositivos para poder usá-los nos disparos."
        action={onRefresh && <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onRefresh} loading={refreshing}>Atualizar lista</Button>}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome, número ou setor" className="lg:w-72" />
        <SegmentedControl<DeviceFilter>
          value={filter}
          onChange={setFilter}
          items={[
            { id: "all", label: "Todos", count: devices.length },
            { id: "online", label: "Online", count: totalOnline },
            { id: "selected", label: "Selecionados", count: selectedCount },
          ]}
        />
        <div className="flex flex-wrap items-center gap-1.5 lg:ml-auto">
          <Button size="sm" variant="secondary" onClick={selectOnline} disabled={totalOnline === 0} title="Seleciona apenas os aparelhos online agora">
            Selecionar online
          </Button>
          <Button size="sm" variant="ghost" onClick={selectAll}>
            Todos
          </Button>
          <Button size="sm" variant="ghost" onClick={clear} disabled={selectedCount === 0}>
            Limpar
          </Button>
          {onRefresh && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Atualizar status dos aparelhos"
              title="Atualizar status"
              icon={<RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />}
            />
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Smartphone size={18} />}
          title="Nenhum aparelho encontrado"
          description={
            search
              ? `Nada corresponde a "${search}".`
              : filter === "online"
              ? "Nenhum aparelho está online no momento."
              : "Nenhum aparelho selecionado ainda."
          }
          className="py-8"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-3 border-b border-border bg-secondary px-3 py-2 text-[0.75rem] text-secondary">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleVisible}
              aria-label={allVisibleSelected ? "Desmarcar visíveis" : "Marcar visíveis"}
              className="h-4 w-4 shrink-0"
            />
            <span>
              {filtered.length} {filtered.length === 1 ? "aparelho" : "aparelhos"}
              {filter !== "all" || search ? " no filtro" : ""}
            </span>
          </div>
          <ul className={`divide-y divide-[var(--color-border)] overflow-y-auto custom-scrollbar ${listClassName}`}>
            {filtered.map((d) => {
              const key = deviceKey(d);
              const isSel = selected.includes(key);
              const online = isDeviceOnline(d);
              const name = deviceLabel(d);
              return (
                <li key={key}>
                  <label
                    className={`!mb-0 flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors ${
                      isSel ? "bg-[var(--color-accent-glow)]" : "hover:bg-[var(--color-bg-hover)]"
                    }`}
                  >
                    <input type="checkbox" checked={isSel} onChange={() => toggle(key)} className="h-4 w-4 shrink-0" />
                    <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[0.8125rem] font-medium text-primary" title={name}>{name}</span>
                        {d.deviceNumber ? <span className="shrink-0 rounded bg-secondary px-1.5 text-[0.6875rem] tabular-nums text-secondary">#{d.deviceNumber}</span> : null}
                      </span>
                      <span className="block truncate text-[0.75rem] text-tertiary">
                        {d.brand ? `${d.brand} ${d.model}` : d.model}
                        {d.sector ? ` · ${d.sector}` : ""}
                      </span>
                    </span>
                    {typeof d.battery === "number" && d.battery > 0 && (
                      <span className={`hidden items-center gap-1 text-[0.75rem] tabular-nums sm:flex ${d.battery <= 20 ? "text-red-500 dark:text-red-400" : "text-tertiary"}`}>
                        <Battery size={13} /> {d.battery}%
                      </span>
                    )}
                    <span className={`w-14 shrink-0 text-right text-[0.75rem] ${online ? "text-emerald-600 dark:text-emerald-400" : "text-tertiary"}`}>
                      {online ? "Online" : "Offline"}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {selectedCount > 0 && selectedOnline === 0 && (
        <InlineAlert tone="warning" icon={<AlertTriangle size={15} />} title="Nenhum aparelho selecionado está online agora">
          Você pode salvar normalmente. Para iniciar o disparo, ao menos um dos aparelhos marcados precisa estar online.
        </InlineAlert>
      )}
    </div>
  );
}

// ============================================================
// LogConsole e estado ao vivo
// ============================================================

// Console de eventos do disparo e o estado atual de cada campanha (enviando, fora do horário, teto da
// rede, ritmo reduzido, pausada pelo sistema...). Fica no módulo: não some ao trocar de aba do app.

export type LogLevel = "info" | "success" | "warning" | "error";

export interface LogLine {
  id: number;
  /** Hora legível da última ocorrência. */
  time: string;
  /** Quando chegou (ms), para medir o ritmo real. */
  at: number;
  level: LogLevel;
  text: string;
  delayMs?: number;
  /** Mesma linha repetida em seguida (ex.: "Fora do horário" a cada minuto). */
  count?: number;
}

const levelStyle: Record<LogLevel, { dot: string; label: string }> = {
  info: { dot: "bg-sky-500", label: "Info" },
  success: { dot: "bg-emerald-500", label: "OK" },
  warning: { dot: "bg-amber-500", label: "Aviso" },
  error: { dot: "bg-red-500", label: "Erro" },
};

export interface ProgressPayload {
  campaign_id: number;
  campaign_name?: string;
  sent_count?: number;
  total_contacts?: number;
  last_contact_phone?: string;
  delay_used_ms?: number;
  status: string;
}

export type LiveKind =
  | "sending"
  | "send_error"
  | "completed"
  | "window"
  | "network_turn"
  | "network_cap"
  | "network_check"
  | "parts_over"
  | "device_wait"
  | "device_unavailable"
  | "chip_rest"
  | "reply_reduced"
  | "reply_paused"
  | "reply_unavailable"
  | "auto_paused"
  | "ai_warning";

export type LiveTone = "success" | "warning" | "danger" | "info";

export interface LiveState {
  kind: LiveKind;
  /** Texto curto (selo da lista e do cabeçalho). */
  short: string;
  /** Explicação para o banner do detalhe. */
  text: string;
  tone: LiveTone;
  at: number;
}

// Estado principal de uma campanha em andamento: vale o último que chegou. O motor avisa a espera só quando
// ela muda (não repete a cada ciclo) e um envio feito encerra a espera, então o último evento é o atual.
const LIVE_MAIN: LiveKind[] = [
  "sending",
  "send_error",
  "window",
  "network_turn",
  "network_cap",
  "network_check",
  "parts_over",
  "device_wait",
  "device_unavailable",
  "chip_rest",
];
// Avisos de aparelho/chip que valem junto com o estado principal (a campanha segue pelos outros aparelhos).
const LIVE_NOTES: LiveKind[] = ["reply_paused", "reply_reduced", "reply_unavailable", "ai_warning"];
// Validade de cada estado sem evento novo. As esperas duram até o próximo envio (teto da rede pode levar
// uma hora); os avisos de chip voltam a cada tentativa.
const LIVE_TTL: Partial<Record<LiveKind, number>> = {
  sending: 30 * 60_000,
  send_error: 30 * 60_000,
  window: 6 * 3_600_000,
  network_turn: 6 * 3_600_000,
  network_cap: 6 * 3_600_000,
  network_check: 6 * 3_600_000,
  parts_over: 6 * 3_600_000,
  device_wait: 6 * 3_600_000,
  device_unavailable: 6 * 3_600_000,
  chip_rest: 6 * 3_600_000,
  reply_paused: 20 * 60_000,
  reply_reduced: 20 * 60_000,
  reply_unavailable: 60 * 60_000,
  ai_warning: 20 * 60_000,
};

const stripCode = (s: string) => s.replace(/^(TRAVA|REDE|APARELHO|CONTA_RESTRITA|RITMO|CANCELADO):\s*/i, "").trim();

// Motivo de pausa automática em linguagem de operador, com o que fazer.
function pauseReasonText(raw: string) {
  const r = raw.trim();
  const base = stripCode(r);
  if (/^CONTA_RESTRITA/i.test(r))
    return `o WhatsApp de um dos aparelhos indica conta restrita ou banida (${base}). Confira os aparelhos e tire o afetado da campanha antes de retomar.`;
  if (/limite do chip/i.test(r)) return `${base} Retome mais tarde ou inclua mais aparelhos.`;
  if (/freio autom/i.test(r)) return `${base} Revise a lista e a mensagem antes de retomar.`;
  if (/chip/i.test(r)) return `${base} Ajuste os chips em Dispositivos antes de retomar.`;
  return base;
}

// Traduz o evento do motor de disparo para uma linha do console e o estado ao vivo da campanha.
export function describeProgress(p: ProgressPayload): { level: LogLevel; text: string; live?: Omit<LiveState, "at"> } {
  const phone = p.last_contact_phone ? ` ${formatPhoneBr(p.last_contact_phone)}` : "";
  const status = (p.status || "").trim();
  switch (status) {
    case "running": {
      const pause = p.delay_used_ms ? ` · intervalo de ~${Math.round(p.delay_used_ms / 1000)}s` : "";
      return {
        level: "success",
        text: `Mensagem enviada para${phone || " o contato"}${pause}`,
        live: { kind: "sending", short: "Enviando", text: "As mensagens estão saindo pelos aparelhos selecionados, uma de cada vez.", tone: "success" },
      };
    }
    case "send_error":
      return {
        level: "error",
        text: `Falha ao enviar para${phone || " o contato"}.`,
        live: { kind: "send_error", short: "Falha no último envio", text: "O último envio falhou. O motor segue com os próximos contatos.", tone: "warning" },
      };
    case "waiting_device":
      return {
        level: "warning",
        text: "Nenhum aparelho disponível agora (offline, em descanso do chip ou pausado). O disparo continua quando um deles liberar.",
        live: {
          kind: "device_wait",
          short: "Aguardando aparelho",
          text: "Nenhum aparelho selecionado está disponível agora: pode estar offline, em descanso do chip ou pausado. O disparo continua sozinho quando um deles liberar.",
          tone: "warning",
        },
      };
    case "completed":
      return {
        level: "success",
        text: "Campanha concluída: não há mais contatos pendentes.",
        live: { kind: "completed", short: "Concluída", text: "Não há mais contatos pendentes.", tone: "info" },
      };
    case "waiting_window": {
      const when = formatWhen(nextWindowOpen());
      return {
        level: "warning",
        text: `Fora do horário de envio (seg–sex 8h–20h, sáb 8h–14h). Volta sozinho ${when}.`,
        live: {
          kind: "window",
          short: `Fora do horário · volta ${when}`,
          text: `Fora do horário de envio (seg–sex 8h–20h, sáb 8h–14h). O disparo volta sozinho ${when}.`,
          tone: "warning",
        },
      };
    }
  }
  if (/^campanha pausada/i.test(status)) {
    const reason = pauseReasonText(status.replace(/^campanha pausada:?\s*/i, ""));
    return { level: "error", text: `Campanha pausada pelo sistema: ${reason}`, live: { kind: "auto_paused", short: "Pausada pelo sistema", text: reason, tone: "danger" } };
  }
  if (/mais partes que o teto|partes e o teto/i.test(status)) {
    const text = `${stripCode(status)}.`.replace(/\.\.$/, ".");
    return { level: "error", text, live: { kind: "parts_over", short: "Mensagem maior que o teto da rede", text, tone: "danger" } };
  }
  if (/aguardando vez na rede/i.test(status))
    return {
      level: "info",
      text: "Aguardando a vez na rede: só um aparelho envia por vez.",
      live: { kind: "network_turn", short: "Aguardando vez na rede", text: "Aguardando a vez na rede: só um aparelho da rede envia por vez.", tone: "info" },
    };
  if (/verificar (o teto|limites)|falha ao (verificar|registrar reserva)/i.test(status))
    return {
      level: "warning",
      text: stripCode(status),
      live: { kind: "network_check", short: "Conferindo o teto da rede", text: `${stripCode(status)} O motor tenta de novo sozinho.`, tone: "warning" },
    };
  if (/teto da rede/i.test(status))
    return {
      level: "warning",
      text: stripCode(status),
      live: {
        kind: "network_cap",
        short: "Teto da rede atingido",
        text: "O teto de envios da rede (Configurações → Rede e ritmo) foi atingido. O disparo continua sozinho quando a janela liberar.",
        tone: "warning",
      },
    };
  if (/chip pausado/i.test(status))
    return {
      level: "warning",
      text: status,
      live: { kind: "reply_paused", short: "Chip pausado por poucas respostas", text: `${status}. Os outros aparelhos continuam.`.replace(/\.\./, "."), tone: "warning" },
    };
  if (/ritmo reduzido|nenhuma resposta captada/i.test(status))
    return {
      level: "warning",
      text: status,
      live: { kind: "reply_reduced", short: "Ritmo reduzido", text: `${status}: os intervalos desse chip dobram até as respostas voltarem.`, tone: "warning" },
    };
  if (/taxa de resposta indispon/i.test(status))
    return {
      level: "info",
      text: status,
      live: { kind: "reply_unavailable", short: "Taxa de resposta indisponível", text: `${status}: o freio por respostas não atua nele.`, tone: "info" },
    };
  if (/descanso do chip|chip em descanso|^ritmo:/i.test(status))
    return {
      level: "info",
      text: stripCode(status),
      live: { kind: "chip_rest", short: "Chip em descanso", text: `${stripCode(status)}. O próximo envio sai quando o descanso terminar.`, tone: "info" },
    };
  if (/aparelho temporariamente indispon|aparelho ocupado/i.test(status))
    return {
      level: "warning",
      text: status,
      live: { kind: "device_unavailable", short: "Aparelho indisponível", text: status, tone: "warning" },
    };
  if (/^ia aviso/i.test(status))
    return {
      level: "warning",
      text: `${status}${phone ? ` (${phone.trim()})` : ""}`,
      live: { kind: "ai_warning", short: "Aviso da IA", text: status, tone: "warning" },
    };
  return { level: "info", text: status };
}

interface CampaignActivity {
  logs: LogLine[];
  live: Partial<Record<LiveKind, LiveState>>;
}

const activityStore = new Map<number, CampaignActivity>();
const activitySubs = new Set<() => void>();
let activityVersion = 0;
const LOG_LIMIT = 300;
let logSeq = 0;

function activityOf(id: number) {
  let a = activityStore.get(id);
  if (!a) {
    a = { logs: [], live: {} };
    activityStore.set(id, a);
  }
  return a;
}

function notifyActivity() {
  activityVersion++;
  activitySubs.forEach((f) => f());
}

export function appendCampaignLog(campaignId: number, level: LogLevel, text: string, delayMs?: number) {
  const a = activityOf(campaignId);
  const last = a.logs[a.logs.length - 1];
  const now = Date.now();
  // Repetida em seguida: soma no contador em vez de encher o console.
  if (last && last.level === level && last.text === text) {
    a.logs = [...a.logs.slice(0, -1), { ...last, time: nowTime(), at: now, count: (last.count || 1) + 1, delayMs: delayMs ?? last.delayMs }];
  } else {
    a.logs = [...a.logs, { id: ++logSeq, time: nowTime(), at: now, level, text, delayMs }].slice(-LOG_LIMIT);
  }
  notifyActivity();
}

export function clearCampaignLogs(campaignId: number) {
  const a = activityStore.get(campaignId);
  if (!a) return;
  a.logs = [];
  notifyActivity();
}

// Estado ao vivo de volta ao zero (ex.: o operador retomou a campanha).
export function clearLiveState(campaignId: number) {
  const a = activityStore.get(campaignId);
  if (!a) return;
  a.live = {};
  notifyActivity();
}

function setLiveState(campaignId: number, state: LiveState) {
  const a = activityOf(campaignId);
  const live = { ...a.live };
  // O estado principal novo substitui o anterior; pausa automática e conclusão encerram as esperas.
  if (LIVE_MAIN.includes(state.kind) || state.kind === "auto_paused" || state.kind === "completed") for (const k of LIVE_MAIN) delete live[k];
  // Um envio feito (ou a conclusão) encerra uma pausa automática antiga.
  if (state.kind === "sending" || state.kind === "completed") delete live.auto_paused;
  live[state.kind] = state;
  a.live = live;
  notifyActivity();
}

export function handleProgress(p: ProgressPayload) {
  if (!p || typeof p.campaign_id !== "number" || typeof p.status !== "string") return;
  const d = describeProgress(p);
  const withDelay = p.status === "running" || p.status === "send_error";
  // O motor pode avisar o mesmo envio duas vezes (ao gravar e depois da pausa): o console mostra uma linha só.
  const repeatedSend = p.status === "running" && (activityStore.get(p.campaign_id)?.logs.slice(-6) ?? []).some((l) => l.level === "success" && l.text === d.text);
  if (!repeatedSend) appendCampaignLog(p.campaign_id, d.level, d.text, withDelay ? p.delay_used_ms || undefined : undefined);
  if (d.live) setLiveState(p.campaign_id, { ...d.live, at: Date.now() });
  // Aviso no app inteiro: o operador pode estar em outra tela quando a campanha para.
  const who = p.campaign_name ? `${p.campaign_name}: ` : "";
  if (d.live?.kind === "auto_paused") toast.error("Campanha pausada pelo sistema", { description: `${who}${d.live.text}`, duration: 0 });
  else if (d.live?.kind === "parts_over") toast.error("Mensagem maior que o teto da rede", { description: `${who}${d.live.text}`, duration: 0 });
  else if (d.live?.kind === "completed") toast.success("Campanha concluída", p.campaign_name || undefined);
}

// Um ouvinte só, para o app inteiro: a atividade continua chegando com a tela de Campanhas fechada.
let progressListener: Promise<unknown> | null = null;
export function ensureProgressListener() {
  if (progressListener) return;
  try {
    progressListener = listen<ProgressPayload>("campaign-progress", (event) => handleProgress(event.payload)).catch(() => {
      progressListener = null;
    });
  } catch {
    progressListener = null;
  }
}

// Liga já ao carregar o app (o App importa esta tela direto): campanhas retomadas sozinhas na abertura
// também avisam pausa e conclusão, mesmo antes de alguém abrir a tela de Campanhas.
if (typeof window !== "undefined") ensureProgressListener();

function subscribeActivity(cb: () => void) {
  activitySubs.add(cb);
  return () => {
    activitySubs.delete(cb);
  };
}

export function useActivityVersion() {
  return useSyncExternalStore(subscribeActivity, () => activityVersion);
}

export function campaignActivity(id: number): CampaignActivity | undefined {
  return activityStore.get(id);
}

// Relógio para os estados ao vivo expirarem na tela (só re-renderiza enquanto ativo).
export function useNow(active: boolean, everyMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

// Estado principal e avisos de uma campanha agora.
export function liveSummary(c: Campaign, a: CampaignActivity | undefined, now: number): { main?: LiveState; notes: LiveState[] } {
  const live = a?.live ?? {};
  const fresh = (s?: LiveState): s is LiveState => Boolean(s) && (LIVE_TTL[s!.kind] === undefined || now - s!.at < (LIVE_TTL[s!.kind] as number));
  if (c.status === "running") {
    let main = LIVE_MAIN.map((k) => live[k]).find(fresh);
    // "Fora do horário" antigo com a janela já aberta: o motor ainda não mandou o próximo evento.
    if (main?.kind === "window" && withinSendWindow(new Date(now)) && now - main.at > 90_000) main = undefined;
    // Sem evento recente: o relógio local já diz se está fora do horário.
    if ((!main || main.kind === "sending" || main.kind === "send_error") && !withinSendWindow(new Date(now))) {
      const when = formatWhen(nextWindowOpen(new Date(now)), new Date(now));
      main = {
        kind: "window",
        short: `Fora do horário · volta ${when}`,
        text: `Fora do horário de envio (seg–sex 8h–20h, sáb 8h–14h). O disparo volta sozinho ${when}.`,
        tone: "warning",
        at: now,
      };
    }
    return { main, notes: LIVE_NOTES.map((k) => live[k]).filter(fresh) };
  }
  if (c.status === "paused" && live.auto_paused) return { main: live.auto_paused, notes: [] };
  return { notes: [] };
}

const liveToneStyle: Record<LiveTone, string> = {
  success: "text-emerald-700 dark:text-emerald-400",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-red-600 dark:text-red-400",
  info: "text-sky-700 dark:text-sky-300",
};

function LogConsole({ lines, onClear }: { lines: LogLine[]; onClear?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-tertiary" />
          <h3 className="text-sm font-semibold text-primary">Atividade ao vivo</h3>
          <span className="text-[0.75rem] text-tertiary">{lines.length ? `${lines.length} eventos` : ""}</span>
        </div>
        <div className="flex items-center gap-1">
          {!follow && lines.length > 0 && (
            <button
              type="button"
              onClick={() => setFollow(true)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.75rem] text-secondary hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
            >
              <ArrowDown size={12} /> Ir para o fim
            </button>
          )}
          {onClear && lines.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="rounded-md px-2 py-1 text-[0.75rem] text-secondary hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
            >
              Limpar
            </button>
          )}
        </div>
      </div>
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        className="h-64 overflow-y-auto bg-secondary px-4 py-3 font-mono text-[0.75rem] leading-6 custom-scrollbar"
      >
        {lines.length === 0 ? (
          <p className="font-sans text-[0.8125rem] text-tertiary">
            Nenhum evento desde que o Esfera abriu. Ao iniciar o disparo, cada envio e cada espera (horário, teto da rede, descanso do chip) aparecem aqui.
          </p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className="flex items-start gap-3">
              <span className="shrink-0 tabular-nums text-tertiary">{l.time}</span>
              <span className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${levelStyle[l.level].dot}`} aria-label={levelStyle[l.level].label} />
              <span
                className={`min-w-0 break-words ${
                  l.level === "error" ? "text-red-600 dark:text-red-400" : l.level === "warning" ? "text-amber-700 dark:text-amber-300" : "text-primary"
                }`}
              >
                {l.text}
                {l.count && l.count > 1 ? <span className="ml-1.5 rounded bg-card px-1 text-tertiary">×{l.count}</span> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================
// ContactsPanel
// ============================================================

// Lista de contatos (fila de disparo) de uma campanha, com busca, filtro de status e exportação.

export type ContactFilter = "all" | "pending" | "sent" | "failed" | "review" | "skipped";
const RENDER_STEP = 500;

const contactStatus: Record<string, { variant: "success" | "danger" | "neutral" | "info" | "warning"; label: string }> = {
  sent: { variant: "success", label: "Enviado" },
  failed: { variant: "danger", label: "Falhou" },
  pending: { variant: "neutral", label: "Pendente" },
  processing: { variant: "warning", label: "Enviando" },
  replied: { variant: "info", label: "Respondeu" },
  opt_out: { variant: "warning", label: "Descadastrado" },
  partial: { variant: "warning", label: "Envio parcial (revisar)" },
  already_sent: { variant: "neutral", label: "Já recebeu" },
  no_whatsapp: { variant: "neutral", label: "Sem WhatsApp (não disparar)" },
};

const SKIPPED_STATUSES = new Set(["opt_out", "no_whatsapp", "already_sent"]);

function contactBucket(status: string): Exclude<ContactFilter, "all"> {
  if (status === "sent" || status === "replied") return "sent";
  if (status === "failed") return "failed";
  if (status === "partial") return "review";
  if (SKIPPED_STATUSES.has(status)) return "skipped";
  return "pending";
}

// Relatório da campanha para o Excel (devolver ao sistema de cobrança quem recebeu, quem saiu, etc.).
export function exportCampaignContacts(campaign: Campaign, contacts: Contact[]) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = campaign.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || `campanha-${campaign.id}`;
  toast.success("Relatório exportado", `${safe} - ${stamp}.csv, na pasta de downloads.`);
  downloadCsv(
    `${safe} - ${stamp}.csv`,
    ["Nome", "Telefone", "Situação", "Enviado em"],
    contacts.map((c) => [
      c.contactName || c.name || "",
      formatPhoneBr(c.phone),
      (contactStatus[c.status] || { label: c.status }).label,
      c.sentAt && (c.status === "sent" || c.status === "replied" || (c.status as string) === "partial") ? formatDate(c.sentAt) : "",
    ])
  );
}

function ContactsPanel({
  campaign,
  contacts,
  loading,
  onImport,
  onReload,
  filter,
  onFilterChange,
}: {
  campaign: Campaign;
  contacts: Contact[];
  loading: boolean;
  onImport: () => void;
  onReload: () => void;
  filter: ContactFilter;
  onFilterChange: (f: ContactFilter) => void;
}) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(RENDER_STEP);

  const counts = useMemo(() => {
    const c = { pending: 0, sent: 0, failed: 0, review: 0, skipped: 0 };
    for (const x of contacts) c[contactBucket(x.status as string)]++;
    return c;
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const qDigits = q.replace(/\D/g, "");
    return contacts.filter((c) => {
      if (filter !== "all" && contactBucket(c.status as string) !== filter) return false;
      if (!q) return true;
      const name = (c.contactName || c.name || "").toLowerCase();
      return name.includes(q) || (qDigits && c.phone.replace(/\D/g, "").includes(qDigits));
    });
  }, [contacts, filter, search]);

  useEffect(() => setLimit(RENDER_STEP), [filter, search]);

  if (loading && contacts.length === 0) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton h-10 rounded-lg" />
        ))}
      </div>
    );
  }

  if (contacts.length === 0) {
    return (
      <EmptyState
        icon={<Users size={18} />}
        title="Nenhum contato nesta campanha"
        description="Importe uma planilha (CSV, TXT ou .xlsx) ou cole uma lista de nomes e telefones para montar a fila de disparo."
        action={
          <Button icon={<Upload size={14} />} onClick={onImport}>
            Importar contatos
          </Button>
        }
      />
    );
  }

  const items: { id: ContactFilter; label: string; count: number }[] = [
    { id: "all", label: "Todos", count: contacts.length },
    { id: "pending", label: "Pendentes", count: counts.pending },
    { id: "sent", label: "Enviados", count: counts.sent },
    { id: "failed", label: "Falhas", count: counts.failed },
  ];
  if (counts.review > 0 || filter === "review") items.push({ id: "review", label: "Revisar", count: counts.review });
  if (counts.skipped > 0 || filter === "skipped") items.push({ id: "skipped", label: "Pulados", count: counts.skipped });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome ou telefone" className="xl:w-64" />
        <div className="overflow-x-auto">
          <SegmentedControl<ContactFilter> value={filter} onChange={onFilterChange} items={items} />
        </div>
        <div className="flex items-center gap-1.5 xl:ml-auto">
          <Button
            size="sm"
            variant="ghost"
            onClick={onReload}
            aria-label="Atualizar lista de contatos"
            title="Atualizar"
            icon={<RefreshCw size={13} className={loading ? "animate-spin" : ""} />}
          />
          <Button size="sm" variant="secondary" icon={<Download size={13} />} onClick={() => exportCampaignContacts(campaign, contacts)} title="Baixa a lista com a situação de cada contato (CSV para o Excel)">
            Exportar
          </Button>
          <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={onImport}>
            Importar contatos
          </Button>
        </div>
      </div>

      {filter === "review" && counts.review > 0 && (
        <InlineAlert tone="warning" icon={<AlertTriangle size={15} />} title="Envio parcial: confira no celular">
          Parte da mensagem pode ter chegado. Esses contatos não recebem de novo automaticamente, para não duplicar. Confira a conversa no aparelho antes de qualquer
          novo contato com eles.
        </InlineAlert>
      )}
      {filter === "skipped" && counts.skipped > 0 && (
        <p className="text-[0.75rem] text-tertiary">Pulados não recebem: pediram para sair (descadastrados), não têm WhatsApp ou já receberam nesta campanha.</p>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon={<Users size={18} />} title="Nenhum contato encontrado" description="Ajuste a busca ou o filtro de status." className="py-8" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="max-h-[560px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-left text-[0.8125rem]">
              <thead className="sticky top-0 z-10 bg-secondary text-[0.75rem] text-secondary">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Nome</th>
                  <th className="px-4 py-2.5 font-medium">Telefone</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Enviado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {filtered.slice(0, limit).map((c) => {
                  const st = contactStatus[c.status] || contactStatus.pending;
                  const s = c.status as string;
                  // A data gravada vale como envio só para enviado e parcial; nos outros é a hora em que foi pulado.
                  const showDate = Boolean(c.sentAt) && (s === "sent" || s === "replied" || s === "partial");
                  return (
                    <tr key={c.id} className="hover:bg-[var(--color-bg-hover)]">
                      <td className="max-w-[16rem] truncate px-4 py-2 text-primary" title={c.contactName || c.name || undefined}>
                        {c.contactName || c.name || <span className="text-tertiary">(sem nome)</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[0.75rem] text-secondary">{formatPhoneBr(c.phone)}</td>
                      <td className="px-4 py-2">
                        <Badge variant={st.variant}>{st.label}</Badge>
                        {c.retryCount ? <span className="ml-2 text-[0.75rem] text-tertiary">{c.retryCount} tentativa{c.retryCount > 1 ? "s" : ""}</span> : null}
                      </td>
                      <td className="hidden px-4 py-2 text-[0.75rem] text-tertiary md:table-cell">{showDate ? formatDate(c.sentAt) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > limit && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-secondary px-4 py-2 text-[0.75rem] text-tertiary">
              <span>
                Mostrando {formatNumber(limit)} de {formatNumber(filtered.length)}. Use a busca para achar um contato específico.
              </span>
              <button type="button" onClick={() => setLimit((n) => n + RENDER_STEP)} className="text-[var(--color-accent-light)] hover:underline cursor-pointer">
                Mostrar mais {formatNumber(Math.min(RENDER_STEP, filtered.length - limit))}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ContactImportModal
// ============================================================

// Importação de contatos: arquivo CSV/TXT (arrastar ou selecionar) ou colar texto, com prévia validada.

type PreviewFilter = "all" | "valid" | "skipped" | "invalid";
const PREVIEW_LIMIT = 300;
// Texto maior que isso não vai para a caixa de edição (o campo fica lento); a prévia continua completa.
const LARGE_TEXT = 200_000;

export interface ImportSummary {
  imported: number;
  mode: "add" | "replace";
  optedOut: number;
  alreadyInCampaign: number;
  replacedPending: number;
}

const shortSample = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);

function ContactImportModal({
  isOpen,
  onClose,
  campaign,
  onImported,
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onImported: (summary: ImportSummary) => void;
}) {
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileKind, setFileKind] = useState<"" | "xlsx" | "text">("");
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // Cada leitura de arquivo ganha um número; abrir/fechar ou ler outro arquivo descarta a anterior.
  const readSeq = useRef(0);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<PreviewFilter>("all");
  const [phoneMode, setPhoneMode] = useState<PhoneMode>("one");
  const [includeLandlines, setIncludeLandlines] = useState(false);
  const [ddd, setDdd] = useState("");
  const [columns, setColumns] = useState<{ nameCol?: number; phoneCols?: number[] }>({});
  const [tidy, setTidy] = useState(true);
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [existing, setExisting] = useState<Contact[] | null>(null);
  const [existingError, setExistingError] = useState("");
  const [existingReload, setExistingReload] = useState(0);
  const [optOutKeys, setOptOutKeys] = useState<Set<string>>(new Set());
  const [optOutError, setOptOutError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dddId = useId();
  const nameColId = useId();

  useEffect(() => {
    readSeq.current++;
    if (isOpen) {
      setRaw("");
      setFileName("");
      setFileKind("");
      setReading(false);
      setDragging(false);
      dragDepth.current = 0;
      setImportError("");
      setFilter("all");
      setPhoneMode("one");
      setIncludeLandlines(false);
      setDdd("");
      setColumns({});
      setTidy(true);
      setMode("add");
      setConfirmReplace(false);
      setConfirmClose(false);
    }
  }, [isOpen, campaign?.id]);

  // Fila atual: decide entre somar e substituir, e evita repetir quem já está na campanha.
  useEffect(() => {
    if (!isOpen || !campaign) return;
    let alive = true;
    setExisting(null);
    setExistingError("");
    api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id })
      .then((list) => {
        if (alive) setExisting(list);
      })
      .catch((e) => {
        if (alive) setExistingError(String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, campaign?.id, existingReload]);

  useEffect(() => {
    if (!isOpen || !campaign?.companyId) return;
    let alive = true;
    setOptOutError(false);
    api<{ phone: string }[]>("list_opt_outs", { companyId: campaign.companyId })
      .then((l) => {
        if (alive) setOptOutKeys(new Set(l.map((x) => x.phone)));
      })
      .catch(() => {
        if (!alive) return;
        setOptOutKeys(new Set());
        setOptOutError(true);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, campaign?.companyId]);

  const deferred = useDeferredValue(raw);
  const stale = deferred !== raw;
  const dddValid = ddd === "" || isValidDdd(ddd);
  const effectiveDdd = ddd && dddValid ? ddd : undefined;
  const delimiter = fileKind === "xlsx" ? "\t" : undefined;
  const parsed = useMemo(
    () => parseContactsText(deferred, { phoneMode, includeLandlines, ddd: effectiveDdd, nameCol: columns.nameCol, phoneCols: columns.phoneCols, delimiter }),
    [deferred, phoneMode, includeLandlines, effectiveDdd, columns, delimiter]
  );
  const otherMode: PhoneMode = phoneMode === "one" ? "all" : "one";
  // Com mais de um telefone por linha, conta as duas opções para o operador comparar.
  const other = useMemo(
    () =>
      parsed.multiPhone
        ? parseContactsText(deferred, { phoneMode: otherMode, includeLandlines, ddd: effectiveDdd, nameCol: columns.nameCol, phoneCols: columns.phoneCols, delimiter })
        : null,
    [parsed.multiPhone, deferred, otherMode, includeLandlines, effectiveDdd, columns, delimiter]
  );

  const existingByKey = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of existing ?? []) m.set(optOutKey(c.phone), c);
    return m;
  }, [existing]);
  const pendingExisting = useMemo(() => (existing ?? []).filter((c) => c.status === "pending"), [existing]);

  const view = useMemo(() => {
    const rows = parsed.rows;
    const validRows = rows.filter((r) => r.valid);
    // Já na campanha: com "somar", qualquer status; com "substituir", só quem não está pendente.
    const inCampaign = (r: ParsedRow) => {
      const c = existingByKey.get(optOutKey(r.phone));
      return Boolean(c) && (mode === "add" || c?.status !== "pending");
    };
    const toImport = validRows.filter((r) => !inCampaign(r));
    const names = validRows.map((r) => r.name).filter(Boolean);
    return {
      rows,
      validRows,
      toImport,
      alreadyIn: validRows.length - toImport.length,
      optedOut: toImport.filter((r) => optOutKeys.has(optOutKey(r.phone))).length,
      skipped: rows.filter((r) => !r.valid && r.skipped).length,
      problems: rows.filter((r) => !r.valid && !r.skipped).length,
      shouted: names.length > 0 && names.filter(isShoutedName).length * 2 >= names.length,
      inCampaign,
    };
  }, [parsed, existingByKey, mode, optOutKeys]);
  const { rows, validRows, toImport } = view;
  const sendable = toImport.length - view.optedOut;
  const visible = rows.filter((r) =>
    filter === "valid" ? r.valid : filter === "skipped" ? !r.valid && r.skipped : filter === "invalid" ? !r.valid && !r.skipped : true
  );
  const showName = (n: string) => (tidy && view.shouted ? tidyName(n) : n);

  const blockedByRunning = campaign?.status === "running";
  const large = raw.length > LARGE_TEXT && Boolean(fileName);
  const canImport = Boolean(campaign) && !blockedByRunning && !reading && !stale && existing !== null && dddValid && toImport.length > 0;

  const clearSource = () => {
    readSeq.current++;
    setReading(false);
    setRaw("");
    setFileName("");
    setFileKind("");
    setColumns({});
  };

  // CSV/TXT (UTF-8, Windows-1252 ou UTF-16) ou planilha .xlsx (1ª aba), tudo pelo mesmo leitor de colunas.
  const readFile = async (file: File) => {
    const seq = ++readSeq.current;
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    setReading(true);
    setImportError("");
    try {
      let text: string;
      if (ext === "xlsx" || ext === "xlsm") text = rowsToText(await parseXlsx(new Uint8Array(await file.arrayBuffer())));
      else if (ext === "xls" || ext === "ods")
        throw new Error("Este formato de planilha não é lido aqui. No Excel, use Salvar como → Pasta de Trabalho do Excel (.xlsx) ou CSV.");
      else text = decodeTextFile(await file.arrayBuffer());
      if (seq !== readSeq.current) return;
      setRaw(text);
      setFileName(file.name);
      setFileKind(ext === "xlsx" || ext === "xlsm" ? "xlsx" : "text");
      setColumns({});
      setFilter("all");
    } catch (error) {
      if (seq !== readSeq.current) return;
      setImportError(error instanceof Error ? error.message : "Não foi possível ler o arquivo selecionado.");
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  };

  const doImport = async () => {
    if (!campaign || !canImport) return;
    setImporting(true);
    setImportError("");
    try {
      // A importação do sistema troca os pendentes pela lista enviada: para somar, a fila atual vai junto.
      let keep: [string, string][] = [];
      if (mode === "add") {
        const current = await api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id });
        const freshKeys = new Set(toImport.map((r) => optOutKey(r.phone)));
        keep = current
          .filter((c) => c.status === "pending" && !freshKeys.has(optOutKey(c.phone)))
          .map((c) => [c.contactName || c.name || "", c.phone]);
      }
      const fresh = toImport.map((r) => [showName(r.name), r.phone] as [string, string]);
      await api("import_campaign_contacts", { campaignId: campaign.id, contacts: [...keep, ...fresh] });
      onImported({
        imported: fresh.length,
        mode,
        optedOut: view.optedOut,
        alreadyInCampaign: view.alreadyIn,
        replacedPending: mode === "replace" ? pendingExisting.length : 0,
      });
      onClose();
    } catch (error) {
      console.error("Falha ao importar contatos:", error);
      setImportError(String(error));
    } finally {
      setImporting(false);
    }
  };

  const handleConfirm = () => {
    if (!canImport) return;
    if (mode === "replace" && pendingExisting.length > 0) setConfirmReplace(true);
    else doImport();
  };

  const requestClose = () => {
    if (importing) return;
    if (raw.trim()) setConfirmClose(true);
    else onClose();
  };

  const downloadProblems = () => {
    const list = rows.filter((r) => !r.valid);
    const base = (fileName || "lista").replace(/\.[^.]+$/, "");
    downloadCsv(
      `${base}_problemas.csv`,
      ["Linha", "Nome", "Telefone", "Motivo", "Linha original"],
      list.map((r) => [r.line, r.name, formatPhoneBr(r.phone), r.reason || "", r.raw])
    );
  };

  const statusLabel = existing === null && !existingError ? "Lendo a fila atual…" : "";

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={requestClose}
        title="Importar contatos"
        description={campaign ? `Campanha: ${campaign.name}` : undefined}
        size="xl"
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-0.5 text-[0.75rem]">
              {view.optedOut > 0 && (
                <p className="text-amber-700 dark:text-amber-300">
                  {formatNumber(view.optedOut)} {view.optedOut === 1 ? "número pediu" : "números pediram"} para não receber (descadastrados) e não {view.optedOut === 1 ? "recebe" : "recebem"}.
                </p>
              )}
              {view.alreadyIn > 0 && (
                <p className="text-tertiary">
                  {formatNumber(view.alreadyIn)} {view.alreadyIn === 1 ? "número já está" : "números já estão"} nesta campanha e não {view.alreadyIn === 1 ? "entra" : "entram"} de novo.
                </p>
              )}
              {statusLabel && <p className="text-tertiary">{statusLabel}</p>}
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2">
              <Button variant="secondary" onClick={requestClose} disabled={importing}>
                Cancelar
              </Button>
              <Button onClick={handleConfirm} disabled={!canImport} loading={importing || reading} icon={<Upload size={14} />}>
                {reading
                  ? "Lendo arquivo…"
                  : toImport.length
                  ? `${mode === "replace" && pendingExisting.length ? "Substituir por" : "Importar"} ${formatNumber(toImport.length)} ${toImport.length === 1 ? "contato" : "contatos"}`
                  : "Importar"}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-5">
          {blockedByRunning && (
            <InlineAlert tone="warning" icon={<Pause size={15} />} title="Pause a campanha para importar">
              A fila não pode mudar enquanto as mensagens estão saindo. Pause a campanha, importe a lista e depois retome.
            </InlineAlert>
          )}
          {importError && (
            <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="A importação falhou" onDismiss={() => setImportError("")}>
              {importError}
            </InlineAlert>
          )}
          {existingError && (
            <InlineAlert
              tone="danger"
              icon={<AlertCircle size={15} />}
              title="Não foi possível ler a fila atual da campanha"
              action={
                <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => setExistingReload((n) => n + 1)}>
                  Tentar de novo
                </Button>
              }
            >
              Sem ela a importação fica bloqueada, para não apagar contatos pendentes por engano.
            </InlineAlert>
          )}
          {optOutError && (
            <InlineAlert tone="warning" icon={<AlertTriangle size={15} />} title="Não foi possível conferir os descadastrados agora">
              A prévia não marca quem pediu SAIR. O disparo confere de novo antes de cada envio, e quem pediu para sair não recebe.
            </InlineAlert>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.tsv,.xlsx,.xlsm,.xls,.ods"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = "";
            }}
          />

          {pendingExisting.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3.5 py-2.5">
              <p className="min-w-0 flex-1 text-[0.8125rem] text-secondary">
                Esta campanha já tem <strong className="tabular-nums text-primary">{formatNumber(pendingExisting.length)}</strong>{" "}
                {pendingExisting.length === 1 ? "contato aguardando" : "contatos aguardando"} envio.
              </p>
              <SegmentedControl<"add" | "replace">
                value={mode}
                onChange={setMode}
                items={[
                  { id: "add", label: "Somar à fila" },
                  { id: "replace", label: "Substituir pendentes" },
                ]}
              />
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div
              role="button"
              tabIndex={0}
              aria-busy={reading}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                dragDepth.current++;
                setDragging(true);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) readFile(f);
              }}
              className={`flex min-h-[11rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
                dragging ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-bg-hover)]"
              }`}
            >
              <span className="pointer-events-none flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary">
                {reading ? <RefreshCw size={18} className="animate-spin" /> : <FileUp size={18} />}
              </span>
              {reading ? (
                <p className="pointer-events-none text-[0.8125rem] font-medium text-primary">Lendo o arquivo…</p>
              ) : fileName ? (
                <>
                  <p className="pointer-events-none break-all text-[0.8125rem] font-medium text-primary">{fileName}</p>
                  <p className="pointer-events-none text-[0.75rem] text-tertiary">Clique para trocar o arquivo</p>
                </>
              ) : (
                <>
                  <p className="pointer-events-none text-[0.8125rem] font-medium text-primary">Arraste um arquivo CSV, TXT ou planilha (.xlsx)</p>
                  <p className="pointer-events-none text-[0.75rem] text-tertiary">ou clique para selecionar</p>
                </>
              )}
            </div>

            {large ? (
              <div className="flex min-h-[11rem] flex-col justify-between gap-3 rounded-xl border border-border px-4 py-3.5">
                <div>
                  <p className="text-[0.8125rem] font-medium text-primary">Conteúdo do arquivo</p>
                  <p className="mt-1 text-[0.75rem] text-tertiary">
                    {formatNumber(parsed.lines)} linhas carregadas. O arquivo é grande demais para editar aqui; confira as linhas na prévia abaixo.
                  </p>
                </div>
                <div>
                  <Button size="sm" variant="secondary" icon={<X size={13} />} onClick={clearSource}>
                    Remover arquivo
                  </Button>
                </div>
              </div>
            ) : (
              <Field
                label="Ou cole a lista"
                htmlFor="import-raw"
                hint="Um contato por linha: Nome, Telefone. Também aceita planilha com cabeçalho (ex.: PROCESSO, NOME DEVEDOR, TELEFONE 1…), ; ou tabulação, ou só o telefone."
                aside={
                  raw ? (
                    <button
                      type="button"
                      onClick={clearSource}
                      className="inline-flex items-center gap-1 text-[0.75rem] text-secondary hover:text-[var(--color-text-primary)] cursor-pointer"
                    >
                      <X size={12} /> Limpar
                    </button>
                  ) : null
                }
              >
                <textarea
                  id="import-raw"
                  rows={7}
                  value={raw}
                  onChange={(e) => {
                    readSeq.current++;
                    setReading(false);
                    setRaw(e.target.value);
                    if (fileName) {
                      setFileName("");
                      setFileKind("");
                    }
                  }}
                  placeholder={"Maria Silva, 11999991111\nJoão Souza, 5511988882222\n5511977773333"}
                  className="resize-none font-mono text-[0.75rem]"
                />
              </Field>
            )}
          </div>

          <p className="text-[0.75rem] text-tertiary">
            Os números são limpos automaticamente e recebem o DDI +55 quando têm DDD. Número sem DDD não entra (viraria um número de outro
            país). Cada telefone válido vira um contato; número repetido entra uma vez.
          </p>

          {rows.length > 0 && (
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]">
                  <span className="text-secondary">
                    <strong className="tabular-nums text-primary">{formatNumber(parsed.lines)}</strong> {parsed.lines === 1 ? "linha" : "linhas"}
                  </span>
                  <span className="text-primary">
                    <strong className="tabular-nums">{formatNumber(Math.max(0, sendable))}</strong> para envio
                  </span>
                  {view.skipped > 0 && (
                    <span className="text-secondary">
                      <strong className="tabular-nums">{formatNumber(view.skipped)}</strong> {view.skipped === 1 ? "pulado" : "pulados"}
                    </span>
                  )}
                  {view.problems > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      <strong className="tabular-nums">{formatNumber(view.problems)}</strong> com problema
                    </span>
                  )}
                </div>
                <SegmentedControl<PreviewFilter>
                  value={filter}
                  onChange={setFilter}
                  items={[
                    { id: "all", label: "Todos", count: rows.length },
                    { id: "valid", label: "Válidos", count: validRows.length },
                    { id: "skipped", label: "Pulados", count: view.skipped },
                    { id: "invalid", label: "Com problema", count: view.problems },
                  ]}
                />
              </div>

              {parsed.allColumns.length > 2 || (parsed.hasHeader && parsed.allColumns.length > 1) ? (
                <div className="space-y-2 rounded-lg border border-border px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor={nameColId} className="!mb-0 text-[0.75rem] text-secondary">
                      Coluna do nome
                    </label>
                    <select
                      id={nameColId}
                      value={parsed.nameCol}
                      onChange={(e) => setColumns((c) => ({ ...c, nameCol: Number(e.target.value) }))}
                      className="!h-8 !w-auto max-w-[18rem] !py-0 text-[0.75rem]"
                    >
                      <option value={-1}>Sem nome</option>
                      {parsed.allColumns.map((c) => (
                        <option key={c.index} value={c.index}>
                          {c.label}
                          {c.sample ? ` (ex.: ${shortSample(c.sample)})` : ""}
                        </option>
                      ))}
                    </select>
                    {(columns.nameCol !== undefined || columns.phoneCols !== undefined) && (
                      <button
                        type="button"
                        onClick={() => setColumns({})}
                        className="text-[0.75rem] text-[var(--color-accent-light)] hover:underline cursor-pointer"
                      >
                        Voltar à escolha automática
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[0.75rem] text-secondary">Telefones do devedor</span>
                    {parsed.allColumns
                      .filter((c) => c.index !== parsed.nameCol)
                      .map((c) => {
                        const on = parsed.phoneCols.includes(c.index);
                        return (
                          <button
                            key={c.index}
                            type="button"
                            aria-pressed={on}
                            title={c.sample ? `Ex.: ${c.sample}` : undefined}
                            onClick={() =>
                              setColumns((s) => ({
                                ...s,
                                phoneCols: on ? parsed.phoneCols.filter((j) => j !== c.index) : [...parsed.phoneCols, c.index].sort((a, b) => a - b),
                              }))
                            }
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[0.75rem] transition-colors cursor-pointer ${
                              on
                                ? "border-[var(--color-border-accent)] bg-[var(--color-accent-glow)] text-primary"
                                : "border-border text-tertiary hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]"
                            }`}
                          >
                            {on && <Check size={11} />}
                            {c.label}
                          </button>
                        );
                      })}
                  </div>
                  <p className="text-[0.6875rem] text-tertiary">
                    Telefone de referência, recado, cônjuge ou trabalho não deve ser usado para cobrar o devedor.
                  </p>
                </div>
              ) : (
                parsed.columns && <p className="text-[0.75rem] text-tertiary">Colunas lidas: {parsed.columns}</p>
              )}

              {parsed.nameCol < 0 && validRows.length > 0 && (
                <p className="text-[0.75rem] text-tertiary">Sem coluna de nome: a variável {"{nome}"} fica em branco (“Olá, tudo bem?”).</p>
              )}

              {(parsed.multiPhone || parsed.landlines > 0 || view.shouted) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2">
                  {parsed.multiPhone && (
                    <>
                      <span className="text-[0.75rem] text-secondary">Telefones de cada devedor</span>
                      <SegmentedControl<PhoneMode>
                        value={phoneMode}
                        onChange={setPhoneMode}
                        items={[
                          { id: "one", label: "Só 1 (celular primeiro)", count: phoneMode === "one" ? validRows.length : other?.rows.filter((r) => r.valid).length },
                          { id: "all", label: "Todos", count: phoneMode === "all" ? validRows.length : other?.rows.filter((r) => r.valid).length },
                        ]}
                      />
                    </>
                  )}
                  {parsed.landlines > 0 && (
                    <Toggle size="sm" checked={includeLandlines} onChange={setIncludeLandlines} label={`Incluir fixos (${formatNumber(parsed.landlines)})`} />
                  )}
                  {view.shouted && (
                    <Toggle size="sm" checked={tidy} onChange={setTidy} label="Ajustar maiúsculas dos nomes (MARIA SILVA → Maria Silva)" />
                  )}
                </div>
              )}
              {parsed.multiPhone && phoneMode === "all" && (
                <p className="text-[0.75rem] text-amber-700 dark:text-amber-300">
                  Com “Todos”, o mesmo devedor recebe uma mensagem em cada número: mais denúncias e mais consumo do teto da rede.
                </p>
              )}

              {(parsed.localCount > 0 || ddd) && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2">
                  <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="text-[0.75rem] text-secondary">
                    {parsed.localCount > 0
                      ? `${formatNumber(parsed.localCount)} ${parsed.localCount === 1 ? "número está" : "números estão"} sem DDD e não ${parsed.localCount === 1 ? "entra" : "entram"}.`
                      : "Números sem DDD completados."}{" "}
                    Se todos forem da mesma região, informe o DDD:
                  </span>
                  <label htmlFor={dddId} className="sr-only">
                    DDD para completar os números
                  </label>
                  <input
                    id={dddId}
                    type="text"
                    inputMode="numeric"
                    maxLength={2}
                    value={ddd}
                    onChange={(e) => setDdd(e.target.value.replace(/\D/g, "").slice(0, 2))}
                    placeholder="75"
                    aria-invalid={!dddValid}
                    className="!h-7 !w-14 !px-2 text-center font-mono text-[0.75rem]"
                  />
                  {!dddValid && <span className="text-[0.75rem] text-red-600 dark:text-red-400">DDD inválido</span>}
                </div>
              )}

              {validRows.length === 0 && (
                <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Nenhum telefone válido encontrado">
                  Confira se há uma coluna de telefone com DDD. Aceita “Nome, Telefone”, planilha com cabeçalho ou só o telefone.
                </InlineAlert>
              )}

              <div className="overflow-hidden rounded-lg border border-border">
                <div className="max-h-64 overflow-y-auto custom-scrollbar">
                  <table className="w-full text-left text-[0.8125rem]">
                    <thead className="sticky top-0 bg-secondary text-[0.75rem] text-secondary">
                      <tr>
                        <th className="w-14 px-3 py-2 font-medium">Linha</th>
                        <th className="px-3 py-2 font-medium">Nome</th>
                        <th className="px-3 py-2 font-medium">Telefone</th>
                        <th className="px-3 py-2 font-medium">Situação</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {visible.slice(0, PREVIEW_LIMIT).map((r, i) => {
                        const optedOut = r.valid && optOutKeys.has(optOutKey(r.phone));
                        const already = r.valid && view.inCampaign(r);
                        return (
                          <tr key={`${r.line}-${i}`} className={!r.valid && !r.skipped ? "bg-red-500/[0.05]" : ""}>
                            <td className="px-3 py-1.5 tabular-nums text-tertiary">{r.line}</td>
                            <td className="max-w-[14rem] truncate px-3 py-1.5 text-primary" title={r.name || r.raw}>
                              {r.name ? showName(r.name) : r.valid ? <span className="text-tertiary">(sem nome)</span> : <span className="text-tertiary">{r.raw}</span>}
                            </td>
                            <td className="px-3 py-1.5 font-mono text-[0.75rem] text-secondary">{r.phone || "—"}</td>
                            <td className="px-3 py-1.5 text-[0.75rem]">
                              {!r.valid ? (
                                <span className={r.skipped ? "text-tertiary" : "text-red-600 dark:text-red-400"}>{r.reason}</span>
                              ) : optedOut ? (
                                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                                  <Ban size={12} /> Descadastrado (não recebe)
                                </span>
                              ) : already ? (
                                <span className="text-tertiary">Já está nesta campanha</span>
                              ) : r.warning ? (
                                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                                  <AlertTriangle size={12} /> {r.warning}
                                </span>
                              ) : (
                                <span className="text-emerald-600 dark:text-emerald-400">Ok</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-secondary px-3 py-2 text-[0.75rem] text-tertiary">
                  <span>
                    {visible.length > PREVIEW_LIMIT
                      ? `Mostrando ${PREVIEW_LIMIT} de ${formatNumber(visible.length)} linhas. Todas são consideradas na importação.`
                      : `${formatNumber(visible.length)} ${visible.length === 1 ? "linha" : "linhas"} no filtro.`}
                  </span>
                  {view.skipped + view.problems > 0 && (
                    <button type="button" onClick={downloadProblems} className="text-[var(--color-accent-light)] hover:underline cursor-pointer">
                      Baixar números não importados (.csv)
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmReplace}
        title="Substituir os contatos pendentes?"
        confirmLabel="Substituir pendentes"
        loading={importing}
        onConfirm={() => {
          setConfirmReplace(false);
          doImport();
        }}
        onClose={() => setConfirmReplace(false)}
      >
        Os <strong className="text-primary">{formatNumber(pendingExisting.length)}</strong> contatos que ainda aguardam envio saem da fila, e entram os{" "}
        <strong className="text-primary">{formatNumber(toImport.length)}</strong> desta lista. Quem já recebeu continua no relatório. Para manter a fila
        atual, escolha “Somar à fila”.
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirmClose}
        title="Fechar sem importar?"
        confirmLabel="Fechar sem importar"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
        onClose={() => setConfirmClose(false)}
      >
        A lista carregada e as opções escolhidas serão descartadas.
      </ConfirmDialog>
    </>
  );
}

// ============================================================
// GlobalAiConfigModal
// ============================================================

// Parâmetros de IA da empresa (padrão para todas as campanhas).

type ProviderKeys = Record<string, { apiKey: string; endpoint: string; model: string }>;

function GlobalAiConfigModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { selectedCompanyId } = useAuth();
  const [provider, setProvider] = useState("groq");
  const [endpoint, setEndpoint] = useState("https://api.groq.com/openai/v1/chat/completions");
  const [model, setModel] = useState("openai/gpt-oss-120b");
  const [temperature, setTemperature] = useState(0.7);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(
    DEFAULT_WHATSAPP_SYSTEM_PROMPT
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
        setProvider(cfg.provider === "ollama_local" ? "ollama" : cfg.provider || "groq");
        setEndpoint(cfg.endpoint || "https://openrouter.ai/api/v1/chat/completions");
        setModel(cfg.model || "openai/gpt-oss-120b");
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
        message: "Olá {nome}, tudo bem? Temos uma condição especial para regularizar o seu cadastro. Podemos conversar?",
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
                <input id="ai-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="openai/gpt-oss-120b" className="font-mono" />
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
                    placeholder={savedProviderKeys[provider] ? "Chave salva (não é exibida). Deixe em branco para manter." : info?.keyPlaceholder || "sk-..."}
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
                  <p className="text-[0.75rem] text-tertiary">Reescreve uma frase de exemplo com os dados acima, sem salvar.</p>
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
              hint="Entre 0,3 e 0,7 a IA mantém números, datas e o SAIR como estão. Valores altos deixam o texto mais criativo (e mais arriscado)."
            >
              <input id="ai-temp" type="range" min="0" max="1" step="0.05" value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="w-full" />
            </Field>
            <Field label="Instrução padrão" htmlFor="ai-prompt" hint="Regras que a IA segue ao reescrever qualquer mensagem da empresa.">
              <textarea
                id="ai-prompt"
                rows={4}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Ex.: atendente de cobrança da empresa, cordial e breve. As regras do CDC e da LGPD já são aplicadas automaticamente."
                className="resize-y"
              />
            </Field>
          </FormSection>
        </div>
      )}
    </Modal>
  );
}

// ============================================================
// CampaignWizard
// ============================================================

// Assistente em etapas para criar ou editar uma campanha.

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
    closing: "Atenciosamente, {Equipe REALESS|Setor Financeiro}. Para deixar de receber mensagens por este canal, responda SAIR.",
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

function CampaignWizard({
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
  const partLimit = partLimitOf(useNetworkLimits());
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
  const [devicesError, setDevicesError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setForm(initialForm(campaign));
    setStep(initialStep);
    setVisited(isEdit ? STEPS.length - 1 : STEPS.findIndex((s) => s.id === initialStep));
    setShowErrors({});
    setSaveError("");
    setConfirmDiscard(false);
    // Reinicia só ao abrir ou trocar de campanha (a lista atualiza ao vivo durante o disparo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, campaign?.id]);

  const loadDevices = async () => {
    if (!selectedCompanyId) return;
    setDevicesLoading(true);
    try {
      const data = await api<Device[]>("get_devices", { companyId: selectedCompanyId });
      setDevices(data || []);
      setDevicesError("");
    } catch (e) {
      setDevicesError(String(e));
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
    message: messageError(form, partLimit),
    sending: delayError(form.delayMin, form.delayMax),
  };
  // Fechar por Esc, clique fora ou Cancelar com alterações pede confirmação.
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm(campaign));
  const requestClose = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
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
  const partCount = messagePartCount(form);
  const invalidSteps = (Object.keys(showErrors) as StepId[]).filter((id) => showErrors[id] && errors[id]);
  const devStats = deviceSelectionStats(devices, form.deviceIds);
  const providerName = form.aiProvider ? getAiProviderInfo(form.aiProvider)?.name || form.aiProvider : "Padrão da empresa";

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <Button variant="ghost" onClick={requestClose} disabled={saving}>
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
    <>
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title={isEdit ? "Editar campanha" : "Nova campanha"}
      description={isEdit ? campaign?.name : undefined}
      size="2xl"
      footer={footer}
    >
      <div className="space-y-6">
        {/* As etapas ficam visíveis ao rolar (janelas baixas, 1280x720). */}
        <div className="sticky top-0 z-10 -mx-5 -mt-4 border-b border-border bg-card px-5 pb-2 pt-3">
          <Stepper steps={STEPS} current={step} onSelect={goTo} invalid={invalidSteps} reachable={(_, i) => isEdit || i <= visited} />
        </div>

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
                placeholder="Carteira A – lote 3"
              />
            </Field>
          </FormSection>
        )}

        {step === "message" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <FormSection title="Mensagem" description="Saudação, corpo e encerramento saem como mensagens seguidas, nesta ordem.">
              <MessageFields
                value={form}
                onChange={(p) => patch(p)}
                showErrors={Boolean(showErrors.message)}
                partLimit={partLimit}
              />
            </FormSection>
            <div className="lg:sticky lg:top-20 lg:self-start">
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
            <AiFields value={form} onChange={(p) => patch(p)} companyId={selectedCompanyId} message={form} />
          </FormSection>
        )}

        {step === "sending" && (
          <div className="space-y-8">
            <FormSection title="Ritmo de envio" description="Intervalos aleatórios entre mensagens deixam o disparo mais natural." className="max-w-3xl">
              <DelayFields min={form.delayMin} max={form.delayMax} onChange={(p) => patch(p)} parts={partCount} devices={form.deviceIds.length} />
            </FormSection>
            <FormSection
              title="Aparelhos"
              description="Quais celulares podem enviar esta campanha. Os envios são distribuídos entre os selecionados que estiverem online. Você também pode definir isso depois."
            >
              {devicesError && devices.length === 0 ? (
                <InlineAlert
                  tone="danger"
                  icon={<AlertCircle size={15} />}
                  title="Não foi possível carregar os aparelhos"
                  action={
                    <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={loadDevices} loading={devicesLoading}>
                      Tentar de novo
                    </Button>
                  }
                >
                  {devicesError}
                </InlineAlert>
              ) : (
                <DevicePicker
                  devices={devices}
                  loading={devicesLoading && !devicesLoaded}
                  selected={form.deviceIds}
                  onChange={(ids) => patch({ deviceIds: ids })}
                  onRefresh={loadDevices}
                  refreshing={devicesLoading}
                  listClassName="max-h-[300px]"
                />
              )}
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
                  {errors.message ? (
                    <span className="text-red-600 dark:text-red-400">{errors.message}</span>
                  ) : (
                    <>
                      {partCount} mensagens seguidas · {formatNumber(fullMessage.length)} caracteres · {form.useSpintax ? "com variações" : "sem variações"}
                    </>
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
    <ConfirmDialog
      isOpen={confirmDiscard}
      title="Descartar alterações?"
      confirmLabel="Descartar"
      onConfirm={() => {
        setConfirmDiscard(false);
        onClose();
      }}
      onClose={() => setConfirmDiscard(false)}
    >
      {isEdit
        ? "As alterações feitas nesta campanha ainda não foram salvas e serão perdidas."
        : "A campanha ainda não foi criada. Para guardar o que já escreveu sem criar, use Salvar rascunho."}
    </ConfirmDialog>
    </>
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

// ============================================================
// CampaignDetail
// ============================================================

// Visão de detalhe de uma campanha: execução, contatos, aparelhos e configurações.

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

// Situação da rede (Configurações → Rede e ritmo) e do freio por respostas de cada chip.
interface NetworkChipInfo {
  chipId: number;
  deviceId: number;
  deviceName: string;
  replyRate: number | null;
  sample: number;
  state: string;
  reason: string;
}

interface NetworkStatusInfo {
  hourly: number;
  daily: number;
  sentLastHour: number;
  sentToday: number;
  /** Tentativas contadas no teto (cada parte extra soma); versões antigas do backend não mandam. */
  attemptsLastHour?: number;
  attemptsToday?: number;
  waitSeconds: number;
  chips: NetworkChipInfo[];
}

// Tempo real entre envios desta sessão (mediana), para a estimativa seguir o ritmo de verdade.
function observedCycleSeconds(logs: LogLine[]) {
  const sends = logs.filter((l) => l.level === "success" && l.text.startsWith("Mensagem enviada")).slice(-21);
  const gaps: number[] = [];
  for (let i = 1; i < sends.length; i++) {
    const gap = (sends[i].at - sends[i - 1].at) / 1000;
    if (gap > 0 && gap < 2 * 3600) gaps.push(gap);
  }
  if (gaps.length < 3) return undefined;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

const liveToneIcon: Record<LiveTone, ReactNode> = {
  success: <Send size={15} />,
  warning: <Clock size={15} />,
  danger: <AlertCircle size={15} />,
  info: <Info size={15} />,
};

function CampaignDetail({
  campaign,
  syncRevision,
  importRevision,
  initialTab = "overview",
  onBack,
  onEdit,
  onImport,
  onUpdateCampaign,
  onRefresh,
}: {
  campaign: Campaign;
  syncRevision: number;
  importRevision: number;
  initialTab?: DetailTab;
  onBack: () => void;
  /** Abre o assistente a partir do que está na tela (inclui alterações ainda não salvas). */
  onEdit: (current: Campaign) => void;
  onImport: () => void;
  onUpdateCampaign: (updated: Campaign) => void;
  onRefresh: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const limits = useNetworkLimits();
  const partLimit = partLimitOf(limits);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(campaign));
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsFilter, setContactsFilter] = useState<ContactFilter>("all");
  const [confirmations, setConfirmations] = useState<{ pending: number; sent: number; uncertain: number } | null>(null);
  const [network, setNetwork] = useState<NetworkStatusInfo | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "start" | "pause" | "stop" | "retry" | "reset" | "save" | "saveDevices">("");
  const [savedFlash, setSavedFlash] = useState<"" | "settings" | "devices">("");
  const [confirm, setConfirm] = useState<"" | "stop" | "reset" | "retry" | "leave">("");
  const isRunning = campaign.status === "running";

  // Atividade ao vivo (fica no módulo, não some ao trocar de aba).
  useActivityVersion();
  const activity = campaignActivity(campaign.id);
  const logs = activity?.logs ?? [];
  const now = useNow(isRunning || campaign.status === "paused");
  const live = liveSummary(campaign, activity, now);
  const onLog = (level: LogLevel, text: string) => appendCampaignLog(campaign.id, level, text);

  // Confirmações de SAIR: a cada 30 s com a campanha rodando; parada, uma vez.
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api<{ pending: number; sent: number; uncertain: number }>("get_confirmation_counts", { campaignId: campaign.id })
        .then((v) => {
          if (alive) setConfirmations(v);
        })
        .catch(() => {
          if (alive) setConfirmations(null);
        });
    refresh();
    const timer = isRunning ? setInterval(refresh, 30_000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [campaign.id, isRunning]);

  // Teto da rede e estado dos chips: a cada 30 s com a campanha rodando.
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api<NetworkStatusInfo>("get_network_status")
        .then((v) => {
          if (alive) setNetwork(v);
        })
        .catch(() => {
          if (alive) setNetwork(null);
        });
    refresh();
    const timer = isRunning ? setInterval(refresh, 30_000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [campaign.id, isRunning]);

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
      setDevicesError("");
    } catch (e) {
      setDevicesError(String(e));
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

  // Fila: recarrega quando um envio muda um contato, no máximo a cada 3 s (a lista pode ter milhares).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      last = Date.now();
      api<Contact[]>("get_campaign_contacts", { campaignId: campaign.id })
        .then((data) => {
          if (!cancelled) setContacts(data);
        })
        .catch(() => {});
    };
    listen<ProgressPayload>("campaign-progress", (event) => {
      const p = event.payload;
      if (!p || p.campaign_id !== campaign.id || !["running", "send_error", "completed"].includes(p.status)) return;
      if (trailing) clearTimeout(trailing);
      const wait = 3000 - (Date.now() - last);
      if (wait <= 0) reload();
      else trailing = setTimeout(reload, wait);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (trailing) clearTimeout(trailing);
      unlisten?.();
    };
  }, [campaign.id]);

  // Aparelhos: o check-in avisa quando um volta; a lista inteira é relida a cada 30 s (pega quem caiu).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ esferaDeviceId: string; status: string }>("device-updated", (event) => {
      const { esferaDeviceId, status } = event.payload || ({} as { esferaDeviceId: string; status: string });
      if (!esferaDeviceId) return;
      setDevices((prev) => prev.map((d) => (d.esferaDeviceId === esferaDeviceId ? { ...d, status: status as Device["status"] } : d)));
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    const timer = setInterval(() => {
      api<Device[]>("get_devices", { companyId: campaign.companyId })
        .then((data) => {
          if (!cancelled && data) setDevices(data);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unlisten?.();
    };
  }, [campaign.companyId]);

  const { total, sent, failed, pending, skipped, review, progress } = countsFromContacts(campaign, contacts);
  const autoPaused = campaign.status === "paused" && live.main?.kind === "auto_paused";
  const status = autoPaused ? { variant: "danger" as BadgeVariant, label: "Pausada pelo sistema" } : statusInfo(campaign.status);
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
  const msgError = messageError(draft, partLimit);

  // Ritmo real: intervalo, teto da rede por parte, limite dos chips e janela de envio.
  const parts = messagePartCount(draft);
  const pace = estimatePace({
    pending,
    delayMin: draft.delayMin,
    delayMax: draft.delayMax,
    parts,
    devices: Math.max(1, devStats.selectedOnline || draft.deviceIds.length),
    limits,
    observedCycleSec: observedCycleSeconds(logs),
    now: new Date(now),
  });

  // Chips dos aparelhos selecionados: sem chip ou com dois, a campanha pausa quando chega a vez dele.
  const selectedDevices = devices.filter((d) => draft.deviceIds.includes(deviceKey(d)));
  const chipProblems = network
    ? selectedDevices
        .map((d) => {
          const chips = network.chips.filter((c) => c.deviceId === d.id);
          if (chips.length === 0) return `${deviceLabel(d)}: sem chip cadastrado`;
          if (chips.length > 1) return `${deviceLabel(d)}: ${chips.length} chips cadastrados`;
          return "";
        })
        .filter(Boolean)
    : [];
  const chipNotes = network
    ? network.chips
        .filter((c) => c.state !== "normal" && selectedDevices.some((d) => d.id === c.deviceId))
        .map((c) => {
          const d = selectedDevices.find((x) => x.id === c.deviceId);
          return `${d ? deviceLabel(d) : c.deviceName}: ${c.reason || c.state}${c.replyRate !== null ? ` (respostas: ${c.replyRate.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%)` : ""}`;
        })
    : [];
  const windowOpen = withinSendWindow(new Date(now));
  const usedHour = network ? network.attemptsLastHour ?? network.sentLastHour : 0;
  const usedDay = network ? network.attemptsToday ?? network.sentToday : 0;

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
    if (msgError) {
      setError(msgError);
      setTab("settings");
      return false;
    }
    const delayErr = delayError(draft.delayMin, draft.delayMax);
    if (delayErr) {
      setError(delayErr);
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

  // Salvar aparelhos grava só os aparelhos sobre a campanha salva: a mensagem em edição fica como está.
  const handleSaveDevices = async () => {
    setBusy("saveDevices");
    try {
      const updated: Campaign = { ...campaign, deviceIds: draft.deviceIds };
      await api("update_campaign", { campaign: updated });
      onUpdateCampaign(updated);
      setError("");
      flash("devices");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const resumed = campaign.status === "paused" || (campaign.status as string) === "stopped" || sent + failed + review > 0;

  const handleRunBatch = async () => {
    if (!draft.deviceIds.length) {
      setError("Selecione ao menos um aparelho.");
      setTab("devices");
      return;
    }
    if (!pending) {
      setError("Não há contatos pendentes: importe uma lista antes de iniciar.");
      setTab("contacts");
      return;
    }
    setBusy("start");
    try {
      if (!(await saveConfiguration())) return;
      await api("start_campaign", { campaignId: campaign.id });
      clearLiveState(campaign.id);
      onUpdateCampaign(buildUpdated({ status: "running" }));
      onLog("info", resumed ? "Disparo retomado." : "Campanha iniciada no motor de disparo.");
      if (!withinSendWindow()) onLog("warning", `Fora do horário de envio: o primeiro envio sai ${formatWhen(nextWindowOpen())}.`);
      toast.success(resumed ? "Disparo retomado" : "Disparo iniciado", withinSendWindow() ? undefined : `Fora do horário: o primeiro envio sai ${formatWhen(nextWindowOpen())}.`);
    } catch (e) {
      setError(String(e));
      onRefresh();
    } finally {
      setBusy("");
    }
  };

  const handlePause = async () => {
    setBusy("pause");
    try {
      await api("pause_campaign", { campaignId: campaign.id });
      onUpdateCampaign({ ...campaign, status: "paused" });
      onLog("info", "Campanha pausada pelo operador.");
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
      onUpdateCampaign({ ...campaign, status: "stopped" as CampaignStatus });
      onLog("warning", "Disparo interrompido pelo operador.");
      onRefresh();
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
      await loadContacts();
      onUpdateCampaign({ ...campaign, failedCount: 0, status: "paused" });
      onLog("info", `${formatNumber(count)} ${count === 1 ? "falha devolvida" : "falhas devolvidas"} à fila para nova tentativa.`);
      setError("");
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      setConfirm("");
    }
  };

  const handleResetQueue = async () => {
    setBusy("reset");
    try {
      const count = await api<number>("reset_campaign_contacts", { campaignId: campaign.id });
      await loadContacts();
      onUpdateCampaign({ ...campaign, sentCount: 0, failedCount: 0, status: "draft" });
      onLog("info", `Fila reiniciada: ${formatNumber(count)} contatos de volta à fila.`);
      setError("");
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      setConfirm("");
    }
  };

  const requestBack = () => {
    if (settingsDirty || devicesDirty) setConfirm("leave");
    else onBack();
  };

  const openContacts = (f: ContactFilter) => {
    setContactsFilter(f);
    setTab("contacts");
  };

  const canReset = !isRunning && total > 0 && pending === 0;
  const canRetry = !isRunning && failed > 0;
  const resumeLabel = resumed ? "Retomar disparo" : "Iniciar disparo";

  type CheckItem = { ok: boolean; warn?: boolean; label: string; detail?: string; action?: ReactNode };
  const checklist: CheckItem[] = [
    {
      ok: !msgError,
      label: msgError ? "Mensagem com pendência" : "Mensagem pronta",
      detail: msgError,
      action: msgError && <LinkButton onClick={() => setTab("settings")}>Corrigir</LinkButton>,
    },
    {
      ok: pending > 0,
      label: pending > 0 ? `${formatNumber(pending)} contatos na fila` : "Contatos pendentes",
      detail: pending > 0 ? undefined : total > 0 ? "Todos já foram processados" : "Nenhum contato importado",
      action: pending === 0 && (total > 0 ? <LinkButton onClick={() => setConfirm("reset")}>Reiniciar fila</LinkButton> : <LinkButton onClick={onImport}>Importar</LinkButton>),
    },
    {
      ok: draft.deviceIds.length > 0,
      label: draft.deviceIds.length > 0 ? `${draft.deviceIds.length} ${draft.deviceIds.length === 1 ? "aparelho selecionado" : "aparelhos selecionados"}` : "Aparelhos selecionados",
      action: draft.deviceIds.length === 0 && <LinkButton onClick={() => setTab("devices")}>Selecionar</LinkButton>,
    },
    {
      ok: devStats.selectedOnline > 0,
      label: "Ao menos um aparelho online",
      detail: draft.deviceIds.length > 0 && !devicesLoading ? `${devStats.selectedOnline} de ${draft.deviceIds.length} online agora` : undefined,
      action: draft.deviceIds.length > 0 && devStats.selectedOnline === 0 && <LinkButton onClick={() => setTab("devices")}>Ver aparelhos</LinkButton>,
    },
  ];
  if (network && selectedDevices.length > 0) {
    checklist.push({
      ok: chipProblems.length === 0,
      label: chipProblems.length ? "Chip com problema" : "Um chip em cada aparelho",
      detail: chipProblems.length ? `${chipProblems.join(" · ")}. Ajuste em Dispositivos: sem isso a campanha pausa quando chegar a vez dele.` : undefined,
    });
  }
  checklist.push({
    ok: windowOpen,
    warn: !windowOpen,
    label: windowOpen ? "Dentro do horário de envio" : "Fora do horário de envio",
    detail: windowOpen ? "Seg–sex 8h–20h, sáb 8h–14h." : `Pode iniciar: o primeiro envio sai ${formatWhen(nextWindowOpen(new Date(now)), new Date(now))}.`,
  });

  const menuActions: MenuAction[] = [
    { label: "Importar contatos", icon: <Upload size={14} />, onSelect: onImport },
    { label: "Exportar contatos (CSV)", icon: <Download size={14} />, onSelect: () => exportCampaignContacts(campaign, contacts), disabled: contacts.length === 0 },
    { label: "Reprocessar falhas", icon: <RotateCcw size={14} />, onSelect: () => setConfirm("retry"), disabled: !canRetry },
    { label: "Reiniciar fila", icon: <RotateCcw size={14} />, onSelect: () => setConfirm("reset"), disabled: !canReset },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Cabeçalho */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={requestBack}
          className="inline-flex items-center gap-1.5 rounded-md text-[0.8125rem] text-secondary hover:text-[var(--color-text-primary)] cursor-pointer"
        >
          <ArrowLeft size={14} /> Campanhas
        </button>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="truncate text-[1.25rem] font-semibold leading-tight tracking-tight text-primary">{campaign.name}</h1>
              <Badge variant={status.variant} dot pulse={isRunning && (!live.main || live.main.kind === "sending")}>
                {status.label}
              </Badge>
              {isRunning && live.main && live.main.kind !== "sending" && (
                <span className={`inline-flex items-center gap-1 text-[0.75rem] font-medium ${liveToneStyle[live.main.tone]}`}>{live.main.short}</span>
              )}
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
            <Button variant="secondary" icon={<Pencil size={14} />} onClick={() => onEdit(buildUpdated())}>
              Editar
            </Button>
            {isRunning ? (
              <>
                <Button variant="secondary" icon={<Square size={13} />} onClick={() => setConfirm("stop")} disabled={!!busy}>
                  Parar
                </Button>
                <Button
                  variant="primary"
                  icon={<Pause size={14} />}
                  onClick={handlePause}
                  loading={busy === "pause"}
                  disabled={!!busy && busy !== "pause"}
                  title="Pausa os envios. Se um aparelho estiver digitando agora, essa mensagem é interrompida e o contato fica para revisão."
                >
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

      {autoPaused && live.main && (
        <InlineAlert
          tone="danger"
          icon={<AlertCircle size={15} />}
          title="A campanha foi pausada pelo sistema"
          action={
            <Button size="sm" variant="secondary" icon={<Smartphone size={13} />} onClick={() => setTab("devices")}>
              Ver aparelhos
            </Button>
          }
        >
          {live.main.text}
        </InlineAlert>
      )}

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
                  {formatNumber(total - pending)} de {formatNumber(total)} processados
                </p>
              </div>
              <div className="mt-4">
                <ProgressBar total={total} sent={sent} failed={failed} skipped={skipped + review} size="lg" completed={campaign.status === "completed"} />
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-5">
                <StatCard
                  label="Enviados"
                  value={formatNumber(sent)}
                  icon={<Send size={14} />}
                  tone="success"
                  hint={
                    review > 0 ? (
                      <LinkButton onClick={() => openContacts("review")}>
                        {formatNumber(review)} {review === 1 ? "parcial" : "parciais"}: revisar
                      </LinkButton>
                    ) : undefined
                  }
                />
                <StatCard
                  label="Falhas"
                  value={formatNumber(failed)}
                  icon={<XCircle size={14} />}
                  tone={failed > 0 ? "danger" : "neutral"}
                  hint={canRetry ? <LinkButton onClick={() => setConfirm("retry")}>{busy === "retry" ? "Reprocessando…" : "Reprocessar"}</LinkButton> : undefined}
                />
                <StatCard
                  label="Pulados"
                  value={formatNumber(skipped)}
                  icon={<Ban size={14} />}
                  hint={skipped > 0 ? <LinkButton onClick={() => openContacts("skipped")}>Ver quem</LinkButton> : "descadastro, sem WhatsApp"}
                />
                <StatCard label="Restantes" value={formatNumber(pending)} icon={<Users size={14} />} tone="info" />
                <StatCard
                  label="Término estimado"
                  value={pending > 0 && pace?.finish ? formatWhen(pace.finish, new Date(now)) : "—"}
                  icon={<Clock size={14} />}
                  hint={
                    pending > 0 && pace ? (
                      <span title={paceLimitText(pace, limits, parts)}>
                        ≈ {perHourText(pace.perHour)} por hora{isRunning ? "" : " · se iniciar agora"}
                      </span>
                    ) : undefined
                  }
                />
              </div>
              {pending > 0 && pace && (
                <p className="mt-3 text-[0.75rem] text-tertiary">
                  Estimativa só no horário de envio, {paceLimitText(pace, limits, parts)}. O teto da rede é dividido entre as campanhas em andamento.
                </p>
              )}
              {confirmations && (confirmations.pending > 0 || confirmations.sent > 0 || confirmations.uncertain > 0) && (
                <p className="mt-3 text-[0.8125rem] text-secondary">
                  Confirmações de SAIR: {formatNumber(confirmations.pending)} aguardam envio · {formatNumber(confirmations.sent)} enviadas
                  {confirmations.uncertain > 0 ? ` · ${formatNumber(confirmations.uncertain)} em revisão` : ""}
                </p>
              )}
              {canReset && (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-3">
                  <p className="text-[0.8125rem] text-secondary">Todos os contatos já foram processados.</p>
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => setConfirm("reset")}>
                    Reiniciar fila
                  </Button>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-primary">{isRunning ? "Disparo em andamento" : "Antes de disparar"}</h3>
              {isRunning ? (
                <div
                  role="status"
                  className={`mt-3 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[0.8125rem] ${
                    live.main?.tone === "danger"
                      ? "border-red-500/25 bg-red-500/[0.07]"
                      : live.main?.tone === "warning"
                      ? "border-amber-500/25 bg-amber-500/[0.07]"
                      : live.main?.tone === "info"
                      ? "border-sky-500/25 bg-sky-500/[0.07]"
                      : "border-emerald-500/25 bg-emerald-500/[0.07]"
                  }`}
                >
                  <span className={`mt-0.5 shrink-0 ${liveToneStyle[live.main?.tone ?? "success"]}`}>{liveToneIcon[live.main?.tone ?? "success"]}</span>
                  <div className="min-w-0">
                    <p className={`font-medium ${liveToneStyle[live.main?.tone ?? "success"]}`}>{live.main ? live.main.short : "Em andamento"}</p>
                    <p className="mt-0.5 text-secondary">
                      {live.main ? live.main.text : "As mensagens saem uma de cada vez, no ritmo configurado. Cada envio e cada espera aparecem na atividade abaixo."}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-0.5 text-[0.75rem] text-tertiary">Tudo marcado? Então é só iniciar.</p>
              )}
              {(live.notes.length > 0 || chipNotes.length > 0) && (
                <ul className="mt-3 space-y-1.5">
                  {chipNotes.map((n) => (
                    <li key={n} className="flex items-start gap-2 text-[0.75rem] text-amber-700 dark:text-amber-300">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {n}
                    </li>
                  ))}
                  {live.notes
                    .filter((n) => chipNotes.length === 0 || n.kind === "ai_warning")
                    .map((n) => (
                      <li key={n.kind} className={`flex items-start gap-2 text-[0.75rem] ${liveToneStyle[n.tone]}`}>
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {n.text}
                      </li>
                    ))}
                </ul>
              )}
              <ul className="mt-4 space-y-3">
                {checklist.map((item) => (
                  <li key={item.label} className="flex items-start gap-2.5">
                    {item.ok ? (
                      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : item.warn ? (
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
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
              {network && (
                <div className="mt-4 space-y-1 border-t border-border pt-3 text-[0.75rem] text-secondary">
                  <p className="font-medium text-primary">Teto da rede</p>
                  <p className="tabular-nums">
                    {formatNumber(usedHour)} de {formatNumber(network.hourly)} nesta hora · {formatNumber(usedDay)} de {formatNumber(network.daily)} hoje
                  </p>
                  {network.waitSeconds > 0 && (
                    <p className="text-amber-700 dark:text-amber-300">
                      Teto atingido: libera por volta de {formatWhen(new Date(now + network.waitSeconds * 1000), new Date(now))}.
                    </p>
                  )}
                  <p className="text-tertiary">Cada parte da mensagem conta uma vez ({parts} por contato).</p>
                </div>
              )}
            </div>
          </div>

          <LogConsole lines={logs} onClear={() => clearCampaignLogs(campaign.id)} />
        </div>
      )}

      {tab === "contacts" && (
        <ContactsPanel
          campaign={campaign}
          contacts={contacts}
          loading={contactsLoading}
          onImport={onImport}
          onReload={loadContacts}
          filter={contactsFilter}
          onFilterChange={setContactsFilter}
        />
      )}

      {tab === "devices" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-primary">Aparelhos autorizados</h2>
            <p className="mt-0.5 text-[0.8125rem] text-secondary">
              O motor reveza os envios entre os aparelhos selecionados que estiverem online, um contato por vez.
            </p>
          </div>
          {chipProblems.length > 0 && (
            <InlineAlert tone="warning" icon={<AlertTriangle size={15} />} title="Aparelho sem chip ou com mais de um">
              {chipProblems.join(" · ")}. Cadastre exatamente um chip em cada aparelho (Dispositivos); senão a campanha pausa quando chegar a vez dele.
            </InlineAlert>
          )}
          {devicesError && devices.length === 0 ? (
            <InlineAlert
              tone="danger"
              icon={<AlertCircle size={15} />}
              title="Não foi possível carregar os aparelhos"
              action={
                <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={loadDevices} loading={devicesLoading}>
                  Tentar de novo
                </Button>
              }
            >
              {devicesError}
            </InlineAlert>
          ) : (
            <DevicePicker
              devices={devices}
              loading={devicesLoading && devices.length === 0}
              selected={draft.deviceIds}
              onChange={(ids) => patch({ deviceIds: ids })}
              onRefresh={loadDevices}
              refreshing={devicesLoading}
              listClassName="max-h-[min(520px,55vh)]"
            />
          )}
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
              <FormSection title="Mensagem" description="Saudação, corpo e encerramento saem como mensagens seguidas, nesta ordem.">
                <MessageFields value={draft} onChange={(p) => patch(p)} partLimit={partLimit} />
              </FormSection>
              <FormSection title="Personalização com IA" description="Opcional. Usa a configuração de IA da empresa quando o provedor fica no padrão.">
                <AiFields value={draft} onChange={(p) => patch(p)} companyId={campaign.companyId} message={draft} />
              </FormSection>
              <FormSection title="Ritmo de envio" description="Intervalos aleatórios entre mensagens deixam o disparo mais natural.">
                <DelayFields
                  min={draft.delayMin}
                  max={draft.delayMax}
                  onChange={(p) => patch(p)}
                  pendingContacts={pending}
                  parts={parts}
                  devices={Math.max(1, devStats.selectedOnline || draft.deviceIds.length)}
                />
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
              {settingsDirty && msgError && <span className="ml-2 text-red-600 dark:text-red-400">Corrija a mensagem para salvar.</span>}
            </p>
            <div className="flex items-center gap-2">
              {settingsDirty && (
                <Button variant="ghost" onClick={() => setDraft((d) => ({ ...draftFrom(campaign), deviceIds: d.deviceIds }))}>
                  Descartar
                </Button>
              )}
              <Button onClick={handleSaveSettings} loading={busy === "save"} disabled={!settingsDirty || !!delayError(draft.delayMin, draft.delayMax) || !!msgError}>
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
        <p>
          Parar encerra o disparo e apaga dos celulares os contatos temporários desta campanha (ao retomar, eles são salvos de novo). Para um intervalo, como
          o almoço, prefira <strong className="text-primary">Pausar</strong>.
        </p>
        <p className="mt-2">
          Quem ainda não recebeu continua na fila. Se um aparelho estiver digitando agora, essa mensagem é interrompida e o contato fica para revisão.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === "retry"}
        title={`Reprocessar ${formatNumber(failed)} ${failed === 1 ? "falha" : "falhas"}?`}
        confirmLabel="Reprocessar"
        danger={false}
        loading={busy === "retry"}
        onConfirm={handleRetryFailures}
        onClose={() => setConfirm("")}
      >
        Os contatos com falha voltam para a fila e são tentados de novo (até 3 vezes cada) quando você retomar. Falhas repetidas contam no freio automático do
        chip e podem pausar a campanha: se o problema for do aparelho, resolva antes.
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === "reset"}
        title="Reiniciar a fila?"
        confirmLabel="Reiniciar fila"
        loading={busy === "reset"}
        onConfirm={handleResetQueue}
        onClose={() => setConfirm("")}
      >
        <p>
          Os {formatNumber(total)} contatos voltam para “pendente”, os contadores de enviados e falhas voltam a zero e a campanha volta a rascunho. Quem já
          recebeu nesta campanha não recebe de novo, e os descadastrados continuam fora.
        </p>
        {review > 0 && (
          <p className="mt-2 text-amber-700 dark:text-amber-300">
            Atenção: {formatNumber(review)} {review === 1 ? "contato com envio parcial volta" : "contatos com envio parcial voltam"} à fila e podem receber
            partes repetidas. Confira esses contatos antes (Contatos → Revisar).
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={confirm === "leave"}
        title="Sair sem salvar?"
        confirmLabel="Sair sem salvar"
        onConfirm={() => {
          setConfirm("");
          onBack();
        }}
        onClose={() => setConfirm("")}
      >
        Há alterações não salvas em {settingsDirty && devicesDirty ? "Configurações e Aparelhos" : settingsDirty ? "Configurações" : "Aparelhos"}. Elas serão
        perdidas.
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

// ============================================================
// CampaignList
// ============================================================

// Lista densa de campanhas (linhas clicáveis com progresso, estado ao vivo e ações).

const GRID = "lg:grid lg:grid-cols-[minmax(0,2.3fr)_10rem_minmax(0,1.6fr)_5rem_6.5rem_8.5rem] lg:items-center lg:gap-4";

export function CampaignListSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-4 last:border-b-0">
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-1/3 rounded" />
            <div className="skeleton h-3 w-1/2 rounded" />
          </div>
          <div className="skeleton hidden h-2 w-48 rounded-full md:block" />
        </div>
      ))}
    </div>
  );
}

// Selo de status com o estado ao vivo embaixo ("Fora do horário · volta seg 08:00", "Teto da rede atingido"...).
function CampaignStatusCell({ c, now }: { c: Campaign; now: number }) {
  const live = liveSummary(c, campaignActivity(c.id), now);
  const autoPaused = c.status === "paused" && live.main?.kind === "auto_paused";
  const st = autoPaused ? { variant: "danger" as BadgeVariant, label: "Pausada pelo sistema" } : statusInfo(c.status);
  const sub = live.main && live.main.kind !== "sending" && (c.status === "running" || autoPaused) ? live.main : undefined;
  return (
    <div className="min-w-0" title={sub?.text}>
      <Badge variant={st.variant} dot pulse={c.status === "running" && !sub}>
        {st.label}
      </Badge>
      {sub && !autoPaused && <p className={`mt-1 truncate text-[0.6875rem] font-medium ${liveToneStyle[sub.tone]}`}>{sub.short}</p>}
    </div>
  );
}

function CampaignList({
  campaigns,
  onOpen,
  onEdit,
  onImport,
  onDelete,
  onQuickToggle,
  quickBusyId,
  now,
  selecting,
  selectedIds,
  onToggle,
  canDelete,
}: {
  campaigns: Campaign[];
  onOpen: (c: Campaign, tab?: DetailTab) => void;
  onEdit: (c: Campaign) => void;
  onImport: (c: Campaign) => void;
  onDelete: (c: Campaign) => void;
  /** Pausar (em andamento) ou retomar (pausada/interrompida) sem abrir a campanha. */
  onQuickToggle: (c: Campaign) => void;
  quickBusyId: number | null;
  now: number;
  selecting: boolean;
  selectedIds: Set<number>;
  onToggle: (id: number) => void;
  canDelete: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className={`hidden rounded-t-xl border-b border-border bg-secondary px-4 py-2.5 text-[0.75rem] font-medium text-secondary ${GRID}`}>
        <span>Campanha</span>
        <span>Status</span>
        <span>Progresso</span>
        <span>Aparelhos</span>
        <span>Atualizada</span>
        <span className="sr-only">Ações</span>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {campaigns.map((c) => {
          const { total, sent, failed, skipped, progress } = countsFromCampaign(c);
          const deviceCount = (c.deviceIds || []).length;
          const preview = [c.greeting, c.message].filter(Boolean).join(" ");
          const running = c.status === "running";
          const canResume = c.status === "paused" || (c.status as string) === "stopped";
          return (
            <li
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onOpen(c);
              }}
              className={`group cursor-pointer px-4 py-3.5 last:rounded-b-xl max-lg:first:rounded-t-xl transition-colors hover:bg-[var(--color-bg-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-accent)] ${GRID}`}
            >
              {/* Nome */}
              <div className="flex min-w-0 items-start justify-between gap-3">
                {selecting && <input type="checkbox" aria-label={`Selecionar ${c.name}`} checked={selectedIds.has(c.id)} disabled={running} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => onToggle(c.id)} className="mt-1 accent-[var(--color-accent)]" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-primary">{c.name}</p>
                    {campaignUsesAi(c) && <Badge variant="purple">IA</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[0.75rem] text-tertiary">{preview || "Sem mensagem"}</p>
                </div>
                <div className="shrink-0 lg:hidden">
                  <CampaignStatusCell c={c} now={now} />
                </div>
              </div>

              {/* Status */}
              <div className="hidden min-w-0 lg:block">
                <CampaignStatusCell c={c} now={now} />
              </div>

              {/* Progresso */}
              <div className="mt-3 min-w-0 lg:mt-0">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[0.75rem]">
                  <span className="truncate tabular-nums text-secondary">
                    <span className="text-primary">{formatNumber(sent)}</span> / {formatNumber(total)}
                    {failed > 0 && <span className="ml-1.5 text-red-600 dark:text-red-400">· {formatNumber(failed)} falhas</span>}
                    {skipped > 0 && <span className="ml-1.5 text-tertiary">· {formatNumber(skipped)} sem envio</span>}
                  </span>
                  <span className="tabular-nums text-tertiary">{progress}%</span>
                </div>
                <ProgressBar total={total} sent={sent} failed={failed} skipped={skipped} completed={c.status === "completed"} />
              </div>

              {/* Aparelhos + data (no mobile ficam numa linha) */}
              <div className="mt-2.5 flex items-center gap-4 text-[0.75rem] text-secondary lg:contents">
                <span className={`inline-flex items-center gap-1.5 tabular-nums ${deviceCount === 0 ? "text-amber-700 dark:text-amber-300" : ""}`}>
                  <Smartphone size={13} className="text-tertiary" />
                  {deviceCount === 0 ? "Nenhum" : deviceCount}
                </span>
                <span className="tabular-nums text-tertiary">{formatDate(c.updatedAt)}</span>
              </div>

              {/* Ações */}
              <div className="mt-2 flex items-center justify-end gap-0.5 lg:mt-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {(running || canResume) && (
                  <button
                    type="button"
                    aria-label={running ? `Pausar ${c.name}` : `Retomar ${c.name}`}
                    title={running ? "Pausar" : "Retomar"}
                    disabled={quickBusyId === c.id}
                    onClick={() => onQuickToggle(c)}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-40 disabled:cursor-wait cursor-pointer"
                  >
                    {quickBusyId === c.id ? <RefreshCw size={14} className="animate-spin" /> : running ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Editar ${c.name}`}
                  title="Editar"
                  onClick={() => onEdit(c)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
                >
                  <Pencil size={14} />
                </button>
                {canDelete && <button type="button" aria-label={`Excluir ${c.name}`} title={running ? "Pare a campanha antes de excluir" : "Excluir campanha"} disabled={running} onClick={() => onDelete(c)} className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed">
                  <Trash2 size={14} />
                </button>}
                <ActionMenu
                  label={`Mais ações para ${c.name}`}
                  actions={[
                    { label: "Abrir campanha", icon: <LayoutDashboard size={14} />, onSelect: () => onOpen(c) },
                    { label: "Importar contatos", icon: <Upload size={14} />, onSelect: () => onImport(c) },
                    { label: "Ver contatos", icon: <Users size={14} />, onSelect: () => onOpen(c, "contacts") },
                    { label: "Escolher aparelhos", icon: <Smartphone size={14} />, onSelect: () => onOpen(c, "devices") },
                    { label: "Configurações", icon: <Settings2 size={14} />, onSelect: () => onOpen(c, "settings") },
                    { label: "Editar", icon: <Pencil size={14} />, onSelect: () => onEdit(c) },
                  ]}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================
// Página
// ============================================================

type StatusFilter = "all" | "running" | "paused" | "completed" | "draft" | "error";

// Em andamento primeiro, depois pausadas, rascunhos e concluídas; dentro de cada grupo, a mais recente.
const STATUS_ORDER: Record<string, number> = { running: 0, paused: 1, stopped: 1, error: 1, draft: 2, completed: 3 };
function sortCampaigns(list: Campaign[]) {
  return [...list].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4) || (b.updatedAt || "").localeCompare(a.updatedAt || "") || b.id - a.id
  );
}

export default function CampaignsTab() {
  const { selectedCompanyId, user } = useAuth();
  const [campaignsList, setCampaignsList] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Navegação interna: lista ou detalhe de uma campanha
  const [detail, setDetail] = useState<{ id: number; tab: DetailTab } | null>(null);
  const [wizard, setWizard] = useState<{ campaign: Campaign | null } | null>(null);
  const [importForId, setImportForId] = useState<number | null>(null);
  const [aiGlobalModalOpen, setAiGlobalModalOpen] = useState(false);
  const [optOutOpen, setOptOutOpen] = useState(false);
  const [importRevision, setImportRevision] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<Campaign[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [quickBusyId, setQuickBusyId] = useState<number | null>(null);
  const [listError, setListError] = useState("");
  const [reviewCount, setReviewCount] = useState(0);
  const canDelete = user?.role !== "colaborador";
  const partLimit = partLimitOf(useNetworkLimits());
  const appendLog = appendCampaignLog;

  // A atividade ao vivo é ouvida uma vez para o app inteiro e guardada no módulo.
  useEffect(() => {
    ensureProgressListener();
  }, []);
  useActivityVersion();
  const now = useNow(campaignsList.some((c) => c.status === "running" || c.status === "paused"));

  const loadCampaigns = useCallback(() => {
    let mounted = true;
    if (!selectedCompanyId) {
      setCampaignsList([]);
      setLoading(false);
      return () => {};
    }
    setLoading(true);
    setLoadError("");
    api<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
      .then((data) => {
        if (mounted) setCampaignsList(data);
      })
      .catch((err) => {
        // Sem dados de exemplo: falha aparece como falha, com "Tentar de novo".
        if (!mounted) return;
        setCampaignsList([]);
        setLoadError(String(err));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [selectedCompanyId]);

  useEffect(() => {
    setDetail(null);
    setSelecting(false);
    setSelectedIds(new Set());
    setDeleteTargets(null);
    setDeleteError("");
    setListError("");
    return loadCampaigns();
  }, [loadCampaigns]);

  // Atualiza a lista ao vivo conforme o motor de disparos emite progresso (1x a cada 2s no máx)
  const refreshCampaigns = useCallback(() => {
    if (!selectedCompanyId) return;
    api<Campaign[]>("get_campaigns", { companyId: selectedCompanyId })
      .then((data) => {
        setCampaignsList(data);
        setLoadError("");
      })
      .catch(() => {
        /* mantém lista atual */
      });
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let lastRefresh = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    listen<ProgressPayload>("campaign-progress", () => {
      // Atualiza no máximo a cada 2s, mas nunca perde o último evento (ex.: "completed").
      const t = Date.now();
      if (trailing) clearTimeout(trailing);
      if (t - lastRefresh >= 2000) {
        lastRefresh = t;
        refreshCampaigns();
      } else {
        trailing = setTimeout(() => {
          lastRefresh = Date.now();
          refreshCampaigns();
        }, 2000 - (t - lastRefresh));
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (trailing) clearTimeout(trailing);
      unlisten?.();
    };
  }, [selectedCompanyId, refreshCampaigns]);

  // Pedidos de SAIR sem número identificável: enquanto ninguém revisa, não bloqueiam envio nenhum.
  const loadReviews = useCallback(() => {
    if (!selectedCompanyId) {
      setReviewCount(0);
      return;
    }
    api<unknown[]>("list_opt_out_reviews", { companyId: selectedCompanyId })
      .then((list) => setReviewCount(Array.isArray(list) ? list.length : 0))
      .catch(() => setReviewCount(0));
  }, [selectedCompanyId]);

  useEffect(() => {
    loadReviews();
    const t = setInterval(loadReviews, 60_000);
    return () => clearInterval(t);
  }, [loadReviews]);

  const upsertCampaign = (c: Campaign) =>
    setCampaignsList((prev) => {
      const idx = prev.findIndex((x) => x.id === c.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = c;
        return updated;
      }
      return [c, ...prev];
    });

  // Salvar pelo assistente não traz contadores antigos: mantém status e números ao vivo da lista.
  const mergeSavedCampaign = (saved: Campaign) =>
    setCampaignsList((prev) => {
      const idx = prev.findIndex((x) => x.id === saved.id);
      if (idx < 0) return [saved, ...prev];
      const cur = prev[idx];
      const next = [...prev];
      next[idx] = { ...saved, status: cur.status, contactsCount: cur.contactsCount, sentCount: cur.sentCount, failedCount: cur.failedCount };
      return next;
    });

  // Pausar ou retomar direto da lista. Retomar confere a mensagem como o detalhe confere; com pendência, abre as configurações.
  const quickToggle = async (c: Campaign) => {
    setListError("");
    if (c.status !== "running") {
      const issue =
        messageError({ greeting: c.greeting || "", body: c.message || "", closing: c.closing || "", useSpintax: c.useSpintax ?? true }, partLimit) ||
        delayError(c.delayMin, c.delayMax);
      if (issue) {
        setListError(`${c.name}: ${issue}`);
        setDetail({ id: c.id, tab: "settings" });
        return;
      }
    }
    setQuickBusyId(c.id);
    try {
      if (c.status === "running") {
        await api("pause_campaign", { campaignId: c.id });
        upsertCampaign({ ...c, status: "paused" });
        appendLog(c.id, "info", "Campanha pausada pelo operador.");
        toast.info("Campanha pausada", c.name);
      } else {
        await api("start_campaign", { campaignId: c.id });
        clearLiveState(c.id);
        upsertCampaign({ ...c, status: "running" });
        appendLog(c.id, "info", "Disparo retomado.");
        toast.success("Disparo retomado", withinSendWindow() ? c.name : `${c.name}: fora do horário, o primeiro envio sai ${formatWhen(nextWindowOpen())}.`);
      }
    } catch (e) {
      setListError(`${c.name}: ${String(e)}`);
    } finally {
      setQuickBusyId(null);
      refreshCampaigns();
    }
  };

  // ---- Métricas e filtros ----
  const counts = useMemo(() => {
    const by = (s: string[]) => campaignsList.filter((c) => s.includes(c.status)).length;
    return {
      all: campaignsList.length,
      running: by(["running"]),
      paused: by(["paused", "stopped"]),
      completed: by(["completed"]),
      draft: by(["draft"]),
      error: by(["error"]),
    };
  }, [campaignsList]);

  const totalSent = campaignsList.reduce((acc, c) => acc + (c.sentCount || 0), 0);
  const totalFailed = campaignsList.reduce((acc, c) => acc + (c.failedCount || 0), 0);
  const totalContacts = campaignsList.reduce((acc, c) => acc + (c.contactsCount || 0), 0);
  const totalPending = campaignsList.reduce((acc, c) => acc + countsFromCampaign(c).pending, 0);

  const query = plainText(searchQuery);
  const filteredCampaigns = sortCampaigns(
    campaignsList.filter((c) => {
      const matchesSearch = !query || plainText(c.name).includes(query) || plainText(`${c.greeting} ${c.message} ${c.closing}`).includes(query);
      const matchesStatus =
        statusFilter === "all" || c.status === statusFilter || (statusFilter === "paused" && (c.status as string) === "stopped");
      return matchesSearch && matchesStatus;
    })
  );

  const deleteCampaigns = async () => {
    if (!deleteTargets || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    const deleted: number[] = [];
    const failures: string[] = [];
    for (const campaign of deleteTargets) {
      try {
        await api("soft_delete_campaign", { campaignId: campaign.id });
        deleted.push(campaign.id);
      } catch (error) {
        failures.push(`${campaign.name}: ${String(error)}`);
      }
    }
    setCampaignsList((prev) => prev.filter((c) => !deleted.includes(c.id)));
    setSelectedIds((prev) => new Set([...prev].filter((id) => !deleted.includes(id))));
    setDeleteTargets(null);
    setDeleteError(failures.join(" · "));
    setDeleteBusy(false);
    refreshCampaigns();
  };

  const openDetail = (c: Campaign, tab: DetailTab = "overview") => setDetail({ id: c.id, tab });
  const detailCampaign = detail ? campaignsList.find((c) => c.id === detail.id) || null : null;
  // A importação lê a campanha ao vivo (status muda durante o disparo).
  const importCampaign = importForId !== null ? campaignsList.find((c) => c.id === importForId) ?? null : null;

  // ---- Modais compartilhados (lista e detalhe) ----
  const modals = (
    <>
      {wizard && (
        <CampaignWizard
          isOpen
          onClose={() => setWizard(null)}
          campaign={wizard.campaign}
          onSaved={(saved, meta) => {
            mergeSavedCampaign(saved);
            setSyncRevision((r) => r + 1);
            if (meta.openAfter) {
              // Campanha nova: abre a importação direto, que é o próximo passo.
              setDetail({ id: saved.id, tab: "contacts" });
              setImportForId(saved.id);
            }
            appendLog(saved.id, "info", meta.created ? "Campanha criada." : "Alterações da campanha salvas.");
            if (meta.openAfter) toast.success("Campanha criada", "Agora importe a lista de contatos.");
            else toast.success(meta.created ? "Rascunho salvo" : "Alterações salvas", saved.name);
            refreshCampaigns();
          }}
        />
      )}

      <ContactImportModal
        isOpen={importCampaign !== null}
        onClose={() => setImportForId(null)}
        campaign={importCampaign}
        onImported={(s) => {
          if (!importCampaign) return;
          setImportRevision((r) => r + 1);
          refreshCampaigns();
          const parts = [
            s.mode === "replace"
              ? `${formatNumber(s.imported)} na fila (substituíram ${formatNumber(s.replacedPending)} pendentes)`
              : `${formatNumber(s.imported)} ${s.imported === 1 ? "contato somado" : "contatos somados"} à fila`,
          ];
          if (s.optedOut) parts.push(`${formatNumber(s.optedOut)} descadastrados não recebem`);
          if (s.alreadyInCampaign) parts.push(`${formatNumber(s.alreadyInCampaign)} já estavam na campanha`);
          appendLog(importCampaign.id, "info", `Lista importada: ${parts.join(" · ")}.`);
          toast.success("Lista importada", parts.join(" · "));
        }}
      />

      {aiGlobalModalOpen && <GlobalAiConfigModal isOpen={aiGlobalModalOpen} onClose={() => setAiGlobalModalOpen(false)} />}
      {optOutOpen && selectedCompanyId && (
        <OptOutModal
          companyId={selectedCompanyId}
          onClose={() => {
            setOptOutOpen(false);
            loadReviews();
          }}
        />
      )}
      <ConfirmDialog isOpen={deleteTargets !== null} title={deleteTargets?.length === 1 ? "Excluir campanha" : "Excluir campanhas"} confirmLabel="Excluir" loading={deleteBusy} onClose={() => { if (!deleteBusy) setDeleteTargets(null); }} onConfirm={deleteCampaigns}>
        <p>Excluir {deleteTargets?.length === 1 ? `a campanha “${deleteTargets[0].name}”` : `${deleteTargets?.length ?? 0} campanhas selecionadas`} e seus contatos da lista?</p>
      </ConfirmDialog>
    </>
  );

  // ---- Detalhe da campanha ----
  if (detail && detailCampaign) {
    return (
      <>
        <CampaignDetail
          campaign={detailCampaign}
          syncRevision={syncRevision}
          importRevision={importRevision}
          initialTab={detail.tab}
          onBack={() => setDetail(null)}
          onEdit={(current) => setWizard({ campaign: current })}
          onImport={() => setImportForId(detailCampaign.id)}
          onUpdateCampaign={upsertCampaign}
          onRefresh={refreshCampaigns}
        />
        {modals}
      </>
    );
  }

  // ---- Lista ----
  const statusItems: { id: StatusFilter; label: string; count: number }[] = [
    { id: "all", label: "Todas", count: counts.all },
    { id: "running", label: "Em andamento", count: counts.running },
    { id: "paused", label: "Pausadas", count: counts.paused },
    { id: "completed", label: "Concluídas", count: counts.completed },
    { id: "draft", label: "Rascunhos", count: counts.draft },
  ];
  if (counts.error > 0 || statusFilter === "error") statusItems.push({ id: "error", label: "Com erro", count: counts.error });

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Campanhas"
        description="Crie, acompanhe e controle os disparos de WhatsApp da empresa."
        actions={
          <>
            <Button variant="secondary" icon={<Ban size={15} />} onClick={() => setOptOutOpen(true)} disabled={!selectedCompanyId}>
              Descadastrados
              {reviewCount > 0 && (
                <span className="rounded-full bg-amber-500/15 px-1.5 text-[0.6875rem] tabular-nums text-amber-700 dark:text-amber-300" title="Pedidos de SAIR aguardando revisão">
                  {reviewCount}
                </span>
              )}
            </Button>
            <Button variant="secondary" icon={<Brain size={15} />} onClick={() => setAiGlobalModalOpen(true)} disabled={!selectedCompanyId}>
              Configurar IA
            </Button>
            {canDelete && <Button variant="secondary" icon={<Trash2 size={15} />} disabled={!selectedCompanyId || campaignsList.length === 0} onClick={() => { setSelecting((v) => !v); setSelectedIds(new Set()); setDeleteError(""); }}>
              {selecting ? "Cancelar seleção" : "Excluir em massa"}
            </Button>}
            <Button icon={<Plus size={15} />} onClick={() => setWizard({ campaign: null })} disabled={!selectedCompanyId}>
              Nova campanha
            </Button>
          </>
        }
      />

      {!selectedCompanyId ? (
        <EmptyState
          icon={<Building2 size={18} />}
          title="Nenhuma empresa selecionada"
          description="Escolha uma empresa para ver e criar campanhas."
        />
      ) : (
        <>
          {reviewCount > 0 && (
            <InlineAlert
              tone="warning"
              icon={<AlertTriangle size={15} />}
              title={`${formatNumber(reviewCount)} ${reviewCount === 1 ? "pedido de SAIR aguarda" : "pedidos de SAIR aguardam"} revisão`}
              action={
                <Button size="sm" variant="secondary" onClick={() => setOptOutOpen(true)}>
                  Revisar
                </Button>
              }
            >
              Chegaram sem um número identificável. Enquanto ninguém informa o número, essas pessoas ainda podem receber mensagens.
            </InlineAlert>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="Campanhas"
              value={loading ? "—" : formatNumber(campaignsList.length)}
              icon={<Megaphone size={14} />}
              tone="accent"
              hint={counts.draft ? `${counts.draft} em rascunho` : undefined}
            />
            <StatCard
              label="Em andamento"
              value={loading ? "—" : formatNumber(counts.running)}
              icon={<Play size={14} />}
              tone="success"
              onClick={counts.running ? () => setStatusFilter("running") : undefined}
            />
            <StatCard
              label="Mensagens enviadas"
              value={loading ? "—" : formatNumber(totalSent)}
              icon={<Send size={14} />}
              tone="info"
              hint={totalFailed ? `${formatNumber(totalFailed)} falhas` : undefined}
            />
            <StatCard
              label="Contatos"
              value={loading ? "—" : formatNumber(totalContacts)}
              icon={<Users size={14} />}
              hint={totalContacts ? `${formatNumber(totalPending)} aguardando envio` : undefined}
            />
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Buscar por nome ou texto da mensagem" className="md:w-80" />
            <div className="overflow-x-auto">
              <SegmentedControl<StatusFilter> items={statusItems} value={statusFilter} onChange={setStatusFilter} />
            </div>
          </div>
          {listError && (
            <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Não foi possível concluir a ação" onDismiss={() => setListError("")}>
              {listError}
            </InlineAlert>
          )}
          {deleteError && <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Não foi possível excluir todas as campanhas">{deleteError}</InlineAlert>}
          {selecting && <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" onClick={() => setSelectedIds((prev) => {
              const visible = filteredCampaigns.filter((c) => c.status !== "running").map((c) => c.id);
              const next = new Set(prev);
              if (visible.every((id) => next.has(id))) visible.forEach((id) => next.delete(id));
              else visible.forEach((id) => next.add(id));
              return next;
            })}>Selecionar visíveis</Button>
            <span className="text-xs text-secondary">{selectedIds.size} selecionada(s). Campanhas em andamento não podem ser excluídas.</span>
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={selectedIds.size === 0} onClick={() => { setDeleteError(""); setDeleteTargets(campaignsList.filter((c) => selectedIds.has(c.id) && c.status !== "running")); }}>Excluir selecionadas</Button>
          </div>}

          {loading && campaignsList.length === 0 ? (
            <CampaignListSkeleton />
          ) : loadError && campaignsList.length === 0 ? (
            <EmptyState
              icon={<AlertCircle size={18} />}
              title="Não foi possível carregar as campanhas"
              description={loadError}
              action={
                <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={() => loadCampaigns()}>
                  Tentar de novo
                </Button>
              }
            />
          ) : campaignsList.length === 0 ? (
            <EmptyState
              icon={<Megaphone size={18} />}
              title="Nenhuma campanha ainda"
              description="Crie a primeira campanha: escreva a mensagem, escolha os aparelhos e importe os contatos."
              action={
                <Button icon={<Plus size={15} />} onClick={() => setWizard({ campaign: null })}>
                  Nova campanha
                </Button>
              }
            />
          ) : filteredCampaigns.length === 0 ? (
            <EmptyState
              icon={<Search size={18} />}
              title="Nenhuma campanha encontrada"
              description="Nenhuma campanha corresponde à busca ou ao filtro de status."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearchQuery("");
                    setStatusFilter("all");
                  }}
                >
                  Limpar filtros
                </Button>
              }
            />
          ) : (
            <CampaignList
              campaigns={filteredCampaigns}
              onOpen={openDetail}
              onEdit={(c) => setWizard({ campaign: c })}
              onImport={(c) => setImportForId(c.id)}
              onDelete={(c) => { setDeleteError(""); setDeleteTargets([c]); }}
              onQuickToggle={quickToggle}
              quickBusyId={quickBusyId}
              now={now}
              selecting={selecting}
              selectedIds={selectedIds}
              onToggle={(id) => setSelectedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
              canDelete={canDelete}
            />
          )}
        </>
      )}

      {modals}
    </div>
  );
}

// ============================================================
// Descadastrados (opt-out)
// ============================================================

type OptOut = {
  phone: string;
  reason: string;
  createdAt: string;
  addedBy?: string | null;
  removedBy?: string | null;
  removedAt?: string | null;
};

type OptOutReviewItem = {
  id: number;
  companyId: number;
  title: string;
  text: string;
  device: string;
  status: string;
  resolvedPhone?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
};

type OptOutAuditItem = {
  id: number;
  companyId: number;
  phone: string;
  action: string;
  actorName: string;
  actorRole: string;
  detail: string;
  createdAt: string;
};

/** Mesma regra do backend (Database::opt_out_key): só dígitos, sem DDI 55 e sem o 9º dígito. */
function optOutKey(phone: string) {
  let d = phone.replace(/\D/g, "").replace(/^0+/, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2); // DDD 55 (RS) também existe
  return d.length === 11 && d[2] === "9" ? d.slice(0, 2) + d.slice(3) : d;
}

function formatOptOutPhone(d: string) {
  // chave sem DDI e sem o 9º dígito: "7588052539" -> "(75) 8805-2539"
  return d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d;
}

function OptOutModal({ companyId, onClose }: { companyId: number; onClose: () => void }) {
  const { user } = useAuth();
  const canRemove = user?.role === "master" || user?.role === "gestor";
  const [items, setItems] = useState<OptOut[]>([]);
  const [reviews, setReviews] = useState<OptOutReviewItem[]>([]);
  const [audits, setAudits] = useState<OptOutAuditItem[]>([]);
  const [reviewPhones, setReviewPhones] = useState<Record<number, string>>({});
  const [reviewBusyId, setReviewBusyId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api<OptOut[]>("list_opt_outs", { companyId }),
      api<OptOutReviewItem[]>("list_opt_out_reviews", { companyId }).catch(() => [] as OptOutReviewItem[]),
      api<OptOutAuditItem[]>("list_opt_out_audit", { companyId }).catch(() => [] as OptOutAuditItem[]),
    ])
      .then(([optOuts, revs, auds]) => {
        setItems(optOuts);
        setReviews(revs);
        setAudits(auds);
      })
      .catch((e) => setMsg({ ok: false, text: String(e) }))
      .finally(() => setLoading(false));
  }, [companyId]);
  useEffect(load, [load]);

  const phones = text.split(/[\n,;]+/).map((l) => l.trim()).filter((l) => l.length > 0);

  const add = async () => {
    if (!phones.length) return;
    setBusy(true);
    try {
      const n = await api<number>("add_opt_outs", { companyId, phones, reason: "Pediu para não receber (SAIR)" });
      setMsg({ ok: true, text: `${n} número(s) descadastrado(s). Envios pendentes foram cancelados.` });
      setText("");
      load();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Remover devolve o número a todas as campanhas: só com confirmação.
  const remove = async (phone: string) => {
    setRemoving(true);
    try {
      await api("remove_opt_out", { companyId, phone });
      setMsg({ ok: true, text: `Número ${formatOptOutPhone(phone)} removido do descadastro.` });
      load();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  };

  const searchKey = search.replace(/\D/g, "") ? optOutKey(search) : "";
  const visibleItems = search.trim()
    ? items.filter((it) => (searchKey && it.phone.includes(searchKey)) || (it.reason || "").toLowerCase().includes(search.trim().toLowerCase()))
    : items;

  const resolveReview = async (reviewId: number) => {
    const phone = (reviewPhones[reviewId] || "").trim();
    if (!phone) {
      setMsg({ ok: false, text: "Informe o DDD + número para descadastrar este pedido." });
      return;
    }
    setReviewBusyId(reviewId);
    try {
      const suppressed = await api<number>("resolve_opt_out_review", { companyId, reviewId, phone });
      setMsg({
        ok: true,
        text: `Número descadastrado com sucesso (${suppressed} envio(s) pendente(s) cancelado(s)).`,
      });
      setReviewPhones((prev) => {
        const next = { ...prev };
        delete next[reviewId];
        return next;
      });
      load();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setReviewBusyId(null);
    }
  };

  const discardReview = async (reviewId: number) => {
    setReviewBusyId(reviewId);
    try {
      await api("discard_opt_out_review", { companyId, reviewId });
      load();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setReviewBusyId(null);
    }
  };

  const removedAudits = audits.filter((a) => a.action === "remove");

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Descadastrados"
      description="Quem respondeu SAIR ou pediu para não receber mensagens. Esses números são pulados em todas as campanhas."
      size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Fechar</Button>}
    >
      <div className="space-y-5">
        <Field label="Adicionar números" hint="Um por linha com DDD obrigatório (ex.: 75 98805-2539). Aceita com ou sem DDI e com ou sem o 9.">
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"75 98805-2539\n11 91234-5678"} className="font-mono" />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[0.75rem] text-tertiary">{phones.length ? `${phones.length} número(s) para adicionar` : "Nenhum número digitado"}</span>
          <Button icon={<Ban size={14} />} onClick={add} loading={busy} disabled={!phones.length}>
            Descadastrar
          </Button>
        </div>
        {msg && (
          <p className={`text-[0.8125rem] ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{msg.text}</p>
        )}

        {/* Seção Para revisar: pedidos de SAIR capturados sem número identificável */}
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-[0.8125rem] font-medium text-primary">Para revisar</span>
            <span className="text-[0.75rem] tabular-nums text-tertiary">{reviews.length}</span>
          </div>
          {reviews.length === 0 ? (
            <p className="px-4 py-4 text-center text-[0.8125rem] text-tertiary">Nenhum pedido pendente de revisão.</p>
          ) : (
            <ul className="max-h-56 divide-y divide-[var(--color-border)] overflow-y-auto custom-scrollbar">
              {reviews.map((rev) => (
                <li key={rev.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[0.8125rem] font-medium text-primary">{rev.title || "Remetente sem número"}</p>
                      <p className="text-[0.75rem] text-secondary">“{rev.text || "SAIR"}”</p>
                      <p className="text-[0.7rem] text-tertiary">
                        Aparelho: {rev.device || "—"} · {formatDate(rev.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={reviewPhones[rev.id] || ""}
                      onChange={(e) => setReviewPhones((prev) => ({ ...prev, [rev.id]: e.target.value }))}
                      placeholder="DDD + número (ex.: 75 98805-2539)"
                      aria-label={`Número de quem pediu SAIR (${rev.title || "remetente sem número"})`}
                      className="!h-8 !w-auto min-w-[12rem] flex-1 font-mono !text-[0.75rem]"
                    />
                    <Button
                      size="sm"
                      icon={<Ban size={13} />}
                      loading={reviewBusyId === rev.id}
                      onClick={() => resolveReview(rev.id)}
                    >
                      Descadastrar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<X size={13} />}
                      disabled={reviewBusyId === rev.id}
                      onClick={() => discardReview(rev.id)}
                    >
                      Descartar
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="text-[0.8125rem] font-medium text-primary">
              Lista <span className="ml-1 text-[0.75rem] font-normal tabular-nums text-tertiary">{items.length}</span>
            </span>
            {items.length > 5 && <SearchInput value={search} onChange={setSearch} placeholder="Buscar número" className="w-48" />}
          </div>
          {loading ? (
            <div className="space-y-2 p-4">
              <div className="skeleton h-5 w-full rounded" />
              <div className="skeleton h-5 w-2/3 rounded" />
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[0.8125rem] text-tertiary">Ninguém descadastrado ainda.</p>
          ) : visibleItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-[0.8125rem] text-tertiary">Nenhum número corresponde à busca.</p>
          ) : (
            <ul className="max-h-72 divide-y divide-[var(--color-border)] overflow-y-auto custom-scrollbar">
              {visibleItems.map((it) => (
                <li key={it.phone} className="flex items-center justify-between gap-3 px-4 py-2">
                  <div className="min-w-0">
                    <p className="font-mono text-[0.8125rem] text-primary">{formatOptOutPhone(it.phone)}</p>
                    <p className="truncate text-[0.75rem] text-tertiary">
                      {it.reason || "—"} · {formatDate(it.createdAt)}
                      {it.addedBy ? ` · por ${it.addedBy}` : ""}
                      {it.removedBy && it.removedAt ? ` · removido por ${it.removedBy} em ${formatDate(it.removedAt)}` : ""}
                    </p>
                  </div>
                  {canRemove && (
                    <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setRemoveTarget(it.phone)} aria-label={`Remover ${formatOptOutPhone(it.phone)} do descadastro`}>
                      Remover
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <ConfirmDialog
          isOpen={removeTarget !== null}
          title="Remover do descadastro?"
          confirmLabel="Remover"
          loading={removing}
          onConfirm={() => removeTarget && remove(removeTarget)}
          onClose={() => setRemoveTarget(null)}
        >
          O número <strong className="font-mono text-primary">{removeTarget ? formatOptOutPhone(removeTarget) : ""}</strong> volta a poder receber mensagens de
          todas as campanhas. Faça isso só se a própria pessoa pediu para voltar a receber. A remoção fica registrada no histórico.
        </ConfirmDialog>

        {removedAudits.length > 0 && (
          <div className="rounded-lg border border-border px-4 py-2.5">
            <p className="mb-1.5 text-[0.75rem] font-medium text-secondary">Histórico de remoções</p>
            <ul className="max-h-32 space-y-1 overflow-y-auto text-[0.75rem] text-tertiary custom-scrollbar">
              {removedAudits.slice(0, 20).map((a) => (
                <li key={a.id} className="font-mono">
                  {formatOptOutPhone(a.phone)} — removido por {a.actorName || "operador"} em {formatDate(a.createdAt)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
