// ============================================================
// Esfera v3 — Tela de Login Refatorada
// Design Glassmorphic Premium com proporções e espaçamentos perfeitos
// ============================================================

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { User, Lock, Eye, EyeOff, Loader2, Sun, Moon, Sparkles } from "lucide-react";

export default function LoginPage() {
  const { login, error } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [username, setUsername] = useState(() => localStorage.getItem("esfera_v3_last_username") || "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  const fillCredentials = (u: string, p: string) => {
    setUsername(u);
    setPassword(p);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setShake(false);

    const success = await login(username, password);

    if (success) {
      navigate("/");
    } else {
      setShake(true);
      setTimeout(() => setShake(false), 600);
    }

    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-[#09090b] p-4 font-sans">
      {/* Subtle Static Radial Gradient Background */}
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#5E6AD2]/15 via-[#09090b] to-[#09090b]" />

      {/* Theme Toggle Button */}
      <button
        onClick={toggleTheme}
        className="absolute top-5 right-5 p-2 rounded-md bg-white/[0.04] border border-white/[0.08] text-zinc-400 hover:text-zinc-100 transition-all z-20 cursor-pointer text-xs"
        title="Alternar Tema"
      >
        {isDark ? <Sun size={15} /> : <Moon size={15} />}
      </button>

      {/* Login Card Container */}
      <div className={`relative w-full max-w-sm ${shake ? "animate-shake" : "animate-scale-in"}`}>
        <div className="rounded-xl bg-[#141418] border border-white/[0.08] p-6 sm:p-7 space-y-5 shadow-2xl shadow-black/80">
          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-[#5E6AD2] text-white font-black text-base shadow-md shadow-[#5E6AD2]/25 mb-3">
              E
            </div>
            <h1 className="text-lg font-bold text-zinc-100 tracking-tight">Esfera Hub</h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              Gestão ADB & Disparos Inteligentes
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {error && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium animate-fade-in">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {/* Input Usuário */}
            <div>
              <label htmlFor="login-username" className="text-xs text-zinc-300 font-medium mb-1.5 block">Usuário</label>
              <div className="relative flex items-center">
                <User size={16} className="input-icon-left text-zinc-500" />
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Digite seu usuário"
                  className="w-full h-10 input-with-icon-left pr-3 text-xs bg-white/[0.03] border border-white/[0.08] rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-[#5E6AD2]"
                />
              </div>
            </div>

            {/* Input Senha */}
            <div>
              <label htmlFor="login-password" className="text-xs text-zinc-300 font-medium mb-1.5 block">Senha</label>
              <div className="relative flex items-center">
                <Lock size={16} className="input-icon-left text-zinc-500" />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Digite sua senha"
                  className="w-full h-10 input-with-icon-both text-xs bg-white/[0.03] border border-white/[0.08] rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-[#5E6AD2]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="input-icon-right text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full h-9 rounded-md text-xs font-semibold text-white bg-[#5E6AD2] hover:bg-[#4C57C6] shadow-sm shadow-[#5E6AD2]/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 cursor-pointer flex items-center justify-center gap-2 mt-4"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  <span>Entrando...</span>
                </>
              ) : (
                <span>Entrar no Sistema</span>
              )}
            </button>
          </form>

          {/* Quick Credentials Widget — APENAS em modo de desenvolvimento */}
          {import.meta.env.DEV && (
            <div className="pt-2 border-t border-white/[0.06]">
              <div className="flex items-center gap-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                <Sparkles size={12} className="text-[#828DF7]" />
                <span>Atalhos DEV</span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => fillCredentials("vicenzzo.master", "root123")}
                  className="py-1.5 px-2 rounded-md bg-[#5E6AD2]/10 hover:bg-[#5E6AD2]/20 text-[11px] font-medium text-[#828DF7] border border-[#5E6AD2]/20 transition-colors cursor-pointer text-center truncate"
                >
                  Master
                </button>
                <button
                  type="button"
                  onClick={() => fillCredentials("vicenzzo.mastronikolis", "Ope@2025")}
                  className="py-1.5 px-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] text-[11px] font-medium text-zinc-300 border border-white/[0.08] transition-colors cursor-pointer text-center truncate"
                >
                  Gestor
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
