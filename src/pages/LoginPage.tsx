// ============================================================
// Esfera v3 — Tela de Login
// Login premium com glassmorphism e animações
// ============================================================

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { Zap, User, Lock, Eye, EyeOff, Loader2, Sun, Moon } from "lucide-react";

export default function LoginPage() {
  const { login, error } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-primary">
      {/* Animated Background */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full
          bg-gradient-to-br from-violet-600/20 to-transparent rounded-full blur-3xl
          animate-float" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full
          bg-gradient-to-tl from-indigo-600/15 to-transparent rounded-full blur-3xl
          animate-float-delayed" />
        <div className="absolute top-1/4 right-1/4 w-96 h-96
          bg-gradient-to-br from-violet-500/10 to-indigo-500/10 rounded-full blur-3xl
          animate-pulse-slow" />
      </div>

      {/* Theme Toggle */}
      <button
        onClick={toggleTheme}
        className="absolute top-6 right-6 p-2.5 rounded-xl bg-white/5 border border-border
          text-secondary hover:text-primary hover:bg-white/10
          transition-all z-10 cursor-pointer"
      >
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </button>

      {/* Login Card */}
      <div className={`relative w-full max-w-md mx-4 ${shake ? "animate-shake" : "animate-scale-in"}`}>
        <div className="rounded-3xl border border-border bg-card backdrop-blur-xl
          shadow-2xl shadow-violet-500/10 overflow-hidden">

          {/* Header */}
          <div className="text-center pt-10 pb-6 px-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl
              bg-gradient-to-br from-violet-600 to-indigo-600 shadow-xl shadow-violet-500/30
              mb-4">
              <Zap size={32} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-primary">Esfera v3</h1>
            <p className="text-sm text-secondary mt-1">
              Plataforma de Disparos Inteligentes
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-8 pb-8 space-y-4">
            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 px-4 py-3 rounded-xl
                bg-red-500/10 border border-red-500/20 text-red-400 text-sm
                animate-fade-in">
                <span>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            {/* Username */}
            <div>
              <label htmlFor="login-username" className="block text-sm font-medium text-secondary mb-1.5">
                Usuário
              </label>
              <div className="relative">
                <User size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
                <input
                  id="login-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Digite seu usuário"
                  autoComplete="username"
                  className="w-full pl-11 pr-4 py-2.5 rounded-xl text-sm
                    bg-white/5 border border-border text-primary
                    placeholder:text-tertiary
                    focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
                    transition-all"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-secondary mb-1.5">
                Senha
              </label>
              <div className="relative">
                <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-tertiary" />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Digite sua senha"
                  autoComplete="current-password"
                  className="w-full pl-11 pr-11 py-2.5 rounded-xl text-sm
                    bg-white/5 border border-border text-primary
                    placeholder:text-tertiary
                    focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30
                    transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2
                    text-tertiary hover:text-secondary transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-white
                bg-gradient-to-r from-violet-600 to-indigo-600
                hover:from-violet-500 hover:to-indigo-500
                shadow-lg shadow-violet-500/25
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all duration-200 cursor-pointer
                flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  <span>Entrando...</span>
                </>
              ) : (
                <span>Entrar</span>
              )}
            </button>
          </form>

          {/* Dev Credentials */}
          <div className="px-8 pb-6">
            <div className="rounded-xl bg-white/[0.03] border border-border p-4">
              <p className="text-[11px] text-tertiary mb-2 uppercase tracking-wide font-medium">
                🔑 Credenciais de Teste
              </p>
              <div className="space-y-1 text-xs text-secondary">
                <div className="flex justify-between">
                  <span className="text-tertiary">Master:</span>
                  <span className="font-mono">admin / admin</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-tertiary">Gestor:</span>
                  <span className="font-mono">gestor / gestor</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-tertiary">Colaborador:</span>
                  <span className="font-mono">colab / colab</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
