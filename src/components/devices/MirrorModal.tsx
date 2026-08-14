// ============================================================
// Esfera v3 — Sub-componente MirrorModal (Linear SaaS Style)
// Modal de espelhamento de tela, controle remoto ADB, digitação e câmera virtual.
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import type { Device } from "../../types";
import { api } from "../../tauri";
import {
  RefreshCw,
  Home,
  ArrowLeft,
  Power,
  Camera,
  Layers,
  Sparkles,
  MonitorPlay,
  Video,
  ScreenShare,
  EyeOff,
  RotateCcw,
  Send,
  Keyboard,
  Volume2,
  VolumeX,
  ClipboardPaste,
  SunMedium,
} from "lucide-react";

type MirrorMode = "frame" | "scrcpy" | "scrcpy_off" | "virtual";

interface MirrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onOpenRegion: () => void;
}

function toImgSrc(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("data:")) return raw;
  return `data:image/png;base64,${raw}`;
}

export function MirrorModal({
  isOpen,
  onClose,
  device,
  onOpenRegion,
}: MirrorModalProps) {
  const [screenSrc, setScreenSrc] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mode, setMode] = useState<MirrorMode>("frame");
  const [busy, setBusy] = useState(false);
  const [streamMsg, setStreamMsg] = useState<string | null>(null);
  const [textInput, setTextInput] = useState("");
  const [sendingText, setSendingText] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const serial = device.currentAdbAddress || device.serial;

  // ---- Frame ADB (preview interno contínuo) ----
  const fetchScreenFrame = useCallback(async () => {
    if (!isOpen) return;
    setLoadingFrame(true);
    setErrorMsg(null);
    try {
      const src = await api<string>("capture_device_screen", { serial });
      setScreenSrc(toImgSrc(src));
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Falha ao capturar frame.";
      setErrorMsg(msg);
    } finally {
      setLoadingFrame(false);
    }
  }, [isOpen, serial]);

  // Reset ao abrir/fechar ou trocar de device
  useEffect(() => {
    if (!isOpen) {
      setScreenSrc(null);
      setErrorMsg(null);
      setStreamMsg(null);
      setTextInput("");
      return;
    }
    setStreamMsg(null);
    fetchScreenFrame();
  }, [isOpen, serial, fetchScreenFrame]);

  // Auto-refresh contínuo do frame ADB apenas quando no modo "frame"
  useEffect(() => {
    if (!isOpen || mode !== "frame") return;
    fetchScreenFrame();
    const intervalId = setInterval(fetchScreenFrame, 2500);
    return () => clearInterval(intervalId);
  }, [isOpen, mode, fetchScreenFrame]);

  // ---- Ações de espelhamento (scrcpy / display virtual) ----
  const startMode = async (next: MirrorMode) => {
    setMode(next);
    setStreamMsg(null);
    setErrorMsg(null);
    if (next === "frame") {
      fetchScreenFrame();
      return;
    }
    setBusy(true);
    try {
      let msg = "";
      if (next === "scrcpy") {
        msg = await api<string>("launch_scrcpy_stream", { serial, turnScreenOff: false });
      } else if (next === "scrcpy_off") {
        msg = await api<string>("launch_scrcpy_stream", { serial, turnScreenOff: true });
      } else if (next === "virtual") {
        msg = await api<string>("launch_virtual_display_stream", {
          serial,
          width: 1080,
          height: 1920,
          dpi: 320,
        });
      }
      setStreamMsg(`${msg}\n(⚡ Janela externa Scrcpy ativa — controle e preview interno sincronizados)`);
    } catch (e: any) {
      setErrorMsg(typeof e === "string" ? e : e?.message || "Falha ao iniciar espelhamento.");
    } finally {
      setBusy(false);
    }
  };

  // ---- Digitação Direta no Android via ADB ----
  const handleSendText = async () => {
    if (!textInput.trim()) return;
    setSendingText(true);
    try {
      await api("send_adb_input_text", { serial, text: textInput });
      setTextInput("");
      setTimeout(fetchScreenFrame, 300);
    } catch (e: any) {
      setErrorMsg(typeof e === "string" ? e : e?.message || "Erro ao digitar texto no celular.");
    } finally {
      setSendingText(false);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) {
        setSendingText(true);
        await api("send_adb_input_text", { serial, text: clip });
        setTimeout(fetchScreenFrame, 300);
      }
    } catch {
      setErrorMsg("Não foi possível ler a área de transferência.");
    } finally {
      setSendingText(false);
    }
  };

  // ---- Câmera traseira / frontal ----
  const startCamera = async (facing: "back" | "front") => {
    setBusy(true);
    setErrorMsg(null);
    setStreamMsg(null);
    try {
      const msg = await api<string>("launch_camera_stream", { serial, facing });
      setStreamMsg(msg);
    } catch (e: any) {
      setErrorMsg(typeof e === "string" ? e : e?.message || "Falha ao abrir câmera.");
    } finally {
      setBusy(false);
    }
  };

  // ---- Roubar a câmera: injeta a tela do PC na Câmera Virtual do celular ----
  const stealCamera = async () => {
    setBusy(true);
    setErrorMsg(null);
    setStreamMsg(null);
    try {
      const msg = await api<string>("inject_virtual_camera", { serial, targetType: "full" });
      setStreamMsg(msg);
    } catch (e: any) {
      setErrorMsg(typeof e === "string" ? e : e?.message || "Falha ao injetar tela do PC.");
    } finally {
      setBusy(false);
    }
  };

  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const normX = Math.round((clickX / rect.width) * 1080);
    const normY = Math.round((clickY / rect.height) * 2400);
    try {
      await api("send_adb_tap", { serial, x: normX, y: normY });
      setTimeout(fetchScreenFrame, 300);
    } catch {
      /* noop */
    }
  };

  const handleKeyevent = async (code: number) => {
    try {
      await api("send_adb_keyevent", { serial, keycode: code });
      setTimeout(fetchScreenFrame, 300);
    } catch {
      /* noop */
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Controle Remoto: ${device.name || device.model} (${device.esferaDeviceId || device.serial})`}
      size="xl"
      footer={
        <div className="flex justify-between items-center w-full text-xs gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onOpenRegion}
            icon={<Camera size={13} className="text-amber-400" />}
          >
            Leitura de QR Code (Câmera)
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Fechar
          </Button>
        </div>
      }
    >
      <div className="flex flex-col lg:flex-row gap-5 items-start text-xs">
        {/* Left: Device Display Screen */}
        <div className="w-full lg:w-[320px] shrink-0 bg-[#09090b] border border-white/[0.08] rounded-xl p-3 flex flex-col items-center justify-center min-h-[460px] relative overflow-hidden shadow-inner">
          {screenSrc ? (
            <div className="relative group flex flex-col items-center">
              <img
                ref={imgRef}
                src={screenSrc}
                alt="Tela do Celular"
                onClick={handleImageClick}
                className="max-h-[440px] w-auto rounded-lg border border-white/[0.06] shadow-md cursor-crosshair transition-transform hover:scale-[1.005]"
              />
              <div className="absolute bottom-2 inset-x-2 bg-black/75 backdrop-blur-sm px-2.5 py-1 rounded text-[10px] text-zinc-300 text-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                Clique na tela para enviar toque ADB
              </div>
            </div>
          ) : (
            <div className="text-center p-6 text-zinc-500">
              {loadingFrame ? (
                <>
                  <RefreshCw size={26} className="animate-spin text-[#828DF7] mx-auto mb-2" />
                  <p className="font-medium text-zinc-400">Capturando tela do Android...</p>
                </>
              ) : (
                <>
                  <MonitorPlay size={28} className="text-zinc-600 mx-auto mb-2" />
                  <p>Iniciando stream de tela...</p>
                </>
              )}
            </div>
          )}

          {/* Badge de modo ativo */}
          {mode !== "frame" && (
            <div className="mt-2.5 px-2.5 py-1 rounded bg-[#5E6AD2]/15 border border-[#5E6AD2]/30 text-[10px] text-[#828DF7] font-medium flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>Scrcpy Ativo (Janela Externa)</span>
            </div>
          )}
        </div>

        {/* Right: Controls & Interactive Keyboard */}
        <div className="flex-1 space-y-3.5 w-full min-w-0">
          {/* Seção 1: Digitar no Celular (ADB Text Input) */}
          <div className="p-3.5 bg-[#141418] border border-white/[0.07] rounded-xl space-y-2.5">
            <div className="flex items-center justify-between">
              <h5 className="font-semibold text-zinc-100 flex items-center gap-1.5 text-xs">
                <Keyboard size={14} className="text-[#828DF7]" /> Digitar no Celular (Entrada ADB)
              </h5>
              <button
                type="button"
                onClick={handlePasteClipboard}
                disabled={sendingText}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 px-2 py-0.5 rounded bg-white/[0.04] border border-white/[0.06] transition-colors"
                title="Colar texto da área de transferência do PC"
              >
                <ClipboardPaste size={12} className="text-amber-400" /> Colar do PC
              </button>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSendText();
                }}
                placeholder="Digite texto e pressione Enter para enviar ao celular..."
                disabled={sendingText}
                className="flex-1 px-3 py-1.5 rounded-md bg-[#09090b] border border-white/[0.08] text-zinc-100 text-xs font-medium focus:outline-none focus:border-[#5E6AD2]"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSendText}
                disabled={sendingText || !textInput.trim()}
                loading={sendingText}
                icon={<Send size={12} />}
              >
                Enviar
              </Button>
            </div>

            {/* Teclas rápidas de digitação */}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => handleKeyevent(66)}
                className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-[10px] font-mono border border-white/[0.06] transition-colors"
              >
                ↵ Enter
              </button>
              <button
                type="button"
                onClick={() => handleKeyevent(67)}
                className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-[10px] font-mono border border-white/[0.06] transition-colors"
              >
                ⌫ Apagar
              </button>
              <button
                type="button"
                onClick={() => handleKeyevent(62)}
                className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-[10px] font-mono border border-white/[0.06] transition-colors"
              >
                ␣ Espaço
              </button>
              <button
                type="button"
                onClick={() => handleKeyevent(61)}
                className="px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] text-zinc-300 text-[10px] font-mono border border-white/[0.06] transition-colors"
              >
                ⇥ Tab
              </button>
            </div>
          </div>

          {/* Seção 2: Modo de Espelhamento */}
          <div className="p-3.5 bg-[#141418] border border-white/[0.07] rounded-xl space-y-2.5">
            <h5 className="font-semibold text-zinc-100 flex items-center gap-1.5 text-xs">
              <ScreenShare size={14} className="text-[#828DF7]" /> Modo de Espelhamento
            </h5>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Button
                variant={mode === "frame" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("frame")}
                icon={<RefreshCw size={12} />}
              >
                Frame Interno
              </Button>
              <Button
                variant={mode === "scrcpy" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("scrcpy")}
                loading={busy && mode !== "scrcpy"}
                icon={<ScreenShare size={12} />}
              >
                Scrcpy 60FPS
              </Button>
              <Button
                variant={mode === "scrcpy_off" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("scrcpy_off")}
                loading={busy && mode !== "scrcpy_off"}
                icon={<EyeOff size={12} />}
              >
                Tela Off
              </Button>
              <Button
                variant={mode === "virtual" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("virtual")}
                loading={busy && mode !== "virtual"}
                icon={<MonitorPlay size={12} />}
              >
                Display #2
              </Button>
            </div>
          </div>

          {/* Seção 3: Botões Físicos & Navegação Android */}
          <div className="p-3.5 bg-[#141418] border border-white/[0.07] rounded-xl space-y-2.5">
            <h5 className="font-semibold text-zinc-100 text-xs">Navegação & Botões Físicos</h5>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(4)} icon={<ArrowLeft size={12} />}>
                Voltar
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(3)} icon={<Home size={12} />}>
                Início
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(187)} icon={<Layers size={12} />}>
                Apps
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(24)} icon={<Volume2 size={12} />}>
                Vol +
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(25)} icon={<VolumeX size={12} />}>
                Vol -
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleKeyevent(26)}
                icon={<Power size={12} className="text-red-400" />}
              >
                Power
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleKeyevent(224)}
                icon={<SunMedium size={12} className="text-amber-400" />}
              >
                Acordar Tela (Wakeup)
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchScreenFrame}
                loading={loadingFrame}
                icon={<RotateCcw size={12} />}
              >
                Atualizar Frame
              </Button>
            </div>
          </div>

          {/* Seção 4: Câmeras & Injeção Virtual */}
          <div className="p-3.5 bg-[#141418] border border-white/[0.07] rounded-xl space-y-2.5">
            <h5 className="font-semibold text-zinc-100 text-xs">Câmera e Injeção Virtual</h5>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => startCamera("back")}
                loading={busy}
                icon={<Camera size={12} className="text-emerald-400" />}
              >
                Câmera Traseira
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => startCamera("front")}
                loading={busy}
                icon={<Camera size={12} className="text-sky-400" />}
              >
                Câmera Frontal
              </Button>
            </div>

            <Button
              variant="secondary"
              size="sm"
              onClick={stealCamera}
              loading={busy}
              icon={<Video size={12} className="text-fuchsia-400" />}
              className="w-full"
            >
              Roubar Câmera (Injetar Tela do PC na Câmera)
            </Button>
          </div>

          {/* Seção 5: Ação Rápida WhatsApp */}
          <Button
            variant="primary"
            size="sm"
            onClick={async () => {
              try {
                await api("send_intent_to_display", {
                  serial,
                  url: "https://wa.me/",
                  displayId: 0,
                });
                setTimeout(fetchScreenFrame, 600);
              } catch {
                /* noop */
              }
            }}
            icon={<Sparkles size={13} />}
            className="w-full py-2 font-semibold shadow-md"
          >
            Abrir WhatsApp Business
          </Button>

          {/* Mensagens de feedback */}
          {streamMsg && (
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono text-[11px] rounded-lg whitespace-pre-wrap">
              {streamMsg}
            </div>
          )}
          {errorMsg && (
            <div className="p-2.5 bg-red-500/10 border border-red-500/20 text-red-300 font-mono text-[11px] rounded-lg whitespace-pre-wrap">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
