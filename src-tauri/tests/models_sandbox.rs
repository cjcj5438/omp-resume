//! 真实 omp 冒烟（只读 + 沙箱写），与 fixtures/backend 同为 `--ignored` 手动回归：
//!
//! ```sh
//! cargo test --test models_sandbox -- --ignored --nocapture
//! ```
//!
//! 顺序敏感（单测试函数串行执行，避免 env 竞态）：
//! 1. 对真实 HOME 只读跑一次 `get_model_config`，只打印条数与 agent 名；
//! 2. `HOME` 切到临时目录，用真实 omp 对白名单 5 个 key 各 set 一遍
//!    （含 `:thinking` 后缀与回退链数组），断言 config.yml 内容与复读一致。
use omp_resume_lib::omp_cli::{resolve_omp, OmpBusy};
use omp_resume_lib::omp_models::{
    get_model_config_impl, update_model_config_impl, KEY_AGENT_ADVISOR, KEY_AGENT_OVERRIDES,
    KEY_DISABLED_AGENTS, KEY_FALLBACK_CHAINS, KEY_MODEL_ROLES,
};
use serde_json::{json, Value};

#[test]
#[ignore]
fn real_home_readonly_summary_then_sandbox_write_smoke() {
    let bin = resolve_omp().expect("需要真实 omp（或设置 OMP_RESUME_OMP_BIN）");

    // 1) 真实 HOME 只读：只打印条数与 agent 名，绝不打印值（可能含 token 类内容）。
    let home = std::path::PathBuf::from(std::env::var_os("HOME").expect("HOME"));
    let config = get_model_config_impl(&bin, &home).expect("真实 HOME 读取失败");
    println!(
        "真实 HOME：roles {} 项、overrides {} 项、disabled {} 项、advisor {} 项、chains {} 项",
        config.roles.len(),
        config.agent_overrides.len(),
        config.disabled_agents.len(),
        config.agent_advisor.len(),
        config.fallback_chains.len(),
    );
    println!(
        "真实 HOME agents：{:?}",
        config
            .agents
            .iter()
            .map(|a| format!("{}({:?})", a.name, a.source))
            .collect::<Vec<_>>()
    );

    // 2) 沙箱 HOME：写入 5 个 key 并核对 config.yml 与复读。
    let sandbox = tempfile::tempdir().expect("临时 HOME");
    std::env::set_var("HOME", sandbox.path());
    let busy = OmpBusy::default();
    let writes: &[(&str, Value)] = &[
        (
            KEY_MODEL_ROLES,
            json!({"default": "5438/muse-spark-1.3-contributor:max",
                   "plan": "5438-claude/claude-sonnet-5-5:xhigh",
                   "judge": "typesafe/jev-latest"}),
        ),
        (
            KEY_AGENT_OVERRIDES,
            json!({"sonic": "factory-droid/claude-haiku-5-5:high",
                   "scout": "5438/deepseek-v4.1-flash"}),
        ),
        (KEY_DISABLED_AGENTS, json!(["scout", "reviewer"])),
        (KEY_AGENT_ADVISOR, json!({"sonic": "off", "task": "on"})),
        (
            KEY_FALLBACK_CHAINS,
            json!({"default": ["5438/mimo-v2.6-pro", "factory-droid/gpt-6.1-sol"],
                   "5438/muse-spark-1.3-contributor": ["5438/mimo-v2.6-pro"]}),
        ),
    ];

    // 先按「读-比-写」把每个 key 写进去（expected 取写前的现值）。
    for (key, value) in writes {
        let before = get_model_config_impl(&bin, sandbox.path()).unwrap();
        let expected = match *key {
            KEY_MODEL_ROLES => Value::Object(before.roles),
            KEY_AGENT_OVERRIDES => Value::Object(before.agent_overrides),
            KEY_DISABLED_AGENTS => Value::Array(before.disabled_agents),
            KEY_AGENT_ADVISOR => Value::Object(before.agent_advisor),
            _ => Value::Object(before.fallback_chains),
        };
        let result = update_model_config_impl(&bin, &busy, key, value, &expected).unwrap();
        assert_eq!(&result.value, value, "{key} 写后复读应一致");
    }

    // 复读整份配置：5 个 key 全部一致（含 :thinking 后缀与数组顺序）。
    let after = get_model_config_impl(&bin, sandbox.path()).unwrap();
    assert_eq!(Value::Object(after.roles.clone()), writes[0].1);
    assert_eq!(Value::Object(after.agent_overrides.clone()), writes[1].1);
    assert_eq!(Value::Array(after.disabled_agents.clone()), writes[2].1);
    assert_eq!(Value::Object(after.agent_advisor.clone()), writes[3].1);
    assert_eq!(Value::Object(after.fallback_chains.clone()), writes[4].1);

    // config.yml 落盘内容核对（真实 omp 的 YAML 序列化）。
    let yaml = std::fs::read_to_string(sandbox.path().join(".omp/agent/config.yml")).unwrap();
    for needle in [
        "default: 5438/muse-spark-1.3-contributor:max",
        "plan: 5438-claude/claude-sonnet-5-5:xhigh",
        "judge: typesafe/jev-latest",
        "sonic: factory-droid/claude-haiku-5-5:high",
        "- scout",
        "sonic: \"off\"",
        "- 5438/mimo-v2.6-pro",
        "- factory-droid/gpt-6.1-sol",
    ] {
        assert!(
            yaml.contains(needle),
            "config.yml 缺少 {needle:?}：\n{yaml}"
        );
    }
    println!("沙箱 config.yml 校验通过（{} 字节）", yaml.len());

    // 冲突检测走真实现值：旧 expected 再写必 CONFLICT。
    let err = update_model_config_impl(&bin, &busy, KEY_MODEL_ROLES, &writes[0].1, &json!({}))
        .unwrap_err();
    assert_eq!(err.code, omp_resume_lib::model::ErrorCode::Conflict);
    println!("CONFLICT 检测通过");
}
