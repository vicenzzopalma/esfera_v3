// Lista de contatos (fila de disparo) de uma campanha, com busca e filtro de status.
import { useMemo, useState } from "react";
import { RefreshCw, Upload, Users } from "lucide-react";
import Button from "../../components/ui/Button";
import Badge from "../../components/ui/Badge";
import EmptyState from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/Tabs";
import type { Contact } from "../../types";
import { SearchInput, formatDate, formatNumber } from "./shared";

type Filter = "all" | "pending" | "sent" | "failed";
const RENDER_LIMIT = 500;

const contactStatus: Record<string, { variant: "success" | "danger" | "neutral" | "info" | "warning"; label: string }> = {
  sent: { variant: "success", label: "Enviado" },
  failed: { variant: "danger", label: "Falhou" },
  pending: { variant: "neutral", label: "Pendente" },
  processing: { variant: "warning", label: "Enviando" },
  replied: { variant: "info", label: "Respondeu" },
};

export default function ContactsPanel({
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
