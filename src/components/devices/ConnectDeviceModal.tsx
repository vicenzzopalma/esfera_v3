// ============================================================
// Esfera v3 — Modal "Conectar celular"
// Conexão por USB, IP e código de pareamento (Android 11+)
// ============================================================

import { useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import Field, { FormSection } from "../ui/Field";
import { Tabs } from "../ui/Tabs";
import EmptyState from "../ui/EmptyState";
import type { Device } from "../../types";
import { RefreshCw, Smartphone, Usb, Globe, KeyRound, Loader2 } from "lucide-react";
import { inputCls, SECTOR_OPTIONS } from "./deviceUi";

interface ConnectDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  usbDevices: { serial: string; state: string; model: string }[];
  loadingUsb: boolean;
  existingDevices?: Device[];
  onFetchUsb: () => void;
  onForceWirelessAdb: (serial: string, deviceNumber: number, sector: string, deviceName: string) => void;
  onConnectDevice: (ip: string, port: number, deviceNumber: number, sector: string, deviceName: string) => void;
  onPairAndConnectDevice: (
    ip: string,
    pairPort: number,
    pairCode: string,
    connectPort: number,
    devNum: number,
    sec: string,
    devName: string
  ) => void;
  linkingSerial: string | null;
  linkingStatus: string | null;
  nextDeviceNumber: number;
}

type ConnectTab = "usb" | "manual" | "pair";

export function ConnectDeviceModal({
  isOpen,
  onClose,
  usbDevices,
  loadingUsb,
  existingDevices = [],
  onFetchUsb,
  onForceWirelessAdb,
  onConnectDevice,
  onPairAndConnectDevice,
  linkingSerial,
  linkingStatus,
  nextDeviceNumber,
}: ConnectDeviceModalProps) {
  const [connectTab, setConnectTab] = useState<ConnectTab>("usb");
  const [connectIp, setConnectIp] = useState("");
  const [connectPort, setConnectPort] = useState("5555");
  const [pairIp, setPairIp] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [connectPortInput, setConnectPortInput] = useState("5555");

  const [setupDeviceData, setSetupDeviceData] = useState<{ serial?: string; ip?: string; port?: number } | null>(null);
  const [deviceNumberInput, setDeviceNumberInput] = useState(nextDeviceNumber.toString());
  const [deviceNameInput, setDeviceNameInput] = useState(`Aparelho ${nextDeviceNumber}`);
  const [sectorInput, setSectorInput] = useState("junior");

  // Filtra dispositivos que já estão vinculados no sistema
  const isDeviceAlreadyAdded = (devSerial: string) => {
    const s = devSerial.trim().toLowerCase();
    const ipOnly = s.includes(":") ? s.split(":")[0] : s;
    return existingDevices.some((d) => {
      const ds = (d.serial || "").trim().toLowerCase();
      const da = (d.currentAdbAddress || "").trim().toLowerCase();
      const di = (d.ip || "").trim().toLowerCase();
      const de = (d.esferaDeviceId || "").trim().toLowerCase();
      const rawDe = de.replace("esf-", "");

      if (s && (ds === s || da === s || di === s)) return true;
      if (ipOnly && (di === ipOnly || da.startsWith(ipOnly) || ds.startsWith(ipOnly))) return true;
      if (rawDe && rawDe.length >= 4 && (s.includes(rawDe) || rawDe.includes(s))) return true;
      if (de && (s === de || s.includes(de))) return true;
      return false;
    });
  };

  const handlePrepareSetup = (data: { serial?: string; ip?: string; port?: number }) => {
    const matchedUsb = usbDevices.find((u) => u.serial === data.serial);
    const suggestedName =
      matchedUsb?.model && matchedUsb.model !== "Aparelho Android" ? matchedUsb.model : `Aparelho ${nextDeviceNumber}`;
    setDeviceNumberInput(nextDeviceNumber.toString());
    setDeviceNameInput(suggestedName);
    setSetupDeviceData(data);
  };

  const handleClose = () => {
    setSetupDeviceData(null);
    onClose();
  };

  const busy = linkingSerial !== null;
  const isError = !!linkingStatus && linkingStatus.startsWith("Erro");

  const statusBox = linkingStatus && (
    <div
      className={`flex items-start gap-2 rounded-lg border p-3 text-[0.8125rem] animate-scale-in ${
        isError
          ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
          : "border-border bg-secondary text-secondary"
      }`}
    >
      {busy && !isError && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
      <p className="min-w-0 break-words">{linkingStatus}</p>
    </div>
  );

  const footer = setupDeviceData ? (
    <>
      <Button variant="secondary" size="sm" onClick={() => setSetupDeviceData(null)} disabled={busy}>
        Voltar
      </Button>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={() => {
          const devNum = parseInt(deviceNumberInput, 10) || 1;
          if (setupDeviceData.serial) {
            onForceWirelessAdb(setupDeviceData.serial, devNum, sectorInput, deviceNameInput);
          } else if (setupDeviceData.ip) {
            onConnectDevice(setupDeviceData.ip, setupDeviceData.port || 5555, devNum, sectorInput, deviceNameInput);
          }
        }}
      >
        {busy ? "Conectando..." : "Conectar celular"}
      </Button>
    </>
  ) : (
    <>
      {connectTab === "usb" && (
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onFetchUsb} disabled={loadingUsb} className="mr-auto">
          Atualizar lista
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={handleClose}>
        Cancelar
      </Button>
      {connectTab === "manual" && (
        <Button
          variant="primary"
          size="sm"
          disabled={!connectIp.trim()}
          onClick={() => {
            if (!connectIp) return;
            handlePrepareSetup({ ip: connectIp, port: parseInt(connectPort, 10) || 5555 });
          }}
        >
          Avançar
        </Button>
      )}
      {connectTab === "pair" && (
        <Button
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!pairIp || !pairPort || !pairCode}
          onClick={() => {
            if (!pairIp || !pairPort || !pairCode) return;
            onPairAndConnectDevice(
              pairIp.trim(),
              parseInt(pairPort, 10) || 5555,
              pairCode.trim(),
              parseInt(connectPortInput, 10) || 5555,
              nextDeviceNumber,
              "junior",
              `Aparelho ${nextDeviceNumber}`
            );
          }}
        >
          Parear e conectar
        </Button>
      )}
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Conectar celular" size="lg" footer={footer}>
      {setupDeviceData ? (
        <div className="space-y-5 animate-scale-in">
          <FormSection title="Identificação do aparelho" description="Defina o nome e o setor em que este celular vai atuar.">
            <Field label="Nome do aparelho" htmlFor="conn-name">
              <input
                id="conn-name"
                type="text"
                value={deviceNameInput}
                onChange={(e) => setDeviceNameInput(e.target.value)}
                placeholder="Ex.: Aparelho 1"
                className={inputCls}
              />
            </Field>
            <Field label="Setor" htmlFor="conn-sector">
              <select id="conn-sector" value={sectorInput} onChange={(e) => setSectorInput(e.target.value)} className={inputCls}>
                {SECTOR_OPTIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          </FormSection>
          {statusBox}
        </div>
      ) : (
        <div className="space-y-5">
          <Tabs<ConnectTab>
            items={[
              { id: "usb", label: "Cabo USB", icon: <Usb size={14} /> },
              { id: "manual", label: "Por IP", icon: <Globe size={14} /> },
              { id: "pair", label: "Código de pareamento", icon: <KeyRound size={14} /> },
            ]}
            value={connectTab}
            onChange={setConnectTab}
          />

          {connectTab === "usb" ? (
            <div className="space-y-3">
              {loadingUsb ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-[0.8125rem] text-secondary">
                  <RefreshCw size={18} className="animate-spin" />
                  Buscando celulares conectados por USB...
                </div>
              ) : usbDevices.length === 0 ? (
                <EmptyState
                  icon={<Smartphone size={18} />}
                  title="Nenhum celular detectado"
                  description="Conecte o cabo USB e ative a depuração USB nas opções do desenvolvedor do Android."
                  action={
                    <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onFetchUsb}>
                      Buscar novamente
                    </Button>
                  }
                />
              ) : (
                <>
                  <p className="text-[0.8125rem] text-secondary">
                    {usbDevices.length} {usbDevices.length === 1 ? "celular detectado" : "celulares detectados"} neste computador
                  </p>
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                    {usbDevices.map((dev) => {
                      const safeSerial = String(dev.serial || "");
                      const safeModel = String(dev.model || "Aparelho Android");
                      const safeState = String(dev.state || "");
                      const isConnected = isDeviceAlreadyAdded(safeSerial);
                      const isIp = safeSerial.includes(":");

                      return (
                        <div key={safeSerial} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-[0.8125rem] font-medium text-primary">{safeModel}</p>
                              {isConnected && <Badge variant="success">Já conectado</Badge>}
                            </div>
                            <p className="truncate font-mono text-[0.75rem] text-tertiary">
                              {safeSerial} · {safeState}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={isConnected ? "secondary" : "primary"}
                            onClick={() => {
                              if (isIp) {
                                handlePrepareSetup({ ip: safeSerial.split(":")[0], port: 5555 });
                              } else {
                                handlePrepareSetup({ serial: safeSerial });
                              }
                            }}
                          >
                            {isConnected ? "Sincronizar" : isIp ? "Conectar por IP" : "Vincular por Wi-Fi"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : connectTab === "manual" ? (
            <FormSection title="Conectar por IP" description="O celular e este computador precisam estar na mesma rede.">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
                <Field label="Endereço IP do celular" htmlFor="conn-ip">
                  <input
                    id="conn-ip"
                    type="text"
                    value={connectIp}
                    onChange={(e) => setConnectIp(e.target.value)}
                    placeholder="192.168.1.105"
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label="Porta" htmlFor="conn-port" hint="Padrão 5555">
                  <input
                    id="conn-port"
                    type="text"
                    value={connectPort}
                    onChange={(e) => setConnectPort(e.target.value)}
                    placeholder="5555"
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </div>
            </FormSection>
          ) : (
            <div className="space-y-4">
              <FormSection
                title="Parear com código"
                description='No Android, abra "Depuração sem fio" e toque em "Parear dispositivo com código". Informe os dados exibidos.'
              >
                <div className="grid grid-cols-2 gap-4">
                  <Field label="IP do celular" htmlFor="pair-ip">
                    <input id="pair-ip" type="text" value={pairIp} onChange={(e) => setPairIp(e.target.value)} placeholder="192.168.1.82" className={`${inputCls} font-mono`} />
                  </Field>
                  <Field label="Porta de pareamento" htmlFor="pair-port">
                    <input id="pair-port" type="text" value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="37123" className={`${inputCls} font-mono`} />
                  </Field>
                  <Field label="Código de 6 dígitos" htmlFor="pair-code">
                    <input id="pair-code" type="text" value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="849201" className={`${inputCls} font-mono text-center`} />
                  </Field>
                  <Field label="Porta de conexão" htmlFor="pair-cport" hint="Padrão 5555">
                    <input id="pair-cport" type="text" value={connectPortInput} onChange={(e) => setConnectPortInput(e.target.value)} placeholder="5555" className={`${inputCls} font-mono`} />
                  </Field>
                </div>
              </FormSection>
              {statusBox}
            </div>
          )}
          {connectTab !== "pair" && statusBox}
        </div>
      )}
    </Modal>
  );
}
