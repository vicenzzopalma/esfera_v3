# Documentação Legada — Win32 ListView / Dangling Pointer (PROJETO C++ LEGADO, NÃO É O Esfera v3)

> AVISO: Este conteúdo NÃO se aplica ao Esfera v3 (que é React 19 + Tauri v2).
> Foi arquivado à parte a pedido do usuário, que o ditou como parte de um rascunho maior.
> O Esfera v3 não contém código Win32/ListView — vide Relatorio_Arquitetura_Esfera_v3.md, Seção 7.

## Contexto (texto original ditado)

O componente Win32 ListView configurado com o estilo de dados virtuais (LVS_OWNERDATA) não armazena as cadeias de caracteres dos itens em sua estrutura interna. Em vez disso, sempre que um item precisa ser desenhado na tela, a janela pai recebe uma mensagem WM_NOTIFY contendo o código de notificação LVN_GETDISPINFO.

A falha de dangling pointer ocorre quando o desenvolvedor preenche o membro NMLVDISPINFO::item.pszText com o ponteiro de um objeto std::string temporário ou uma variável local alocada na pilha da função do manipulador de mensagens:

```c
//  CÓDIGO VULNERÁVEL - Ponteiro Pendente (Dangling Pointer)
INT_PTR CALLBACK DialogProc(HWND hwnd, UINT uMsg, WPARAM wParam, LPARAM lParam) {
    if (uMsg == WM_NOTIFY) {
        LPNMHDR pnmh = (LPNMHDR)lParam;
        if (pnmh->code == LVN_GETDISPINFO) {
            NMLVDISPINFO* pItem = (NMLVDISPINFO*)lParam;
            if (pItem->item.mask & LVIF_TEXT) {
                // ERRO: std::string temporária é destruída ao sair do IF
                std::string status = "Dispositivo " + std::to_string(pItem->item.iItem);
                pItem->item.pszText = (LPSTR)status.c_str(); // PONTEIRO INVÁLIDO!
            }
        }
    }
    return FALSE;
}
```

Quando a função DialogProc encerra sua execução, a memória ocupada pela variável status na pilha é liberada. No entanto, o subsistema de renderização da API Win32 tenta ler o endereço contido em pszText instantes depois, acessando uma região de memória corrompida.

## Solução proposta (texto original ditado)

Para resolver este problema de forma definitiva e segura contra travamentos de memória (Memory-Safe), a arquitetura deve aplicar o padrão Virtual ListView com Contêiner Persistente e Smart Pointers. A visualização é totalmente desacoplada da camada de dados, e a memória das strings é mantida por ponteiros inteligentes em um vetor persistente no modelo de dados do estado da aplicação:

```cpp
//  CÓDIGO SEGURO - Alocação Persistente com std::shared_ptr
struct DeviceViewModel {
    std::string serial;
    std::string displayName;
    std::string statusText;
};

class DeviceListController {
private:
    std::vector<std::shared_ptr<DeviceViewModel>> m_devices;
    std::mutex m_dataMutex;
public:
    void OnGetDispInfo(NMLVDISPINFO* pDispInfo) {
        std::lock_guard<std::mutex> lock(m_dataMutex);
        size_t index = static_cast<size_t>(pDispInfo->item.iItem);
        if (index >= m_devices.size()) return;
        const auto& device = m_devices[index];
        if (pDispInfo->item.mask & LVIF_TEXT) {
            switch (pDispInfo->item.iSubItem) {
                case 0:
                    pDispInfo->item.pszText = const_cast<LPSTR>(device->displayName.c_str());
                    break;
                case 1:
                    pDispInfo->item.pszText = const_cast<LPSTR>(device->statusText.c_str());
                    break;
            }
        }
    }
};
```

A utilização de `const_cast<LPSTR>` apontando para o buffer mantido pelo `std::string` pertencente à estrutura alocada no `std::vector` garante que o ponteiro permanecerá válido durante todo o ciclo de pintura da janela, eliminando vazamentos de memória e acessos inválidos na Heap.
