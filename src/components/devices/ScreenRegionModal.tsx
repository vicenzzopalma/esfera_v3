// ============================================================
// Esfera v3 — Sub-componente ScreenRegionModal (Linear SaaS Style)
// Overlay de seleção de enquadramento da câmera virtual (VCam)
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react";
import Modal from "../ui/Modal";
import Button from "../ui/Button";
import { api } from "../../tauri";
import { Camera, RefreshCw } from "lucide-react";

interface ScreenRegionModalProps {
  isOpen: boolean;
  onClose: () => void;
  serial: string;
}

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

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [boxStart, setBoxStart] = useState({ x: 0, y: 0 });

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setStreamActive(true);
        setStatusMsg("✅ Monitor capturado! Arraste o quadrado para enquadrar o QR Code.");
      }
    } catch {
      setStatusMsg("❌ Erro ao acessar monitor.");
    }
  };

  const captureAndInjectBase64 = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !streamActive) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const outWidth = 720;
    const outHeight = 1280;
    canvas.width = outWidth;
    canvas.height = outHeight;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.drawImage(video, posX, posY, width, height, 0, 0, outWidth, outHeight);

    const base64Data = canvas.toDataURL("image/jpeg", 0.7);

    try {
      const msg = await api<string>("inject_base64_frame", { serial, frameData: base64Data });
      setStatusMsg(msg);
    } catch (err: any) {
      setStatusMsg(`❌ Erro: ${typeof err === "string" ? err : err?.message || "Falha na injeção"}`);
    }
  }, [serial, posX, posY, width, height, streamActive]);

  useEffect(() => {
    let isActive = true;
    let timerId: any;

    const loop = async () => {
      if (!isActive || !isStreaming) return;
      const startTime = Date.now();
      await captureAndInjectBase64();
      const elapsed = Date.now() - startTime;
      const delay = Math.max(500, 1500 - elapsed);
      if (isActive && isStreaming) {
        timerId = setTimeout(loop, delay);
      }
    };

    if (isStreaming) {
      loop();
    }

    return () => {
      isActive = false;
      clearTimeout(timerId);
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
    const rect = videoRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !videoRef.current.videoWidth) return;

    const scaleX = videoRef.current.videoWidth / rect.width;
    const scaleY = videoRef.current.videoHeight / rect.height;

    setPosX(Math.max(0, Math.round(boxStart.x + dx * scaleX)));
    setPosY(Math.max(0, Math.round(boxStart.y + dy * scaleY)));
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
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

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        setIsStreaming(false);
        if (videoRef.current && videoRef.current.srcObject) {
          const stream = videoRef.current.srcObject as MediaStream;
          stream.getTracks().forEach((track) => track.stop());
        }
        onClose();
      }}
      title="Selecionar Área de Enquadramento (Câmera Virtual)"
      size="xl"
    >
      <div className="space-y-3 text-xs flex flex-col items-center">
        {!streamActive ? (
          <div className="w-full p-6 border border-dashed border-white/[0.1] rounded-lg bg-[#141418] flex flex-col items-center justify-center text-center space-y-3">
            <Camera size={36} className="text-[#828DF7]" />
            <div>
              <h3 className="text-sm font-semibold text-zinc-100 mb-1">Captura de Tela para Câmera Virtual</h3>
              <p className="text-xs text-zinc-400 max-w-sm">
                Selecione o monitor para enquadrar o QR Code do WhatsApp Web em tempo real.
              </p>
            </div>
            <Button variant="primary" size="sm" onClick={startScreenShare}>
              Selecionar Tela / Monitor
            </Button>
          </div>
        ) : (
          <div className="w-full relative rounded-lg overflow-hidden border border-white/[0.08] bg-black flex justify-center items-center max-h-[50vh]">
            <video ref={videoRef} className="max-w-full max-h-full" muted playsInline />

            <div
              className={`absolute border-2 ${isStreaming ? "border-red-500" : "border-[#5E6AD2] border-dashed"} bg-[#5E6AD2]/10 cursor-move`}
              style={getOverlayStyle()}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <div className="absolute -top-5 left-0 bg-[#5E6AD2] text-white font-mono text-[9px] px-1.5 py-0.5 rounded-t font-semibold whitespace-nowrap">
                Pos: ({posX}, {posY}) - {width}x{height}
              </div>
            </div>
          </div>
        )}

        {streamActive && (
          <div className="w-full flex items-center justify-between gap-3 pt-2">
            <Button
              variant={isStreaming ? "danger" : "primary"}
              size="sm"
              onClick={() => setIsStreaming(!isStreaming)}
              icon={<RefreshCw size={13} className={isStreaming ? "animate-spin" : ""} />}
              className="w-full"
            >
              {isStreaming ? "Parar Transmissão" : "Iniciar Câmera Virtual"}
            </Button>
          </div>
        )}

        {statusMsg && (
          <div className="w-full p-2.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono text-[11px] rounded text-center">
            {statusMsg}
          </div>
        )}

        <canvas ref={canvasRef} className="hidden" />
      </div>
    </Modal>
  );
}
