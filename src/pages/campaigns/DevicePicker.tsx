// Seleção de aparelhos autorizados para a campanha.
import { useMemo, useState } from "react";
import { AlertTriangle, Battery, RefreshCw, Smartphone } from "lucide-react";
import Button from "../../components/ui/Button";
import EmptyState from "../../components/ui/EmptyState";
import { SegmentedControl } from "../../components/ui/Tabs";
import type { Device } from "../../types";
import { InlineAlert, SearchInput, deviceKey, deviceLabel, isDeviceOnline, sortDevices } from "./shared";

type DeviceFilter = "all" | "online" | "selected";

export function deviceSelectionStats(devices: Device[], selected: string[]) {
  const selectedOnline = devices.filter((d) => selected.includes(deviceKey(d)) && isDeviceOnline(d)).length;
  const totalOnline = devices.filter(isDeviceOnline).length;
  return { selectedCount: selected.length, selectedOnline, totalOnline };
}

export default function DevicePicker({
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
