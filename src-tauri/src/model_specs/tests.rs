use super::*;
use crate::model::ModelCostPatch;
use std::fs;
use std::os::unix::fs::PermissionsExt;

const SECRET: &str = "sk-secret-值-必须永不出现";

// F1/F4 回归：嵌套同名键永不遮蔽直接子字段；id 只认直接子。
fn nested_shadow_sample() -> &'static str {
    r#"providers:
  acme:
    models:
      - id: fast
        name: Real
        contextWindow: 1000
        x-meta:
          name: Inner
        compat:
          contextWindow: 2
        inputLimits:
          images:
            input: sneaky
"#
}

#[test]
fn nested_keys_never_shadow_direct_fields() {
    // 读侧：嵌套值不遮蔽。
    let lines = split_lines(nested_shadow_sample());
    let span = locate_model(&lines, "acme", "fast").unwrap();
    let spec = read_spec(&lines, &span, "acme", "fast");
    assert_eq!(spec.name.as_deref(), Some("Real"));
    assert_eq!(spec.context_window, Some(1000));
    assert_eq!(spec.input, None);
    // 写 name：改顶层行，嵌套行不动。
    let out = apply_patch_to_text(
        nested_shadow_sample(),
        "acme",
        "fast",
        &ModelSpecPatch {
            name: Some("New".to_owned()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        name: \"New\"\n"), "{out}");
    assert!(out.contains("          name: Inner\n"), "{out}");
    // 写 input：顶层缺 input → 插入新行，嵌套 input 行不动。
    let out = apply_patch_to_text(
        nested_shadow_sample(),
        "acme",
        "fast",
        &ModelSpecPatch {
            input: Some(vec!["text".to_owned()]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        input: [text]\n"), "{out}");
    assert!(out.contains("            input: sneaky\n"), "{out}");
    // 写 contextWindow：改顶层行，compat 嵌套行不动。
    let out = apply_patch_to_text(
        nested_shadow_sample(),
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        contextWindow: 5\n"), "{out}");
    assert!(out.contains("          contextWindow: 2\n"), "{out}");
}

#[test]
fn nested_reasoning_shadow_inserts_top_level() {
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        x-meta:\n          reasoning: true\n";
    // 读侧：嵌套 reasoning 不算。
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    assert_eq!(read_spec(&lines, &span, "acme", "fast").reasoning, None);
    // 写侧：插入顶层行，嵌套行不动。
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            reasoning: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        reasoning: false\n"), "{out}");
    assert!(out.contains("          reasoning: true\n"), "{out}");
}

#[test]
fn id_matching_ignores_nested_and_handles_anchors() {
    // 仅有嵌套 id 的条目不可定位。
    let yml = "providers:\n  acme:\n    models:\n      - name: beta\n        nested:\n          id: fast\n        contextWindow: 2\n";
    let error = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("未找到"), "{}", error.message);
    // 锚值 id 可定位：`id: &x fast`。
    let yml =
        "providers:\n  acme:\n    models:\n      - id: &x fast\n        contextWindow: 1000\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("contextWindow: 5"), "{out}");
    // 同一条目两个不同的顶层 id → 手动改。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        id: slow\n        contextWindow: 1\n";
    let error = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("手动"), "{}", error.message);
    // 目标命中第二个 id 同样手动改（不静默选首个）。
    let error = apply_patch_to_text(
        yml,
        "acme",
        "slow",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    let yml = "providers:\n  acme:\n    models:\n      - id: real\n        nested:\n          id: ghost\n        contextWindow: 1\n";
    let specs = read_all_specs(yml, true).unwrap();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].id, "real");
}

fn sample() -> &'static str {
    r#"# 顶部注释
providers:
  acme: # 行尾注释
    baseUrl: https://example.test
    api: openai
    apiKey: sk-secret-值-必须永不出现
    models:
      - id: fast # 内联注释
        name: "Fast One"
        contextWindow: 1000
        maxTokens: 100
        reasoning: true
        input: [text, image]
        cost: &u5438
          input: 0.3
          output: 1.2
          cacheRead: 0.006
          cacheWrite: 0
      - name: Slow
        id: slow
        contextWindow: 2000
  "quoted-prov":
    apiKey: sk-secret-值-必须永不出现
    models:
      - id: q1
"#
}

fn patch_all() -> ModelSpecPatch {
    ModelSpecPatch {
        name: Some("快 \"新\" \\ 名".to_owned()),
        context_window: Some(2000),
        max_tokens: Some(200),
        reasoning: Some(false),
        input: Some(vec!["text".to_owned()]),
        cost: Some(ModelCostPatch {
            input: 0.5,
            output: 2.0,
            cache_read: 0.01,
            cache_write: 0.0,
        }),
    }
}

#[test]
fn path_resolution_priority_and_size_cap() {
    let home = Path::new("/home/u");
    assert_eq!(
        resolve_models_yml_with(|_| None, home),
        home.join(".omp/agent/models.yml")
    );
    assert_eq!(
        resolve_models_yml_with(
            |key| (key == PI_AGENT_DIR_ENV).then(|| "/tmp/agent".to_owned()),
            home
        ),
        PathBuf::from("/tmp/agent/models.yml")
    );
    // 空白覆盖值视为未设置，落到下一级。
    assert_eq!(
        resolve_models_yml_with(
            |key| match key {
                MODELS_YML_ENV => Some("   ".to_owned()),
                PI_AGENT_DIR_ENV => Some("/tmp/agent".to_owned()),
                _ => None,
            },
            home
        ),
        PathBuf::from("/tmp/agent/models.yml")
    );
    assert_eq!(
        resolve_models_yml_with(
            |key| (key == MODELS_YML_ENV).then(|| "/tmp/custom.yml".to_owned()),
            home
        ),
        PathBuf::from("/tmp/custom.yml")
    );
    // 大小上限：超 2 MiB 拒绝。
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("models.yml");
    fs::write(&big, vec![b'x'; MAX_YML_BYTES as usize + 1]).unwrap();
    let error = read_yml(&big).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(read_yml(&dir.path().join("missing.yml")).unwrap().is_none());
    // revision 为字节 SHA256。
    assert_eq!(
        revision_of(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn replace_existing_scalars_preserves_rest_bytes() {
    let text = sample();
    let out = apply_patch_to_text(text, "acme", "fast", &patch_all()).unwrap();
    // 替换值正确（含 name 转义、费用 6 位小数修剪）。
    assert!(out.contains("name: \"快 \\\"新\\\" \\\\ 名\""), "{out}");
    assert!(out.contains("contextWindow: 2000"), "{out}");
    assert!(out.contains("maxTokens: 200"), "{out}");
    assert!(out.contains("reasoning: false"), "{out}");
    assert!(out.contains("input: [text]"), "{out}");
    assert!(out.contains("input: 0.5"), "{out}");
    assert!(out.contains("cacheWrite: 0\n"), "{out}");
    // 注释/锚点/凭据行原样保留。
    assert!(out.contains("# 顶部注释"), "{out}");
    assert!(out.contains("acme: # 行尾注释"), "{out}");
    assert!(out.contains("- id: fast # 内联注释"), "{out}");
    assert!(out.contains("cost: &u5438"), "{out}");
    assert!(out.contains(&format!("apiKey: {SECRET}")), "{out}");
    // 未触碰的模型行逐字节一致。
    for needle in ["- name: Slow", "id: slow", "\"quoted-prov\":", "- id: q1"] {
        assert_eq!(
            out.matches(needle).count(),
            text.matches(needle).count(),
            "{needle}"
        );
    }
    // 读回规格一致。
    let lines = split_lines(&out);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    let spec = read_spec(&lines, &span, "acme", "fast");
    assert_eq!(spec.name.as_deref(), Some("快 \"新\" \\ 名"));
    assert_eq!(spec.context_window, Some(2000));
    assert_eq!(spec.max_tokens, Some(200));
    assert_eq!(spec.reasoning, Some(false));
    assert_eq!(spec.input, Some(vec!["text".to_owned()]));
    assert_eq!(spec.cost_input, Some(0.5));
    assert_eq!(spec.cost_cache_write, Some(0.0));
}

#[test]
fn insert_missing_fields_and_cost_block_after_dash() {
    let out = apply_patch_to_text(sample(), "acme", "slow", &patch_all()).unwrap();
    // 缺失字段插在条目内（`id: slow` 所在条目、下一 provider 之前）。
    let slow_at = out.find("id: slow").unwrap();
    let quoted_at = out.find("\"quoted-prov\"").unwrap();
    // 条目起点为 id 行之上最近的 `- ` 行。
    let dash_at = out[..slow_at].rfind("- name:").unwrap();
    let block = &out[dash_at..quoted_at];
    assert!(block.contains("maxTokens: 200"), "{block}");
    assert!(block.contains("reasoning: false"), "{block}");
    assert!(block.contains("cost:"), "{block}");
    assert!(block.contains("cacheRead: 0.01"), "{block}");
    // cost 块四键齐全、顺序固定。
    let cost_at = block.find("cost:\n").unwrap();
    let cost_block = &block[cost_at..];
    let order = [
        "input: 0.5",
        "output: 2",
        "cacheRead: 0.01",
        "cacheWrite: 0",
    ];
    let mut last = 0;
    for needle in order {
        let at = cost_block.find(needle).unwrap();
        assert!(at > last, "{needle} in {cost_block}");
        last = at;
    }
    // 已存在的 name/contextWindow 被替换而非重复插入。
    assert_eq!(block.matches("name:").count(), 1, "{block}");
    assert_eq!(block.matches("contextWindow:").count(), 1, "{block}");
    // id 在第二行的条目形式可定位。
    let lines = split_lines(&out);
    let span = locate_model(&lines, "acme", "slow").unwrap();
    let spec = read_spec(&lines, &span, "acme", "slow");
    assert_eq!(spec.max_tokens, Some(200));
    assert_eq!(spec.cost_output, Some(2.0));
}

#[test]
fn quoted_keys_and_head_id_form() {
    // 引号 provider + `- id: x` 首行内联形式。
    let out = apply_patch_to_text(
        sample(),
        "quoted-prov",
        "q1",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("- id: q1"), "{out}");
    assert!(out.contains("contextWindow: 5"), "{out}");
    // 单引号 id 匹配。
    let single = sample().replace("- id: q1", "- id: 'q1'");
    let out = apply_patch_to_text(
        &single,
        "quoted-prov",
        "q1",
        &ModelSpecPatch {
            max_tokens: Some(7),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("maxTokens: 7"), "{out}");
}

#[test]
fn crlf_comments_and_flow_style() {
    let crlf = sample().replace('\n', "\r\n");
    let out = apply_patch_to_text(
        &crlf,
        "acme",
        "fast",
        &ModelSpecPatch {
            max_tokens: Some(300),
            ..Default::default()
        },
    )
    .unwrap();
    // CRLF 保留：替换行与插入行均为 \r\n，且无裸 \n。
    assert!(out.contains("maxTokens: 300\r\n"), "{out:?}");
    for line in out.split("\r\n") {
        assert!(!line.contains('\n'), "{line:?}");
    }
    // 注释保留。
    assert!(out.contains("# 内联注释\r\n"), "{out:?}");
    // 流式条目拒绝。
    let flow = sample().replace("- id: fast # 内联注释", "- {id: fast}");
    let error = apply_patch_to_text(
        &flow,
        "acme",
        "fast",
        &ModelSpecPatch {
            max_tokens: Some(1),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("手动"), "{}", error.message);
    assert!(!error.message.contains(SECRET), "{}", error.message);
}

#[test]
fn anchor_heads_alias_items_and_alias_guard() {
    let anchored = r#"providers:
  acme:
    apiKey: sk-secret-值-必须永不出现
    models:
      - &spark
        id: fast
        contextWindow: 1000
      - id: slow
        contextWindow: 2000
  alias-prov:
    apiKey: sk-secret-值-必须永不出现
    models:
      - *spark
"#;
    // `- &name` 锚条目可定位；但它被他处 `*spark` 引用 → 写时拒绝。
    let lines = split_lines(anchored);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    assert_eq!(
        read_spec(&lines, &span, "acme", "fast").context_window,
        Some(1000)
    );
    let error = apply_patch_to_text(
        anchored,
        "acme",
        "fast",
        &ModelSpecPatch {
            max_tokens: Some(1),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("别名"), "{}", error.message);
    assert!(!error.message.contains(SECRET), "{}", error.message);
    // 无引用的锚条目可写。
    let unreferenced = anchored.replace("      - *spark\n", "      - id: other\n");
    let out = apply_patch_to_text(
        &unreferenced,
        "acme",
        "fast",
        &ModelSpecPatch {
            max_tokens: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("- &spark"), "{out}");
    assert!(out.contains("maxTokens: 5"), "{out}");
    // 读侧跳过纯别名条目（无本地 id）。
    let specs = read_all_specs(anchored, true).unwrap();
    assert_eq!(specs.len(), 2);
    assert!(specs.iter().all(|s| !s.id.is_empty()));
    // cost 锚被引用同样拒绝。
    let cost_anchor = r#"providers:
  acme:
    models:
      - id: fast
        cost: &c0
          input: 0.1
          output: 0.2
          cacheRead: 0.003
          cacheWrite: 0
      - id: slow
        cost: *c0
"#;
    let error = apply_patch_to_text(
        cost_anchor,
        "acme",
        "fast",
        &ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1.0,
                output: 1.0,
                cache_read: 1.0,
                cache_write: 1.0,
            }),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("别名"), "{}", error.message);
}

#[test]
fn missing_duplicate_and_manual_shapes() {
    let patch = ModelSpecPatch {
        max_tokens: Some(1),
        ..Default::default()
    };
    // 缺 provider / 缺模型。
    for (provider, id) in [("nope", "fast"), ("acme", "nope")] {
        let error = apply_patch_to_text(sample(), provider, id, &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{provider}/{id}");
        assert!(!error.message.contains(SECRET), "{}", error.message);
    }
    // 重复 provider。
    let dup_provider = sample().replace(
        "  \"quoted-prov\":",
        "  acme:\n    models:\n      - id: other\n  \"quoted-prov\":",
    );
    let error = apply_patch_to_text(&dup_provider, "acme", "fast", &patch).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("手动"), "{}", error.message);
    // 重复 id。
    let dup_id = sample().replace("- name: Slow\n        id: slow", "id: fast");
    let error = apply_patch_to_text(&dup_id, "acme", "fast", &patch).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("手动"), "{}", error.message);
    // cost 行内写法。
    let inline_cost = sample().replace("cost: &u5438", "cost: {input: 1}");
    let error = apply_patch_to_text(
        &inline_cost,
        "acme",
        "fast",
        &ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1.0,
                output: 1.0,
                cache_read: 1.0,
                cache_write: 1.0,
            }),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(!error.message.contains(SECRET), "{}", error.message);
    // cost 缺子键。
    let missing_sub = sample().replace("          cacheWrite: 0\n", "");
    let error = apply_patch_to_text(
        &missing_sub,
        "acme",
        "fast",
        &ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1.0,
                output: 1.0,
                cache_read: 1.0,
                cache_write: 1.0,
            }),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[test]
fn atomic_write_refuses_symlink_and_readonly() {
    // F10 回归：符号链接与只读目标拒绝写入。
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real.yml");
    fs::write(&real, b"real").unwrap();
    let link = dir.path().join("models.yml");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let error = atomic_write(&link, b"new").unwrap_err();
    assert_eq!(error.code, ErrorCode::Io);
    assert!(error.message.contains("符号链接"), "{}", error.message);
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&real).unwrap(), b"real");
    // 只读文件拒绝。
    let ro = dir.path().join("ro.yml");
    fs::write(&ro, b"old").unwrap();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o444)).unwrap();
    let error = atomic_write(&ro, b"new").unwrap_err();
    assert_eq!(error.code, ErrorCode::Io);
    assert!(error.message.contains("只读"), "{}", error.message);
    assert_eq!(fs::read(&ro).unwrap(), b"old");
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o644)).unwrap();
}

#[test]
fn revision_sentinels_dup_models_and_flow_continue() {
    // F12 回归：哨兵 revision → INVALID；重复 models → 手动改；流式项跳过不断读。
    let dir = tempfile::tempdir().unwrap();
    let yml = dir.path().join("models.yml");
    fs::write(&yml, sample()).unwrap();
    let busy = OmpBusy::default();
    for sentinel in ["absent", "unreadable"] {
        let error = update_model_spec_impl(
            dir.path(),
            &busy,
            &yml,
            &ModelSpecPatchRequest {
                provider: "acme".to_owned(),
                id: "fast".to_owned(),
                patch: ModelSpecPatch {
                    max_tokens: Some(1),
                    ..Default::default()
                },
                expected_revision: sentinel.to_owned(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{sentinel}");
        assert!(error.message.contains("刷新"), "{}", error.message);
    }
    // 同一 provider 下第二个 models。
    let dup = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1\n    models:\n      - id: fast\n        contextWindow: 2\n";
    let error = apply_patch_to_text(
        dup,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert!(error.message.contains("手动"), "{}", error.message);
    // 流式首项后仍读到后项。
    let yml = "providers:\n  acme:\n    models:\n      - {id: skip}\n      - id: fast\n        contextWindow: 1\n";
    let specs = read_all_specs(yml, false).unwrap();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].id, "fast");
    // 200 汉字（600 字节）不超限。
    assert!(validate_target(&"中".repeat(200), "x").is_ok());
    assert!(validate_target(&"中".repeat(201), "x").is_err());
}

#[test]
fn alias_guard_token_aware_and_wide_charset() {
    // F13 回归：`*c0x` 不误伤 `&c0`；`&a.b` 全名参与比对。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        cost: &c0\n          input: 0.1\n          output: 0.2\n          cacheRead: 0.003\n          cacheWrite: 0\n      - id: slow\n        cost: *c0x\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("contextWindow: 5"), "{out}");
    // 真引用仍拒绝（含合并键导入）。
    let yml = "providers:\n  acme:\n    models:\n      - &tgt\n        id: fast\n        contextWindow: 1\n  b:\n    models:\n      - <<: *tgt\n        id: other\n";
    let error = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(error.message.contains("别名"), "{}", error.message);
    // 点号锚名不截断：`*a` 不误伤 `&a.b`。
    let yml = "providers:\n  acme:\n    models:\n      - &a.b id: fast\n        contextWindow: 1\n  b:\n    models:\n      - *a\n        contextWindow: 2\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("contextWindow: 5"), "{out}");
}

#[test]
fn relative_models_yml_absolutized() {
    // F14 回归：相对覆盖转绝对，不再 `Some("")`。
    let home = Path::new("/home/u");
    let resolved = resolve_models_yml_with(
        |key| (key == MODELS_YML_ENV).then(|| "rel.yml".to_owned()),
        home,
    );
    assert!(resolved.is_absolute());
    assert!(resolved.ends_with("rel.yml"));
}

#[test]
fn patch_validation_rejects_bad_values() {
    let cost = || ModelCostPatch {
        input: 1.0,
        output: 1.0,
        cache_read: 1.0,
        cache_write: 1.0,
    };
    let cases: Vec<ModelSpecPatch> = vec![
        ModelSpecPatch {
            name: Some("  ".to_owned()),
            ..Default::default()
        },
        ModelSpecPatch {
            context_window: Some(0),
            ..Default::default()
        },
        ModelSpecPatch {
            max_tokens: Some(0),
            ..Default::default()
        },
        ModelSpecPatch {
            input: Some(vec![]),
            ..Default::default()
        },
        ModelSpecPatch {
            input: Some(vec!["".to_owned()]),
            ..Default::default()
        },
        ModelSpecPatch {
            input: Some(vec!["a,b".to_owned()]),
            ..Default::default()
        },
        ModelSpecPatch {
            input: Some(vec!["a".repeat(33)]),
            ..Default::default()
        },
        ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: f64::NAN,
                ..cost()
            }),
            ..Default::default()
        },
        ModelSpecPatch {
            cost: Some(ModelCostPatch {
                output: -1.0,
                ..cost()
            }),
            ..Default::default()
        },
        // F11：超 2^53。
        ModelSpecPatch {
            context_window: Some((1 << 53) - 1 + 1),
            ..Default::default()
        },
        ModelSpecPatch {
            max_tokens: Some(u64::MAX),
            ..Default::default()
        },
        // F11：控制字符 / YAML 换行符。
        ModelSpecPatch {
            name: Some("a\0b".to_owned()),
            ..Default::default()
        },
        ModelSpecPatch {
            name: Some("a\tb".to_owned()),
            ..Default::default()
        },
        ModelSpecPatch {
            name: Some("a b".to_owned()),
            ..Default::default()
        },
        // F11：超 1e9 / 精度不足。
        ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1e10,
                ..cost()
            }),
            ..Default::default()
        },
        ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1e-7,
                ..cost()
            }),
            ..Default::default()
        },
        // F11：重复 input。
        ModelSpecPatch {
            input: Some(vec!["text".to_owned(), "text".to_owned()]),
            ..Default::default()
        },
    ];
    for patch in cases {
        assert_eq!(
            validate_patch(&patch).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
    assert!(validate_target("", "x").is_err());
    assert!(validate_target("a/b", "x").is_err());
    assert!(validate_target("a", "x/y").is_err());
    validate_patch(&patch_all()).unwrap();
    // P0.5：未知但格式合法的模态放行。
    validate_patch(&ModelSpecPatch {
        input: Some(vec!["video".to_owned(), "text".to_owned()]),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(format_cost(0.3000004), "0.3");
    assert_eq!(format_cost(0.0), "0");
    assert_eq!(format_cost(2.0), "2");
    assert_eq!(format_cost(0.006), "0.006");
}

#[test]
fn block_sequence_input_replace_and_read() {
    // F3 回归：真实块序列形 input 可读可写。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        input:\n          - text\n          - image\n        contextWindow: 1000\n";
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    assert_eq!(
        read_spec(&lines, &span, "acme", "fast").input,
        Some(vec!["text".to_owned(), "image".to_owned()])
    );
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            input: Some(vec!["text".to_owned()]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        input: [text]\n"), "{out}");
    assert!(!out.contains("- image"), "{out}");
    // 零缩进 `- ` 子行同样归属头。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        input:\n        - text\n        - image\n        contextWindow: 1000\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            input: Some(vec!["text".to_owned()]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        input: [text]\n"), "{out}");
    assert!(!out.contains("- image"), "{out}");
}

#[test]
fn block_scalar_values_refuse_manual_edit() {
    // F3 回归：块标量体永不悬空，一律手动改。
    for header in [
        "        name: |",
        "        name: >-",
        "        contextWindow: |2",
        "        input: |",
    ] {
        let yml = format!(
            "providers:\n  acme:\n    models:\n      - id: fast\n{header}\n          body line\n        maxTokens: 100\n"
        );
        let patch = if header.contains("contextWindow") {
            ModelSpecPatch {
                context_window: Some(5),
                ..Default::default()
            }
        } else if header.contains("input:") {
            ModelSpecPatch {
                input: Some(vec!["text".to_owned()]),
                ..Default::default()
            }
        } else {
            ModelSpecPatch {
                name: Some("N".to_owned()),
                ..Default::default()
            }
        };
        let error = apply_patch_to_text(&yml, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{header}");
        assert!(
            error.message.contains("手动"),
            "{header}: {}",
            error.message
        );
    }
    // 头后带行内注释的空值 input 仍可识别为块序列。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        input: # 注释\n          - text\n        contextWindow: 1000\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            input: Some(vec!["text".to_owned(), "image".to_owned()]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("input: [text, image]"), "{out}");
    assert!(!out.contains("- text\n          -"), "{out}");
}

#[test]
fn sandbox_output_checks_name_reasoning_input() {
    // F2 回归：name/reasoning/input 读回不一致或缺字段 → 拒绝。
    let patch = ModelSpecPatch {
        name: Some("New".to_owned()),
        reasoning: Some(false),
        input: Some(vec!["text".to_owned(), "image".to_owned()]),
        ..Default::default()
    };
    let good = "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
        \"reasoning\":false,\"input\":[\"text\",\"image\"]}]}\n";
    check_sandbox_output(good, "acme", "fast", &patch).unwrap();
    // input 无序也算一致。
    let shuffled = "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
        \"reasoning\":false,\"input\":[\"image\",\"text\"]}]}\n";
    check_sandbox_output(shuffled, "acme", "fast", &patch).unwrap();
    for bad in [
        // name 不一致。
        "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"fast\",\
        \"reasoning\":false,\"input\":[\"text\",\"image\"]}]}\n",
        // reasoning 不一致。
        "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
        \"reasoning\":true,\"input\":[\"text\",\"image\"]}]}\n",
        // input 集合不一致（缺 image）。
        "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
        \"reasoning\":false,\"input\":[\"text\"]}]}\n",
        // input 缺字段。
        "{\"models\":[{\"selector\":\"acme/fast\",\"name\":\"New\",\
        \"reasoning\":false}]}\n",
        // name 缺字段。
        "{\"models\":[{\"selector\":\"acme/fast\",\
        \"reasoning\":false,\"input\":[\"text\",\"image\"]}]}\n",
    ] {
        let error = check_sandbox_output(bad, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput, "{bad}");
        assert_eq!(error.message, "新规格未通过 omp 校验，请检查后重试");
    }
    // 未打补丁的字段不参与比对：缺字段也通过。
    check_sandbox_output(
        "{\"models\":[{\"selector\":\"acme/fast\"}]}\n",
        "acme",
        "fast",
        &ModelSpecPatch::default(),
    )
    .unwrap();
}

#[test]
fn tiered_cost_reads_none_and_refuses_write() {
    // 分层价回归：真实 longContext 形 → 四费用 None + 标记，写侧整模型拒改。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        cost:\n          input: 0.1\n          output: 0.5\n          cacheRead: 0.01\n          cacheWrite: 0.125\n          longContext:\n            inputThreshold: 100000\n            input: 0.5\n            output: 2.5\n            cacheRead: 0.05\n            cacheWrite: 0.625\n";
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    let spec = read_spec(&lines, &span, "acme", "fast");
    assert!(spec.cost_tiered);
    assert_eq!(spec.cost_input, None);
    assert_eq!(spec.cost_output, None);
    assert_eq!(spec.cost_cache_read, None);
    assert_eq!(spec.cost_cache_write, None);
    // 连非 cost 补丁也拒（可预测）。
    for patch in [
        ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
        ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1.0,
                output: 1.0,
                cache_read: 1.0,
                cache_write: 1.0,
            }),
            ..Default::default()
        },
    ] {
        let error = apply_patch_to_text(yml, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(
            error.message,
            "该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml"
        );
    }
    // 普通四键 cost 照常读写。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        cost:\n          input: 0.1\n          output: 0.2\n          cacheRead: 0.003\n          cacheWrite: 0\n";
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    let spec = read_spec(&lines, &span, "acme", "fast");
    assert!(!spec.cost_tiered);
    assert_eq!(spec.cost_input, Some(0.1));
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        contextWindow: 5\n"), "{out}");
    // compat 嵌套的四键 cost 不是真 cost：忽略，不标 tiered。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1000\n        compat:\n          cost:\n            input: 9\n            output: 9\n            cacheRead: 9\n            cacheWrite: 9\n";
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    let spec = read_spec(&lines, &span, "acme", "fast");
    assert!(!spec.cost_tiered);
    assert_eq!(spec.cost_input, None);
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        contextWindow: 5\n"), "{out}");
    assert!(out.contains("            input: 9\n"), "{out}");
}

#[test]
fn block_scalar_bodies_never_parse_as_fields() {
    // F5 回归：标量体里的 `contextWindow: 999` 永不解析为字段。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        description: |\n          contextWindow: 999\n          name: oldinner\n        maxTokens: 100\n";
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    let spec = read_spec(&lines, &span, "acme", "fast");
    assert_eq!(spec.context_window, None);
    assert_eq!(spec.name, None);
    // 写 contextWindow → 插入顶层行，体行不动。
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("        contextWindow: 5\n"), "{out}");
    assert!(out.contains("          contextWindow: 999\n"), "{out}");
    // 折叠式 `>` 同理。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        description: >\n          folded\n          contextWindow: 999\n        maxTokens: 100\n";
    let lines = split_lines(yml);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    assert_eq!(
        read_spec(&lines, &span, "acme", "fast").context_window,
        None
    );
}

#[test]
fn eof_without_newline_inserts_cleanly() {
    // F7 回归：EOF 无尾换行时插入不粘连。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            max_tokens: Some(7),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        out.contains("- id: fast\n        maxTokens: 7\n"),
        "{out:?}"
    );
    // cost 块插入同理。
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            cost: Some(ModelCostPatch {
                input: 1.0,
                output: 1.0,
                cache_read: 1.0,
                cache_write: 1.0,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("- id: fast\n        cost:\n"), "{out:?}");
    // CRLF 变体：横线行无换行，插入用 LF 亦不粘连。
    let yml = "providers:\r\n  acme:\r\n    models:\r\n      - id: fast";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            max_tokens: Some(7),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        out.contains("- id: fast\n        maxTokens: 7\n"),
        "{out:?}"
    );
}

#[test]
fn zero_indent_sequence_and_spaced_anchor_head() {
    // F8a 回归：`models:` 后横线同列可定位。
    let yml = "providers:\n  acme:\n    models:\n    - id: fast\n      contextWindow: 1000\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("contextWindow: 5"), "{out}");
    assert_eq!(read_all_specs(yml, true).unwrap().len(), 1);
    // F8b 回归：`-   &a id: x` 多余空格可定位。
    let yml = "providers:\n  acme:\n    models:\n      -   &a id: fast\n        contextWindow: 1\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(out.contains("contextWindow: 5"), "{out}");
}

#[test]
fn sandbox_output_checks_warnings_presence_and_numbers() {
    let patch = ModelSpecPatch {
        context_window: Some(2000),
        max_tokens: Some(200),
        cost: Some(ModelCostPatch {
            input: 0.5,
            output: 2.0,
            cache_read: 0.01,
            cache_write: 0.0,
        }),
        ..Default::default()
    };
    let good = |window: u64, cost_input: f64| {
        format!(
            "{{\"models\":[{{\"selector\":\"acme/fast\",\"contextWindow\":{window},\"maxTokens\":200,\
             \"cost\":{{\"input\":{cost_input},\"output\":2.0,\"cacheRead\":0.01,\"cacheWrite\":0}}}}]}}\n"
        )
    };
    check_sandbox_output(&good(2000, 0.5), "acme", "fast", &patch).unwrap();
    // 警告行 → 拒绝。
    for warning in [
        "config validation failed: bad\n".to_owned() + &good(2000, 0.5),
        "Failed to load config file models: boom\n".to_owned() + &good(2000, 0.5),
    ] {
        let error = check_sandbox_output(&warning, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(!error.message.contains("boom"), "{}", error.message);
    }
    // 缺模型 / 数字不一致 / 无 JSON → 拒绝，且文案固定不回显输出。
    for bad in [
        good(2000, 0.5).replace("acme/fast", "acme/other"),
        good(999, 0.5),
        good(2000, 0.6),
        "not json at all\n".to_owned(),
    ] {
        let error = check_sandbox_output(&bad, "acme", "fast", &patch).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert_eq!(error.message, "新规格未通过 omp 校验，请检查后重试");
    }
}

#[test]
fn validate_with_fake_omp_writes_sandbox_and_checks() {
    let _guard = crate::omp_cli::subprocess_test_guard();
    let dir = tempfile::tempdir().unwrap();
    let seen = dir.path().join("seen");
    let bin = dir.path().join("omp");
    // 假 omp：断言沙箱 env 与文件存在，回固定 JSON。
    std::fs::write(
        &bin,
        format!(
            "#!/bin/sh\ntest -f \"$PI_CODING_AGENT_DIR/models.yml\" && echo ok > \"{}\"\
             \nprintf '%s\\n' '{{\"models\":[{{\"selector\":\"acme/fast\",\"name\":\"快 \\\"新\\\" \\\\ 名\",\
             \"contextWindow\":2000,\"maxTokens\":200,\"reasoning\":false,\"input\":[\"text\"],\
             \"cost\":{{\"input\":0.5,\"output\":2,\"cacheRead\":0.01,\"cacheWrite\":0}}}}]}}'\n",
            seen.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let new_text = apply_patch_to_text(sample(), "acme", "fast", &patch_all()).unwrap();
    validate_with(
        &bin,
        &new_text,
        "acme",
        "fast",
        &patch_all(),
        run_sandbox_omp,
    )
    .unwrap();
    assert!(seen.exists(), "假 omp 应看到沙箱 models.yml");
}

#[test]
fn update_end_to_end_backups_and_atomic_rewrite() {
    let _guard = crate::omp_cli::subprocess_test_guard();
    let dir = tempfile::tempdir().unwrap();
    let yml = dir.path().join("models.yml");
    fs::write(&yml, sample()).unwrap();
    let revision = revision_of(sample().as_bytes());
    // 旧备份 12 份：写后只留最新 10 份。
    for day in 1..=12 {
        fs::write(
            dir.path()
                .join(format!("models.yml.omp-resume.202610{day:02}T120000Z.bak")),
            b"old",
        )
        .unwrap();
    }
    let request = ModelSpecPatchRequest {
        provider: "acme".to_owned(),
        id: "fast".to_owned(),
        patch: ModelSpecPatch {
            max_tokens: Some(300),
            ..Default::default()
        },
        expected_revision: revision.clone(),
    };
    // 先行校验逻辑等价：用纯函数链模拟 update（真 update 会调 sandbox_validate）。
    let text = String::from_utf8(fs::read(&yml).unwrap()).unwrap();
    let new_text = apply_patch_to_text(&text, "acme", "fast", &request.patch).unwrap();
    check_sandbox_output(
        "{\"models\":[{\"selector\":\"acme/fast\",\"contextWindow\":1000,\"maxTokens\":300,\
         \"cost\":{\"input\":0.3,\"output\":1.2,\"cacheRead\":0.006,\"cacheWrite\":0}}]}\n",
        "acme",
        "fast",
        &request.patch,
    )
    .unwrap();
    let backup = backup_existing(&yml, text.as_bytes()).unwrap();
    atomic_write(&yml, new_text.as_bytes()).unwrap();
    // 备份内容为原文、0600；新文件 0600；旧备份被剪到 10 份。
    assert_eq!(fs::read(&backup).unwrap(), sample().as_bytes());
    assert_eq!(
        backup.metadata().unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(yml.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    let backups: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| name.ends_with(".bak"))
        .collect();
    assert_eq!(backups.len(), 10, "{backups:?}");
    assert!(backups
        .iter()
        .all(|name| name.as_str() > "models.yml.omp-resume.20261002T120000Z.bak"));
    // revision 变化且读回一致。
    let reread = fs::read(&yml).unwrap();
    assert_ne!(revision_of(&reread), revision);
    let text = String::from_utf8(reread).unwrap();
    let lines = split_lines(&text);
    let span = locate_model(&lines, "acme", "fast").unwrap();
    assert_eq!(
        read_spec(&lines, &span, "acme", "fast").max_tokens,
        Some(300)
    );
    // CONFLICT：revision 对不上拒绝。
    let busy = OmpBusy::default();
    let bin = dir.path().join("no-omp-here");
    let error = update_model_spec_impl(
        &bin,
        &busy,
        &yml,
        &ModelSpecPatchRequest {
            expected_revision: revision,
            ..request.clone()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    // BUSY：门禁被占拒绝。
    let _held = busy.try_acquire().unwrap();
    let current = revision_of(&fs::read(&yml).unwrap());
    let error = update_model_spec_impl(
        &bin,
        &busy,
        &yml,
        &ModelSpecPatchRequest {
            expected_revision: current,
            ..request.clone()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::Busy);
}

#[test]
fn zero_indent_multi_item_list_reads_and_patches_each() {
    // N1：零额外缩进多项不再截断列表；逐项可读可写、互不串改。
    let yml = "providers:\n  acme:\n    models:\n    - id: a\n      contextWindow: 1\n    - id: b\n      contextWindow: 2\n    - id: c\n      contextWindow: 3\n";
    let specs = read_all_specs(yml, true).unwrap();
    assert_eq!(
        specs.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["a", "b", "c"]
    );
    for (id, old, new) in [("b", 2u64, 20u64), ("c", 3u64, 30u64)] {
        let out = apply_patch_to_text(
            yml,
            "acme",
            id,
            &ModelSpecPatch {
                context_window: Some(new),
                ..Default::default()
            },
        )
        .unwrap();
        // 仅目标行变化，其余逐行一致。
        let old_lines: Vec<&str> = yml.lines().collect();
        let new_lines: Vec<&str> = out.lines().collect();
        assert_eq!(old_lines.len(), new_lines.len(), "{out}");
        let mut changed = 0;
        for (a, b) in old_lines.iter().zip(new_lines.iter()) {
            if a != b {
                changed += 1;
                assert_eq!(*a, format!("      contextWindow: {old}"));
                assert_eq!(*b, format!("      contextWindow: {new}"));
            }
        }
        assert_eq!(changed, 1, "{out}");
        // 读回新值。
        let specs = read_all_specs(&out, true).unwrap();
        assert_eq!(specs.len(), 3);
        assert_eq!(
            specs.iter().find(|s| s.id == id).unwrap().context_window,
            Some(new)
        );
    }
    // 正常深缩进列表行为不变：三项全读、改中间项只动一行。
    let yml = "providers:\n  acme:\n    models:\n      - id: a\n        contextWindow: 1\n      - id: b\n        contextWindow: 2\n      - id: c\n        contextWindow: 3\n";
    assert_eq!(read_all_specs(yml, true).unwrap().len(), 3);
    let out = apply_patch_to_text(
        yml,
        "acme",
        "b",
        &ModelSpecPatch {
            context_window: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(out.matches("contextWindow: 20").count(), 1, "{out}");
    assert!(out.contains("        contextWindow: 1\n"), "{out}");
    assert!(out.contains("        contextWindow: 3\n"), "{out}");
}

#[test]
fn anchored_inline_head_uses_continuation_indent() {
    // N2：`- &a id: fast` + 10 列字段（横线后两格紧凑对齐）→ 替换现行，不插重复行。
    let yml = "providers:\n  acme:\n    models:\n        - &a id: fast\n          contextWindow: 1\n          maxTokens: 100\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(out.matches("contextWindow").count(), 1, "{out}");
    assert!(out.contains("          contextWindow: 5\n"), "{out}");
    let specs = read_all_specs(&out, true).unwrap();
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].id, "fast");
    assert_eq!(specs[0].context_window, Some(5));
    assert_eq!(specs[0].max_tokens, Some(100));
    // 规范形（`- id: x` + 横线后两格字段）行为不变。
    let yml = "providers:\n  acme:\n    models:\n      - id: fast\n        contextWindow: 1\n";
    let out = apply_patch_to_text(
        yml,
        "acme",
        "fast",
        &ModelSpecPatch {
            context_window: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(out.matches("contextWindow").count(), 1, "{out}");
    assert!(out.contains("        contextWindow: 5\n"), "{out}");
}

#[test]
fn update_refuses_unsafe_target_before_backup() {
    // N4：符号链接/只读在备份前拒绝（假 omp 全程可用验证走到备份前），不留 .bak。
    let _guard = crate::omp_cli::subprocess_test_guard();
    let dir = tempfile::tempdir().unwrap();
    let json = dir.path().join("models.json");
    std::fs::write(
        &json,
        "{\"models\":[{\"selector\":\"acme/fast\",\"contextWindow\":1000,\"maxTokens\":300,\
         \"cost\":{\"input\":0.3,\"output\":1.2,\"cacheRead\":0.006,\"cacheWrite\":0}}]}\n",
    )
    .unwrap();
    let bin = dir.path().join("omp");
    std::fs::write(&bin, format!("#!/bin/sh\ncat \"{}\"\n", json.display())).unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let busy = OmpBusy::default();
    let revision = revision_of(sample().as_bytes());
    let request = || ModelSpecPatchRequest {
        provider: "acme".to_owned(),
        id: "fast".to_owned(),
        patch: ModelSpecPatch {
            max_tokens: Some(300),
            ..Default::default()
        },
        expected_revision: revision.clone(),
    };
    let bak_count = |dir: &Path| {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".bak"))
            .count()
    };
    // 符号链接：特定文案 + 无 .bak。
    let real = dir.path().join("real-models.yml");
    fs::write(&real, sample()).unwrap();
    let link = dir.path().join("models.yml");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    // （同一 dir 内假 omp 产物不影响 .bak 计数：只统计 *.bak。）
    let error = update_model_spec_impl(&bin, &busy, &link, &request()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Io, "{error:?}");
    assert!(error.message.contains("符号链接"), "{}", error.message);
    assert_eq!(bak_count(dir.path()), 0);
    assert_eq!(fs::read(&real).unwrap(), sample().as_bytes());
    // 只读目标：特定文案 + 无 .bak。
    let ro = dir.path().join("ro-models.yml");
    fs::write(&ro, sample()).unwrap();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o444)).unwrap();
    let error = update_model_spec_impl(&bin, &busy, &ro, &request()).unwrap_err();
    assert_eq!(error.code, ErrorCode::Io, "{error:?}");
    assert!(error.message.contains("只读"), "{}", error.message);
    assert_eq!(bak_count(dir.path()), 0);
    assert_eq!(fs::read(&ro).unwrap(), sample().as_bytes());
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o644)).unwrap();
}
