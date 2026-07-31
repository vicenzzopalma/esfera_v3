#ifndef ESFERA_HPC_H
#define ESFERA_HPC_H

#include <stddef.h>

#if defined(_MSC_VER)
    typedef unsigned __int64 esfera_size_t;
    typedef unsigned __int8  esfera_uint8_t;
    typedef __int32          esfera_int32_t;
#else
    typedef unsigned long long esfera_size_t;
    typedef unsigned char      esfera_uint8_t;
    typedef int                esfera_int32_t;
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool supports_avx2;
    bool supports_avx512;
    bool supports_sse42;
} EsferaHardwareCaps;

typedef struct {
    bool has_any_usb_device;
    bool has_android_usb_device;
    bool is_adb_process_running;
    esfera_int32_t detected_usb_count;
    char diagnostic_msg[256];
} EsferaAdbDiagnostic;

void esfera_hpc_detect_hardware(EsferaHardwareCaps* caps);

void esfera_hpc_run_adb_diagnostic(EsferaAdbDiagnostic* diag);

esfera_int32_t esfera_hpc_sanitize_png_buffer(
    const esfera_uint8_t* input_ptr,
    esfera_size_t input_len,
    esfera_uint8_t* output_ptr,
    esfera_size_t max_out_len,
    esfera_size_t* out_written
);

esfera_int32_t esfera_hpc_calculate_gaussian_delay(esfera_int32_t min_ms, esfera_int32_t max_ms);

void esfera_hpc_generate_hardware_uuid(char* out_uuid_buf, esfera_size_t max_len);

esfera_int32_t esfera_hpc_generate_bezier_points(
    esfera_int32_t start_x,
    esfera_int32_t start_y,
    esfera_int32_t end_x,
    esfera_int32_t end_y,
    esfera_int32_t* out_pts_x,
    esfera_int32_t* out_pts_y,
    esfera_int32_t max_points,
    esfera_int32_t* out_count
);

esfera_int32_t esfera_hpc_calculate_tap_coordinates(
    esfera_int32_t screen_width,
    esfera_int32_t screen_height,
    double pct_x,
    double pct_y,
    esfera_int32_t* out_x,
    esfera_int32_t* out_y
);

void esfera_hpc_format_active_user_badge(
    const char* user_display_name,
    char* out_buf,
    esfera_size_t max_len
);

// Processador genérico de buffer: remove CRLF -> LF.
// Útil para parser/logs ADB ou stream de texto.
// Se out_written > max_out_len, retorna -2.
esfera_int32_t esfera_hpc_process_buffer(
    const esfera_uint8_t* input_ptr,
    esfera_size_t input_len,
    esfera_uint8_t* output_ptr,
    esfera_size_t max_out_len,
    esfera_size_t* out_written
);

// Ponteiro de função para o caminho SIMD escolhido no boot.
typedef void (*esfera_hpc_process_fn)(const esfera_uint8_t* in, esfera_size_t len, esfera_uint8_t* out, esfera_size_t* out_written);

esfera_hpc_process_fn esfera_hpc_get_optimized_processor(void);

esfera_int32_t esfera_hpc_get_debloat_package_list(
    const char* brand_or_manufacturer,
    char* out_packages_buf,
    esfera_size_t max_len
);

#ifdef __cplusplus
}
#endif

#endif // ESFERA_HPC_H
