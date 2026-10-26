//! 后台任务（P0 只有实例复制 / 复制实例两类；内容包与存档任务在 L3b）。
//!
//! 任务的存在理由：`copy` 档实例要把整棵游戏目录抄进 `instances/{id}/game/`，几 GB 的
//! 复制不能占着命令线程，也不能让"创建实例"这个动作看起来卡死。于是：
//! - `launcher_instance_create` 同步建清单（`state=preparing`）并**立即返回任务**；
//! - 工作线程按文件复制、每 100 ms 报一次进度、任意时刻可取消；
//! - 成功 → `state=ready`；失败 / 取消 → **删掉整个实例目录并从注册表摘除**（不留半成品）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use walkdir::WalkDir;

use super::error::{internal, LauncherErrorDto, LauncherResult};
use super::store;
use super::{iso_now, LauncherHost, EVENT_TASK};

/// 任务进度（`LauncherTask.progress` 同形）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgressDto {
    pub done: u64,
    pub total: u64,
    pub unit: String,
    pub message: String,
}

/// 任务（`LauncherTask` 同形）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDto {
    pub id: String,
    pub kind: String,
    pub instance_id: Option<String>,
    pub state: String,
    pub progress: Option<TaskProgressDto>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub error: Option<LauncherErrorDto>,
    pub result: Option<Value>,
    pub cancellable: bool,
}

pub struct TaskSlot {
    pub dto: TaskDto,
    pub cancel: Arc<AtomicBool>,
}

/// 进度事件的合并间隔（契约：≥100 ms）。
const PROGRESS_INTERVAL_MS: u128 = 100;

pub fn new_task_id(host: &LauncherHost) -> String {
    format!(
        "task-{}-{}-{:04}",
        super::session_stamp(),
        std::process::id(),
        host.next_seq()
    )
}

fn emit_task(host: &LauncherHost, task: &TaskDto) {
    host.emit_event(EVENT_TASK, json!({ "task": task }));
}

/// 存并广播（任务表的唯一写入口）。
fn store_task(host: &LauncherHost, task: TaskDto) {
    let cancel = host
        .tasks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&task.id)
        .map(|slot| slot.cancel.clone())
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    host.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(
        task.id.clone(),
        TaskSlot {
            dto: task.clone(),
            cancel,
        },
    );
    emit_task(host, &task);
}

pub fn list(host: &LauncherHost) -> Vec<TaskDto> {
    let tasks = host.tasks.lock().unwrap_or_else(|e| e.into_inner());
    let mut out: Vec<TaskDto> = tasks.values().map(|slot| slot.dto.clone()).collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    out
}

/// 取消：只置标记，**回滚由任务自己完成**（契约 §7.2）。终态任务不报错（幂等）。
pub fn cancel(host: &LauncherHost, task_id: &str) -> LauncherResult<()> {
    let tasks = host.tasks.lock().unwrap_or_else(|e| e.into_inner());
    let Some(slot) = tasks.get(task_id) else {
        return Err(
            LauncherErrorDto::new(super::error::ErrorCode::Internal, "找不到这个任务")
                .detail(format!("taskId={task_id}")),
        );
    };
    if matches!(
        slot.dto.state.as_str(),
        "succeeded" | "failed" | "cancelled"
    ) {
        return Ok(());
    }
    slot.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

fn skipped_relative(rel: &Path) -> bool {
    for component in rel.components() {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "logs" | "tmp" | "staging" | "backups" | ".git"
        ) {
            return true;
        }
    }
    rel.extension()
        .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("log"))
        .unwrap_or(false)
}

/// 源根下的文件清单（大小，字节）。符号链接不跟随（`follow_links(false)`）。
fn collect_files(source: &Path, skip_roots: &[PathBuf]) -> Vec<(PathBuf, u64)> {
    let mut files = Vec::new();
    for entry in WalkDir::new(source).follow_links(false) {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().to_path_buf();
        if skip_roots
            .iter()
            .any(|root| super::paths::path_has_prefix(root, &path))
        {
            continue;
        }
        let Ok(rel) = path.strip_prefix(source) else {
            continue;
        };
        if skipped_relative(rel) {
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        files.push((path, size));
    }
    files
}

fn update_progress(host: &LauncherHost, dto: &mut TaskDto, done: u64, total: u64, message: &str) {
    dto.progress = Some(TaskProgressDto {
        done,
        total,
        unit: "bytes".to_string(),
        message: message.to_string(),
    });
    host.tasks
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(dto.id.clone())
        .and_modify(|slot| slot.dto.progress = dto.progress.clone());
}

/// 起一个"把 `source` 抄进 `dest`"的任务。`dest` 只由 `paths::LauncherLayout` 拼。
pub fn enqueue_copy(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    kind: &'static str,
    source: PathBuf,
    dest: PathBuf,
    skip_roots: Vec<PathBuf>,
) -> TaskDto {
    let task = TaskDto {
        id: new_task_id(host),
        kind: kind.to_string(),
        instance_id: Some(instance_id.to_string()),
        state: "queued".to_string(),
        progress: None,
        created_at: iso_now(),
        started_at: None,
        ended_at: None,
        error: None,
        result: None,
        cancellable: true,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    host.tasks.lock().unwrap_or_else(|e| e.into_inner()).insert(
        task.id.clone(),
        TaskSlot {
            dto: task.clone(),
            cancel: cancel.clone(),
        },
    );
    emit_task(host, &task);

    let host_worker = host.clone();
    let task_id = task.id.clone();
    let instance_worker = instance_id.to_string();
    std::thread::Builder::new()
        .name(format!("launcher-task-{kind}"))
        .spawn(move || {
            run_copy(
                host_worker,
                task_id,
                instance_worker,
                source,
                dest,
                skip_roots,
                cancel,
            )
        })
        .expect("任务线程必须起得来");
    task
}

fn run_copy(
    host: Arc<LauncherHost>,
    task_id: String,
    instance_id: String,
    source: PathBuf,
    dest: PathBuf,
    skip_roots: Vec<PathBuf>,
    cancel: Arc<AtomicBool>,
) {
    let mut dto = {
        let tasks = host.tasks.lock().unwrap_or_else(|e| e.into_inner());
        match tasks.get(&task_id) {
            Some(slot) => slot.dto.clone(),
            None => return,
        }
    };
    dto.state = "running".to_string();
    dto.started_at = Some(iso_now());
    store_task(&host, dto.clone());

    let files = collect_files(&source, &skip_roots);
    let total: u64 = files.iter().map(|(_, size)| *size).sum();
    let mut done: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    let mut failure: Option<LauncherErrorDto> = None;
    let mut cancelled = false;
    for (src, size) in &files {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let rel = match src.strip_prefix(&source) {
            Ok(rel) => rel.to_path_buf(),
            Err(_) => {
                failure = Some(internal("复制路径无法相对化").detail(src.display().to_string()));
                break;
            }
        };
        let target = dest.join(&rel);
        let result = (|| -> std::io::Result<()> {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(src, &target)?;
            Ok(())
        })();
        if let Err(err) = result {
            failure = Some(super::error::io_failure("复制文件", &target, &err));
            break;
        }
        done = done.saturating_add(*size);
        if last_emit.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
            update_progress(&host, &mut dto, done, total, "正在复制游戏目录");
            emit_task(&host, &dto);
            last_emit = std::time::Instant::now();
        }
    }

    if cancelled {
        rollback_instance(&host, &instance_id);
        dto.state = "cancelled".to_string();
        dto.ended_at = Some(iso_now());
        dto.progress = Some(TaskProgressDto {
            done,
            total,
            unit: "bytes".to_string(),
            message: "已取消，半成品实例已清理".to_string(),
        });
        store_task(&host, dto);
        return;
    }

    if let Some(err) = failure {
        rollback_instance(&host, &instance_id);
        dto.state = "failed".to_string();
        dto.ended_at = Some(iso_now());
        dto.error = Some(err);
        store_task(&host, dto);
        return;
    }

    // 复制完成 → 实例转 ready（清单 + 注册表 + 事件）
    let mark = host.with_manifest(|layout| {
        let mut instance = store::load_instance(layout, &instance_id)?;
        instance.state = "ready".to_string();
        instance.updated_at = iso_now();
        store::save_instance(layout, &instance)?;
        let mut registry = store::load_registry(layout)?;
        let mut entry = instance.registry_entry();
        entry.state = "ready".to_string();
        registry.upsert(entry);
        store::save_registry(layout, &mut registry)
    });
    if let Err(err) = mark {
        rollback_instance(&host, &instance_id);
        dto.state = "failed".to_string();
        dto.ended_at = Some(iso_now());
        dto.error = Some(err);
        store_task(&host, dto);
        return;
    }
    host.emit_instance_change("state", &instance_id);

    dto.state = "succeeded".to_string();
    dto.ended_at = Some(iso_now());
    dto.progress = Some(TaskProgressDto {
        done,
        total,
        unit: "bytes".to_string(),
        message: "复制完成".to_string(),
    });
    dto.result = Some(json!({ "instanceId": instance_id }));
    store_task(&host, dto);
}

/// 失败 / 取消的回滚：删实例目录（只在实例根内）→ 从注册表摘除 → 发事件。
fn rollback_instance(host: &LauncherHost, instance_id: &str) {
    if let Ok(root) = host.layout.instance_root(instance_id) {
        if root.exists() {
            // 删前再确认一次落点在 instances/ 下（防拼错把别处删了）
            if super::paths::path_has_prefix(&host.layout.instances_dir(), &root) {
                let _ = std::fs::remove_dir_all(&root);
            }
        }
    }
    if let Ok(mut registry) = store::load_registry(&host.layout) {
        if registry.remove(instance_id) {
            let _ = store::save_registry(&host.layout, &mut registry);
        }
    }
    host.emit_instance_change("removed", instance_id);
}
