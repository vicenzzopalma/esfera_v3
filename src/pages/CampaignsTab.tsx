// ============================================================
// Esfera v3 — Campanhas
// Lista de campanhas, assistente de criação/edição, detalhe com
// execução ao vivo, contatos, aparelhos e configurações.
// Componentes em ./campaigns/
// ============================================================

import { type ReactNode, useEffect, useRef, useState, useMemo, useDeferredValue, useCallback } from "react";
import { Search, X, MoreHorizontal, Check, CheckCheck, ChevronLeft, ChevronRight, Shuffle, AlertCircle, Sparkles, ChevronDown, UserRound, Clock, AlertTriangle, Battery, RefreshCw, Smartphone, ArrowDown, Terminal, Upload, Users, FileUp, CheckCircle2, Eye, EyeOff, PlugZap, ArrowLeft, ArrowRight, Circle, LayoutDashboard, Pause, Pencil, Play, RotateCcw, Send, Settings2, Square, XCircle, Brain, Building2, Megaphone, Plus, Ban, Trash2 } from "lucide-react";
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
import { MOCK_CAMPAIGNS } from "../mock-data";
import PageHeader from "../components/ui/PageHeader";

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
  progress: number;
}

export function countsFromCampaign(c: Campaign): CampaignCounts {
  const total = c.contactsCount || 0;
  const sent = c.sentCount || 0;
  const failed = c.failedCount || 0;
  const pending = Math.max(0, total - sent - failed);
  const progress = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
  return { total, sent, failed, pending, progress };
}

// Mesma regra da janela de execução original: prioriza a lista real de contatos.
export function countsFromContacts(c: Campaign, contacts: Contact[]): CampaignCounts {
  const total = contacts.length || c.contactsCount || 0;
  const sent = contacts.filter((x) => x.status === "sent").length || c.sentCount || 0;
  const failed = contacts.filter((x) => x.status === "failed").length || c.failedCount || 0;
  const pending = contacts.length ? contacts.filter((x) => x.status === "pending").length : Math.max(0, total - sent - failed);
  const progress = total > 0 ? Math.round(((sent + failed) / total) * 100) : 0;
  return { total, sent, failed, pending, progress };
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

export function delaySummary(min: number, max: number) {
  return min === max ? `${min}s entre mensagens` : `entre ${min}s e ${max}s por mensagem`;
}

// ---------- Contatos (importação) ----------
// Higieniza números no padrão REALESS / Esfera v3 (Brasil, DDI +55).
// NÃO inventa DDD: apenas normaliza o que o usuário informou.
//  - já com DDI 55 (12-13 dígitos) -> mantém
//  - com DDD (10-11 dígitos)         -> prefixa +55
//  - só número local (8-9 dígitos)   -> não infere DDD, retorna limpo
export function sanitizePhoneNumber(raw: string) {
  const clean = raw.replace(/\D/g, "");
  if (clean.length === 0) return "";
  if (clean.startsWith("55") && (clean.length === 12 || clean.length === 13)) return "+" + clean;
  if (clean.length === 10 || clean.length === 11) return "+55" + clean;
  return "+" + clean;
}

export interface ParsedRow {
  line: number;
  raw: string;
  name: string;
  phone: string;
  valid: boolean;
  warning?: string;
  reason?: string;
}

// DDDs em uso no Brasil (Anatel). Número que não começa por DDD válido (ex.: nº de processo) não é telefone.
const BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export type PhoneKind = "mobile" | "landline" | "local" | "invalid";

// Celular: DDD + 9 + 8 dígitos (ou 8 dígitos antigos começando em 6-9). Fixo: DDD + 8 dígitos começando em 2-5.
// "local": 8-9 dígitos sem DDD, mantido como no importador original (com aviso).
export function classifyPhone(raw: string): { phone: string; kind: PhoneKind } {
  const clean = raw.replace(/\D/g, "").replace(/^0+/, "");
  const d = (clean.length === 12 || clean.length === 13) && clean.startsWith("55") ? clean.slice(2) : clean;
  if (d.length === 10 || d.length === 11) {
    const local = d.slice(2);
    if (!BR_DDD.has(Number(d.slice(0, 2)))) return { phone: "", kind: "invalid" };
    if (local.length === 9) return local[0] === "9" ? { phone: "+55" + d, kind: "mobile" } : { phone: "", kind: "invalid" };
    if ("2345".includes(local[0])) return { phone: "+55" + d, kind: "landline" };
    if ("6789".includes(local[0])) return { phone: "+55" + d, kind: "mobile" };
    return { phone: "", kind: "invalid" };
  }
  if (clean.length === 8 || clean.length === 9) return { phone: "+" + clean, kind: "local" };
  return { phone: "", kind: "invalid" };
}

export type PhoneMode = "all" | "one";

export interface ImportOptions {
  phoneMode: PhoneMode;
  includeLandlines: boolean;
}

export interface ParsedImport {
  rows: ParsedRow[];
  lines: number;
  columns: string;
  multiPhone: boolean;
  landlines: number;
}

const PHONE_HEADER = /tel|fone|cel|whats|numero|^contato\s*\d/;
const NAME_HEADER = /nome|name|devedor|razao|cliente|contato|destinat|empresa|sacado/;
const HEADER_WORD = /\b(nome|name|devedor|razao|cliente|contato|telefone|fone|tel|celular|cel|whatsapp|whats|numero|processo|codigo|cpf|cnpj|documento|email)\b/;

function plainText(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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

// Divide a linha pelo separador, respeitando campos entre aspas ("SILVA, JOÃO";...).
function splitCells(line: string, delim: string | null): string[] {
  if (!delim) return [line.trim()];
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
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, raw: l.trim() }))
    .filter((l) => l.raw !== "");
  if (!source.length) return { rows: [], lines: 0, columns: "", multiPhone: false, landlines: 0 };

  const delim = detectDelimiter(source.map((l) => l.raw));
  const table = source.map((l) => ({ ...l, cells: splitCells(l.raw, delim) }));
  const width = table.reduce((w, r) => Math.max(w, r.cells.length), 0);
  const isStrongPhone = (v: string) => {
    const k = classifyPhone(v).kind;
    return k === "mobile" || k === "landline";
  };
  const firstCells = table[0].cells;
  const hasHeader = !firstCells.some(isStrongPhone) && firstCells.filter((c) => HEADER_WORD.test(plainText(c))).length >= 2;
  const header = hasHeader ? firstCells.map(plainText) : null;
  const data = hasHeader ? table.slice(1) : table;

  const stats = Array.from({ length: width }, () => ({ filled: 0, letters: 0, strong: 0, local: 0 }));
  for (const r of data) {
    r.cells.forEach((c, j) => {
      if (!c) return;
      const st = stats[j];
      st.filled++;
      if (/[a-zA-ZÀ-ÿ]/.test(c)) st.letters++;
      else {
        const k = classifyPhone(c).kind;
        if (k === "mobile" || k === "landline") st.strong++;
        else if (k === "local") st.local++;
      }
    });
  }
  const textual = (j: number) => stats[j].filled > 0 && stats[j].letters * 2 >= stats[j].filled;

  let nameCol = header ? header.findIndex((h, j) => NAME_HEADER.test(h) && !PHONE_HEADER.test(h) && textual(j)) : -1;
  if (nameCol < 0) {
    let best = 0;
    stats.forEach((st, j) => {
      if (st.letters > best && textual(j)) {
        best = st.letters;
        nameCol = j;
      }
    });
  }
  let phoneCols = header ? header.map((h, j) => (PHONE_HEADER.test(h) && j !== nameCol ? j : -1)).filter((j) => j >= 0) : [];
  if (!phoneCols.length) {
    phoneCols = stats
      .map((st, j) => {
        if (j === nameCol || !st.filled) return -1;
        // Antes da coluna de nome (ex.: código/processo) só conta se for telefone com DDD na maioria.
        const share = (nameCol >= 0 && j < nameCol ? st.strong : st.strong + st.local) / st.filled;
        return share >= 0.6 ? j : -1;
      })
      .filter((j) => j >= 0);
  }

  const label = (j: number) => (hasHeader && firstCells[j]?.trim()) || `coluna ${j + 1}`;
  const ignored = stats.map((st, j) => (st.filled && j !== nameCol && !phoneCols.includes(j) ? label(j) : "")).filter(Boolean);
  const columns = [
    nameCol >= 0 ? `Nome: ${label(nameCol)}` : "Nome: “Cliente” (sem coluna de nome)",
    phoneCols.length ? `Telefone: ${listLabels(phoneCols.map(label))}` : "Telefone: nenhuma coluna reconhecida",
    ignored.length ? `Ignorada: ${listLabels(ignored)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rows: ParsedRow[] = [];
  const seen = new Map<string, number>();
  let multiPhone = false;
  let landlines = 0;
  for (const r of data) {
    // Linha só com o telefone (sem separador) numa lista "Nome, Telefone": nome "Cliente".
    const single = r.cells.length === 1;
    const name = (!single && nameCol >= 0 ? r.cells[nameCol] ?? "" : "").trim() || "Cliente";
    const values = (single ? [r.cells[0]] : phoneCols.map((j) => (r.cells[j] ?? "").trim())).filter(Boolean);
    if (!values.length) {
      rows.push({ line: r.line, raw: r.raw, name, phone: "", valid: false, reason: "Sem telefone" });
      continue;
    }
    const found = values.map((v) => ({ v, ...classifyPhone(v) }));
    if (found.filter((c) => c.kind !== "invalid").length > 1) multiPhone = true;
    landlines += found.filter((c) => c.kind === "landline").length;
    // "Só 1": o 1º celular ainda não usado; sem celular, o 1º número aceito.
    const pool = found.filter((c) => c.kind !== "invalid" && (c.kind !== "landline" || opts.includeLandlines) && !seen.has(optOutKey(c.phone)));
    const chosen = opts.phoneMode === "one" ? pool.find((c) => c.kind === "mobile") ?? pool[0] : undefined;
    for (const c of found) {
      const base = { line: r.line, raw: r.raw, name, phone: c.phone || c.v };
      if (c.kind === "invalid") {
        rows.push({ ...base, valid: false, reason: "Número inválido" });
        continue;
      }
      if (c.kind === "landline" && !opts.includeLandlines) {
        rows.push({ ...base, valid: false, reason: "Fixo (ignorado)" });
        continue;
      }
      const key = optOutKey(c.phone);
      const firstLine = seen.get(key);
      if (firstLine !== undefined) {
        rows.push({ ...base, valid: false, reason: firstLine === r.line ? "Repetido na mesma linha" : `Repetido (linha ${firstLine})` });
        continue;
      }
      if (opts.phoneMode === "one" && c !== chosen) {
        rows.push({ ...base, valid: false, reason: "Outro número do devedor" });
        continue;
      }
      seen.set(key, r.line);
      rows.push({ ...base, valid: true, warning: c.kind === "local" ? "Sem DDD" : c.kind === "landline" ? "Fixo" : undefined });
    }
  }
  return { rows, lines: data.length, columns, multiPhone, landlines };
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

// UTF-8 (com ou sem BOM); se não for UTF-8 válido, Windows-1252 (CSV salvo pelo Excel no Windows).
export function decodeTextFile(buf: ArrayBuffer) {
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

// A mensagem sai sempre em 3 partes: saudação, corpo e encerramento são obrigatórios.
export function messageError(greeting: string, body: string, closing: string) {
  if (!body.trim()) return "Escreva a mensagem que será enviada.";
  if (!greeting.trim() || !closing.trim()) return "Preencha a saudação e o encerramento: a mensagem sai sempre em 3 partes.";
  const full = joinMessage(greeting, body, closing);
  if (/(?:https?:\/\/|www\.|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|\b))/i.test(full))
    return "Remova os links da primeira mensagem para contatos novos, incluindo links wa.me.";
  return moneyError(full);
}

// Junta saudação + corpo + encerramento como o motor de disparo faz.
// Regra da empresa: mensagens não podem citar valores (R$, reais, centavos ou quantias como 350,00).
// Mesma regra do backend (AiEngine::has_money): R$, reais, %, "R 350", "valor/saldo/parcela... 350", 350,00 / 350.00.
const MONEY_RE =
  /R\$|RS\$|\bBRL\b|\breais\b|\bcentavos\b|\d+\s*%|\bpor\s*cento\b|\bR\s+\d|\b(valor|valores|saldo|parcelas?|d[ií]vida|d[ée]bito|total|quantia|montante|pre[çc]o|desconto|juros|multa|pague|pagar|pagamento|custa)\b[:\s]*(\S+\s+){0,2}?\d|\d[,.]\d{2}(?![\d./])/i;
export function moneyError(text: string): string | undefined {
  return MONEY_RE.test(text)
    ? "Não é permitido falar de valores. Remova as quantias (R$, reais, 350,00) e direcione o cliente ao canal de negociação."
    : undefined;
}

export function joinMessage(greeting: string, body: string, closing: string) {
  let full = "";
  if (greeting.trim()) full += greeting + " ";
  full += body;
  if (closing.trim()) full += " " + closing;
  return full.trim();
}

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
export function ProgressBar({
  total,
  sent,
  failed,
  size = "sm",
  completed,
}: {
  total: number;
  sent: number;
  failed: number;
  size?: "sm" | "lg";
  completed?: boolean;
}) {
  const sentPct = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  const failPct = total > 0 ? Math.min(100 - sentPct, (failed / total) * 100) : 0;
  return (
    <div
      className={`flex w-full overflow-hidden rounded-full bg-secondary ${size === "lg" ? "h-2.5" : "h-1.5"}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(sentPct + failPct)}
    >
      <div
        className={`h-full transition-[width] duration-500 ${completed ? "bg-emerald-500" : "bg-[var(--color-accent)]"}`}
        style={{ width: `${sentPct}%` }}
      />
      {failPct > 0 && <div className="h-full bg-red-500/80 transition-[width] duration-500" style={{ width: `${failPct}%` }} />}
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

// Pré-visualização estilo conversa de WhatsApp, com geração de variações (spintax).

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
  const full = joinMessage(greeting, body, closing);
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

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-secondary">
      <div className="flex items-center gap-2.5 border-b border-border bg-card px-3.5 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-[0.75rem] font-semibold text-secondary">M</span>
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-medium text-primary">{SAMPLE_NAME}</p>
          <p className="text-[0.6875rem] text-tertiary">Pré-visualização</p>
        </div>
      </div>

      <div className="flex-1 space-y-2 p-3.5">
        <ChatBubble text={showing || "Sua mensagem aparecerá aqui."} muted={!showing} />
        {aiNote && <p className="text-center text-[0.75rem] text-tertiary">Com IA ativa, cada contato recebe uma versão reescrita deste texto.</p>}
      </div>

      <div className="space-y-2 border-t border-border bg-card px-3.5 py-3">
        <div className="flex items-center justify-between gap-2 text-[0.75rem] text-secondary">
          <span>{full.length} caracteres</span>
          {useSpintax && (
            <span className="tabular-nums">
              {combos > 1 ? `${combos >= 1_000_000_000 ? "+1 bi" : formatNumber(combos)} variações possíveis` : "Sem variações"}
            </span>
          )}
        </div>
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

function AiFields({
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
  // Cada teste ganha um número; "Parar" troca o número e a resposta atrasada é descartada.
  const testRun = useRef(0);

  const stopTest = () => {
    testRun.current += 1;
    setTesting(false);
    setResult({ success: false, text: "Reescrita interrompida." });
  };

  const handleTest = async () => {
    const msg = messageForTest.trim();
    if (!msg) {
      setResult({ success: false, text: "Escreva a mensagem antes de testar a reescrita com IA." });
      return;
    }
    const run = ++testRun.current;
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
      if (run !== testRun.current) return;
      setResult({ success: true, text: rewritten });
    } catch (error) {
      if (run !== testRun.current) return;
      setResult({ success: false, text: String(error) });
    } finally {
      if (run === testRun.current) setTesting(false);
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
                placeholder="openai/gpt-oss-120b"
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
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" icon={<Sparkles size={13} />} onClick={handleTest} loading={testing}>
                  {testing ? "Gerando…" : "Testar"}
                </Button>
                {testing && (
                  <Button size="sm" variant="ghost" onClick={stopTest}>
                    Parar
                  </Button>
                )}
              </div>
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

// ============================================================
// MessageFields
// ============================================================

// Campos de mensagem (saudação / corpo / encerramento) com spintax e ajuda.

export interface MessageValue {
  greeting: string;
  body: string;
  closing: string;
  useSpintax: boolean;
}

const WHATSAPP_LIMIT = 4096;

function Counter({ value, limit }: { value: number; limit?: number }) {
  const over = limit && value > limit;
  return <span className={`tabular-nums ${over ? "text-red-400" : ""}`}>{limit ? `${value} / ${limit}` : value}</span>;
}

function MessageFields({
  value,
  onChange,
  bodyError,
}: {
  value: MessageValue;
  onChange: (patch: Partial<MessageValue>) => void;
  bodyError?: string;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const insertName = () => {
    const el = bodyRef.current;
    const token = "{nome}";
    if (!el) {
      onChange({ body: value.body + token });
      return;
    }
    const start = el.selectionStart ?? value.body.length;
    const end = el.selectionEnd ?? value.body.length;
    const next = value.body.slice(0, start) + token + value.body.slice(end);
    onChange({ body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const total = value.greeting.length + value.body.length + value.closing.length;
  const unknownVars = unknownVariables(`${value.greeting}\n${value.body}\n${value.closing}`);

  return (
    <div className="space-y-4">
      <Field label="Saudação" htmlFor="cmp-greeting" aside={<Counter value={value.greeting.length} />} hint="Obrigatória. 1ª das 3 mensagens, antes do corpo.">
        <input
          id="cmp-greeting"
          type="text"
          value={value.greeting}
          onChange={(e) => onChange({ greeting: e.target.value })}
          placeholder="{Olá|Oi|Bom dia} {nome}, tudo bem?"
        />
      </Field>

      <Field
        label="Mensagem"
        htmlFor="cmp-body"
        required
        error={bodyError}
        aside={<Counter value={total} limit={WHATSAPP_LIMIT} />}
        hint="Não inclua links na primeira mensagem para contatos novos. Chaves PIX saem exatamente como escritas. Não cite valores (R$, reais, %, quantias): a mensagem é bloqueada."
      >
        <textarea
          id="cmp-body"
          ref={bodyRef}
          rows={6}
          value={value.body}
          onChange={(e) => onChange({ body: e.target.value })}
          placeholder="Identificamos uma {pendência|condição especial} no seu cadastro. Podemos conversar sobre a melhor forma de regularizar?"
          className="resize-y"
          aria-invalid={Boolean(bodyError)}
        />
      </Field>
      <div className="-mt-2">
        <button
          type="button"
          onClick={insertName}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[0.75rem] text-secondary transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)] cursor-pointer"
        >
          <UserRound size={12} /> Inserir nome do contato
        </button>
      </div>
      {unknownVars.length > 0 && (
        <InlineAlert tone="warning" icon={<AlertTriangle size={15} />} title="Variável não reconhecida">
          {unknownVars.join(", ")} vai sair como texto no disparo. O sistema preenche só o nome do contato: use {"{nome}"} ou o nome da
          coluna da planilha, como {"{NOME DEVEDOR}"} ou {"{RAZÃO SOCIAL}"}.
        </InlineAlert>
      )}

      <Field label="Encerramento" htmlFor="cmp-closing" aside={<Counter value={value.closing.length} />} hint="Assinatura e a opção de descadastro, em texto neutro: “Para deixar de receber mensagens por este canal, responda SAIR.” Nunca associe o SAIR a reconhecimento de dívida ou renúncia a contestação.">
        <input
          id="cmp-closing"
          type="text"
          value={value.closing}
          onChange={(e) => onChange({ closing: e.target.value })}
          placeholder="Atenciosamente, {Equipe REALESS|Setor Financeiro}. Para deixar de receber mensagens por este canal, responda SAIR."
        />
      </Field>

      <div className="rounded-lg border border-border">
        <div className="flex items-center justify-between gap-3 px-3.5 py-3">
          <div className="min-w-0">
            <p className="text-[0.8125rem] font-medium text-primary">Variações automáticas (spintax)</p>
            <p className="text-[0.75rem] text-tertiary">Cada contato recebe uma combinação diferente do texto.</p>
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

// Intervalo entre mensagens, com explicação em linguagem humana.

export function delayError(min: number, max: number): string | undefined {
  if (!min || min < 1) return "O intervalo mínimo precisa ser de pelo menos 1 segundo.";
  if (max < min) return "O intervalo máximo não pode ser menor que o mínimo.";
  return undefined;
}

const PRESETS = [
  { label: "Cauteloso", min: 60, max: 180 },
  { label: "Equilibrado", min: 30, max: 90 },
  { label: "Rápido", min: 15, max: 45 },
];

function DelayFields({
  min,
  max,
  onChange,
  pendingContacts,
}: {
  min: number;
  max: number;
  onChange: (patch: { delayMin?: number; delayMax?: number }) => void;
  pendingContacts?: number;
}) {
  const err = delayError(min, max);
  const avg = (min + max) / 2;
  const perHour = avg > 0 ? Math.round(3600 / avg) : 0;

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
        <Field label="Mínimo (segundos)" htmlFor="cmp-delay-min">
          <input
            id="cmp-delay-min"
            type="number"
            min={1}
            value={min}
            onChange={(e) => onChange({ delayMin: parseInt(e.target.value, 10) || 0 })}
            className="tabular-nums"
          />
        </Field>
        <Field label="Máximo (segundos)" htmlFor="cmp-delay-max">
          <input
            id="cmp-delay-max"
            type="number"
            min={1}
            value={max}
            onChange={(e) => onChange({ delayMax: parseInt(e.target.value, 10) || 0 })}
            className="tabular-nums"
          />
        </Field>
      </div>

      {err ? (
        <p className="text-[0.75rem] text-red-500 dark:text-red-400">{err}</p>
      ) : (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-[var(--color-bg-hover)] px-3.5 py-3 text-[0.8125rem] text-secondary">
          <Clock size={15} className="mt-0.5 shrink-0 text-tertiary" />
          <p>
            Cada mensagem sai {min === max ? <>a cada <strong className="text-primary">{min}s</strong></> : <>entre <strong className="text-primary">{min}s</strong> e <strong className="text-primary">{max}s</strong> depois da anterior</>}
            , em intervalos aleatórios. Isso dá cerca de <strong className="text-primary tabular-nums">{perHour}</strong> mensagens por hora
            {pendingContacts ? <>, ou aproximadamente <strong className="text-primary">{formatDuration(pendingContacts * avg)}</strong> para os {pendingContacts} contatos pendentes</> : null}.
          </p>
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
// LogConsole
// ============================================================

// Console de eventos do disparo, legível e com rolagem automática.

export type LogLevel = "info" | "success" | "warning" | "error";

export interface LogLine {
  id: number;
  time: string;
  level: LogLevel;
  text: string;
  delayMs?: number;
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

// Traduz o evento do motor de disparo para uma linha legível.
export function describeProgress(p: ProgressPayload): { level: LogLevel; text: string } {
  const phone = p.last_contact_phone ? ` ${p.last_contact_phone}` : "";
  const next = p.delay_used_ms ? ` · próximo envio em ~${Math.round(p.delay_used_ms / 1000)}s` : "";
  switch (p.status) {
    case "running":
      return { level: "success", text: `Contato processado${phone}${next}` };
    case "send_error":
      return { level: "error", text: `Falha ao enviar para${phone || " o contato"}${next}` };
    case "waiting_device":
      return { level: "warning", text: "Nenhum aparelho selecionado está online. Aguardando conexão." };
    case "completed":
      return { level: "info", text: "Campanha concluída: não há mais contatos pendentes." };
    case "waiting_window":
      return { level: "warning", text: "Fora do horário de envio (seg-sex 8h-20h, sáb 8h-14h). O disparo continua sozinho no próximo horário." };
    default:
      if (p.status.startsWith("IA aviso")) return { level: "warning", text: `${p.status}${phone ? ` (${phone.trim()})` : ""}` };
      return { level: "info", text: p.status };
  }
}

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
            Nenhum evento nesta sessão. Ao iniciar o disparo, cada envio aparece aqui em tempo real.
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

// Lista de contatos (fila de disparo) de uma campanha, com busca e filtro de status.

type Filter = "all" | "pending" | "sent" | "failed";
const RENDER_LIMIT = 500;

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

function ContactsPanel({
  contacts,
  loading,
  onImport,
  onReload,
}: {
  contacts: Contact[];
  loading: boolean;
  onImport: () => void;
  onReload: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(
    () => ({
      pending: contacts.filter((c) => c.status === "pending").length,
      sent: contacts.filter((c) => c.status === "sent").length,
      failed: contacts.filter((c) => c.status === "failed").length,
    }),
    [contacts]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const qDigits = q.replace(/\D/g, "");
    return contacts.filter((c) => {
      if (filter !== "all" && c.status !== filter) return false;
      if (!q) return true;
      const name = (c.contactName || c.name || "").toLowerCase();
      return name.includes(q) || (qDigits && c.phone.replace(/\D/g, "").includes(qDigits));
    });
  }, [contacts, filter, search]);

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
        description="Importe uma planilha CSV ou cole uma lista de nomes e telefones para montar a fila de disparo."
        action={
          <Button icon={<Upload size={14} />} onClick={onImport}>
            Importar contatos
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome ou telefone" className="lg:w-72" />
        <SegmentedControl<Filter>
          value={filter}
          onChange={setFilter}
          items={[
            { id: "all", label: "Todos", count: contacts.length },
            { id: "pending", label: "Pendentes", count: counts.pending },
            { id: "sent", label: "Enviados", count: counts.sent },
            { id: "failed", label: "Falhas", count: counts.failed },
          ]}
        />
        <div className="flex items-center gap-1.5 lg:ml-auto">
          <Button
            size="sm"
            variant="ghost"
            onClick={onReload}
            aria-label="Atualizar lista de contatos"
            title="Atualizar"
            icon={<RefreshCw size={13} className={loading ? "animate-spin" : ""} />}
          />
          <Button size="sm" variant="secondary" icon={<Upload size={13} />} onClick={onImport}>
            Importar contatos
          </Button>
        </div>
      </div>

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
                {filtered.slice(0, RENDER_LIMIT).map((c) => {
                  const st = contactStatus[c.status] || contactStatus.pending;
                  return (
                    <tr key={c.id} className="hover:bg-[var(--color-bg-hover)]">
                      <td className="max-w-[16rem] truncate px-4 py-2 text-primary">{c.contactName || c.name || "Contato"}</td>
                      <td className="px-4 py-2 font-mono text-[0.75rem] text-secondary">{c.phone}</td>
                      <td className="px-4 py-2">
                        <Badge variant={st.variant}>{st.label}</Badge>
                        {c.retryCount ? <span className="ml-2 text-[0.75rem] text-tertiary">{c.retryCount} tentativa{c.retryCount > 1 ? "s" : ""}</span> : null}
                      </td>
                      <td className="hidden px-4 py-2 text-[0.75rem] text-tertiary md:table-cell">{c.sentAt ? formatDate(c.sentAt) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > RENDER_LIMIT && (
            <p className="border-t border-border bg-secondary px-4 py-2 text-[0.75rem] text-tertiary">
              Mostrando {RENDER_LIMIT} de {formatNumber(filtered.length)}. Use a busca para encontrar um contato específico.
            </p>
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

type PreviewFilter = "all" | "valid" | "invalid";
const PREVIEW_LIMIT = 300;

function ContactImportModal({
  isOpen,
  onClose,
  campaign,
  onImported,
}: {
  isOpen: boolean;
  onClose: () => void;
  campaign: Campaign | null;
  onImported: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState<PreviewFilter>("all");
  const [phoneMode, setPhoneMode] = useState<PhoneMode>("all");
  const [includeLandlines, setIncludeLandlines] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setRaw("");
      setFileName("");
      setImportError("");
      setFilter("all");
      setPhoneMode("all");
      setIncludeLandlines(false);
    }
  }, [isOpen, campaign?.id]);

  const deferred = useDeferredValue(raw);
  const parsed = useMemo(() => parseContactsText(deferred, { phoneMode, includeLandlines }), [deferred, phoneMode, includeLandlines]);
  const rows = parsed.rows;
  const validRows = rows.filter((r) => r.valid);
  const invalidCount = rows.length - validRows.length;
  const warningCount = validRows.filter((r) => r.warning).length;
  const visible = rows.filter((r) => (filter === "valid" ? r.valid : filter === "invalid" ? !r.valid : true));
  const [optOutKeys, setOptOutKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!isOpen || !campaign?.companyId) return;
    api<{ phone: string }[]>("list_opt_outs", { companyId: campaign.companyId })
      .then((l) => setOptOutKeys(new Set(l.map((x) => x.phone))))
      .catch(() => setOptOutKeys(new Set()));
  }, [isOpen, campaign?.companyId]);
  const optedOutCount = validRows.filter((r) => optOutKeys.has(optOutKey(r.phone))).length;

  // CSV/TXT (UTF-8 ou Windows-1252) ou planilha .xlsx (1ª aba), tudo pelo mesmo leitor de colunas.
  const readFile = async (file: File) => {
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    try {
      let text: string;
      if (ext === "xlsx" || ext === "xlsm") text = rowsToText(await parseXlsx(new Uint8Array(await file.arrayBuffer())));
      else if (ext === "xls" || ext === "ods")
        throw new Error("Este formato de planilha não é lido aqui. No Excel, use Salvar como → Pasta de Trabalho do Excel (.xlsx) ou CSV.");
      else text = decodeTextFile(await file.arrayBuffer());
      setRaw(text);
      setFileName(file.name);
      setImportError("");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Não foi possível ler o arquivo selecionado.");
    }
  };

  const handleConfirm = async () => {
    if (!campaign || validRows.length === 0) return;
    setImporting(true);
    try {
      await api("import_campaign_contacts", {
        campaignId: campaign.id,
        contacts: validRows.map((c) => [c.name, c.phone]),
      });
    } catch (error) {
      console.error("Falha ao importar contatos:", error);
      setImportError(String(error));
      setImporting(false);
      return;
    }
    setImporting(false);
    setImportError("");
    setRaw("");
    setFileName("");
    onImported();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Importar contatos"
      description={campaign ? `Campanha: ${campaign.name}` : undefined}
      size="xl"
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          {optedOutCount > 0 && (
            <p className="text-[0.75rem] text-amber-700 dark:text-amber-400">
              {optedOutCount} número(s) desta lista pediram para não receber mensagens (Descadastrados) e serão pulados no disparo.
            </p>
          )}
          <p className="text-[0.75rem] text-tertiary">A importação substitui os contatos ainda pendentes desta campanha.</p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={importing}>
              Cancelar
            </Button>
            <Button onClick={handleConfirm} disabled={validRows.length === 0} loading={importing} icon={<Upload size={14} />}>
              {validRows.length ? `Importar ${formatNumber(validRows.length)} ${validRows.length === 1 ? "contato" : "contatos"}` : "Importar"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {importError && (
          <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="A importação falhou" onDismiss={() => setImportError("")}>
            {importError}
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

        <div className="grid gap-4 lg:grid-cols-2">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) readFile(f);
            }}
            className={`flex min-h-[11rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
              dragging ? "border-[var(--color-accent)] bg-[var(--color-accent-glow)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-bg-hover)]"
            }`}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-secondary">
              <FileUp size={18} />
            </span>
            {fileName ? (
              <>
                <p className="text-[0.8125rem] font-medium text-primary">{fileName}</p>
                <p className="text-[0.75rem] text-tertiary">Clique para trocar o arquivo</p>
              </>
            ) : (
              <>
                <p className="text-[0.8125rem] font-medium text-primary">Arraste um arquivo CSV, TXT ou planilha (.xlsx)</p>
                <p className="text-[0.75rem] text-tertiary">ou clique para selecionar</p>
              </>
            )}
          </div>

          <Field
            label="Ou cole a lista"
            htmlFor="import-raw"
            hint="Um contato por linha: Nome, Telefone. Também aceita planilha com cabeçalho (ex.: PROCESSO, NOME DEVEDOR, TELEFONE 1…), ; ou tabulação, ou só o telefone."
            aside={
              raw ? (
                <button
                  type="button"
                  onClick={() => {
                    setRaw("");
                    setFileName("");
                  }}
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
                setRaw(e.target.value);
                if (fileName) setFileName("");
              }}
              placeholder={"Maria Silva, 11999991111\nJoão Souza, 5511988882222\n5511977773333"}
              className="resize-none font-mono text-[0.75rem]"
            />
          </Field>
        </div>

        <p className="text-[0.75rem] text-tertiary">
          Os números são limpos automaticamente e recebem o DDI +55 quando têm DDD. Cada telefone válido vira um contato; número repetido entra uma vez.
        </p>

        {rows.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]">
                <span className="text-secondary">
                  <strong className="tabular-nums text-primary">{formatNumber(parsed.lines)}</strong> {parsed.lines === 1 ? "linha" : "linhas"}
                </span>
                <span className="text-primary">
                  <strong className="tabular-nums">{formatNumber(validRows.length)}</strong> {validRows.length === 1 ? "número válido" : "números válidos"}
                </span>
                <span className={invalidCount ? "text-red-600 dark:text-red-400" : "text-tertiary"}>
                  <strong className="tabular-nums">{formatNumber(invalidCount)}</strong> ignorados
                </span>
                {warningCount > 0 && (
                  <span className="text-amber-700 dark:text-amber-300">
                    <strong className="tabular-nums">{formatNumber(warningCount)}</strong> com aviso
                  </span>
                )}
              </div>
              <SegmentedControl<PreviewFilter>
                value={filter}
                onChange={setFilter}
                items={[
                  { id: "all", label: "Todos", count: rows.length },
                  { id: "valid", label: "Válidos", count: validRows.length },
                  { id: "invalid", label: "Ignorados", count: invalidCount },
                ]}
              />
            </div>

            {parsed.columns && <p className="text-[0.75rem] text-tertiary">Colunas lidas: {parsed.columns}</p>}

            {(parsed.multiPhone || parsed.landlines > 0) && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2">
                <span className="text-[0.75rem] text-secondary">Telefones de cada linha</span>
                <SegmentedControl<PhoneMode>
                  value={phoneMode}
                  onChange={setPhoneMode}
                  items={[
                    { id: "all", label: "Todos" },
                    { id: "one", label: "Só 1 (celular primeiro)" },
                  ]}
                />
                {parsed.landlines > 0 && (
                  <Toggle size="sm" checked={includeLandlines} onChange={setIncludeLandlines} label={`Incluir fixos (${formatNumber(parsed.landlines)})`} />
                )}
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
                    {visible.slice(0, PREVIEW_LIMIT).map((r, i) => (
                      <tr key={`${r.line}-${i}`} className={r.valid ? "" : "bg-red-500/[0.05]"}>
                        <td className="px-3 py-1.5 tabular-nums text-tertiary">{r.line}</td>
                        <td className="max-w-[14rem] truncate px-3 py-1.5 text-primary">
                          {r.valid || r.name !== "Cliente" ? r.name : <span className="text-tertiary">{r.raw}</span>}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-[0.75rem] text-secondary">{r.phone || "—"}</td>
                        <td className="px-3 py-1.5 text-[0.75rem]">
                          {!r.valid ? (
                            <span className="text-red-600 dark:text-red-400">{r.reason}</span>
                          ) : r.warning ? (
                            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                              <AlertTriangle size={12} /> {r.warning}
                            </span>
                          ) : (
                            <span className="text-emerald-600 dark:text-emerald-400">Ok</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {visible.length > PREVIEW_LIMIT && (
                <p className="border-t border-border bg-secondary px-3 py-2 text-[0.75rem] text-tertiary">
                  Mostrando {PREVIEW_LIMIT} de {formatNumber(visible.length)} linhas. Todas serão consideradas na importação.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </Modal>
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
        message: "Olá {nome}! Seu boleto vence hoje. Pague via PIX financeiro@empresa.com ou no link https://empresa.com/fatura",
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
    message: messageError(form.greeting, form.body, form.closing),
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

function CampaignDetail({
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
  const [confirmations, setConfirmations] = useState<{pending: number; sent: number; uncertain: number} | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => api<{pending: number; sent: number; uncertain: number}>("get_confirmation_counts", { campaignId: campaign.id }).then((v) => { if (alive) setConfirmations(v); }).catch(() => { if (alive) setConfirmations(null); });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [campaign.id]);
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
    const msgError = messageError(draft.greeting, draft.body, draft.closing);
    if (msgError) {
      setError(msgError);
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
    const money = moneyError(joinMessage(draft.greeting, draft.body, draft.closing));
    if (money) {
      setError(money);
      setTab("settings");
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
              {confirmations && <p className="mt-4 text-[0.8125rem] text-secondary">Confirmações de SAIR: {formatNumber(confirmations.pending)} aguardam envio · {formatNumber(confirmations.sent)} enviadas{confirmations.uncertain > 0 ? ` · ${formatNumber(confirmations.uncertain)} em revisão` : ""}</p>}
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
                  bodyError={messageError(draft.greeting, draft.body, draft.closing)}
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
              <Button onClick={handleSaveSettings} loading={busy === "save"} disabled={!settingsDirty || !!delayError(draft.delayMin, draft.delayMax) || !!moneyError(joinMessage(draft.greeting, draft.body, draft.closing))}>
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

// ============================================================
// CampaignList
// ============================================================

// Lista densa de campanhas (linhas clicáveis com progresso e ações).

const GRID = "lg:grid lg:grid-cols-[minmax(0,2.4fr)_8rem_minmax(0,1.7fr)_6rem_7rem_4.5rem] lg:items-center lg:gap-4";

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

function CampaignList({
  campaigns,
  onOpen,
  onEdit,
  onImport,
  onDelete,
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
          const st = statusInfo(c.status);
          const { total, sent, failed, progress } = countsFromCampaign(c);
          const deviceCount = (c.deviceIds || []).length;
          const preview = [c.greeting, c.message].filter(Boolean).join(" ");
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
                {selecting && <input type="checkbox" aria-label={`Selecionar ${c.name}`} checked={selectedIds.has(c.id)} disabled={c.status === "running"} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onChange={() => onToggle(c.id)} className="mt-1 accent-[var(--color-accent)]" />}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-primary">{c.name}</p>
                    {campaignUsesAi(c) && <Badge variant="purple">IA</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[0.75rem] text-tertiary">{preview || "Sem mensagem"}</p>
                </div>
                <div className="lg:hidden">
                  <Badge variant={st.variant} dot pulse={c.status === "running"}>
                    {st.label}
                  </Badge>
                </div>
              </div>

              {/* Status */}
              <div className="hidden lg:block">
                <Badge variant={st.variant} dot pulse={c.status === "running"}>
                  {st.label}
                </Badge>
              </div>

              {/* Progresso */}
              <div className="mt-3 min-w-0 lg:mt-0">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[0.75rem]">
                  <span className="tabular-nums text-secondary">
                    <span className="text-primary">{formatNumber(sent)}</span> / {formatNumber(total)}
                    {failed > 0 && <span className="ml-1.5 text-red-600 dark:text-red-400">· {formatNumber(failed)} falhas</span>}
                  </span>
                  <span className="tabular-nums text-tertiary">{progress}%</span>
                </div>
                <ProgressBar total={total} sent={sent} failed={failed} completed={c.status === "completed"} />
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
                <button
                  type="button"
                  aria-label={`Editar ${c.name}`}
                  title="Editar"
                  onClick={() => onEdit(c)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] cursor-pointer"
                >
                  <Pencil size={14} />
                </button>
                {canDelete && <button type="button" aria-label={`Excluir ${c.name}`} title={c.status === "running" ? "Pare a campanha antes de excluir" : "Excluir campanha"} disabled={c.status === "running"} onClick={() => onDelete(c)} className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed">
                  <Trash2 size={14} />
                </button>}
                <ActionMenu
                  label={`Mais ações para ${c.name}`}
                  actions={[
                    { label: "Abrir campanha", icon: <Play size={14} />, onSelect: () => onOpen(c) },
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
const LOG_LIMIT = 300;
let logSeq = 0;

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
  const [importFor, setImportFor] = useState<Campaign | null>(null);
  const [aiGlobalModalOpen, setAiGlobalModalOpen] = useState(false);
  const [optOutOpen, setOptOutOpen] = useState(false);
  const [importRevision, setImportRevision] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const [logs, setLogs] = useState<Record<number, LogLine[]>>({});
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<Campaign[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const canDelete = user?.role !== "colaborador";

  const appendLog = useCallback((campaignId: number, level: LogLevel, text: string, delayMs?: number) => {
    setLogs((prev) => {
      const list = [...(prev[campaignId] || []), { id: ++logSeq, time: nowTime(), level, text, delayMs }];
      return { ...prev, [campaignId]: list.slice(-LOG_LIMIT) };
    });
  }, []);

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
        if (mounted) {
          setCampaignsList(MOCK_CAMPAIGNS.filter((c) => c.companyId === selectedCompanyId));
          setLoadError(String(err));
        }
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
    let unlisten: (() => void) | undefined;
    let lastRefresh = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    listen<ProgressPayload>("campaign-progress", (event) => {
      const p = event.payload;
      if (p && typeof p.campaign_id === "number" && typeof p.status === "string") {
        const { level, text } = describeProgress(p);
        appendLog(p.campaign_id, level, text, p.delay_used_ms || undefined);
      }
      // Atualiza no máximo a cada 2s, mas nunca perde o último evento (ex.: "completed").
      const now = Date.now();
      if (trailing) clearTimeout(trailing);
      if (now - lastRefresh >= 2000) {
        lastRefresh = now;
        refreshCampaigns();
      } else {
        trailing = setTimeout(() => {
          lastRefresh = Date.now();
          refreshCampaigns();
        }, 2000 - (now - lastRefresh));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (trailing) clearTimeout(trailing);
      if (unlisten) unlisten();
    };
  }, [selectedCompanyId, refreshCampaigns, appendLog]);

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
  const totalPending = campaignsList.reduce((acc, c) => acc + Math.max(0, (c.contactsCount || 0) - (c.sentCount || 0) - (c.failedCount || 0)), 0);

  const filteredCampaigns = campaignsList.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(searchQuery.toLowerCase().trim());
    const matchesStatus =
      statusFilter === "all" || c.status === statusFilter || (statusFilter === "paused" && (c.status as string) === "stopped");
    return matchesSearch && matchesStatus;
  });

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

  // ---- Modais compartilhados (lista e detalhe) ----
  const modals = (
    <>
      {wizard && (
        <CampaignWizard
          isOpen
          onClose={() => setWizard(null)}
          campaign={wizard.campaign}
          onSaved={(saved, meta) => {
            upsertCampaign(saved);
            setSyncRevision((r) => r + 1);
            if (meta.openAfter) setDetail({ id: saved.id, tab: "contacts" });
            refreshCampaigns();
          }}
        />
      )}

      <ContactImportModal
        isOpen={importFor !== null}
        onClose={() => setImportFor(null)}
        campaign={importFor}
        onImported={() => {
          setImportRevision((r) => r + 1);
          refreshCampaigns();
          if (importFor) appendLog(importFor.id, "info", "Lista de contatos importada.");
        }}
      />

      {aiGlobalModalOpen && <GlobalAiConfigModal isOpen={aiGlobalModalOpen} onClose={() => setAiGlobalModalOpen(false)} />}
      {optOutOpen && selectedCompanyId && <OptOutModal companyId={selectedCompanyId} onClose={() => setOptOutOpen(false)} />}
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
          logs={logs[detailCampaign.id] || []}
          onLog={(level, text) => appendLog(detailCampaign.id, level, text)}
          onClearLogs={() => setLogs((prev) => ({ ...prev, [detailCampaign.id]: [] }))}
          onBack={() => setDetail(null)}
          onEdit={() => setWizard({ campaign: detailCampaign })}
          onImport={() => setImportFor(detailCampaign)}
          onUpdateCampaign={upsertCampaign}
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
            <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Buscar campanha" className="md:w-72" />
            <div className="overflow-x-auto">
              <SegmentedControl<StatusFilter> items={statusItems} value={statusFilter} onChange={setStatusFilter} />
            </div>
          </div>
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
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={selectedIds.size === 0} onClick={() => { setDeleteError(""); setDeleteTargets(campaignsList.filter((c) => selectedIds.has(c.id))); }}>Excluir selecionadas</Button>
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
              onImport={(c) => setImportFor(c)}
              onDelete={(c) => { setDeleteError(""); setDeleteTargets([c]); }}
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

  const remove = async (phone: string) => {
    try {
      await api("remove_opt_out", { companyId, phone });
      setMsg({ ok: true, text: `Número ${formatOptOutPhone(phone)} removido do descadastro.` });
      load();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    }
  };

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
                      className="h-8 flex-1 rounded-md border border-border bg-primary px-2.5 font-mono text-[0.75rem] text-primary"
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
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-[0.8125rem] font-medium text-primary">Lista</span>
            <span className="text-[0.75rem] tabular-nums text-tertiary">{items.length}</span>
          </div>
          {loading ? (
            <div className="space-y-2 p-4">
              <div className="skeleton h-5 w-full rounded" />
              <div className="skeleton h-5 w-2/3 rounded" />
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[0.8125rem] text-tertiary">Ninguém descadastrado ainda.</p>
          ) : (
            <ul className="max-h-72 divide-y divide-[var(--color-border)] overflow-y-auto custom-scrollbar">
              {items.map((it) => (
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
                    <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => remove(it.phone)} aria-label={`Remover ${it.phone}`}>
                      Remover
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

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
