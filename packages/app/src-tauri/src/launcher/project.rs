//! 插件源码项目的宿主面（§7.2 `launcher_project_hash` / `launcher_project_extract`）。
//!
//! **两条命令都不认识插件语义**（§7.2 尾注 / ADR-0010 决策 3）：
//! - `hash` 只回答「这批字节的 SHA-256 是多少」——逐文件流式读（64 KiB 块），大二进制
//!   不整包读进 JS，也不整包读进本进程；
//! - `extract` 只按**内容包同一套** ZIP 守卫解到宿主暂存，再把 `pack.json` 原样读回。
//!   `plugin.json` 校验、`roots` 映射、`buildId`、drift 报告全在 TS 侧
//!   `PluginProjectService`；宿主不判「这是不是一个插件」。
//!
//! 三条边界（与 `mod.rs` 的文件头同源）：
//! 1. **`projectDir` 是输入根，不是写落点**：命令只读，且必须先过宿主写允许域判定
//!    （`crate::ensure_read_root_allowed` —— 复用 appData / 已注册项目根 / 常驻工作区根
//!    那三张表，**不新增第四套路径表**）；
//! 2. **条目一律先规范化再拼**：`paths::normalize_relative` 拒 `..` / 绝对路径 / 盘符 /
//!    UNC / ADS 冒号 / 保留名 / 尾点尾空格；拼完再做 canonicalize 前缀复核 + 逐段 reparse
//!    复核 ⇒ 符号链接 / junction 逃逸在**读到字节之前**被拒；
//! 3. **解包落点只由 `LauncherLayout` 拼**（`launcher/project-staging/{id}/`）：命令没有
//!    落点参数；失败清扫整个暂存目录，超过 TTL 的旧暂存由下一次解包顺手清掉。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::archive_guard::{self, StagingLimits};
use super::content::{self, PackManifestDto};
use super::error::{io_failure, ErrorCode, LauncherErrorDto, LauncherResult};
use super::paths;
use super::trust;
use super::{unix_ms, LauncherHost};

/// 解包暂存的存活时长（超过它的旧目录在下一次解包时被清掉）。
///
/// 为什么是 24 小时而不是内容包计划那 10 分钟：项目提取的**消费方**（TS 写进工作区）
/// 可能跨一次编辑器重启（计划台账在 core 侧是内存态），暂存被过早清掉会让「提取到一半
/// 重启」变成读不到字节的假故障；一天的窗口足以覆盖，又不至于让临时目录无限膨胀。
pub const PROJECT_STAGING_TTL_MS: u128 = 24 * 60 * 60 * 1000;

/// 解包容器名（必须过共享表的命名闸：小写 `[a-z0-9._-]` + `.zip` 后缀）。
const CONTAINER_NAME: &str = "pack.zip";
/// 解出目录（与实例暂存同名：都不带语义，只是「夹层目录」）。
const UNPACKED_NAME: &str = "unpacked";
/// 包内清单（`ContentPackManifest` 在 ZIP 根的唯一文件名）。
const MANIFEST_FILE: &str = "pack.json";

/* ------------------------------- DTO ------------------------------- */

/// 宿主 `launcher_project_hash` 的一条读数（`HostFileDigest`，§7.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDigestDto {
    /// 入参里那条**相对 `artifactDir`** 的路径（原样回显，消费方按它配对）。
    pub path: String,
    /// 小写十六进制 SHA-256（与 `ExecutableTrust.sha256` 同形）。
    pub sha256: String,
    pub size: u64,
}

/// `launcher_project_extract` 的逐条目读数（`HostProjectExtractEntry`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectExtractEntryDto {
    /// 包内路径（`{rootId}/{path}`；宿主已解到暂存目录下同名相对路径）。
    pub path: String,
    /// 条目类型：本命令只搬普通文件（符号链接 / 目录条目在 ZIP 守卫里就被拒了）。
    pub kind: &'static str,
    pub size: u64,
}

/// `launcher_project_extract` 的返回（`HostProjectExtractResult`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectExtractResultDto {
    /// 解包落点（读侧；消费方只读不写，也不删——暂存由宿主 TTL 清理）。
    pub staging_dir: String,
    pub manifest: PackManifestDto,
    pub entries: Vec<ProjectExtractEntryDto>,
}

/// `launcher_project_extract` 的 `opts`（三枚限额**必须由调用方从契约常量传入**）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectExtractOptionsDto {
    pub limits: StagingLimits,
}

/* --------------------------- 路径判据（摘要） --------------------------- */

fn escape(message: &str, detail: String) -> LauncherErrorDto {
    LauncherErrorDto::new(ErrorCode::PathEscape, message.to_string()).detail(detail)
}

/// 制品目录名：**单层**（`/'` 出现即拒），其余交给 `normalize_relative` 的统一口径。
fn artifact_name(raw: &str) -> LauncherResult<String> {
    let normalized = paths::normalize_relative(raw)?;
    if normalized.contains('/') {
        return Err(escape(
            "制品目录必须是项目根下的单层目录",
            format!("artifactDir={raw}"),
        ));
    }
    Ok(normalized)
}

/// `projectDir` 的形态闸 + 宿主写允许域判定（**命令层调用**；纯函数层只做项目内路径）。
///
/// 只读命令也要过写允许域：规格 §7.1 明确「`projectDir` 在宿主已登记的写允许域内」——
/// 判定复用那三张表，本函数不另立清单。路径先 canonicalize：域判定与后续前缀复核必须
/// 看同一份真实落点（`launcher_project_hash` 随后按规范路径拼条目）。
pub fn assert_project_root(app: &tauri::AppHandle, raw: &str) -> LauncherResult<PathBuf> {
    let path = PathBuf::from(raw);
    if raw.trim().is_empty() || raw.chars().any(|c| c.is_control()) {
        return Err(escape("没有给出有效的插件项目目录", raw.to_string()));
    }
    if !path.is_absolute() {
        return Err(escape("插件项目目录必须是本机绝对路径", raw.to_string()));
    }
    if raw.starts_with(r"\\") {
        return Err(escape("插件项目目录不能是网络路径", raw.to_string()));
    }
    let canonical = std::fs::canonicalize(&path).map_err(|e| {
        escape(
            "找不到这个插件项目目录",
            format!("{raw}：{e}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(escape(
            "插件项目目录不是一个目录",
            canonical.display().to_string(),
        ));
    }
    crate::ensure_read_root_allowed(app, &canonical, "读取插件项目").map_err(|detail| {
        escape(
            "插件项目不在编辑器可写的范围内（请从工作区根里选项目）",
            detail,
        )
    })?;
    Ok(canonical)
}

/* ------------------------------- 摘要 ------------------------------- */

/// 逐文件流式摘要（`launcher_project_hash` 的纯逻辑面；命令层已过写允许域）。
///
/// `entries` 是相对 `artifactDir` 的 POSIX 路径；返回值**按入参顺序**、`path` 原样回显
/// （消费方按它把摘要配回自己的收集表，而不是再猜一遍规范化后的写法）。
/// 任何一条越界 / 不存在 / 读不了 ⇒ 整批失败（fail-closed，不跳过、不返回半批）。
pub fn hash_project(
    project_dir: &Path,
    artifact_dir: &str,
    entries: &[String],
) -> LauncherResult<Vec<FileDigestDto>> {
    if !project_dir.is_absolute() {
        return Err(escape(
            "插件项目目录必须是本机绝对路径",
            project_dir.display().to_string(),
        ));
    }
    if !project_dir.is_dir() {
        return Err(escape(
            "插件项目目录不存在",
            project_dir.display().to_string(),
        ));
    }
    let artifact = artifact_name(artifact_dir)?;
    let artifact_root = paths::resolve_relative(project_dir, &artifact)?;
    if !artifact_root.is_dir() {
        return Err(escape(
            "插件项目的制品目录不存在",
            artifact_root.display().to_string(),
        ));
    }
    // 制品目录本身也可能是指向项目外的 junction：规范路径复核 + 逐段 reparse 复核。
    paths::assert_inside_existing(project_dir, &artifact_root)?;
    paths::assert_no_reparse_between(project_dir, &artifact_root)?;

    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let rel = paths::normalize_relative(entry)?;
        let abs = paths::resolve_relative(&artifact_root, &rel)?;
        // 先判"在不在"再判"往哪指"：缺文件 / 目录 / 坏文件是读数问题（Internal），
        // 而 canonicalize 对不存在的目标只能报 PathEscape —— 顺序反了会把"缺文件"
        // 误报成"越界"（两者都是 fail-closed，但诊断码必须说真话）。
        if !abs.is_file() {
            return Err(LauncherErrorDto::new(
                ErrorCode::Internal,
                "插件项目里缺少要摘要的文件",
            )
            .detail(format!("{entry}（{}）", abs.display())));
        }
        // 文件级复核：符号链接指向项目外时，canonical 落点会离开制品根 ⇒ 这里拒。
        paths::assert_inside_existing(&artifact_root, &abs)?;
        paths::assert_no_reparse_between(&artifact_root, &abs)?;
        let digest = trust::sha256_file_labeled(&abs, "插件项目文件")?;
        out.push(FileDigestDto {
            path: entry.clone(),
            sha256: digest.sha256,
            size: digest.size,
        });
    }
    Ok(out)
}

/* ------------------------------- 解包 ------------------------------- */

fn new_staging_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // 前缀 `project-` 让项目暂存与实例暂存（`plan-c-` / `plan-s-`）永不同名。
    format!(
        "project-{}-{}",
        super::session_stamp().to_lowercase(),
        COUNTER.fetch_add(1, Ordering::SeqCst) % 1000
    )
}

/// 清掉超过 TTL 的旧暂存（只碰 `project-staging/` 下的直接子目录；失败只出声）。
fn sweep_stale(layout: &paths::LauncherLayout) {
    let root = layout.project_staging_root();
    let Ok(read) = std::fs::read_dir(&root) else {
        return;
    };
    let now = unix_ms();
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_dir() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis());
        let Some(modified) = modified else { continue };
        if now.saturating_sub(modified) > PROJECT_STAGING_TTL_MS {
            if let Err(e) = std::fs::remove_dir_all(&path) {
                eprintln!("[launcher] 旧项目暂存清理失败 {}：{e}", path.display());
            }
        }
    }
}

/// `launcher_project_extract` 的纯逻辑面：解到宿主暂存并交回逐条目读数。
///
/// 解包、路径闸、类型闸、限额闸、失败清扫全部复用 `archive_guard::extract_staging`
/// （与内容包 / 存档导入同一个守卫，**没有第二份 ZIP 解析**）。
pub fn extract_project(
    host: &Arc<LauncherHost>,
    archive_path: &str,
    opts: &ProjectExtractOptionsDto,
) -> LauncherResult<ProjectExtractResultDto> {
    // 输入件形态闸与内容包同一条（本机绝对路径、存在、是文件、非 UNC、无控制字符）。
    let archive = content::validate_archive_argument(archive_path)?;
    let layout = &host.layout;
    std::fs::create_dir_all(layout.project_staging_root()).map_err(|e| {
        io_failure("创建项目暂存目录", &layout.project_staging_root(), &e)
    })?;
    sweep_stale(layout);

    let staging = layout.project_staging_dir(&new_staging_id())?;
    let outcome = extract_into_staging(&staging, &archive, &opts.limits);
    if outcome.is_err() {
        // 失败一律清扫：暂存区不许留残壳（与内容包计划同口径）。
        if let Err(e) = std::fs::remove_dir_all(&staging) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[launcher] 项目暂存清理失败 {}：{e}", staging.display());
            }
        }
    }
    outcome
}

fn extract_into_staging(
    staging: &Path,
    archive: &Path,
    limits: &StagingLimits,
) -> LauncherResult<ProjectExtractResultDto> {
    std::fs::create_dir_all(staging)
        .map_err(|e| io_failure("创建项目暂存目录", staging, &e))?;
    let container = staging.join(CONTAINER_NAME);
    std::fs::copy(archive, &container)
        .map_err(|e| io_failure("抄入项目暂存区", &container, &e))?;
    let extracted = archive_guard::extract_staging(staging, CONTAINER_NAME, UNPACKED_NAME, limits)
        .map_err(|detail| content::archive_error_for("插件项目压缩包", detail))?;
    let _ = std::fs::remove_file(&container);

    let unpacked = staging.join(UNPACKED_NAME);
    let manifest_path = unpacked.join(MANIFEST_FILE);
    let manifest_bytes = std::fs::read(&manifest_path).map_err(|e| {
        LauncherErrorDto::new(ErrorCode::ArchiveInvalid, "插件项目压缩包里没有 pack.json")
            .detail(format!("{}：{e}", manifest_path.display()))
    })?;
    let manifest: PackManifestDto = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        LauncherErrorDto::new(ErrorCode::ArchiveInvalid, "pack.json 无法解析")
            .detail(e.to_string())
    })?;

    // `pack.json` 是清单而不是载荷：消费方按 `{rootId}/{path}` 分组，把它掺进去会被判成
    // 「条目路径非法」。其余条目一律报 `file`——符号链接 / 目录条目在守卫里已经拒了。
    let entries: Vec<ProjectExtractEntryDto> = extracted
        .entries
        .into_iter()
        .filter(|entry| entry.path != MANIFEST_FILE)
        .map(|entry| ProjectExtractEntryDto {
            path: entry.path,
            kind: "file",
            size: entry.bytes,
        })
        .collect();
    if entries.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "插件项目压缩包里没有可提取的文件",
        )
        .detail(archive.display().to_string()));
    }

    Ok(ProjectExtractResultDto {
        staging_dir: unpacked.to_string_lossy().to_string(),
        manifest,
        entries,
    })
}
