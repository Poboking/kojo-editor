//! 落盘层：注册表、实例清单、批准表、运行锁。
//!
//! 三条纪律：
//! - **原子写**：同目录 `temp` → `flush + sync_all` → `rename`（Windows 上 `rename` 走
//!   `MoveFileEx(REPLACE_EXISTING)`，同卷原子的替换）。直接 `fs::write` 目标文件会在中途
//!   崩溃时留下半份 JSON——启动器的注册表一旦半份，整库读不出来。
//! - **读失败 = fail-closed**：文件不存在是"首次运行"（合法空态），**其余任何读/解析失败
//!   一律报错**，不静默回退到空表（空表会让下一次写把整库覆盖掉）。
//! - **派生字段不落盘**：`instanceRoot` / `gameRoot` 由宿主按当前 appData 现算，清单里只有
//!   `sourceRoot`（用户选的绝对源根）与相对路径。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::error::{internal, io_failure, ErrorCode, LauncherErrorDto, LauncherResult};
use super::paths::{self, LauncherLayout};
use super::process;

/* ------------------------------- 原子写 ------------------------------- */

static ATOMIC_SEQ: AtomicU64 = AtomicU64::new(0);

/// 同目录临时名：`{pid}-{进程内序号}`（只用 pid 会被并发写抢成同一个名字）。
fn tmp_name(path: &Path) -> String {
    let base = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "tmp".to_string());
    format!(
        ".{base}.{}-{}.tmp",
        std::process::id(),
        ATOMIC_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// 原子写：临时文件写完 → `sync_all` → `rename` 覆盖目标。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> LauncherResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| internal("写盘目标没有父目录").detail(path.display().to_string()))?;
    std::fs::create_dir_all(parent).map_err(|e| io_failure("创建目录", parent, &e))?;
    let tmp = parent.join(tmp_name(path));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        // flush + sync：不 fsync 的话断电后 rename 可能指向"长度对、内容空"的块
        file.flush()?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(io_failure("写入临时文件", &tmp, &err));
    }
    // Windows 上杀软 / 索引器偶尔握着目标句柄 ⇒ 重试几次再判失败
    let mut last_err = None;
    for _ in 0..5 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(io_failure(
        "替换目标文件",
        path,
        &last_err.unwrap_or_else(|| std::io::Error::other("rename failed")),
    ))
}

/// 读 JSON：不存在 = `Ok(None)`；存在但读不出 / 解析不出 = `Err`（fail-closed）。
pub fn read_json<T: DeserializeOwned>(path: &Path, what: &str) -> LauncherResult<Option<T>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(io_failure(&format!("读取{what}"), path, &err)),
    };
    let value = serde_json::from_slice::<T>(&bytes).map_err(|err| {
        internal(format!("{what}无法解析")).detail(format!("{}：{err}", path.display()))
    })?;
    Ok(Some(value))
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> LauncherResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| internal("序列化失败").detail(e.to_string()))?;
    atomic_write(path, &bytes)
}

/* ------------------------------- 注册表 ------------------------------- */

/// 注册表结构版本。升高 = 旧版应用读新库必须报 `LAUNCHER_SCHEMA_UNSUPPORTED`。
pub const SCHEMA_VERSION: u32 = 1;
/// 实例清单结构版本（与注册表版本各自独立演进）。
pub const INSTANCE_SCHEMA_VERSION: u32 = 1;

/// 注册表里的索引条目：**派生缓存**，权威是每个实例目录里的 `instance.json`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub adapter_id: String,
    pub game_id: String,
    pub isolation: String,
    pub state: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub schema_version: u32,
    pub rev: u64,
    pub instances: Vec<RegistryEntry>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            rev: 0,
            instances: Vec::new(),
        }
    }
}

pub fn load_registry(layout: &LauncherLayout) -> LauncherResult<Registry> {
    let path = layout.registry_file();
    let Some(mut registry) = read_json::<Registry>(&path, "实例注册表")? else {
        return Ok(Registry::default());
    };
    if registry.schema_version > SCHEMA_VERSION {
        return Err(LauncherErrorDto::new(
            ErrorCode::SchemaUnsupported,
            "实例注册表版本高于本应用支持的版本，请升级应用",
        )
        .detail(format!(
            "{}：schemaVersion={}（本机支持 {}）",
            path.display(),
            registry.schema_version,
            SCHEMA_VERSION
        )));
    }
    if registry.schema_version < SCHEMA_VERSION {
        // v1 是首版：低版本只可能是外部手改的残片，不静默"迁移"成空表
        registry.schema_version = SCHEMA_VERSION;
    }
    Ok(registry)
}

pub fn save_registry(layout: &LauncherLayout, registry: &mut Registry) -> LauncherResult<()> {
    registry.schema_version = SCHEMA_VERSION;
    registry.rev = registry.rev.saturating_add(1);
    write_json(&layout.registry_file(), registry)
}

impl Registry {
    pub fn index_of(&self, id: &str) -> Option<usize> {
        self.instances.iter().position(|e| e.id == id)
    }

    pub fn upsert(&mut self, entry: RegistryEntry) {
        match self.index_of(&entry.id) {
            Some(idx) => self.instances[idx] = entry,
            None => self.instances.push(entry),
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        match self.index_of(id) {
            Some(idx) => {
                self.instances.remove(idx);
                true
            }
            None => false,
        }
    }
}

/* ------------------------------- 实例清单 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredExecutable {
    pub relative_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_window_mode")]
    pub window_mode: String,
    /// 宿主在创建 / 信任时算好写回；**JS 传的值一律忽略**。
    #[serde(default)]
    pub sha256: Option<String>,
}

fn default_window_mode() -> String {
    "auto".to_string()
}

impl Default for StoredExecutable {
    fn default() -> Self {
        Self {
            relative_path: String::new(),
            args: Vec::new(),
            env: BTreeMap::new(),
            window_mode: default_window_mode(),
            sha256: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredTrust {
    pub sha256: String,
    pub size: u64,
    pub approved_at: String,
    /// 证明来源固定为宿主原生确认框（不接受其它来源）。
    pub approved_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredExit {
    pub session_id: String,
    pub started_at: String,
    pub ended_at: String,
    pub exit_code: Option<i64>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredInstance {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub adapter_id: String,
    pub game_id: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub source_root: Option<String>,
    pub isolation: String,
    pub state: String,
    pub executable: StoredExecutable,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub locale: Option<Value>,
    #[serde(default)]
    pub encoding: Option<Value>,
    #[serde(default)]
    pub save_roots: Vec<Value>,
    #[serde(default)]
    pub content_roots: Vec<Value>,
    #[serde(default)]
    pub executable_trust: Option<StoredTrust>,
    #[serde(default)]
    pub launch_count: u64,
    #[serde(default)]
    pub last_launched_at: Option<String>,
    #[serde(default)]
    pub last_exit: Option<StoredExit>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

impl StoredInstance {
    pub fn registry_entry(&self) -> RegistryEntry {
        RegistryEntry {
            id: self.id.clone(),
            name: self.name.clone(),
            adapter_id: self.adapter_id.clone(),
            game_id: self.game_id.clone(),
            isolation: self.isolation.clone(),
            state: self.state.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    pub fn game_root(&self, layout: &LauncherLayout) -> LauncherResult<PathBuf> {
        layout.game_root(&self.id, &self.isolation, self.source_root.as_deref())
    }

    /// 在存档根 / 内容根里按 `rootId` 找声明（宿主不解释语义，只读相对路径）。
    pub fn root_spec(&self, root_id: &str) -> Option<&Value> {
        self.content_roots
            .iter()
            .chain(self.save_roots.iter())
            .find(|spec| root_spec_id(spec) == Some(root_id))
    }
}

/// `ContentRootSpec` / `SaveRootSpec` 的公共读法：宿主只认 `id` 与 `relativePath`。
pub fn root_spec_id(spec: &Value) -> Option<&str> {
    spec.get("id").and_then(Value::as_str)
}

pub fn root_spec_relative_path(spec: &Value) -> Option<&str> {
    spec.get("relativePath").and_then(Value::as_str)
}

pub fn load_instance(layout: &LauncherLayout, id: &str) -> LauncherResult<StoredInstance> {
    let path = layout.manifest_file(id)?;
    let Some(instance) = read_json::<StoredInstance>(&path, "实例清单")? else {
        return Err(
            LauncherErrorDto::new(ErrorCode::InstanceNotFound, "找不到这个实例")
                .detail(format!("id={id}")),
        );
    };
    if instance.id != id {
        return Err(internal("实例清单的 id 与目录名不一致")
            .detail(format!("目录={id} 清单={}", instance.id)));
    }
    if instance.schema_version > INSTANCE_SCHEMA_VERSION {
        return Err(LauncherErrorDto::new(
            ErrorCode::SchemaUnsupported,
            "实例清单版本高于本应用支持的版本，请升级应用",
        )
        .detail(format!(
            "instance={id} schemaVersion={}（本机支持 {}）",
            instance.schema_version, INSTANCE_SCHEMA_VERSION
        )));
    }
    Ok(instance)
}

pub fn save_instance(layout: &LauncherLayout, instance: &StoredInstance) -> LauncherResult<()> {
    let path = layout.manifest_file(&instance.id)?;
    write_json(&path, instance)
}

/// 按注册表顺序读全部实例清单（**读不出任何一份就报错**，不静默跳过）。
pub fn load_all_instances(layout: &LauncherLayout) -> LauncherResult<Vec<StoredInstance>> {
    let registry = load_registry(layout)?;
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for entry in &registry.instances {
        let instance = load_instance(layout, &entry.id).map_err(|err| {
            let detail = match err.detail {
                Some(detail) => format!("{detail}（注册表条目 {}）", entry.id),
                None => format!("注册表条目 {}", entry.id),
            };
            LauncherErrorDto {
                code: err.code,
                message: err.message,
                detail: Some(detail),
                retryable: err.retryable,
            }
        })?;
        seen.push(entry.id.clone());
        out.push(instance);
    }
    // 目录里存在但注册表没记的实例：**不静默收养**（那是"删除失败后复活"的来源），
    // 但也不删——只在启动器日志里出声，由用户决定。
    if let Ok(entries) = std::fs::read_dir(layout.instances_dir()) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            if !seen.contains(&id) {
                eprintln!("[launcher] 发现未登记的实例目录：{id}（未收养）");
            }
        }
    }
    Ok(out)
}

/* ------------------------------- 批准表 ------------------------------- */

/// 来源根批准 + shared 写授权（粒度 = 实例 × rootId）。**只由原生对话框写入**。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedRoot {
    pub path: String,
    pub approved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedWriteRoot {
    pub instance_id: String,
    pub root_id: String,
    pub path: String,
    pub approved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Approvals {
    pub schema_version: u32,
    #[serde(default)]
    pub source_roots: Vec<ApprovedRoot>,
    #[serde(default)]
    pub write_roots: Vec<ApprovedWriteRoot>,
}

impl Default for Approvals {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            source_roots: Vec::new(),
            write_roots: Vec::new(),
        }
    }
}

pub fn load_approvals(layout: &LauncherLayout) -> LauncherResult<Approvals> {
    let mut approvals =
        read_json::<Approvals>(&layout.approvals_file(), "启动器批准表")?.unwrap_or_default();
    approvals.schema_version = SCHEMA_VERSION;
    Ok(approvals)
}

fn save_approvals(layout: &LauncherLayout, approvals: &Approvals) -> LauncherResult<()> {
    write_json(&layout.approvals_file(), approvals)
}

/// 路径是否已被批准为来源根（规范化后逐组件比；大小写按平台口径）。
pub fn is_source_approved(layout: &LauncherLayout, path: &Path) -> LauncherResult<bool> {
    let approvals = load_approvals(layout)?;
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(approvals.source_roots.iter().any(|root| {
        let approved = PathBuf::from(&root.path);
        let approved = std::fs::canonicalize(&approved).unwrap_or(approved);
        paths::path_has_prefix(&approved, &target)
    }))
}

/// 登记来源根（只由 `launcher_pick_source_root` 在对话框确认后调用）。
pub fn approve_source_root(layout: &LauncherLayout, path: &Path, now: &str) -> LauncherResult<()> {
    let mut approvals = load_approvals(layout)?;
    let text = path.to_string_lossy().to_string();
    if approvals.source_roots.iter().any(|root| root.path == text) {
        return Ok(());
    }
    approvals.source_roots.push(ApprovedRoot {
        path: text,
        approved_at: now.to_string(),
    });
    save_approvals(layout, &approvals)
}

/// 登记 shared 写授权（实例 × rootId）。
pub fn approve_write_root(
    layout: &LauncherLayout,
    instance_id: &str,
    root_id: &str,
    path: &Path,
    now: &str,
) -> LauncherResult<()> {
    let mut approvals = load_approvals(layout)?;
    let text = path.to_string_lossy().to_string();
    if let Some(existing) = approvals
        .write_roots
        .iter_mut()
        .find(|entry| entry.instance_id == instance_id && entry.root_id == root_id)
    {
        existing.path = text;
        existing.approved_at = now.to_string();
    } else {
        approvals.write_roots.push(ApprovedWriteRoot {
            instance_id: instance_id.to_string(),
            root_id: root_id.to_string(),
            path: text,
            approved_at: now.to_string(),
        });
    }
    save_approvals(layout, &approvals)
}

/// 该实例该根的已授权落点（没有 = `None`，调用方据此报 `SOURCE_NOT_APPROVED`）。
///
/// L3a 只写这张表（`launcher_pick_write_root`）；复验消费在 L3b 的安装 / 恢复流程。
#[allow(dead_code)]
pub fn approved_write_root(
    layout: &LauncherLayout,
    instance_id: &str,
    root_id: &str,
) -> LauncherResult<Option<PathBuf>> {
    let approvals = load_approvals(layout)?;
    Ok(approvals
        .write_roots
        .iter()
        .find(|entry| entry.instance_id == instance_id && entry.root_id == root_id)
        .map(|entry| PathBuf::from(&entry.path)))
}

/* ------------------------------- 运行锁 ------------------------------- */

/// 实例目录内的 `running.lock`：内存表之外的第二道保险（跨宿主进程）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredLock {
    pub schema_version: u32,
    pub instance_id: String,
    pub pid: u32,
    pub session_id: String,
    pub started_at: String,
    /// 进程创建时间（FILETIME  ticks）：pid 被复用时的核对位。
    #[serde(default)]
    pub process_start_ticks: Option<u64>,
    pub written_at: String,
}

pub fn read_lock(layout: &LauncherLayout, id: &str) -> LauncherResult<Option<StoredLock>> {
    read_json::<StoredLock>(&layout.lock_file(id)?, "运行锁")
}

pub fn write_lock(layout: &LauncherLayout, lock: &StoredLock) -> LauncherResult<()> {
    write_json(&layout.lock_file(&lock.instance_id)?, lock)
}

/// 只删属于该会话的锁（避免把下一场会话刚写的锁删掉）。
pub fn clear_lock(layout: &LauncherLayout, id: &str, session_id: &str) {
    let Ok(path) = layout.lock_file(id) else {
        return;
    };
    let matches = read_json::<StoredLock>(&path, "运行锁")
        .ok()
        .flatten()
        .map(|lock| lock.session_id == session_id)
        .unwrap_or(true);
    if matches {
        let _ = std::fs::remove_file(&path);
    }
}

/// 陈旧锁判定：pid 不存在 ⇒ 陈旧；pid 存在但创建时间与记录不符 ⇒ 陈旧（pid 复用）。
pub fn lock_is_stale(lock: &StoredLock) -> bool {
    match process::process_start_ticks(lock.pid) {
        None => true,
        Some(ticks) => match lock.process_start_ticks {
            Some(recorded) => recorded != ticks,
            // 记录里没有时间戳（旧版本写的锁）：只认 pid 存活与否
            None => false,
        },
    }
}
