use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::model::AppError;

use super::{invalid, io_error};

pub const MODELS_YML_ENV: &str = "OMP_RESUME_MODELS_YML";
/// 沙箱校验用的 omp 环境根目录变量名（omp 读 `<dir>/models.yml`）。
pub const PI_AGENT_DIR_ENV: &str = "PI_CODING_AGENT_DIR";
/// 文件大小上限（2 MiB）。
pub const MAX_YML_BYTES: u64 = 2 * 1024 * 1024;
/// 备份保留份数（按名倒序取最新）。
pub const BACKUP_KEEP: usize = 10;
/// 备份文件名缀。
const BACKUP_MARK: &str = ".omp-resume.";
const BACKUP_SUFFIX: &str = ".bak";
pub(super) const MODELS_YML_NAME: &str = "models.yml";

/// 解析 models.yml 路径（`_with` 可注入环境与 HOME，便于单测）。
/// 相对路径的 `OMP_RESUME_MODELS_YML` 按当前目录 absolutize（`parent()` 为 `Some("")`
/// 会让建目录报错含糊，故此处先转绝对）。
pub fn resolve_models_yml_with(env: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if let Some(path) = env(MODELS_YML_ENV).filter(|p| !p.trim().is_empty()) {
        let path = PathBuf::from(path.trim());
        if path.is_absolute() {
            return path;
        }
        return std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path);
    }
    if let Some(dir) = env(PI_AGENT_DIR_ENV).filter(|p| !p.trim().is_empty()) {
        return PathBuf::from(dir.trim()).join(MODELS_YML_NAME);
    }
    home.join(".omp/agent/models.yml")
}

pub fn resolve_models_yml() -> PathBuf {
    resolve_models_yml_with(
        |key| std::env::var_os(key).map(|value| value.to_string_lossy().into_owned()),
        &crate::util::home_dir(),
    )
}

/// 文件字节的 SHA256 十六进制（revision）。
pub fn revision_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 读取 models.yml（大小上限 2 MiB；缺失返回 None）。
pub(super) fn read_yml(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() as u64 > MAX_YML_BYTES {
                return Err(invalid("模型规格文件过大（超过 2 MiB），请手动编辑"));
            }
            Ok(Some(bytes))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(format!("无法读取模型规格文件：{error}"))),
    }
}

/// 备份文件名时间戳：UTC 紧凑 `YYYYMMDDTHHMMSSZ`（同秒冲突递增）。
fn pick_backup_name(dir: &Path) -> Result<String, AppError> {
    let mut moment = chrono::Utc::now();
    for _ in 0..120 {
        let name = format!(
            "{MODELS_YML_NAME}{BACKUP_MARK}{}Z.bak",
            moment.format("%Y%m%dT%H%M%S")
        );
        // 形如 `models.yml.omp-resume.20261021T120000Z.bak`。
        if fs::symlink_metadata(dir.join(&name)).is_err() {
            return Ok(name);
        }
        moment += chrono::Duration::seconds(1);
    }
    Err(io_error("无法生成备份文件名"))
}

/// 备份现有文件（0600），保留最新 10 份（按名倒序），返回备份路径。
pub(super) fn backup_existing(path: &Path, bytes: &[u8]) -> Result<PathBuf, AppError> {
    let dir = path.parent().ok_or_else(|| io_error("模型规格路径无效"))?;
    let name = pick_backup_name(dir)?;
    let backup = dir.join(&name);
    (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&backup)?;
        file.write_all(bytes)?;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.sync_all()?;
        Ok(())
    })()
    .map_err(|e| io_error(format!("无法备份模型规格文件：{e}")))?;
    prune_backups(dir);
    Ok(backup)
}

/// 剪掉旧备份（同目录 `models.yml.omp-resume.*.bak` 只留最新 10 个；失败静默）。
fn prune_backups(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{MODELS_YML_NAME}{BACKUP_MARK}");
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| name.starts_with(&prefix) && name.ends_with(BACKUP_SUFFIX))
        .collect();
    names.sort();
    names.reverse();
    for extra in names.into_iter().skip(BACKUP_KEEP) {
        let _ = fs::remove_file(dir.join(extra));
    }
}

/// 写目标前置检查：符号链接与只读一律拒绝（update 入口与 atomic_write 双处设防）。
pub(super) fn check_write_target(path: &Path) -> Result<(), AppError> {
    // 符号链接拒绝：rename 会把链接换成普通文件，不断用户 dotfiles 布局。
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(io_error("models.yml 是符号链接，请手动编辑或改用真实路径"));
    }
    // 只读目标拒绝：尊重用户的锁定意图，不静默覆盖。
    if fs::metadata(path).is_ok_and(|meta| meta.permissions().readonly()) {
        return Err(io_error("模型规格文件为只读，请手动解除后重试"));
    }
    Ok(())
}

/// 原子替换：同目录临时文件（0600）+ fsync + rename + 0600。
pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    // 纵深设防：与 update 入口同一检查（备份后仍可能被换链/加锁，写前复检）。
    check_write_target(path)?;
    use crate::util::{AtomicStage, PendingAtomic};
    let pending =
        PendingAtomic::stage(path, bytes, "models.yml", None).map_err(|(stage, error)| {
            match (stage, error.kind()) {
                (AtomicStage::Create, ErrorKind::InvalidInput) => io_error("模型规格路径无效"),
                (AtomicStage::Create, _) => io_error(format!("无法创建规格临时文件：{error}")),
                (AtomicStage::Write, _) => io_error(format!("无法写入模型规格：{error}")),
                (AtomicStage::Chmod, _) => io_error(format!("无法设置规格文件权限：{error}")),
                (AtomicStage::Sync, _) => io_error(format!("无法同步模型规格：{error}")),
                (AtomicStage::Rename, _) => io_error(format!("无法原子替换模型规格：{error}")),
            }
        })?;
    pending
        .commit(path)
        .map_err(|(_, error)| io_error(format!("无法原子替换模型规格：{error}")))?;
    // 临时文件创建即 0600，rename 保留权限：此 chmod 尽力而为，失败不报错。
    let _ = fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(())
}
