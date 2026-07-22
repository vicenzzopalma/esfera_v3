// ============================================================
// Esfera v3 — Tela de Login Refatorada
// Design Glassmorphic Premium com proporções e espaçamentos perfeitos
// ============================================================

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { Zap, User, Lock, Eye, EyeOff, Loader2, Sun, Moon, Sparkles } from "lucide-react";

export default function LoginPage() {
  const { login, error } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
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
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-primary p-6">
      {/* Background Ambient Lighting */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/3 -left-1/3 w-2/3 h-2/3 bg-gradient-to-br from-violet-600/30 to-indigo-600/10 rounded-full blur-3xl animate-float" />
        <div className="absolute -bottom-1/3 -right-1/3 w-2/3 h-2/3 bg-gradient-to-tl from-indigo-600/25 to-violet-600/10 rounded-full blur-3xl animate-float-delayed" />
      </div>

      {/* Theme Toggle Button */}
      <button
        onClick={toggleTheme}
        className="absolute top-6 right-6 p-3 rounded-2xl bg-white/5 border border-border text-secondary hover:text-primary hover:bg-white/10 transition-all z-20 cursor-pointer shadow-lg"
        title="Alternar Tema"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      {/* Login Card Container */}
      <div className={`relative w-full max-w-md ${shake ? "animate-shake" : "animate-scale-in"}`}>
        <div className="rounded-3xl glass-panel shadow-2xl overflow-hidden border border-white/10 p-8 sm:p-10 space-y-6">
          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-600 shadow-xl shadow-violet-500/30 mb-4 animate-glow-pulse">
              <Zap size={32} className="text-white" />
            </div>
            <h1 className="text-2xl font-extrabold text-primary tracking-tight">Esfera v3</h1>
            <p className="text-xs text-secondary mt-1 font-medium">
              Plataforma de Disparos e Gestão ADB
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-xs font-medium animate-fade-in">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {/* Input Usuário */}
            <div>
              <label htmlFor="login-username">Usuário de Acesso</label>
              <div className="relative flex items-center">
                <User size={18} className="absolute left-3.5 text-tertiary pointer-events-none z-10" />
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Digite seu usuário..."
                  className="input-with-icon-left"
                />
              </div>
            </div>

            {/* Input Senha */}
            <div>
              <label htmlFor="login-password">Senha de Acesso</label>
              <div className="relative flex items-center">
                <Lock size={18} className="absolute left-3.5 text-tertiary pointer-events-none z-10" />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Digite sua senha..."
                  className="input-with-icon-left input-with-icon-right"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 text-tertiary hover:text-secondary transition-colors cursor-pointer z-10"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full h-12 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 shadow-lg shadow-violet-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 mt-4"
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  <span>Autenticando...</span>
                </>
              ) : (
                <span>Acessar Plataforma</span>
              )}
            </button>
          </form>

          {/* Quick Credentials Widget — APENAS em modo de desenvolvimento */}
          {import.meta.env.DEV && (
            <div className="pt-2">
              <div className="rounded-2xl bg-white/[0.02] border border-border p-4">
                <div className="flex items-center gap-1.5 text-[11px] font-bold text-tertiary uppercase tracking-wider mb-3">
                  <Sparkles size={14} className="text-violet-400" />
                  <span>Atalhos de Login (DEV)</span>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => fillCredentials("vicenzzo.master", "root123")}
                    className="py-2.5 px-3 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 text-xs font-semibold text-violet-300 border border-violet-500/30 transition-colors cursor-pointer text-center"
                  >
                    Vicenzzo Master
                  </button>
                  <button
                    type="button"
                    onClick={() => fillCredentials("vicenzzo.mastronikolis", "Ope@2025")}
                    className="py-2.5 px-3 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 text-xs font-semibold text-indigo-300 border border-indigo-500/30 transition-colors cursor-pointer text-center"
                  >
                    Gestor Realess
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
