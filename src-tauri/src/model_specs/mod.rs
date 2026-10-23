//! 模型规格编辑（CONTRACT §21 / §4.54–§4.55）：读写 omp 的
//! `models.yml`（`OMP_RESUME_MODELS_YML` 可覆盖），只改单个模型的非凭据规格字段。
//!
//! SECURITY：
//! - 该文件含明文 apiKey：绝不做 YAML 解析再整体重排（会复制/换行凭据），只做
//!   行级外科手术替换；错误信息里绝不出现文件内容、apiKey 或环境变量值；
//! - 读取只向 IPC 返回非凭据规格字段（provider/id/name/窗口/档位/input/费用）；
//! - 写入前必须先把新文本放沙箱目录，用真实 omp `models --json` 校验（fail-closed）；
//! - omp 缺失（无法校验）时拒绝写入（`OMP_NOT_FOUND`）；
//! - 写盘前先备份（0600，同目录保留最新 10 份），原子替换（同目录临时文件 +
//!   fsync + rename + 0600）。
//!
//! 注意：`omp models --json` 的 stdout/stderr 可能混有配置警告文本，解析失败或
//! 校验不匹配时只返回固定中文文案，不回显 omp 输出。

mod io;
mod validate;
mod yaml;

#[cfg(test)]
mod tests;

#[cfg(test)]
use {validate::*, yaml::*};

use io::{atomic_write, backup_existing, check_write_target, read_yml};
use validate::{sandbox_validate, validate_patch, validate_target};
use yaml::{apply_patch_to_text, read_all_specs};

use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use crate::model::{
    AppError, ErrorCode, ModelSpecPatch, ModelSpecPatchRequest, ModelSpecUpdateResult,
    ModelSpecsResult,
};
use crate::omp_cli::{omp_not_found, resolve_omp, OmpBusy};

pub use io::{
    resolve_models_yml, resolve_models_yml_with, revision_of, BACKUP_KEEP, MAX_YML_BYTES,
    MODELS_YML_ENV, PI_AGENT_DIR_ENV,
};

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, message)
}

fn io_error(message: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::Io, message)
}

fn conflict() -> AppError {
    AppError::new(
        ErrorCode::Conflict,
        "模型规格文件已被外部修改，请刷新后重试",
    )
}

/// 手动编辑提示：文件形状超出本编辑器的能力时请用户自行处理。
fn manual_edit(reason: &str) -> AppError {
    invalid(format!("{reason}，请手动编辑 models.yml"))
}

/// CONTRACT §4.54：读规格快照。文件缺失 → `available=false` 正常空状态；
/// 超大/不可读/形状异常 → `available=true` + `error` 中文说明（specs 为空）。
pub fn get_model_specs_impl(path: &Path) -> ModelSpecsResult {
    let display = path.to_string_lossy().into_owned();
    match read_yml(path) {
        Ok(None) => ModelSpecsResult {
            path: display,
            available: false,
            revision: "absent".to_owned(),
            specs: Vec::new(),
            error: None,
        },
        Ok(Some(bytes)) => {
            let revision = revision_of(&bytes);
            match String::from_utf8(bytes) {
                Err(_) => ModelSpecsResult {
                    path: display,
                    available: true,
                    revision,
                    specs: Vec::new(),
                    error: Some("模型规格文件不是合法 UTF-8，请手动修复".to_owned()),
                },
                Ok(text) => match read_all_specs(&text, false) {
                    Ok(specs) => ModelSpecsResult {
                        path: display,
                        available: true,
                        revision,
                        specs,
                        error: None,
                    },
                    Err(error) => ModelSpecsResult {
                        path: display,
                        available: true,
                        revision,
                        specs: Vec::new(),
                        error: Some(error.message),
                    },
                },
            }
        }
        Err(error) => ModelSpecsResult {
            path: display,
            available: true,
            revision: "unreadable".to_owned(),
            specs: Vec::new(),
            error: Some(error.message),
        },
    }
}

/// CONTRACT §4.55：读-比-沙箱校验-备份-原子写-复读。整体持有 `OmpBusy`。
pub fn update_model_spec_impl(
    bin: &Path,
    busy: &OmpBusy,
    path: &Path,
    request: &ModelSpecPatchRequest,
) -> Result<ModelSpecUpdateResult, AppError> {
    // 拒写前置：备份之前先排除符号链接与只读目标，不留无用 .bak。
    check_write_target(path)?;
    validate_target(&request.provider, &request.id)?;
    validate_patch(&request.patch)?;
    if request.expected_revision.trim().is_empty() {
        return Err(invalid("缺少 revision，请刷新后重试"));
    }
    // 读侧哨兵串（absent/unreadable）不是可用版本：报 INVALID 而非误导性 CONFLICT。
    if request.expected_revision == "absent" || request.expected_revision == "unreadable" {
        return Err(invalid("当前没有可用的规格文件版本，请刷新后重试"));
    }
    let _guard = busy.try_acquire()?;
    let existing = read_yml(path)?.ok_or_else(|| invalid("模型规格文件不存在"))?;
    if revision_of(&existing) != request.expected_revision {
        return Err(conflict());
    }
    let text = String::from_utf8(existing.clone())
        .map_err(|_| invalid("模型规格文件不是合法 UTF-8，请手动修复"))?;
    let new_text = apply_patch_to_text(&text, &request.provider, &request.id, &request.patch)?;
    // 无变化（补丁值与现值一致）→ 直接返回现规格，不写盘。
    if new_text == text {
        let spec = read_all_specs(&text, true)?
            .into_iter()
            .find(|spec| spec.provider == request.provider && spec.id == request.id)
            .ok_or_else(|| invalid("未找到指定的模型"))?;
        return Ok(ModelSpecUpdateResult {
            revision: request.expected_revision.clone(),
            spec,
            backup_path: String::new(),
        });
    }
    // 写前沙箱校验（omp 缺失由调用方保证 bin 存在；此处只做校验）。
    sandbox_validate(
        bin,
        &new_text,
        &request.provider,
        &request.id,
        &request.patch,
    )?;
    // 二次 revision 门（校验耗时，防并发外部改）。
    let recheck = read_yml(path)?.ok_or_else(|| invalid("模型规格文件不存在"))?;
    if revision_of(&recheck) != request.expected_revision {
        return Err(conflict());
    }
    let backup = backup_existing(path, &existing)?;
    if let Err(error) = atomic_write(path, new_text.as_bytes()) {
        // 写失败尽力保留备份（不回滚已建备份，由用户手动恢复）。
        let _ = backup;
        return Err(error);
    }
    let reread = read_yml(path)?.ok_or_else(|| io_error("写后复读失败：文件消失"))?;
    let revision = revision_of(&reread);
    let text =
        String::from_utf8(reread).map_err(|_| io_error("写后复读失败：文件不是合法 UTF-8"))?;
    let spec = read_all_specs(&text, true)?
        .into_iter()
        .find(|spec| spec.provider == request.provider && spec.id == request.id)
        .ok_or_else(|| io_error("写后复读失败：模型消失"))?;
    Ok(ModelSpecUpdateResult {
        revision,
        spec,
        backup_path: backup.to_string_lossy().into_owned(),
    })
}

/// CONTRACT §4.54：模型规格快照（只读，不占写门禁）。
#[tauri::command]
pub async fn get_model_specs() -> Result<ModelSpecsResult, AppError> {
    crate::blocking(|| Ok(get_model_specs_impl(&resolve_models_yml()))).await
}

/// CONTRACT §4.55：单个模型规格的读-比-校验-写。omp 缺失时拒绝写入。
#[tauri::command]
pub async fn update_model_spec(
    app: tauri::AppHandle,
    provider: String,
    id: String,
    patch: ModelSpecPatch,
    expected_revision: String,
) -> Result<ModelSpecUpdateResult, AppError> {
    crate::blocking(move || {
        use tauri::Manager;
        let busy = app.state::<OmpBusy>();
        let bin = resolve_omp().ok_or_else(omp_not_found)?;
        let request = ModelSpecPatchRequest {
            provider,
            id,
            patch,
            expected_revision,
        };
        update_model_spec_impl(&bin, &busy, &resolve_models_yml(), &request)
    })
    .await
}
