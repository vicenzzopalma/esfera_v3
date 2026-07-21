fn main() {
    cc::Build::new()
        .cpp(true)
        .file("src/native_hpc/esfera_hpc.cpp")
        .include("src/native_hpc")
        .flag_if_supported("/std:c++17")
        .flag_if_supported("-std=c++17")
        .compile("esfera_hpc");

    println!("cargo:rerun-if-changed=src/native_hpc/esfera_hpc.cpp");
    println!("cargo:rerun-if-changed=src/native_hpc/esfera_hpc.h");

    tauri_build::build();
}
