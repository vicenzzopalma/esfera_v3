// ============================================================
// Esfera v3 — Motor Spintax Real (spintax.rs)
// Sintaxe: {variante1|variante2|variante3} com aninhamento
// recursivo e contagem de combinações possíveis.
// ============================================================

use rand::Rng;

/// Limite de profundidade para evitar recursão infinita em entradas malformadas.
const MAX_DEPTH: usize = 32;

/// Limite de combinações contadas para não estourar u64 em entradas patológicas.
const MAX_COMBINATIONS: u64 = 1_000_000_000;

/// Localiza o bloco spintax mais interno (sem `{` aninhado dentro).
/// Retorna (inicio, fim) dos índices do par de chaves, ou None.
fn find_innermost_block(input: &str) -> Option<(usize, usize)> {
    let mut open: Option<usize> = None;
    for (i, c) in input.char_indices() {
        match c {
            '{' => open = Some(i),
            '}' => {
                if let Some(o) = open.take() {
                    return Some((o, i));
                }
            }
            _ => {}
        }
    }
    None
}

/// Divide as variantes de um bloco sem quebrar blocos aninhados (por segurança).
fn split_variants(inner: &str) -> Vec<String> {
    let mut variants = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    for c in inner.chars() {
        match c {
            '{' => {
                depth += 1;
                current.push(c);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(c);
            }
            '|' if depth == 0 => {
                variants.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    variants.push(current);
    variants
}

/// Expande o bloco spintax mais interno de uma string.
fn expand_one(input: &str) -> String {
    match find_innermost_block(input) {
        None => input.to_string(),
        Some((start, end)) => {
            let inner = &input[start + 1..end];
            let variants = split_variants(inner);
            let mut rng = rand::thread_rng();
            let chosen = if variants.is_empty() {
                String::new()
            } else {
                variants[rng.gen_range(0..variants.len())].clone()
            };
            let mut out = String::with_capacity(input.len());
            out.push_str(&input[..start]);
            out.push_str(&chosen);
            out.push_str(&input[end + 1..]);
            out
        }
    }
}

/// Resolve (expande) todo o Spintax de forma recursiva, do bloco mais interno
/// para o externo. Entrada sem chaves retorna igual.
pub fn resolve_spintax(input: &str) -> String {
    let mut current = input.to_string();
    for _ in 0..MAX_DEPTH {
        let expanded = expand_one(&current);
        if expanded == current {
            break;
        }
        current = expanded;
    }
    current
}

/// Conta o número total de combinações possíveis do texto Spintax.
/// Multiplica o número de variantes de cada bloco, com limite seguro.
pub fn spintax_combinations(input: &str) -> u64 {
    count_combinations(input, 0).min(MAX_COMBINATIONS)
}

fn count_combinations(input: &str, depth: usize) -> u64 {
    if depth > MAX_DEPTH {
        return 1;
    }
    // Primeiro bloco spintax no nível superior: '[' mais externo até seu '}' correspondente
    let mut first_open: Option<usize> = None;
    let mut open_depth = 0usize;
    let mut close: Option<usize> = None;
    for (i, c) in input.char_indices() {
        match c {
            '{' => {
                if first_open.is_none() {
                    first_open = Some(i);
                }
                open_depth += 1;
            }
            '}' => {
                if open_depth > 0 {
                    open_depth -= 1;
                    if open_depth == 0 {
                        close = Some(i);
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let (start, end) = match (first_open, close) {
        (Some(s), Some(e)) if e > s => (s, e),
        _ => return 1,
    };

    let inner = &input[start + 1..end];
    let variants = split_variants(inner);
    if variants.is_empty() {
        return 1;
    }

    let mut inner_total: u64 = 0;
    for v in &variants {
        inner_total = inner_total
            .saturating_add(count_combinations(v, depth + 1))
            .min(MAX_COMBINATIONS);
    }
    let before = count_combinations(&input[..start], depth + 1);
    let after = count_combinations(&input[end + 1..], depth + 1);

    before
        .saturating_mul(inner_total)
        .min(MAX_COMBINATIONS)
        .saturating_mul(after)
        .min(MAX_COMBINATIONS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_simple_variant() {
        let out = resolve_spintax("{Oi|Olá} tudo bem?");
        assert!(out == "Oi tudo bem?" || out == "Olá tudo bem?");
    }

    #[test]
    fn resolve_nested() {
        let out = resolve_spintax("{a|{b|c}}d");
        assert!(
            out == "ad" || out == "bd" || out == "cd",
            "saída inesperada: {}",
            out
        );
    }

    #[test]
    fn no_braces_unchanged() {
        assert_eq!(resolve_spintax("texto simples"), "texto simples");
    }

    #[test]
    fn combinations_basic() {
        assert_eq!(spintax_combinations("{a|b|c}{x|y}"), 6);
    }

    #[test]
    fn combinations_nested() {
        assert_eq!(spintax_combinations("{a|{b|c}}"), 3);
    }

    #[test]
    fn combinations_no_spintax() {
        assert_eq!(spintax_combinations("sem chaves"), 1);
    }
}
