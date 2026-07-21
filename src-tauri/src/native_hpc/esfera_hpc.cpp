// ============================================================
// Esfera v3 — Engine Nativa C++ High-Performance Computing (HPC)
// Processador de Buffers ADB, Sanitizador de Frames & Dispatch CPU
// ============================================================

#include "esfera_hpc.h"
#include <random>
#include <sstream>
#include <iomanip>
#include <cmath>

#if defined(_WIN32) || defined(_MSC_VER)
    #include <windows.h>
    #include <setupapi.h>
    #include <tlhelp32.h>
    #include <string>
    #include <algorithm>
    #pragma comment(lib, "setupapi.lib")
#endif

#if defined(_MSC_VER)
    #include <intrin.h>
#elif defined(__GNUC__) || defined(__clang__)
    #include <cpuid.h>
#endif

extern "C" {

void esfera_hpc_detect_hardware(EsferaHardwareCaps* caps) {
    if (!caps) return;
    caps->supports_avx2 = false;
    caps->supports_avx512 = false;
    caps->supports_sse42 = false;

    int cpuInfo[4] = {0};

#if defined(_MSC_VER)
    __cpuid(cpuInfo, 1);
    caps->supports_sse42 = (cpuInfo[2] & (1 << 20)) != 0;

    __cpuidex(cpuInfo, 7, 0);
    caps->supports_avx2 = (cpuInfo[1] & (1 << 5)) != 0;
    caps->supports_avx512 = (cpuInfo[1] & (1 << 16)) != 0;
#elif defined(__GNUC__) || defined(__clang__)
    unsigned int eax = 0, ebx = 0, ecx = 0, edx = 0;
    if (__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
        caps->supports_sse42 = (ecx & (1 << 20)) != 0;
    }
    if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
        caps->supports_avx2 = (ebx & (1 << 5)) != 0;
        caps->supports_avx512 = (ebx & (1 << 16)) != 0;
    }
#endif
}

esfera_int32_t esfera_hpc_sanitize_png_buffer(
    const esfera_uint8_t* in,
    esfera_size_t in_len,
    esfera_uint8_t* out,
    esfera_size_t max_out,
    esfera_size_t* out_written
) {
    if (!in || !out || !out_written || in_len < 8 || max_out < in_len) {
        if (out_written) *out_written = 0;
        return -1;
    }

    // Assinatura PNG Válida: 89 50 4E 47 0D 0A 1A 0A
    static const esfera_uint8_t png_header[8] = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };

    // Se o buffer já é um PNG perfeitamente válido, faz cópia direta de memória
    bool is_valid_png = true;
    for (int i = 0; i < 8; ++i) {
        if (in[i] != png_header[i]) {
            is_valid_png = false;
            break;
        }
    }

    if (is_valid_png) {
        for (esfera_size_t i = 0; i < in_len; ++i) {
            out[i] = in[i];
        }
        *out_written = in_len;
        return 0;
    }

    // Se o stdout do ADB converteu \n -> \r\n, varredura rápida em C++
    esfera_size_t out_idx = 0;
    for (esfera_size_t i = 0; i < in_len && out_idx < max_out; ++i) {
        if (in[i] == 0x0D && (i + 1 < in_len) && in[i + 1] == 0x0A) {
            out[out_idx++] = 0x0A;
            i++;
        } else {
            out[out_idx++] = in[i];
        }
    }

    *out_written = out_idx;
    return 0;
}

void esfera_hpc_run_adb_diagnostic(EsferaAdbDiagnostic* diag) {
    if (!diag) return;
    diag->has_any_usb_device = false;
    diag->has_android_usb_device = false;
    diag->is_adb_process_running = false;
    diag->detected_usb_count = 0;
    for (int i = 0; i < 256; ++i) diag->diagnostic_msg[i] = '\0';

    const char* init_msg = "Diagnóstico não suportado nesta plataforma.";
    int idx_init = 0;
    while (init_msg[idx_init] != '\0' && idx_init < 255) {
        diag->diagnostic_msg[idx_init] = init_msg[idx_init];
        idx_init++;
    }
    diag->diagnostic_msg[idx_init] = '\0';

#if defined(_WIN32) || defined(_MSC_VER)
    // 1. Verificar se o processo adb.exe está em execução
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe32;
        pe32.dwSize = sizeof(PROCESSENTRY32W);
        if (Process32FirstW(hSnapshot, &pe32)) {
            do {
                std::wstring exe_name(pe32.szExeFile);
                std::transform(exe_name.begin(), exe_name.end(), exe_name.begin(), ::towlower);
                if (exe_name == L"adb.exe") {
                    diag->is_adb_process_running = true;
                    break;
                }
            } while (Process32NextW(hSnapshot, &pe32));
        }
        CloseHandle(hSnapshot);
    }

    // 2. Enumerar dispositivos USB
    HDEVINFO hDevInfo = SetupDiGetClassDevsW(NULL, L"USB", NULL, DIGCF_ALLCLASSES | DIGCF_PRESENT);
    if (hDevInfo != INVALID_HANDLE_VALUE) {
        SP_DEVINFO_DATA devInfoData;
        devInfoData.cbSize = sizeof(SP_DEVINFO_DATA);
        
        int devIndex = 0;
        int usb_count = 0;
        bool has_android = false;

        while (SetupDiEnumDeviceInfo(hDevInfo, devIndex, &devInfoData)) {
            devIndex++;
            usb_count++;
            
            wchar_t descBuf[512] = {0};
            DWORD regDataType = 0;
            DWORD reqSize = 0;
            if (SetupDiGetDeviceRegistryPropertyW(hDevInfo, &devInfoData, SPDRP_DEVICEDESC, &regDataType, (PBYTE)descBuf, sizeof(descBuf) - sizeof(wchar_t), &reqSize)) {
                std::wstring desc(descBuf);
                std::transform(desc.begin(), desc.end(), desc.begin(), ::towlower);

                if (desc.find(L"android") != std::wstring::npos ||
                    desc.find(L"adb") != std::wstring::npos ||
                    desc.find(L"mtp") != std::wstring::npos ||
                    desc.find(L"samsung") != std::wstring::npos ||
                    desc.find(L"motorola") != std::wstring::npos ||
                    desc.find(L"xiaomi") != std::wstring::npos ||
                    desc.find(L"redmi") != std::wstring::npos ||
                    desc.find(L"oneplus") != std::wstring::npos ||
                    desc.find(L"huawei") != std::wstring::npos ||
                    desc.find(L"google pixel") != std::wstring::npos ||
                    desc.find(L"lg mobile") != std::wstring::npos) {
                    has_android = true;
                }
            }

            wchar_t friendlyBuf[512] = {0};
            if (SetupDiGetDeviceRegistryPropertyW(hDevInfo, &devInfoData, SPDRP_FRIENDLYNAME, &regDataType, (PBYTE)friendlyBuf, sizeof(friendlyBuf) - sizeof(wchar_t), &reqSize)) {
                std::wstring friendly(friendlyBuf);
                std::transform(friendly.begin(), friendly.end(), friendly.begin(), ::towlower);

                if (friendly.find(L"android") != std::wstring::npos ||
                    friendly.find(L"adb") != std::wstring::npos ||
                    friendly.find(L"mtp") != std::wstring::npos ||
                    friendly.find(L"samsung") != std::wstring::npos ||
                    friendly.find(L"motorola") != std::wstring::npos ||
                    friendly.find(L"xiaomi") != std::wstring::npos ||
                    friendly.find(L"redmi") != std::wstring::npos ||
                    friendly.find(L"oneplus") != std::wstring::npos ||
                    friendly.find(L"huawei") != std::wstring::npos ||
                    friendly.find(L"google pixel") != std::wstring::npos ||
                    friendly.find(L"lg mobile") != std::wstring::npos) {
                    has_android = true;
                }
            }
        }
        SetupDiDestroyDeviceInfoList(hDevInfo);

        diag->detected_usb_count = usb_count;
        if (usb_count > 0) {
            diag->has_any_usb_device = true;
        }
        diag->has_android_usb_device = has_android;
    }

    std::string msg;
    if (!diag->has_any_usb_device) {
        msg = "Nenhum dispositivo USB detectado no barramento do sistema. Reconecte o cabo ou tente outra porta USB.";
    } else if (!diag->has_android_usb_device) {
        msg = "Dispositivos USB detectados, mas nenhum celular/Android foi identificado. Verifique se o aparelho esta ligado e com o modo de transferencia ativado.";
    } else if (!diag->is_adb_process_running) {
        msg = "Celular detectado fisicamente! Porem, o servidor ADB (adb.exe) nao esta rodando. Tente reiniciar o servidor ADB.";
    } else {
        msg = "Celular detectado e processo ADB ativo. Se ainda nao aparece listado, ative a 'Depuracao USB' nas configuracoes do celular e autorize o computador.";
    }

    for (int i = 0; i < 255; ++i) diag->diagnostic_msg[i] = '\0';
    int idx = 0;
    while (idx < msg.length() && idx < 255) {
        diag->diagnostic_msg[idx] = msg[idx];
        idx++;
    }
    diag->diagnostic_msg[idx] = '\0';
#endif
}

esfera_int32_t esfera_hpc_calculate_gaussian_delay(esfera_int32_t min_ms, esfera_int32_t max_ms) {
    if (min_ms >= max_ms) return min_ms;

    thread_local std::random_device rd;
    thread_local std::mt19937 gen(rd());

    double mean = (static_cast<double>(min_ms) + static_cast<double>(max_ms)) / 2.0;
    double stddev = (static_cast<double>(max_ms) - static_cast<double>(min_ms)) / 6.0;

    std::normal_distribution<double> dist(mean, stddev);
    double val = dist(gen);

    if (val < min_ms) val = min_ms;
    if (val > max_ms) val = max_ms;

    return static_cast<esfera_int32_t>(val);
}

void esfera_hpc_generate_hardware_uuid(char* out_uuid_buf, esfera_size_t max_len) {
    if (!out_uuid_buf || max_len < 32) return;

    std::ostringstream ss;
    int cpuInfo[4] = {0};

#if defined(_MSC_VER)
    __cpuid(cpuInfo, 1);
    ss << std::hex << cpuInfo[0] << cpuInfo[1] << cpuInfo[2] << cpuInfo[3];
#elif defined(__GNUC__) || defined(__clang__)
    unsigned int eax = 0, ebx = 0, ecx = 0, edx = 0;
    if (__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
        ss << std::hex << eax << ebx << ecx << edx;
    }
#endif

#if defined(_WIN32) || defined(_MSC_VER)
    wchar_t compName[MAX_COMPUTERNAME_LENGTH + 1];
    DWORD compLen = MAX_COMPUTERNAME_LENGTH + 1;
    if (GetComputerNameW(compName, &compLen)) {
        for (DWORD i = 0; i < compLen; ++i) {
            ss << static_cast<char>(compName[i]);
        }
    }

    DWORD volSerial = 0;
    if (GetVolumeInformationW(L"C:\\", NULL, 0, &volSerial, NULL, NULL, NULL, 0)) {
        ss << std::hex << volSerial;
    }
#endif

    std::string raw = ss.str();
    unsigned long long hash = 14695981039346656037ULL; // FNV-1a offset basis
    for (char c : raw) {
        hash ^= static_cast<unsigned char>(c);
        hash *= 1099511628211ULL; // FNV prime
    }

    std::ostringstream final_ss;
    final_ss << "ESFERA-HWID-" 
             << std::uppercase << std::setfill('0') << std::setw(8) << std::hex << (hash & 0xFFFFFFFF)
             << "-"
             << std::setfill('0') << std::setw(8) << std::hex << ((hash >> 32) & 0xFFFFFFFF);

    std::string formatted = final_ss.str();
    esfera_size_t idx = 0;
    while (idx < formatted.length() && idx < max_len - 1) {
        out_uuid_buf[idx] = formatted[idx];
        idx++;
    }
    out_uuid_buf[idx] = '\0';
}

esfera_int32_t esfera_hpc_generate_bezier_points(
    esfera_int32_t start_x,
    esfera_int32_t start_y,
    esfera_int32_t end_x,
    esfera_int32_t end_y,
    esfera_int32_t* out_pts_x,
    esfera_int32_t* out_pts_y,
    esfera_int32_t max_points,
    esfera_int32_t* out_count
) {
    if (!out_pts_x || !out_pts_y || !out_count || max_points < 2) return -1;

    thread_local std::random_device rd;
    thread_local std::mt19937 gen(rd());
    std::uniform_int_distribution<int> offset_dist(-40, 40);

    // Ponto de controle P1 com desvio perpendicular aleatório
    int ctrl_x = (start_x + end_x) / 2 + offset_dist(gen);
    int ctrl_y = (start_y + end_y) / 2 + offset_dist(gen);

    int num_steps = max_points > 20 ? 20 : max_points;
    for (int i = 0; i < num_steps; ++i) {
        double t = static_cast<double>(i) / static_cast<double>(num_steps - 1);
        double one_minus_t = 1.0 - t;

        double x = one_minus_t * one_minus_t * start_x + 2.0 * one_minus_t * t * ctrl_x + t * t * end_x;
        double y = one_minus_t * one_minus_t * start_y + 2.0 * one_minus_t * t * ctrl_y + t * t * end_y;

        out_pts_x[i] = static_cast<esfera_int32_t>(x);
        out_pts_y[i] = static_cast<esfera_int32_t>(y);
    }

    *out_count = num_steps;
    return 0;
}

}
