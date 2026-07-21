#ifndef ESFERA_HPC_H
#define ESFERA_HPC_H

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

#ifdef __cplusplus
}
#endif

#endif // ESFERA_HPC_H
