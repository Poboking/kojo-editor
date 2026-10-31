//! 启动器的**宿主特权面**（Rust 侧；`docs/LAUNCHER-ARCHITECTURE.md` §7 / §8 / §13）。
//!
//! 这个模块只做「已登记实例的进程托管 + 实例/日志的落盘」，**不认识任何具体游戏**：
//! 启动参数、存档根、内容根都由 TS 侧 adapter 编译好经 `launcher_instance_create`
//! 的 `{ request, profile }` 载荷传进来；宿主不理解它们的语义，只按形状校验。
//!
//! 三个不可协商的边界：
//! 1. **只认 `instanceId`**：没有任何命令接受"目标程序路径"，exe 是实例清单里的
//!    `executable.relativePath`（相对游戏根），拼绝对路径后逐段校验（见 `paths`）；
//! 2. **写落点全由 `paths::LauncherLayout` 拼**：命令不接受任意目标路径；唯一的
//!    "写域外"通道是原生对话框 + 同命令写盘（`launcher_log_export`）；
//! 3. **非 Windows 明确不支持**：没有 Job Object 就没有杀树保证，不做 shell 兜底。
//!
//! 线程模型（`process.rs`）：命令本身都是 `async`（`CreateProcessW` 实测阻塞 280~375 ms，
//! 必须放工作线程）；进程拉起后由**两条日志泵线程 + 一条监视线程**接管，命令立即返回。

pub mod commands;
pub mod content;
pub mod error;
pub mod job;
pub mod logs;
pub mod paths;
pub mod process;
pub mod project;
pub mod saves;
pub mod store;
pub mod tasks;
pub mod trust;

#[cfg(test)]
mod content_tests;
#[cfg(test)]
mod project_tests;
#[cfg(test)]
mod save_tests;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::{json, Value};

use self::error::LauncherResult;
use self::paths::LauncherLayout;
use self::process::{ProcessStatusDto, RunningProc};
use self::tasks::TaskSlot;

/* ------------------------------- 事件 ------------------------------- */

pub const EVENT_PROCESS: &str = "kojo:launcher-process";
pub const EVENT_LOG: &str = "kojo:launcher-log";
pub const EVENT_TASK: &str = "kojo:launcher-task";
pub const EVENT_INSTANCE: &str = "kojo:launcher-instance";

/// 事件发射器：生产环境包 `AppHandle::emit`，测试里换成记录器。
///
/// 线程安全 + 不返回错误：事件是"通知"，发不出去不该拖垮进程托管（前端会靠
/// `launcher_process_list` / `launcher_log_read` 重新对齐）。
pub type EmitFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// 生产环境的发射器（`tauri::AppHandle` 是 `Send + Sync` 且可克隆）。
pub fn app_emitter(app: tauri::AppHandle) -> EmitFn {
    use tauri::Emitter;
    Arc::new(move |event: &str, payload: Value| {
        if let Err(err) = app.emit(event, payload) {
            eprintln!("[launcher] 事件 {event} 发送失败：{err}");
        }
    })
}

/* ------------------------------- 时钟 ------------------------------- */

/// 当前 Unix 毫秒。
pub(crate) fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// ISO-8601（UTC，秒精度，`Z` 结尾）——与契约里的 `createdAt` / `startedAt` 同形。
pub(crate) fn iso_now() -> String {
    iso_from_unix_ms(unix_ms())
}

pub(crate) fn iso_from_unix_ms(ms: u128) -> String {
    let secs = (ms / 1000) as u64;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days：Unix 天数 → (年, 月, 日)，无第三方依赖。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 文件名安全的会话时间戳（`YYYYMMDDTHHMMSSmmm`）：日志文件名用它，不用 ISO 里的冒号。
pub(crate) fn session_stamp() -> String {
    iso_from_unix_ms(unix_ms())
        .replace(['-', ':'], "")
        .replace('Z', "")
}

/* ------------------------------- 宿主状态 ------------------------------- */

/// 命令层共享的宿主状态（`Arc` 交给 Tauri `manage`，线程各自克隆）。
pub struct LauncherHost {
    pub layout: LauncherLayout,
    emit: EmitFn,
    seq: AtomicU64,
    /// 正在跑的实例（内存表；`running.lock` 是跨宿主进程的第二道保险）。
    pub(crate) running: Mutex<HashMap<String, RunningProc>>,
    /// 每个实例的"最近一次状态快照"（退出后 `process_status` 仍要有读数）。
    pub(crate) last: Mutex<HashMap<String, ProcessStatusDto>>,
    /// 后台任务（P0：只有实例复制 / 复制实例两类）。
    pub(crate) tasks: Mutex<BTreeMap<String, TaskSlot>>,
    /// 清单读-改-写的串行闸：启动次数、退出记录会从不同线程写同一份 `instance.json`。
    pub(crate) manifest_io: Mutex<()>,
}

impl LauncherHost {
    pub fn new(app_data_dir: &Path, emit: EmitFn) -> Arc<Self> {
        Arc::new(Self {
            layout: LauncherLayout::new(app_data_dir),
            emit,
            seq: AtomicU64::new(0),
            running: Mutex::new(HashMap::new()),
            last: Mutex::new(HashMap::new()),
            tasks: Mutex::new(BTreeMap::new()),
            manifest_io: Mutex::new(()),
        })
    }

    /// 严格递增的事件序号（UI 去重用；每个事件都自带）。
    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn emit_event(&self, event: &str, mut payload: Value) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("seq".to_string(), json!(self.next_seq()));
        }
        (self.emit)(event, payload);
    }

    pub fn emit_instance_change(&self, kind: &str, instance_id: &str) {
        self.emit_event(
            EVENT_INSTANCE,
            json!({ "kind": kind, "instanceId": instance_id }),
        );
    }

    pub(crate) fn running_map(&self) -> MutexGuard<'_, HashMap<String, RunningProc>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn set_status(&self, status: ProcessStatusDto) {
        self.last
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(status.instance_id.clone(), status);
    }

    /// 只有"仍是这一场会话"才摘掉运行记录（防快速重启时误摘新会话）。
    pub(crate) fn finish_running(&self, instance_id: &str, session_id: &str) -> bool {
        let mut map = self.running_map();
        let matches = map
            .get(instance_id)
            .map(|proc| proc.session_id == session_id)
            .unwrap_or(false);
        if matches {
            map.remove(instance_id);
        }
        matches
    }

    /// 清单读-改-写（持锁调用本函数，别在锁里做长 IO 之外的事）。
    pub(crate) fn with_manifest<T>(
        &self,
        f: impl FnOnce(&LauncherLayout) -> LauncherResult<T>,
    ) -> LauncherResult<T> {
        let _guard = self.manifest_io.lock().unwrap_or_else(|e| e.into_inner());
        f(&self.layout)
    }
}
