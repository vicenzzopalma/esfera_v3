// Importação de contatos: arquivo CSV/TXT (arrastar ou selecionar) ou colar texto, com prévia validada.
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, FileUp, Upload, X } from "lucide-react";
import Modal from "../../components/ui/Modal";
import Button from "../../components/ui/Button";
import Field from "../../components/ui/Field";
import { SegmentedControl } from "../../components/ui/Tabs";
import type { Campaign } from "../../types";
import { api } from "../../tauri";
import { InlineAlert, formatNumber, parseContactsText } from "./shared";

type PreviewFilter = "all" | "valid" | "invalid";
const PREVIEW_LIMIT = 300;

export default function ContactImportModal({
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setRaw("");
      setFileName("");
      setImportError("");
      setFilter("all");
    }
  }, [isOpen, campaign?.id]);

  const deferred = useDeferredValue(raw);
  const rows = useMemo(() => parseContactsText(deferred), [deferred]);
  const validRows = rows.filter((r) => r.valid);
  const invalidCount = rows.length - validRows.length;
  const warningCount = validRows.filter((r) => r.warning).length;
  const visible = rows.filter((r) => (filter === "valid" ? r.valid : filter === "invalid" ? !r.valid : true));

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      setRaw((ev.target?.result as string) || "");
      setFileName(file.name);
      setImportError("");
    };
    reader.onerror = () => setImportError("Não foi possível ler o arquivo selecionado.");
    reader.readAsText(file);
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
          accept=".csv,.txt,.tsv"
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
                <p className="text-[0.8125rem] font-medium text-primary">Arraste um arquivo CSV ou TXT</p>
                <p className="text-[0.75rem] text-tertiary">ou clique para selecionar</p>
              </>
            )}
          </div>

          <Field
            label="Ou cole a lista"
            htmlFor="import-raw"
            hint="Um contato por linha: Nome, Telefone. Também aceita ; ou tabulação, ou só o telefone."
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
          Os números são limpos automaticamente e recebem o DDI +55 quando têm DDD. Números sem DDD são mantidos como estão.
        </p>

        {rows.length > 0 && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem]">
                <span className="text-primary">
                  <strong className="tabular-nums">{formatNumber(validRows.length)}</strong> válidos
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

            {validRows.length === 0 && (
              <InlineAlert tone="danger" icon={<AlertCircle size={15} />} title="Nenhum telefone válido encontrado">
                Confira se cada linha tem um telefone, no formato "Nome, Telefone".
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
                    {visible.slice(0, PREVIEW_LIMIT).map((r) => (
                      <tr key={r.line} className={r.valid ? "" : "bg-red-500/[0.05]"}>
                        <td className="px-3 py-1.5 tabular-nums text-tertiary">{r.line}</td>
                        <td className="max-w-[14rem] truncate px-3 py-1.5 text-primary">{r.valid ? r.name : <span className="text-tertiary">{r.raw}</span>}</td>
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
