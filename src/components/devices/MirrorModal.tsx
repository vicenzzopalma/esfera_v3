// ============================================================
// Esfera v3 — Sub-componente MirrorModal (Linear SaaS Style)
// Modal de espelhamento de tela, controle remoto ADB e câmera virtual.
// AUDITADO: corrige invoke inválido (capture_screen -> capture_device_screen),
// adiciona seletor de modos de espelhamento, câmera traseira/frontal e
// injeção de tela do PC na Câmera Virtual ("roubar a câmera").
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
} from "lucide-react";

type MirrorMode = "frame" | "scrcpy" | "scrcpy_off" | "virtual";

interface MirrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onOpenRegion: () => void;
}

// Converte o retorno do backend (data:URL ou base64 puro) em src de <img>.
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
  const imgRef = useRef<HTMLImageElement>(null);

  const serial = device.serial;

  // ---- Frame ADB (preview interno) ----
  const fetchScreenFrame = useCallback(async () => {
    if (!isOpen || mode !== "frame") return;
    setLoadingFrame(true);
    setErrorMsg(null);
    try {
      const src = await api<string>("capture_device_screen", { serial });
      setScreenSrc(toImgSrc(src));
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Falha ao capturar frame.";
      setErrorMsg(msg);
      setScreenSrc(null);
    } finally {
      setLoadingFrame(false);
    }
  }, [isOpen, mode, serial]);

  // Reset ao abrir/fechar ou trocar de device.
  useEffect(() => {
    if (!isOpen) {
      setScreenSrc(null);
      setErrorMsg(null);
      setStreamMsg(null);
      return;
    }
    setStreamMsg(null);
    if (mode === "frame") fetchScreenFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, serial]);

  // Auto-refresh do frame ADB enquanto no modo "frame".
  useEffect(() => {
    if (!isOpen || mode !== "frame") return;
    fetchScreenFrame();
    const intervalId = setInterval(fetchScreenFrame, 1500);
    return () => clearInterval(intervalId);
  }, [isOpen, mode, fetchScreenFrame]);

  // ---- Ações de espelhamento (scrcpy / display virtual) ----
  const startMode = async (next: MirrorMode) => {
    setMode(next);
    setStreamMsg(null);
    setErrorMsg(null);
    if (next === "frame") {
      setScreenSrc(null);
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
      setStreamMsg(`${msg}\n(Aba externa do scrcpy — use o preview de frame para controle interno)`);
    } catch (e: any) {
      setErrorMsg(typeof e === "string" ? e : e?.message || "Falha ao iniciar espelhamento.");
    } finally {
      setBusy(false);
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
    if (!imgRef.current || mode !== "frame") return;
    const rect = imgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const normX = Math.round((clickX / rect.width) * 1080);
    const normY = Math.round((clickY / rect.height) * 2400);
    try {
      await api("send_adb_tap", { serial, x: normX, y: normY });
      setTimeout(fetchScreenFrame, 300);
    } catch {
      /* noop: tap melhor-effort */
    }
  };

  const handleKeyevent = async (code: number) => {
    try {
      await api("send_adb_keyevent", { serial, keycode: code });
      if (mode === "frame") setTimeout(fetchScreenFrame, 300);
    } catch {
      /* noop */
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Controle Remoto: ${device.name || device.model}`}
      size="lg"
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
      <div className="flex flex-col md:flex-row gap-4 items-center md:items-start text-xs">
        {/* Left: Device Display Screen */}
        <div className="w-full md:w-72 bg-[#09090b] border border-white/[0.08] rounded-xl p-2 flex flex-col items-center justify-center min-h-[380px] relative overflow-hidden">
          {screenSrc ? (
            <img
              ref={imgRef}
              src={screenSrc}
              alt="Tela do Celular"
              onClick={handleImageClick}
              className={`max-h-[440px] w-auto rounded border border-white/[0.05] ${
                mode === "frame" ? "cursor-pointer" : "cursor-default"
              }`}
            />
          ) : (
            <div className="text-center p-6 text-zinc-500">
              {loadingFrame ? (
                <>
                  <RefreshCw size={24} className="animate-spin text-[#828DF7] mx-auto mb-2" />
                  <p>Carregando frame ADB...</p>
                </>
              ) : (
                <>
                  <MonitorPlay size={24} className="text-zinc-600 mx-auto mb-2" />
                  <p>{mode === "frame" ? "Sem frame disponível" : "Espelhamento em janela externa"}</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right: Controls */}
        <div className="flex-1 space-y-3 w-full">
          {/* Modo de espelhamento */}
          <div className="p-3 bg-[#141418] border border-white/[0.07] rounded-lg space-y-2">
            <h5 className="font-semibold text-zinc-200">Modo de Espelhamento</h5>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={mode === "frame" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("frame")}
                icon={<RefreshCw size={13} />}
              >
                Frame ADB
              </Button>
              <Button
                variant={mode === "scrcpy" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("scrcpy")}
                loading={busy && mode !== "scrcpy"}
                icon={<ScreenShare size={13} />}
              >
                Scrcpy 60FPS
              </Button>
              <Button
                variant={mode === "scrcpy_off" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("scrcpy_off")}
                loading={busy && mode !== "scrcpy_off"}
                icon={<EyeOff size={13} />}
              >
                Scrcpy (Tela Off)
              </Button>
              <Button
                variant={mode === "virtual" ? "primary" : "secondary"}
                size="sm"
                onClick={() => startMode("virtual")}
                loading={busy && mode !== "virtual"}
                icon={<MonitorPlay size={13} />}
              >
                Display Virtual #2
              </Button>
            </div>

            {/* Câmera traseira / frontal */}
            <h5 className="font-semibold text-zinc-200 pt-1">Câmera do Celular</h5>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => startCamera("back")}
                loading={busy}
                icon={<Camera size={13} className="text-emerald-400" />}
              >
                Câmera Traseira
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => startCamera("front")}
                loading={busy}
                icon={<Camera size={13} className="text-sky-400" />}
              >
                Câmera Frontal
              </Button>
            </div>

            {/* Roubar a câmera */}
            <h5 className="font-semibold text-zinc-200 pt-1">Câmera Virtual (PC → Celular)</h5>
            <Button
              variant="secondary"
              size="sm"
              onClick={stealCamera}
              loading={busy}
              icon={<Video size={13} className="text-fuchsia-400" />}
              className="w-full"
            >
              Roubar Câmera (Injetar Tela do PC)
            </Button>
          </div>

          {/* Botões físicos Android */}
          <div className="p-3 bg-[#141418] border border-white/[0.07] rounded-lg space-y-2">
            <h5 className="font-semibold text-zinc-200">Botões Físicos Android</h5>
            <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(4)} icon={<ArrowLeft size={13} />}>
                Voltar
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(3)} icon={<Home size={13} />}>
                Início
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(187)} icon={<Layers size={13} />}>
                Apps
              </Button>
            </div>
          </div>

          {/* Controles de tela */}
          <div className="p-3 bg-[#141418] border border-white/[0.07] rounded-lg space-y-2">
            <h5 className="font-semibold text-zinc-200">Controles de Tela</h5>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleKeyevent(26)}
                icon={<Power size={13} className="text-red-400" />}
              >
                Liga/Desliga
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={fetchScreenFrame}
                loading={loadingFrame}
                icon={<RotateCcw size={13} />}
              >
                Atualizar Frame
              </Button>
            </div>
          </div>

          {/* Automação de WhatsApp */}
          <div className="p-3 bg-[#141418] border border-white/[0.07] rounded-lg space-y-2">
            <h5 className="font-semibold text-zinc-200">Automação de WhatsApp</h5>
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
                  if (mode === "frame") fetchScreenFrame();
                } catch {
                  /* noop */
                }
              }}
              icon={<Sparkles size={13} />}
              className="w-full"
            >
              Abrir WhatsApp Business
            </Button>
          </div>

          {/* Mensagens de status */}
          {streamMsg && (
            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono text-[11px] rounded whitespace-pre-wrap">
              {streamMsg}
            </div>
          )}
          {errorMsg && (
            <div className="p-2.5 bg-red-500/10 border border-red-500/20 text-red-300 font-mono text-[11px] rounded whitespace-pre-wrap">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
