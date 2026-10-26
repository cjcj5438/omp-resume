//! 错误信息脱敏。
/// 错误原文 → 单行、≤200 字符；形似密钥的片段脱敏为 [已脱敏]。
pub(crate) fn sanitize_message(raw: &str) -> String {
    redact_secrets(&raw.split_whitespace().collect::<Vec<_>>().join(" "))
        .chars()
        .take(200)
        .collect()
}

/// 保守脱敏：只处理明确像密钥的形态（真实数据中未见密钥，此为防御性处理）。
pub(super) fn redact_secrets(text: &str) -> String {
    const MARK: &str = "[已脱敏]";
    // 常见密钥前缀：命中则整词替换。
    const PREFIXES: &[&str] = &[
        "sk-",
        "sk_",
        "eyJ",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "AKIA",
        "xoxb-",
        "xoxp-",
        "xoxa-",
        "xoxs-",
        "sq0atp-",
        "AIza",
    ];
    let mut words: Vec<String> = text.split(' ').map(str::to_owned).collect();
    let mut cred_next = false;
    for word in words.iter_mut() {
        if cred_next {
            *word = MARK.to_owned();
            cred_next = false;
            continue;
        }
        // "Bearer <token>" / "Authorization: <token>"：凭证在下一个词。
        if word.eq_ignore_ascii_case("bearer")
            || word.eq_ignore_ascii_case("bearer:")
            || word.eq_ignore_ascii_case("authorization")
            || word.eq_ignore_ascii_case("authorization:")
        {
            cred_next = true;
            continue;
        }
        if PREFIXES
            .iter()
            .any(|p| word.len() >= p.len() + 8 && word.starts_with(p))
        {
            *word = MARK.to_owned();
            continue;
        }
        if looks_like_jwt(word) || looks_like_opaque_secret(word) {
            *word = MARK.to_owned();
            continue;
        }
        // key=value / key: value 形态：键名像密钥则只保留键名。
        if let Some(pos) = word.find('=').or_else(|| word.find(':')) {
            let key: String = word[..pos]
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
                .to_lowercase();
            if [
                "api_key",
                "apikey",
                "api-key",
                "secret",
                "password",
                "passwd",
                "token",
                "authorization",
            ]
            .iter()
            .any(|k| key.ends_with(k))
                && word.len() > pos + 1
            {
                *word = format!("{}{MARK}", &word[..=pos]);
            }
        }
    }
    words.join(" ")
}

/// 去单词首尾标点（供无特征形态判定；不改变原词）。
pub(super) fn trim_edge_punct(word: &str) -> &str {
    word.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | '.' | ';' | ':' | '!' | '?'
        )
    })
}

/// JWT 紧凑形态：三段 base64url（各 ≥8 字符）。
pub(super) fn looks_like_jwt(word: &str) -> bool {
    let parts: Vec<&str> = trim_edge_punct(word).split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| {
            p.len() >= 8
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// 无特征长串：去首尾标点后 ≥32 个 base64/十六进制字符；
/// 字符集不含 `-./`，避免误伤路径、URL、域名与 UUID。
pub(super) fn looks_like_opaque_secret(word: &str) -> bool {
    let core = trim_edge_punct(word);
    core.len() >= 32
        && core
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'_' | b'='))
}
