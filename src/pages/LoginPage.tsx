// ============================================================
// Esfera v3 — Tela de Login
// Cartão central sóbrio, segue o tema claro/escuro
// ============================================================

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import Button from "../components/ui/Button";
import Field from "../components/ui/Field";
import { User, Lock, Eye, EyeOff, Sun, Moon, AlertCircle } from "lucide-react";

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
    <div className="min-h-screen flex items-center justify-center relative bg-primary text-primary p-4 font-sans">
      <button
        type="button"
        onClick={toggleTheme}
        className="absolute top-4 right-4 h-8 w-8 flex items-center justify-center rounded-lg text-secondary hover:text-primary hover:bg-hover transition-colors cursor-pointer"
        title={isDark ? "Tema claro" : "Tema escuro"}
        aria-label={isDark ? "Mudar para tema claro" : "Mudar para tema escuro"}
      >
        {isDark ? <Sun size={16} /> : <Moon size={16} />}
      </button>

      <div className={`relative w-full max-w-sm ${shake ? "animate-shake" : "animate-scale-in"}`}>
        <div className="rounded-xl bg-card border border-border p-7 space-y-6 shadow-[var(--shadow-pop)]">
          <div className="text-center">
            <img src="/logo.png" alt="Esfera" className="w-12 h-12 object-contain mx-auto mb-3" />
            <h1 className="text-xl font-semibold text-primary">Entrar na Esfera</h1>
            <p className="text-[0.8125rem] text-secondary mt-1">Use seu usuário e senha para continuar.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-600 dark:text-red-400 text-[0.8125rem] animate-fade-in"
              >
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Field label="Usuário" htmlFor="login-username">
              <div className="relative flex items-center">
                <User size={15} className="input-icon-left text-tertiary" />
                <input
                  id="login-username"
                  type="text"
                  autoComplete="username"
                  autoFocus={!username}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Seu usuário"
                  className="input-with-icon-left"
                />
              </div>
            </Field>

            <Field label="Senha" htmlFor="login-password">
              <div className="relative flex items-center">
                <Lock size={15} className="input-icon-left text-tertiary" />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  autoFocus={!!username}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Sua senha"
                  className="input-with-icon-both"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  className="input-icon-right text-tertiary hover:text-primary transition-colors cursor-pointer"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </Field>

            <Button
              type="submit"
              size="lg"
              loading={loading}
              disabled={!username || !password}
              className="w-full"
            >
              {loading ? "Entrando..." : "Entrar"}
            </Button>
          </form>

          {/* Atalhos — apenas em modo de desenvolvimento */}
          {import.meta.env.DEV && (
            <div className="pt-4 border-t border-border">
              <p className="text-xs text-tertiary mb-2">Atalhos de desenvolvimento</p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fillCredentials("vicenzzo.master", "root123")}
                >
                  Master
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fillCredentials("vicenzzo.mastronikolis", "Ope@2025")}
                >
                  Gestor
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
