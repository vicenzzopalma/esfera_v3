// ============================================================
// Esfera v3 — Sub-componente ConnectDeviceModal (Linear SaaS Style)
// Modal de conexão USB, Wi-Fi e pareamento de celulares
// ============================================================

import { useState } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import type { Device } from "../../types";
import { RefreshCw, Smartphone, CheckCircle2, Eye, EyeOff } from "lucide-react";

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
  const [connectTab, setConnectTab] = useState<"usb" | "manual" | "pair" | "apk">("usb");
  const [connectIp, setConnectIp] = useState("");
  const [connectPort, setConnectPort] = useState("5555");
  const [pairIp, setPairIp] = useState("");
  const [pairPort, setPairPort] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [connectPortInput, setConnectPortInput] = useState("5555");
  const [showAlreadyConnected, setShowAlreadyConnected] = useState(false);

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

  const newUsbDevices = usbDevices.filter((dev) => !isDeviceAlreadyAdded(dev.serial));
  const alreadyConnectedDevices = usbDevices.filter((dev) => isDeviceAlreadyAdded(dev.serial));

  const handlePrepareSetup = (data: { serial?: string; ip?: string; port?: number }) => {
    setDeviceNumberInput(nextDeviceNumber.toString());
    setDeviceNameInput(`Aparelho ${nextDeviceNumber}`);
    setSetupDeviceData(data);
  };

  const handleClose = () => {
    setSetupDeviceData(null);
    setShowAlreadyConnected(false);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Conectar Novo Celular Android"
      size="lg"
      footer={
        <div className="flex justify-between items-center w-full text-xs">
          {setupDeviceData ? (
            <div className="flex gap-2 ml-auto">
              <Button variant="secondary" size="sm" onClick={() => setSetupDeviceData(null)} disabled={linkingSerial !== null}>
                Voltar
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const devNum = parseInt(deviceNumberInput, 10) || 1;
                  if (setupDeviceData.serial) {
                    onForceWirelessAdb(setupDeviceData.serial, devNum, sectorInput, deviceNameInput);
                  } else if (setupDeviceData.ip) {
                    onConnectDevice(setupDeviceData.ip, setupDeviceData.port || 5555, devNum, sectorInput, deviceNameInput);
                  }
                }}
                disabled={linkingSerial !== null}
              >
                {linkingSerial ? "Conectando..." : "Conectar Celular"}
              </Button>
            </div>
          ) : (
            <>
              {connectTab === "usb" && (
                <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onFetchUsb} disabled={loadingUsb}>
                  Atualizar USB
                </Button>
              )}
              <div className="flex gap-2 ml-auto">
                <Button variant="secondary" size="sm" onClick={handleClose}>
                  Cancelar
                </Button>
                {connectTab === "manual" && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      if (!connectIp) return;
                      handlePrepareSetup({ ip: connectIp, port: parseInt(connectPort, 10) || 5555 });
                    }}
                  >
                    Avançar
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      }
    >
      {setupDeviceData ? (
        <div className="space-y-4 text-xs animate-scale-in">
          <div>
            <h4 className="font-semibold text-zinc-100 mb-0.5">Identificação do Aparelho</h4>
            <p className="text-[11px] text-zinc-500">
              Defina o nome e o setor onde este celular atuará no sistema.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Nome do Aparelho</label>
            <input
              type="text"
              value={deviceNameInput}
              onChange={(e) => setDeviceNameInput(e.target.value)}
              placeholder="Ex: Aparelho 1"
              className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">Setor Operacional</label>
            <select
              value={sectorInput}
              onChange={(e) => setSectorInput(e.target.value)}
              className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs focus:outline-none focus:border-[#5E6AD2]"
            >
              <option value="junior">Junior</option>
              <option value="senior">Senior</option>
              <option value="pa_fixa">PA Fixa</option>
              <option value="pesquisa">Pesquisa</option>
            </select>
          </div>

          {linkingStatus && (
            <div className="p-3 rounded-md bg-[#5E6AD2]/10 border border-[#5E6AD2]/20 text-[#828DF7] text-[11px] font-mono animate-scale-in">
              <p className="flex items-center gap-1.5 font-bold mb-0.5">
                <RefreshCw size={12} className="animate-spin" /> Processando ADB...
              </p>
              <p>{linkingStatus}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 text-xs">
          {/* Navigation Tabs */}
          <div className="flex border-b border-white/[0.07]">
            <button
              onClick={() => setConnectTab("usb")}
              className={`flex-1 py-2 text-center font-medium cursor-pointer border-b-2 text-xs transition-all ${
                connectTab === "usb"
                  ? "border-[#5E6AD2] text-[#828DF7]"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              🔌 Cabo USB (Auto)
            </button>
            <button
              onClick={() => setConnectTab("manual")}
              className={`flex-1 py-2 text-center font-medium cursor-pointer border-b-2 text-xs transition-all ${
                connectTab === "manual"
                  ? "border-[#5E6AD2] text-[#828DF7]"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              🌐 Conectar por IP
            </button>
            <button
              onClick={() => setConnectTab("pair")}
              className={`flex-1 py-2 text-center font-medium cursor-pointer border-b-2 text-xs transition-all ${
                connectTab === "pair"
                  ? "border-[#5E6AD2] text-[#828DF7]"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              🔑 Código (Android 11+)
            </button>
          </div>

          {connectTab === "usb" ? (
            <div className="space-y-3">
              {loadingUsb ? (
                <div className="flex flex-col items-center justify-center py-6 text-zinc-400">
                  <RefreshCw size={20} className="animate-spin text-[#828DF7] mb-2" />
                  <span>Buscando celulares conectados via USB...</span>
                </div>
              ) : usbDevices.length === 0 ? (
                <div className="text-center py-6 border border-dashed border-white/[0.08] rounded-lg p-4">
                  <Smartphone size={28} className="mx-auto text-zinc-600 mb-1" />
                  <p className="font-medium text-zinc-300">Nenhum celular detectado no ADB</p>
                  <p className="text-[11px] text-zinc-500 mt-0.5">Conecte o cabo USB e ative a "Depuração USB".</p>
                </div>
              ) : newUsbDevices.length === 0 && !showAlreadyConnected ? (
                <div className="text-center py-5 border border-emerald-500/20 bg-emerald-500/[0.04] rounded-lg p-4 space-y-2 animate-fade-in">
                  <CheckCircle2 size={30} className="mx-auto text-emerald-400 mb-1" />
                  <p className="font-semibold text-zinc-100 text-xs">Todos os celulares detectados já estão conectados</p>
                  <p className="text-[11px] text-zinc-400 max-w-sm mx-auto">
                    Todos os {alreadyConnectedDevices.length} aparelho(s) ADB encontrados neste computador já estão cadastrados e ativos no sistema.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAlreadyConnected(true)}
                    className="mt-2 text-[11px] text-[#828DF7] hover:underline font-medium cursor-pointer inline-flex items-center gap-1"
                  >
                    <Eye size={12} /> Ver aparelhos já conectados ({alreadyConnectedDevices.length})
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-zinc-400">
                      {newUsbDevices.length > 0
                        ? `Novos aparelhos disponíveis para conexão (${newUsbDevices.length}):`
                        : `Aparelhos já vinculados no sistema (${alreadyConnectedDevices.length}):`}
                    </p>
                    {alreadyConnectedDevices.length > 0 && newUsbDevices.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAlreadyConnected(!showAlreadyConnected)}
                        className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 cursor-pointer"
                      >
                        {showAlreadyConnected ? <EyeOff size={11} /> : <Eye size={11} />}
                        {showAlreadyConnected ? "Ocultar já conectados" : `Ver já conectados (${alreadyConnectedDevices.length})`}
                      </button>
                    )}
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                    {(showAlreadyConnected ? usbDevices : newUsbDevices).map((dev) => {
                      const safeSerial = String(dev.serial || "");
                      const safeModel = String(dev.model || "Aparelho Android");
                      const safeState = String(dev.state || "");
                      const isConnected = isDeviceAlreadyAdded(safeSerial);

                      return (
                        <div
                          key={safeSerial}
                          className={`flex items-center justify-between p-2.5 rounded-md border ${
                            isConnected
                              ? "bg-emerald-500/[0.03] border-emerald-500/20 opacity-80"
                              : "bg-white/[0.02] border-white/[0.06]"
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="font-medium text-zinc-100">{safeModel}</p>
                              {isConnected && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">
                                  Já Conectado
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-zinc-500 font-mono">
                              {safeSerial.includes(":") ? "🟢 IP: " : "🔌 USB: "} {safeSerial} ({safeState})
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant={isConnected ? "secondary" : "primary"}
                            onClick={() => {
                              if (safeSerial.includes(":")) {
                                const ipOnly = safeSerial.split(":")[0];
                                handlePrepareSetup({ ip: ipOnly, port: 5555 });
                              } else {
                                handlePrepareSetup({ serial: safeSerial });
                              }
                            }}
                          >
                            {isConnected ? "Re-sincronizar" : safeSerial.includes(":") ? "Conectar IP" : "Vincular Wi-Fi"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : connectTab === "manual" ? (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Endereço IP do Celular</label>
                <input
                  type="text"
                  value={connectIp}
                  onChange={(e) => setConnectIp(e.target.value)}
                  placeholder="Ex: 192.168.1.105"
                  className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 font-mono text-xs focus:outline-none focus:border-[#5E6AD2]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">Porta ADB (Padrão 5555)</label>
                <input
                  type="text"
                  value={connectPort}
                  onChange={(e) => setConnectPort(e.target.value)}
                  placeholder="5555"
                  className="w-full px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 font-mono text-xs focus:outline-none focus:border-[#5E6AD2]"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] text-zinc-400">
                Acesse "Depuração sem Fio" ➔ "Parear com código de pareamento". Digite o IP, Porta e o Código de 6 dígitos gerados:
              </p>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-medium text-zinc-400 mb-1">IP do Celular</label>
                  <input
                    type="text"
                    value={pairIp}
                    onChange={(e) => setPairIp(e.target.value)}
                    placeholder="Ex: 192.168.1.82"
                    className="w-full px-2.5 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-zinc-400 mb-1">Porta Pareamento</label>
                  <input
                    type="text"
                    value={pairPort}
                    onChange={(e) => setPairPort(e.target.value)}
                    placeholder="Ex: 37123"
                    className="w-full px-2.5 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 font-mono text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-medium text-zinc-400 mb-1">Código (6 Dígitos)</label>
                  <input
                    type="text"
                    value={pairCode}
                    onChange={(e) => setPairCode(e.target.value)}
                    placeholder="Ex: 849201"
                    className="w-full px-2.5 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-[#828DF7] font-mono text-xs tracking-widest text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-zinc-400 mb-1">Porta Conexão</label>
                  <input
                    type="text"
                    value={connectPortInput}
                    onChange={(e) => setConnectPortInput(e.target.value)}
                    placeholder="5555"
                    className="w-full px-2.5 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 font-mono text-xs"
                  />
                </div>
              </div>

              <Button
                variant="primary"
                size="sm"
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
                className="w-full mt-2"
              >
                Parear e Conectar
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
