//! 合成 fixture 自验证（`#[ignore]`，手动跑）：
//!
//! ```sh
//! node scripts/fixtures/make-fixtures.mjs /tmp/omp-resume-fixtures
//! node scripts/fixtures/hold-lock.mjs /tmp/omp-resume-fixtures/owners <heldId> &
//! OMP_RESUME_SESSIONS_DIR=/tmp/omp-resume-fixtures/sessions \
//! OMP_RESUME_OWNERS_DIR=/tmp/omp-resume-fixtures/owners \
//! OMP_RESUME_MANIFEST=/tmp/omp-resume-fixtures/manifest.json \
//! cargo test --test fixtures -- --ignored --nocapture
//! kill %1
//! ```
//!
//! 逐项比对 manifest 已知真相。inUse 断言要求 holder 正在运行。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use omp_resume_lib::config::Config;
use omp_resume_lib::sessions;
use serde_json::Value;

fn env_path(key: &str) -> PathBuf {
    PathBuf::from(std::env::var(key).unwrap_or_else(|_| panic!("缺少环境变量 {key}")))
}

fn manifest() -> Value {
    let sessions_dir = env_path("OMP_RESUME_SESSIONS_DIR");
    let mpath = std::env::var("OMP_RESUME_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| sessions_dir.join("..").join("manifest.json"));
    let text = std::fs::read_to_string(&mpath)
        .unwrap_or_else(|_| panic!("读 manifest 失败：{}", mpath.display()));
    serde_json::from_str(&text).unwrap()
}

fn sstr(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}

#[test]
#[ignore]
fn fixture_manifest_check() {
    use std::time::Instant;
    let sessions_dir = env_path("OMP_RESUME_SESSIONS_DIR");
    let owners_dir = env_path("OMP_RESUME_OWNERS_DIR");
    let m = manifest();
    let cfg = Config {
        sessions_dir: sessions_dir.clone(),
        owners_dir,
    };

    let t0 = Instant::now();
    let listed = sessions::list::list_sessions(&cfg).unwrap();
    println!("list_ms={}", t0.elapsed().as_millis());

    // 分组数 / 顺序 / hiddenEmpty
    let groups = m["groups"].as_array().unwrap();
    assert_eq!(listed.groups.len(), groups.len(), "分组数");
    for (g, want) in listed.groups.iter().zip(groups.iter()) {
        assert_eq!(g.dir_name, want["dirName"].as_str().unwrap());
        let want_ids: Vec<&str> = want["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let got_ids: Vec<&str> = g.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(got_ids, want_ids, "组 {} 内顺序", g.dir_name);
    }
    assert_eq!(listed.hidden_empty, m["hiddenEmpty"].as_u64().unwrap());

    let want_sessions = m["sessions"].as_object().unwrap();
    let mut by_id: HashMap<&str, _> = HashMap::new();
    for g in &listed.groups {
        for s in &g.sessions {
            by_id.insert(s.id.as_str(), s);
        }
    }
    assert_eq!(by_id.len(), want_sessions.len(), "可见会话数");

    for (id, want) in want_sessions {
        let s = by_id
            .get(id.as_str())
            .unwrap_or_else(|| panic!("缺会话 {id}"));
        assert_eq!(s.title, sstr(&want["title"]), "{id} title");
        assert_eq!(
            s.branch_count,
            want["branchCount"].as_u64().unwrap(),
            "{id} branchCount"
        );
        assert_eq!(
            s.message_count,
            want["messageCount"].as_u64().unwrap(),
            "{id} messageCount"
        );
        assert_eq!(
            s.format_supported,
            want["formatSupported"].as_bool().unwrap(),
            "{id} format"
        );
        assert_eq!(
            s.version,
            want["version"].as_u64().map(|v| v as u32),
            "{id} version"
        );
        assert_eq!(
            s.bad_lines,
            want["badLines"].as_u64().unwrap(),
            "{id} badLines"
        );
        assert_eq!(
            s.cwd_exists,
            want["cwdExists"].as_bool().unwrap(),
            "{id} cwdExists"
        );
        assert_eq!(s.in_use, want["inUse"].as_bool().unwrap(), "{id} inUse");
        assert!(s.probe_ok, "{id} probeOk");
        if s.in_use {
            match &s.occupant {
                Some(o) => println!(
                    "occupant: {id} pid={} app={} version={}",
                    o.pid,
                    o.app.as_deref().unwrap_or("-"),
                    o.app_version.as_deref().unwrap_or("-"),
                ),
                None => println!("occupant: {id} None"),
            }
        } else {
            assert!(s.occupant.is_none(), "{id} 非占用会话 occupant 应为 null");
        }
        match (s.fork.as_ref(), want.get("fork")) {
            (None, None) | (None, Some(Value::Null)) => {}
            (Some(f), Some(w)) if !w.is_null() => {
                assert_eq!(f.parent_raw, sstr(&w["parentRaw"]), "{id} fork.raw");
                assert_eq!(
                    f.parent_title.as_deref(),
                    w["parentTitle"].as_str(),
                    "{id} fork.title"
                );
                match (f.parent_path.as_deref(), w.get("parentId")) {
                    (Some(_), Some(Value::String(pid))) => {
                        let want_file = want_sessions[pid.as_str()]["file"].as_str().unwrap();
                        assert!(
                            f.parent_path.as_ref().unwrap().ends_with(want_file),
                            "{id} fork.path"
                        );
                    }
                    (None, _) => {}
                    (Some(p), _) => panic!("{id} fork.path 应为 null，实为 {p}"),
                }
            }
            (a, b) => panic!("{id} fork 不一致：{a:?} vs {b:?}"),
        }
        // 路径落在 sessions 根下（根 canonicalize：/tmp 在 macOS 是符号链接）
        let canon_root = std::fs::canonicalize(&sessions_dir).unwrap();
        let rel = Path::new(s.path.as_str())
            .strip_prefix(&canon_root)
            .unwrap_or_else(|_| panic!("{id} 路径逃逸"));
        assert_eq!(
            rel.to_str().unwrap(),
            want["file"]
                .as_str()
                .unwrap()
                .strip_prefix("sessions/")
                .unwrap()
        );

        // 树 / 会话抽查
        if s.format_supported {
            if want.get("skipTree").is_none() {
                let p = PathBuf::from(&s.path);
                let t = sessions::tree::get_tree(&p).unwrap();
                assert_eq!(t.leaf_id.as_deref(), want["leafId"].as_str(), "{id} leaf");
                let want_path: Vec<String> = want["activePath"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(sstr)
                    .collect();
                assert_eq!(t.active_path_ids, want_path, "{id} activePath");
                if let Some(n) = want.get("convItems") {
                    let c = sessions::conversation::get_conversation(&p, None).unwrap();
                    assert_eq!(c.items.len() as u64, n.as_u64().unwrap(), "{id} convItems");
                    assert_eq!(c.target_id, c.leaf_id.unwrap(), "{id} target==leaf");
                }
            }
        } else {
            let p = PathBuf::from(&s.path);
            assert!(sessions::tree::get_tree(&p).is_err());
            assert!(sessions::conversation::get_conversation(&p, None).is_err());
        }
    }
    println!("fixture_manifest_check 通过：{} 会话", by_id.len());
}
