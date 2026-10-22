//! 模型测速/稳定性探测（CONTRACT §20）：两次 `omp bench` 探针合成一轮，
//! 历史 JSONL 追加/裁剪，以及 omp 日常实测 `model_perf` 的只读聚合。
//!
//! SECURITY：
//! - `selector` 先校验（首字符字母数字、无空白、含 `/`、≤200 字符），不经 shell，
//!   整串作为一个 argv 传给 omp；
//! - bench 的原始输出和错误全文都不写日志；
//! - `model_perf_list` 只用 `SQLITE_OPEN_READ_ONLY` 打开 agent.db，只发一条写死的
//!   SELECT，不碰库里其他表（库里有凭据表）。

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Deserializer, Value};

use crate::memory::open_readonly;
use crate::meta;
use crate::model::{AppError, BenchRound, ErrorCode, ModelPerf};
use crate::omp_cli::{omp_not_found, output_tail, resolve_omp, run_omp};

/// 单次探针超时（6 分钟；超时错误文本见 `TIMEOUT_ERROR`）。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(6 * 60);
/// `agent.db` 路径覆盖（测试/开发用），默认 `$HOME/.omp/agent/agent.db`。
pub const AGENT_DB_ENV: &str = "OMP_RESUME_AGENT_DB";

/// 短探针：chat 画像 × 5 次 × 100 token；长探针：generation 画像 × 3 次 × 600 token。
const SHORT_PROFILE: &str = "chat";
const SHORT_RUNS: usize = 5;
const SHORT_MAX_TOKENS: u32 = 100;
const LONG_PROFILE: &str = "generation";
const LONG_RUNS: usize = 3;
const LONG_MAX_TOKENS: u32 = 600;
/// 探针超时的错误文本（字面量按 CONTRACT §20.1 写死）。
const TIMEOUT_ERROR: &str = "超时（6 分钟）";
/// 错误文本缺失的失败请求的占位文本。
const UNKNOWN_ERROR: &str = "未知错误";
/// 历史文件（与 `meta.json` 同目录，`OMP_RESUME_DATA_DIR` 可覆盖）。
const BENCH_FILE: &str = "model-bench.jsonl";
/// 历史保留窗口（天）。
const HISTORY_DAYS: i64 = 30;
/// 错误文本上限：每条字符数 / 总条数。
const ERROR_MAX_CHARS: usize = 200;
const ERROR_MAX_COUNT: usize = 5;

/// 进程内互斥：保护历史 JSONL 的追加与裁剪重写。多个模型可并发调命令，
/// 真正的写盘在此串行（读-改-写全程持锁）。
static BENCH_LOCK: Mutex<()> = Mutex::new(());

/// `selector` 校验：`provider/model[:thinking]`，≤200 字符，首字符字母或数字
/// （防参数注入），无空白，必须含 `/`。失败 ⇒ `INVALID_INPUT`（此时不调用 omp）。
pub fn validate_selector(selector: &str) -> Result<(), AppError> {
    let bad =
        |why: &str| AppError::new(ErrorCode::InvalidInput, format!("模型选择器不合法：{why}"));
    if selector.chars().count() > 200 {
        return Err(bad("长度不能超过 200 个字符"));
    }
    if !selector.chars().next().is_some_and(|c| c.is_alphanumeric()) {
        return Err(bad("首字符必须是字母或数字"));
    }
    if selector.chars().any(char::is_whitespace) {
        return Err(bad("不能包含空白字符"));
    }
    if !selector.contains('/') {
        return Err(bad("必须是 provider/model[:thinking] 形式"));
    }
    Ok(())
}

/// bench 输出 `models[0].results[]` 的单条结果（字段缺失按最保守语义兜底）。
#[derive(Debug, Deserialize)]
struct BenchResultJson {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "ttftMs")]
    ttft_ms: Option<f64>,
    #[serde(default, rename = "generationTps")]
    generation_tps: Option<f64>,
    #[serde(default)]
    cost: Option<f64>,
}

/// 归一化后的单次请求样本。
#[derive(Debug, Clone)]
struct Sample {
    ok: bool,
    error: Option<String>,
    ttft_ms: Option<f64>,
    tps: Option<f64>,
    cost: f64,
}

/// 从合并输出解析探针结果：不看退出码（有失败时 bench 返回 1 但照样有 JSON），
/// 从第一个以 `{` 开头的行开始流式解析第一个 JSON 值，取 `models[0].results[]`。
fn parse_probe_output(output: &str) -> Result<Vec<Sample>, String> {
    let json = json_start(output).ok_or_else(|| "输出中没有找到 JSON".to_string())?;
    let mut stream = Deserializer::from_str(json).into_iter::<Value>();
    let value = stream
        .next()
        .ok_or_else(|| "输出中没有找到 JSON".to_string())?
        .map_err(|e| format!("无法解析 bench 输出：{e}"))?;
    let results = value
        .get("models")
        .and_then(|models| models.get(0))
        .and_then(|model| model.get("results"))
        .and_then(Value::as_array)
        .ok_or_else(|| "bench 输出缺少 models[0].results".to_string())?;
    results
        .iter()
        .map(|result| {
            let parsed: BenchResultJson = serde_json::from_value(result.clone())
                .map_err(|e| format!("无法解析 bench 结果：{e}"))?;
            Ok(Sample {
                ok: parsed.ok,
                error: parsed.error,
                ttft_ms: parsed.ttft_ms,
                tps: parsed.generation_tps,
                cost: parsed.cost.unwrap_or(0.0),
            })
        })
        .collect()
}

/// 合并输出中第一个以 `{` 开头的行及之后全部内容；没有 ⇒ `None`。
fn json_start(output: &str) -> Option<&str> {
    let mut index = 0;
    for segment in output.split_inclusive('\n') {
        if segment.starts_with('{') {
            return Some(&output[index..]);
        }
        index += segment.len();
    }
    None
}

/// 跑一次探针。超时 ⇒ 按计划请求数全部记失败（错误文本写死）；其他错误原样返回。
fn run_probe(
    bin: &Path,
    selector: &str,
    profile: &str,
    planned_runs: usize,
    max_tokens: u32,
    timeout: Duration,
) -> Result<Vec<Sample>, AppError> {
    let runs = planned_runs.to_string();
    let max_tokens = max_tokens.to_string();
    let args = [
        "bench",
        selector,
        "--json",
        "--par",
        "1",
        "--profile",
        profile,
        "--runs",
        runs.as_str(),
        "--max-tokens",
        max_tokens.as_str(),
    ];
    match run_omp(bin, &args, timeout, &mut |_| {}) {
        Ok(done) => parse_probe_output(&done.output).map_err(|_| {
            AppError::new(
                ErrorCode::OmpFailed,
                format!("无法解析 omp bench 输出：{}", output_tail(&done.output)),
            )
        }),
        Err(error) if error.code == ErrorCode::Timeout => Ok(vec![
            Sample {
                ok: false,
                error: Some(TIMEOUT_ERROR.to_string()),
                ttft_ms: None,
                tps: None,
                cost: 0.0,
            };
            planned_runs
        ]),
        Err(error) => Err(error),
    }
}

/// 两次探针的全部请求合成一轮：分位数用最近秩法，CV 用总体标准差/均值。
/// 其中 `tps` 只取长探针（generation 画像，token 多，速度稳定）的成功样本；
/// 长探针没有带 generationTps 的成功样本时才回退到短探针。
fn aggregate(at: &str, selector: &str, short: &[Sample], long: &[Sample]) -> BenchRound {
    let both: Vec<&Sample> = short.iter().chain(long.iter()).collect();
    let mut ttfts: Vec<f64> = both
        .iter()
        .filter(|s| s.ok)
        .filter_map(|s| s.ttft_ms)
        .collect();
    let mut tps: Vec<f64> = ok_tps(long);
    if tps.is_empty() {
        tps = ok_tps(short);
    }
    ttfts.sort_by(f64::total_cmp);
    tps.sort_by(f64::total_cmp);
    BenchRound {
        at: at.to_string(),
        selector: selector.to_string(),
        total: both.len() as u64,
        ok: both.iter().filter(|s| s.ok).count() as u64,
        ttft_p50_ms: percentile(&ttfts, 50.0),
        ttft_p95_ms: percentile(&ttfts, 95.0),
        tps_p50: percentile(&tps, 50.0),
        tps_cv: variation(&tps),
        // fold 从 +0.0 起：f64 的 sum() 空迭代返回 -0.0，会序列化成 "-0.0"。
        cost: both
            .iter()
            .filter(|s| s.ok)
            .fold(0.0, |acc, s| acc + s.cost),
        errors: collect_errors_iter(both),
    }
}

/// 某次探针的成功样本的 generationTps。
fn ok_tps(samples: &[Sample]) -> Vec<f64> {
    samples
        .iter()
        .filter(|s| s.ok)
        .filter_map(|s| s.tps)
        .collect()
}

/// 最近秩法分位数：`rank = ceil(p/100·n)`（1 起）；无样本 ⇒ `None`。
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    let n = sorted.len();
    if n == 0 {
        return None;
    }
    let rank = ((p / 100.0 * n as f64).ceil() as usize).clamp(1, n);
    Some(sorted[rank - 1])
}

/// 变异系数 = 总体标准差 / 均值；样本少于 2 或均值非正 ⇒ `None`。
fn variation(sorted: &[f64]) -> Option<f64> {
    if sorted.len() < 2 {
        return None;
    }
    let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
    if mean <= 0.0 {
        return None;
    }
    let variance = sorted.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / sorted.len() as f64;
    Some(variance.sqrt() / mean)
}

/// 失败请求的错误文本：去重（保序），每条截到 200 字符，最多 5 条。
fn collect_errors_iter<'a>(samples: impl IntoIterator<Item = &'a Sample>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for sample in samples.into_iter().filter(|s| !s.ok) {
        let text = sample.error.as_deref().unwrap_or("").trim();
        let text = if text.is_empty() { UNKNOWN_ERROR } else { text };
        let text: String = text.chars().take(ERROR_MAX_CHARS).collect();
        if seen.insert(text.clone()) {
            out.push(text);
        }
        if out.len() >= ERROR_MAX_COUNT {
            break;
        }
    }
    out
}

fn bench_path(data_dir: &Path) -> PathBuf {
    data_dir.join(BENCH_FILE)
}

/// 追加一轮到历史文件（调用方持 `BENCH_LOCK`）。失败 ⇒ `IO`。
fn append_round(data_dir: &Path, round: &BenchRound) -> Result<(), AppError> {
    let mut line = serde_json::to_string(round)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法序列化探测结果：{e}")))?;
    line.push('\n');
    fs::create_dir_all(data_dir)
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法创建数据目录：{e}")))?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(bench_path(data_dir))
        .and_then(|mut file| file.write_all(line.as_bytes()))
        .map_err(|e| AppError::new(ErrorCode::Io, format!("无法写入探测历史：{e}")))
}

/// 先后跑短/长两次探针并记一轮。单次探针超时只记失败、另一次照常跑；
/// 解析失败 / `IO` 直接返回且不写历史。
pub fn model_bench_run_impl(
    bin: &Path,
    data_dir: &Path,
    selector: &str,
    timeout: Duration,
) -> Result<BenchRound, AppError> {
    validate_selector(selector)?;
    // `at` 取本轮开始时间（两次探针之前）。
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let short = run_probe(
        bin,
        selector,
        SHORT_PROFILE,
        SHORT_RUNS,
        SHORT_MAX_TOKENS,
        timeout,
    )?;
    let long = run_probe(
        bin,
        selector,
        LONG_PROFILE,
        LONG_RUNS,
        LONG_MAX_TOKENS,
        timeout,
    )?;
    let round = aggregate(&at, selector, &short, &long);
    let _guard = BENCH_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    append_round(data_dir, &round)?;
    Ok(round)
}

/// 读历史：只保留最近 30 天，按 `at` 从早到晚；文件不存在 ⇒ `[]`，坏行静默跳过；
/// 有裁剪或坏行时原子重写（失败静默）。
pub fn model_bench_history_impl(data_dir: &Path) -> Vec<BenchRound> {
    let _guard = BENCH_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = bench_path(data_dir);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Vec::new(),
    };
    let now = Utc::now();
    let mut kept: Vec<(DateTime<Utc>, BenchRound)> = Vec::new();
    let mut dirty = false;
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Ok(round) = serde_json::from_str::<BenchRound>(line) else {
            dirty = true;
            continue;
        };
        let Ok(at) = DateTime::parse_from_rfc3339(&round.at) else {
            dirty = true;
            continue;
        };
        let at = at.with_timezone(&Utc);
        if now.signed_duration_since(at) > chrono::Duration::days(HISTORY_DAYS) {
            dirty = true;
            continue;
        }
        kept.push((at, round));
    }
    kept.sort_by_key(|a| a.0);
    if dirty {
        rewrite_history(&path, &kept);
    }
    kept.into_iter().map(|(_, round)| round).collect()
}

/// 原子重写历史文件（同目录临时文件 + rename）；任何失败都静默忽略。
/// 调用方持 `BENCH_LOCK`（进程内串行），临时路径单 pid 一份即可。
fn rewrite_history(path: &Path, kept: &[(DateTime<Utc>, BenchRound)]) {
    let Some(parent) = path.parent() else {
        return;
    };
    let mut text = String::new();
    for (_, round) in kept {
        let Ok(mut line) = serde_json::to_string(round) else {
            return;
        };
        line.push('\n');
        text.push_str(&line);
    }
    let tmp = parent.join(format!(".{BENCH_FILE}.{}.tmp", std::process::id()));
    if fs::write(&tmp, text.as_bytes()).is_err() || fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// 解析 agent.db 路径：`OMP_RESUME_AGENT_DB` > `$HOME/.omp/agent/agent.db`。
pub fn resolve_agent_db_path() -> PathBuf {
    if let Some(p) = std::env::var_os(AGENT_DB_ENV) {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".omp/agent/agent.db")
}

/// omp 日常实测统计（只读；任何失败 ⇒ `[]`，静默）。SQL 写死成一条，
/// 只读 `model_perf`，不碰库里其他表。
pub fn model_perf_list_impl(db: &Path) -> Vec<ModelPerf> {
    let Some(conn) = open_readonly(db) else {
        return Vec::new();
    };
    let mut stmt = match conn.prepare(
        "SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at FROM model_perf",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<f64>>(1)?,
            row.get::<_, Option<f64>>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, Option<f64>>(4)?,
            row.get::<_, Option<f64>>(5)?,
            row.get::<_, Option<i64>>(6)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for row in rows.filter_map(Result::ok) {
        let (key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms, updated_at) = row;
        // 主键/样本数/时间戳缺失或时间戳越界的行直接跳过（不影响其他行）。
        let (Some(selector), Some(samples), Some(updated_at)) = (key, samples, updated_at) else {
            continue;
        };
        let Some(updated_at) = DateTime::<Utc>::from_timestamp(updated_at, 0)
            .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
        else {
            continue;
        };
        let ttft_ms = match (ttft_ms, ttft_samples) {
            (Some(ms), Some(n)) if n > 0.0 => Some(ms / n),
            _ => None,
        };
        let tps = match (output_tokens, gen_ms) {
            (Some(tokens), Some(ms)) if ms > 0.0 => Some(tokens / (ms / 1000.0)),
            _ => None,
        };
        out.push(ModelPerf {
            selector,
            samples: samples.round() as i64,
            ttft_ms,
            tps,
            updated_at,
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.samples));
    out
}

// ---------------------------------------------------------------------------
// Tauri 命令（阻塞操作在后台线程；不占 `OmpBusy`，只读探测不能卡住配置保存）
// ---------------------------------------------------------------------------

/// CONTRACT §20.1/§4.51：跑两次 `omp bench` 探针并记一轮。
#[tauri::command]
pub async fn model_bench_run(selector: String) -> Result<BenchRound, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        let data_dir = meta::data_dir()?;
        model_bench_run_impl(&bin, &data_dir, &selector, PROBE_TIMEOUT)
    })
    .await
    .map_err(crate::io_join_error)?
}

/// CONTRACT §20.2/§4.52：最近 30 天的探测历史（按 `at` 从早到晚）。
#[tauri::command]
pub async fn model_bench_history() -> Result<Vec<BenchRound>, AppError> {
    tauri::async_runtime::spawn_blocking(|| {
        let data_dir = meta::data_dir()?;
        Ok(model_bench_history_impl(&data_dir))
    })
    .await
    .map_err(crate::io_join_error)?
}

/// CONTRACT §20.3/§4.53：omp 日常实测统计（只读；失败静默为空列表）。
#[tauri::command]
pub async fn model_perf_list() -> Result<Vec<ModelPerf>, AppError> {
    tauri::async_runtime::spawn_blocking(|| Ok(model_perf_list_impl(&resolve_agent_db_path())))
        .await
        .map_err(crate::io_join_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::os::unix::fs::PermissionsExt;

    fn fake(body: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (dir, bin)
    }

    /// 短探针输出：噪声行 + 5 条混合结果（含真实失败形状与缺失 cost）。
    const SHORT_OUTPUT: &str = "omp bench acme/widget\nprofile chat: warming up\n{\"models\":[{\"results\":[{\"ok\":true,\"ttftMs\":100.0,\"generationTps\":40.0,\"cost\":0.001,\"challenge\":\"chat\"},{\"ok\":true,\"ttftMs\":200.0,\"generationTps\":50.0,\"challenge\":\"chat\"},{\"ok\":true,\"ttftMs\":300.0,\"generationTps\":60.0,\"cost\":0.003,\"challenge\":\"chat\"},{\"ok\":false,\"error\":\"403 Forbidden: key revoked\",\"challenge\":\"chat\"},{\"ok\":false,\"error\":\"429 rate limit, retry later\",\"challenge\":\"chat\"}]}]}";
    /// 长探针输出：3 条结果，403 错误与短探针重复（聚合时去重）。
    const LONG_OUTPUT: &str = "{\"models\":[{\"results\":[{\"ok\":true,\"ttftMs\":400.0,\"generationTps\":70.0,\"cost\":0.01,\"challenge\":\"generation\"},{\"ok\":true,\"ttftMs\":500.0,\"generationTps\":80.0,\"cost\":0.02,\"challenge\":\"generation\"},{\"ok\":false,\"error\":\"403 Forbidden: key revoked\",\"challenge\":\"generation\"}]}]}";

    #[test]
    fn parses_noisy_output_and_aggregates_round() {
        let short = parse_probe_output(SHORT_OUTPUT).unwrap();
        assert_eq!(short.len(), 5);
        let long = parse_probe_output(LONG_OUTPUT).unwrap();
        assert_eq!(long.len(), 3);
        let round = aggregate("2026-10-21T02:00:00.000Z", "acme/widget", &short, &long);
        assert_eq!(round.at, "2026-10-21T02:00:00.000Z");
        assert_eq!(round.selector, "acme/widget");
        assert_eq!((round.total, round.ok), (8, 5));
        // ttft 取两次探针 [100,200,300,400,500]：p50 取第 3 个，p95 取第 5 个（最近秩法）。
        assert_eq!(round.ttft_p50_ms, Some(300.0));
        assert_eq!(round.ttft_p95_ms, Some(500.0));
        // tps 只取长探针 [70,80]：p50 取第 1 个；均值 75，总体方差 25。
        assert_eq!(round.tps_p50, Some(70.0));
        let cv = round.tps_cv.unwrap();
        assert!((cv - 0.066_666_666_666_666_67).abs() < 1e-12, "cv={cv}");
        // 缺失 cost 按 0：0.001 + 0 + 0.003 + 0.01 + 0.02。
        assert!((round.cost - 0.034).abs() < 1e-12, "cost={}", round.cost);
        assert_eq!(
            round.errors,
            ["403 Forbidden: key revoked", "429 rate limit, retry later"]
        );
    }

    #[test]
    fn tps_falls_back_to_short_probe_without_long_tps() {
        let short = parse_probe_output(SHORT_OUTPUT).unwrap();
        let failed = |n: usize| {
            vec![
                Sample {
                    ok: false,
                    error: Some("boom".into()),
                    ttft_ms: None,
                    tps: None,
                    cost: 0.0,
                };
                n
            ]
        };
        // 长探针全失败 → 回退到短探针 tps [40,50,60]，p50 取第 2 个。
        let round = aggregate("t", "s", &short, &failed(3));
        assert_eq!(round.tps_p50, Some(50.0));
        assert!(round.tps_cv.is_some());
        // 长探针成功但缺 generationTps → 同样回退。
        let no_tps = vec![
            Sample {
                ok: true,
                error: None,
                ttft_ms: Some(400.0),
                tps: None,
                cost: 0.0,
            };
            2
        ];
        let round = aggregate("t", "s", &short, &no_tps);
        assert_eq!(round.tps_p50, Some(50.0));
        // 两边都没有 tps → null。
        let round = aggregate("t", "s", &failed(5), &failed(3));
        assert!(round.tps_p50.is_none() && round.tps_cv.is_none());
    }

    #[test]
    fn unparseable_probe_output_is_omp_failed_without_history() {
        let _processes = crate::omp_cli::subprocess_test_guard();
        assert!(parse_probe_output("no json here\nstill none\n").is_err());
        assert!(parse_probe_output("{\"models\": [oops").is_err());
        assert!(parse_probe_output("{\"models\":[]}").is_err());
        // 端到端：假 omp 输出垃圾 → OMP_FAILED，且不写历史文件。
        let (dir, bin) = fake("printf 'bench failed badly\\n'; exit 1");
        let data_dir = dir.path().join("data");
        let error = model_bench_run_impl(&bin, &data_dir, "acme/widget", Duration::from_secs(10))
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::OmpFailed);
        assert!(!data_dir.join(BENCH_FILE).exists());
    }

    #[test]
    fn selector_validation_rejects_injection_and_shape_errors() {
        for ok in [
            "acme/widget",
            "a/b:c1",
            "1a/b2",
            &format!("{}/b", "a".repeat(198)),
        ] {
            validate_selector(ok).unwrap();
        }
        for bad in [
            "",
            "-x/y",
            "/lead",
            "noslash",
            "a/b c",
            "a/b\t",
            &format!("{}/b", "a".repeat(200)),
        ] {
            let error = validate_selector(bad).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidInput, "selector {bad:?}");
        }
        // 非法 selector 在 omp 调用之前被拒绝（bin 不存在也不影响错误码）。
        let dir = tempfile::tempdir().unwrap();
        let error = model_bench_run_impl(
            &dir.path().join("no-such-omp"),
            dir.path(),
            "-x/y",
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
    }

    #[test]
    fn error_collection_dedups_truncates_and_caps() {
        let long = "e".repeat(250);
        let sample = |ok: bool, error: Option<String>| Sample {
            ok,
            error,
            ttft_ms: None,
            tps: None,
            cost: 0.0,
        };
        let samples = vec![
            sample(true, Some("成功请求的错误被忽略".into())),
            sample(false, Some(long.clone())),
            sample(false, Some("b".into())),
            sample(false, Some(long.clone())),
            sample(false, Some("  ".into())),
            sample(false, None),
            sample(false, Some("c".into())),
            sample(false, Some("d".into())),
            sample(false, Some("e".into())),
            sample(false, Some("f".into())),
        ];
        let errors = collect_errors_iter(&samples);
        assert_eq!(errors.len(), 5);
        assert_eq!(errors[0].chars().count(), 200);
        assert!(errors[0].chars().all(|c| c == 'e'));
        // 空白/缺失错误文本合并为一条占位。
        assert_eq!(errors[1..], ["b", "未知错误", "c", "d"]);
    }

    #[test]
    fn history_filters_window_sorts_and_rewrites() {
        let dir = tempfile::tempdir().unwrap();
        let now = Utc::now();
        let line = |at: &str, ok: u64| {
            serde_json::to_string(&BenchRound {
                at: at.to_string(),
                selector: "acme/widget".into(),
                total: 7,
                ok,
                ttft_p50_ms: None,
                ttft_p95_ms: None,
                tps_p50: None,
                tps_cv: None,
                cost: 0.0,
                errors: Vec::new(),
            })
            .unwrap()
        };
        let old = (now - chrono::Duration::days(31)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let recent_new =
            (now - chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let recent_old =
            (now - chrono::Duration::days(29)).to_rfc3339_opts(SecondsFormat::Millis, true);
        // 乱序 + 坏行 + 过期行。
        let content = format!(
            "{}\n{{bad line}}\n{}\n{}\n",
            line(&recent_new, 7),
            line(&old, 0),
            line(&recent_old, 5)
        );
        fs::write(dir.path().join(BENCH_FILE), content).unwrap();
        let history = model_bench_history_impl(dir.path());
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].at, recent_old);
        assert_eq!(history[1].at, recent_new);
        // 已原子重写：只剩两行有效记录。
        let rewritten = fs::read_to_string(dir.path().join(BENCH_FILE)).unwrap();
        assert_eq!(rewritten.lines().count(), 2);
        assert!(!rewritten.contains("bad line") && !rewritten.contains(&old));
        // 文件不存在 → []。
        assert!(model_bench_history_impl(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn model_perf_maps_sorts_and_degrades_silently() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("agent.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE model_perf (model_key TEXT, samples REAL, output_tokens REAL, gen_ms REAL, ttft_samples REAL, ttft_ms REAL, updated_at INTEGER);
                 INSERT INTO model_perf VALUES ('b/model', 10.4, 1000.0, 2000.0, 3.0, 300.0, 1700000000);
                 INSERT INTO model_perf VALUES ('a/model', 20.0, 500.0, 0.0, 0.0, 50.0, 1700000000);
                 INSERT INTO model_perf VALUES ('c/model', NULL, 10.0, 10.0, 1.0, 1.0, 1700000000);",
            )
            .unwrap();
        }
        let before = fs::metadata(&db_path).unwrap();
        let list = model_perf_list_impl(&db_path);
        let after = fs::metadata(&db_path).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        // NULL 样本行被跳过；按 samples 从大到小。
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].selector, "a/model");
        assert_eq!(list[0].samples, 20);
        assert_eq!(list[0].tps, None);
        assert_eq!(list[0].ttft_ms, None);
        assert_eq!(list[1].selector, "b/model");
        assert_eq!(list[1].samples, 10);
        assert_eq!(list[1].tps, Some(500.0));
        assert_eq!(list[1].ttft_ms, Some(100.0));
        assert_eq!(list[1].updated_at, "2023-11-14T22:13:20.000Z");
        // 库不存在 / 表结构不对 → []。
        assert!(model_perf_list_impl(&dir.path().join("missing.db")).is_empty());
        let bad_path = dir.path().join("bad.db");
        Connection::open(&bad_path)
            .unwrap()
            .execute_batch("CREATE TABLE wrong_shape (x TEXT);")
            .unwrap();
        assert!(model_perf_list_impl(&bad_path).is_empty());
    }

    #[test]
    fn bench_run_invokes_two_probes_and_appends_history() {
        let _processes = crate::omp_cli::subprocess_test_guard();
        let (dir, bin) = fake(
            "printf '%s\\n' \"$@\" >> \"$0.argv\"\n\
             case \"$*\" in\n\
             *generation*) printf 'warmup log\\n{\"models\":[{\"results\":[{\"ok\":true,\"ttftMs\":400,\"generationTps\":70,\"cost\":0.01,\"challenge\":\"generation\"},{\"ok\":false,\"error\":\"boom\",\"challenge\":\"generation\"}]}]}\\n'; exit 1;;\n\
             *) printf '{\"models\":[{\"results\":[{\"ok\":true,\"ttftMs\":100,\"generationTps\":40,\"challenge\":\"chat\"},{\"ok\":false,\"error\":\"403 Forbidden\",\"challenge\":\"chat\"}]}]}\\n';;\n\
             esac",
        );
        let data_dir = dir.path().join("data");
        let round =
            model_bench_run_impl(&bin, &data_dir, "acme/widget", Duration::from_secs(30)).unwrap();
        // argv：两次调用，先 chat 后 generation，`--par 1` 必带，selector 整串一个参数。
        let argv: Vec<String> = fs::read_to_string(dir.path().join("omp.argv"))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            argv,
            [
                "bench",
                "acme/widget",
                "--json",
                "--par",
                "1",
                "--profile",
                "chat",
                "--runs",
                "5",
                "--max-tokens",
                "100",
                "bench",
                "acme/widget",
                "--json",
                "--par",
                "1",
                "--profile",
                "generation",
                "--runs",
                "3",
                "--max-tokens",
                "600",
            ]
        );
        // 退出码 1 被忽略，长探针结果照样计入。
        assert_eq!((round.total, round.ok), (4, 2));
        assert_eq!(round.ttft_p50_ms, Some(100.0));
        assert_eq!(round.ttft_p95_ms, Some(400.0));
        // tps 只取长探针 [70]：单个样本，CV 为 null。
        assert_eq!(round.tps_p50, Some(70.0));
        assert!(round.tps_cv.is_none());
        assert!((round.cost - 0.01).abs() < 1e-12);
        assert_eq!(round.errors, ["403 Forbidden", "boom"]);
        // 历史追加了一行，且与返回值一致。
        let lines: Vec<String> = fs::read_to_string(data_dir.join(BENCH_FILE))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(lines.len(), 1);
        let stored: BenchRound = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(stored.at, round.at);
        assert_eq!(stored.selector, "acme/widget");
        assert_eq!((stored.total, stored.ok), (4, 2));
    }

    #[test]
    fn bench_run_timeout_counts_planned_runs_failed() {
        let _processes = crate::omp_cli::subprocess_test_guard();
        let (dir, bin) = fake("sleep 30");
        let data_dir = dir.path().join("data");
        let round =
            model_bench_run_impl(&bin, &data_dir, "acme/widget", Duration::from_millis(300))
                .unwrap();
        assert_eq!((round.total, round.ok), (8, 0));
        assert_eq!(round.errors, [TIMEOUT_ERROR]);
        assert!(round.ttft_p50_ms.is_none() && round.ttft_p95_ms.is_none());
        assert!(round.tps_p50.is_none() && round.tps_cv.is_none());
        assert_eq!(round.cost, 0.0);
        // 两次探针都超时仍然记一轮。
        assert_eq!(
            fs::read_to_string(data_dir.join(BENCH_FILE))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }

    /// 真实 `agent.db` 只读冒烟（`cargo test -- --ignored bench_smoke_real_agent_db`）：
    /// 只打印条数和首个 selector；调用前后用 `stat` 核对 db/-wal/-shm 的大小与 mtime。
    #[test]
    #[ignore]
    fn bench_smoke_real_agent_db() {
        let rows = model_perf_list_impl(&resolve_agent_db_path());
        println!(
            "model_perf: {} rows, first: {}",
            rows.len(),
            rows.first()
                .map(|row| row.selector.as_str())
                .unwrap_or("<none>")
        );
    }
}
