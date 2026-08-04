// ============================================================
// Esfera v3 — Daemon Nativo C++ de Kernel / Root (esfera_kernel_daemon.cpp)
// Compilado para Linux ARM64 / ARMv7 (Android NDK)
// Executa diretamente no Kernel (UID 0 / Root) via init.rc / Magisk service.d
// Imune ao Doze Mode, JVM GC e suspensão de processos do Android.
// ============================================================

#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <thread>
#include <chrono>
#include <cstring>
#include <cstdlib>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
#else
    #include <sys/socket.h>
    #include <arpa/inet.h>
    #include <netdb.h>
    #include <unistd.h>
    #include <fcntl.h>
    #include <sys/system_properties.h>
#endif

// Estrutura de Capacidades de Hardware do Dispositivo
struct HardwareCaps {
    char serial[128];
    char model[128];
    bool is_root_kernel;
};

// Detecção Nativa de Hardware via Linux Sysfs / Android System Properties
HardwareCaps detect_hardware() {
    HardwareCaps caps;
    std::memset(&caps, 0, sizeof(caps));
    caps.is_root_kernel = (getuid() == 0);

#ifndef _WIN32
    // Tenta ler o serial diretamente do sysfs do Kernel Linux
    std::ifstream sysfs_serial("/sys/class/android_usb/android0/iSerial");
    if (sysfs_serial.is_open() && sysfs_serial >> caps.serial && std::strlen(caps.serial) > 0) {
        // Serial lida via Sysfs com sucesso
    } else {
        // Fallback para property do sistema Android
        __system_property_get("ro.serialno", caps.serial);
        if (std::strlen(caps.serial) == 0) {
            __system_property_get("ro.boot.serialno", caps.serial);
        }
    }
    __system_property_get("ro.product.model", caps.model);
#else
    std::strncpy(caps.serial, "WIN32_DEV_TEST", sizeof(caps.serial));
    std::strncpy(caps.model, "EMULATED_DEVICE", sizeof(caps.model));
#endif

    if (std::strlen(caps.serial) == 0) {
        std::strncpy(caps.serial, "UNKNOWN_KERNEL_HWID", sizeof(caps.serial));
    }
    return caps;
}

// Daemon principal de conexão persistente no Kernel
void run_kernel_daemon(const std::string& server_ip, int server_port) {
    HardwareCaps caps = detect_hardware();
    std::cout << "[Kernel Daemon] Iniciado com UID: " << getuid() << std::endl;
    std::cout << "[Kernel Daemon] HW Serial: " << caps.serial << " (" << caps.model << ")" << std::endl;

    while (true) {
        int sock = socket(AF_INET, SOCK_STREAM, 0);
        if (sock < 0) {
            std::this_thread::sleep_for(std::chrono::seconds(5));
            continue;
        }

        sockaddr_in server_addr;
        std::memset(&server_addr, 0, sizeof(server_addr));
        server_addr.sin_family = AF_INET;
        server_addr.sin_port = htons(server_port);
        inet_pton(AF_INET, server_ip.c_str(), &server_addr.sin_addr);

        std::cout << "[Kernel Daemon] Conectando ao servidor " << server_ip << ":" << server_port << "..." << std::endl;

        if (connect(sock, (struct sockaddr*)&server_addr, sizeof(server_addr)) == 0) {
            std::cout << "[Kernel Daemon] Conexao de Kernel ESTABELECIDA!" << std::endl;

            // Handshake inicial enviando JSON de identificacao
            std::string handshake = "{\"type\":\"kernel_tunnel\",\"hardware_uuid\":\"" + std::string(caps.serial) + "\",\"model\":\"" + std::string(caps.model) + "\"}\n";
            send(sock, handshake.c_str(), handshake.length(), 0);

            // Loop Keep-Alive nativo sem consumo de CPU
            char buffer[1024];
            while (true) {
                std::this_thread::sleep_for(std::chrono::seconds(10));
                std::string ping = "{\"type\":\"ping\"}\n";
                if (send(sock, ping.c_str(), ping.length(), 0) <= 0) {
                    std::cout << "[Kernel Daemon] Queda detectada no soquete Linux!" << std::endl;
                    break;
                }
            }
        } else {
            std::cout << "[Kernel Daemon] Falha ao conectar. Retentando em 5s..." << std::endl;
        }

#ifndef _WIN32
        close(sock);
#else
        closesocket(sock);
#endif
        // Delay com Jitter para poupar bateria e evitar sobrecarga de rede
        std::this_thread::sleep_for(std::chrono::milliseconds(5000 + (std::rand() % 2000)));
    }
}

int main(int argc, char* argv[]) {
    std::string server_ip = "192.168.1.15"; // IP do servidor padrão
    int server_port = 8888;

    if (argc > 1) server_ip = argv[1];
    if (argc > 2) server_port = std::atoi(argv[2]);

    run_kernel_daemon(server_ip, server_port);
    return 0;
}
