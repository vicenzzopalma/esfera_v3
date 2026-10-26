// Pré-visualização estilo conversa de WhatsApp, com geração de variações (spintax).
import { useMemo, useState } from "react";
import { CheckCheck, ChevronLeft, ChevronRight, Shuffle } from "lucide-react";
import Button from "../../components/ui/Button";
import { api } from "../../tauri";
import { fillSampleName, formatNumber, joinMessage, resolveSpintaxLocal, spintaxCombinations } from "./shared";

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

export default function WhatsAppPreview({
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
