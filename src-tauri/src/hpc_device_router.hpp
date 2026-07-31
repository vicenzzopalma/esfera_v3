#ifndef HPC_DEVICE_ROUTER_HPP
#define HPC_DEVICE_ROUTER_HPP

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    const char* adb_device_id;
    const char* user_display_name;
    int32_t user_id;
    int32_t authorized;
} HpcDeviceAuthEntry;

typedef struct {
    const HpcDeviceAuthEntry* entries;
    size_t count;
} HpcDeviceAuthTable;

void hpc_device_router_init(const HpcDeviceAuthTable* table);
void hpc_device_router_shutdown(void);
int32_t hpc_device_router_check_authorized(const char* adb_device_id, int32_t user_id);
int32_t hpc_device_router_find_user_id(const char* adb_device_id);

#ifdef __cplusplus
}
#endif

#endif
