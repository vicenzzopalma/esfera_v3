// ============================================================
// Esfera v3 — Layout Principal
// Container com Sidebar + Área de conteúdo + StatusBar
// ============================================================

import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import StatusBar from "./StatusBar";

export default function Layout() {
  return (
    <div className="min-h-screen bg-primary">
      <Sidebar />
      <main className="ml-64 pb-8 min-h-screen">
        <div className="p-6">
          <Outlet />
        </div>
      </main>
      <StatusBar />
    </div>
  );
}
