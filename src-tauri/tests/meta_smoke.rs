//! 会话备注 meta.json 真实读写冒烟（`#[ignore]`，手动跑）：
//!
//! ```sh
//! OMP_RESUME_DATA_DIR=/tmp/omp-resume-meta-smoke \
//!   cargo test --test meta_smoke -- --ignored --nocapture
//! ```
//!
//! 只用 `OMP_RESUME_DATA_DIR` 指向的目录，绝不碰
//! `~/Library/Application Support/omp-resume`。

use std::fs;
use std::os::unix::fs::PermissionsExt;

use omp_resume_lib::meta::{data_dir, prune_session_after_delete};
use omp_resume_lib::model::SessionMetaInput;

fn env_dir() -> std::path::PathBuf {
    std::env::var("OMP_RESUME_DATA_DIR")
        .expect("需要 OMP_RESUME_DATA_DIR 指向临时目录")
        .into()
}

#[test]
#[ignore]
fn real_roundtrip_write_0600_and_delete_prune() {
    let dir = env_dir();
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(
        data_dir().unwrap(),
        dir,
        "data_dir 未采用 OMP_RESUME_DATA_DIR"
    );

    let input = SessionMetaInput {
        alias: Some("冒烟别名".into()),
        tags: vec!["smoke".into(), "SMOKE".into()],
        note: Some("冒烟备注".into()),
    };
    let snap =
        omp_resume_lib::meta::set_session_meta_impl(&dir, "smoke-id", Some(input), 0).unwrap();
    assert_eq!(snap.revision, 1);
    assert_eq!(snap.sessions["smoke-id"].tags, vec!["smoke"]);

    let path = dir.join("meta.json");
    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "meta.json 权限应为 0600");
    println!("meta.json 已写入：{}（权限 0600）", path.display());
    println!("{}", fs::read_to_string(&path).unwrap());

    // 删除联动：走真实 env 路径清理条目。
    std::env::set_var("OMP_RESUME_DATA_DIR", &dir);
    prune_session_after_delete("smoke-id");
    std::env::remove_var("OMP_RESUME_DATA_DIR");
    let snap = omp_resume_lib::meta::get_meta_impl(&dir).unwrap();
    assert_eq!(snap.revision, 2);
    assert!(snap.sessions.is_empty(), "删除后条目应被联动清除");
    println!("删除联动清理成功：revision={}", snap.revision);
}
