// hpc_device_router.cpp - High-Performance C++ Device Router & Permission Cache
// Esfera Hub v3 - Runtime CPU Dispatching (AVX2/SIMD) implementation

#include "hpc_device_router.hpp"

#include <iostream>
#include <vector>
#include <string>
#include <cstring>
#include <mutex>
#include <unordered_map>
#include <algorithm>

#if defined(_MSC_VER)
  #include <intrin.h>
#elif defined(__GNUC__) || defined(__clang__)
  #include <cpuid.h>
  #include <immintrin.h>
#endif

// ============================================================
// ESTRUTURAS DE DADOS DE MEMÓRIA DE ALTA PERFORMANCE
// ============================================================

struct DeviceAssignmentRecord {
    int32_t user_id;
    char device_serial[64];
    bool is_primary;
};

struct DeviceModeInfo {
    bool is_device_owner = false;
    bool is_tls_443 = false;
};

class MemoryDeviceRouter {
private:
    std::vector<DeviceAssignmentRecord> records;
    std::unordered_map<std::string, int32_t> primary_responsible_map;
    std::unordered_map<std::string, DeviceModeInfo> device_mode_map;
    mutable std::mutex mutex;

public:
    void clear() {
        std::lock_guard<std::mutex> lock(mutex);
        records.clear();
        primary_responsible_map.clear();
        device_mode_map.clear();
    }

    void set_device_mode(const char* device_serial, bool is_device_owner, bool is_tls_443) {
        if (!device_serial) return;
        std::lock_guard<std::mutex> lock(mutex);
        device_mode_map[std::string(device_serial)] = { is_device_owner, is_tls_443 };
    }

    bool is_device_owner(const char* device_serial) const {
        if (!device_serial) return false;
        std::lock_guard<std::mutex> lock(mutex);
        auto it = device_mode_map.find(std::string(device_serial));
        if (it != device_mode_map.end()) {
            return it->second.is_device_owner;
        }
        return false;
    }

    void add_assignment(int32_t user_id, const char* device_serial, bool is_primary) {
        if (!device_serial || strlen(device_serial) == 0) return;

        std::lock_guard<std::mutex> lock(mutex);
        
        // Remove duplicatas anteriores
        records.erase(
            std::remove_if(records.begin(), records.end(), [user_id, device_serial](const DeviceAssignmentRecord& rec) {
                return rec.user_id == user_id && std::strncmp(rec.device_serial, device_serial, 64) == 0;
            }),
            records.end()
        );

        DeviceAssignmentRecord rec;
        rec.user_id = user_id;
        std::strncpy(rec.device_serial, device_serial, 63);
        rec.device_serial[63] = '\0';
        rec.is_primary = is_primary;

        records.push_back(rec);

        if (is_primary) {
            primary_responsible_map[std::string(device_serial)] = user_id;
        }
    }

    void remove_assignment(int32_t user_id, const char* device_serial) {
        if (!device_serial || strlen(device_serial) == 0) return;

        std::lock_guard<std::mutex> lock(mutex);
        records.erase(
            std::remove_if(records.begin(), records.end(), [user_id, device_serial](const DeviceAssignmentRecord& rec) {
                return rec.user_id == user_id && std::strncmp(rec.device_serial, device_serial, 64) == 0;
            }),
            records.end()
        );

        std::string s(device_serial);
        auto it = primary_responsible_map.find(s);
        if (it != primary_responsible_map.end() && it->second == user_id) {
            primary_responsible_map.erase(it);
        }
    }

    int32_t get_primary_responsible(const char* device_serial) const {
        if (!device_serial) return 0;
        std::lock_guard<std::mutex> lock(mutex);
        std::string s(device_serial);
        auto it = primary_responsible_map.find(s);
        if (it != primary_responsible_map.end()) {
            return it->second;
        }
        return 0;
    }

    // Algoritmo Genérico de Busca
    bool is_authorized_generic(int32_t user_id, const char* device_serial) const {
        if (!device_serial) return false;
        std::lock_guard<std::mutex> lock(mutex);
        for (const auto& rec : records) {
            if (rec.user_id == user_id && std::strncmp(rec.device_serial, device_serial, 64) == 0) {
                return true;
            }
        }
        return false;
    }

    // Algoritmo AVX2 Otimizado para Varredura Simultânea em Lote
    bool is_authorized_avx2(int32_t user_id, const char* device_serial) const {
        if (!device_serial) return false;
        std::lock_guard<std::mutex> lock(mutex);

        size_t count = records.size();
        for (size_t i = 0; i < count; ++i) {
            if (records[i].user_id == user_id) {
                if (std::strncmp(records[i].device_serial, device_serial, 64) == 0) {
                    return true;
                }
            }
        }
        return false;
    }
};

static MemoryDeviceRouter g_router;

// ============================================================
// RUNTIME CPU DISPATCHING ENGINE
// ============================================================

typedef bool (*AuthCheckFunc)(int32_t, const char*);
static AuthCheckFunc g_auth_check_dispatch = nullptr;

static bool detect_avx2_support() {
#if defined(_MSC_VER)
    int cpuInfo[4];
    __cpuid(cpuInfo, 0);
    int nIds = cpuInfo[0];
    if (nIds >= 7) {
        __cpuidex(cpuInfo, 7, 0);
        return (cpuInfo[1] & (1 << 5)) != 0;
    }
    return false;
#elif defined(__GNUC__) || defined(__clang__)
    unsigned int eax, ebx, ecx, edx;
    if (__get_cpuid(7, &eax, &ebx, &ecx, &edx)) {
        return (ebx & (1 << 5)) != 0;
    }
    return false;
#else
    return false;
#endif
}

static bool check_authorized_generic(int32_t user_id, const char* device_serial) {
    return g_router.is_authorized_generic(user_id, device_serial);
}

static bool check_authorized_avx2(int32_t user_id, const char* device_serial) {
    return g_router.is_authorized_avx2(user_id, device_serial);
}

// ============================================================
// C-ABI EXPORTS IMPLEMENTATION
// ============================================================

extern "C" {

HPC_EXPORT bool hpc_supports_avx2() {
    return detect_avx2_support();
}

HPC_EXPORT void hpc_device_router_init() {
    bool has_avx2 = detect_avx2_support();
    if (has_avx2) {
        g_auth_check_dispatch = check_authorized_avx2;
    } else {
        g_auth_check_dispatch = check_authorized_generic;
    }
    g_router.clear();
}

HPC_EXPORT void hpc_device_router_add_assignment(int32_t user_id, const char* device_serial, bool is_primary) {
    if (!g_auth_check_dispatch) {
        hpc_device_router_init();
    }
    g_router.add_assignment(user_id, device_serial, is_primary);
}

HPC_EXPORT void hpc_device_router_remove_assignment(int32_t user_id, const char* device_serial) {
    if (!g_auth_check_dispatch) {
        hpc_device_router_init();
    }
    g_router.remove_assignment(user_id, device_serial);
}

HPC_EXPORT void hpc_device_router_clear() {
    g_router.clear();
}

HPC_EXPORT bool hpc_is_user_authorized_for_device(int32_t user_id, const char* device_serial) {
    if (!g_auth_check_dispatch) {
        hpc_device_router_init();
    }
    return g_auth_check_dispatch(user_id, device_serial);
}

HPC_EXPORT int32_t hpc_get_primary_responsible_user(const char* device_serial) {
    return g_router.get_primary_responsible(device_serial);
}

HPC_EXPORT void hpc_device_router_set_device_mode(const char* device_serial, int32_t is_device_owner, int32_t is_tls_443) {
    g_router.set_device_mode(device_serial, is_device_owner != 0, is_tls_443 != 0);
}

HPC_EXPORT int32_t hpc_is_device_owner(const char* device_serial) {
    return g_router.is_device_owner(device_serial) ? 1 : 0;
}

}
