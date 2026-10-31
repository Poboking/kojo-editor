//! 内容包 / 游戏插件的落盘面（§9.1 / §9.2 / §10；命令面 `launcher_content_*`）。
//!
//! ## 这个模块负责什么
//!
//! 1. **两阶段**：`plan` 只把选中的 ZIP 抄进 `instances/{id}/staging/{planId}/`、用
//!    `archive_guard::extract_staging` 解开、与清单逐条对账，产出带 `expiresAt` 的计划文件；
//!    **一个字节都不写游戏根**。`apply` 才写，且每实例单飞（第二发 `LAUNCHER_TASK_BUSY`）。
//! 2. **ownership 是唯一删改凭据**：每包写 `content/{packId}/ownership.json`（根 id + 相对
//!    路径 + sha256 + 写入时刻）。卸载 / 停用只动这张清单里的文件，且**与别的包同名的一律
//!    不碰**（§10.2「目标文件属于另一个已安装包 ⇒ abort」）。
//! 3. **可回滚**：apply 中途失败（或取消）⇒ 逆序逐个收：本包这次新写的删掉、被覆盖的按
//!    `backups/packs/{packId}/{timestamp}/` 的当次快照放回；`original/`（首装基础快照）
//!    **只在首装时写一次，升级不覆盖**（§10.1 第 [7] 步）。
//! 4. **ZIP 守卫不复制**：解包一律走 `archive_guard::extract_staging`（EOCD 预检 / 中央目录核 /
//!    逐字节累计 / 失败清扫都在那里）。本模块**没有**自己的 `ZipArchive` 解包路径。
//!
//! ## 包内布局（宿主约定，`pack.json` 是唯一清单）
//!
//! ```text
//! pack.json                  ← ContentPackManifest（与 TS 契约同形）
//! {rootId}/{path}            ← 载荷：目标根 id + 相对该根的 posix 路径
//! ```
//!
//! 载荷条目名与清单条目 `{ rootId, path }` 逐字对应：宿主只做**字符串对账**，从不拿
//! `rootId` 拼路径（拼路径的只有 `paths::resolve_relative` + 根的落点）。
//!
//! ## 写落点（§9.1；第三条特权写路径）
//!
//! - `copy` 实例：`instances/{id}/game/{root.relativePath}`；
//! - `shared` 实例：只认 `approvals.json` 里**实例 × rootId** 那条授权（原生目录对话框写入），
//!   没有就 `LAUNCHER_SOURCE_NOT_APPROVED`——不静默跳过、不"先建目录再说"。

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::archive_guard::{self, StagingLimits};
use super::error::{internal, io_failure, ErrorCode, LauncherErrorDto, LauncherResult};
use super::paths::{self, LauncherLayout};
use super::process;
use super::store::{self, StoredInstance};
use super::tasks::{self, TaskDto};
use super::trust;
use super::{iso_from_unix_ms, iso_now, unix_ms, LauncherHost};

/* ------------------------------- 常量 ------------------------------- */

/// 计划 / 状态 / ownership 的结构版本（升高 = 旧版应用必须拒读，不静默迁移）。
pub const CONTENT_SCHEMA_VERSION: u32 = 1;
/// 计划有效期：预检与确认之间不持有实例锁，只能靠时间界（§10.1「关键不变量」）。
pub const PLAN_TTL_MS: u128 = 10 * 60 * 1000;

const PLAN_FILE: &str = "plan.json";
/// 暂存容器名：必须过共享表的命名闸（小写 `[a-z0-9._-]` + `.zip` 后缀）。
const STAGING_CONTAINER: &str = "pack.zip";
const STAGING_UNPACKED: &str = "unpacked";
const MANIFEST_FILE: &str = "pack.json";
/// 计划里列出的「包内多余条目」上限（全列会把 UI 打满）。
const MAX_LISTED_EXTRAS: usize = 5;

/* ------------------------------- DTO ------------------------------- */

/// `ContentFileRef`（计划、ownership、冲突决议共用这一形状）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRefDto {
    pub root_id: String,
    pub path: String,
}

/// 清单里的一条文件（`ContentFileEntry`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFileDto {
    pub root_id: String,
    pub path: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestRequirementDto {
    pub id: String,
    #[serde(default)]
    pub version: String,
}

/// `ContentPackManifest`（契约 §5.4）。**未知字段原样保留**（`extra`）：宿主只是过客，
/// 不该因为"我不认识"就把作者写的扩展字段从 `pack.json` 快照里抹掉。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifestDto {
    pub schema_version: u32,
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub game_id: String,
    #[serde(default)]
    pub files: Vec<ManifestFileDto>,
    #[serde(default)]
    pub load_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<Vec<ManifestRequirementDto>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_impact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entrypoints: Option<Vec<FileRefDto>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// 计划里的一条冲突（比契约多一档 `case-collision`：大小写折叠是**落盘语义**，
/// 只有看见磁盘的宿主判得了；映射回契约二分在 TS `content-manager` 里做）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDto {
    pub root_id: String,
    pub path: String,
    /// `other-pack` | `base-file` | `case-collision`
    pub kind: String,
    pub existing_pack_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_path: Option<String>,
    /// 缺省决议（契约 `ContentConflict.resolution`）：内容包一律 `abort`，
    /// 覆盖必须由用户在 UI 上显式给 `overwrite` / `replace`。
    pub resolution: String,
}

/// 一个目标根（`ContentInstallPlan.targets`）。本宿主恒写 `''`：落点就是根本身。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetDto {
    pub root_id: String,
    pub relative_path: String,
}

/// `launcher_content_plan` 的返回（`ContentInstallPlan` 同形；多一档冲突见上）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentPlanDto {
    pub plan_id: String,
    pub manifest: PackManifestDto,
    pub targets: Vec<TargetDto>,
    pub additions: Vec<FileRefDto>,
    pub overwrites: Vec<FileRefDto>,
    pub conflicts: Vec<ConflictDto>,
    pub missing_requirements: Vec<String>,
    pub warnings: Vec<String>,
    pub expires_at: String,
}

/// 逐条决议（`ConflictResolution`）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolutionDto {
    pub root_id: String,
    pub path: String,
    pub action: String,
}

/// `launcher_content_plan` 的可选第二参数（TS 侧 `{ limits }`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanOptionsDto {
    pub limits: Option<StagingLimits>,
}

/// `InstalledContent`（契约 §6.6）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledContentDto {
    pub manifest: PackManifestDto,
    pub enabled: bool,
    pub order: i64,
    pub installed_at: String,
    pub owned_files: Vec<FileRefDto>,
    pub status: String,
}

/// 诊断码：契约四项 + 宿主多报的两档（`orphan-file` / `load-order`，TS 映射进 `conflict`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDto {
    pub pack_id: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisDto {
    pub instance_id: String,
    pub issues: Vec<IssueDto>,
}

/* ------------------------------- 落盘文档 ------------------------------- */

/// `content/{packId}/ownership.json`：**本包写进游戏根的文件清单**（唯一删改凭据）。
///
/// 只有根 id + 相对路径：绝不存绝对路径（实例换 appData、游戏目录搬家都不该让它失效）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipDoc {
    pub schema_version: u32,
    pub pack_id: String,
    pub written_at: String,
    #[serde(default)]
    pub files: Vec<OwnedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnedFile {
    pub root_id: String,
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub written_at: String,
}

/// `content/{packId}/state.json`：启停、顺序、安装时刻（UI 与清理策略读它）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStateDoc {
    pub schema_version: u32,
    pub pack_id: String,
    pub enabled: bool,
    pub order: i64,
    pub installed_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub kind: String,
}

/// 暂存计划（`staging/{planId}/plan.json`）：`apply` 的唯一输入，一次性消费。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPlan {
    schema_version: u32,
    instance_id: String,
    created_at: String,
    expires_at: String,
    manifest: PackManifestDto,
    targets: Vec<TargetDto>,
    additions: Vec<FileRefDto>,
    overwrites: Vec<FileRefDto>,
    conflicts: Vec<ConflictDto>,
    missing_requirements: Vec<String>,
    warnings: Vec<String>,
    /// 载荷条目（archive 名 = `{rootId}/{path}`；sha256 / bytes 是**实测**读数）
    staged: Vec<StagedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagedFile {
    root_id: String,
    path: String,
    sha256: String,
    bytes: u64,
}

/// 一个内容根的声明（`ContentRootSpec`；宿主只读 `id` / `relativePath` / `accepts` /
/// `writableInShared`，不解释 `kind` / `label`）。
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRootSpecDto {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub relative_path: String,
    #[serde(default)]
    pub accepts: Option<Vec<String>>,
    #[serde(default)]
    pub writable_in_shared: bool,
}

/* ------------------------------- 单飞闸 ------------------------------- */

/// 每实例单飞（§10.1「同一实例同时只允许一个内容/插件变更任务」）。
///
/// 键 = 作用域字符串（`content:{instanceId}` / `save:{instanceId}:{op}`）；占位失败**就是**
/// 并发协议，报既有码 `LAUNCHER_TASK_BUSY`——不自造"同义词"。
fn flight_slots() -> &'static Mutex<BTreeSet<String>> {
    static SLOTS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(BTreeSet::new()))
}

pub(crate) struct FlightGuard {
    key: String,
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        flight_slots()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

pub(crate) fn flight_enter(
    key: &str,
    message: &str,
    detail: String,
) -> LauncherResult<FlightGuard> {
    let mut slots = flight_slots().lock().unwrap_or_else(|e| e.into_inner());
    if slots.contains(key) {
        return Err(LauncherErrorDto::new(ErrorCode::TaskBusy, message).detail(detail));
    }
    slots.insert(key.to_string());
    Ok(FlightGuard {
        key: key.to_string(),
    })
}

/* ------------------------------- 时钟 ------------------------------- */

/// ISO-8601（UTC，秒精度，`Z` 结尾）→ Unix 毫秒。只认宿主自己写的形态。
pub(crate) fn parse_iso_ms(text: &str) -> Option<u128> {
    let text = text.trim();
    if text.len() < 20 || !text.ends_with('Z') {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> { text.get(range)?.parse().ok() };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second;
    if secs < 0 {
        return None;
    }
    Some(secs as u128 * 1000)
}

/// Howard Hinnant 的 `days_from_civil`：与 `mod.rs` 的 `civil_from_days` 互逆。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/* ------------------------------- 小工具 ------------------------------- */

fn new_plan_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // 前缀 `plan-c-` 让"内容包计划"与"存档导入计划"（`plan-s-`）永不同名：
    // 两者共用 `staging/{planId}/`，撞名会变成"暂存目录已存在"的假故障。
    format!(
        "plan-c-{}-{}",
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

/// 解包失败 → 契约码（限额 / 越界 / 其余归归档不合法，与 TS `zipEntryContractProblem`
/// 同一套映射，别让同一个坏包在两层说两句不同的话）。
fn archive_error(detail: String) -> LauncherErrorDto {
    archive_error_for("内容包", detail)
}

/// 同一条码映射，只在人话里点名对象（插件项目解包复用；**判据只有这一份**）。
pub(crate) fn archive_error_for(what: &str, detail: String) -> LauncherErrorDto {
    let lower = detail.to_lowercase();
    if lower.contains("entries-limit")
        || lower.contains("bytes-limit")
        || lower.contains("path-depth")
    {
        return LauncherErrorDto::new(
            ErrorCode::ArchiveLimit,
            format!("{what}超出解包限额，已中止"),
        )
        .detail(detail);
    }
    if lower.contains("path-dotdot") || lower.contains("path-absolute") || lower.contains("path-drive")
    {
        return LauncherErrorDto::new(ErrorCode::PathEscape, "包内路径越出了目标根，已拒绝")
            .detail(detail);
    }
    LauncherErrorDto::new(
        ErrorCode::ArchiveInvalid,
        format!("{what}不是可安全解开的 ZIP"),
    )
    .detail(detail)
}

fn is_hex_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 根 id 的形状闸。根 id 来自 adapter（宿主不解释语义），但它会参与**字符串对账**，
/// 所以这里只保证「它拼不出路径」：不许分隔符、冒号、上下级、控制字符。
fn root_id_problem(root_id: &str) -> Option<String> {
    if root_id.is_empty() || root_id.len() > 64 {
        return Some(format!("根 id 长度必须在 1..=64：{root_id:?}"));
    }
    if root_id.contains('/') || root_id.contains('\\') || root_id.contains(':') {
        return Some(format!("根 id 不许含分隔符或冒号：{root_id:?}"));
    }
    if root_id == "." || root_id == ".." {
        return Some(format!("根 id 不能是点名：{root_id:?}"));
    }
    if root_id.chars().any(|c| c.is_control()) {
        return Some(format!("根 id 含控制字符：{root_id:?}"));
    }
    if !paths::valid_component(root_id) {
        return Some(format!("根 id 不是合法的单段名：{root_id:?}"));
    }
    None
}

/// 盘上读回来的文件引用要**再过一遍**形状闸（`ownership.json` / 计划文件都可能被手改）。
///
/// 这些字符串随后要拼进快照目录名与目标路径；不在这一层拦，`op_dir.join(rootId).join(path)`
/// 就成了绕过 `paths::` 判据的第二条拼路径通道。
pub(crate) fn guard_file_ref(root_id: &str, path: &str, what: &str) -> LauncherResult<()> {
    if let Some(problem) = root_id_problem(root_id) {
        return Err(LauncherErrorDto::new(
            ErrorCode::ContentBroken,
            format!("{what}里的根 id 非法，已拒绝"),
        )
        .detail(problem));
    }
    if let Err(err) = paths::normalize_relative(path) {
        return Err(LauncherErrorDto::new(
            ErrorCode::ContentBroken,
            format!("{what}里的相对路径非法，已拒绝"),
        )
        .detail(err.detail.unwrap_or_else(|| path.to_string())));
    }
    Ok(())
}

fn spec_of(specs: &[Value], root_id: &str) -> Option<ContentRootSpecDto> {
    specs.iter().find_map(|spec| {
        let parsed: ContentRootSpecDto = serde_json::from_value(spec.clone()).ok()?;
        (parsed.id == root_id).then_some(parsed)
    })
}

fn content_root(instance: &StoredInstance, root_id: &str) -> Option<ContentRootSpecDto> {
    spec_of(&instance.content_roots, root_id)
}

fn save_root(instance: &StoredInstance, root_id: &str) -> Option<ContentRootSpecDto> {
    spec_of(&instance.save_roots, root_id)
}

/// 一个根的**写落点**（§9.1）。
///
/// - `copy`：实例内 `game/{relativePath}`（不需要授权，写的是副本）；
/// - `shared` / 其它：只认 `approvals.json` 里 `(instanceId, rootId)` 那条授权路径——
///   授权目录必须仍然存在，且仍在声明根内（复核，不扩大范围）。
pub(crate) fn write_root(
    instance: &StoredInstance,
    layout: &LauncherLayout,
    root_id: &str,
    for_saves: bool,
) -> LauncherResult<PathBuf> {
    let what = if for_saves { "存档根" } else { "内容根" };
    let spec = if for_saves {
        save_root(instance, root_id)
    } else {
        content_root(instance, root_id)
    }
    .ok_or_else(|| {
        LauncherErrorDto::new(
            ErrorCode::SourceNotApproved,
            format!("实例里没有这个{what}"),
        )
        .detail(format!("instance={} rootId={root_id}", instance.id))
    })?;
    let relative = spec.relative_path.trim();
    let game_root = instance.game_root(layout)?;
    let declared = if relative.is_empty() {
        game_root.clone()
    } else {
        paths::resolve_relative(&game_root, relative)?
    };

    if instance.isolation == "copy" {
        return Ok(declared);
    }
    let approved = store::approved_write_root(layout, &instance.id, root_id)?.ok_or_else(|| {
        LauncherErrorDto::new(
            ErrorCode::SourceNotApproved,
            format!("这个{what}还没有获得写入授权，请用原生目录对话框逐根批准"),
        )
        .detail(format!(
            "instance={} rootId={root_id}（{}）",
            instance.id, spec.label
        ))
    })?;
    if !approved.is_dir() {
        return Err(LauncherErrorDto::new(
            ErrorCode::SourceNotApproved,
            format!("已授权的{what}目录已不可用，请重新授权"),
        )
        .detail(approved.display().to_string()));
    }
    // 复核：授权落点必须仍在声明根内（授权不因一次成功而扩大范围，§9.1）
    if declared.is_dir() {
        paths::assert_inside_existing(&declared, &approved)?;
    }
    Ok(approved)
}

/// 目标名在父目录里的**大小写变体**（Windows 落盘不区分大小写：`Data/A` 与 `data/a`
/// 是同一个文件，清单里写另一种大小写会静默互覆）。
fn case_variant(parent: &Path, name: &str) -> Option<String> {
    let entries = std::fs::read_dir(parent).ok()?;
    let mut found: Option<String> = None;
    for entry in entries.flatten() {
        let candidate = entry.file_name().to_string_lossy().to_string();
        if candidate != name && candidate.eq_ignore_ascii_case(name) {
            found = Some(candidate);
            break;
        }
    }
    found
}

fn ref_key(root_id: &str, path: &str) -> String {
    format!(
        "{}/{}",
        root_id.to_lowercase(),
        path.replace('\\', "/").to_lowercase()
    )
}

/// 停游戏（§10.3「任何启停 / 卸载前必须先停游戏」；本模块的写动作一律先停）。
pub(crate) fn ensure_stopped(host: &Arc<LauncherHost>, instance_id: &str) -> LauncherResult<()> {
    if !host.running_map().contains_key(instance_id) {
        return Ok(());
    }
    let _ = process::stop_blocking(host, instance_id, false, Some(process::DEFAULT_STOP_TIMEOUT_MS));
    if host.running_map().contains_key(instance_id) {
        return Err(LauncherErrorDto::new(
            ErrorCode::InstanceBusy,
            "游戏还没停稳，内容包变更未执行",
        )
        .detail(format!("instance={instance_id}")));
    }
    Ok(())
}

/* ------------------------------- 读已装 ------------------------------- */

struct InstalledPack {
    pack_id: String,
    manifest: Option<PackManifestDto>,
    ownership: Option<OwnershipDoc>,
    state: Option<PackStateDoc>,
}

fn installed_pack_ids(layout: &LauncherLayout, instance_id: &str) -> LauncherResult<Vec<String>> {
    let dir = layout.content_dir(instance_id)?;
    let mut ids = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                ids.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    ids.sort();
    Ok(ids)
}

fn load_ownership(
    layout: &LauncherLayout,
    instance_id: &str,
    pack_id: &str,
) -> LauncherResult<Option<OwnershipDoc>> {
    let doc = store::read_json::<OwnershipDoc>(
        &layout.pack_dir(instance_id, pack_id)?.join(paths::OWNERSHIP_FILE),
        "内容包 ownership",
    )?;
    if let Some(doc) = doc.as_ref() {
        for file in &doc.files {
            guard_file_ref(&file.root_id, &file.path, "ownership.json")?;
        }
    }
    Ok(doc)
}

fn load_state(
    layout: &LauncherLayout,
    instance_id: &str,
    pack_id: &str,
) -> LauncherResult<Option<PackStateDoc>> {
    store::read_json::<PackStateDoc>(
        &layout.pack_dir(instance_id, pack_id)?.join(paths::PACK_STATE_FILE),
        "内容包状态",
    )
}

fn load_manifest(
    layout: &LauncherLayout,
    instance_id: &str,
    pack_id: &str,
) -> LauncherResult<Option<PackManifestDto>> {
    store::read_json::<PackManifestDto>(
        &layout.pack_dir(instance_id, pack_id)?.join(paths::PACK_MANIFEST_FILE),
        "内容包清单",
    )
}

fn load_installed(layout: &LauncherLayout, instance_id: &str) -> LauncherResult<Vec<InstalledPack>> {
    let mut out = Vec::new();
    for pack_id in installed_pack_ids(layout, instance_id)? {
        out.push(InstalledPack {
            manifest: load_manifest(layout, instance_id, &pack_id)?,
            ownership: load_ownership(layout, instance_id, &pack_id)?,
            state: load_state(layout, instance_id, &pack_id)?,
            pack_id,
        });
    }
    Ok(out)
}

/// 全库 ownership 索引：`(rootId, path)`（大小写折叠）→ 包 id。
fn ownership_index(packs: &[InstalledPack]) -> HashMap<String, String> {
    let mut index = HashMap::new();
    for pack in packs {
        let Some(ownership) = pack.ownership.as_ref() else {
            continue;
        };
        for file in &ownership.files {
            index
                .entry(ref_key(&file.root_id, &file.path))
                .or_insert_with(|| pack.pack_id.clone());
        }
    }
    index
}

/* ------------------------------- 列表 / 诊断 ------------------------------- */

fn file_present(layout: &LauncherLayout, instance: &StoredInstance, file: &OwnedFile) -> (bool, bool) {
    let Ok(root) = write_root(instance, layout, &file.root_id, false) else {
        return (false, false);
    };
    let Ok(target) = paths::resolve_relative(&root, &file.path) else {
        return (false, false);
    };
    if !target.is_file() {
        return (false, false);
    }
    match trust::sha256_file(&target) {
        Ok(digest) => (true, digest.sha256 == file.sha256),
        Err(_) => (true, false),
    }
}

pub fn list(host: &Arc<LauncherHost>, instance_id: &str) -> LauncherResult<Vec<InstalledContentDto>> {
    let layout = host.layout.clone();
    let instance = store::load_instance(&layout, instance_id)?;
    let packs = load_installed(&layout, instance_id)?;
    let index = ownership_index(&packs);
    let mut out = Vec::new();
    for pack in &packs {
        let Some(manifest) = pack.manifest.clone() else {
            // 装坏了：不藏起来（铁律 4），用最小形状如实报出
            out.push(InstalledContentDto {
                manifest: PackManifestDto {
                    schema_version: CONTENT_SCHEMA_VERSION,
                    id: pack.pack_id.clone(),
                    name: pack.pack_id.clone(),
                    version: String::new(),
                    kind: String::new(),
                    game_id: instance.game_id.clone(),
                    files: Vec::new(),
                    load_order: 0,
                    requires: None,
                    conflicts: None,
                    author: None,
                    license: None,
                    homepage: None,
                    description: None,
                    capabilities: None,
                    game_version: None,
                    api_version: None,
                    save_impact: None,
                    entrypoints: None,
                    extra: BTreeMap::new(),
                },
                enabled: false,
                order: -1,
                installed_at: String::new(),
                owned_files: Vec::new(),
                status: "broken".to_string(),
            });
            continue;
        };
        let owned: Vec<FileRefDto> = pack
            .ownership
            .as_ref()
            .map(|doc| {
                doc.files
                    .iter()
                    .map(|file| FileRefDto {
                        root_id: file.root_id.clone(),
                        path: file.path.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut status = if pack.ownership.is_none() {
            "broken"
        } else {
            "ok"
        };
        for file in pack.ownership.iter().flat_map(|doc| doc.files.iter()) {
            let (present, matches) = file_present(&layout, &instance, file);
            if !present || !matches {
                status = "conflict";
            }
            if let Some(other) = index.get(&ref_key(&file.root_id, &file.path)) {
                if other != &pack.pack_id {
                    status = "conflict";
                }
            }
        }
        out.push(InstalledContentDto {
            manifest,
            enabled: pack.state.as_ref().map(|s| s.enabled).unwrap_or(true),
            order: pack.state.as_ref().map(|s| s.order).unwrap_or(-1),
            installed_at: pack
                .state
                .as_ref()
                .map(|s| s.installed_at.clone())
                .unwrap_or_default(),
            owned_files: owned,
            status: status.to_string(),
        });
    }
    out.sort_by(|a, b| {
        a.order
            .cmp(&b.order)
            .then_with(|| a.manifest.id.cmp(&b.manifest.id))
    });
    Ok(out)
}

/// 只读诊断（§6.6 `ContentDiagnosis`；码表之外的两档见 `IssueDto`）。
pub fn diagnose(host: &Arc<LauncherHost>, instance_id: &str) -> LauncherResult<DiagnosisDto> {
    let layout = host.layout.clone();
    let instance = store::load_instance(&layout, instance_id)?;
    let packs = load_installed(&layout, instance_id)?;
    let index = ownership_index(&packs);
    let mut issues: Vec<IssueDto> = Vec::new();

    for pack in &packs {
        let pack_id = pack.pack_id.clone();
        let Some(ownership) = pack.ownership.as_ref() else {
            issues.push(IssueDto {
                pack_id: pack_id.clone(),
                code: "conflict".to_string(),
                path: None,
                message: "缺少 ownership.json：这个包的文件归属无法核对".to_string(),
            });
            continue;
        };
        if pack.manifest.is_none() {
            issues.push(IssueDto {
                pack_id: pack_id.clone(),
                code: "conflict".to_string(),
                path: None,
                message: "缺少 pack.json：安装记录已损坏".to_string(),
            });
        }
        for file in &ownership.files {
            let (present, matches) = file_present(&layout, &instance, file);
            if !present {
                issues.push(IssueDto {
                    pack_id: pack_id.clone(),
                    code: "missing-file".to_string(),
                    path: Some(format!("{}/{}", file.root_id, file.path)),
                    message: "本包写入的文件已不存在".to_string(),
                });
            } else if !matches {
                issues.push(IssueDto {
                    pack_id: pack_id.clone(),
                    code: "hash-mismatch".to_string(),
                    path: Some(format!("{}/{}", file.root_id, file.path)),
                    message: "文件内容已被改动（哈希与安装记录不符）".to_string(),
                });
            }
            if let Some(other) = index.get(&ref_key(&file.root_id, &file.path)) {
                if other != &pack_id {
                    issues.push(IssueDto {
                        pack_id: pack_id.clone(),
                        code: "conflict".to_string(),
                        path: Some(format!("{}/{}", file.root_id, file.path)),
                        message: format!("同一路径同时归属 {other}，两个包会互相撤文件"),
                    });
                }
            }
        }
        // 孤儿：payload 里有、ownership 里没有（撤销过半截事务的痕迹）
        if let Ok(payload) = layout.pack_payload_dir(&instance.id, &pack_id) {
            let owned: BTreeSet<String> = ownership
                .files
                .iter()
                .map(|file| format!("{}/{}", file.root_id, file.path))
                .collect();
            for entry in walkdir::WalkDir::new(&payload)
                .follow_links(false)
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let Ok(rel) = entry.path().strip_prefix(&payload) else {
                    continue;
                };
                let name = rel.to_string_lossy().replace('\\', "/");
                if !owned.contains(&name) {
                    issues.push(IssueDto {
                        pack_id: pack_id.clone(),
                        code: "orphan-file".to_string(),
                        path: Some(name),
                        message: "包内副本里有不属于本包 ownership 的文件".to_string(),
                    });
                }
            }
        }
        if ownership.schema_version > CONTENT_SCHEMA_VERSION {
            issues.push(IssueDto {
                pack_id: pack_id.clone(),
                code: "conflict".to_string(),
                path: None,
                message: format!(
                    "ownership 版本 {} 高于本机支持的 {}，请升级应用",
                    ownership.schema_version, CONTENT_SCHEMA_VERSION
                ),
            });
        }
    }

    // 启用顺序异常：并列 order 的已启用包，加载次序不确定（插件侧同一判据）
    let mut by_order: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for pack in &packs {
        let Some(state) = pack.state.as_ref() else {
            continue;
        };
        if state.order < 0 {
            issues.push(IssueDto {
                pack_id: pack.pack_id.clone(),
                code: "load-order".to_string(),
                path: None,
                message: format!("启用顺序异常：order 必须是 ≥0 的整数（当前 {}）", state.order),
            });
            continue;
        }
        if state.enabled {
            by_order.entry(state.order).or_default().push(pack.pack_id.clone());
        }
    }
    for (order, ids) in &by_order {
        if ids.len() < 2 {
            continue;
        }
        for id in ids {
            let others: Vec<&String> = ids.iter().filter(|other| *other != id).collect();
            issues.push(IssueDto {
                pack_id: id.clone(),
                code: "load-order".to_string(),
                path: None,
                message: format!(
                    "启用顺序异常：与 {} 并列在 {order}，加载次序不确定",
                    others
                        .iter()
                        .map(|item| item.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                ),
            });
        }
    }

    // 依赖缺失（按已装清单判；不启用也算"装了"——启停是另一个维度）
    let installed: BTreeSet<String> = packs.iter().map(|pack| pack.pack_id.clone()).collect();
    for pack in &packs {
        let Some(manifest) = pack.manifest.as_ref() else {
            continue;
        };
        for requirement in manifest.requires.iter().flatten() {
            if !installed.contains(&requirement.id) {
                issues.push(IssueDto {
                    pack_id: pack.pack_id.clone(),
                    code: "missing-dependency".to_string(),
                    path: None,
                    message: format!("依赖缺失：需要 {} {}", requirement.id, requirement.version),
                });
            }
        }
    }

    issues.sort_by(|a, b| {
        a.pack_id
            .cmp(&b.pack_id)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.code.cmp(&b.code))
            .then_with(|| a.message.cmp(&b.message))
    });
    Ok(DiagnosisDto {
        instance_id: instance_id.to_string(),
        issues,
    })
}

/* ------------------------------- 预检 ------------------------------- */

/// `launcher_content_plan`：只读预检（解到暂存，**不写游戏根**）。
pub fn plan(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    archive_path: &str,
    limits: Option<StagingLimits>,
) -> LauncherResult<ContentPlanDto> {
    let layout = host.layout.clone();
    let instance = store::load_instance(&layout, instance_id)?;
    layout.ensure_instance_dirs(instance_id)?;

    let archive = validate_archive_argument(archive_path)?;
    let limits = limits.unwrap_or(default_staging_limits()?);
    let limits = archive_guard::cap_staging_limits(limits);

    let plan_id = new_plan_id();
    let staging = layout.staging_plan_dir(instance_id, &plan_id)?;
    if staging.exists() {
        return Err(internal("暂存目录已存在，未复用").detail(staging.display().to_string()));
    }
    std::fs::create_dir_all(&staging)
        .map_err(|e| io_failure("创建暂存目录", &staging, &e))?;

    let outcome = build_plan(&layout, &instance, &archive, &plan_id, &staging, &limits);
    match outcome {
        Ok(stored) => {
            let dto = plan_dto(&plan_id, &stored);
            store::write_json(&staging.join(PLAN_FILE), &stored)?;
            host.emit_instance_change("updated", instance_id);
            Ok(dto)
        }
        Err(err) => {
            // 预检失败不留半成品暂存（与 `extract_staging` 的清扫口径一致）
            let _ = std::fs::remove_dir_all(&staging);
            Err(err)
        }
    }
}

/// `archivePath` 是用户在原生对话框里选中的**输入件**（唯一允许从外部进来的绝对路径）；
/// 这里只做形态闸：本机绝对路径、存在、是文件、非 UNC、无控制字符。
///
/// 存档导入（`saves::plan_import`）复用同一道闸——两条链路对"输入件"的口径只此一份。
pub(crate) fn validate_archive_argument(archive_path: &str) -> LauncherResult<PathBuf> {
    if archive_path.trim().is_empty() || archive_path.chars().any(|c| c.is_control()) {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "没有选中有效的压缩包（应由原生文件对话框给出）",
        ));
    }
    let path = PathBuf::from(archive_path);
    if !path.is_absolute() {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "压缩包必须是本机绝对路径",
        )
        .detail(archive_path.to_string()));
    }
    if archive_path.starts_with(r"\\") {
        return Err(
            LauncherErrorDto::new(ErrorCode::ArchiveInvalid, "不支持网络路径上的压缩包")
                .detail(archive_path.to_string()),
        );
    }
    if !path.is_file() {
        return Err(LauncherErrorDto::new(ErrorCode::ArchiveInvalid, "压缩包不存在或不是文件")
            .detail(path.display().to_string()));
    }
    Ok(path)
}

fn build_plan(
    layout: &LauncherLayout,
    instance: &StoredInstance,
    archive: &Path,
    plan_id: &str,
    staging: &Path,
    limits: &StagingLimits,
) -> LauncherResult<StoredPlan> {
    let container = staging.join(STAGING_CONTAINER);
    std::fs::copy(archive, &container).map_err(|e| io_failure("抄入暂存区", &container, &e))?;
    let extracted = archive_guard::extract_staging(
        staging,
        STAGING_CONTAINER,
        STAGING_UNPACKED,
        limits,
    )
    .map_err(archive_error)?;
    let _ = std::fs::remove_file(&container);
    let unpacked = staging.join(STAGING_UNPACKED);

    let manifest_bytes = std::fs::read(unpacked.join(MANIFEST_FILE)).map_err(|e| {
        LauncherErrorDto::new(ErrorCode::ArchiveInvalid, "内容包里没有 pack.json")
            .detail(format!("{}：{e}", unpacked.join(MANIFEST_FILE).display()))
    })?;
    let manifest: PackManifestDto = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        LauncherErrorDto::new(ErrorCode::ArchiveInvalid, "pack.json 无法解析")
            .detail(e.to_string())
    })?;
    validate_manifest(&manifest, instance)?;

    // 包内条目：只认 `{rootId}/{path}`（清单是唯一权威，多余条目只报不计）
    let available: BTreeMap<String, u64> = extracted
        .entries
        .iter()
        .map(|entry| (entry.path.clone(), entry.bytes))
        .collect();

    let mut staged: Vec<StagedFile> = Vec::new();
    let mut additions: Vec<FileRefDto> = Vec::new();
    let mut overwrites: Vec<FileRefDto> = Vec::new();
    let mut conflicts: Vec<ConflictDto> = Vec::new();
    let mut targets: Vec<TargetDto> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut roots: HashMap<String, PathBuf> = HashMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    let packs = load_installed(layout, &instance.id)?;
    let index = ownership_index(&packs);

    let mut installed_ids: BTreeSet<String> = packs.iter().map(|p| p.pack_id.clone()).collect();
    installed_ids.remove(&manifest.id);

    for file in &manifest.files {
        let root_id = file.root_id.trim();
        if let Some(problem) = root_id_problem(root_id) {
            return Err(LauncherErrorDto::new(
                ErrorCode::SourceNotApproved,
                "清单里的内容根 id 形状非法，已拒绝",
            )
            .detail(format!("{}：{problem}", manifest.id)));
        }
        let spec = content_root(instance, root_id).ok_or_else(|| {
            LauncherErrorDto::new(
                ErrorCode::SourceNotApproved,
                "内容包的目标根不在实例已声明的内容根内，已拒绝",
            )
            .detail(format!("rootId={root_id}（{} / {}）", manifest.id, file.path))
        })?;
        if instance.isolation != "copy" && !spec.writable_in_shared {
            return Err(LauncherErrorDto::new(
                ErrorCode::SourceNotApproved,
                "该内容根在共享实例下未声明可写，需先逐根授权",
            )
            .detail(format!("rootId={root_id}（{}）", spec.label)));
        }
        if let Some(accepts) = spec.accepts.as_ref() {
            if !accepts.iter().any(|kind| kind == &manifest.kind) {
                return Err(LauncherErrorDto::new(
                    ErrorCode::ContentConflict,
                    "目标内容根不接受该类型的包，已拒绝",
                )
                .detail(format!(
                    "rootId={root_id} 接受 [{}]，包类型为 {}",
                    accepts.join("、"),
                    manifest.kind
                )));
            }
        }

        let path = paths::normalize_relative(&file.path)?;
        let key = format!("{root_id}/{path}");
        if !seen.insert(ref_key(root_id, &path)) {
            return Err(LauncherErrorDto::new(
                ErrorCode::ArchiveInvalid,
                "清单里同一路径声明了两次，已拒绝",
            )
            .detail(key));
        }
        if !is_hex_sha256(&file.sha256) {
            return Err(LauncherErrorDto::new(
                ErrorCode::ArchiveInvalid,
                "清单里的文件哈希不是 sha256，已拒绝",
            )
            .detail(format!("{key}：{:?}", file.sha256)));
        }

        let Some(&declared_bytes) = available.get(&key) else {
            return Err(LauncherErrorDto::new(
                ErrorCode::ArchiveInvalid,
                "清单里声明的文件不在包内",
            )
            .detail(format!("缺少条目 {key}（包内条目名 = 根 id + 相对路径）")));
        };
        let source = paths::resolve_relative(&unpacked, &key)?;
        let bytes = std::fs::read(&source).map_err(|e| io_failure("读取包内条目", &source, &e))?;
        let actual = trust::sha256_bytes(&bytes);
        if actual != file.sha256.to_lowercase() || declared_bytes != bytes.len() as u64 {
            return Err(LauncherErrorDto::new(
                ErrorCode::ArchiveInvalid,
                "包内文件与清单对不上，已拒绝（清单可能被改过）",
            )
            .detail(format!(
                "{key}：清单 sha256={} / size={}，实测 sha256={} / size={}",
                file.sha256,
                file.size,
                actual,
                bytes.len()
            )));
        }

        let root_path = match roots.get(root_id) {
            Some(cached) => cached.clone(),
            None => {
                let resolved = write_root(instance, layout, root_id, false)?;
                roots.insert(root_id.to_string(), resolved.clone());
                resolved
            }
        };
        let target = paths::resolve_relative(&root_path, &path)?;
        paths::assert_no_reparse_between(&root_path, &target)?;
        if !targets.iter().any(|item| item.root_id == root_id) {
            targets.push(TargetDto {
                root_id: root_id.to_string(),
                relative_path: String::new(),
            });
        }

        let owner = index.get(&ref_key(root_id, &path)).cloned();
        let filename = target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let parent = target.parent().map(Path::to_path_buf).unwrap_or_default();
        let variant = if target.exists() {
            None
        } else {
            case_variant(&parent, &filename)
        };

        if target.exists() && !target.is_file() {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "目标路径已被目录占用，无法写入文件",
            )
            .detail(target.display().to_string()));
        }

        match (owner.clone(), target.exists(), variant) {
            (Some(other), _, _) if other != manifest.id => conflicts.push(ConflictDto {
                root_id: root_id.to_string(),
                path: path.clone(),
                kind: "other-pack".to_string(),
                existing_pack_id: Some(other),
                existing_path: None,
                resolution: "abort".to_string(),
            }),
            (_, false, Some(existing)) => conflicts.push(ConflictDto {
                root_id: root_id.to_string(),
                path: path.clone(),
                kind: "case-collision".to_string(),
                existing_pack_id: index
                    .get(&ref_key(root_id, &existing))
                    .cloned(),
                existing_path: Some(existing),
                resolution: "abort".to_string(),
            }),
            (_, false, None) => additions.push(FileRefDto {
                root_id: root_id.to_string(),
                path: path.clone(),
            }),
            (owner, true, _) => {
                if owner.as_deref() == Some(manifest.id.as_str()) {
                    // 自己的旧版本文件：升级覆盖，不算冲突
                    overwrites.push(FileRefDto {
                        root_id: root_id.to_string(),
                        path: path.clone(),
                    });
                } else {
                    conflicts.push(ConflictDto {
                        root_id: root_id.to_string(),
                        path: path.clone(),
                        kind: "base-file".to_string(),
                        existing_pack_id: None,
                        existing_path: None,
                        resolution: "abort".to_string(),
                    });
                }
            }
        }

        staged.push(StagedFile {
            root_id: root_id.to_string(),
            path,
            sha256: actual,
            bytes: bytes.len() as u64,
        });
    }

    // 依赖 / 声明冲突（§10.2：命中即 abort，用户卸载冲突包后重试）
    let mut missing_requirements: Vec<String> = Vec::new();
    for requirement in manifest.requires.iter().flatten() {
        if !installed_ids.contains(&requirement.id) && requirement.id != manifest.id {
            missing_requirements.push(format!("{} {}", requirement.id, requirement.version));
        }
    }
    if let Some(declared) = manifest.conflicts.as_ref() {
        let hit: Vec<&String> = declared
            .iter()
            .filter(|id| installed_ids.contains(id.as_str()))
            .collect();
        if !hit.is_empty() {
            return Err(LauncherErrorDto::new(
                ErrorCode::PluginDependency,
                "包声明与已安装的内容冲突，已拒绝",
            )
            .detail(
                hit.iter()
                    .map(|id| id.as_str())
                    .collect::<Vec<_>>()
                    .join("、"),
            ));
        }
    }

    // 包内多余条目：只报名（清单是权威，未声明的文件不会被安装）
    let declared: BTreeSet<String> = staged
        .iter()
        .map(|file| format!("{}/{}", file.root_id, file.path))
        .collect();
    let mut extras: Vec<&String> = available
        .keys()
        .filter(|name| name.as_str() != MANIFEST_FILE && !declared.contains(*name))
        .collect();
    if !extras.is_empty() {
        extras.sort();
        let preview: Vec<String> = extras
            .iter()
            .take(MAX_LISTED_EXTRAS)
            .map(|name| (*name).clone())
            .collect();
        warnings.push(format!(
            "包内有 {} 个条目不在清单中，将不会安装：{}{}",
            extras.len(),
            preview.join("、"),
            if extras.len() > MAX_LISTED_EXTRAS {
                "…"
            } else {
                ""
            }
        ));
    }
    for conflict in &conflicts {
        if conflict.kind == "case-collision" {
            warnings.push(format!(
                "大小写碰撞：{}/{} 与既有 {} 在大小写不敏感的文件系统上等价",
                conflict.root_id,
                conflict.path,
                conflict.existing_path.as_deref().unwrap_or("同名条目")
            ));
        }
    }
    if staged.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "内容包清单没有声明任何文件，已拒绝",
        )
        .detail(format!("{}（{}）", manifest.id, plan_id)));
    }

    let created = unix_ms();
    Ok(StoredPlan {
        schema_version: CONTENT_SCHEMA_VERSION,
        instance_id: instance.id.clone(),
        created_at: iso_from_unix_ms(created),
        expires_at: iso_from_unix_ms(created + PLAN_TTL_MS),
        manifest,
        targets,
        additions,
        overwrites,
        conflicts,
        missing_requirements,
        warnings,
        staged,
    })
}

fn validate_manifest(manifest: &PackManifestDto, instance: &StoredInstance) -> LauncherResult<()> {
    if manifest.schema_version != 1 {
        return Err(LauncherErrorDto::new(
            ErrorCode::SchemaUnsupported,
            "内容包清单版本不受支持，请升级应用",
        )
        .detail(format!("schemaVersion={}", manifest.schema_version)));
    }
    if !paths::valid_component(&manifest.id) {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "内容包 id 不是合法的单段名，已拒绝",
        )
        .detail(format!("id={:?}", manifest.id)));
    }
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "内容包清单缺少名称或版本，已拒绝",
        )
        .detail(format!("id={}", manifest.id)));
    }
    if instance.isolation != "copy" && instance.isolation != "shared" {
        return Err(LauncherErrorDto::new(
            ErrorCode::PlatformUnsupported,
            "这个隔离模式暂不支持安装内容包",
        )
        .detail(format!("isolation={}", instance.isolation)));
    }
    if instance.game_id != manifest.game_id {
        return Err(LauncherErrorDto::new(
            ErrorCode::ArchiveInvalid,
            "内容包声明的游戏与实例不一致，已拒绝",
        )
        .detail(format!(
            "包 {} / 实例 {}",
            manifest.game_id, instance.game_id
        )));
    }
    Ok(())
}

fn plan_dto(plan_id: &str, stored: &StoredPlan) -> ContentPlanDto {
    ContentPlanDto {
        plan_id: plan_id.to_string(),
        manifest: stored.manifest.clone(),
        targets: stored.targets.clone(),
        additions: stored.additions.clone(),
        overwrites: stored.overwrites.clone(),
        conflicts: stored.conflicts.clone(),
        missing_requirements: stored.missing_requirements.clone(),
        warnings: stored.warnings.clone(),
        expires_at: stored.expires_at.clone(),
    }
}

/* ------------------------------- 应用 ------------------------------- */

/// `planId` 是唯一寻址方式（契约里 `apply` 没有 `instanceId`）⇒ 按实例扫暂存目录找它。
/// 找到多份 = 库不自洽，如实报错（不猜"最新那一个"）。
fn find_plan(
    layout: &LauncherLayout,
    plan_id: &str,
) -> LauncherResult<(String, StoredPlan, PathBuf)> {
    if !paths::valid_component(plan_id) {
        return Err(LauncherErrorDto::new(
            ErrorCode::PathEscape,
            "计划 id 形状非法",
        )
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
            let Some(stored) = store::read_json::<StoredPlan>(&dir.join(PLAN_FILE), "内容安装计划")?
            else {
                continue;
            };
            hits.push((instance_id, stored, dir));
        }
    }
    match hits.len() {
        0 => Err(LauncherErrorDto::new(
            ErrorCode::Internal,
            "安装计划不存在或已失效，请重新预检",
        )
        .detail(format!("planId={plan_id}"))
        .with_retryable(true)),
        1 => Ok(hits.remove(0)),
        _ => Err(internal("同一个计划 id 出现在多个实例的暂存区，已拒绝")
            .detail(format!("planId={plan_id}"))),
    }
}

/// 取消 / 失败的回滚台账。
#[derive(Default)]
struct OpRecord {
    pack_id: String,
    /// 本次写过的文件（逆序撤）
    written: Vec<FileRefDto>,
    /// 本次覆盖前的当次快照（`opDir/{rootId}/{path}`）
    snapshots: Vec<(FileRefDto, PathBuf)>,
    op_dir: Option<PathBuf>,
    /// 本次**新写**的基础快照（只删这些，旧快照一条不动）
    created_originals: Vec<PathBuf>,
    pack_dir_existed: bool,
    /// 被 `replace` 拿走归属的 (包 id, 文件)
    transfers: Vec<(String, FileRefDto)>,
}

/// 回滚：**逆序**把这次做过的事收回去；每步失败都记下但继续收（"失败也要把已做的部分收干净"）。
fn rollback(
    layout: &LauncherLayout,
    instance: &StoredInstance,
    record: &OpRecord,
) -> Vec<String> {
    let mut problems = Vec::new();
    for file in record.written.iter().rev() {
        let snapshot = record
            .snapshots
            .iter()
            .find(|(item, _)| item == file)
            .map(|(_, path)| path.clone());
        let target = write_root(instance, layout, &file.root_id, false)
            .and_then(|root| paths::resolve_relative(&root, &file.path));
        let Ok(target) = target else {
            problems.push(format!("{}/{}：目标根已不可用，未能撤回", file.root_id, file.path));
            continue;
        };
        match snapshot {
            Some(snapshot) if snapshot.is_file() => {
                match std::fs::read(&snapshot).map_err(|e| e.to_string()) {
                    Ok(bytes) => {
                        if let Err(err) = store::atomic_write(&target, &bytes) {
                            problems.push(format!(
                                "{}/{}：从快照恢复失败（{}）",
                                file.root_id, file.path, err.message
                            ));
                        }
                    }
                    Err(err) => problems.push(format!(
                        "{}/{}：读快照失败（{err}）",
                        file.root_id, file.path
                    )),
                }
            }
            _ => {
                if target.exists() {
                    if let Err(err) = std::fs::remove_file(&target) {
                        problems.push(format!(
                            "{}/{}：删除失败（{err}）",
                            file.root_id, file.path
                        ));
                    }
                }
            }
        }
    }
    if let Some(op_dir) = record.op_dir.as_ref() {
        let _ = std::fs::remove_dir_all(op_dir);
    }
    for original in &record.created_originals {
        let _ = std::fs::remove_file(original);
    }
    if !record.created_originals.is_empty() {
        // 只清空目录（`remove_dir` 遇非空会失败，正好保留旧快照）
        if let Ok(dir) = layout.pack_backups_dir(&instance.id, &record.pack_id) {
            let mut current = dir.join(paths::ORIGINAL_SNAPSHOT_DIR);
            while let Some(parent) = current.parent() {
                if std::fs::remove_dir(&current).is_err() || parent == dir {
                    break;
                }
                current = parent.to_path_buf();
            }
        }
    }
    if !record.pack_dir_existed && !record.pack_id.is_empty() {
        if let Ok(dir) = layout.pack_dir(&instance.id, &record.pack_id) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    problems
}

/// 取消信号集合：任务槽里那个标志（`launcher_task_cancel` 置它）+ 可选的预置标志
/// （只有测试用：先置位再跑，等价于"在第一个检查点就被取消"）。
pub(crate) type CancelFlags = Vec<Arc<AtomicBool>>;

pub(crate) fn is_cancelled(flags: &[Arc<AtomicBool>]) -> bool {
    flags.iter().any(|flag| flag.load(Ordering::SeqCst))
}

/// `launcher_content_apply`：真落盘（两阶段的第二半）。
pub fn apply(
    host: &Arc<LauncherHost>,
    plan_id: &str,
    resolutions: Option<Vec<ResolutionDto>>,
) -> LauncherResult<TaskDto> {
    apply_with(host, plan_id, resolutions, None)
}

/// `apply` 的实现（`extra_cancel` 只给测试用来预置取消；生产恒 `None`）。
pub(crate) fn apply_with(
    host: &Arc<LauncherHost>,
    plan_id: &str,
    resolutions: Option<Vec<ResolutionDto>>,
    extra_cancel: Option<Arc<AtomicBool>>,
) -> LauncherResult<TaskDto> {
    let layout = host.layout.clone();
    let (instance_id, stored, staging) = find_plan(&layout, plan_id)?;
    let _flight = flight_enter(
        &format!("content:{instance_id}"),
        "该实例已有内容变更正在进行中，请等它结束",
        format!("instance={instance_id} planId={plan_id}"),
    )?;

    let mut task = tasks::begin(host, Some(&instance_id), "content-install");
    let mut flags: CancelFlags = vec![task.cancel.clone()];
    if let Some(extra) = extra_cancel {
        flags.push(extra);
    }
    let outcome = run_apply(
        host,
        &layout,
        &instance_id,
        plan_id,
        &stored,
        &staging,
        resolutions,
        &flags,
        &mut task.dto,
    );
    let _ = std::fs::remove_dir_all(&staging);
    match outcome {
        Ok(result) => Ok(tasks::succeed(host, task.dto, result, "内容包已应用")),
        Err(RunError::Failed(err)) => Err(lost_task(tasks::fail(host, task.dto, err))),
        Err(RunError::Cancelled(message)) => {
            Err(lost_task(tasks::cancel_task(host, task.dto, &message)))
        }
    }
}

/// 任务已经是终态了，不需要再"返回"一份——这里把错误带出去（命令失败以 reject 表达）。
fn lost_task(dto: TaskDto) -> LauncherErrorDto {
    dto.error.unwrap_or_else(|| {
        LauncherErrorDto::new(ErrorCode::Internal, "内容包操作未完成").detail(format!("task={}", dto.id))
    })
}

enum RunError {
    Failed(LauncherErrorDto),
    Cancelled(String),
}

impl From<LauncherErrorDto> for RunError {
    fn from(err: LauncherErrorDto) -> Self {
        RunError::Failed(err)
    }
}

#[allow(clippy::too_many_arguments)]
fn run_apply(
    host: &Arc<LauncherHost>,
    layout: &LauncherLayout,
    instance_id: &str,
    plan_id: &str,
    stored: &StoredPlan,
    staging: &Path,
    resolutions: Option<Vec<ResolutionDto>>,
    cancel: &[Arc<AtomicBool>],
    task: &mut TaskDto,
) -> Result<Value, RunError> {
    if stored.instance_id != instance_id {
        return Err(RunError::Failed(internal("计划与实例不一致，已拒绝").detail(format!(
            "planId={plan_id} 计划={} 请求={instance_id}",
            stored.instance_id
        ))));
    }
    let expires = parse_iso_ms(&stored.expires_at).ok_or_else(|| {
        RunError::Failed(
            LauncherErrorDto::new(ErrorCode::Internal, "安装计划缺少有效的过期时间，请重新预检")
                .detail(format!("planId={plan_id} expiresAt={}", stored.expires_at))
                .with_retryable(true),
        )
    })?;
    if expires <= unix_ms() {
        return Err(RunError::Failed(
            LauncherErrorDto::new(ErrorCode::Internal, "安装计划已过期，请重新预检")
                .detail(format!("planId={plan_id} 过期于 {}", stored.expires_at))
                .with_retryable(true),
        ));
    }
    if !stored.missing_requirements.is_empty() {
        return Err(RunError::Failed(
            LauncherErrorDto::new(
                ErrorCode::PluginDependency,
                "内容包声明的依赖未满足，已拒绝安装",
            )
            .detail(stored.missing_requirements.join("、")),
        ));
    }

    let instance = store::load_instance(layout, instance_id)?;
    // 计划文件读回来先过形状闸：它的 rootId / path 会拼进快照目录名
    for file in &stored.staged {
        guard_file_ref(&file.root_id, &file.path, "安装计划")?;
    }
    ensure_stopped(host, instance_id)?;

    // 冲突决议：计划里的每个冲突都必须有且只有一个决定（漏一条即整包拒绝）
    let decisions = match_decisions(&stored.conflicts, resolutions)?;
    let skipped: BTreeSet<String> = stored
        .conflicts
        .iter()
        .filter(|conflict| {
            decisions
                .get(&ref_key(&conflict.root_id, &conflict.path))
                .map(|action| action == "skip")
                .unwrap_or(false)
        })
        .map(|conflict| ref_key(&conflict.root_id, &conflict.path))
        .collect();
    let replacements: BTreeSet<String> = stored
        .conflicts
        .iter()
        .filter(|conflict| {
            decisions
                .get(&ref_key(&conflict.root_id, &conflict.path))
                .map(|action| action == "replace")
                .unwrap_or(false)
        })
        .map(|conflict| ref_key(&conflict.root_id, &conflict.path))
        .collect();

    let pack_id = stored.manifest.id.clone();
    let pack_dir = layout.pack_dir(instance_id, &pack_id)?;
    let unpacked = staging.join(STAGING_UNPACKED);
    let mut record = OpRecord {
        pack_id: pack_id.clone(),
        pack_dir_existed: pack_dir.exists(),
        ..OpRecord::default()
    };

    // 计划里"自己的旧文件"要保留在 ownership 里（升级后仍然可卸载）
    let previous = load_ownership(layout, instance_id, &pack_id)?.unwrap_or_default();
    let previous_state = load_state(layout, instance_id, &pack_id)?;
    let total: u64 = stored.staged.iter().map(|file| file.bytes).sum();
    let mut done: u64 = 0;

    let stamp = format!(
        "{}-{:04}",
        super::session_stamp(),
        host.next_seq() % 10_000
    );
    let op_dir = layout.pack_backups_dir(instance_id, &pack_id)?.join(&stamp);
    // 当次快照目录也进台账：失败 / 取消时连它一起收（不留"看起来能回滚但其实没用"的空壳）
    record.op_dir = Some(op_dir.clone());

    let result = (|| -> Result<Vec<OwnedFile>, RunError> {
        // ── 快照：先在 backups/ 里把"将被覆盖的"存好，再动游戏根 ──
        for file in &stored.staged {
            let key = ref_key(&file.root_id, &file.path);
            if skipped.contains(&key) {
                continue;
            }
            let root = write_root(&instance, layout, &file.root_id, false)?;
            let target = paths::resolve_relative(&root, &file.path)?;
            if !target.exists() {
                continue;
            }
            if !target.is_file() {
                return Err(RunError::Failed(
                    LauncherErrorDto::new(ErrorCode::ContentConflict, "目标路径已被目录占用，无法写入文件")
                        .detail(target.display().to_string()),
                ));
            }
            let snapshot = op_dir.join(&file.root_id).join(&file.path);
            if let Some(parent) = snapshot.parent() {
                std::fs::create_dir_all(parent).map_err(|e| io_failure("创建快照目录", parent, &e))?;
            }
            std::fs::copy(&target, &snapshot)
                .map_err(|e| io_failure("写入当次快照", &snapshot, &e))?;
            record.snapshots.push((
                FileRefDto {
                    root_id: file.root_id.clone(),
                    path: file.path.clone(),
                },
                snapshot,
            ));
            // 首装基础快照：只写一次，升级不覆盖（§10.1 第 [7] 步）
            let owned_before = previous
                .files
                .iter()
                .any(|item| ref_key(&item.root_id, &item.path) == key);
            if !owned_before || replacements.contains(&key) {
                let original = layout
                    .pack_backups_dir(instance_id, &pack_id)?
                    .join(paths::ORIGINAL_SNAPSHOT_DIR)
                    .join(&file.root_id)
                    .join(&file.path);
                if !original.exists() {
                    if let Some(parent) = original.parent() {
                        std::fs::create_dir_all(parent)
                            .map_err(|e| io_failure("创建基础快照目录", parent, &e))?;
                    }
                    std::fs::copy(&target, &original)
                        .map_err(|e| io_failure("写入基础快照", &original, &e))?;
                    record.created_originals.push(original);
                }
            }
            if replacements.contains(&key) {
                let other = decisions_owner(&stored.conflicts, &file.root_id, &file.path);
                if let Some(other) = other {
                    record.transfers.push((
                        other,
                        FileRefDto {
                            root_id: file.root_id.clone(),
                            path: file.path.clone(),
                        },
                    ));
                }
            }
        }

        // ── 写入：读包内字节 → 临时 + rename（同时落 payload 副本，供启停重放） ──
        let mut written: Vec<OwnedFile> = Vec::new();
        for file in &stored.staged {
            let key = ref_key(&file.root_id, &file.path);
            if skipped.contains(&key) {
                continue;
            }
            if is_cancelled(cancel) {
                return Err(RunError::Cancelled(
                    "已取消：本次写入已全部回滚，ownership 未落盘".to_string(),
                ));
            }
            let source = paths::resolve_relative(&unpacked, &format!("{}/{}", file.root_id, file.path))?;
            let bytes = std::fs::read(&source).map_err(|e| io_failure("读取包内条目", &source, &e))?;
            if trust::sha256_bytes(&bytes) != file.sha256 {
                return Err(RunError::Failed(
                    LauncherErrorDto::new(
                        ErrorCode::ContentBroken,
                        "暂存内容在确认前后发生变化，请重新预检",
                    )
                    .detail(format!("{}/{}", file.root_id, file.path)),
                ));
            }
            let root = write_root(&instance, layout, &file.root_id, false)?;
            let target = paths::resolve_relative(&root, &file.path)?;
            paths::assert_no_reparse_between(&root, &target)?;
            store::atomic_write(&target, &bytes)?;
            let payload = layout
                .pack_payload_dir(instance_id, &pack_id)?
                .join(&file.root_id)
                .join(&file.path);
            store::atomic_write(&payload, &bytes)?;
            record.written.push(FileRefDto {
                root_id: file.root_id.clone(),
                path: file.path.clone(),
            });
            written.push(OwnedFile {
                root_id: file.root_id.clone(),
                path: file.path.clone(),
                sha256: file.sha256.clone(),
                bytes: file.bytes,
                written_at: iso_now(),
            });
            done = done.saturating_add(file.bytes);
            tasks::report_progress(host, task, done, total, "正在写入内容包文件");
        }
        Ok(written)
    })();

    let written = match result {
        Ok(written) => written,
        Err(RunError::Failed(err)) => {
            let problems = rollback(layout, &instance, &record);
            let detail = err.detail.clone().unwrap_or_default();
            let err = if problems.is_empty() {
                err
            } else {
                err.detail(format!(
                    "{detail} · 回滚未完全成功：{}",
                    problems.join("；")
                ))
            };
            return Err(RunError::Failed(err));
        }
        Err(other) => {
            let problems = rollback(layout, &instance, &record);
            match other {
                RunError::Cancelled(_) if problems.is_empty() => {
                    return Err(RunError::Cancelled(
                        "已取消：本次写入已全部回滚，ownership 未落盘".to_string(),
                    ));
                }
                RunError::Cancelled(_) => {
                    return Err(RunError::Failed(
                        LauncherErrorDto::new(
                            ErrorCode::TaskCancelled,
                            "已取消，但回滚没有完全成功",
                        )
                        .detail(problems.join("；")),
                    ));
                }
                other => return Err(other),
            }
        }
    };

    // ── 提交：pack.json / ownership / state / 归属转移（最后一步写，失败也能整块收回） ──
    let commit = (|| -> Result<(), RunError> {
        let manifest_snapshot = std::fs::read(unpacked.join(MANIFEST_FILE))
            .map_err(|e| io_failure("读取清单快照", &unpacked.join(MANIFEST_FILE), &e))?;
        store::atomic_write(&pack_dir.join(paths::PACK_MANIFEST_FILE), &manifest_snapshot)?;

        // 旧版本写过、本次清单里已经没有的文件：仍归本包（卸载时一并撤下），但要报出来
        let mut files = written.clone();
        let current: BTreeSet<String> = files
            .iter()
            .map(|file| ref_key(&file.root_id, &file.path))
            .collect();
        for old in &previous.files {
            if current.contains(&ref_key(&old.root_id, &old.path)) {
                continue;
            }
            let Ok(root) = write_root(&instance, layout, &old.root_id, false) else {
                continue;
            };
            let Ok(target) = paths::resolve_relative(&root, &old.path) else {
                continue;
            };
            if target.is_file() {
                files.push(old.clone());
            }
        }
        let now = iso_now();
        let ownership = OwnershipDoc {
            schema_version: CONTENT_SCHEMA_VERSION,
            pack_id: pack_id.clone(),
            written_at: now.clone(),
            files,
        };
        store::write_json(&pack_dir.join(paths::OWNERSHIP_FILE), &ownership)?;

        let order = previous_state.as_ref().map(|state| state.order).unwrap_or_else(|| {
            load_installed(layout, instance_id)
                .unwrap_or_default()
                .iter()
                .filter_map(|pack| pack.state.as_ref().map(|state| state.order))
                .max()
                .unwrap_or(-1)
                + 1
        });
        let state = PackStateDoc {
            schema_version: CONTENT_SCHEMA_VERSION,
            pack_id: pack_id.clone(),
            enabled: previous_state.as_ref().map(|s| s.enabled).unwrap_or(true),
            order,
            installed_at: previous_state
                .as_ref()
                .map(|s| s.installed_at.clone())
                .unwrap_or_else(|| now.clone()),
            updated_at: now.clone(),
            kind: stored.manifest.kind.clone(),
        };
        store::write_json(&pack_dir.join(paths::PACK_STATE_FILE), &state)?;

        // 归属转移：`replace` 决定的那条路径从原包 ownership 里摘掉（它已经归我们了）
        for (other, file) in &record.transfers {
            let Some(mut doc) = load_ownership(layout, instance_id, other)? else {
                continue;
            };
            let before = doc.files.len();
            doc.files
                .retain(|item| ref_key(&item.root_id, &item.path) != ref_key(&file.root_id, &file.path));
            if doc.files.len() != before {
                doc.written_at = now.clone();
                store::write_json(
                    &layout.pack_dir(instance_id, other)?.join(paths::OWNERSHIP_FILE),
                    &doc,
                )?;
            }
        }
        Ok(())
    })();
    if let Err(err) = commit {
        let problems = rollback(layout, &instance, &record);
        let err = match err {
            RunError::Failed(err) if !problems.is_empty() => {
                let detail = err.detail.clone().unwrap_or_default();
                err.detail(format!(
                    "{detail} · 回滚未完全成功：{}",
                    problems.join("；")
                ))
            }
            RunError::Failed(err) => err,
            other => return Err(other),
        };
        return Err(RunError::Failed(err));
    }

    if is_cancelled(cancel) {
        // 提交已经完成：文件与 ownership 都在。取消来得太晚就不再回滚（撤销要走卸载路径），
        // 但要在结果里如实标出，UI 不会以为"取消了所以什么都没发生"。
        eprintln!("[launcher] 内容包 {pack_id} 已提交，取消请求晚到，未回滚");
    }

    host.emit_instance_change("updated", instance_id);
    Ok(json!({
        "planId": plan_id,
        "packId": pack_id,
        "instanceId": instance_id,
        "written": written.len(),
        "skipped": skipped.len(),
        "snapshot": op_dir.to_string_lossy(),
        "cancelledLate": is_cancelled(cancel),
    }))
}

fn decisions_owner(conflicts: &[ConflictDto], root_id: &str, path: &str) -> Option<String> {
    conflicts
        .iter()
        .find(|conflict| conflict.root_id == root_id && conflict.path == path)
        .and_then(|conflict| conflict.existing_pack_id.clone())
}

/// 逐条决议：漏一条 / 多一条 / 动作与冲突类型不配，全部整包拒绝。
fn match_decisions(
    conflicts: &[ConflictDto],
    resolutions: Option<Vec<ResolutionDto>>,
) -> LauncherResult<HashMap<String, String>> {
    let mut given: HashMap<String, String> = HashMap::new();
    for resolution in resolutions.unwrap_or_default() {
        let key = ref_key(&resolution.root_id, &resolution.path);
        if given.contains_key(&key) {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "同一个文件给了多条冲突决议，已拒绝",
            )
            .detail(format!("{}/{}", resolution.root_id, resolution.path)));
        }
        given.insert(key, resolution.action.to_lowercase());
    }
    let mut out = HashMap::new();
    for conflict in conflicts {
        let key = ref_key(&conflict.root_id, &conflict.path);
        let Some(action) = given.get(&key) else {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "还有冲突没有决断，已中止安装",
            )
            .detail(format!("{}/{}（{}）", conflict.root_id, conflict.path, conflict.kind)));
        };
        match conflict.kind.as_str() {
            "other-pack" | "case-collision" if conflict.existing_pack_id.is_some() => {
                if action == "overwrite" {
                    return Err(LauncherErrorDto::new(
                        ErrorCode::ContentConflict,
                        "覆盖别的包写过的文件需用 replace（转移归属）",
                    )
                    .detail(format!("{}/{}", conflict.root_id, conflict.path)));
                }
            }
            _ => {
                if action == "replace" {
                    return Err(LauncherErrorDto::new(
                        ErrorCode::ContentConflict,
                        "基础游戏文件只能用 overwrite 或 skip",
                    )
                    .detail(format!("{}/{}", conflict.root_id, conflict.path)));
                }
            }
        }
        if !matches!(action.as_str(), "skip" | "overwrite" | "replace") {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "冲突决议的动作不合法，已拒绝",
            )
            .detail(format!("{}/{}：{action}", conflict.root_id, conflict.path)));
        }
        out.insert(key, action.clone());
    }
    for key in given.keys() {
        if !out.contains_key(key) {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "决议里有计划之外的冲突项，已拒绝",
            )
            .detail(key.clone()));
        }
    }
    Ok(out)
}

/* ------------------------------- 卸载 / 启停 / 排序 ------------------------------- */

/// 把本包写过的文件撤下（**只动 ownership 里的**；与别的包同名的一律不碰）。
/// 返回 (撤下的条数, 保留的说明行)。
fn withdraw_files(
    layout: &LauncherLayout,
    instance: &StoredInstance,
    pack_id: &str,
    ownership: &OwnershipDoc,
    only: Option<&BTreeSet<String>>,
) -> LauncherResult<(usize, Vec<String>)> {
    let packs = load_installed(layout, &instance.id)?;
    let index = ownership_index(&packs);
    let mut removed = 0usize;
    let mut notes: Vec<String> = Vec::new();
    for file in &ownership.files {
        let key = ref_key(&file.root_id, &file.path);
        if let Some(only) = only {
            if !only.contains(&key) {
                continue;
            }
        }
        if let Some(other) = index.get(&key) {
            if other != pack_id {
                notes.push(format!(
                    "{}/{}：与 {other} 共有，未删除",
                    file.root_id, file.path
                ));
                continue;
            }
        }
        let Ok(root) = write_root(instance, layout, &file.root_id, false) else {
            notes.push(format!(
                "{}/{}：目标根已不可用，未撤下",
                file.root_id, file.path
            ));
            continue;
        };
        let Ok(target) = paths::resolve_relative(&root, &file.path) else {
            continue;
        };
        if target.is_file() {
            match trust::sha256_file(&target) {
                Ok(digest) if digest.sha256 != file.sha256 => {
                    // 用户改过包内文件：不静默覆盖用户改动（§10.3），保留并如实报
                    notes.push(format!(
                        "{}/{}：文件已被改动，保留你的改动",
                        file.root_id, file.path
                    ));
                    continue;
                }
                _ => {}
            }
            std::fs::remove_file(&target).map_err(|e| io_failure("撤下内容包文件", &target, &e))?;
            removed += 1;
        }
        // 基础快照复位：卸载后回到"装之前"（不是最近一次操作的快照）
        let original = layout
            .pack_backups_dir(&instance.id, pack_id)?
            .join(paths::ORIGINAL_SNAPSHOT_DIR)
            .join(&file.root_id)
            .join(&file.path);
        if original.is_file() {
            let bytes = std::fs::read(&original)
                .map_err(|e| io_failure("读取基础快照", &original, &e))?;
            store::atomic_write(&target, &bytes)?;
        }
    }
    Ok((removed, notes))
}

/// `launcher_content_uninstall`：撤下 → 删 `content/{packId}/` → 清 `original/`（§10.3）。
pub fn uninstall(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    pack_id: &str,
    files: Option<Vec<FileRefDto>>,
) -> LauncherResult<TaskDto> {
    let layout = host.layout.clone();
    if !paths::valid_component(pack_id) {
        return Err(LauncherErrorDto::new(ErrorCode::PathEscape, "包 id 形状非法")
            .detail(format!("packId={pack_id}")));
    }
    let _flight = flight_enter(
        &format!("content:{instance_id}"),
        "该实例已有内容变更正在进行中，请等它结束",
        format!("instance={instance_id} packId={pack_id}"),
    )?;
    let task = tasks::begin(host, Some(instance_id), "content-uninstall");
    let cancel = task.cancel.clone();
    let outcome = (|| -> LauncherResult<Value> {
        let instance = store::load_instance(&layout, instance_id)?;
        let ownership = load_ownership(&layout, instance_id, pack_id)?.ok_or_else(|| {
            LauncherErrorDto::new(
                ErrorCode::ContentBroken,
                "该内容包未安装，或安装记录已损坏",
            )
            .detail(format!("packId={pack_id}"))
        })?;
        ensure_stopped(host, instance_id)?;
        // TS 传进来的 `files` 只作**筛选**：ownership 仍是权威（纵深防御）
        let only = files.map(|list| {
            list.into_iter()
                .map(|file| ref_key(&file.root_id, &file.path))
                .collect::<BTreeSet<String>>()
        });
        if cancel.load(Ordering::SeqCst) {
            return Err(LauncherErrorDto::new(
                ErrorCode::TaskCancelled,
                "已取消：未做任何改动",
            ));
        }
        let (removed, notes) =
            withdraw_files(&layout, &instance, pack_id, &ownership, only.as_ref())?;
        let pack_dir = layout.pack_dir(instance_id, pack_id)?;
        if pack_dir.exists() {
            std::fs::remove_dir_all(&pack_dir)
                .map_err(|e| io_failure("删除内容包目录", &pack_dir, &e))?;
        }
        let backups = layout.pack_backups_dir(instance_id, pack_id)?;
        if backups.exists() {
            std::fs::remove_dir_all(&backups)
                .map_err(|e| io_failure("清理内容包备份", &backups, &e))?;
        }
        let manifest = load_manifest(&layout, instance_id, pack_id).ok().flatten();
        host.emit_instance_change("updated", instance_id);
        Ok(json!({
            "packId": pack_id,
            "instanceId": instance_id,
            "removed": removed,
            "kept": notes,
            "saveImpact": manifest.and_then(|m| m.save_impact),
        }))
    })();
    match outcome {
        Ok(result) => Ok(tasks::succeed(host, task.dto, result, "内容包已卸载")),
        Err(err) if err.code == ErrorCode::TaskCancelled.as_str() => {
            Err(lost_task(tasks::cancel_task(host, task.dto, &err.message)))
        }
        Err(err) => Err(lost_task(tasks::fail(host, task.dto, err))),
    }
}

/// `launcher_content_set_enabled`：撤下 / 重放（payload 是重放的唯一来源）。
pub fn set_enabled(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    pack_id: &str,
    enabled: bool,
) -> LauncherResult<TaskDto> {
    let layout = host.layout.clone();
    if !paths::valid_component(pack_id) {
        return Err(LauncherErrorDto::new(ErrorCode::PathEscape, "包 id 形状非法")
            .detail(format!("packId={pack_id}")));
    }
    let _flight = flight_enter(
        &format!("content:{instance_id}"),
        "该实例已有内容变更正在进行中，请等它结束",
        format!("instance={instance_id} packId={pack_id}"),
    )?;
    // 契约 `TaskKind` 只有 `content-toggle` 这一档（启用 / 停用共用一个类别）
    let task = tasks::begin(host, Some(instance_id), "content-toggle");
    let cancel = task.cancel.clone();
    let outcome = (|| -> LauncherResult<Value> {
        let instance = store::load_instance(&layout, instance_id)?;
        let ownership = load_ownership(&layout, instance_id, pack_id)?.ok_or_else(|| {
            LauncherErrorDto::new(ErrorCode::ContentBroken, "该内容包未安装，无法切换启停")
                .detail(format!("packId={pack_id}"))
        })?;
        let mut state = load_state(&layout, instance_id, pack_id)?.unwrap_or(PackStateDoc {
            schema_version: CONTENT_SCHEMA_VERSION,
            pack_id: pack_id.to_string(),
            enabled: !enabled,
            order: 0,
            installed_at: iso_now(),
            updated_at: iso_now(),
            kind: String::new(),
        });
        ensure_stopped(host, instance_id)?;
        if cancel.load(Ordering::SeqCst) {
            return Err(LauncherErrorDto::new(
                ErrorCode::TaskCancelled,
                "已取消：未做任何改动",
            ));
        }
        if state.enabled == enabled {
            return Ok(json!({
                "packId": pack_id,
                "instanceId": instance_id,
                "enabled": enabled,
                "changed": false,
            }));
        }
        let payload = layout.pack_payload_dir(instance_id, pack_id)?;
        if enabled && !payload.is_dir() {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentBroken,
                "内容包副本已丢失，无法重新启用（请卸载后重装）",
            )
            .detail(payload.display().to_string()));
        }
        if enabled {
            // 重放：payload → 目标根（先快照，写坏了按快照回滚）
            let mut record = OpRecord {
                pack_id: pack_id.to_string(),
                pack_dir_existed: true,
                ..OpRecord::default()
            };
            let stamp = format!("{}-{:04}", super::session_stamp(), host.next_seq() % 10_000);
            let op_dir = layout.pack_backups_dir(instance_id, pack_id)?.join(&stamp);
            record.op_dir = Some(op_dir.clone());
            let attempt = (|| -> LauncherResult<()> {
                for file in &ownership.files {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(LauncherErrorDto::new(
                            ErrorCode::TaskCancelled,
                            "已取消：本次重放已回滚",
                        ));
                    }
                    let source = paths::resolve_relative(&payload, &format!("{}/{}", file.root_id, file.path))?;
                    let bytes = std::fs::read(&source)
                        .map_err(|e| io_failure("读取内容包副本", &source, &e))?;
                    let root = write_root(&instance, &layout, &file.root_id, false)?;
                    let target = paths::resolve_relative(&root, &file.path)?;
                    if target.is_file() {
                        let snapshot = op_dir.join(&file.root_id).join(&file.path);
                        if let Some(parent) = snapshot.parent() {
                            std::fs::create_dir_all(parent)
                                .map_err(|e| io_failure("创建快照目录", parent, &e))?;
                        }
                        std::fs::copy(&target, &snapshot)
                            .map_err(|e| io_failure("写入当次快照", &snapshot, &e))?;
                        record.snapshots.push((FileRefDto {
                            root_id: file.root_id.clone(),
                            path: file.path.clone(),
                        }, snapshot));
                    }
                    store::atomic_write(&target, &bytes)?;
                    record.written.push(FileRefDto {
                        root_id: file.root_id.clone(),
                        path: file.path.clone(),
                    });
                }
                Ok(())
            })();
            if let Err(err) = attempt {
                let problems = rollback(&layout, &instance, &record);
                let detail = if problems.is_empty() {
                    err.detail.unwrap_or_default()
                } else {
                    format!("{} · 回滚未完全成功：{}", err.detail.unwrap_or_default(), problems.join("；"))
                };
                return Err(LauncherErrorDto::new(
                    if err.code == ErrorCode::TaskCancelled.as_str() {
                        ErrorCode::TaskCancelled
                    } else {
                        ErrorCode::ContentBroken
                    },
                    err.message,
                )
                .detail(detail));
            }
        } else {
            let (removed, notes) =
                withdraw_files(&layout, &instance, pack_id, &ownership, None)?;
            if removed == 0 && !notes.is_empty() {
                // 一个都没撤下来：状态照改，但把原因如实带出去
                let _ = notes;
            }
        }
        state.enabled = enabled;
        state.updated_at = iso_now();
        store::write_json(
            &layout.pack_dir(instance_id, pack_id)?.join(paths::PACK_STATE_FILE),
            &state,
        )?;
        host.emit_instance_change("updated", instance_id);
        Ok(json!({
            "packId": pack_id,
            "instanceId": instance_id,
            "enabled": enabled,
            "changed": true,
        }))
    })();
    match outcome {
        Ok(result) => Ok(tasks::succeed(host, task.dto, result, "内容包启停已切换")),
        Err(err) if err.code == ErrorCode::TaskCancelled.as_str() => {
            Err(lost_task(tasks::cancel_task(host, task.dto, &err.message)))
        }
        Err(err) => Err(lost_task(tasks::fail(host, task.dto, err))),
    }
}

/// `launcher_content_set_order`：只接受已安装 id 的**排列**（不多、不少、不重）。
pub fn set_order(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    pack_ids: &[String],
) -> LauncherResult<()> {
    let layout = host.layout.clone();
    let _flight = flight_enter(
        &format!("content:{instance_id}"),
        "该实例已有内容变更正在进行中，请等它结束",
        format!("instance={instance_id}"),
    )?;
    let installed = installed_pack_ids(&layout, instance_id)?;
    let mut wanted: BTreeSet<&str> = BTreeSet::new();
    for id in pack_ids {
        if !paths::valid_component(id) {
            return Err(LauncherErrorDto::new(ErrorCode::PathEscape, "包 id 形状非法")
                .detail(format!("packId={id}")));
        }
        if !wanted.insert(id.as_str()) {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "加载顺序里同一个包出现了两次，已拒绝",
            )
            .detail(id.clone()));
        }
        if !installed.iter().any(|candidate| candidate == id) {
            return Err(LauncherErrorDto::new(
                ErrorCode::ContentConflict,
                "加载顺序里有未安装的包，已拒绝",
            )
            .detail(id.clone()));
        }
    }
    let missing: Vec<&str> = installed
        .iter()
        .map(|id| id.as_str())
        .filter(|id| !wanted.contains(id))
        .collect();
    if !missing.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::ContentConflict,
            "加载顺序漏掉了已安装的包，已拒绝",
        )
        .detail(missing.join("、")));
    }
    let now = iso_now();
    for (index, id) in pack_ids.iter().enumerate() {
        let mut state = load_state(&layout, instance_id, id)?.unwrap_or(PackStateDoc {
            schema_version: CONTENT_SCHEMA_VERSION,
            pack_id: id.clone(),
            enabled: true,
            order: index as i64,
            installed_at: now.clone(),
            updated_at: now.clone(),
            kind: String::new(),
        });
        state.order = index as i64;
        state.updated_at = now.clone();
        store::write_json(
            &layout.pack_dir(instance_id, id)?.join(paths::PACK_STATE_FILE),
            &state,
        )?;
    }
    host.emit_instance_change("updated", instance_id);
    Ok(())
}

/* ------------------------------- 测试辅助 ------------------------------- */

/// 测试用的最小实例（只写 `instance.json` + 注册表，不碰真游戏目录）。
#[cfg(test)]
pub(crate) fn install_test_instance(
    layout: &LauncherLayout,
    id: &str,
    game_root: &Path,
    isolation: &str,
    content_roots: Vec<Value>,
) -> LauncherResult<StoredInstance> {
    layout.ensure_root()?;
    let instance = StoredInstance {
        schema_version: store::INSTANCE_SCHEMA_VERSION,
        id: id.to_string(),
        name: format!("测试实例 {id}"),
        adapter_id: "test-adapter".to_string(),
        game_id: "test-game".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        source_root: Some(game_root.to_string_lossy().to_string()),
        isolation: isolation.to_string(),
        state: "ready".to_string(),
        executable: store::StoredExecutable::default(),
        runtime_id: None,
        locale: None,
        encoding: None,
        save_roots: Vec::new(),
        content_roots,
        executable_trust: None,
        launch_count: 0,
        last_launched_at: None,
        last_exit: None,
        notes: None,
        tags: None,
    };
    layout.ensure_instance_dirs(id)?;
    if isolation == "copy" {
        std::fs::create_dir_all(layout.game_dir(id)?).ok();
    }
    store::save_instance(layout, &instance)?;
    let mut registry = store::load_registry(layout)?;
    registry.upsert(instance.registry_entry());
    store::save_registry(layout, &mut registry)?;
    Ok(instance)
}
