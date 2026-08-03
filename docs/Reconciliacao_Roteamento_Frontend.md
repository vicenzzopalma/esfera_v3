# Reconciliação: Rascunho de Roteamento Front-End (App.tsx / AuthContext) vs Código Real — Esfera v3

Documento de auditoria. O rascunho enviado ("Análise Arquitetural e de Segurança do Sistema de Roteamento Front-End") foi reconciliado linha a linha contra `src/App.tsx` e `src/context/AuthContext.tsx`. Várias afirmações do rascunho NÃO correspondem ao código atual — o rascunho analisou uma versão desatualizada do `CompanyGate`.

Evidência primária:
- `src/App.tsx` (192 linhas) — ProtectedRoute, RoleGate, CompanyGate, RootRedirect, AppRoutes.
- `src/context/AuthContext.tsx` (261 linhas) — useAuth, hidratação de estado, fallback de usuários.

---

## 0. Resumo de Status

| Afirmação do Rascunho | Veredito vs Código |
|---|---|
| Bypass de Tenant para não-master (CompanyGate só checa master) | **NÃO EXISTE** — código já trata não-master (App.tsx:54-61) |
| Race condition por hidratação assíncrona (deep link expulso) | **PARCIAL** — estado vem de localStorage síncrono; risco baixo |
| Redirect Bounce (RoleGate → / → RootRedirect) | **REAL** (App.tsx:37 + 78) |
| Ausência de tela 403 | **REAL** |
| Rotas declaradas manualmente (verbosas) | **REAL** — sugestão de metadados válida |
| Matriz de permissões por rota | **EM SUA MAIORIA CORRETA**, mas baseada na premissa errada do CompanyGate |

---

## 1. CompanyGate — a "vulnerabilidade crítica" JÁ FOI CORRIGIDA

O rascunho (seção "Vulnerabilidade de Ignorância de Tenant para Papéis Não-Master") cita este código como atual:

```ts
if (!user) return <Navigate to="/login" replace />;
if (user.role === "master" && selectedCompanyId === null) {
  return <Navigate to="/companies" replace />;
}
return <>{children}</>;
```

**O código real em `src/App.tsx:44-64` é diferente e já fecha a brecha:**

```ts
function CompanyGate({ children }: { children: ReactNode }) {
  const { user, selectedCompanyId } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  // Master sem empresa selecionada → vai para companies
  if (user.role === "master" && selectedCompanyId === null) {
    return <Navigate to="/companies" replace />;
  }
  // Gestor ou Colaborador sem empresa → tenta restaurar do user.companyId ou redireciona ao login
  if (user.role !== "master" && selectedCompanyId === null) {
    if (user.companyId) {
      return <Navigate to="/" replace />;   // safety net
    }
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
```

**Conclusão:** um `gestor` ou `colaborador` sem empresa NÃO monta a tela operacional. O ramo `user.role !== "master" && selectedCompanyId === null` intercepta e manda para `/login` (ou `/` se tiver `user.companyId`). A alegação de "montagem de ecrãs operacionais sem empresa para perfis gestor" é **falsa para o código atual**.

**Risco residual real (diferente do rascunho):** o ramo `if (user.companyId) return <Navigate to="/" replace />` é uma *safety net* que, em vez de forçar seleção de empresa, joga o usuário na raiz — onde `RootRedirect` (`App.tsx:73-78`) o manda para `/devices` mesmo sem `selectedCompanyId` explícito (porque `RootRedirect` só checa master). Ou seja, para não-master com `user.companyId` mas `selectedCompanyId === null`, o fluxo depende de `RootRedirect` + do default `|| 1` do AuthContext. Funciona na prática (o `selectedCompanyId` inicializa com `1` via `|| 1`), mas a *lógica de safety net* é confusa. Recomendação: em vez de `<Navigate to="/" replace />`, redirecionar para `/companies` ou a uma tela de seleção de empresa. **Severidade: Baixa** (não é bypass de tenant).

---

## 2. Race Condition / Hidratação (alegação "Alta")

O rascunho alega que `user`, `loggedIn` e `selectedCompanyId` são lidos de forma síncrona mas a hidratação é assíncrona (JWT/token/API no startup), causando expulsão prematura em deep links.

**Código real (`AuthContext.tsx:68-69`):**

```ts
const [user, setUser] = useState<User | null>(() => loadFromStorage<User>(STORAGE_KEY_USER));
const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(() => loadFromStorage<number>(STORAGE_KEY_COMPANY) || 1);
```

- O estado é **hidratado síncronamente do localStorage** no `useState` inicial (não via fetch assíncrono em startup).
- `selectedCompanyId` **defaulta para `1`** (`|| 1`), nunca `null`, após o primeiro login.
- `loggedIn = !!user` (`AuthContext.tsx:235`).

**Conclusão:** o cenário "deep link com estado null durante hidratação assíncrona" tem **baixa probabilidade** no design atual, porque o localStorage é síncrono e o default de empresa é `1`. A única janela assíncrona real é `loadPermissions` (chamada após login / no `useEffect` de user), mas ela só popula permissões granulares — não blocos de roteamento. O `isLoading` sugerido pelo rascunho **não existe** no contexto, mas também **não é estritamente necessário** dado o modelo síncrono de localStorage.

**Veredito:** PARCIAL. A recomendação de `isLoading` é boa prática defensiva, mas a vulnerabilidade descrita ("expulsão por hidratação incompleta") não se reproduz no código atual. Manter como melhoria opcional, não correção crítica.

---

## 3. Redirect Bounce (alegação "Média") — REAL

`RoleGate` redireciona para `/` em falha de papel (`App.tsx:37`). A rota `/` é o `RootRedirect`, que reavalia e manda para `/devices` (não-master) ou `/companies` (master) (`App.tsx:73-78`).

Exemplo real: `gestor` acessa `/permissions` (master only, `App.tsx:113`):
1. RoleGate detecta papel inválido → `<Navigate to="/" replace />` (App.tsx:37).
2. `/` monta RootRedirect → `<Navigate to="/devices" replace />` (App.tsx:78, pois gestor !== master).

São 2 transições. O `replace` evita sujar o histórico, mas há re-render duplo + flickering. **Veredito: REAL.** Correção recomendada: RoleGate redirecionar direto para um destino por papel (ex.: `/devices` para operacionais, `/companies` para master) em vez de `/`.

---

## 4. Ausência de tela 403 (alegação "Baixa") — REAL

Não há rota `/403` nem componente de "Acesso Negado". `RoleGate` e `RootRedirect` usam `Navigate` silencioso. **Veredito: REAL.** Melhoria de UX: adicionar `<Route path="/forbidden" element={<ForbiddenPage />} />` e RoleGate → `/forbidden` com mensagem de privilégios insuficientes.

---

## 5. Matriz de Rotas — correções vs rascunho

O rascunho montou uma tabela (Mapeamento de Rotas). Reconciliada com `App.tsx`:

| Rota | Auth | Roles (RoleGate) | CompanyGate | Redirecionamento em falha (real) |
|---|---|---|---|---|
| /login | Não | público | Não | N/A |
| / (RootRedirect) | Sim* | todos | Não | → /login (sem user), /companies (master s/ empresa), /devices (caso contrário) |
| /companies | Sim | master | Não | → / (RoleGate, App.tsx:37) |
| /permissions | Sim | master | Não | → / (RoleGate) |
| /dashboard | Sim | master, gestor, supervisor | Sim | → /companies se master s/ empresa (CompanyGate); → /login s/ user; RoleGate → / se papel inválido |
| /devices | Sim | todos (sem RoleGate) | Sim | CompanyGate (App.tsx:135) |
| /campaigns | Sim | master, gestor | Sim | RoleGate → /; CompanyGate → /login/companies |
| /automations | Sim | master, gestor | Sim | igual /campaigns |
| /logs | Sim | todos (sem RoleGate) | Sim | CompanyGate (App.tsx:163) |
| /settings | Sim | master, gestor | Sim | igual /campaigns |
| * (catch-all) | — | — | — | → / (App.tsx:181) |

*RootRedirect não tem ProtectedRoute externo direto, mas checa `!user` → /login (App.tsx:70). Obs: `/` está DENTRO do `<ProtectedRoute><Layout/></ProtectedRoute>` (App.tsx:89-97), então já é protegido.

**Nota importante:** o rascunho diz que `/devices`, `/logs`, `/dashboard` "exigem empresa apenas validado para master". FALSO — o `CompanyGate` envolve essas rotas (App.tsx:123, 135, 163) e, como mostrado na Seção 1, o CompanyGate real trata não-master também. A matriz do rascunho está correta quanto aos papéis, mas a premissa de que "não-master passa sem empresa" está errada.

---

## 6. Recomendações — o que vale implementar

Prioridade real (baseada no código, não no rascunho):

- **[BAIXA] Limpar a safety net do CompanyGate** (`App.tsx:55-59`): trocar `return <Navigate to="/" replace />` por redirecionamento explícito a `/companies` ou tela de seleção de empresa, para não depender do default `|| 1`.
- **[MÉDIA] Eliminar Redirect Bounce** (`App.tsx:37`): RoleGate redirecionar ao destino final por papel em vez de `/`.
- **[BAIXA] Tela 403** (`App.tsx` + nova rota): feedback explícito de acesso negado.
- **[OPCIONAL] isLoading no AuthContext** (`AuthContext.tsx`): defensivo, mas não crítico dado o modelo síncrono de localStorage.
- **[OPCIONAL] Metadados de rota**: reduz verbosidade, mas é refactor estético.

Itens do rascunho que **NÃO** são ações válidas hoje:
- "Corrigir Bypass de Tenant no CompanyGate" — já corrigido; o rascunho analisou código desatualizado.

---

## 7. Conclusão

O rascunho é bem escrito e aplica padrões enterprise corretos, mas **parte substancial da auditoria de segurança está desatualizada**: a vulnerabilidade "Crítica" de bypass de tenant não existe mais no `CompanyGate` atual. As falhas realmente presentes são de **baixa/média severidade** (redirect bounce, ausência de 403, safety net confusa). Recomenda-se revisar o rascunho antes de qualquer refatoração, ancorando em `src/App.tsx` e `src/context/AuthContext.tsx`.
