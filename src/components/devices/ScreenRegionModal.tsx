// ============================================================
// Esfera v3 — Sub-componente ScreenRegionModal (Linear SaaS Style)
// Overlay de seleção de enquadramento da câmera virtual (VCam)
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { api } from "../../tauri";
import { Camera, RefreshCw } from "lucide-react";
import EmptyState from "../ui/EmptyState";
import { errorText } from "./deviceUi";

interface ScreenRegionModalProps {
  isOpen: boolean;
  onClose: () => void;
  serial: string;
}

// Depois de tantas falhas seguidas (aparelho desconectado), a transmissão pausa sozinha.
const MAX_FAILURES = 3;

export function ScreenRegionModal({
  isOpen,
  onClose,
  serial,
}: ScreenRegionModalProps) {
  const [posX, setPosX] = useState(400);
  const [posY, setPosY] = useState(200);
  const [width] = useState(500);
  const [height] = useState(500);
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [streamActive, setStreamActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Posição atual lida pelo laço de envio: arrastar o quadro não reinicia o laço.
  const regionRef = useRef({ posX, posY, width, height, serial });
  regionRef.current = { posX, posY, width, height, serial };

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [boxStart, setBoxStart] = useState({ x: 0, y: 0 });

  const stopCapture = useCallback(() => {
    setIsStreaming(false);
    setStreamActive(false);
    const stream = streamRef.current || (videoRef.current?.srcObject as MediaStream | null);
    stream?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Fechar a janela, trocar de aba ou desmontar a tela sempre libera a captura do monitor.
  useEffect(() => {
    if (!isOpen) {
      stopCapture();
      setStatusMsg("");
    }
  }, [isOpen, stopCapture]);

  useEffect(() => stopCapture, [stopCapture]);

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      // O operador pode parar o compartilhamento pela barra do Windows.
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          stopCapture();
          setStatusMsg("Compartilhamento de tela encerrado.");
        };
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
        setStreamActive(true);
        setStatusMsg("Tela capturada. Arraste o quadrado para enquadrar o QR Code.");
      }
    } catch {
      setStatusMsg("Não foi possível acessar a tela. Escolha um monitor ou janela para compartilhar.");
    }
  };

  const captureAndInjectBase64 = useCallback(async (): Promise<boolean> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streamRef.current) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const r = regionRef.current;

    const outWidth = 720;
    const outHeight = 1280;
    canvas.width = outWidth;
    canvas.height = outHeight;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.drawImage(video, r.posX, r.posY, r.width, r.height, 0, 0, outWidth, outHeight);

    const base64Data = canvas.toDataURL("image/jpeg", 0.7);

    try {
      const msg = await api<string>("inject_base64_frame", { serial: r.serial, frameData: base64Data });
      setStatusMsg(msg);
      return true;
    } catch (err: any) {
      setStatusMsg(`Erro: ${errorText(err, "Falha ao enviar a imagem ao aparelho.")}`);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isStreaming) return;
    let isActive = true;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const loop = async () => {
      if (!isActive) return;
      const startTime = Date.now();
      const ok = await captureAndInjectBase64();
      if (!isActive) return;
      failures = ok ? 0 : failures + 1;
      if (failures >= MAX_FAILURES) {
        setIsStreaming(false);
        setStatusMsg("Erro: transmissão pausada depois de 3 falhas seguidas. Confira se o aparelho está conectado e inicie de novo.");
        return;
      }
      const elapsed = Date.now() - startTime;
      const delay = Math.max(500, 1500 - elapsed);
      timerId = setTimeout(loop, delay);
    };

    loop();

    return () => {
      isActive = false;
      if (timerId) clearTimeout(timerId);
    };
  }, [isStreaming, captureAndInjectBase64]);

  const handlePointerDown = (e: React.PointerEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setBoxStart({ x: posX, y: posY });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging || !videoRef.current) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const video = videoRef.current;
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !video.videoWidth) return;

    const scaleX = video.videoWidth / rect.width;
    const scaleY = video.videoHeight / rect.height;
    const maxX = Math.max(0, video.videoWidth - width);
    const maxY = Math.max(0, video.videoHeight - height);

    setPosX(Math.min(maxX, Math.max(0, Math.round(boxStart.x + dx * scaleX))));
    setPosY(Math.min(maxY, Math.max(0, Math.round(boxStart.y + dy * scaleY))));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const getOverlayStyle = () => {
    if (!videoRef.current || !videoRef.current.videoWidth) return { display: "none" };
    const vw = videoRef.current.videoWidth;
    const vh = videoRef.current.videoHeight;
    return {
      left: `${(posX / vw) * 100}%`,
      top: `${(posY / vh) * 100}%`,
      width: `${(width / vw) * 100}%`,
      height: `${(height / vh) * 100}%`,
    };
  };

  // Perto da borda de cima a etiqueta fica dentro do quadro (fora dele seria cortada).
  const labelInside = !!videoRef.current?.videoHeight && posY / videoRef.current.videoHeight < 0.06;

  const isError = statusMsg.startsWith("Erro") || statusMsg.startsWith("Não foi");
  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        stopCapture();
        setStatusMsg("");
        onClose();
      }}
      title="Câmera virtual"
      size="xl"
    >
      <div className="space-y-4">
        {!streamActive && (
          <EmptyState
            icon={<Camera size={18} />}
            title="Capture a tela para usar como câmera"
            description="Escolha o monitor e enquadre o QR Code do WhatsApp Web. A imagem é enviada ao aparelho em tempo real."
            action={
              <Button variant="primary" size="sm" onClick={startScreenShare}>
                Selecionar tela
              </Button>
            }
          />
        )}
        <div className={streamActive ? "relative flex max-h-[50vh] items-center justify-center overflow-hidden rounded-xl border border-border bg-black" : "hidden"}>
          <video ref={videoRef} className="max-h-full max-w-full" muted playsInline />
          <div
            className={`absolute cursor-move touch-none border-2 bg-[var(--color-accent-glow)] ${isStreaming ? "border-red-500" : "border-dashed border-[var(--color-accent)]"}`}
            style={getOverlayStyle()}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <div
              className={`absolute left-0 whitespace-nowrap bg-[var(--color-accent)] px-1.5 py-0.5 font-mono text-[0.6875rem] text-white ${
                labelInside ? "top-0 rounded-br" : "-top-5 rounded-t"
              }`}
            >
              {posX}, {posY} · {width}x{height}
            </div>
          </div>
        </div>

        {streamActive && (
          <Button
            variant={isStreaming ? "danger" : "primary"}
            size="md"
            onClick={() => setIsStreaming(!isStreaming)}
            icon={<RefreshCw size={13} className={isStreaming ? "animate-spin" : ""} />}
            className="w-full"
          >
            {isStreaming ? "Parar transmissão" : "Iniciar câmera virtual"}
          </Button>
        )}

        {statusMsg && (
          <p
            role={isError ? "alert" : "status"}
            className={`rounded-lg border px-3 py-2 text-[0.8125rem] ${
              isError ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400" : "border-border bg-secondary text-secondary"
            }`}
          >
            {statusMsg}
          </p>
        )}

        <canvas ref={canvasRef} className="hidden" />
      </div>
    </Modal>
  );
}
