// ============================================================
// Esfera v3 — Layout Principal
// Sidebar Fixa + Inline Style Padding 256px + Header + Viewport + StatusBar
// ============================================================

import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Header from "./Header";
import StatusBar from "./StatusBar";

export default function Layout() {
  return (
    <div className="min-h-screen bg-primary text-primary relative">
      {/* Sidebar Fixa (Largura: 256px) */}
      <Sidebar />

      {/* Container Principal Deslocado Exatamente 256px para a direita via inline style */}
      <div style={{ paddingLeft: "256px" }} className="min-h-screen flex flex-col min-w-0">
        {/* Header Global */}
        <Header />

        {/* Viewport de Conteúdo das Abas */}
        <main className="flex-1 p-6 pb-16 overflow-y-auto min-w-0">
          <Outlet />
        </main>
      </div>

      {/* Barra de Status no Rodapé */}
      <StatusBar />
    </div>
  );
}
