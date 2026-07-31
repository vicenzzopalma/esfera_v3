fn main() {
    let mut builder = cc::Build::new();
    builder.cpp(true)
        .file("src/native_hpc/esfera_hpc.cpp")
        .file("src/hpc_device_router.cpp")
        .include("src/native_hpc")
        .include("src")
        .flag_if_supported("/std:c++17")
        .flag_if_supported("-std=c++17");

    // Habilita vetorialização AVX2 universal no binário.
    if builder.get_compiler().is_like_gnu() || builder.get_compiler().is_like_clang() {
        builder.flag_if_supported("-mavx2");
    } else if builder.get_compiler().is_like_msvc() {
        builder.flag_if_supported("/arch:AVX2");
    }

    builder.compile("esfera_hpc");

    println!("cargo:rerun-if-changed=src/native_hpc/esfera_hpc.cpp");
    println!("cargo:rerun-if-changed=src/native_hpc/esfera_hpc.h");
    println!("cargo:rerun-if-changed=src/hpc_device_router.cpp");
    println!("cargo:rerun-if-changed=src/hpc_device_router.hpp");
    tauri_build::build();
}
