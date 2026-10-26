// Confirmação explícita para ações destrutivas.
import type { ReactNode } from "react";
import Modal from "../../components/ui/Modal";
import Button from "../../components/ui/Button";

export default function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  danger = true,
  loading = false,
  onConfirm,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[0.8125rem] leading-relaxed text-secondary">{children}</div>
    </Modal>
  );
}
