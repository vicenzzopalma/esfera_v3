import os

PATHS_TO_DUMP = [
    "src",
    "src-tauri/src",
    "src-tauri/Cargo.toml",
    "package.json",
    "vite.config.ts",
    "README.md"
]

OUTPUT_FILE = "monstro.txt"

def dump_file(file_path, outfile):
    rel_path = os.path.relpath(file_path)
    outfile.write(f"\n\n// ========================================================\n")
    outfile.write(f"// ARQUIVO: {rel_path}\n")
    outfile.write(f"// ========================================================\n\n")
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as infile:
            outfile.write(infile.read())
    except Exception as e:
        outfile.write(f"// ERRO AO COPIAR CONTEÚDO: {str(e)}\n")

def main():
    print(f"Iniciando a geração do arquivo monstro.txt para o Esfera v3...")
    total_files = 0
    with open(OUTPUT_FILE, "w", encoding="utf-8") as outfile:
        for path in PATHS_TO_DUMP:
            if not os.path.exists(path):
                continue
            if os.path.isfile(path):
                dump_file(path, outfile)
                total_files += 1
            elif os.path.isdir(path):
                for root, dirs, files in os.walk(path):
                    if ".git" in root or "node_modules" in root or "target" in root:
                        continue
                    for file in files:
                        ext = os.path.splitext(file)[1].lower()
                        if ext in [".rs", ".ts", ".tsx", ".cpp", ".h", ".c", ".json", ".toml", ".bat", ".css", ".html", ".md"]:
                            file_path = os.path.join(root, file)
                            dump_file(file_path, outfile)
                            total_files += 1

    print(f"Concluído! {total_files} arquivos consolidados com sucesso em '{OUTPUT_FILE}'.")

if __name__ == "__main__":
    main()
