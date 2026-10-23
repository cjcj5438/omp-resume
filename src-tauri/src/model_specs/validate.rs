use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model::{AppError, ErrorCode, ModelSpecPatch};
use crate::omp_cli::{run_omp_with, RunOpts, CHECK_TIMEOUT};

use super::io::{MODELS_YML_NAME, PI_AGENT_DIR_ENV};
use super::yaml::format_cost;
use super::{invalid, io_error};

/// input 校验。补丁值校验（正数/有限数/格式 input）；错误绝不回显文件内容。
pub(super) fn validate_patch(patch: &ModelSpecPatch) -> Result<(), AppError> {
    // omp/JSON 数字经 f64：超 2^53 精度丢失，写前直接拒。
    const MAX_SAFE_INT: u64 = (1 << 53) - 1;
    if let Some(name) = &patch.name {
        if name.trim().is_empty() {
            return Err(invalid("模型名称不能为空"));
        }
        if name.chars().count() > 200 {
            return Err(invalid("模型名称过长（最多 200 个字符）"));
        }
        if name.contains(['\n', '\r']) {
            return Err(invalid("模型名称不能换行"));
        }
        // 控制字符（含 NUL/制表符）与 YAML 换行符一律拒（写进引号也危险）。
        if name
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}' | '\u{0085}'))
        {
            return Err(invalid("模型名称包含非法字符"));
        }
    }
    if let Some(window) = patch.context_window {
        if window == 0 {
            return Err(invalid("上下文窗口必须大于 0"));
        }
        if window > MAX_SAFE_INT {
            return Err(invalid("上下文窗口过大（最多 2^53-1）"));
        }
    }
    if let Some(tokens) = patch.max_tokens {
        if tokens == 0 {
            return Err(invalid("最大输出必须大于 0"));
        }
        if tokens > MAX_SAFE_INT {
            return Err(invalid("最大输出过大（最多 2^53-1）"));
        }
    }
    if let Some(input) = &patch.input {
        if input.is_empty() {
            return Err(invalid("输入类型不能为空"));
        }
        if input.len() > 8 {
            return Err(invalid("输入类型过多（最多 8 个）"));
        }
        let mut seen = std::collections::HashSet::new();
        for item in input {
            if item.trim().is_empty() {
                return Err(invalid("输入类型不能含空项"));
            }
            if item.len() > 32
                || !item
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err(invalid(format!("不支持的输入类型：{item}")));
            }
            if !seen.insert(item) {
                return Err(invalid("输入类型不能重复"));
            }
        }
    }
    if let Some(cost) = &patch.cost {
        for (label, value) in [
            ("输入价格", cost.input),
            ("输出价格", cost.output),
            ("缓存读取价格", cost.cache_read),
            ("缓存写入价格", cost.cache_write),
        ] {
            if !value.is_finite() || value < 0.0 || value > 1e9 {
                return Err(invalid(format!("{label}必须是非负有限数")));
            }
            // 非零值若格式化成 "0"（精度 < 1e-6），写后沙箱必 mismatch：提前拒。
            if value != 0.0 && format_cost(value) == "0" {
                return Err(invalid(format!("{label}过小，精度不足")));
            }
        }
    }
    Ok(())
}

/// 校验 provider/id 定位键（非空、无换行、无 `/` 歧义）。
pub(super) fn validate_target(provider: &str, id: &str) -> Result<(), AppError> {
    for (label, value) in [("provider", provider), ("模型 id", id)] {
        if value.trim().is_empty() {
            return Err(invalid(format!("{label}不能为空")));
        }
        if value.chars().count() > 200 {
            return Err(invalid(format!("{label}过长（最多 200 个字符）")));
        }
        if value.contains(['\n', '\r']) {
            return Err(invalid(format!("{label}不能换行")));
        }
    }
    if provider.contains('/') || id.contains('/') {
        return Err(invalid("provider 与模型 id 不能包含 /"));
    }
    Ok(())
}

/// 校验输出是否含 omp 的配置失败警告（合并输出，不区分 stdout/stderr）。
fn has_validation_warning(output: &str) -> bool {
    output.contains("validation failed") || output.contains("Failed to load config file models")
}

/// 沙箱校验：新文本写入 `<tmp>/agent/models.yml`（0600），跑真实 omp
/// `models --json`（`PI_CODING_AGENT_DIR=<tmp>/agent`，60 秒，退出码忽略）。
/// 通过条件：无失败警告、JSON 里有 `provider/id`、补丁数字字段一致。
pub(super) fn sandbox_validate(
    bin: &Path,
    new_text: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
) -> Result<(), AppError> {
    validate_with(bin, new_text, provider, id, patch, run_sandbox_omp)
}

/// 沙箱根目录守卫：任何路径（含 panic）都删除沙箱目录。
struct SandboxGuard {
    root: PathBuf,
}

impl Drop for SandboxGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// 可注入 omp 执行体的校验内核（单测用假 omp）。
pub(super) fn validate_with(
    bin: &Path,
    new_text: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
    run: impl FnOnce(&Path, &Path) -> Result<String, AppError>,
) -> Result<(), AppError> {
    let root = crate::util::mk_secure_tempdir("omp-resume-specvalidate")
        .map_err(|error| io_error(format!("无法创建校验沙箱：{error}")))?;
    let agent_dir = root.join("agent");
    // 沙箱子目录 0700：失败时先删根目录再报错。
    if let Err(error) = std::fs::DirBuilder::new().mode(0o700).create(&agent_dir) {
        let _ = fs::remove_dir_all(&root);
        return Err(io_error(format!("无法创建校验沙箱：{error}")));
    }
    // Drop 守卫：run  panic 时同样清理（含明文副本的目录不泄漏）。
    let _guard = SandboxGuard { root: root.clone() };
    let yml = agent_dir.join(MODELS_YML_NAME);
    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&yml)?;
        file.write_all(new_text.as_bytes())?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        return Err(io_error(format!("无法写入校验沙箱：{error}")));
    }
    let output = run(bin, &agent_dir)?;
    check_sandbox_output(&output, provider, id, patch)
}

/// 真实 omp 执行：不经 shell，`PI_CODING_AGENT_DIR` 指向沙箱（不继承用户值）。
pub(super) fn run_sandbox_omp(bin: &Path, agent_dir: &Path) -> Result<String, AppError> {
    const PIPE_CAP: usize = 8 * 1024 * 1024;
    let opts = RunOpts {
        extra_env: Some((PI_AGENT_DIR_ENV, agent_dir)),
        pipe_cap: Some(PIPE_CAP),
    };
    match run_omp_with(bin, &["models", "--json"], CHECK_TIMEOUT, &mut |_| {}, opts) {
        Ok(out) => Ok(out.output), // 退出码不看，按内容判定（现行为）
        Err(e) if e.code == ErrorCode::Timeout => {
            Err(AppError::new(ErrorCode::Timeout, "omp 校验超时"))
        }
        Err(e) if e.code == ErrorCode::OmpFailed => {
            Err(invalid("新规格未通过 omp 校验，请检查后重试"))
        }
        Err(e) => Err(e),
    }
}

/// 判定沙箱输出（纯函数，可单测）：警告/缺模型/数字不一致 → `INVALID_INPUT`。
pub(super) fn check_sandbox_output(
    output: &str,
    provider: &str,
    id: &str,
    patch: &ModelSpecPatch,
) -> Result<(), AppError> {
    if has_validation_warning(output) {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    }
    let Some(json_text) = crate::util::json_start(output) else {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    };
    let mut stream = serde_json::Deserializer::from_str(json_text).into_iter::<Value>();
    let value: Value = stream
        .next()
        .ok_or_else(|| invalid("新规格未通过 omp 校验，请检查后重试"))?
        .map_err(|_| invalid("新规格未通过 omp 校验，请检查后重试"))?;
    let selector = format!("{provider}/{id}");
    let models = value.get("models").and_then(Value::as_array);
    let found = models
        .into_iter()
        .flatten()
        .find(|model| model.get("selector").and_then(Value::as_str) == Some(selector.as_str()));
    let Some(found) = found else {
        return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
    };
    // 补丁字段必须与 omp 读回一致（防编辑器错位写到别的行）。
    // name 精确比对，reasoning 布尔比对，input 无序集合比对；
    // 读回缺字段一律拒绝（fail-closed）。
    if let Some(name) = &patch.name {
        if found.get("name").and_then(Value::as_str) != Some(name.as_str()) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(reasoning) = patch.reasoning {
        if found.get("reasoning").and_then(Value::as_bool) != Some(reasoning) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(input) = &patch.input {
        let Some(actual) = found.get("input").and_then(Value::as_array) else {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        };
        let mut got: Vec<&str> = actual.iter().filter_map(Value::as_str).collect();
        let mut want: Vec<&str> = input.iter().map(String::as_str).collect();
        got.sort_unstable();
        want.sort_unstable();
        if got != want {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(window) = patch.context_window {
        if found.get("contextWindow").and_then(Value::as_u64) != Some(window) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(tokens) = patch.max_tokens {
        if found.get("maxTokens").and_then(Value::as_u64) != Some(tokens) {
            return Err(invalid("新规格未通过 omp 校验，请检查后重试"));
        }
    }
    if let Some(cost) = &patch.cost {
        let actual = |key: &str| {
            found
                .get("cost")
                .and_then(|block| block.get(key))
                .and_then(Value::as_f64)
        };
        for (key, expected) in [
            ("input", cost.input),
            ("output", cost.output),
            ("cacheRead", cost.cache_read),
            ("cacheWrite", cost.cache_write),
        ] {
            match actual(key) {
                Some(got) if (got - expected).abs() <= 1e-9 => {}
                _ => return Err(invalid("新规格未通过 omp 校验，请检查后重试")),
            }
        }
    }
    Ok(())
}
