use crate::model::{AppError, ModelSpec, ModelSpecPatch};

use super::{invalid, manual_edit};

/// 文本行视图：`content` 不含换行符；`newline` 为原换行（`\n` / `\r\n` / 文件尾无）。
pub(super) struct Line<'a> {
    pub(super) content: &'a str,
    pub(super) newline: &'a str,
}

/// 按行切分，保留每行换行符（含 CRLF）；要求 UTF-8。
pub(super) fn split_lines(text: &str) -> Vec<Line<'_>> {
    let mut lines = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(index) => {
                let (mut content, after) = (&rest[..index], &rest[index + 1..]);
                let mut newline = "\n";
                if let Some(stripped) = content.strip_suffix('\r') {
                    content = stripped;
                    newline = "\r\n";
                }
                lines.push(Line { content, newline });
                rest = after;
            }
            None => {
                lines.push(Line {
                    content: rest,
                    newline: "",
                });
                break;
            }
        }
    }
    lines
}

/// 行首空格数（只数空格；tab 视为 0，命中时由键匹配自然失败）。
fn indent_of(content: &str) -> usize {
    content.len() - content.trim_start_matches(' ').len()
}

/// 去掉行尾注释（`#` 前须有空白；引号内的 `#` 不算）。
fn strip_comment(content: &str) -> &str {
    let bytes = content.as_bytes();
    let mut quote: Option<u8> = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(q) => {
                if byte == q {
                    if q == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        quote = None;
                    }
                } else if q == b'"' && byte == b'\\' {
                    index += 1;
                }
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    quote = Some(byte);
                } else if byte == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
                    return content[..index].trim_end();
                }
            }
        }
        index += 1;
    }
    content.trim_end()
}

/// 剥掉成对引号（双引号处理 `\\` `\"` `\n`，单引号处理 `''`）；不成对则原文。
fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let mut out = String::with_capacity(raw.len());
        let mut chars = raw[1..raw.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        }
        return out;
    }
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        return raw[1..raw.len() - 1].replace("''", "'");
    }
    raw.to_owned()
}

/// `key: value` 顶层键行解析：返回（键原文去引号后，值部分原文（去注释、去首尾空））。
/// 要求键后紧跟 `:`（`key :` 的空格容忍），值可为空（块头）。
fn parse_key_line(content: &str) -> Option<(String, &str)> {
    let trimmed = content.trim_start_matches(' ');
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("- ") || trimmed == "-"
    {
        return None;
    }
    // 键可能是 `"a b": v` / `'a': v` / `plain: v`。
    let (key_raw, after) = if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let quote = trimmed.as_bytes()[0];
        let bytes = trimmed.as_bytes();
        let mut index = 1;
        let mut end = None;
        while index < bytes.len() {
            if bytes[index] == quote {
                if quote == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                end = Some(index);
                break;
            }
            if quote == b'"' && bytes[index] == b'\\' {
                index += 1;
            }
            index += 1;
        }
        let end = end?;
        let key = &trimmed[..=end];
        let after = trimmed[end + 1..].trim_start_matches(' ');
        if !after.starts_with(':') {
            return None;
        }
        (key, after[1..].trim_start_matches(' '))
    } else {
        let colon = trimmed.find(':')?;
        let key = trimmed[..colon].trim_end_matches(' ');
        if key.is_empty() || key.contains([' ', '\t']) {
            return None;
        }
        (key, trimmed[colon + 1..].trim_start_matches(' '))
    };
    Some((unquote(key_raw), strip_comment(after).trim()))
}

/// 列表项头（`- ` / `-`）：返回横线后的剩余内容。
fn item_head(content: &str) -> Option<(usize, &str)> {
    let indent = indent_of(content);
    let trimmed = &content[indent..];
    if trimmed == "-" {
        return Some((indent, ""));
    }
    trimmed
        .strip_prefix("- ")
        .map(|rest| (indent, rest))
        .or_else(|| {
            trimmed
                .strip_prefix("-\t")
                .map(|rest| (indent, rest.trim_start_matches([' ', '\t'])))
        })
}

/// 条目首行内联键：剥掉 `- &anchor` 前缀后再解析（`- *alias` / `- {` 无键）。
fn head_key_of(rest: &str) -> Option<(String, String)> {
    let trimmed = rest.trim();
    if trimmed.is_empty() || trimmed.starts_with('*') || trimmed.starts_with('{') {
        return None;
    }
    // 锚前缀前可能有多余空格（`-   &a id: x`）：先裁再判。
    let anchored = rest.trim_start_matches([' ', '\t']);
    if let Some(after) = anchored.strip_prefix('&') {
        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
        if parts.next().unwrap_or("").is_empty() {
            return None;
        }
        let key_part = parts.next().unwrap_or("").trim_start();
        if key_part.is_empty() {
            return None;
        }
        return parse_key_line(key_part).map(|(key, value)| (key, value.to_owned()));
    }
    parse_key_line(rest).map(|(key, value)| (key, value.to_owned()))
}

/// 首行内联字段（键原文去引号后，值原文）。
type HeadKey = Option<(String, String)>;
/// 条目匹配（首行，内联键，末行）。
type ItemMatch = (usize, HeadKey, usize);
/// 条目首行内联 id 归一化：剥掉前导 `&anchor` 标记再去引号。
/// `id: &x fast` → `fast`；无锚时与 `unquote` 一致。
fn normalize_id_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(after) = trimmed.strip_prefix('&') {
        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
        let anchor = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("").trim();
        if !anchor.is_empty() && !rest.is_empty() {
            return unquote(rest);
        }
    }
    unquote(trimmed)
}

/// 条目直接子字段缩进：首行有内联键则取首行键列，否则取横线后首个键行的缩进。
/// 找不到任何键行时回退 `dash + 2`（纯 `- ` 空条目）。
fn item_field_indent(lines: &[Line<'_>], item_line: usize, end_line: usize) -> usize {
    let content = lines[item_line].content;
    let dash_indent = indent_of(content);
    if let Some((_, rest)) = item_head(content) {
        if head_key_of(rest).is_some() {
            // 首行内联键的列：横线后第一个非空白字符列（锚前缀跳过）。
            let after_dash = &content[dash_indent + 1..];
            let key_rest = after_dash.trim_start_matches([' ', '\t']);
            let mut key_col = content.len() - key_rest.len();
            if let Some(after) = key_rest.strip_prefix('&') {
                // `- &anchor key:`：键在锚之后。
                let mut parts = after.splitn(2, |c: char| c.is_whitespace());
                let anchor = parts.next().unwrap_or("");
                if !anchor.is_empty() {
                    let key_part = parts.next().unwrap_or("");
                    let trimmed = key_part.trim_start();
                    key_col = content.len() - trimmed.len();
                }
            }
            // 锚头（`- &a id: x`）键列偏右：续行首个键行的缩进才是字段真相
            // （YAML 紧凑写法允许续行与首键不对齐）；无续行键或其不深于横线
            // （外来回退行）时沿用键列。
            let mut index = item_line + 1;
            while index <= end_line && index < lines.len() {
                let line = &lines[index];
                if item_head(line.content).is_some() {
                    break;
                }
                if parse_key_line(line.content).is_some() {
                    let found = indent_of(line.content);
                    if found > dash_indent {
                        return found;
                    }
                    break;
                }
                index += 1;
            }
            return key_col;
        }
    }
    let mut index = item_line + 1;
    while index <= end_line && index < lines.len() {
        let line = &lines[index];
        if item_head(line.content).is_some() {
            break;
        }
        if parse_key_line(line.content).is_some() {
            return indent_of(line.content);
        }
        index += 1;
    }
    dash_indent + 2
}

/// 模型条目在行数组中的位置。
pub(super) struct ModelSpan {
    /// 列表项首行（`- ...`）下标。
    pub(super) item_line: usize,
    /// 首行 `- ` 后的内联 `key: value`（如 `- id: x`），无则 None。
    pub(super) head_key: HeadKey,
    /// 条目最后一行下标（含）。
    pub(super) end_line: usize,
    /// 条目内字段缩进（`- ` 行的字段缩进；`- id: x` 与续行字段可能差两列）。
    pub(super) field_indent: usize,
}

/// 定位 `providers:` 下某 provider 的 `models:` 列表里 `id` 匹配的条目。
/// 返回条目跨度；锚点/注释/其他 provider 均原样跳过。
pub(super) fn locate_model(
    lines: &[Line<'_>],
    provider: &str,
    id: &str,
) -> Result<ModelSpan, AppError> {
    // 1) 顶层 `providers:` 块。
    let mut providers_line = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some((key, value)) = parse_key_line(line.content) {
            if indent_of(line.content) == 0 && key == "providers" && value.is_empty() {
                providers_line = Some(index);
                break;
            }
        }
    }
    let providers_line = providers_line.ok_or_else(|| manual_edit("未找到 providers 配置块"))?;

    // 2) provider 键：缩进大于 0、小于等于其后 models 块；同级键出现即结束。
    let mut provider_indent = None;
    let mut provider_count = 0;
    let mut provider_line = None;
    for (index, line) in lines.iter().enumerate().skip(providers_line + 1) {
        let indent = indent_of(line.content);
        if indent == 0 {
            if parse_key_line(line.content).is_some() {
                break;
            }
            continue;
        }
        let Some((key, _)) = parse_key_line(line.content) else {
            continue;
        };
        match provider_indent {
            None => {
                // 第一个 provider 键确立缩进；同名计数用于判重。
                if key == provider {
                    provider_indent = Some(indent);
                    provider_count = 1;
                    provider_line = Some(index);
                } else if indent == provider_indent.unwrap_or(indent) {
                    // 首个非目标键：仍需确立缩进以便判重（取首键缩进）。
                    provider_indent = Some(indent);
                }
            }
            Some(expected) => {
                if indent < expected {
                    continue;
                }
                if indent == expected && key == provider {
                    provider_count += 1;
                    if provider_count == 1 {
                        provider_line = Some(index);
                    }
                }
            }
        }
    }
    if provider_count > 1 {
        return Err(manual_edit(
            format!("provider {provider} 在文件中出现多次").as_str(),
        ));
    }
    let provider_line = provider_line.ok_or_else(|| invalid("未找到指定的 provider"))?;
    let provider_indent =
        provider_indent.unwrap_or_else(|| indent_of(lines[provider_line].content));

    // 3) provider 块内的 `models:`（缩进大于 provider）；同级第二个 models → 手动改。
    let mut models_line = None;
    let mut models_indent_found = None;
    let mut scan = provider_line + 1;
    while scan < lines.len() {
        let line = &lines[scan];
        let indent = indent_of(line.content);
        if let Some((key, value)) = parse_key_line(line.content) {
            if indent <= provider_indent {
                break;
            }
            if indent > provider_indent && key == "models" && value.is_empty() {
                match models_line {
                    None => {
                        models_line = Some(scan);
                        models_indent_found = Some(indent);
                    }
                    Some(_) if Some(indent) == models_indent_found => {
                        return Err(manual_edit("该 provider 下 models 出现多次"));
                    }
                    Some(_) => {}
                }
            }
        }
        scan += 1;
    }
    let models_line = models_line.ok_or_else(|| manual_edit("该 provider 下未找到 models 列表"))?;
    let models_indent = indent_of(lines[models_line].content);

    // 4) 条目：缩进大于 models 的 `- ` 项；首个缩进<=models 的键行结束列表。
    // 先收集条目跨度，再逐条目按直接子字段缩进找 id（嵌套 id 永不匹配）。
    struct RawItem {
        start: usize,
        head: HeadKey,
        end: usize,
    }
    let mut items: Vec<RawItem> = Vec::new();
    let mut item_indent: Option<usize> = None;
    let mut current: Option<(usize, HeadKey)> = None;
    let mut index = models_line + 1;
    // 纯别名条目不占 current，但它的行归属上一条目跨度无关紧要（跨度只用于读 id）。
    let mut index_end = lines.len();
    while index < lines.len() {
        let line = &lines[index];
        let indent = indent_of(line.content);
        if let Some((head_indent, rest)) = item_head(line.content) {
            // 零额外缩进序列（`models:` 后横线与其同列）是合法 YAML。
            // 首项确立条目缩进；之后同条目缩进的横线（即使恰在 models 列）即新条目，
            // 只有浅于条目与 models 二者之浅者才是外来 dedent。混入的深缩进横线
            // （嵌套列表）仍由下方的 item_indent 不一致分支归入当前条目。
            if head_indent < item_indent.unwrap_or(models_indent).min(models_indent) {
                index_end = index;
                break;
            }
            if item_indent.is_none() {
                item_indent = Some(head_indent);
            }
            if Some(head_indent) != item_indent {
                // 缩进不一致的横线：可能是嵌套列表，归入当前条目。
                index += 1;
                continue;
            }
            if let Some((start, head)) = current.take() {
                items.push(RawItem {
                    start,
                    head,
                    end: index - 1,
                });
            }
            let rest_trimmed = rest.trim();
            if rest_trimmed.starts_with('{') {
                return Err(manual_edit("models 列表含行内对象写法（- {…}）"));
            }
            // 纯别名条目（`- *name`）：形状合法但无本地 id，不可编辑，跳过。
            if rest_trimmed.starts_with('*') {
                current = None;
                index += 1;
                continue;
            }
            let head = head_key_of(rest);
            // 首行非空但解析不出键（`- &` 残缺等复杂写法）→ 拒绝。
            if !rest_trimmed.is_empty() && head.is_none() && !rest_trimmed.starts_with('&') {
                return Err(manual_edit("models 列表含无法识别的条目写法"));
            }
            if head.is_none()
                && rest_trimmed.starts_with('&')
                && rest
                    .trim_start_matches([' ', '\t'])
                    .strip_prefix('&')
                    .is_some_and(|after| {
                        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
                        let anchor = parts.next().unwrap_or("");
                        let key_part = parts.next().unwrap_or("").trim_start();
                        anchor.is_empty()
                            || (!key_part.is_empty() && parse_key_line(key_part).is_none())
                    })
            {
                return Err(manual_edit("models 列表含无法识别的条目写法"));
            }
            current = Some((index, head));
            index += 1;
            continue;
        }
        // 非横线行：缩进<=models 的键行结束列表。
        if parse_key_line(line.content).is_some() && indent <= models_indent {
            index_end = index;
            break;
        }
        index += 1;
    }
    if let Some((start, head)) = current {
        items.push(RawItem {
            start,
            head,
            end: index_end.saturating_sub(1),
        });
    }
    // 逐条目收集直接子 id：首行内联 id + 与字段缩进同列的续行 id。
    // 同一条目两个不同顶层 id → 手动改；嵌套 id 永不参与匹配。
    let mut matches: Vec<ItemMatch> = Vec::new();
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut duplicate_target = false;
    for item in &items {
        let item_end = item.end.min(lines.len().saturating_sub(1));
        let field_indent = item_field_indent(lines, item.start, item_end);
        let mut found: Option<String> = None;
        let mut second: Option<String> = None;
        let mut conflict = false;
        if let Some((key, value)) = &item.head {
            if key == "id" {
                found = Some(normalize_id_value(value));
            }
        }
        let mut scan = item.start + 1;
        let mut skip_until: usize = 0;
        while scan <= item_end {
            if scan <= skip_until {
                scan += 1;
                continue;
            }
            let line = &lines[scan];
            if let Some((key, value)) = parse_key_line(line.content) {
                let indent = indent_of(line.content);
                if is_block_scalar_value(value) {
                    skip_until = block_scalar_end(lines, scan, item_end, indent);
                }
                if indent == field_indent && key == "id" {
                    let value = normalize_id_value(value);
                    match &found {
                        None => found = Some(value),
                        Some(first) if *first == value => {}
                        Some(_) => {
                            second = Some(value);
                            conflict = true;
                            break;
                        }
                    }
                }
            }
            scan += 1;
        }
        if conflict {
            // 首行与续行各一个不同的顶层 id：任一命中目标都无法确定，提示手动改。
            if found.as_deref() == Some(id) || second.as_deref() == Some(id) {
                return Err(manual_edit("该模型的 id 出现多次"));
            }
            continue;
        }
        if let Some(value) = found {
            if value == id {
                matches.push((item.start, item.head.clone(), item_end));
            }
            if !seen_ids.insert(value.clone()) && value == id {
                duplicate_target = true;
            }
        }
    }
    // （跨度在上一步已收尾；此处直接判重。）
    if duplicate_target || matches.len() > 1 {
        return Err(manual_edit(
            format!("模型 {provider}/{id} 在文件中出现多次").as_str(),
        ));
    }
    let (item_line, head_key, end_line) = matches
        .into_iter()
        .next()
        .ok_or_else(|| invalid("未找到指定的模型"))?;
    let field_indent = item_field_indent(lines, item_line, end_line);
    Ok(ModelSpan {
        item_line,
        head_key,
        end_line,
        field_indent,
    })
}

/// 从条目跨度内提取规格字段（只读非凭据键；其余键忽略）。
pub(super) fn read_spec(
    lines: &[Line<'_>],
    span: &ModelSpan,
    provider: &str,
    id: &str,
) -> ModelSpec {
    let mut name = None;
    let mut context_window = None;
    let mut max_tokens = None;
    let mut reasoning = None;
    let mut input = None;
    let mut cost_input = None;
    let mut cost_output = None;
    let mut cost_cache_read = None;
    let mut cost_cache_write = None;

    let mut cost_indent: Option<usize> = None;
    let mut cost_child_indent: Option<usize> = None;
    // （行号，缩进，键，值）：行号用于块序列 input 体解析。
    let mut fields: Vec<(usize, usize, String, String)> = Vec::new();
    if let Some((key, value)) = &span.head_key {
        fields.push((
            span.item_line,
            span.field_indent,
            key.clone(),
            value.clone(),
        ));
    }
    let mut skip_until: usize = 0;
    for (line_no, line) in lines
        .iter()
        .enumerate()
        .take(span.end_line + 1)
        .skip(span.item_line + 1)
    {
        if line_no <= skip_until {
            continue;
        }
        if let Some((key, value)) = parse_key_line(line.content) {
            let indent = indent_of(line.content);
            if is_block_scalar_value(value) {
                skip_until = block_scalar_end(lines, line_no, span.end_line, indent);
            }
            fields.push((line_no, indent, key, value.to_owned()));
        }
    }
    let mut cost_tiered = false;
    for (line_no, indent, key, value) in &fields {
        if let Some(cost_at) = cost_indent {
            if *indent > cost_at {
                // cost 子键只收首个子缩进同列的行；更深嵌套（如 longContext 体）
                // 说明是分层价：整块标 tiered，后续不再收任何价。
                match cost_child_indent {
                    None => {
                        cost_child_indent = Some(*indent);
                    }
                    Some(child) if *indent != child => {
                        cost_tiered = true;
                        continue;
                    }
                    _ => {}
                }
                // 子键值为空/标签/行内映射 → 嵌套映射头，同样标 tiered。
                if value.is_empty() || value.starts_with('!') || value.starts_with('{') {
                    cost_tiered = true;
                    continue;
                }
                match key.as_str() {
                    "input" => cost_input = parse_cost_value(value),
                    "output" => cost_output = parse_cost_value(value),
                    "cacheRead" => cost_cache_read = parse_cost_value(value),
                    "cacheWrite" => cost_cache_write = parse_cost_value(value),
                    _ => {}
                }
                continue;
            }
            cost_indent = None;
            cost_child_indent = None;
        }
        // 只认直接子字段（与条目字段缩进同列）；嵌套键视为不透明。
        // 首行内联键已按字段缩进压入，不受此限。
        if *indent != span.field_indent {
            continue;
        }
        match key.as_str() {
            "name" => name = Some(unquote(value)),
            "contextWindow" => context_window = parse_u64_value(value),
            "maxTokens" => max_tokens = parse_u64_value(value),
            "reasoning" => reasoning = parse_bool_value(value),
            "input" => {
                // 流式 `[a, b]` 优先；空值头 + 块序列子行则读块序列。
                if let Some(items) = parse_input_value(value) {
                    input = Some(items);
                } else if value.is_empty() {
                    let items = parse_block_sequence_input(lines, *line_no, span.end_line);
                    if !items.is_empty() {
                        input = Some(items);
                    }
                }
            }
            "cost" if value.is_empty() || value.starts_with('&') => cost_indent = Some(*indent),
            _ => {}
        }
    }
    // 分层价：四费用一律 None，只留标记（绝不把层级价当基准价报）。
    if cost_tiered {
        cost_input = None;
        cost_output = None;
        cost_cache_read = None;
        cost_cache_write = None;
    }

    ModelSpec {
        provider: provider.to_owned(),
        id: id.to_owned(),
        selector: format!("{provider}/{id}"),
        name,
        context_window,
        max_tokens,
        reasoning,
        input,
        cost_input,
        cost_output,
        cost_cache_read,
        cost_cache_write,
        cost_tiered,
    }
}

/// 读出全文件所有模型的规格（`get_model_specs` 用；形状异常的 provider 跳过）。
pub(super) fn read_all_specs(text: &str, validate: bool) -> Result<Vec<ModelSpec>, AppError> {
    let lines = split_lines(text);
    // 复用定位逻辑：先找 providers 块，再枚举各 provider 的 models 列表。
    let mut providers_line = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some((key, value)) = parse_key_line(line.content) {
            if indent_of(line.content) == 0 && key == "providers" && value.is_empty() {
                providers_line = Some(index);
                break;
            }
        }
    }
    let Some(providers_line) = providers_line else {
        if validate {
            return Err(manual_edit("未找到 providers 配置块"));
        }
        return Ok(Vec::new());
    };
    // 收集 provider 键（首个缩进确立同级）。
    let mut provider_indent: Option<usize> = None;
    let mut providers: Vec<(String, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate().skip(providers_line + 1) {
        let Some((key, _)) = parse_key_line(line.content) else {
            continue;
        };
        let indent = indent_of(line.content);
        if indent == 0 {
            break;
        }
        match provider_indent {
            None => {
                provider_indent = Some(indent);
                providers.push((key, index));
            }
            Some(expected) => {
                if indent < expected {
                    continue;
                }
                if indent == expected {
                    providers.push((key, index));
                }
            }
        }
    }
    let mut specs = Vec::new();
    for (provider, provider_line) in &providers {
        let provider_indent = indent_of(lines[*provider_line].content);
        let mut models_line = None;
        let mut scan = provider_line + 1;
        while scan < lines.len() {
            let line = &lines[scan];
            if let Some((key, value)) = parse_key_line(line.content) {
                let indent = indent_of(line.content);
                if indent <= provider_indent {
                    break;
                }
                if key == "models" && value.is_empty() {
                    models_line = Some(scan);
                    break;
                }
            }
            scan += 1;
        }
        let Some(models_line) = models_line else {
            continue;
        };
        let models_indent = indent_of(lines[models_line].content);
        // 枚举条目跨度并逐个读 id。
        let mut item_indent: Option<usize> = None;
        let mut item_starts: Vec<usize> = Vec::new();
        let mut index = models_line + 1;
        let mut list_end = models_line;
        while index < lines.len() {
            let line = &lines[index];
            if let Some((head_indent, rest)) = item_head(line.content) {
                // 零额外缩进序列首项接受（合法 YAML）；首项确立条目缩进后同列即新条目，
                // 只有浅于条目与 models 二者之浅者才结束列表。
                if head_indent < item_indent.unwrap_or(models_indent).min(models_indent) {
                    break;
                }
                if item_indent.is_none() {
                    item_indent = Some(head_indent);
                }
                if Some(head_indent) == item_indent {
                    let trimmed = rest.trim();
                    if trimmed.starts_with('{') {
                        if validate {
                            return Err(manual_edit("models 列表含行内对象写法（- {…}）"));
                        }
                        // 宽容读：跳过该流式项，继续收后项（不隐藏整 provider）。
                        list_end = index;
                        index += 1;
                        continue;
                    }
                    // 纯别名条目（`- *name`）无本地字段，读侧跳过。
                    if !trimmed.starts_with('*') {
                        item_starts.push(index);
                    }
                }
                list_end = index;
                index += 1;
                continue;
            }
            if let Some((_, _)) = parse_key_line(line.content) {
                if indent_of(line.content) <= models_indent {
                    break;
                }
            }
            list_end = index;
            index += 1;
        }
        for (position, start) in item_starts.iter().enumerate() {
            let end = item_starts
                .get(position + 1)
                .map(|next| next - 1)
                .unwrap_or(list_end);
            let head_key = item_head(lines[*start].content).and_then(|(_, rest)| head_key_of(rest));
            let span = ModelSpan {
                item_line: *start,
                head_key,
                end_line: end,
                field_indent: item_field_indent(&lines, *start, end),
            };
            // 只认直接子 id（首行内联 + 同列续行）；嵌套 id 永不匹配。
            let mut found = String::new();
            if let Some((key, value)) = &span.head_key {
                if key == "id" {
                    found = normalize_id_value(value);
                }
            }
            if found.is_empty() {
                let mut skip_until: usize = 0;
                for (line_no, line) in lines.iter().enumerate().take(end + 1).skip(start + 1) {
                    if line_no <= skip_until {
                        continue;
                    }
                    if let Some((key, value)) = parse_key_line(line.content) {
                        let indent = indent_of(line.content);
                        if is_block_scalar_value(value) {
                            skip_until = block_scalar_end(&lines, line_no, end, indent);
                        }
                        if indent == span.field_indent && key == "id" {
                            found = normalize_id_value(value);
                            break;
                        }
                    }
                }
            }
            // id 缺失的条目跳过（omp 会 fail-closed，但读侧宽容）。
            if found.is_empty() {
                continue;
            }
            let mut spec = read_spec(&lines, &span, provider, &found);
            spec.id = found.clone();
            spec.selector = format!("{provider}/{found}");
            specs.push(spec);
        }
    }
    Ok(specs)
}

fn parse_u64_value(raw: &str) -> Option<u64> {
    let value = unquote(raw);
    if value.is_empty() {
        return None;
    }
    value.parse::<u64>().ok()
}

fn parse_bool_value(raw: &str) -> Option<bool> {
    match unquote(raw).as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// `input` 支持行内 `[text, image]`（含引号变体）与空值。
fn parse_input_value(raw: &str) -> Option<Vec<String>> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let inner = value.strip_prefix('[')?.strip_suffix(']')?;
    let mut items = Vec::new();
    for part in inner.split(',') {
        let item = unquote(part.trim());
        if item.is_empty() {
            continue;
        }
        items.push(item);
    }
    Some(items)
}

fn parse_cost_value(raw: &str) -> Option<f64> {
    let value = unquote(raw);
    if value.is_empty() {
        return None;
    }
    value.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// name 双引号转义（`\\` 与 `"`）。
fn quote_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 2);
    out.push('"');
    for c in name.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 费用数字：最多 6 位小数，去尾零（`0.300000` → `0.3`，`0` → `0`）。
pub(super) fn format_cost(value: f64) -> String {
    let rounded = (value * 1_000_000.0).round() / 1_000_000.0;
    let mut text = format!("{rounded:.6}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    if text == "-0" {
        text = "0".to_owned();
    }
    text
}

fn format_input(items: &[String]) -> String {
    format!("[{}]", items.join(", "))
}

/// 块标量头判定：`parse_key_line` 已去注释，值段形如 `|`/`>`/`|-`/`>+`/`|2`。
fn is_block_scalar_value(value: &str) -> bool {
    let value = value.trim();
    let mut chars = value.chars();
    match chars.next() {
        Some('|') | Some('>') => {}
        _ => return false,
    }
    let rest = &value[1..];
    let rest = rest.strip_prefix(['+', '-']).unwrap_or(rest);
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    rest.trim().is_empty()
}

/// 列表项行判定（`- ` / `-` / `-\t`，去掉前导空格后看）。
fn is_sequence_item(content: &str) -> bool {
    let trimmed = content.trim_start_matches(' ');
    trimmed == "-" || trimmed.starts_with("- ") || trimmed.starts_with("-\t")
}

/// 块序列子行收集：从 `header + 1` 起，连续的序列项行（缩进大于头缩进，
/// 或与头同列的零缩进 `- ` 行）都归属该头；夹在序列项之间的注释/空行
/// 一并归属（删头时同删，避免悬空）。
fn block_sequence_children(
    lines: &[Line<'_>],
    header: usize,
    end_line: usize,
    header_indent: usize,
) -> Vec<usize> {
    let mut owned = Vec::new();
    let mut pending_blank: Vec<usize> = Vec::new();
    let mut index = header + 1;
    let limit = end_line.min(lines.len().saturating_sub(1));
    while index <= limit {
        let content = lines[index].content;
        let trimmed = content.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            pending_blank.push(index);
            index += 1;
            continue;
        }
        let indent = indent_of(content);
        if is_sequence_item(content) && indent >= header_indent {
            owned.append(&mut pending_blank);
            owned.push(index);
            index += 1;
            continue;
        }
        break;
    }
    owned
}

/// 块标量体跳过：从 `header + 1` 起，缩进大于头缩进的行与空行都属标量体。
/// 返回体末行下标（含）；无体返回 `header`。
fn block_scalar_end(
    lines: &[Line<'_>],
    header: usize,
    end_line: usize,
    header_indent: usize,
) -> usize {
    let mut last = header;
    let mut index = header + 1;
    let limit = end_line.min(lines.len().saturating_sub(1));
    while index <= limit {
        let content = lines[index].content;
        if content.trim().is_empty() {
            last = index;
            index += 1;
            continue;
        }
        if indent_of(content) > header_indent {
            last = index;
            index += 1;
            continue;
        }
        break;
    }
    last
}

/// 块序列 `input` 体解析：`input:` 空值头 + 后续子行 `- text`/`- image`。
/// 子项去引号；复杂项跳过。
fn parse_block_sequence_input(lines: &[Line<'_>], header: usize, end_line: usize) -> Vec<String> {
    let header_indent = indent_of(lines[header].content);
    let mut items = Vec::new();
    for child in block_sequence_children(lines, header, end_line, header_indent) {
        let content = lines[child].content;
        let trimmed = content.trim_start_matches(' ');
        let rest = trimmed
            .strip_prefix('-')
            .unwrap_or(trimmed)
            .trim_start_matches([' ', '\t']);
        let rest = strip_comment(rest).trim();
        if rest.is_empty() {
            continue;
        }
        // `- {…}` 等复杂项：只取纯标量。
        if rest.starts_with('{') || rest.starts_with('[') || rest.starts_with('*') {
            continue;
        }
        let item = unquote(rest);
        if !item.is_empty() {
            items.push(item);
        }
    }
    items
}

/// 替换行内 `key:` 后的值段（保留缩进、键原文、行尾注释与换行）。
/// 返回新行 content（不含换行）。
fn replace_value(content: &str, key_end: usize, new_value: &str) -> String {
    // key_end 为 `:` 在 content 中的字节下标。
    let (head, after) = content.split_at(key_end + 1);
    // after = ` 旧值 # 注释`：找到注释起点（`#` 前有空白、引号外）。
    let bytes = after.as_bytes();
    let mut quote: Option<u8> = None;
    let mut index = 0;
    let mut comment_at = None;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(q) => {
                if byte == q {
                    if q == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                        index += 1;
                    } else {
                        quote = None;
                    }
                } else if q == b'"' && byte == b'\\' {
                    index += 1;
                }
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    quote = Some(byte);
                } else if byte == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
                    comment_at = Some(index);
                    break;
                }
            }
        }
        index += 1;
    }
    let mut out = String::with_capacity(content.len() + new_value.len());
    out.push_str(head);
    out.push(' ');
    out.push_str(new_value);
    if let Some(at) = comment_at {
        // 保留注释前的空白（至少一空格）与注释原文。
        let comment = &after[at..];
        let gap = &after[..at];
        let spaces = gap.len() - gap.trim_end().len();
        for _ in 0..spaces.max(1) {
            out.push(' ');
        }
        out.push_str(comment.trim_end());
    }
    out
}

/// 在 content 中找顶层 `key:` 的 `:` 下标（与 `parse_key_line` 同规则）。
fn key_colon(content: &str) -> Option<usize> {
    let trimmed = content.trim_start_matches(' ');
    let base = content.len() - trimmed.len();
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let quote = trimmed.as_bytes()[0];
        let bytes = trimmed.as_bytes();
        let mut index = 1;
        while index < bytes.len() {
            if bytes[index] == quote {
                if quote == b'\'' && bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                let after = &trimmed[index + 1..];
                let spaces = after.len() - after.trim_start_matches(' ').len();
                if after[spaces..].starts_with(':') {
                    return Some(base + index + 1 + spaces);
                }
                return None;
            }
            if quote == b'"' && bytes[index] == b'\\' {
                index += 1;
            }
            index += 1;
        }
        return None;
    }
    let colon = trimmed.find(':')?;
    Some(base + colon)
}

/// 首行 `- ` 内联字段的 `:` 下标（content 内字节下标；`- &anchor` 前缀先剥掉）。
fn head_colon(content: &str, dash_indent: usize) -> Option<usize> {
    let after_dash = content
        .get(dash_indent + 1..)?
        .trim_start_matches([' ', '\t']);
    let key_part = after_dash.strip_prefix('&').and_then(|after| {
        let mut parts = after.splitn(2, |c: char| c.is_whitespace());
        if parts.next().unwrap_or("").is_empty() {
            return None;
        }
        Some(parts.next().unwrap_or("").trim_start())
    });
    match key_part {
        Some("") | None if after_dash.trim_start().starts_with('&') => {
            // `- &name` bare 头：内联无键，不应走到替换。
            None
        }
        Some(part) => {
            let base = content.len() - after_dash.len() + (after_dash.len() - part.len());
            key_colon(part).map(|colon| base + colon)
        }
        None => {
            let base = content.len() - after_dash.len();
            key_colon(after_dash).map(|colon| base + colon)
        }
    }
}

/// 锚名字符集（YAML 子集）：字母数字 + `_-.:%` + 非 ASCII。
fn is_anchor_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '%' | '/')
}

/// 从 `&...` 后取锚名（到首个非锚字符止）。
fn anchor_name_of(after: &str) -> String {
    after.chars().take_while(|c| is_anchor_char(*c)).collect()
}

/// 行内别名引用扫描：`*name` 完整名比对（`code` 已去注释；遇引号内疑似
/// 别名仍按引用算，fail-closed）。
fn line_references_alias(code: &str, anchor: &str) -> bool {
    let bytes = code.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'*' {
            index += 1;
            continue;
        }
        let rest = &code[index + 1..];
        let name: String = rest.chars().take_while(|c| is_anchor_char(*c)).collect();
        if name == anchor {
            return true;
        }
        index += 1;
    }
    false
}

/// 目标条目锚引用检查：条目首行 `- &name` 或条目内 `cost: &name` 定义的锚，
/// 若正文他处出现 `*name` 引用则拒绝（改锚会静默波及引用者）。
fn reject_aliased_target(lines: &[Line<'_>], span: &ModelSpan) -> Result<(), AppError> {
    let mut anchors: Vec<String> = Vec::new();
    if let Some((_, rest)) = item_head(lines[span.item_line].content) {
        if let Some(after) = rest.trim_start_matches([' ', '\t']).strip_prefix('&') {
            let name = anchor_name_of(after);
            if !name.is_empty() {
                anchors.push(name);
            }
        }
    }
    for line in lines.iter().take(span.end_line + 1).skip(span.item_line) {
        if let Some((key, value)) = parse_key_line(line.content) {
            if key == "cost" && value.starts_with('&') {
                let name = anchor_name_of(&value[1..]);
                if !name.is_empty() {
                    anchors.push(name);
                }
            }
        }
    }
    if anchors.is_empty() {
        return Ok(());
    }
    for (index, line) in lines.iter().enumerate() {
        if index >= span.item_line && index <= span.end_line {
            continue;
        }
        let code = strip_comment(line.content);
        for anchor in &anchors {
            if line_references_alias(code, anchor) {
                return Err(manual_edit(
                    format!("该模型被别名 *{anchor} 引用，改它会影响其他条目").as_str(),
                ));
            }
        }
    }
    Ok(())
}

/// 对单个模型条目应用补丁，返回新全文。
/// 只替换已存在的标量行或在 `- ` 行后插入缺失字段；其余字节不动。
pub(super) fn apply_patch_to_text(
    text: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
) -> Result<String, AppError> {
    let lines = split_lines(text);
    let span = locate_model(&lines, provider, id)?;
    // 别名引用检查：目标条目若定义了锚（`- &name` / `cost: &name`）且正文中有
    // `*name` 引用，改它会静默波及其他引用者 → 拒绝，请手动改。
    reject_aliased_target(&lines, &span)?;
    struct FieldRow {
        line: usize,
        key: String,
        head: bool,
    }
    let mut rows: Vec<FieldRow> = Vec::new();
    if let Some((key, _)) = &span.head_key {
        rows.push(FieldRow {
            line: span.item_line,
            key: key.clone(),
            head: true,
        });
    }
    // cost 块范围（行号区间）与子键行。
    let mut cost_block: Option<(usize, usize)> = None;
    let mut cost_rows: Vec<FieldRow> = Vec::new();
    let mut cost_indent: Option<usize> = None;
    let mut cost_child_indent: Option<usize> = None;
    let mut cost_header_line: Option<usize> = None;
    let mut skip_until: usize = 0;
    for (offset, line) in lines
        .iter()
        .enumerate()
        .take(span.end_line + 1)
        .skip(span.item_line + 1)
    {
        let line_no = offset;
        // 块标量体行：跳过（永不解析为字段）。
        if line_no <= skip_until {
            continue;
        }
        let content = line.content;
        let Some((key, value)) = parse_key_line(content) else {
            continue;
        };
        let indent = indent_of(content);
        // 块标量头：记体末行，后续体行跳过。
        if is_block_scalar_value(value) {
            skip_until = block_scalar_end(&lines, line_no, span.end_line, indent);
        }
        if let Some(cost_at) = cost_indent {
            if indent > cost_at {
                // cost 子键只收首个子缩进同列的行；更深嵌套/空值子头
                // 说明是分层价：整模型拒改（连非 cost 补丁也拒，保持可预测）。
                match cost_child_indent {
                    None => {
                        cost_child_indent = Some(indent);
                    }
                    Some(child) if indent != child => {
                        return Err(invalid(
                            "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml",
                        ));
                    }
                    _ => {}
                }
                if value.is_empty() || value.starts_with('!') || value.starts_with('{') {
                    return Err(invalid(
                        "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml",
                    ));
                }
                cost_rows.push(FieldRow {
                    line: line_no,
                    key,
                    head: false,
                });
                continue;
            }
            let header = cost_header_line.unwrap_or(line_no);
            cost_block = Some((header, line_no - 1));
            cost_indent = None;
            cost_child_indent = None;
            cost_header_line = None;
        }
        // 只收直接子字段；嵌套键视为不透明（防错行替换）。
        if indent != span.field_indent {
            continue;
        }
        if key == "cost" && (value.is_empty() || value.starts_with('&')) {
            // `cost:` 块头（含 `cost: &anchor` 锚）；行内值另行拒绝。
            cost_indent = Some(indent);
            cost_header_line = Some(line_no);
            continue;
        }
        rows.push(FieldRow {
            line: line_no,
            key,
            head: false,
        });
    }
    if let Some(header) = cost_header_line {
        cost_block = Some((header, span.end_line));
    }
    // cost 行内写法（`cost: {...}` / `cost: 1`）：不支持，提示手动改。
    // 锚头（`cost: &x`）是合法块头，不在此拒绝。
    for (line_no, line) in lines
        .iter()
        .enumerate()
        .take(span.end_line + 1)
        .skip(span.item_line + 1)
    {
        // 只看直接子 cost 头；嵌套 cost（如 compat 下）与本条目 cost 无关。
        if indent_of(line.content) != span.field_indent {
            continue;
        }
        if let Some((key, value)) = parse_key_line(line.content) {
            if key == "cost"
                && !value.is_empty()
                && !value.starts_with('&')
                && cost_header_line.is_none_or(|header| header != line_no)
            {
                return Err(manual_edit("该模型的 cost 不是块写法"));
            }
        }
    }
    if let Some((key, _)) = &span.head_key {
        if key == "cost" {
            return Err(manual_edit("该模型的 cost 不是块写法"));
        }
    }

    // 简单字段：(键, 新值)。有行则替换，无行则插入。
    let mut simple: Vec<(&str, String)> = Vec::new();
    if let Some(name) = &patch.name {
        simple.push(("name", quote_name(name)));
    }
    if let Some(window) = patch.context_window {
        simple.push(("contextWindow", window.to_string()));
    }
    if let Some(tokens) = patch.max_tokens {
        simple.push(("maxTokens", tokens.to_string()));
    }
    if let Some(reasoning) = patch.reasoning {
        simple.push(("reasoning", reasoning.to_string()));
    }
    if let Some(input) = &patch.input {
        simple.push(("input", format_input(input)));
    }

    // 新行数组（content 可变，换行保留）。
    let mut contents: Vec<String> = lines.iter().map(|line| line.content.to_owned()).collect();
    let newlines: Vec<&str> = lines.iter().map(|line| line.newline).collect();
    // 条目内同键重复（脏文件）→ 提示手动改。
    let mut seen_simple = std::collections::HashSet::new();
    for row in &rows {
        if ["name", "contextWindow", "maxTokens", "reasoning", "input"].contains(&row.key.as_str())
            && !seen_simple.insert(row.key.clone())
        {
            return Err(manual_edit(
                format!("该模型的 {} 出现多次", row.key).as_str(),
            ));
        }
    }
    let mut seen_cost = std::collections::HashSet::new();
    for row in &cost_rows {
        if ["input", "output", "cacheRead", "cacheWrite"].contains(&row.key.as_str())
            && !seen_cost.insert(row.key.clone())
        {
            return Err(manual_edit(
                format!("该模型的 cost.{} 出现多次", row.key).as_str(),
            ));
        }
    }

    // 替换简单字段：先判现有值形状。
    // 标量/流式 → 原地替换；块序列 input → 头改流式 + 删子行；
    // 块标量或其他非标量形 → 手动改（绝不悬空体）。
    let mut remove_lines: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut need_insert: Vec<(&str, String)> = Vec::new();
    for (key, value) in &simple {
        let mut found = None;
        for row in &rows {
            if &row.key == key {
                found = Some(row);
                break;
            }
        }
        if let Some(row) = found {
            if row.head {
                // 首行内联值必为单行标量/流式：原地替换。
                let dash = indent_of(&contents[row.line]);
                let colon = head_colon(&contents[row.line], dash)
                    .ok_or_else(|| manual_edit("该模型的条目首行无法识别"))?;
                contents[row.line] = replace_value(&contents[row.line].clone(), colon, value);
                continue;
            }
            let content = contents[row.line].clone();
            let (_, old_value) =
                parse_key_line(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
            if is_block_scalar_value(old_value) {
                return Err(manual_edit(format!("该模型的 {key} 是多行文本").as_str()));
            }
            if old_value.is_empty() {
                // 空值头：input 允许块序列（改头 + 删子行），其余键看后继形状。
                let header_indent = indent_of(&content);
                let children =
                    block_sequence_children(&lines, row.line, span.end_line, header_indent);
                if *key == "input" && !children.is_empty() {
                    let colon =
                        key_colon(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
                    contents[row.line] = replace_value(&content, colon, value);
                    remove_lines.extend(children);
                    continue;
                }
                if children.is_empty() {
                    // 空值且无块序列子行：后继若有更深缩进的键行，
                    // 说明是映射块头而非标量 → 手动改。
                    let mut scan = row.line + 1;
                    let limit = span.end_line.min(lines.len().saturating_sub(1));
                    let mut is_map = false;
                    while scan <= limit {
                        let next = lines[scan].content;
                        if next.trim().is_empty() {
                            scan += 1;
                            continue;
                        }
                        if indent_of(next) > header_indent && parse_key_line(next).is_some() {
                            is_map = true;
                        }
                        break;
                    }
                    if is_map {
                        return Err(manual_edit(format!("该模型的 {key} 不是单行写法").as_str()));
                    }
                    let colon =
                        key_colon(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
                    contents[row.line] = replace_value(&content, colon, value);
                    continue;
                }
                // 非 input 键挂着块序列子行 → 手动改。
                return Err(manual_edit(format!("该模型的 {key} 不是单行写法").as_str()));
            }
            let colon = key_colon(&content).ok_or_else(|| manual_edit("该模型的字段行无法识别"))?;
            contents[row.line] = replace_value(&content, colon, value);
        } else {
            need_insert.push((key, value.clone()));
        }
    }

    // cost 块。
    let mut need_cost_block = false;
    if let Some(cost) = &patch.cost {
        let pairs = [
            ("input", format_cost(cost.input)),
            ("output", format_cost(cost.output)),
            ("cacheRead", format_cost(cost.cache_read)),
            ("cacheWrite", format_cost(cost.cache_write)),
        ];
        if cost_block.is_some() {
            for (key, value) in &pairs {
                let mut found = None;
                for row in &cost_rows {
                    if &row.key == key {
                        found = Some(row);
                        break;
                    }
                }
                if let Some(row) = found {
                    let colon = key_colon(&contents[row.line])
                        .ok_or_else(|| manual_edit("该模型的 cost 行无法识别"))?;
                    contents[row.line] = replace_value(&contents[row.line].clone(), colon, value);
                } else {
                    // cost 块缺子键：omp fail-closed 要求四键齐全，
                    // 缺键说明文件已坏，不猜位置，提示手动修。
                    return Err(manual_edit("该模型的 cost 缺少子键"));
                }
            }
        } else {
            need_cost_block = true;
            // 插入完整四键块时，把 pairs 暂存到 need_insert 之后处理。
            for (key, value) in pairs {
                need_insert.push((
                    match key {
                        "input" => "cost.input",
                        "output" => "cost.output",
                        "cacheRead" => "cost.cacheRead",
                        _ => "cost.cacheWrite",
                    },
                    value,
                ));
            }
        }
    }

    // 插入缺失字段：紧随 `- ` 行之后（id 优先——id 行永存，
    // 故新字段插在首行之后即位于条目前部，不干扰锚点）。
    if !need_insert.is_empty() {
        let field_indent = " ".repeat(span.field_indent);
        let insert_at = span.item_line + 1;
        let mut insert_lines: Vec<String> = Vec::new();
        let mut cost_lines: Vec<(String, String)> = Vec::new();
        for (key, value) in &need_insert {
            if let Some(sub) = key.strip_prefix("cost.") {
                cost_lines.push((sub.to_owned(), value.clone()));
            } else {
                insert_lines.push(format!("{field_indent}{key}: {value}"));
            }
        }
        if need_cost_block {
            // cost 块缩进与普通字段同级，子键再深两格。
            insert_lines.push(format!("{field_indent}cost:"));
            let child = " ".repeat(span.field_indent + 2);
            for (sub, value) in &cost_lines {
                insert_lines.push(format!("{child}{sub}: {value}"));
            }
        }
        // 插入行的换行符沿用 `- ` 行的换行（无换行则用 `\n`）。
        let newline = if newlines[span.item_line].is_empty() {
            "\n"
        } else {
            newlines[span.item_line]
        };
        let mut new_contents: Vec<String> = Vec::with_capacity(contents.len() + insert_lines.len());
        let mut new_newlines: Vec<&str> = Vec::with_capacity(newlines.len() + insert_lines.len());
        // 若插入点前一行原文无换行（EOF 无尾换行），先给它补上换行，
        // 否则插入行会与横线行连成一行。
        let mut fixed_newlines: Vec<&str> = newlines.clone();
        if insert_at > 0 && fixed_newlines[insert_at - 1].is_empty() {
            fixed_newlines[insert_at - 1] = newline;
        }
        for (index, content) in contents.iter().enumerate() {
            if index == insert_at {
                for line in &insert_lines {
                    new_contents.push(line.clone());
                    new_newlines.push(newline);
                }
            }
            new_contents.push(content.clone());
            new_newlines.push(fixed_newlines[index]);
        }
        if insert_at >= contents.len() {
            for line in &insert_lines {
                new_contents.push(line.clone());
                new_newlines.push(newline);
            }
        }
        let mut out = String::with_capacity(text.len() + insert_lines.join("\n").len() + 32);
        for (content, newline) in new_contents.iter().zip(new_newlines.iter()) {
            out.push_str(content);
            out.push_str(newline);
        }
        return Ok(out);
    }

    let mut out = String::with_capacity(text.len() + 64);
    for (index, (content, newline)) in contents.iter().zip(newlines.iter()).enumerate() {
        // 块序列 input 子行随头一并删除。
        if remove_lines.contains(&index) {
            continue;
        }
        out.push_str(content);
        out.push_str(newline);
    }
    Ok(out)
}
