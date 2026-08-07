#ifndef HPC_DEVICE_ROUTER_HPP
#define HPC_DEVICE_ROUTER_HPP

#include <stddef.h>
#include <stdint.h>

#ifndef HPC_EXPORT
#define HPC_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const char* adb_device_id;
    const char* user_display_name;
    int32_t user_id;
    int32_t authorized;
    int32_t is_device_owner;
    int32_t is_tls_443;
} HpcDeviceAuthEntry;

typedef struct {
    const HpcDeviceAuthEntry* entries;
    size_t count;
} HpcDeviceAuthTable;

void hpc_device_router_init(void);
void hpc_device_router_shutdown(void);
int32_t hpc_device_router_check_authorized(const char* adb_device_id, int32_t user_id);
int32_t hpc_device_router_find_user_id(const char* adb_device_id);
void hpc_device_router_set_device_mode(const char* device_serial, int32_t is_device_owner, int32_t is_tls_443);
int32_t hpc_is_device_owner(const char* device_serial);

#ifdef __cplusplus
}
#endif

#endif
