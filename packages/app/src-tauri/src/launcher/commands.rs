//! `launcher_*` 命令面（`docs/LAUNCHER-ARCHITECTURE.md` §7.2 逐条）。
//!
//! 形状纪律：
//! - **每个命令的参数里都没有"目标程序路径"**：启动只认 `instanceId`（ADR-0008 决策 1）；
//! - **写落点全部由 `paths::LauncherLayout` 拼**，命令不接受任意写路径；
//! - 唯一"写到域外"的命令是 `launcher_log_export`：先弹原生保存对话框，落点由对话框
//!   当场选定，**写盘与对话框在同一个命令内**（铁律 6 的形态，`exportFile` 的同款）；
//! - `launcher_pick_source_root` / `launcher_pick_write_root` 同样把"登记"放在同一命令内：
//!   对话框即授权，前端拿不到可编程的授权接口。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tauri::State;

use super::content::{
    self, ContentPlanDto, DiagnosisDto, FileRefDto, InstalledContentDto, PlanOptionsDto,
    ResolutionDto,
};
use super::error::{internal, platform_unsupported, ErrorCode, LauncherErrorDto, LauncherResult};
use super::logs::{self, LogPageDto, LogQuery, LogSessionDto};
use super::paths::{self, LauncherLayout};
use super::process::{self, ProcessStatusDto};
use super::saves::{
    self, RestoreOptionsDto, SaveBackupDto, SaveBackupRequestDto, SaveExportRequestDto,
    SaveImportPlanDto, SaveListingDto, SaveResolutionDto,
};
use super::store::{self, StoredExecutable, StoredInstance, StoredTrust};
use super::tasks::{self, TaskDto};
use super::trust;
use super::{iso_now, LauncherHost};

type HostState<'a> = State<'a, Arc<LauncherHost>>;

/// 阻塞活挪到工作线程（`CreateProcessW` / 大目录复制 / 哈希都不能占 IPC 线程）。
async fn block<T, F>(op: &str, work: F) -> LauncherResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> LauncherResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| internal(format!("{op} 宿主线程池失败")).detail(err.to_string()))?
}

/* ------------------------------- DTO ------------------------------- */

/// `LauncherInstance` + 两个**现算**的派生字段（不落盘）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceDto {
    #[serde(flatten)]
    pub instance: StoredInstance,
    pub instance_root: String,
    pub game_root: String,
}

fn instance_dto(layout: &LauncherLayout, instance: &StoredInstance) -> LauncherResult<InstanceDto> {
    Ok(InstanceDto {
        instance_root: layout
            .instance_root(&instance.id)?
            .to_string_lossy()
            .to_string(),
        game_root: instance.game_root(layout)?.to_string_lossy().to_string(),
        instance: instance.clone(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableInspectionDto {
    pub absolute_path: String,
    pub exists: bool,
    pub sha256: Option<String>,
    pub trusted: bool,
    pub changed_since_trust: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInspectionDto {
    pub required: Option<Value>,
    pub resolved: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsDto {
    pub instance_root: String,
    pub game_root: String,
    pub save_roots: Vec<String>,
    pub log_dir: String,
    pub backup_dir: String,
}

/// `InstanceInspection`（详情页一次取全；`warnings` 是人话行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionDto {
    pub instance: InstanceDto,
    pub executable: ExecutableInspectionDto,
    pub runtime: RuntimeInspectionDto,
    pub paths: PathsDto,
    pub disk_usage_bytes: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreationDto {
    pub instance: InstanceDto,
    pub task: Option<TaskDto>,
}

/// `launcher_instance_create` 的 `request`（`CreateInstanceRequest` 的宿主子集）。
///
/// `sourceRoot` 必须是**已批准的源根**（只由 `launcher_pick_source_root` 登记）。
///
/// `candidateId` 收而不存：它是 adapter 侧的候选标识，契约里的 `LauncherInstance` 没有这个
/// 字段（落库会多出一个契约外字段），宿主也从不解释它。
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstanceRequest {
    pub name: String,
    pub source_root: String,
    pub adapter_id: String,
    pub game_id: String,
    #[serde(default)]
    pub candidate_id: String,
    pub isolation: String,
    #[serde(default)]
    pub include_saves: bool,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub locale: Option<Value>,
    #[serde(default)]
    pub encoding: Option<Value>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// `LaunchExecutable`（`sha256` 从 JS 传进来也不收：本结构体没有这个字段）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableInputDto {
    pub relative_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_window_mode")]
    pub window_mode: String,
}

fn default_window_mode() -> String {
    "auto".to_string()
}

/// `LaunchProfile`（adapter 在 TS 侧编译好，宿主不认识内容语义）。
///
/// 收而不用的四格（`candidateId` / `cwdRelative` / `runtime` / `warnings`）是**契约缺口**的
/// 直接后果：`LauncherInstance`（§5.1）里没有 cwd / 运行时需求的存放位置，宿主当前以
/// `gameRoot` 作为工作目录并把运行时需求判为未解析（见 `process::prepare_and_spawn`）。
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileDto {
    #[serde(default)]
    pub candidate_id: String,
    pub executable: ExecutableInputDto,
    #[serde(default = "default_cwd_relative")]
    pub cwd_relative: String,
    #[serde(default)]
    pub runtime: Option<Value>,
    #[serde(default)]
    pub locale: Option<Value>,
    #[serde(default)]
    pub encoding: Option<Value>,
    #[serde(default)]
    pub save_roots: Vec<Value>,
    #[serde(default)]
    pub content_roots: Vec<Value>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

fn default_cwd_relative() -> String {
    ".".to_string()
}

/// `InstancePatch`：**结构性不可改的字段根本不在这个结构体里**
/// （`id` / `sourceRoot` / `isolation` / `gameId`）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstancePatch {
    pub name: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<BTreeMap<String, String>>,
    pub locale: Option<Value>,
    pub encoding: Option<Value>,
    pub executable_relative_path: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub runtime_id: Option<Option<String>>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// 三态字段（缺席 = 不动；`null` = 清空；字符串 = 设置）。
fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}

/* ------------------------------- 工具 ------------------------------- */

fn is_unc(path: &Path) -> bool {
    path.to_string_lossy().starts_with(r"\\")
}

/// 实例 id：宿主生成的 UUID 形态（由时间 + pid + 计数器混合，`splitmix64` 打散）。
fn new_instance_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    fn splitmix(mut x: u64) -> u64 {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seed = nanos
        ^ (std::process::id() as u64).rotate_left(17)
        ^ COUNTER
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let high = splitmix(seed);
    let low = splitmix(high ^ seed);
    let hex = format!("{high:016x}{low:016x}");
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now() -> String {
    iso_now()
}

fn clamp_name(raw: &str) -> LauncherResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(internal("实例名称不能为空"));
    }
    if name.chars().count() > 200 {
        return Err(internal("实例名称过长（最多 200 字）"));
    }
    Ok(name.to_string())
}

/// 存档根的绝对落点（copy 时决定跳不跳 `includeSaves`）。
fn save_root_paths(instance: &StoredInstance, root: &Path) -> Vec<PathBuf> {
    instance
        .save_roots
        .iter()
        .filter_map(store::root_spec_relative_path)
        .filter_map(|rel| paths::resolve_relative(root, rel).ok())
        .collect()
}

/// 目录体积（详情页读一次；读不动就按 0 计并给一条 warning 都不值——静默 0 可接受，
/// 因为它是展示字段，不是判据）。
fn dir_size(root: &Path) -> u64 {
    let mut total = 0u64;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let Ok(entry) = entry else {
            continue;
        };
        if entry.file_type().is_file() {
            total = total.saturating_add(entry.metadata().map(|m| m.len()).unwrap_or(0));
        }
    }
    total
}

/* ------------------------------- 选择对话框 ------------------------------- */

/// `launcher_pick_source_root`：原生目录对话框 + **同一命令内**登记来源根批准表。
#[tauri::command]
pub async fn launcher_pick_source_root(
    state: HostState<'_>,
    title: Option<String>,
) -> LauncherResult<Option<String>> {
    let host = state.inner().clone();
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(title) = title.as_deref() {
        dialog = dialog.set_title(title);
    }
    let Some(picked) = dialog.pick_folder().await else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    block("launcher_pick_source_root", move || {
        let canonical = std::fs::canonicalize(&path).map_err(|err| {
            LauncherErrorDto::new(ErrorCode::SourceNotApproved, "选中的目录不可用")
                .detail(format!("{}：{err}", path.display()))
        })?;
        // UNC / 网络盘默认拒绝：远程 exe 启动是另一类风险
        if is_unc(&canonical) {
            return Err(LauncherErrorDto::new(
                ErrorCode::SourceNotApproved,
                "不支持网络路径作为游戏根",
            )
            .detail(canonical.display().to_string()));
        }
        paths::assert_not_reparse(&canonical)?;
        if !canonical.is_dir() {
            return Err(
                LauncherErrorDto::new(ErrorCode::SourceNotApproved, "选中的不是目录")
                    .detail(canonical.display().to_string()),
            );
        }
        host.layout.ensure_root()?;
        // 落盘的是用户看到的那条路径（不是 `\\?\` 形态的 canonical），比较时两侧都规范化
        store::approve_source_root(&host.layout, &path, &now())?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

/// `launcher_pick_write_root`：原生目录对话框 + **同一命令内**登记 shared 写授权。
///
/// 粒度 = **实例 × rootId**：`rootId` 必须在该实例的 `saveRoots` / `contentRoots` 里，
/// 选中的目录必须落在该根的声明落点内（否则 `LAUNCHER_PATH_ESCAPE`）。
#[tauri::command]
pub async fn launcher_pick_write_root(
    state: HostState<'_>,
    instance_id: String,
    root_id: String,
) -> LauncherResult<Option<String>> {
    let host = state.inner().clone();
    let (declared, instance) = {
        let layout = host.layout.clone();
        let instance_id = instance_id.clone();
        let root_id = root_id.clone();
        block("launcher_pick_write_root", move || {
            let instance = store::load_instance(&layout, &instance_id)?;
            let game_root = instance.game_root(&layout)?;
            let spec = instance.root_spec(&root_id).ok_or_else(|| {
                LauncherErrorDto::new(
                    ErrorCode::SourceNotApproved,
                    "实例里没有这个内容根 / 存档根",
                )
                .detail(format!("rootId={root_id}"))
            })?;
            let relative = store::root_spec_relative_path(spec).ok_or_else(|| {
                LauncherErrorDto::new(ErrorCode::SourceNotApproved, "该根缺少 relativePath")
                    .detail(format!("rootId={root_id}"))
            })?;
            let declared = paths::resolve_relative(&game_root, relative)?;
            Ok((declared, instance))
        })
        .await?
    };

    let Some(picked) = rfd::AsyncFileDialog::new()
        .set_title("选择这个根的授权目录")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    block("launcher_pick_write_root 登记", move || {
        // **授权之前一个字节都不写**：声明根不存在就明确拒绝（等游戏跑过一次再来授权），
        // 而不是先替用户在游戏目录里建目录。
        if !declared.is_dir() {
            return Err(LauncherErrorDto::new(
                ErrorCode::SourceNotApproved,
                "这个根对应的目录还不存在，无法授权",
            )
            .detail(declared.display().to_string()));
        }
        // 规范化后必须落在声明根内（组件级，不是字符串前缀）
        paths::assert_inside_existing(&declared, &path)?;
        paths::assert_not_reparse(&path)?;
        store::approve_write_root(&host.layout, &instance.id, &root_id, &path, &now())?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

/* ------------------------------- 实例 ------------------------------- */

#[tauri::command]
pub async fn launcher_instance_list(state: HostState<'_>) -> LauncherResult<Vec<InstanceDto>> {
    let host = state.inner().clone();
    block("launcher_instance_list", move || {
        let layout = host.layout.clone();
        let instances = store::load_all_instances(&layout)?;
        instances
            .iter()
            .map(|instance| instance_dto(&layout, instance))
            .collect()
    })
    .await
}

#[tauri::command]
pub async fn launcher_instance_get(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<InspectionDto> {
    let host = state.inner().clone();
    block("launcher_instance_get", move || {
        let layout = host.layout.clone();
        let instance = store::load_instance(&layout, &instance_id)?;
        let game_root = instance.game_root(&layout)?;
        let mut warnings: Vec<String> = Vec::new();

        let (absolute, exists, digest) =
            match paths::resolve_relative(&game_root, instance.executable.relative_path.trim()) {
                Ok(target) => {
                    let exists = target.is_file();
                    let digest = if exists {
                        trust::sha256_file(&target).ok()
                    } else {
                        None
                    };
                    (target, exists, digest)
                }
                Err(err) => {
                    warnings.push(format!("可执行路径不合法：{}", err.message));
                    (game_root.clone(), false, None)
                }
            };
        if !exists {
            warnings.push("可执行文件不存在（启动会被拦下）".to_string());
        }
        let trusted = match (&instance.executable_trust, &digest) {
            (Some(trust), Some(digest)) => trust.sha256 == digest.sha256,
            _ => false,
        };
        if instance.executable_trust.is_none() {
            warnings.push("尚未信任可执行文件（首次启动前需确认）".to_string());
        } else if exists && !trusted {
            warnings.push("可执行文件已变化，需要重新信任".to_string());
        }
        if instance.runtime_id.is_some() {
            warnings.push("运行时管理属 P1，本版不会解析运行时".to_string());
        }
        if instance.state != "ready" {
            warnings.push(format!("实例当前状态：{}", instance.state));
        }

        let save_roots: Vec<String> = instance
            .save_roots
            .iter()
            .filter_map(store::root_spec_relative_path)
            .filter_map(|rel| paths::resolve_relative(&game_root, rel).ok())
            .map(|path| path.to_string_lossy().to_string())
            .collect();

        let inspection = InspectionDto {
            instance: instance_dto(&layout, &instance)?,
            executable: ExecutableInspectionDto {
                absolute_path: absolute.to_string_lossy().to_string(),
                exists,
                sha256: instance
                    .executable
                    .sha256
                    .clone()
                    .or_else(|| digest.as_ref().map(|d| d.sha256.clone())),
                trusted,
                changed_since_trust: instance.executable_trust.is_some() && exists && !trusted,
            },
            runtime: RuntimeInspectionDto {
                required: None,
                resolved: None,
            },
            paths: PathsDto {
                instance_root: layout
                    .instance_root(&instance.id)?
                    .to_string_lossy()
                    .to_string(),
                game_root: game_root.to_string_lossy().to_string(),
                save_roots,
                log_dir: layout.logs_dir(&instance.id)?.to_string_lossy().to_string(),
                backup_dir: layout
                    .backups_dir(&instance.id)?
                    .to_string_lossy()
                    .to_string(),
            },
            disk_usage_bytes: layout
                .instance_root(&instance.id)
                .map(|root| dir_size(&root))
                .unwrap_or(0),
            warnings,
        };
        Ok(inspection)
    })
    .await
}

/// `launcher_instance_create({ request, profile })`：宿主不认识 adapter，profile 由 TS 编译。
#[tauri::command]
pub async fn launcher_instance_create(
    state: HostState<'_>,
    request: CreateInstanceRequest,
    profile: LaunchProfileDto,
) -> LauncherResult<CreationDto> {
    let host = state.inner().clone();
    block("launcher_instance_create", move || {
        create_instance(&host, request, profile)
    })
    .await
}

pub(crate) fn create_instance(
    host: &Arc<LauncherHost>,
    request: CreateInstanceRequest,
    profile: LaunchProfileDto,
) -> LauncherResult<CreationDto> {
    host.layout.ensure_root()?;
    let name = clamp_name(&request.name)?;
    let isolation = request.isolation.as_str();
    match isolation {
        "shared" | "copy" => {}
        "overlay" => {
            return Err(platform_unsupported("覆盖层实例").detail("overlay 隔离属 P2"));
        }
        other => {
            return Err(internal("未知的隔离模式").detail(other.to_string()));
        }
    }

    let source = PathBuf::from(&request.source_root);
    if !source.is_absolute() || is_unc(&source) {
        return Err(LauncherErrorDto::new(
            ErrorCode::SourceNotApproved,
            "游戏根必须是本机绝对路径",
        )
        .detail(request.source_root.clone()));
    }
    let canonical_source = std::fs::canonicalize(&source).map_err(|err| {
        LauncherErrorDto::new(ErrorCode::SourceNotApproved, "游戏根目录不可用")
            .detail(format!("{}：{err}", source.display()))
    })?;
    if !canonical_source.is_dir() {
        return Err(
            LauncherErrorDto::new(ErrorCode::SourceNotApproved, "游戏根不是目录")
                .detail(canonical_source.display().to_string()),
        );
    }
    if !store::is_source_approved(&host.layout, &canonical_source)? {
        return Err(
            LauncherErrorDto::new(ErrorCode::SourceNotApproved, "这个目录还没有经过批准").detail(
                format!(
                    "{}：请先用「选择游戏目录」走原生对话框授权",
                    canonical_source.display()
                ),
            ),
        );
    }

    let id = new_instance_id();
    let timestamp = now();
    let instance = StoredInstance {
        schema_version: store::INSTANCE_SCHEMA_VERSION,
        id: id.clone(),
        name,
        adapter_id: request.adapter_id.clone(),
        game_id: request.game_id.clone(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        source_root: Some(canonical_source.to_string_lossy().to_string()),
        isolation: isolation.to_string(),
        state: if isolation == "copy" {
            "preparing".to_string()
        } else {
            "ready".to_string()
        },
        executable: StoredExecutable {
            relative_path: profile.executable.relative_path.clone(),
            args: profile.executable.args.clone(),
            env: profile.executable.env.clone(),
            window_mode: profile.executable.window_mode.clone(),
            // 哈希由宿主算；JS 传的值根本进不来
            sha256: None,
        },
        runtime_id: request.runtime_id.clone(),
        locale: profile.locale.clone().or_else(|| request.locale.clone()),
        encoding: profile
            .encoding
            .clone()
            .or_else(|| request.encoding.clone()),
        save_roots: profile.save_roots.clone(),
        content_roots: profile.content_roots.clone(),
        executable_trust: None,
        launch_count: 0,
        last_launched_at: None,
        last_exit: None,
        notes: request.notes.clone(),
        tags: None,
    };

    // 校验链第 2~5 步 + 建库时的哈希（此时游戏根是**源根**：copy 还没发生）
    let target = process::resolve_executable(&instance, &canonical_source)?;
    let digest = trust::sha256_file(&target)?;
    let mut instance = instance;
    instance.executable.sha256 = Some(digest.sha256.clone());

    host.layout.ensure_instance_dirs(&id)?;
    if isolation == "copy" {
        // 空源目录也要有 `game/`：复制任务只按文件流抄，不会替实例建根。
        // 建目录放在**写清单之前**——否则建不出来时会留下一个已登记的"准备中"僵尸实例。
        let dest = host.layout.game_dir(&id)?;
        std::fs::create_dir_all(&dest)
            .map_err(|err| super::error::io_failure("创建实例游戏目录", &dest, &err))?;
    }
    store::save_instance(&host.layout, &instance)?;
    {
        let mut registry = store::load_registry(&host.layout)?;
        registry.upsert(instance.registry_entry());
        store::save_registry(&host.layout, &mut registry)?;
    }
    host.emit_instance_change("created", &id);

    let task = if isolation == "copy" {
        let dest = host.layout.game_dir(&id)?;
        let skip = if request.include_saves {
            Vec::new()
        } else {
            save_root_paths(&instance, &canonical_source)
        };
        Some(tasks::enqueue_copy(
            host,
            &id,
            "instance-copy",
            canonical_source.clone(),
            dest,
            skip,
        ))
    } else {
        None
    };

    Ok(CreationDto {
        instance: instance_dto(&host.layout, &instance)?,
        task,
    })
}

#[tauri::command]
pub async fn launcher_instance_update(
    state: HostState<'_>,
    instance_id: String,
    patch: InstancePatch,
) -> LauncherResult<InstanceDto> {
    let host = state.inner().clone();
    block("launcher_instance_update", move || {
        let layout = host.layout.clone();
        let _guard = host.manifest_io.lock().unwrap_or_else(|e| e.into_inner());
        let mut instance = store::load_instance(&layout, &instance_id)?;

        if let Some(name) = patch.name.as_deref() {
            instance.name = clamp_name(name)?;
        }
        if let Some(args) = patch.args {
            process::validate_argv(&args)?;
            instance.executable.args = args;
        }
        if let Some(env) = patch.env {
            // 形状闸与启动时同一份（别让坏 key 拖到启动才炸）
            process::build_env(&env)?;
            instance.executable.env = env;
        }
        if let Some(locale) = patch.locale {
            instance.locale = Some(locale);
        }
        if let Some(encoding) = patch.encoding {
            instance.encoding = Some(encoding);
        }
        if let Some(runtime_id) = patch.runtime_id {
            instance.runtime_id = runtime_id;
        }
        if patch.notes.is_some() {
            instance.notes = patch.notes;
        }
        if patch.tags.is_some() {
            instance.tags = patch.tags;
        }
        if let Some(relative) = patch.executable_relative_path.as_deref() {
            let relative = relative.trim().to_string();
            if relative != instance.executable.relative_path {
                let mut candidate = instance.clone();
                candidate.executable.relative_path = relative;
                let game_root = candidate.game_root(&layout)?;
                let target = process::resolve_executable(&candidate, &game_root)?;
                let digest = trust::sha256_file(&target)?;
                instance.executable.relative_path = candidate.executable.relative_path;
                instance.executable.sha256 = Some(digest.sha256);
                // 换 exe = 信任作废（ADR-0008 决策 1）
                instance.executable_trust = None;
            }
        }
        instance.updated_at = now();
        store::save_instance(&layout, &instance)?;
        let mut registry = store::load_registry(&layout)?;
        registry.upsert(instance.registry_entry());
        store::save_registry(&layout, &mut registry)?;
        drop(_guard);
        host.emit_instance_change("updated", &instance_id);
        instance_dto(&layout, &instance)
    })
    .await
}

#[tauri::command]
pub async fn launcher_instance_remove(
    state: HostState<'_>,
    instance_id: String,
    delete_files: bool,
    keep_backups: Option<bool>,
) -> LauncherResult<()> {
    let host = state.inner().clone();
    block("launcher_instance_remove", move || {
        remove_instance(
            &host,
            &instance_id,
            delete_files,
            keep_backups.unwrap_or(false),
        )
    })
    .await
}

/// `launcher_instance_remove` 的同步实现（抽出来给测试直调；三条硬顺序写在函数里）。
pub(crate) fn remove_instance(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    delete_files: bool,
    keep_backups: bool,
) -> LauncherResult<()> {
    let layout = host.layout.clone();
    // 先停进程（"先停再删"是硬顺序）
    if host.running_map().contains_key(instance_id) {
        let _ = process::stop_blocking(host, instance_id, true, Some(10_000));
    }
    if host.running_map().contains_key(instance_id) {
        return Err(
            LauncherErrorDto::new(ErrorCode::InstanceBusy, "进程还没停下来，实例未删除")
                .detail(format!("instance={instance_id}")),
        );
    }
    let instance = store::load_instance(&layout, instance_id)?;
    if delete_files {
        let root = layout.instance_root(instance_id)?;
        if keep_backups {
            let backups = layout.backups_dir(instance_id)?;
            if backups.exists() {
                let trash = layout
                    .trash_dir()
                    .join(super::session_stamp())
                    .join(instance_id);
                std::fs::create_dir_all(&trash)
                    .map_err(|e| super::error::io_failure("创建回收目录", &trash, &e))?;
                std::fs::rename(&backups, trash.join("backups"))
                    .map_err(|e| super::error::io_failure("移动备份到回收目录", &backups, &e))?;
            }
        }
        if root.exists() {
            // 删前复核落点（组件级）：只删实例根内的东西
            if !paths::path_has_prefix(&layout.instances_dir(), &root) {
                return Err(LauncherErrorDto::new(
                    ErrorCode::PathEscape,
                    "实例目录不在实例根内，拒绝删除",
                )
                .detail(root.display().to_string()));
            }
            std::fs::remove_dir_all(&root)
                .map_err(|e| super::error::io_failure("删除实例目录", &root, &e))?;
        }
    }
    // 删文件成功之后才摘索引：反过来做失败时会把实例变成"没人认领的目录"
    {
        let _guard = host.manifest_io.lock().unwrap_or_else(|e| e.into_inner());
        let mut registry = store::load_registry(&layout)?;
        registry.remove(instance_id);
        store::save_registry(&layout, &mut registry)?;
    }
    host.emit_instance_change("removed", instance_id);
    eprintln!(
        "[launcher] 实例已移除：{}（{}）",
        instance.id,
        if delete_files {
            "含文件"
        } else {
            "保留文件"
        }
    );
    Ok(())
}

#[tauri::command]
pub async fn launcher_instance_duplicate(
    state: HostState<'_>,
    instance_id: String,
    name: Option<String>,
) -> LauncherResult<CreationDto> {
    let host = state.inner().clone();
    block("launcher_instance_duplicate", move || {
        duplicate_instance(&host, &instance_id, name)
    })
    .await
}

fn duplicate_instance(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    name: Option<String>,
) -> LauncherResult<CreationDto> {
    host.layout.ensure_root()?;
    let source = store::load_instance(&host.layout, instance_id)?;
    let source_game_root = source.game_root(&host.layout)?;
    let target_name = match name {
        Some(raw) => clamp_name(&raw)?,
        None => clamp_name(&format!("{} 副本", source.name))?,
    };
    let id = new_instance_id();
    let timestamp = now();
    let mut instance = StoredInstance {
        schema_version: store::INSTANCE_SCHEMA_VERSION,
        id: id.clone(),
        name: target_name,
        adapter_id: source.adapter_id.clone(),
        game_id: source.game_id.clone(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        source_root: source.source_root.clone(),
        isolation: source.isolation.clone(),
        state: if source.isolation == "copy" {
            "preparing".to_string()
        } else {
            "ready".to_string()
        },
        executable: source.executable.clone(),
        runtime_id: source.runtime_id.clone(),
        locale: source.locale.clone(),
        encoding: source.encoding.clone(),
        save_roots: source.save_roots.clone(),
        content_roots: source.content_roots.clone(),
        // 复制出的实例**不继承信任记录**：信任是对某个具体文件的确认，换一份就该重新确认
        executable_trust: None,
        launch_count: 0,
        last_launched_at: None,
        last_exit: None,
        notes: source.notes.clone(),
        tags: source.tags.clone(),
    };
    let target = process::resolve_executable(&instance, &source_game_root)?;
    let digest = trust::sha256_file(&target)?;
    instance.executable.sha256 = Some(digest.sha256);

    host.layout.ensure_instance_dirs(&id)?;
    if source.isolation == "copy" {
        let dest = host.layout.game_dir(&id)?;
        std::fs::create_dir_all(&dest)
            .map_err(|err| super::error::io_failure("创建实例游戏目录", &dest, &err))?;
    }
    store::save_instance(&host.layout, &instance)?;
    {
        let mut registry = store::load_registry(&host.layout)?;
        registry.upsert(instance.registry_entry());
        store::save_registry(&host.layout, &mut registry)?;
    }
    host.emit_instance_change("created", &id);

    let task = if source.isolation == "copy" {
        let dest = host.layout.game_dir(&id)?;
        Some(tasks::enqueue_copy(
            host,
            &id,
            "instance-duplicate",
            source_game_root,
            dest,
            Vec::new(),
        ))
    } else {
        None
    };
    Ok(CreationDto {
        instance: instance_dto(&host.layout, &instance)?,
        task,
    })
}

#[tauri::command]
pub async fn launcher_instance_open_folder(
    state: HostState<'_>,
    instance_id: String,
    which: String,
) -> LauncherResult<()> {
    let host = state.inner().clone();
    block("launcher_instance_open_folder", move || {
        let layout = host.layout.clone();
        let instance = store::load_instance(&layout, &instance_id)?;
        let target = match which.as_str() {
            "instance" => layout.instance_root(&instance_id)?,
            "game" => instance.game_root(&layout)?,
            "logs" => layout.logs_dir(&instance_id)?,
            "backups" => layout.backups_dir(&instance_id)?,
            "staging" => layout.staging_dir(&instance_id)?,
            other => {
                return Err(internal("未知的目录类型").detail(format!("which={other}")));
            }
        };
        std::fs::create_dir_all(&target)
            .map_err(|e| super::error::io_failure("创建目录", &target, &e))?;
        crate::shell::reveal_in_folder(&target).map_err(internal)
    })
    .await
}

/* ------------------------------- 信任 ------------------------------- */

/// `launcher_trust_executable`：宿主算哈希 + **宿主弹原生确认框**（JS 不传哈希、不能跳过）。
#[tauri::command]
pub async fn launcher_trust_executable(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<StoredTrust> {
    let host = state.inner().clone();
    let (instance, target) = {
        let layout = host.layout.clone();
        let instance_id = instance_id.clone();
        block("launcher_trust_executable 校验", move || {
            let instance = store::load_instance(&layout, &instance_id)?;
            let game_root = instance.game_root(&layout)?;
            let target = process::resolve_executable(&instance, &game_root)?;
            Ok((instance, target))
        })
        .await?
    };
    let digest = block("launcher_trust_executable 哈希", {
        let target = target.clone();
        move || trust::sha256_file(&target)
    })
    .await?;

    let text = trust::confirm_text(&target, &digest);
    if !trust::confirm_native("确认信任这个程序", &text).await? {
        return Err(LauncherErrorDto::new(
            ErrorCode::TrustRequired,
            "已取消信任确认，可执行文件未获信任",
        )
        .detail(target.display().to_string()));
    }

    let approved_at = now();
    let record = trust::make_trust(&digest, &approved_at);
    let record_for_write = record.clone();
    block("launcher_trust_executable 落盘", move || {
        let layout = host.layout.clone();
        let _guard = host.manifest_io.lock().unwrap_or_else(|e| e.into_inner());
        let mut latest = store::load_instance(&layout, &instance.id)?;
        latest.executable.sha256 = Some(record_for_write.sha256.clone());
        latest.executable_trust = Some(record_for_write);
        latest.updated_at = now();
        store::save_instance(&layout, &latest)?;
        let mut registry = store::load_registry(&layout)?;
        registry.upsert(latest.registry_entry());
        store::save_registry(&layout, &mut registry)?;
        drop(_guard);
        host.emit_instance_change("updated", &instance.id);
        Ok(())
    })
    .await?;
    Ok(record)
}

/* ------------------------------- 进程 ------------------------------- */

#[tauri::command]
pub async fn launcher_start(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<ProcessStatusDto> {
    let host = state.inner().clone();
    block("launcher_start", move || {
        process::start_blocking(&host, &instance_id)
    })
    .await
}

#[tauri::command]
pub async fn launcher_stop(
    state: HostState<'_>,
    instance_id: String,
    force: Option<bool>,
    timeout_ms: Option<u64>,
) -> LauncherResult<ProcessStatusDto> {
    let host = state.inner().clone();
    block("launcher_stop", move || {
        process::stop_blocking(&host, &instance_id, force.unwrap_or(false), timeout_ms)
    })
    .await
}

#[tauri::command]
pub async fn launcher_process_status(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<ProcessStatusDto> {
    let host = state.inner().clone();
    Ok(process::status(&host, &instance_id))
}

#[tauri::command]
pub async fn launcher_process_list(state: HostState<'_>) -> LauncherResult<Vec<ProcessStatusDto>> {
    let host = state.inner().clone();
    Ok(process::list(&host))
}

/* ------------------------------- 日志 ------------------------------- */

#[tauri::command]
pub async fn launcher_log_tail(
    state: HostState<'_>,
    instance_id: String,
    query: Option<LogQuery>,
) -> LauncherResult<LogPageDto> {
    let host = state.inner().clone();
    block("launcher_log_tail", move || {
        logs::tail(&host.layout, &instance_id, &query.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn launcher_log_sessions(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<Vec<LogSessionDto>> {
    let host = state.inner().clone();
    block("launcher_log_sessions", move || {
        logs::sessions(&host.layout, &instance_id)
    })
    .await
}

#[tauri::command]
pub async fn launcher_log_read(
    state: HostState<'_>,
    session_id: String,
    query: Option<LogQuery>,
) -> LauncherResult<LogPageDto> {
    let host = state.inner().clone();
    block("launcher_log_read", move || {
        logs::read(&host.layout, &session_id, &query.unwrap_or_default())
    })
    .await
}

/// `launcher_log_export`：原生保存对话框 + **同一命令内写盘**（唯一"写到域外"的通道）。
#[tauri::command]
pub async fn launcher_log_export(
    state: HostState<'_>,
    instance_id: String,
    session_id: Option<String>,
    include_diagnostics: Option<bool>,
) -> LauncherResult<Option<String>> {
    let host = state.inner().clone();
    let (suggested, bytes) = block("launcher_log_export 打包", move || {
        let layout = host.layout.clone();
        let instance = store::load_instance(&layout, &instance_id)?;
        logs::export_bytes(
            &layout,
            &instance,
            session_id.as_deref(),
            include_diagnostics.unwrap_or(false),
        )
    })
    .await?;

    let Some(picked) = rfd::AsyncFileDialog::new()
        .set_title("导出启动器日志")
        .set_file_name(&suggested)
        .add_filter("日志文件", &["log", "txt"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    block("launcher_log_export 写入", move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| super::error::io_failure("创建导出目录", parent, &e))?;
        }
        std::fs::write(&path, &bytes)
            .map_err(|e| super::error::io_failure("写入导出文件", &path, &e))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

/* ------------------------------- 任务 ------------------------------- */

#[tauri::command]
pub async fn launcher_task_list(state: HostState<'_>) -> LauncherResult<Vec<TaskDto>> {
    let host = state.inner().clone();
    Ok(tasks::list(&host))
}

#[tauri::command]
pub async fn launcher_task_cancel(state: HostState<'_>, task_id: String) -> LauncherResult<()> {
    let host = state.inner().clone();
    tasks::cancel(&host, &task_id)
}

/* ------------------------------- 内容包 ------------------------------- */

/// `launcher_pick_archive`：原生文件对话框，**只选不读不写**（§7.2）。
///
/// 返回的路径随后作为 `archivePath` 传给 `content_plan` / `save_import`——那是"输入件"，
/// 不是"写落点"；写落点仍然全部由 `paths::LauncherLayout` 拼。
#[tauri::command]
pub async fn launcher_pick_archive(title: Option<String>) -> LauncherResult<Option<String>> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_title(title.unwrap_or_else(|| "选择压缩包".to_string()))
        .add_filter("ZIP 压缩包", &["zip"]);
    let Some(picked) = dialog.pick_file().await else {
        return Ok(None);
    };
    Ok(Some(picked.path().to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn launcher_content_list(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<Vec<InstalledContentDto>> {
    let host = state.inner().clone();
    block("launcher_content_list", move || {
        content::list(&host, &instance_id)
    })
    .await
}

/// `launcher_content_plan({ instanceId, archivePath, opts })`：解到暂存 + 出计划，**不写游戏根**。
#[tauri::command]
pub async fn launcher_content_plan(
    state: HostState<'_>,
    instance_id: String,
    archive_path: String,
    opts: Option<PlanOptionsDto>,
) -> LauncherResult<ContentPlanDto> {
    let host = state.inner().clone();
    block("launcher_content_plan", move || {
        let limits = opts.and_then(|opts| opts.limits);
        content::plan(&host, &instance_id, &archive_path, limits)
    })
    .await
}

#[tauri::command]
pub async fn launcher_content_apply(
    state: HostState<'_>,
    plan_id: String,
    resolutions: Option<Vec<ResolutionDto>>,
) -> LauncherResult<TaskDto> {
    let host = state.inner().clone();
    block("launcher_content_apply", move || {
        content::apply(&host, &plan_id, resolutions)
    })
    .await
}

/// `launcher_content_uninstall`：`files` = TS 侧算出的「本包独占」快照；ownership 仍是权威。
#[tauri::command]
pub async fn launcher_content_uninstall(
    state: HostState<'_>,
    instance_id: String,
    pack_id: String,
    files: Option<Vec<FileRefDto>>,
) -> LauncherResult<TaskDto> {
    let host = state.inner().clone();
    block("launcher_content_uninstall", move || {
        content::uninstall(&host, &instance_id, &pack_id, files)
    })
    .await
}

#[tauri::command]
pub async fn launcher_content_set_enabled(
    state: HostState<'_>,
    instance_id: String,
    pack_id: String,
    enabled: bool,
) -> LauncherResult<TaskDto> {
    let host = state.inner().clone();
    block("launcher_content_set_enabled", move || {
        content::set_enabled(&host, &instance_id, &pack_id, enabled)
    })
    .await
}

#[tauri::command]
pub async fn launcher_content_set_order(
    state: HostState<'_>,
    instance_id: String,
    pack_ids: Vec<String>,
) -> LauncherResult<()> {
    let host = state.inner().clone();
    block("launcher_content_set_order", move || {
        content::set_order(&host, &instance_id, &pack_ids)
    })
    .await
}

#[tauri::command]
pub async fn launcher_content_diagnose(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<DiagnosisDto> {
    let host = state.inner().clone();
    block("launcher_content_diagnose", move || {
        content::diagnose(&host, &instance_id)
    })
    .await
}

/* ------------------------------- 存档 ------------------------------- */

#[tauri::command]
pub async fn launcher_save_list(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<SaveListingDto> {
    let host = state.inner().clone();
    block("launcher_save_list", move || {
        saves::list(&host, &instance_id)
    })
    .await
}

#[tauri::command]
pub async fn launcher_save_backups(
    state: HostState<'_>,
    instance_id: String,
) -> LauncherResult<Vec<SaveBackupDto>> {
    let host = state.inner().clone();
    block("launcher_save_backups", move || {
        saves::backups(&host, &instance_id)
    })
    .await
}

#[tauri::command]
pub async fn launcher_save_backup(
    state: HostState<'_>,
    instance_id: String,
    req: SaveBackupRequestDto,
) -> LauncherResult<TaskDto> {
    let host = state.inner().clone();
    block("launcher_save_backup", move || {
        saves::backup(&host, &instance_id, req)
    })
    .await
}

/// `launcher_save_restore`：宿主内**必然**先自动备份当前（`backupCurrent` 默认 true）。
#[tauri::command]
pub async fn launcher_save_restore(
    state: HostState<'_>,
    instance_id: String,
    backup_id: String,
    opts: Option<RestoreOptionsDto>,
) -> LauncherResult<TaskDto> {
    let host = state.inner().clone();
    block("launcher_save_restore", move || {
        saves::restore(&host, &instance_id, &backup_id, opts.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn launcher_save_delete_backup(
    state: HostState<'_>,
    instance_id: String,
    backup_id: String,
) -> LauncherResult<()> {
    let host = state.inner().clone();
    block("launcher_save_delete_backup", move || {
        saves::delete_backup(&host, &instance_id, &backup_id)
    })
    .await
}

#[tauri::command]
pub async fn launcher_save_import(
    state: HostState<'_>,
    instance_id: String,
    archive_path: String,
) -> LauncherResult<SaveImportPlanDto> {
    let host = state.inner().clone();
    block("launcher_save_import", move || {
        saves::plan_import(&host, &instance_id, &archive_path)
    })
    .await
}

#[tauri::command]
pub async fn launcher_save_apply_import(
    state: HostState<'_>,
    plan_id: String,
    resolutions: Option<Vec<SaveResolutionDto>>,
) -> LauncherResult<TaskDto> {
    let host = state.inner().clone();
    block("launcher_save_apply_import", move || {
        saves::apply_import(&host, &plan_id, resolutions)
    })
    .await
}

/// `launcher_save_export`：原生保存对话框 + **同一命令内写 ZIP**（对话框即授权）。
#[tauri::command]
pub async fn launcher_save_export(
    state: HostState<'_>,
    instance_id: String,
    req: SaveExportRequestDto,
) -> LauncherResult<Option<String>> {
    let host = state.inner().clone();
    let suggested = {
        let host = host.clone();
        let instance_id = instance_id.clone();
        block("launcher_save_export 命名", move || {
            Ok(saves::suggested_export_name(&host, &instance_id))
        })
        .await?
    };
    let Some(picked) = rfd::AsyncFileDialog::new()
        .set_title("导出存档备份")
        .set_file_name(&suggested)
        .add_filter("ZIP 压缩包", &["zip"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = picked.path().to_path_buf();
    block("launcher_save_export 写入", move || {
        saves::export_to(&host, &instance_id, req, &path)?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

/// 命令名的唯一清单（测试拿它钉 `lib.rs` 的注册表：少登记一条就红）。
#[allow(dead_code)]
pub const COMMAND_NAMES: [&str; 36] = [
    "launcher_pick_source_root",
    "launcher_pick_write_root",
    "launcher_pick_archive",
    "launcher_instance_list",
    "launcher_instance_get",
    "launcher_instance_create",
    "launcher_instance_update",
    "launcher_instance_remove",
    "launcher_instance_duplicate",
    "launcher_instance_open_folder",
    "launcher_trust_executable",
    "launcher_start",
    "launcher_stop",
    "launcher_process_status",
    "launcher_process_list",
    "launcher_log_tail",
    "launcher_log_sessions",
    "launcher_log_read",
    "launcher_log_export",
    "launcher_content_list",
    "launcher_content_plan",
    "launcher_content_apply",
    "launcher_content_uninstall",
    "launcher_content_set_enabled",
    "launcher_content_set_order",
    "launcher_content_diagnose",
    "launcher_save_list",
    "launcher_save_backups",
    "launcher_save_backup",
    "launcher_save_restore",
    "launcher_save_delete_backup",
    "launcher_save_import",
    "launcher_save_apply_import",
    "launcher_save_export",
    "launcher_task_list",
    "launcher_task_cancel",
];
