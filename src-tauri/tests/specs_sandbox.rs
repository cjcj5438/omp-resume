//! 真实 models.yml 副本往返冒烟（`#[ignore]` 手动回归）：
//!
//! ```sh
//! cargo test --test specs_sandbox -- --ignored --nocapture
//! ```
//!
//! 前置（测试内自动做）：`cp ~/.omp/agent/models.yml <tmp>/agent/models.yml`
//! （只读复制；绝不打印文件内容；绝不写回 ~/.omp）。
//! 流程：真实 omp 沙箱校验 + 真实写 /tmp 副本，断言备份/权限/字节差/CONFLICT/非法拒绝。
//! 输出的 diff 会把含 apiKey/token/baseUrl 的行打码后再打印。
use omp_resume_lib::model::{ErrorCode, ModelCostPatch, ModelSpecPatch, ModelSpecPatchRequest};
use omp_resume_lib::model_specs::{
    get_model_specs_impl, resolve_models_yml, revision_of, update_model_spec_impl,
};
use omp_resume_lib::omp_cli::{resolve_omp, OmpBusy};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
/// 含凭据的行打码（只留行号与键名；contextWindow 等含 token 子串的规格键不算）。
fn redact(line: &str) -> String {
    let lower = line.to_lowercase();
    let code = lower.split('#').next().unwrap_or("");
    let is_secret = code.contains("apikey")
        || code.contains("baseurl")
        || code.split(':').next().is_some_and(|key| {
            let key = key.trim().trim_matches(['"', '\'']);
            key == "token" || key.ends_with("_token") || key.ends_with("-token")
        });
    if is_secret {
        let key = line
            .split(':')
            .next()
            .unwrap_or("?")
            .trim()
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '_' || *c == ' ' || *c == '-')
            .collect::<String>();
        return format!("<redacted {key}>");
    }
    line.to_owned()
}

#[test]
#[ignore]
fn real_models_yml_copy_roundtrip() {
    let bin = resolve_omp().expect("需要真实 omp（或设置 OMP_RESUME_OMP_BIN）");
    let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
    let live = home.join(".omp/agent/models.yml");
    assert!(live.is_file(), "真实 models.yml 不存在：{}", live.display());

    // 只读复制到沙箱。
    let sandbox = tempfile::tempdir().expect("临时目录");
    let agent_dir = sandbox.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let yml = agent_dir.join("models.yml");
    let original = std::fs::read(&live).expect("读真实文件");
    assert!(!original.is_empty());
    std::fs::write(&yml, &original).unwrap();
    // resolve_models_yml 默认应指向真实路径（仅断言形状，不用它写）。
    assert_eq!(resolve_models_yml(), live);

    // (0) 读快照：必须 available 且无 error；分层价模型只记 id，跳过不写。
    let snapshot = get_model_specs_impl(&yml);
    assert!(snapshot.available, "error={:?}", snapshot.error);
    assert!(snapshot.error.is_none(), "{:?}", snapshot.error);
    println!(
        "读到 {} 个规格，revision={}",
        snapshot.specs.len(),
        snapshot.revision
    );
    assert!(!snapshot.specs.is_empty());
    for tiered in snapshot.specs.iter().filter(|s| s.cost_tiered) {
        println!("(0) 跳过分层价模型（不写）：{}", tiered.selector);
        assert!(
            tiered.cost_input.is_none()
                && tiered.cost_output.is_none()
                && tiered.cost_cache_read.is_none()
                && tiered.cost_cache_write.is_none(),
            "分层价四费用必须为 None：{}",
            tiered.selector
        );
    }
    // 真实文件已知形状：5438/muse-spark-1.3-contributor 是 `- &muse_spark` 锚条目
    // 且被 5438-r1/r2 别名引用 → 写它必须被拒（防波及引用者）。
    let anchored = snapshot
        .specs
        .iter()
        .find(|s| s.provider == "5438" && s.id == "muse-spark-1.3-contributor")
        .expect("锚点条目应被读到");
    println!(
        "锚点条目：{} ctx={:?} cost={:?}",
        anchored.selector, anchored.context_window, anchored.cost_input
    );
    let busy = OmpBusy::default();
    let err = update_model_spec_impl(
        &bin,
        &busy,
        &yml,
        &ModelSpecPatchRequest {
            provider: anchored.provider.clone(),
            id: anchored.id.clone(),
            patch: ModelSpecPatch {
                context_window: Some(anchored.context_window.unwrap_or(100) + 1),
                ..Default::default()
            },
            expected_revision: snapshot.revision.clone(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput, "{err:?}");
    assert!(err.message.contains("别名"), "{}", err.message);
    println!("(0) 锚点别名守卫通过：{}", err.message);
    assert_eq!(std::fs::read(&yml).unwrap(), original, "拒绝后文件必须不动");

    // (1) 选一个普通条目：带块序列 input + 普通 cost + reasoning，非分层价，
    // 且非常驻别名目标（锚条目写侧拒改，此处跳过）。
    let target = snapshot
        .specs
        .iter()
        .find(|s| {
            !s.cost_tiered
                && s.provider != "5438"
                && s.input.as_ref().is_some_and(|items| items.len() >= 2)
                && s.cost_input.is_some()
                && s.reasoning.is_some()
        })
        .or_else(|| {
            snapshot.specs.iter().find(|s| {
                !s.cost_tiered
                    && s.id != "muse-spark-1.3-contributor"
                    && s.input.as_ref().is_some_and(|items| items.len() >= 2)
                    && s.cost_input.is_some()
                    && s.reasoning.is_some()
            })
        })
        .expect("应有块序列 input + 普通 cost 的目标条目");
    println!(
        "目标：{} input={:?} reasoning={:?}",
        target.selector, target.input, target.reasoning
    );
    let new_window = target.context_window.unwrap_or(1000) + 1;
    let new_name = format!(
        "{}-smoke",
        target.name.clone().unwrap_or_else(|| "M".into())
    );
    // input：去掉一个模态（至少留 text）；reasoning 取反。
    let mut new_input = target.input.clone().unwrap();
    new_input.pop();
    if new_input.is_empty() {
        new_input.push("text".to_owned());
    }
    let new_reasoning = !target.reasoning.unwrap();
    let new_cost = ModelCostPatch {
        input: target.cost_input.unwrap_or(0.3) + 0.01,
        output: target.cost_output.unwrap_or(1.2),
        cache_read: target.cost_cache_read.unwrap_or(0.006),
        cache_write: target.cost_cache_write.unwrap_or(0.0),
    };
    println!(
        "目标：{} ctx {}->{} name后缀 input->{:?} reasoning->{new_reasoning} cost.input->{}",
        target.selector,
        target.context_window.unwrap_or(0),
        new_window,
        new_input,
        new_cost.input
    );

    // (a) 真实写（沙箱校验走真实 omp）：name + 窗口 + input + reasoning + cost。
    let result = update_model_spec_impl(
        &bin,
        &busy,
        &yml,
        &ModelSpecPatchRequest {
            provider: target.provider.clone(),
            id: target.id.clone(),
            patch: ModelSpecPatch {
                name: Some(new_name.clone()),
                context_window: Some(new_window),
                max_tokens: target.max_tokens,
                reasoning: Some(new_reasoning),
                input: Some(new_input.clone()),
                cost: Some(new_cost.clone()),
            },
            expected_revision: snapshot.revision.clone(),
        },
    )
    .expect("真实写应成功");
    println!(
        "(a) 写成功：revision={} backup={}",
        result.revision, result.backup_path
    );
    assert_ne!(result.revision, snapshot.revision);
    assert_eq!(result.spec.context_window, Some(new_window));
    assert_eq!(result.spec.name.as_deref(), Some(new_name.as_str()));
    assert_eq!(result.spec.reasoning, Some(new_reasoning));
    assert_eq!(result.spec.input, Some(new_input.clone()));
    let backup = PathBuf::from(&result.backup_path);
    assert!(backup.is_file(), "备份应存在");
    assert_eq!(
        backup.metadata().unwrap().permissions().mode() & 0o777,
        0o600,
        "备份 0600"
    );
    assert_eq!(
        yml.metadata().unwrap().permissions().mode() & 0o777,
        0o600,
        "新文件 0600"
    );
    assert_eq!(std::fs::read(&backup).unwrap(), original, "备份内容=原文");

    // (b) 字节差：块序列 input 头改流式 + 子行删除，故行数减少；
    // 含 apiKey 的行绝不能变；变化只许在目标条目跨度内。
    let new_bytes = std::fs::read(&yml).unwrap();
    let old_lines: Vec<&str> = std::str::from_utf8(&original).unwrap().lines().collect();
    let new_lines: Vec<&str> = std::str::from_utf8(&new_bytes).unwrap().lines().collect();
    // 旧 input 占 1 头 + N 子行，新 input 占 1 行：行数差 = N。
    let old_input_children = target.input.clone().unwrap().len();
    assert_eq!(
        old_lines.len() - new_lines.len(),
        old_input_children,
        "块序列 input 应坍缩为一行"
    );
    // 程序化断言：apiKey 行集合完全一致（打码后打印 diff）。
    let old_secrets: Vec<&&str> = old_lines
        .iter()
        .filter(|line| line.to_lowercase().contains("apikey"))
        .collect();
    let new_secrets: Vec<&&str> = new_lines
        .iter()
        .filter(|line| line.to_lowercase().contains("apikey"))
        .collect();
    assert_eq!(old_secrets, new_secrets, "apiKey 行必须逐行一致");
    // 简单逐行 diff（行数不等时按前缀比，余行全记变化）。
    let mut changed = Vec::new();
    let common = old_lines.len().min(new_lines.len());
    for (i, (a, b)) in old_lines
        .iter()
        .zip(new_lines.iter())
        .enumerate()
        .take(common)
    {
        if a != b {
            changed.push((i + 1, (*a).to_string(), (*b).to_string()));
        }
    }
    println!("(b) 变化行数（前缀比）：{}", changed.len());
    for (no, a, b) in &changed {
        println!("  {no}- {}", redact(a));
        println!("  {no}+ {}", redact(b));
    }
    // 新值必须出现在 diff 里。
    let joined: String = changed.iter().map(|(_, _, b)| b.clone()).collect();
    assert!(joined.contains(&new_window.to_string()), "{joined:?}");
    assert!(joined.contains(&new_name), "{joined:?}");
    assert!(
        joined.contains(&format!("input: [{}]", new_input.join(", "))),
        "{joined:?}"
    );

    // (c) omp 读回新值、无 validation failed。
    let out = std::process::Command::new(&bin)
        .args(["models", "--json"])
        .env("PI_CODING_AGENT_DIR", &agent_dir)
        .env("NO_COLOR", "1")
        .output()
        .expect("跑 omp");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stdout.contains("validation failed") && !stderr.contains("validation failed"),
        "stderr={stderr}"
    );
    assert!(
        !stderr.contains("Failed to load config file models"),
        "stderr={stderr}"
    );
    let json_start = stdout.find('{').expect("应有 JSON");
    let value: serde_json::Value =
        serde_json::from_str(&stdout[json_start..]).expect("解析 omp 输出");
    let found = value["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["selector"] == target.selector)
        .expect("应有目标模型");
    assert_eq!(found["contextWindow"], new_window);
    assert_eq!(found["name"], new_name);
    assert_eq!(found["reasoning"], new_reasoning);
    let mut got_input: Vec<&str> = found["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    let mut want_input: Vec<&str> = new_input.iter().map(String::as_str).collect();
    got_input.sort_unstable();
    want_input.sort_unstable();
    assert_eq!(got_input, want_input);
    assert!((found["cost"]["input"].as_f64().unwrap() - new_cost.input).abs() < 1e-9);
    println!("(c) omp 读回一致，无 validation failed");

    // (d) 旧 revision 再写 → CONFLICT。
    let err = update_model_spec_impl(
        &bin,
        &busy,
        &yml,
        &ModelSpecPatchRequest {
            provider: target.provider.clone(),
            id: target.id.clone(),
            patch: ModelSpecPatch {
                max_tokens: Some(123),
                ..Default::default()
            },
            expected_revision: snapshot.revision.clone(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    println!("(d) CONFLICT 通过");

    // (e) 非法补丁写前拒绝，文件 hash 不变。
    let before_hash = revision_of(&std::fs::read(&yml).unwrap());
    let err = update_model_spec_impl(
        &bin,
        &busy,
        &yml,
        &ModelSpecPatchRequest {
            provider: target.provider.clone(),
            id: target.id.clone(),
            patch: ModelSpecPatch {
                context_window: Some(0),
                ..Default::default()
            },
            expected_revision: result.revision.clone(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(revision_of(&std::fs::read(&yml).unwrap()), before_hash);
    println!("(e) 非法拒绝通过，文件未动");
    println!(
        "全部断言通过（沙箱：{}，真实 ~/.omp 未动）",
        agent_dir.display()
    );
}
