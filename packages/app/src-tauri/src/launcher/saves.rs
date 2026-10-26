//! 存档与备份的宿主面（§11；命令面 `launcher_save_*`）。
//!
//! ## 边界（与 `save-manager.ts` 的分工）
//!
//! TS 侧只"点菜"：`rootId` + 相对名 / `backupId` / `planId`，没有一条命令接受
//! "写到这里的绝对路径"。本模块负责**所有**落盘动作：
//!
//! 1. **备份只写 `backups/saves/`**：`{backupId}.zip`（条目名 = `{rootId}/{相对路径}`）+
//!    `{backupId}.json`（实例、时间、根、逐文件 sha256/字节、理由）。游戏目录一个字节都不动。
//! 2. **恢复**：解包（同一套 ZIP 守卫）→ 逐文件核哈希 → **先自动备份当前**（`backupCurrent`
//!    默认 true）→ 停游戏（未运行则继续）→ 逐文件「临时 + rename」。失败按 pre-restore 备份
//!    逆序写回（§11.3），写回也失败时在错误 detail 里明说"存档可能处于中间状态"。
//! 3. **导入两阶段**：`import` 只解到暂存 + 预检 + 做一份可回滚备份并返回计划；
//!    `apply_import` 才写。计划带有效期，用掉即作废。
//! 4. **导出**：落点只由原生保存对话框给（对话框即授权），写盘与对话框同在一条命令内。
//!
//! ## 写落点（§9.1）
//!
//! - `copy` 实例：`instances/{id}/game/{root.relativePath}`；
//! - `shared`：只认 `approvals.json` 里 `(instanceId, rootId)` 那条授权（`content::write_root`），
//!   没有 ⇒ `LAUNCHER_SOURCE_NOT_APPROVED`（不静默跳过）。
//!
//! ## 备份保留策略（§11.2）
//!
//! `manual` / `auto` 两类按创建时间**最旧先删**、只保留 `DEFAULT_SAVE_BACKUP_KEEP` 份；
//! `pre-restore` / `pre-plugin`（安全回退点）不占用户配额、永不自动删。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::archive_guard::{self, StagingLimits};
use super::content::{self, parse_iso_ms};
use super::error::{internal, io_failure, ErrorCode, LauncherErrorDto, LauncherResult};
use super::paths::{self, LauncherLayout};
use super::store::{self, StoredInstance};
use super::tasks::{self, TaskDto};
use super::trust;
use super::{iso_from_unix_ms, iso_now, unix_ms, LauncherHost};

/* ------------------------------- 常量 ------------------------------- */

/// 备份元数据的结构版本。
pub const SAVE_SCHEMA_VERSION: u32 = 1;
/// 用户配额：`manual` / `auto` 备份最多保留多少份（§11.2 的 20 份）。
pub const DEFAULT_SAVE_BACKUP_KEEP: usize = 20;
/// 导入计划有效期（与内容包同一档：预检与确认之间不持有实例锁）。
pub const IMPORT_PLAN_TTL_MS: u128 = 10 * 60 * 1000;

const PLAN_FILE: &str = "plan.json";
const STAGING_CONTAINER: &str = "save.zip";
const STAGING_UNPACKED: &str = "unpacked";
const META_SUFFIX: &str = ".json";
const ZIP_SUFFIX: &str = ".zip";
/// 只在保留策略里豁免的安全回退理由。
const SAFETY_REASONS: [&str; 2] = ["pre-restore", "pre-plugin"];

/* ------------------------------- DTO ------------------------------- */

/// `SaveEntry`（`path` 相对对应 saveRoot）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEntryDto {
    pub path: String,
    pub root_id: String,
    pub name: String,
    pub bytes: u64,
    pub mtime_ms: u64,
}

/// 一个 saveRoot 的宿主读数（`approved` = 是否已在 `approvals.json` 里授权写入）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRootStateDto {
    pub root_id: String,
    pub approved: bool,
    pub exists: bool,
}

/// `launcher_save_list` 的返回：条目 + 逐根授权读数（TS `HostSaveListing`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveListingDto {
    pub entries: Vec<SaveEntryDto>,
    pub roots: Vec<SaveRootStateDto>,
    pub warnings: Vec<String>,
}

/// `SaveBackup`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveBackupDto {
    pub id: String,
    pub instance_id: String,
    pub created_at: String,
    pub label: String,
    pub bytes: u64,
    pub entry_count: u64,
    pub reason: String,
}

/// 根内的一条文件引用（`SaveBackupRequest.entries` / `SaveExportRequest.entries`）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileRefDto {
    pub root_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveBackupRequestDto {
    pub label: Option<String>,
    pub reason: Option<String>,
    pub entries: Option<Vec<SaveFileRefDto>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SaveExportRequestDto {
    pub label: Option<String>,
    pub entries: Option<Vec<SaveFileRefDto>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RestoreOptionsDto {
    pub backup_current: Option<bool>,
}

/// `SaveImportPlan` + 宿主可选读数（条目数 / 总字节 / 过期时刻）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImportPlanDto {
    pub plan_id: String,
    pub backup_id: String,
    pub overwrites: Vec<String>,
    pub warnings: Vec<String>,
    pub entry_count: u64,
    pub total_bytes: u64,
    pub expires_at: String,
}

/// `ConflictResolution`（导入只用 `skip` / `overwrite`；`replace` 在存档面没有对象）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResolutionDto {
    pub root_id: String,
    pub path: String,
    pub action: String,
}

/* ------------------------------- 落盘文档 ------------------------------- */

/// `backups/saves/{backupId}.json`：备份的元数据（ZIP 里放不下的东西都在这里）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveBackupMeta {
    schema_version: u32,
    id: String,
    instance_id: String,
    created_at: String,
    label: String,
    reason: String,
    bytes: u64,
    entry_count: u64,
    files: Vec<BackupFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileEntry {
    root_id: String,
    path: String,
    sha256: String,
    bytes: u64,
}

/// 导入计划（`staging/{planId}/plan.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredImportPlan {
    schema_version: u32,
    instance_id: String,
    created_at: String,
    expires_at: String,
    backup_id: String,
    overwrites: Vec<String>,
    warnings: Vec<String>,
    files: Vec<BackupFileEntry>,
}

/* ------------------------------- 小工具 ------------------------------- */

fn new_plan_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // 与内容包计划（`plan-c-`）分前缀，见 `content::new_plan_id`
    format!(
        "plan-s-{}-{}",
        super::session_stamp().to_lowercase(),
        COUNTER.fetch_add(1, Ordering::SeqCst) % 1000
    )
}

fn new_backup_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!(
        "bk-{}-{}",
        super::session_stamp().to_lowercase(),
        COUNTER.fetch_add(1, Ordering::SeqCst) % 1000
    )
}

fn default_staging_limits() -> LauncherResult<StagingLimits> {
    let contract = archive_guard::zip_roundtrip_contract()
        .map_err(|e| internal("ZIP 往返契约表不可用").detail(e))?;
    Ok(StagingLimits {
        max_entries: contract.limits.max_entries,
        max_depth: contract.limits.max_depth,
        max_unpacked_bytes: contract.limits.max_unpacked_bytes,
    })
}

fn archive_error(detail: String) -> LauncherErrorDto {
    let lower = detail.to_lowercase();
    if lower.contains("entries-limit")
        || lower.contains("bytes-limit")
        || lower.contains("path-depth")
    {
        return LauncherErrorDto::new(ErrorCode::ArchiveLimit, "导入包超出解包限额，已中止")
            .detail(detail);
    }
    if lower.contains("path-dotdot") || lower.contains("path-absolute") || lower.contains("path-drive")
    {
        return LauncherErrorDto::new(ErrorCode::PathEscape, "导入包内的路径越出了存档根，已拒绝")
            .detail(detail);
    }
    LauncherErrorDto::new(
        ErrorCode::ArchiveInvalid,
        "导入包不是可安全解开的 ZIP",
    )
    .detail(detail)
}

fn backup_meta_path(layout: &LauncherLayout, instance_id: &str, backup_id: &str) -> LauncherResult<PathBuf> {
    if !paths::valid_component(backup_id) {
        return Err(LauncherErrorDto::new(ErrorCode::PathEscape, "备份 id 形状非法")
            .detail(format!("backupId={backup_id}")));
    }
    Ok(layout
        .save_backups_dir(instance_id)?
        .join(format!("{backup_id}{META_SUFFIX}")))
}

fn backup_zip_path(layout: &LauncherLayout, instance_id: &str, backup_id: &str) -> LauncherResult<PathBuf> {
    if !paths::valid_component(backup_id) {
        return Err(LauncherErrorDto::new(ErrorCode::PathEscape, "备份 id 形状非法")
            .detail(format!("backupId={backup_id}")));
    }
    Ok(layout
        .save_backups_dir(instance_id)?
        .join(format!("{backup_id}{ZIP_SUFFIX}")))
}

fn read_backup_meta(
    layout: &LauncherLayout,
    instance_id: &str,
    backup_id: &str,
) -> LauncherResult<Option<SaveBackupMeta>> {
    let meta = store::read_json::<SaveBackupMeta>(
        &backup_meta_path(layout, instance_id, backup_id)?,
        "存档备份元数据",
    )?;
    if let Some(meta) = meta.as_ref() {
        for file in &meta.files {
            content::guard_file_ref(&file.root_id, &file.path, "备份元数据")?;
        }
    }
    Ok(meta)
}

/// 一个根的**声明落点**（`game/{relativePath}`；不要求授权——列目录要用它）。
fn declared_root(
    instance: &StoredInstance,
    layout: &LauncherLayout,
    root_id: &str,
) -> LauncherResult<PathBuf> {
    let spec = instance
        .save_roots
        .iter()
        .find_map(|spec| {
            let parsed: content::ContentRootSpecDto = serde_json::from_value(spec.clone()).ok()?;
            (parsed.id == root_id).then_some(parsed)
        })
        .ok_or_else(|| {
            LauncherErrorDto::new(ErrorCode::SourceNotApproved, "实例里没有这个存档根")
                .detail(format!("rootId={root_id}"))
        })?;
    let relative = spec.relative_path.trim();
    let game_root = instance.game_root(layout)?;
    if relative.is_empty() {
        return Ok(game_root);
    }
    paths::resolve_relative(&game_root, relative)
}

/// 一个根在**本实例上**的真实落点：已授权就用授权目录，否则退回声明目录（只读用）。
fn read_root(
    instance: &StoredInstance,
    layout: &LauncherLayout,
    root_id: &str,
) -> LauncherResult<(PathBuf, bool)> {
    let approved = store::approved_write_root(layout, &instance.id, root_id)?;
    if instance.isolation == "copy" {
        return Ok((declared_root(instance, layout, root_id)?, true));
    }
    match approved {
        Some(path) => Ok((path, true)),
        None => Ok((declared_root(instance, layout, root_id)?, false)),
    }
}

/// 根下所有普通文件（posix 相对名 + 绝对路径 + 字节 + mtime；reparse point 不跟随）。
struct RootFile {
    relative: String,
    absolute: PathBuf,
    bytes: u64,
    mtime_ms: u64,
}

fn walk_root(root: &Path, warnings: &mut Vec<String>) -> Vec<RootFile> {
    let mut out = Vec::new();
    let mut skipped = 0usize;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let Ok(entry) = entry else {
            skipped += 1;
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let relative = rel.to_string_lossy().replace('\\', "/");
        if paths::normalize_relative(&relative).is_err() {
            skipped += 1;
            continue;
        }
        let meta = entry.metadata().ok();
        let bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(RootFile {
            relative,
            absolute: entry.path().to_path_buf(),
            bytes,
            mtime_ms,
        });
    }
    if skipped > 0 {
        warnings.push(format!(
            "有 {skipped} 个文件无法纳入存档视图（路径非法 / 读不动），已跳过"
        ));
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    out
}

/// 一条选择（`{rootId, path}`）→ (根落点, 目标绝对路径, posix 相对名)。
/// **只做相对名 + 根内前缀**，不接受绝对路径输入。
fn resolve_selection(
    instance: &StoredInstance,
    layout: &LauncherLayout,
    file: &SaveFileRefDto,
) -> LauncherResult<(PathBuf, PathBuf, String)> {
    let (root_path, _) = read_root(instance, layout, &file.root_id)?;
    let relative = paths::normalize_relative(&file.path)?;
    let target = paths::resolve_relative(&root_path, &relative)?;
    paths::assert_no_reparse_between(&root_path, &target)?;
    Ok((root_path, target, relative))
}

/// 选择集：空 = 全部根下全部文件。
fn collect_selection(
    instance: &StoredInstance,
    layout: &LauncherLayout,
    entries: Option<&Vec<SaveFileRefDto>>,
    warnings: &mut Vec<String>,
) -> LauncherResult<Vec<(String, String, PathBuf, u64)>> {
    let mut out: Vec<(String, String, PathBuf, u64)> = Vec::new();
    match entries {
        Some(list) if !list.is_empty() => {
            for file in list {
                let (_, target, relative) = resolve_selection(instance, layout, file)?;
                if !target.is_file() {
                    warnings.push(format!(
                        "选中的存档已不存在：{}/{}",
                        file.root_id, file.path
                    ));
                    continue;
                }
                let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
                out.push((file.root_id.clone(), relative, target, bytes));
            }
        }
        _ => {
            for spec in &instance.save_roots {
                let Some(root_id) = store::root_spec_id(spec) else {
                    continue;
                };
                // 备份 / 导出只**读**存档根：授权管的是写，读不受它约束（未授权也能备份）
                let (root_path, _) = read_root(instance, layout, root_id)?;
                if !root_path.is_dir() {
                    continue;
                }
                for file in walk_root(&root_path, warnings) {
                    out.push((
                        root_id.to_string(),
                        file.relative,
                        file.absolute,
                        file.bytes,
                    ));
                }
            }
        }
    }
    Ok(out)
}

/// 我们自己的备份 / 导出条目名也必须是**能再解回来**的名字（同一套条目闸）。
fn assert_entry_name(name: &str, limits: &StagingLimits) -> LauncherResult<()> {
    let problem = archive_guard::entry_contract_problem(
        name,
        name.as_bytes(),
        Some(0x0800), // 我们写 UTF-8 名（bit 11 恒置位）
        limits.max_depth,
    );
    match problem {
        None => Ok(()),
        Some(code) => Err(LauncherErrorDto::new(
            ErrorCode::PathEscape,
            "这个存档文件的路径无法安全地打进备份 / 导出包",
        )
        .detail(format!("{name}（{code}）"))),
    }
}

/// 写一个 ZIP（条目名 → 源文件）。先写临时文件再 rename（不留半截包）。
fn write_zip(dest: &Path, entries: &[(String, PathBuf)]) -> LauncherResult<u64> {
    let parent = dest.parent().ok_or_else(|| {
        internal("导出落点没有父目录").detail(dest.display().to_string())
    })?;
    std::fs::create_dir_all(parent).map_err(|e| io_failure("创建导出目录", parent, &e))?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "saves".to_string());
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = parent.join(format!(
        ".{name}.{}-{}-{}.tmp",
        std::process::id(),
        unix_ms(),
        TMP_SEQ.fetch_add(1, Ordering::SeqCst) % 1000
    ));
    let outcome = (|| -> std::io::Result<u64> {
        let file = std::fs::File::create(&tmp)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        for (entry, source) in entries {
            writer.start_file(entry.as_str(), options)?;
            let mut input = std::fs::File::open(source)?;
            std::io::copy(&mut input, &mut writer)?;
        }
        let file = writer.finish()?;
        file.sync_all()?;
        Ok(std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0))
    })();
    match outcome {
        Ok(bytes) => {
            std::fs::rename(&tmp, dest).map_err(|e| io_failure("落盘 ZIP", dest, &e))?;
            Ok(bytes)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(io_failure("写 ZIP 临时文件", &tmp, &err))
        }
    }
}

/* ------------------------------- 列表 ------------------------------- */

pub fn list(host: &Arc<LauncherHost>, instance_id: &str) -> LauncherResult<SaveListingDto> {
    let layout = host.layout.clone();
    let instance = store::load_instance(&layout, instance_id)?;
    let mut warnings: Vec<String> = Vec::new();
    let mut entries: Vec<SaveEntryDto> = Vec::new();
    let mut roots: Vec<SaveRootStateDto> = Vec::new();
    for spec in &instance.save_roots {
        let Some(root_id) = store::root_spec_id(spec) else {
            continue;
        };
        let (root_path, approved) = read_root(&instance, &layout, root_id)?;
        roots.push(SaveRootStateDto {
            root_id: root_id.to_string(),
            approved,
            exists: root_path.is_dir(),
        });
        if !root_path.is_dir() {
            continue;
        }
        for file in walk_root(&root_path, &mut warnings) {
            let name = file
                .absolute
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            entries.push(SaveEntryDto {
                path: file.relative,
                root_id: root_id.to_string(),
                name,
                bytes: file.bytes,
                mtime_ms: file.mtime_ms,
            });
        }
    }
    entries.sort_by(|a, b| a.root_id.cmp(&b.root_id).then_with(|| a.path.cmp(&b.path)));
    Ok(SaveListingDto {
        entries,
        roots,
        warnings,
    })
}

/* ------------------------------- 备份 ------------------------------- */

pub fn backups(host: &Arc<LauncherHost>, instance_id: &str) -> LauncherResult<Vec<SaveBackupDto>> {
    let layout = host.layout.clone();
    store::load_instance(&layout, instance_id)?;
    let dir = layout.save_backups_dir(instance_id)?;
    let mut out: Vec<SaveBackupDto> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|ext| ext != "json").unwrap_or(true) {
                continue;
            }
            let Some(meta) = store::read_json::<SaveBackupMeta>(&path, "存档备份元数据")? else {
                continue;
            };
            out.push(SaveBackupDto {
                id: meta.id,
                instance_id: meta.instance_id,
                created_at: meta.created_at,
                label: meta.label,
                bytes: meta.bytes,
                entry_count: meta.entry_count,
                reason: meta.reason,
            });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Ok(out)
}

fn normalize_reason(reason: Option<&str>) -> String {
    match reason.unwrap_or("manual") {
        "manual" | "auto" | "pre-restore" | "pre-plugin" => reason.unwrap_or("manual").to_string(),
        _ => "manual".to_string(),
    }
}

/// 建一份备份（**只写 `backups/saves/`**）。`reason` 由调用方给（命令面只受 `manual`/`auto`）。
fn create_backup(
    host: &Arc<LauncherHost>,
    instance: &StoredInstance,
    label: Option<String>,
    reason: &str,
    entries: Option<&Vec<SaveFileRefDto>>,
) -> LauncherResult<SaveBackupDto> {
    let layout = host.layout.clone();
    let limits = default_staging_limits()?;
    let mut warnings: Vec<String> = Vec::new();
    let selection = collect_selection(instance, &layout, entries, &mut warnings)?;
    if selection.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::Internal,
            "没有可备份的存档文件",
        )
        .detail(format!("instance={}", instance.id)));
    }
    let backup_id = new_backup_id();
    let created_at = iso_now();
    let mut zip_entries: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<BackupFileEntry> = Vec::new();
    let mut total: u64 = 0;
    for (root_id, relative, absolute, bytes) in selection {
        let name = format!("{root_id}/{relative}");
        assert_entry_name(&name, &limits)?;
        let digest = trust::sha256_file(&absolute)?;
        total = total.saturating_add(digest.size);
        files.push(BackupFileEntry {
            root_id,
            path: relative,
            sha256: digest.sha256,
            bytes,
        });
        zip_entries.push((name, absolute));
    }
    let zip_path = backup_zip_path(&layout, &instance.id, &backup_id)?;
    write_zip(&zip_path, &zip_entries)?;
    let meta = SaveBackupMeta {
        schema_version: SAVE_SCHEMA_VERSION,
        id: backup_id.clone(),
        instance_id: instance.id.clone(),
        created_at: created_at.clone(),
        label: label
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| format!("手动备份（{} 个文件）", files.len())),
        reason: reason.to_string(),
        bytes: total,
        entry_count: files.len() as u64,
        files,
    };
    if let Err(err) = store::write_json(&meta_path_for(&zip_path, &backup_id), &meta) {
        // 元数据写不出 ⇒ 这份 ZIP 不可用（不能让它"看起来能恢复"）
        let _ = std::fs::remove_file(&zip_path);
        return Err(err);
    }
    prune_backups(&layout, &instance.id, DEFAULT_SAVE_BACKUP_KEEP)?;
    host.emit_instance_change("updated", &instance.id);
    Ok(SaveBackupDto {
        id: meta.id,
        instance_id: meta.instance_id,
        created_at: meta.created_at,
        label: meta.label,
        bytes: meta.bytes,
        entry_count: meta.entry_count,
        reason: meta.reason,
    })
}

fn meta_path_for(zip_path: &Path, backup_id: &str) -> PathBuf {
    let parent = zip_path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{backup_id}{META_SUFFIX}"))
}

/// 保留策略：`manual` / `auto` 超额时**从最旧删起**；安全回退点不占配额（§11.2）。
pub fn prune_backups(layout: &LauncherLayout, instance_id: &str, keep: usize) -> LauncherResult<usize> {
    if keep == 0 {
        return Ok(0);
    }
    let dir = layout.save_backups_dir(instance_id)?;
    let mut quota: Vec<SaveBackupMeta> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|ext| ext != "json").unwrap_or(true) {
                continue;
            }
            let Some(meta) = store::read_json::<SaveBackupMeta>(&path, "存档备份元数据")? else {
                continue;
            };
            if SAFETY_REASONS.contains(&meta.reason.as_str()) {
                continue;
            }
            quota.push(meta);
        }
    }
    quota.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    if quota.len() <= keep {
        return Ok(0);
    }
    let excess = quota.len() - keep;
    let mut removed = 0;
    for victim in quota.into_iter().take(excess) {
        if !paths::valid_component(&victim.id) {
            continue;
        }
        let _ = std::fs::remove_file(backup_zip_path(layout, instance_id, &victim.id)?);
        let _ = std::fs::remove_file(backup_meta_path(layout, instance_id, &victim.id)?);
        removed += 1;
    }
    Ok(removed)
}

/// `launcher_save_backup`：备份（只写实例备份目录，不需要写授权）。
pub fn backup(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    req: SaveBackupRequestDto,
) -> LauncherResult<TaskDto> {
    let layout = host.layout.clone();
    let _flight = content::flight_enter(
        &format!("save:{instance_id}:backup"),
        "同一实例的存档备份正在进行",
        format!("instance={instance_id}"),
    )?;
    let task = tasks::begin(host, Some(instance_id), "save-backup");
    let cancel = task.cancel.clone();
    let outcome = (|| -> LauncherResult<SaveBackupDto> {
        let instance = store::load_instance(&layout, instance_id)?;
        if instance.save_roots.is_empty() {
            return Err(LauncherErrorDto::new(
                ErrorCode::PlatformUnsupported,
                "该游戏未声明存档目录，存档操作不可用",
            )
            .detail(format!("instance={instance_id}")));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(LauncherErrorDto::new(ErrorCode::TaskCancelled, "已取消：未做任何改动"));
        }
        create_backup(
            host,
            &instance,
            req.label,
            &normalize_reason(req.reason.as_deref()),
            req.entries.as_ref(),
        )
    })();
    match outcome {
        Ok(backup) => {
            let result = json!({ "backupId": backup.id, "backup": backup });
            Ok(tasks::succeed(host, task.dto, result, "存档已备份"))
        }
        Err(err) if err.code == ErrorCode::TaskCancelled.as_str() => {
            Err(task_error(tasks::cancel_task(host, task.dto, &err.message)))
        }
        Err(err) => Err(task_error(tasks::fail(host, task.dto, err))),
    }
}

fn task_error(dto: TaskDto) -> LauncherErrorDto {
    dto.error.unwrap_or_else(|| {
        LauncherErrorDto::new(ErrorCode::Internal, "存档操作未完成").detail(format!("task={}", dto.id))
    })
}

/* ------------------------------- 恢复 ------------------------------- */

/// 解一份备份到实例暂存并逐条核哈希（**恢复 / 导入共用的唯一解包路径**）。
fn extract_backup(
    zip_path: &Path,
    into: &Path,
    limits: &StagingLimits,
) -> LauncherResult<Vec<String>> {
    std::fs::create_dir_all(into).map_err(|e| io_failure("创建暂存目录", into, &e))?;
    let container = into.join(STAGING_CONTAINER);
    std::fs::copy(zip_path, &container).map_err(|e| io_failure("抄入暂存区", &container, &e))?;
    let extracted =
        archive_guard::extract_staging(into, STAGING_CONTAINER, STAGING_UNPACKED, limits)
            .map_err(archive_error)?;
    let _ = std::fs::remove_file(&container);
    Ok(extracted.entries.into_iter().map(|entry| entry.path).collect())
}

/// 把解出来的条目写回各自的存档根（先快照当前的，失败逆序放回）。
fn write_backup_files(
    instance: &StoredInstance,
    layout: &LauncherLayout,
    unpacked: &Path,
    files: &[BackupFileEntry],
    op_dir: &Path,
) -> LauncherResult<usize> {
    // 先把每个根都解析出来：一个根没授权就整体不写（不留半截）
    let mut written: Vec<(String, PathBuf, Option<PathBuf>)> = Vec::new();
    for file in files {
        let root = content::write_root(instance, layout, &file.root_id, true)?;
        let target = paths::resolve_relative(&root, &file.path)?;
        paths::assert_no_reparse_between(&root, &target)?;
        written.push((format!("{}/{}", file.root_id, file.path), target, None));
    }
    let mut done = 0usize;
    for (index, file) in files.iter().enumerate() {
        let source = paths::resolve_relative(unpacked, &format!("{}/{}", file.root_id, file.path))?;
        let bytes = std::fs::read(&source).map_err(|e| io_failure("读取备份内容", &source, &e))?;
        if trust::sha256_bytes(&bytes) != file.sha256 {
            return Err(LauncherErrorDto::new(
                ErrorCode::ArchiveInvalid,
                "备份包内容与元数据对不上，已中止恢复",
            )
            .detail(format!("{}/{}", file.root_id, file.path)));
        }
        let target = written[index].1.clone();
        if target.is_file() {
            let snapshot = op_dir.join(&file.root_id).join(&file.path);
            if let Some(parent) = snapshot.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| io_failure("创建快照目录", parent, &e))?;
            }
            std::fs::copy(&target, &snapshot)
                .map_err(|e| io_failure("写入当次快照", &snapshot, &e))?;
            written[index].2 = Some(snapshot);
        }
        store::atomic_write(&target, &bytes)?;
        done += 1;
    }
    Ok(done)
}

/// 回滚：用 `op_dir` 里的当次快照把刚才写过的文件放回去（逆序）。
fn rollback_writes(op_dir: &Path, files: &[BackupFileEntry], targets: &[(String, PathBuf)]) -> Vec<String> {
    let mut problems = Vec::new();
    for (index, file) in files.iter().enumerate().rev() {
        let snapshot = op_dir.join(&file.root_id).join(&file.path);
        let Some((label, target)) = targets.get(index) else {
            continue;
        };
        if snapshot.is_file() {
            match std::fs::read(&snapshot) {
                Ok(bytes) => {
                    if let Err(err) = store::atomic_write(target, &bytes) {
                        problems.push(format!("{label}：从快照恢复失败（{}）", err.message));
                    }
                }
                Err(err) => problems.push(format!("{label}：读快照失败（{err}）")),
            }
        } else if target.is_file() {
            if let Err(err) = std::fs::remove_file(target) {
                problems.push(format!("{label}：删除失败（{err}）"));
            }
        }
    }
    problems
}

/// `launcher_save_restore`：解包 → 核哈希 → 自动备份当前 → 停游戏 → 写回（§11.3）。
pub fn restore(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    backup_id: &str,
    opts: RestoreOptionsDto,
) -> LauncherResult<TaskDto> {
    let layout = host.layout.clone();
    let _flight = content::flight_enter(
        &format!("save:{instance_id}:restore"),
        "同一实例的存档恢复正在进行",
        format!("instance={instance_id}"),
    )?;
    let task = tasks::begin(host, Some(instance_id), "save-restore");
    let cancel = task.cancel.clone();
    let outcome = (|| -> LauncherResult<serde_json::Value> {
        let instance = store::load_instance(&layout, instance_id)?;
        let meta = read_backup_meta(&layout, instance_id, backup_id)?.ok_or_else(|| {
            LauncherErrorDto::new(ErrorCode::SaveRestoreFailed, "找不到这份存档备份")
                .detail(format!("backupId={backup_id}"))
        })?;
        if meta.instance_id != instance.id {
            return Err(LauncherErrorDto::new(
                ErrorCode::PathEscape,
                "这份备份不属于该实例，恢复已拒绝",
            )
            .detail(format!("backupId={backup_id}")));
        }
        if meta.schema_version > SAVE_SCHEMA_VERSION {
            return Err(LauncherErrorDto::new(
                ErrorCode::SchemaUnsupported,
                "备份版本高于本应用支持的版本，请升级应用",
            )
            .detail(format!("schemaVersion={}", meta.schema_version)));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(LauncherErrorDto::new(ErrorCode::TaskCancelled, "已取消：未做任何改动"));
        }

        // [1] 先自动备份当前（没有回退点的写回不做）
        let auto_backup = if opts.backup_current.unwrap_or(true) {
            Some(create_backup(
                host,
                &instance,
                Some(format!("恢复前自动备份（{}）", meta.label)),
                "pre-restore",
                None,
            )?)
        } else {
            None
        };

        // [2] 停游戏（未运行则继续）
        content::ensure_stopped(host, instance_id)?;

        // [3] 解包 + 逐条核哈希
        let limits = default_staging_limits()?;
        let stamp = format!("{}-{:04}", super::session_stamp(), host.next_seq() % 10_000);
        let staging = layout.staging_plan_dir(instance_id, &format!("restore-{stamp}"))?;
        let result = (|| -> LauncherResult<serde_json::Value> {
            extract_backup(
                &backup_zip_path(&layout, instance_id, backup_id)?,
                &staging,
                &limits,
            )?;
            let unpacked = staging.join(STAGING_UNPACKED);
            let op_dir = layout
                .save_backups_dir(instance_id)?
                .join(format!("rollback-{stamp}"));
            let mut targets: Vec<(String, PathBuf)> = Vec::new();
            for file in &meta.files {
                let root = content::write_root(&instance, &layout, &file.root_id, true)?;
                let target = paths::resolve_relative(&root, &file.path)?;
                targets.push((format!("{}/{}", file.root_id, file.path), target));
            }
            let written = match write_backup_files(&instance, &layout, &unpacked, &meta.files, &op_dir) {
                Ok(count) => count,
                Err(err) => {
                    let problems = rollback_writes(&op_dir, &meta.files, &targets);
                    let _ = std::fs::remove_dir_all(&op_dir);
                    let detail = if problems.is_empty() {
                        err.detail.unwrap_or_default()
                    } else {
                        format!(
                            "{} · 回滚未完全成功：{}",
                            err.detail.unwrap_or_default(),
                            problems.join("；")
                        )
                    };
                    return Err(LauncherErrorDto::new(
                        ErrorCode::SaveRestoreFailed,
                        "恢复存档失败，已按恢复前的状态回滚",
                    )
                    .detail(detail));
                }
            };
            let _ = std::fs::remove_dir_all(&op_dir);
            Ok(json!({
                "backupId": backup_id,
                "instanceId": instance_id,
                "restored": written,
                "autoBackupId": auto_backup.as_ref().map(|item| item.id.clone()),
            }))
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result
    })();
    match outcome {
        Ok(result) => Ok(tasks::succeed(host, task.dto, result, "存档已恢复")),
        Err(err) if err.code == ErrorCode::TaskCancelled.as_str() => {
            Err(task_error(tasks::cancel_task(host, task.dto, &err.message)))
        }
        Err(err) => Err(task_error(tasks::fail(host, task.dto, err))),
    }
}

/* ------------------------------- 删除备份 ------------------------------- */

pub fn delete_backup(host: &Arc<LauncherHost>, instance_id: &str, backup_id: &str) -> LauncherResult<()> {
    let layout = host.layout.clone();
    store::load_instance(&layout, instance_id)?;
    let meta = read_backup_meta(&layout, instance_id, backup_id)?.ok_or_else(|| {
        LauncherErrorDto::new(ErrorCode::PathEscape, "这份备份不属于该实例，删除已拒绝")
            .detail(format!("backupId={backup_id}"))
    })?;
    if meta.instance_id != instance_id {
        return Err(LauncherErrorDto::new(
            ErrorCode::PathEscape,
            "这份备份不属于该实例，删除已拒绝",
        )
        .detail(format!("backupId={backup_id}")));
    }
    let zip = backup_zip_path(&layout, instance_id, backup_id)?;
    if zip.exists() {
        std::fs::remove_file(&zip).map_err(|e| io_failure("删除备份包", &zip, &e))?;
    }
    std::fs::remove_file(backup_meta_path(&layout, instance_id, backup_id)?)
        .map_err(|e| io_failure("删除备份元数据", &zip, &e))?;
    host.emit_instance_change("updated", instance_id);
    Ok(())
}

/* ------------------------------- 导入 ------------------------------- */

/// `launcher_save_import`：解到暂存 + 预检 + 做一份可回滚备份（**不写存档根**）。
pub fn plan_import(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    archive_path: &str,
) -> LauncherResult<SaveImportPlanDto> {
    let layout = host.layout.clone();
    let instance = store::load_instance(&layout, instance_id)?;
    if instance.save_roots.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::PlatformUnsupported,
            "该游戏未声明存档目录，存档操作不可用",
        )
        .detail(format!("instance={instance_id}")));
    }
    layout.ensure_instance_dirs(instance_id)?;
    let archive = super::content::validate_archive_argument(archive_path)?;
    let limits = default_staging_limits()?;
    let plan_id = new_plan_id();
    let staging = layout.staging_plan_dir(instance_id, &plan_id)?;
    if staging.exists() {
        return Err(internal("暂存目录已存在，未复用").detail(staging.display().to_string()));
    }
    let outcome = (|| -> LauncherResult<SaveImportPlanDto> {
        let entries = extract_backup(&archive, &staging, &limits)?;
        let unpacked = staging.join(STAGING_UNPACKED);
        let mut files: Vec<BackupFileEntry> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut overwrites: Vec<String> = Vec::new();
        let mut total: u64 = 0;
        let mut seen = std::collections::BTreeSet::new();
        for name in &entries {
            // 条目名 = `{rootId}/{path}`（与备份包同一约定）
            let (root_id, path) = name.split_once('/').ok_or_else(|| {
                LauncherErrorDto::new(
                    ErrorCode::ArchiveInvalid,
                    "导入包里的条目不是「存档根/相对路径」形态，已拒绝",
                )
                .detail(name.clone())
            })?;
            if !instance
                .save_roots
                .iter()
                .any(|spec| store::root_spec_id(spec) == Some(root_id))
            {
                return Err(LauncherErrorDto::new(
                    ErrorCode::SourceNotApproved,
                    "导入包要写进一个未声明的存档根，已拒绝",
                )
                .detail(format!("rootId={root_id}（{name}）")));
            }
            let normalized = paths::normalize_relative(path)?;
            if !seen.insert(format!("{}/{}", root_id.to_lowercase(), normalized.to_lowercase())) {
                return Err(LauncherErrorDto::new(
                    ErrorCode::ArchiveInvalid,
                    "导入包里有重复的存档路径，已拒绝",
                )
                .detail(name.clone()));
            }
            let source = paths::resolve_relative(&unpacked, name)?;
            let digest = trust::sha256_file(&source)?;
            total = total.saturating_add(digest.size);
            let (root_path, _) = read_root(&instance, &layout, root_id)?;
            let target = paths::resolve_relative(&root_path, &normalized)?;
            if target.is_file() {
                overwrites.push(normalized.clone());
            }
            files.push(BackupFileEntry {
                root_id: root_id.to_string(),
                path: normalized,
                sha256: digest.sha256,
                bytes: digest.size,
            });
        }
        if files.is_empty() {
            return Err(LauncherErrorDto::new(
                ErrorCode::ArchiveInvalid,
                "导入包里没有任何存档文件，已拒绝",
            )
            .detail(plan_id.clone()));
        }
        // 可回滚点：导入前把当前存档备一份（安全回退，不占用户配额）
        let backup = create_backup(
            host,
            &instance,
            Some("导入前自动备份".to_string()),
            "pre-restore",
            None,
        )?;
        if !overwrites.is_empty() {
            warnings.push(format!("将覆盖 {} 个同名存档", overwrites.len()));
        }
        warnings.push(format!("导入包包含 {} 个条目、合计 {total} 字节", files.len()));
        let created = unix_ms();
        let stored = StoredImportPlan {
            schema_version: SAVE_SCHEMA_VERSION,
            instance_id: instance.id.clone(),
            created_at: iso_from_unix_ms(created),
            expires_at: iso_from_unix_ms(created + IMPORT_PLAN_TTL_MS),
            backup_id: backup.id.clone(),
            overwrites: overwrites.clone(),
            warnings: warnings.clone(),
            files,
        };
        store::write_json(&staging.join(PLAN_FILE), &stored)?;
        Ok(SaveImportPlanDto {
            plan_id,
            backup_id: backup.id,
            overwrites,
            warnings,
            entry_count: stored.files.len() as u64,
            total_bytes: total,
            expires_at: stored.expires_at,
        })
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    outcome
}

fn find_import_plan(
    layout: &LauncherLayout,
    plan_id: &str,
) -> LauncherResult<(String, StoredImportPlan, PathBuf)> {
    if !paths::valid_component(plan_id) {
        return Err(LauncherErrorDto::new(ErrorCode::PathEscape, "导入计划 id 形状非法")
            .detail(format!("planId={plan_id}")));
    }
    let mut hits = Vec::new();
    if let Ok(entries) = std::fs::read_dir(layout.instances_dir()) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let instance_id = entry.file_name().to_string_lossy().to_string();
            let Ok(dir) = layout.staging_plan_dir(&instance_id, plan_id) else {
                continue;
            };
            if !dir.is_dir() {
                continue;
            }
            let Some(stored) =
                store::read_json::<StoredImportPlan>(&dir.join(PLAN_FILE), "存档导入计划")?
            else {
                continue;
            };
            for file in &stored.files {
                content::guard_file_ref(&file.root_id, &file.path, "导入计划")?;
            }
            hits.push((instance_id, stored, dir));
        }
    }
    match hits.len() {
        0 => Err(LauncherErrorDto::new(
            ErrorCode::Internal,
            "导入计划不存在或已使用，请重新预检",
        )
        .detail(format!("planId={plan_id}"))
        .with_retryable(true)),
        1 => Ok(hits.remove(0)),
        _ => Err(internal("同一个导入计划出现在多个实例的暂存区，已拒绝")
            .detail(format!("planId={plan_id}"))),
    }
}

/// 决议：`skip` 不动，`overwrite` 才写；`replace` 在存档面没有对象 ⇒ 拒。
fn import_skips(
    plan: &StoredImportPlan,
    resolutions: Option<Vec<SaveResolutionDto>>,
) -> LauncherResult<std::collections::BTreeSet<String>> {
    let mut skips = std::collections::BTreeSet::new();
    let mut seen = std::collections::BTreeSet::new();
    for resolution in resolutions.unwrap_or_default() {
        let key = format!("{}/{}", resolution.root_id, resolution.path);
        if !seen.insert(key.clone()) {
            continue;
        }
        match resolution.action.to_lowercase().as_str() {
            "skip" => {
                skips.insert(key);
            }
            "overwrite" => {}
            other => {
                return Err(LauncherErrorDto::new(
                    ErrorCode::SaveRestoreFailed,
                    "导入决议的动作不合法，已拒绝",
                )
                .detail(format!("{key}：{other}")));
            }
        }
    }
    for key in &skips {
        if !plan
            .files
            .iter()
            .any(|file| format!("{}/{}", file.root_id, file.path) == *key)
        {
            return Err(LauncherErrorDto::new(
                ErrorCode::SaveRestoreFailed,
                "决议里有导入包之外的文件，已拒绝",
            )
            .detail(key.clone()));
        }
    }
    Ok(skips)
}

/// `launcher_save_apply_import`：把预检过的存档写回（计划一次性消费）。
pub fn apply_import(
    host: &Arc<LauncherHost>,
    plan_id: &str,
    resolutions: Option<Vec<SaveResolutionDto>>,
) -> LauncherResult<TaskDto> {
    let layout = host.layout.clone();
    let (instance_id, stored, staging) = find_import_plan(&layout, plan_id)?;
    let _flight = content::flight_enter(
        &format!("save:{instance_id}:import"),
        "同一实例的存档导入正在进行",
        format!("instance={instance_id} planId={plan_id}"),
    )?;
    let task = tasks::begin(host, Some(&instance_id), "save-import");
    let cancel = task.cancel.clone();
    let outcome = (|| -> LauncherResult<serde_json::Value> {
        let expires = parse_iso_ms(&stored.expires_at).ok_or_else(|| {
            LauncherErrorDto::new(ErrorCode::Internal, "导入计划缺少有效的过期时间，请重新预检")
                .detail(format!("planId={plan_id}"))
                .with_retryable(true)
        })?;
        if expires <= unix_ms() {
            return Err(LauncherErrorDto::new(ErrorCode::Internal, "导入计划已过期，请重新预检")
                .detail(format!("planId={plan_id} 过期于 {}", stored.expires_at))
                .with_retryable(true));
        }
        let instance = store::load_instance(&layout, &instance_id)?;
        if instance.id != stored.instance_id {
            return Err(internal("导入计划与实例不一致，已拒绝").detail(plan_id.to_string()));
        }
        let skips = import_skips(&stored, resolutions)?;
        let unpacked = staging.join(STAGING_UNPACKED);
        if !unpacked.is_dir() {
            return Err(LauncherErrorDto::new(
                ErrorCode::Internal,
                "导入暂存已失效，请重新预检",
            )
            .detail(unpacked.display().to_string()));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(LauncherErrorDto::new(ErrorCode::TaskCancelled, "已取消：未做任何改动"));
        }
        content::ensure_stopped(host, &instance_id)?;

        let todo: Vec<BackupFileEntry> = stored
            .files
            .iter()
            .filter(|file| !skips.contains(&format!("{}/{}", file.root_id, file.path)))
            .cloned()
            .collect();
        let stamp = format!("{}-{:04}", super::session_stamp(), host.next_seq() % 10_000);
        let op_dir = layout
            .save_backups_dir(&instance_id)?
            .join(format!("rollback-{stamp}"));
        let mut targets: Vec<(String, PathBuf)> = Vec::new();
        for file in &todo {
            let root = content::write_root(&instance, &layout, &file.root_id, true)?;
            let target = paths::resolve_relative(&root, &file.path)?;
            targets.push((format!("{}/{}", file.root_id, file.path), target));
        }
        let written = match write_backup_files(&instance, &layout, &unpacked, &todo, &op_dir) {
            Ok(count) => count,
            Err(err) => {
                let problems = rollback_writes(&op_dir, &todo, &targets);
                let _ = std::fs::remove_dir_all(&op_dir);
                let detail = if problems.is_empty() {
                    err.detail.unwrap_or_default()
                } else {
                    format!(
                        "{} · 回滚未完全成功：{}",
                        err.detail.unwrap_or_default(),
                        problems.join("；")
                    )
                };
                return Err(LauncherErrorDto::new(
                    ErrorCode::SaveRestoreFailed,
                    "导入失败，已按导入前的状态回滚",
                )
                .detail(detail));
            }
        };
        let _ = std::fs::remove_dir_all(&op_dir);
        host.emit_instance_change("updated", &instance_id);
        Ok(json!({
            "planId": plan_id,
            "instanceId": instance_id,
            "written": written,
            "skipped": skips.len(),
            "backupId": stored.backup_id,
        }))
    })();
    let _ = std::fs::remove_dir_all(&staging);
    match outcome {
        Ok(result) => Ok(tasks::succeed(host, task.dto, result, "存档已导入")),
        Err(err) if err.code == ErrorCode::TaskCancelled.as_str() => {
            Err(task_error(tasks::cancel_task(host, task.dto, &err.message)))
        }
        Err(err) => Err(task_error(tasks::fail(host, task.dto, err))),
    }
}

/* ------------------------------- 导出 ------------------------------- */

/// 导出（落点由原生对话框给；`dest` 是对话框返回值，这里只写、不再当参数传回来）。
pub fn export_to(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    req: SaveExportRequestDto,
    dest: &Path,
) -> LauncherResult<()> {
    let layout = host.layout.clone();
    let instance = store::load_instance(&layout, instance_id)?;
    let limits = default_staging_limits()?;
    let mut warnings: Vec<String> = Vec::new();
    let selection = collect_selection(&instance, &layout, req.entries.as_ref(), &mut warnings)?;
    if selection.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::Internal,
            "没有可导出的存档文件",
        )
        .detail(format!("instance={instance_id}")));
    }
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for (root_id, relative, absolute, _) in selection {
        let name = format!("{root_id}/{relative}");
        assert_entry_name(&name, &limits)?;
        entries.push((name, absolute));
    }
    write_zip(dest, &entries)?;
    Ok(())
}

/// 导出用的建议文件名（只是建议，用户可以在对话框里改）。
pub fn suggested_export_name(host: &Arc<LauncherHost>, instance_id: &str) -> String {
    let name = store::load_instance(&host.layout, instance_id)
        .map(|instance| instance.name)
        .unwrap_or_else(|_| instance_id.to_string());
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    format!("{}-saves-{}.zip", safe.trim(), super::session_stamp().to_lowercase())
}

/* ------------------------------- 测试辅助 ------------------------------- */

/// 测试用：给实例登记一个存档根（只写清单，不碰批准表）。
#[cfg(test)]
pub(crate) fn set_save_roots(
    layout: &LauncherLayout,
    instance_id: &str,
    roots: Vec<serde_json::Value>,
) -> LauncherResult<()> {
    let mut instance = store::load_instance(layout, instance_id)?;
    instance.save_roots = roots;
    store::save_instance(layout, &instance)
}
