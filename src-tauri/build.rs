fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");

    let mut builder = cc::Build::new();
    builder.cpp(true)
        .file(format!("{}/src/native_hpc/esfera_hpc.cpp", manifest_dir))
        .file(format!("{}/src/hpc_device_router.cpp", manifest_dir))
        .include(format!("{}/src/native_hpc", manifest_dir))
        .include(format!("{}/src", manifest_dir))
        .flag_if_supported("/std:c++17")
        .flag_if_supported("-std=c++17");

    // Habilita vetorialização AVX2 universal no binário.
    if builder.get_compiler().is_like_gnu() || builder.get_compiler().is_like_clang() {
        builder.flag_if_supported("-mavx2");
    } else if builder.get_compiler().is_like_msvc() {
        builder.flag_if_supported("/arch:AVX2");
    }

    builder.compile("esfera_hpc");

    println!("cargo:rerun-if-changed={}/src/native_hpc/esfera_hpc.cpp", manifest_dir);
    println!("cargo:rerun-if-changed={}/src/native_hpc/esfera_hpc.h", manifest_dir);
    println!("cargo:rerun-if-changed={}/src/hpc_device_router.cpp", manifest_dir);
    println!("cargo:rerun-if-changed={}/src/hpc_device_router.hpp", manifest_dir);
    tauri_build::build();
}
