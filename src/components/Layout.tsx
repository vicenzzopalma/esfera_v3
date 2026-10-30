// ============================================================
// Esfera v3 — Layout Principal
// Sidebar fixa (240px, ou 64px recolhida) + Header + conteúdo + StatusBar
// ============================================================

import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import Header from "./Header";
import StatusBar from "./StatusBar";

export default function Layout() {
  return (
    <div className="min-h-screen bg-primary text-primary relative font-sans overflow-x-hidden">
      <Sidebar />

      {/* Recuo da sidebar: .layout-main-wrapper usa var(--sidebar-w) (index.css) */}
      <div className="layout-main-wrapper min-h-screen flex flex-col min-w-0">
        <Header />

        <main className="flex-1 px-6 py-6 pb-14 overflow-x-hidden min-w-0">
          <div className="max-w-[1440px] mx-auto w-full space-y-6 min-w-0">
            <Outlet />
          </div>
        </main>
      </div>

      <StatusBar />
    </div>
  );
}
