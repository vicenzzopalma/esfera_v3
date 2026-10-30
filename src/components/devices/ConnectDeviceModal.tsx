// ============================================================
// Esfera v3 — Modal "Conectar aparelho"
// Conexão por USB, IP e código de pareamento (Android 11+)
// ============================================================

import { useEffect, useState, type ReactNode } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import Field, { FormSection } from "../ui/Field";
import { Tabs } from "../ui/Tabs";
import EmptyState from "../ui/EmptyState";
import type { Device } from "../../types";
import { RefreshCw, Smartphone, Usb, Globe, KeyRound, Loader2, Hand, Zap } from "lucide-react";
import { inputCls, SECTOR_OPTIONS, deviceDisplayName } from "./deviceUi";

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

type SetupData =
  | { kind: "usb"; serial: string }
  | { kind: "ip"; ip: string; port: number }
  | { kind: "pair"; ip: string; pairPort: number; code: string; connectPort: number };

// Estado do ADB em português, com o que o operador precisa fazer.
function usbStateView(state: string): { label: string; tone: "success" | "warning" | "neutral"; help?: string; ready: boolean } {
  switch (state) {
    case "device":
      return { label: "Pronto", tone: "success", ready: true };
    case "unauthorized":
      return {
        label: "Aguardando permissão",
        tone: "warning",
        ready: false,
        help: 'Desbloqueie o aparelho e toque em "Permitir" na janela "Permitir depuração USB?". Marque "Sempre permitir deste computador" e clique em Atualizar lista.',
      };
    case "offline":
      return { label: "Sem resposta", tone: "warning", ready: false, help: "Desconecte e conecte o cabo de novo. Se continuar, reinicie o aparelho." };
    case "authorizing":
      return { label: "Autorizando", tone: "warning", ready: false, help: "Aguarde alguns segundos e clique em Atualizar lista." };
    default:
      return { label: state || "Desconhecido", tone: "neutral", ready: false };
  }
}

function portValid(v: string) {
  const n = Number(v);
  return /^\d+$/.test(v.trim()) && n > 0 && n < 65536;
}

// Mensagens do backend vêm com emoji e tempo em ms: mostra só o que interessa.
function prettyStatus(text: string) {
  return text.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+em\s+\d+\s*ms!?/i, ".").trim();
}

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

  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [deviceNameInput, setDeviceNameInput] = useState("");
  const [sectorInput, setSectorInput] = useState("junior");

  // Cada abertura começa do zero: antes, o passo de identificação de uma conexão
  // anterior reaparecia com o nome antigo.
  useEffect(() => {
    if (!isOpen) return;
    setSetupData(null);
    setPairCode("");
  }, [isOpen]);

  // Procura o cadastro deste aparelho com comparação exata (evita confundir aparelhos
  // de serial parecido e herdar o nome de outro).
  const findExisting = (adbSerial: string): Device | undefined => {
    const s = adbSerial.trim().toLowerCase();
    if (!s) return undefined;
    const ip = s.includes(":") ? s.split(":")[0] : "";
    return existingDevices.find((d) => {
      const ds = (d.serial || "").trim().toLowerCase();
      const da = (d.currentAdbAddress || "").trim().toLowerCase();
      const di = (d.ip || "").trim().toLowerCase();
      const de = (d.esferaDeviceId || "").trim().toLowerCase();
      if (ds === s || da === s || de === s) return true;
      if (ip && (di === ip || ds.split(":")[0] === ip || da.split(":")[0] === ip)) return true;
      // ID antigo derivado do serial USB (ESF-<8 primeiros caracteres>).
      const rawDe = de.replace(/^esf-/, "");
      return rawDe.length >= 8 && !rawDe.includes("-") && s.startsWith(rawDe);
    });
  };

  const openSetup = (data: SetupData) => {
    setDeviceNameInput(`Celular ${nextDeviceNumber}`);
    setSectorInput("junior");
    setSetupData(data);
  };

  const handleClose = () => {
    setSetupData(null);
    onClose();
  };

  const busy = linkingSerial !== null;
  const isError = !!linkingStatus && (linkingStatus.startsWith("Erro") || linkingStatus.startsWith("Tempo esgotado"));
  const nameTrim = deviceNameInput.trim();
  const genericName = /^aparelho\s/i.test(nameTrim);

  const statusBox = linkingStatus && (
    <div
      role={isError ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border p-3 text-[0.8125rem] animate-scale-in ${
        isError ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : "border-border bg-secondary text-secondary"
      }`}
    >
      {busy && !isError && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}
      <p className="min-w-0 break-words">{prettyStatus(linkingStatus)}</p>
    </div>
  );

  const confirmSetup = () => {
    if (!setupData || !nameTrim || busy) return;
    if (setupData.kind === "usb") {
      onForceWirelessAdb(setupData.serial, nextDeviceNumber, sectorInput, nameTrim);
    } else if (setupData.kind === "ip") {
      onConnectDevice(setupData.ip, setupData.port, nextDeviceNumber, sectorInput, nameTrim);
    } else {
      onPairAndConnectDevice(setupData.ip, setupData.pairPort, setupData.code, setupData.connectPort, nextDeviceNumber, sectorInput, nameTrim);
    }
  };

  const ipValid = connectIp.trim().length > 0 && (connectPort.trim() === "" || portValid(connectPort));
  const codeDigits = pairCode.replace(/\D/g, "");
  const pairValid = pairIp.trim().length > 0 && portValid(pairPort) && codeDigits.length === 6 && (connectPortInput.trim() === "" || portValid(connectPortInput));

  const footer = setupData ? (
    <>
      <Button variant="secondary" size="sm" onClick={() => setSetupData(null)} disabled={busy}>
        Voltar
      </Button>
      <Button variant="primary" size="sm" loading={busy} disabled={!nameTrim} onClick={confirmSetup}>
        {busy ? "Conectando..." : setupData.kind === "pair" ? "Parear e conectar" : "Conectar aparelho"}
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
          disabled={!ipValid}
          onClick={() => {
            if (!ipValid) return;
            openSetup({ kind: "ip", ip: connectIp.trim(), port: parseInt(connectPort, 10) || 5555 });
          }}
        >
          Avançar
        </Button>
      )}
      {connectTab === "pair" && (
        <Button
          variant="primary"
          size="sm"
          disabled={!pairValid}
          onClick={() => {
            if (!pairValid) return;
            openSetup({
              kind: "pair",
              ip: pairIp.trim(),
              pairPort: parseInt(pairPort, 10),
              code: codeDigits,
              connectPort: parseInt(connectPortInput, 10) || 5555,
            });
          }}
        >
          Avançar
        </Button>
      )}
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Conectar aparelho" size="lg" footer={footer} closeOnOverlayClick={!setupData && !busy}>
      {setupData ? (
        <div className="space-y-5 animate-scale-in">
          <FormSection title="Identificação do aparelho" description="Defina o nome e o setor em que este aparelho vai atuar. O nome só muda depois por edição manual nas configurações.">
            <Field
              label="Nome do aparelho"
              htmlFor="conn-name"
              required
              error={!nameTrim ? "Dê um nome ao aparelho." : undefined}
              hint={
                genericName
                  ? 'Nomes no formato "Aparelho N" são tratados como automáticos e trocados por "Celular" + código. Prefira outro nome.'
                  : "Use um nome fácil de achar na lista, como o número do aparelho na bancada."
              }
            >
              <input
                id="conn-name"
                type="text"
                value={deviceNameInput}
                onChange={(e) => setDeviceNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmSetup();
                }}
                placeholder="Ex.: Celular 4"
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
                  Buscando aparelhos conectados por USB...
                </div>
              ) : usbDevices.length === 0 ? (
                <EmptyState
                  icon={<Smartphone size={18} />}
                  title="Nenhum aparelho detectado"
                  description="Conecte o cabo USB (de dados, não só de carga) e ative a depuração USB nas opções do desenvolvedor do Android."
                  action={
                    <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onFetchUsb}>
                      Buscar novamente
                    </Button>
                  }
                />
              ) : (
                <>
                  <p className="text-[0.8125rem] text-secondary">
                    {usbDevices.length} {usbDevices.length === 1 ? "aparelho detectado" : "aparelhos detectados"} neste computador
                  </p>
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
                    {usbDevices.map((dev) => {
                      const safeSerial = String(dev.serial || "");
                      const safeModel = String(dev.model || "Aparelho Android");
                      const view = usbStateView(String(dev.state || ""));
                      const existing = findExisting(safeSerial);
                      const isIp = safeSerial.includes(":");
                      const linkingThis = busy && linkingSerial === safeSerial;

                      let action: ReactNode = null;
                      if (!view.ready) {
                        action = null;
                      } else if (existing) {
                        // Já cadastrado: religa sem formulário, mantendo nome, número e setor.
                        action = isIp ? (
                          <span className="text-[0.75rem] text-tertiary">Conectado por Wi-Fi</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={linkingThis}
                            disabled={busy && !linkingThis}
                            icon={<Zap size={13} />}
                            title="Liga o controle por Wi-Fi para usar o aparelho sem o cabo"
                            onClick={() => onForceWirelessAdb(safeSerial, existing.deviceNumber || 0, existing.sector || "junior", existing.name || "")}
                          >
                            Ativar Wi-Fi
                          </Button>
                        );
                      } else {
                        action = (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={busy}
                            onClick={() => (isIp ? openSetup({ kind: "ip", ip: safeSerial.split(":")[0], port: parseInt(safeSerial.split(":")[1], 10) || 5555 }) : openSetup({ kind: "usb", serial: safeSerial }))}
                          >
                            Cadastrar
                          </Button>
                        );
                      }

                      return (
                        <div key={safeSerial} className="space-y-2 rounded-lg border border-border bg-card p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <p className="truncate text-[0.8125rem] font-medium text-primary">{existing ? deviceDisplayName(existing) : safeModel}</p>
                                {existing ? <Badge variant="success">Já cadastrado</Badge> : <Badge variant={view.tone}>{view.label}</Badge>}
                              </div>
                              <p className="truncate font-mono text-[0.75rem] text-tertiary">
                                {existing ? `${safeModel} · ` : ""}
                                {safeSerial}
                              </p>
                            </div>
                            <div className="shrink-0">{action}</div>
                          </div>
                          {view.help && (
                            <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[0.75rem] text-amber-700 dark:text-amber-400">
                              <Hand size={12} className="mt-0.5 shrink-0" />
                              <span>{view.help}</span>
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ) : connectTab === "manual" ? (
            <FormSection title="Conectar por IP" description="O aparelho e este computador precisam estar na mesma rede, com a depuração por Wi-Fi ativa no aparelho.">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
                <Field label="Endereço IP do aparelho" htmlFor="conn-ip">
                  <input
                    id="conn-ip"
                    type="text"
                    value={connectIp}
                    onChange={(e) => setConnectIp(e.target.value)}
                    placeholder="192.168.1.105"
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label="Porta" htmlFor="conn-port" hint="Padrão 5555" error={connectPort.trim() && !portValid(connectPort) ? "Porta inválida." : undefined}>
                  <input
                    id="conn-port"
                    type="text"
                    inputMode="numeric"
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
                description='No Android 11 ou mais novo, abra "Depuração por Wi-Fi" e toque em "Parear dispositivo com código de pareamento". Informe os dados exibidos.'
              >
                <div className="grid grid-cols-2 gap-4">
                  <Field label="IP do aparelho" htmlFor="pair-ip">
                    <input id="pair-ip" type="text" value={pairIp} onChange={(e) => setPairIp(e.target.value)} placeholder="192.168.1.82" className={`${inputCls} font-mono`} />
                  </Field>
                  <Field label="Porta de pareamento" htmlFor="pair-port" error={pairPort.trim() && !portValid(pairPort) ? "Porta inválida." : undefined}>
                    <input id="pair-port" type="text" inputMode="numeric" value={pairPort} onChange={(e) => setPairPort(e.target.value)} placeholder="37123" className={`${inputCls} font-mono`} />
                  </Field>
                  <Field label="Código de 6 dígitos" htmlFor="pair-code" error={pairCode.trim() && codeDigits.length !== 6 ? "O código tem 6 dígitos." : undefined}>
                    <input
                      id="pair-code"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={pairCode}
                      onChange={(e) => setPairCode(e.target.value)}
                      placeholder="849201"
                      className={`${inputCls} font-mono text-center`}
                    />
                  </Field>
                  <Field
                    label="Porta de conexão"
                    htmlFor="pair-cport"
                    hint="A que aparece em Depuração por Wi-Fi (padrão 5555)"
                    error={connectPortInput.trim() && !portValid(connectPortInput) ? "Porta inválida." : undefined}
                  >
                    <input
                      id="pair-cport"
                      type="text"
                      inputMode="numeric"
                      value={connectPortInput}
                      onChange={(e) => setConnectPortInput(e.target.value)}
                      placeholder="5555"
                      className={`${inputCls} font-mono`}
                    />
                  </Field>
                </div>
              </FormSection>
            </div>
          )}
          {statusBox}
        </div>
      )}
    </Modal>
  );
}
