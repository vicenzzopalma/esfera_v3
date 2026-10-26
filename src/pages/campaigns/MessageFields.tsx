// Campos de mensagem (saudação / corpo / encerramento) com spintax e ajuda.
import { useRef, useState } from "react";
import { ChevronDown, UserRound } from "lucide-react";
import Field from "../../components/ui/Field";
import Toggle from "../../components/ui/Toggle";

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

export default function MessageFields({
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

  return (
    <div className="space-y-4">
      <Field label="Saudação" htmlFor="cmp-greeting" aside={<Counter value={value.greeting.length} />} hint="Opcional. Vem antes do corpo da mensagem.">
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
        hint="Links, chaves PIX e valores são enviados exatamente como escritos."
      >
        <textarea
          id="cmp-body"
          ref={bodyRef}
          rows={6}
          value={value.body}
          onChange={(e) => onChange({ body: e.target.value })}
          placeholder="Identificamos um acordo {pendente|disponível} para você com {desconto|abatimento} de 50%."
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

      <Field label="Encerramento" htmlFor="cmp-closing" aside={<Counter value={value.closing.length} />} hint="Opcional. Assinatura ou despedida.">
        <input
          id="cmp-closing"
          type="text"
          value={value.closing}
          onChange={(e) => onChange({ closing: e.target.value })}
          placeholder="Atenciosamente, {Equipe REALESS|Setor Financeiro}"
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
              Use <code className="rounded bg-secondary px-1 py-0.5 font-mono text-primary">{"{nome}"}</code> para o nome do contato.
            </p>
            <p>Dá para combinar blocos: quanto mais opções, mais natural fica o disparo e menor o risco de bloqueio.</p>
          </div>
        )}
      </div>
    </div>
  );
}
