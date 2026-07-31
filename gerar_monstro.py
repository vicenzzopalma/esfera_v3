import os

ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(ROOT, "tt")

EXCLUDE_DIRS = {".git", "node_modules", "target", "dist", "gen", "icons", "binaries"}
EXCLUDE_EXTS = {".png", ".ico", ".icns", ".apk", ".mp4", ".svg", ".db", ".zip", ".pyc", ".lock"}
INCLUDE_EXTS = {".rs", ".ts", ".tsx", ".js", ".jsx", ".kt", ".cpp", ".h", ".c",
                ".json", ".toml", ".bat", ".css", ".html", ".md", ".xml", ".yml",
                ".yaml", ".gradle", ".kts", ".properties", ".sh", ".ps1", ".txt",
                ".conf", ".service", ".py", ".gradle.kts"}

SOURCE_DIRS = [
    "src",
    "src-tauri",
    "src-agent",
    "hub-standalone",
    "docs",
    ".opencode",
    ".github",
    ".agents",
    ".vscode",
]

SOURCE_FILES = [
    ".gitignore",
    "package.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts",
    "index.html",
    "README.md",
    "Iniciar_Esfera_v3.bat",
    "Ativar_Esfera_WiFi_ADB.bat",
    "gerar_monstro.py",
]

def dump_file(file_path, outfile):
    rel_path = os.path.relpath(file_path, ROOT)
    outfile.write(f"\n\n// ========================================================\n")
    outfile.write(f"// ARQUIVO: {rel_path}\n")
    outfile.write(f"// ========================================================\n\n")
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as infile:
            outfile.write(infile.read())
    except Exception as e:
        outfile.write(f"// ERRO AO COPIAR CONTEÚDO: {str(e)}\n")

def should_include(file_path):
    ext = os.path.splitext(file_path)[1].lower()
    return ext in INCLUDE_EXTS

def main():
    print(f"Gerando monstro em '{OUTPUT_FILE}'...")
    total_files = 0
    with open(OUTPUT_FILE, "w", encoding="utf-8") as outfile:
        outfile.write("// ========================================================\n")
        outfile.write("// ESFERA v3 - MONSTRO (codigo completo do programa)\n")
        outfile.write(f"// Gerado em: {os.path.basename(OUTPUT_FILE)}\n")
        outfile.write("// ========================================================\n")

        for path in SOURCE_DIRS:
            full_path = os.path.join(ROOT, path)
            if not os.path.isdir(full_path):
                continue
            for root, dirs, files in os.walk(full_path):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
                if any(ex in root for ex in EXCLUDE_DIRS):
                    continue
                for file in files:
                    file_path = os.path.join(root, file)
                    if should_include(file_path):
                        dump_file(file_path, outfile)
                        total_files += 1

        for file in SOURCE_FILES:
            file_path = os.path.join(ROOT, file)
            if os.path.isfile(file_path) and should_include(file_path):
                dump_file(file_path, outfile)
                total_files += 1

    print(f"Concluido! {total_files} arquivos consolidados em '{OUTPUT_FILE}'.")

if __name__ == "__main__":
    main()
