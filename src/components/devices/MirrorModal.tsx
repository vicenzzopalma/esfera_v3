// ============================================================
// Esfera v3 — Sub-componente MirrorModal (Linear SaaS Style)
// Modal de espelhamento de tela e controle remoto ADB
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
} from "lucide-react";

interface MirrorModalProps {
  isOpen: boolean;
  onClose: () => void;
  device: Device;
  onOpenRegion: () => void;
}

export function MirrorModal({
  isOpen,
  onClose,
  device,
  onOpenRegion,
}: MirrorModalProps) {
  const [screenSrc, setScreenSrc] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const autoRefresh = true;
  const imgRef = useRef<HTMLImageElement>(null);

  const fetchScreenFrame = useCallback(async () => {
    if (!isOpen) return;
    setLoadingFrame(true);
    try {
      const src = await api<string>("capture_screen", { serial: device.serial });
      setScreenSrc(src);
    } catch {
      setScreenSrc(null);
    } fontally: {
      setLoadingFrame(false);
    }
  }, [isOpen, device.serial]);

  useEffect(() => {
    if (!isOpen) {
      setScreenSrc(null);
      return;
    }

    fetchScreenFrame();
    let intervalId: any = null;
    if (autoRefresh) {
      intervalId = setInterval(fetchScreenFrame, 1500);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [isOpen, autoRefresh, fetchScreenFrame]);

  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const normX = Math.round((clickX / rect.width) * 1080);
    const normY = Math.round((clickY / rect.height) * 2400);

    try {
      await api("send_adb_tap", { serial: device.serial, x: normX, y: normY });
      setTimeout(fetchScreenFrame, 300);
    } catch {
      console.log(`ADB Tap: X=${normX}, Y=${normY}`);
    }
  };

  const handleKeyevent = async (code: number) => {
    try {
      await api("send_adb_keyevent", { serial: device.serial, keycode: code });
      setTimeout(fetchScreenFrame, 300);
    } catch {
      console.log(`ADB Keyevent: ${code}`);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Controle Remoto: ${device.name || device.model}`}
      size="lg"
      footer={
        <div className="flex justify-between items-center w-full text-xs">
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
              className="max-h-[440px] w-auto rounded cursor-pointer border border-white/[0.05]"
            />
          ) : (
            <div className="text-center p-6 text-zinc-500">
              <RefreshCw size={24} className="animate-spin text-[#828DF7] mx-auto mb-2" />
              <p>Carregando frame ADB...</p>
            </div>
          )}
        </div>

        {/* Right: Hardware Navigation Controls */}
        <div className="flex-1 space-y-3 w-full">
          <div className="p-3 bg-[#141418] border border-white/[0.07] rounded-lg space-y-2">
            <h5 className="font-semibold text-zinc-200">Botões Físicos Android</h5>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleKeyevent(4)}
                icon={<ArrowLeft size={13} />}
              >
                Voltar
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleKeyevent(3)}
                icon={<Home size={13} />}
              >
                Início
              </Button>

              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleKeyevent(187)}
                icon={<Layers size={13} />}
              >
                Apps
              </Button>
            </div>
          </div>

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
                icon={<RefreshCw size={13} />}
              >
                Atualizar Frame
              </Button>
            </div>
          </div>

          <div className="p-3 bg-[#141418] border border-white/[0.07] rounded-lg space-y-2">
            <h5 className="font-semibold text-zinc-200">Automação de WhatsApp</h5>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  await api("open_whatsapp_target", { serial: device.serial });
                  fetchScreenFrame();
                } catch {
                  console.log("Abrindo WhatsApp...");
                }
              }}
              icon={<Sparkles size={13} />}
              className="w-full"
            >
              Abrir WhatsApp Business
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
