// ============================================================
// Esfera v3 — Sub-componente MirrorModal (Linear SaaS Style)
// Modal de espelhamento de tela, controle remoto ADB, digitação e câmera virtual.
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { FormSection } from "../ui/Field";
import { SegmentedControl } from "../ui/Tabs";
import { inputCls, errorText, deviceDisplayName } from "./deviceUi";
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
  RotateCcw,
  Send,
  Volume2,
  VolumeX,
  ClipboardPaste,
  SunMedium,
} from "lucide-react";

type MirrorMode = "frame" | "scrcpy" | "scrcpy_off";

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
  const [cameraBusy, setCameraBusy] = useState<null | "back" | "front" | "pc">(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Uma captura por vez: pelo Wi-Fi a imagem pode levar mais que o intervalo e os
  // pedidos se acumulavam no ADB do aparelho (inclusive durante envios).
  const captureInFlight = useRef(false);

  const serial = device.currentAdbAddress || device.serial;

  // ---- Frame ADB (preview interno contínuo) ----
  const fetchScreenFrame = useCallback(async () => {
    if (!isOpen || captureInFlight.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    captureInFlight.current = true;
    setLoadingFrame(true);
    try {
      const src = await api<string>("capture_device_screen", { serial });
      setScreenSrc(toImgSrc(src));
      setErrorMsg(null);
    } catch (e: any) {
      setErrorMsg(errorText(e, "Não foi possível capturar a tela do aparelho."));
    } finally {
      captureInFlight.current = false;
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
      }
      setStreamMsg(`${msg}\nJanela ao vivo aberta no computador: imagem e controle em tempo real.`);
    } catch (e: any) {
      // Sem janela externa, volta para a pré-visualização (senão a imagem parava de atualizar).
      setMode("frame");
      setErrorMsg(errorText(e, "Não foi possível abrir a janela ao vivo."));
    } finally {
      setBusy(false);
    }
  };

  // ---- Digitação Direta no Android via ADB ----
  const handleSendText = async () => {
    if (!textInput.trim() || sendingText) return;
    setSendingText(true);
    try {
      await api("send_adb_input_text", { serial, text: textInput });
      setTextInput("");
      setTimeout(fetchScreenFrame, 300);
    } catch (e: any) {
      setErrorMsg(errorText(e, "Não foi possível digitar o texto no aparelho."));
    } finally {
      setSendingText(false);
    }
  };

  const handlePasteClipboard = async () => {
    let clip = "";
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      setErrorMsg("Não foi possível ler a área de transferência do computador.");
      return;
    }
    if (!clip) {
      setErrorMsg("A área de transferência está vazia.");
      return;
    }
    setSendingText(true);
    try {
      await api("send_adb_input_text", { serial, text: clip });
      setTimeout(fetchScreenFrame, 300);
    } catch (e: any) {
      setErrorMsg(errorText(e, "Não foi possível digitar o texto colado no aparelho."));
    } finally {
      setSendingText(false);
    }
  };

  // ---- Câmera traseira / frontal ----
  const startCamera = async (facing: "back" | "front") => {
    setCameraBusy(facing);
    setErrorMsg(null);
    setStreamMsg(null);
    try {
      const msg = await api<string>("launch_camera_stream", { serial, facing });
      setStreamMsg(msg);
    } catch (e: any) {
      setErrorMsg(errorText(e, "Não foi possível abrir a câmera."));
    } finally {
      setCameraBusy(null);
    }
  };

  // ---- Envia a tela do PC para a câmera virtual do aparelho ----
  const stealCamera = async () => {
    setCameraBusy("pc");
    setErrorMsg(null);
    setStreamMsg(null);
    try {
      const msg = await api<string>("inject_virtual_camera", { serial, targetType: "full" });
      setStreamMsg(msg);
    } catch (e: any) {
      setErrorMsg(errorText(e, "Não foi possível enviar a tela do PC como câmera."));
    } finally {
      setCameraBusy(null);
    }
  };

  // A captura (screencap) tem o tamanho real da tela: o toque usa a mesma escala,
  // então funciona em 720x1600, 1080x2400 ou com o aparelho deitado.
  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const naturalW = img.naturalWidth || 1080;
    const naturalH = img.naturalHeight || 2400;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * naturalW);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * naturalH);
    const normX = Math.min(Math.max(x, 0), naturalW - 1);
    const normY = Math.min(Math.max(y, 0), naturalH - 1);
    try {
      await api("send_adb_tap", { serial, x: normX, y: normY });
      setTimeout(fetchScreenFrame, 300);
    } catch (err: any) {
      setErrorMsg(errorText(err, "O toque não chegou ao aparelho."));
    }
  };

  const handleKeyevent = async (code: number) => {
    try {
      await api("send_adb_keyevent", { serial, keycode: code });
      setTimeout(fetchScreenFrame, 300);
    } catch (err: any) {
      setErrorMsg(errorText(err, "O botão não chegou ao aparelho."));
    }
  };

  const openWhatsApp = async () => {
    try {
      await api("send_intent_to_display", { serial, url: "https://wa.me/", displayId: 0 });
      setTimeout(fetchScreenFrame, 600);
    } catch (err: any) {
      setErrorMsg(errorText(err, "Não foi possível abrir o WhatsApp no aparelho."));
    }
  };

  const keyBtn =
    "rounded-lg border border-border px-2.5 py-1 text-[0.75rem] text-secondary hover:text-primary bg-secondary hover:bg-hover transition-colors cursor-pointer";

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Controle remoto: ${deviceDisplayName(device)}`}
      size="xl"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onOpenRegion} icon={<Camera size={13} />} className="mr-auto">
            Câmera virtual (QR Code)
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Fechar
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-start gap-6 lg:flex-row">
        {/* Tela do aparelho */}
        <div className="relative flex min-h-[26rem] w-full shrink-0 flex-col items-center justify-center rounded-xl border border-border bg-black/90 p-3 lg:w-[20rem]">
          {screenSrc ? (
            <div className="group relative flex flex-col items-center">
              <img
                ref={imgRef}
                src={screenSrc}
                alt="Tela do aparelho"
                onClick={handleImageClick}
                className="max-h-[26rem] w-auto cursor-crosshair rounded-lg border border-white/10"
              />
              <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded bg-black/75 px-2.5 py-1 text-center text-[0.75rem] text-zinc-200 opacity-0 transition-opacity group-hover:opacity-100">
                Clique na tela para enviar um toque
              </div>
            </div>
          ) : (
            <div className="p-6 text-center text-[0.8125rem] text-zinc-400">
              {loadingFrame ? (
                <>
                  <RefreshCw size={22} className="mx-auto mb-2 animate-spin" />
                  <p>Capturando a tela...</p>
                </>
              ) : (
                <>
                  <MonitorPlay size={24} className="mx-auto mb-2" />
                  <p>{errorMsg ? "Sem imagem do aparelho" : "Conectando à tela..."}</p>
                </>
              )}
            </div>
          )}
          {mode !== "frame" && (
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[0.75rem] text-zinc-200">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Janela ao vivo aberta no computador
            </div>
          )}
        </div>

        {/* Controles */}
        <div className="w-full min-w-0 flex-1 space-y-6">
          <FormSection title="Digitar no aparelho" description="O texto é enviado ao campo em foco no aparelho.">
            <div className="flex gap-2">
              <input
                type="text"
                aria-label="Texto para enviar ao aparelho"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSendText();
                }}
                placeholder="Digite e pressione Enter"
                disabled={sendingText}
                className={inputCls}
              />
              <Button variant="primary" size="md" onClick={handleSendText} disabled={sendingText || !textInput.trim()} loading={sendingText} icon={<Send size={13} />}>
                Enviar
              </Button>
              <Button variant="secondary" size="md" onClick={handlePasteClipboard} disabled={sendingText} icon={<ClipboardPaste size={13} />} title="Colar texto da área de transferência do PC">
                Colar
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button type="button" onClick={() => handleKeyevent(66)} className={keyBtn}>Enter</button>
              <button type="button" onClick={() => handleKeyevent(67)} className={keyBtn}>Apagar</button>
              <button type="button" onClick={() => handleKeyevent(62)} className={keyBtn}>Espaço</button>
              <button type="button" onClick={() => handleKeyevent(61)} className={keyBtn}>Tab</button>
            </div>
          </FormSection>

          <FormSection title="Modo de espelhamento">
            <SegmentedControl<MirrorMode>
              items={[
                { id: "frame", label: "Pré-visualização" },
                { id: "scrcpy", label: "Janela ao vivo" },
                { id: "scrcpy_off", label: "Ao vivo, tela apagada" },
              ]}
              value={mode}
              onChange={(m) => !busy && startMode(m)}
            />
            <p className="text-[0.75rem] text-secondary">
              A pré-visualização atualiza a cada poucos segundos. As opções ao vivo abrem uma janela separada no computador; "tela apagada" economiza a bateria do aparelho.
            </p>
            {busy && (
              <p className="flex items-center gap-1.5 text-[0.75rem] text-secondary">
                <RefreshCw size={12} className="animate-spin" /> Iniciando...
              </p>
            )}
          </FormSection>

          <FormSection title="Navegação e botões">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(4)} icon={<ArrowLeft size={12} />}>Voltar</Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(3)} icon={<Home size={12} />}>Início</Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(187)} icon={<Layers size={12} />}>Apps</Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(24)} icon={<Volume2 size={12} />}>Vol +</Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(25)} icon={<VolumeX size={12} />}>Vol -</Button>
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(26)} icon={<Power size={12} />}>Ligar</Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleKeyevent(224)} icon={<SunMedium size={12} />}>Acordar tela</Button>
              <Button variant="secondary" size="sm" onClick={fetchScreenFrame} loading={loadingFrame} icon={<RotateCcw size={12} />}>Atualizar imagem</Button>
            </div>
          </FormSection>

          <FormSection title="Câmera" description="Abra a câmera do aparelho ou envie a tela do PC como câmera.">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" size="sm" onClick={() => startCamera("back")} loading={cameraBusy === "back"} disabled={!!cameraBusy && cameraBusy !== "back"} icon={<Camera size={12} />}>Câmera traseira</Button>
              <Button variant="secondary" size="sm" onClick={() => startCamera("front")} loading={cameraBusy === "front"} disabled={!!cameraBusy && cameraBusy !== "front"} icon={<Camera size={12} />}>Câmera frontal</Button>
            </div>
            <Button variant="secondary" size="sm" onClick={stealCamera} loading={cameraBusy === "pc"} disabled={!!cameraBusy && cameraBusy !== "pc"} icon={<Video size={12} />} className="w-full">
              Enviar tela do PC como câmera
            </Button>
          </FormSection>

          <Button
            variant="secondary"
            size="md"
            onClick={openWhatsApp}
            icon={<Sparkles size={13} />}
            className="w-full"
          >
            Abrir WhatsApp
          </Button>

          {streamMsg && (
            <div role="status" className="whitespace-pre-wrap rounded-lg border border-border bg-secondary p-3 text-[0.8125rem] text-secondary">
              {streamMsg}
            </div>
          )}
          {errorMsg && (
            <div role="alert" className="whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[0.8125rem] text-red-600 dark:text-red-400">
              {errorMsg}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
