// ============================================================
// Esfera v3 — Layout Principal
// Sidebar fixa (240px, ou 64px recolhida) + Header + conteúdo + StatusBar
// ============================================================

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import Sidebar from "./Sidebar";
import Header from "./Header";
import StatusBar from "./StatusBar";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Ao mudar (ex.: troca de rota), a tela com erro é montada de novo. */
  resetKey?: string;
  /** true: tela cheia com "Recarregar o Esfera" (usado na raiz do App). */
  fullPage?: boolean;
}

/**
 * Se uma tela quebrar ao desenhar, mostra um aviso no lugar dela em vez de deixar
 * a janela inteira em branco. Menu, cabeçalho e rodapé continuam funcionando.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Erro ao exibir a tela:", error, info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const fullPage = this.props.fullPage;
    return (
      <div className={fullPage ? "min-h-screen flex items-center justify-center bg-primary p-6" : "py-10"}>
        <div
          role="alert"
          className="mx-auto max-w-lg rounded-xl border border-border bg-card p-6 text-center shadow-[var(--shadow-pop)]"
        >
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={18} />
          </div>
          <p className="text-sm font-semibold text-primary">
            {fullPage ? "O Esfera encontrou um erro ao abrir" : "Esta tela encontrou um erro"}
          </p>
          <p className="mt-1 text-[0.8125rem] text-secondary">
            {fullPage
              ? "Recarregue para continuar. Os envios em andamento não são afetados."
              : "O resto do Esfera continua funcionando. Tente abrir de novo ou use o menu para ir a outra tela."}
          </p>
          {error.message && (
            <p className="mt-3 break-words rounded-lg bg-secondary px-3 py-2 text-left font-mono text-[0.75rem] text-tertiary">
              {error.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => (fullPage ? window.location.reload() : this.setState({ error: null }))}
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-accent)] px-3 text-[0.8125rem] font-medium text-[var(--color-accent-contrast)] transition-colors hover:bg-[var(--color-accent-hover)] cursor-pointer"
          >
            <RotateCcw size={14} />
            {fullPage ? "Recarregar o Esfera" : "Tentar de novo"}
          </button>
        </div>
      </div>
    );
  }
}

export default function Layout() {
  const location = useLocation();
  const { selectedCompanyId } = useAuth();
  return (
    <div className="min-h-screen bg-primary text-primary relative font-sans overflow-x-hidden">
      <Sidebar />

      {/* Recuo da sidebar: .layout-main-wrapper usa var(--sidebar-w) (index.css) */}
      <div className="layout-main-wrapper min-h-screen flex flex-col min-w-0">
        <Header />

        <main className="flex-1 px-6 py-6 pb-14 overflow-x-hidden min-w-0">
          <div className="max-w-[1440px] mx-auto w-full space-y-6 min-w-0">
            {/* key: ao trocar de empresa a página é recriada — nada da empresa anterior fica na tela */}
            <ErrorBoundary key={selectedCompanyId ?? "sem-empresa"} resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </main>
      </div>

      <StatusBar />
    </div>
  );
}
