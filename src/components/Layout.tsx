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
        <main className="flex-1 p-8 md:p-10 xl:p-12 pb-24 overflow-y-auto min-w-0">
          <div className="max-w-7xl mx-auto w-full space-y-8">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Barra de Status no Rodapé */}
      <StatusBar />
    </div>
  );
}
