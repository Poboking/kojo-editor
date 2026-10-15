//! kojo-editor Tauri 宿主。
//!
//! 本层的全部职责 = 为 WebView 内的内核提供 **PlatformBridge 原语**：
//! 文件字节读写（原子写）、目录遍历、编解码（encoding_rs）、目录对话框、应用数据目录、
//! 文件监视（notify 原始事件转发；去抖与判定在内核 TS）。
//! **零游戏知识、零业务逻辑**——一切领域逻辑都在前端的内核与插件中。
//!
//! 二进制数据经 base64 字符串跨 IPC（确定性强；口上文件体量下开销可忽略）。

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// 市场 IO 原语（远程下载 + ZIP 安全解压）独立成文件：它自带一整套安全闸与 fixture，
/// 塞进本文件会把既有 IO 正文淹掉（照 `search_tests` 的分文件先例）。
mod market;

/* --------------------- 写允许域（审阅 M3：纵深防御） --------------------- */
//
// JS 层 kernel io 的 writablePaths 白名单是第一道闸；本层是第二道闸：
// 即便 JS 层被绕过，Rust 命令也只接受「允许域」内的写路径。
//
// 允许域 = 项目根目录（project.opened 时由前端注册；project.closed 后清除）
//        + appDataDir（备份 / 配置 / 存储，常驻允许）。
// 其余路径一律拒绝并返回明确错误（不静默、fail-closed）。
//
// 判定域语义与 kernel writablePaths 一致：项目根目录整体（含游戏目录）。
// 注意 JS 层的 writablePaths 是项目根的**子集**（用户显式批准）——
// 语义以更严者为准，双闸并存不冲突。

/// Tauri 托管状态：当前注册的项目根目录（None = 仅 appDataDir 可写）
/// + **常驻授权的项目位置根**（`extra_roots`，2026-10-14 新建项目自选位置批）。
///
/// `extra_roots` 的唯一来源是 `choose_workspace_root` 里**用户在系统目录对话框中选定**
/// 的目录（对话框即授权）与磁盘清单 `<appDataDir>/workspace_roots.txt` 的读回。
/// **没有任何命令接受路径参数来授予写权限**——JS 侧不存在"给个路径就放行"的入口。
#[derive(Default)]
struct WriteDomainState {
    project_root: Mutex<Option<PathBuf>>,
    extra_roots: Mutex<Vec<PathBuf>>,
}

/// 规范化路径：找到最深的已存在祖先做 canonicalize（解析 `..` 与符号链接），
/// 再把其余组件追加回去。不存在于磁盘的目标（原子写的待建文件）同样可判定。
fn canonicalize_deep(path: &Path) -> std::io::Result<PathBuf> {
    let mut cur = path;
    let mut extra: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match cur.canonicalize() {
            Ok(canon) => {
                let mut result = canon;
                for seg in extra.into_iter().rev() {
                    result.push(seg);
                }
                return Ok(result);
            }
            Err(_) => match (cur.parent(), cur.file_name()) {
                (Some(parent), Some(name)) => {
                    extra.push(name.to_os_string());
                    cur = parent;
                }
                _ => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no existing ancestor to canonicalize",
                    ))
                }
            },
        }
    }
}

/// 路径 → 小写组件序列（Windows 大小写不敏感；同义写法折叠成同一个键）。
fn lowered_components(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// 组件级前缀比较（Windows 大小写不敏感；`foo` 与 `foobar` 不会误判为包含）。
fn is_within(canonical_path: &Path, canonical_root: &Path) -> bool {
    let p = lowered_components(canonical_path);
    let r = lowered_components(canonical_root);
    p.len() >= r.len() && p.iter().zip(r.iter()).all(|(a, b)| a == b)
}

/// 同一个目录的两种写法（大小写 / 尾分隔符）算一个根：整串组件相等才算。
fn is_same_path(a: &Path, b: &Path) -> bool {
    lowered_components(a) == lowered_components(b)
}

/// 追加常驻授权根（按规范化路径去重）；返回是否真的新增。
/// 去重要经 `canonicalize_deep`——对话框回来的路径常带 `\\?\` 前缀或大小写差异，
/// 纯字符串比较会把同一个目录认成两次授权。
fn push_extra_root(list: &mut Vec<PathBuf>, root: &Path) -> bool {
    let same = |p: &Path| -> bool {
        match (canonicalize_deep(p), canonicalize_deep(root)) {
            (Ok(a), Ok(b)) => is_same_path(&a, &b),
            _ => is_same_path(p, root),
        }
    };
    if list.iter().any(|p| same(p)) {
        return false;
    }
    list.push(root.to_path_buf());
    true
}

/// 常驻授权根清单文件（appDataDir 下，一行一路径，UTF-8）。
const WORKSPACE_ROOTS_FILE: &str = "workspace_roots.txt";

fn workspace_roots_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(WORKSPACE_ROOTS_FILE)
}

/// 从磁盘读回常驻授权根：文件不存在 = 空列表（首次运行的正常态）；
/// 读失败**出声**（stderr）后按空处理——不静默，也不连累启动。
fn read_workspace_roots(app_data_dir: &Path) -> Vec<PathBuf> {
    let file = workspace_roots_file(app_data_dir);
    match std::fs::read_to_string(&file) {
        Ok(text) => text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            eprintln!(
                "[workspace_roots] 读取授权根清单失败（按空处理）{}: {e}",
                file.display()
            );
            Vec::new()
        }
    }
}

/// 落盘常驻授权根清单（整表重写 ⇒ 天然去重、无追加竞态）。
fn write_workspace_roots(app_data_dir: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let file = workspace_roots_file(app_data_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建授权根清单目录失败 {}: {e}", parent.display()))?;
    }
    let mut body = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    std::fs::write(&file, body).map_err(|e| format!("写授权根清单失败 {}: {e}", file.display()))
}

/// 纯逻辑判定（可单测，不依赖 Tauri 类型）：
/// `project_root` = 当前注册的项目根（可为 None），`app_data_dir` 常驻允许，
/// `extra_roots` = 用户经对话框自选并常驻授权的项目位置根。
fn ensure_in_write_domain(
    project_root: Option<&Path>,
    app_data_dir: &Path,
    extra_roots: &[PathBuf],
    path: &Path,
    op: &str,
) -> Result<(), String> {
    let canon_target = canonicalize_deep(path)
        .map_err(|e| format!("写允许域（{op}）：路径解析失败 {path_display}: {e}", path_display = path.display()))?;
    let mut roots: Vec<PathBuf> = vec![app_data_dir.to_path_buf()];
    if let Some(r) = project_root {
        roots.push(r.to_path_buf());
    }
    roots.extend(extra_roots.iter().cloned());
    for root in &roots {
        let canon_root = canonicalize_deep(root).map_err(|e| {
            format!(
                "写允许域（{op}）：允许域根目录解析失败 {}: {e}",
                root.display()
            )
        })?;
        if is_within(&canon_target, &canon_root) {
            return Ok(());
        }
    }
    Err(format!(
        "写允许域拒绝（{op}）：{} 不在允许域内（允许 = 项目根目录 / appDataDir / 自选项目位置；未打开项目时仅 appDataDir + 自选项目位置）",
        path.display()
    ))
}

/// 命令侧包装：取 appDataDir + 当前注册的项目根 + 常驻授权根，执行判定。
fn ensure_write_allowed(
    app: &tauri::AppHandle,
    state: &WriteDomainState,
    path: &Path,
    op: &str,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let root = state
        .project_root
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .clone();
    let extras = state
        .extra_roots
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .clone();
    ensure_in_write_domain(root.as_deref(), &app_dir, &extras, path, op)
}

/// project.opened：前端注册项目根目录（允许域 = 项目根 + appDataDir）。
#[tauri::command]
fn register_write_domain(state: tauri::State<'_, WriteDomainState>, root: String) -> Result<(), String> {
    let mut guard = state
        .project_root
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?;
    *guard = Some(PathBuf::from(root));
    Ok(())
}

/// project.closed：清除项目根（回到仅 appDataDir 可写）。
#[tauri::command]
fn clear_write_domain(state: tauri::State<'_, WriteDomainState>) -> Result<(), String> {
    let mut guard = state
        .project_root
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?;
    *guard = None;
    Ok(())
}

/* ------------------------------- DTO ------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryDto {
    name: String,
    path: String,
    is_directory: bool,
    /// `walkDir({withMetadata:true})` 时填充；其余情况**整个键不出现**（前端拿到 undefined，
    /// 而不是被当成 0）。取值走 `mtime_ms_of`，与 `stat_file` 逐位同值 ⇒ 才有资格省掉那次 stat。
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStatDto {
    size: u64,
    mtime_ms: f64,
    is_directory: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct WalkOptionsDto {
    max_depth: Option<usize>,
    include_files: Option<bool>,
    include_dirs: Option<bool>,
    /// true ⇒ 每个文件条目顺带带回 mtime/size（省掉调用方的逐文件 `stat_file` 往返）。
    /// 默认 false：既有调用的开销形态不变。
    with_metadata: Option<bool>,
}

/// mtime → epoch 毫秒。`stat_file` 与 `walk_dir(withMetadata)` **共用这一份实现**：
/// 只有逐位同值，索引的体量指纹与逐文件复用判据才不会因为换了取数路径而变化。
fn mtime_ms_of(t: Option<std::time::SystemTime>) -> f64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/* ---------------------------- 文件原语 ---------------------------- */

#[tauri::command]
fn read_file_bytes(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(B64.encode(bytes))
}

/// 同一件事，但**响应以二进制过界**：Tauri 把 `ipc::Response` 的 body 原样送到前端，
/// 前端拿到 `ArrayBuffer`。省掉 base64 的 1.34× 膨胀和 JS 侧逐字节还原——
/// 开项目热路径每轮要读两份 10 MB 级快照（IMPLEMENTATION-LOG §5.91 实机读数）。
/// `read_file_bytes` 保留：它仍是 smoke 脚本与"两条通道逐字节对照"探针的参照物。
#[tauri::command]
fn read_file_bytes_raw(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 原子写：同目录临时文件 + rename（Windows 上 rename 覆盖已存在文件）。
/// 写允许域第二道闸（M3）：目标路径必须在允许域内。
#[tauri::command]
fn write_file_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
    data: String,
) -> Result<(), String> {
    ensure_write_allowed(&app, &state, Path::new(&path), "write")?;
    let bytes = B64.decode(data).map_err(|e| format!("base64 decode: {e}"))?;
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or_else(|| format!("no parent directory: {path}"))?
        .to_path_buf();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed");
    let tmp = dir.join(format!(".{file_name}.{}.kojo-tmp", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write tmp: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename: {e}"));
    }
    Ok(())
}

#[tauri::command]
fn ensure_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
) -> Result<(), String> {
    ensure_write_allowed(&app, &state, Path::new(&path), "ensure_dir")?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryDto>, String> {
    let mut out = Vec::new();
    let read = match std::fs::read_dir(&path) {
        Ok(r) => r,
        Err(_) => return Ok(out), // 路径不存在 → 空列表（与 NodeBridge 语义一致）
    };
    for entry in read.flatten() {
        let md = entry.metadata().ok();
        out.push(DirEntryDto {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory: md.map(|m| m.is_dir()).unwrap_or(false),
            // listDir 没有 withMetadata 选项：输出形态与改造前逐字一致（键直接不出现）
            mtime_ms: None,
            size: None,
        });
    }
    Ok(out)
}

#[tauri::command]
fn walk_dir(path: String, opts: Option<WalkOptionsDto>) -> Result<Vec<DirEntryDto>, String> {
    let o = opts.unwrap_or_default();
    let include_files = o.include_files.unwrap_or(true);
    let include_dirs = o.include_dirs.unwrap_or(false);
    let max_depth = o.max_depth.unwrap_or(usize::MAX);
    let with_metadata = o.with_metadata.unwrap_or(false);

    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(&path)
        .min_depth(1)
        .max_depth(if max_depth == usize::MAX { usize::MAX } else { max_depth + 1 });
    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        let is_dir = entry.file_type().is_dir();
        // include_dirs 只控制“是否输出目录条目”，递归不受影响
        if is_dir && !include_dirs {
            continue;
        }
        if !is_dir && !include_files {
            continue;
        }
        let p = entry.path();
        // 顺路取元数据：Windows 上 `DirEntry::metadata()` 用的是枚举时已经拿到的信息，
        // 不再额外系统调用——**这正是"一次遍历替掉 N 次 stat"成立的前提**。
        // 取不到就留空（前端退化回 stat_file），绝不伪造 0。
        let (mtime_ms, size) = match (with_metadata, is_dir) {
            (true, false) => match entry.metadata() {
                Ok(md) => (Some(mtime_ms_of(md.modified().ok())), Some(md.len())),
                Err(_) => (None, None),
            },
            _ => (None, None),
        };
        out.push(DirEntryDto {
            name: entry.file_name().to_string_lossy().to_string(),
            path: p.to_string_lossy().to_string(),
            is_directory: is_dir,
            mtime_ms,
            size,
        });
    }
    Ok(out)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn stat_file(path: String) -> Option<FileStatDto> {
    let md = std::fs::metadata(&path).ok()?;
    let mtime_ms = mtime_ms_of(md.modified().ok());
    Some(FileStatDto {
        size: md.len(),
        mtime_ms,
        is_directory: md.is_dir(),
    })
}

/* --------------------- 批量读（二进制帧，2026-10-16 批量 IO 批） --------------------- */
//
// 冷开一次项目要对语料做 ~9,000 次单文件读，而 JS 侧每读一个文件要 2 趟 IPC
// （read_file_bytes_raw + stat_file）。本段把"读一批文件 + 带回元数据"压成一个命令一趟 IPC
// —— 仍是纯 IO 原语（不认识任何领域概念，批大小与使用姿势全由调用方定）。
//
// 帧格式刻意朴素（定长头 + 长度前缀，全小端；JS 侧解帧器是纯 DataView 函数，
// 见 packages/app/src/bridge/read-files-frame.ts，两份实现成对演进）：
//   [u32 文件数]
//   每文件：[u32 pathLen][path(utf-8 字节)][u32 status][i64 mtimeMs][u64 size][u64 dataLen][data]
//
// 设计口径：
// - 逐文件失败**不失败整批**：status 三态（0=ok / 1=不存在 / 2=读错）如实带回；
// - 输出顺序 = 入参顺序（并行只影响内部完成次序，结果按下标回位）；
// - 字节原样进帧（不转码、不剥 BOM）——解码口径归调用方（内核 encoding.ts 单一真源）。

/// 帧内单文件状态码（与 JS 侧解帧器逐字对应）
const FRAME_STATUS_OK: u32 = 0;
const FRAME_STATUS_NOT_FOUND: u32 = 1;
const FRAME_STATUS_READ_ERROR: u32 = 2;

/// 批量读的并行度（与检索段缺省同量级：索引/抽取段的读盘并发本就是 8）
const BATCH_READ_THREADS: usize = 8;

/// mtime → epoch 毫秒（i64 帧字段）。与 `mtime_ms_of`（f64）同源；ms 级整数在 f64 里
/// 可精确表示 ⇒ 两侧比等值不会漂。
fn mtime_ms_i64(t: Option<std::time::SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 单文件读取结果（帧编码前的中介形态；纯数据）
struct RawFileRead {
    path: String,
    status: u32,
    mtime_ms: i64,
    size: u64,
    data: Vec<u8>,
}

/// 读一个文件（含元数据）。读不到的**分类如实**：NotFound 与其它 IO 错误分开报，
/// 让调用方能区分"文件没了"与"读不动"（都不可静默）。
fn read_one_file(path: &str) -> RawFileRead {
    match std::fs::read(path) {
        Ok(data) => {
            // 元数据取不到不致命（退化为 0；缓存判据要求 stat 两侧都有值才命中，不会误中）
            let (mtime_ms, size) = match std::fs::metadata(path) {
                Ok(md) => (mtime_ms_i64(md.modified().ok()), md.len()),
                Err(_) => (0, data.len() as u64),
            };
            RawFileRead {
                path: path.to_string(),
                status: FRAME_STATUS_OK,
                mtime_ms,
                size,
                data,
            }
        }
        Err(e) => RawFileRead {
            path: path.to_string(),
            status: if e.kind() == std::io::ErrorKind::NotFound {
                FRAME_STATUS_NOT_FOUND
            } else {
                FRAME_STATUS_READ_ERROR
            },
            mtime_ms: 0,
            size: 0,
            data: Vec::new(),
        },
    }
}

/// 批量读并编码成帧（并行读、按下标回位；`len<=1` 不铺线程）。
/// 纯函数面独立出来是为了可单测（帧一旦漂，前端解帧器静默错位——比读失败更坏）。
fn read_files_frame(paths: &[String]) -> Vec<u8> {
    let results: Vec<RawFileRead> = if paths.len() <= 1 {
        paths.iter().map(|p| read_one_file(p)).collect()
    } else {
        let next = AtomicUsize::new(0);
        let workers = paths.len().min(BATCH_READ_THREADS);
        let mut collected: Vec<(usize, RawFileRead)> = std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for _ in 0..workers {
                let next = &next;
                handles.push(scope.spawn(move || {
                    let mut local: Vec<(usize, RawFileRead)> = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= paths.len() {
                            break;
                        }
                        local.push((i, read_one_file(&paths[i])));
                    }
                    local
                }));
            }
            let mut merged: Vec<(usize, RawFileRead)> = Vec::new();
            for h in handles {
                if let Ok(mut local) = h.join() {
                    merged.append(&mut local);
                }
            }
            merged
        });
        collected.sort_by_key(|(i, _)| *i);
        collected.into_iter().map(|(_, r)| r).collect()
    };

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&(results.len() as u32).to_le_bytes());
    for r in &results {
        let path_bytes = r.path.as_bytes();
        out.extend_from_slice(&(path_bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(path_bytes);
        out.extend_from_slice(&r.status.to_le_bytes());
        out.extend_from_slice(&r.mtime_ms.to_le_bytes());
        out.extend_from_slice(&r.size.to_le_bytes());
        out.extend_from_slice(&(r.data.len() as u64).to_le_bytes());
        out.extend_from_slice(&r.data);
    }
    out
}

/// 批量读：一次 IPC 带回多文件原始字节 + 元数据（`ipc::Response` 二进制过界，无 base64 膨胀）。
/// 逐文件失败不改整批的成败（status 三态在帧里），故本命令无 Result 错误面。
#[tauri::command]
fn read_files_raw(paths: Vec<String>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(read_files_frame(&paths))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchStatDto {
    path: String,
    exists: bool,
    /// 存在时与 `stat_file` 同源同值；不存在 ⇒ null（不拿 0 兜底）
    mtime_ms: Option<f64>,
    size: Option<u64>,
}

/// 批量 stat（小载荷，JSON 形态）：与 `stat_file` 共用 `mtime_ms_of`（判据同源不漂）。
/// 逐文件失败 ⇒ `exists:false`，不抛整批（与 `read_files_raw` 同口径）。
#[tauri::command]
fn stat_files(paths: Vec<String>) -> Vec<BatchStatDto> {
    paths
        .iter()
        .map(|p| match std::fs::metadata(p) {
            Ok(md) => BatchStatDto {
                path: p.clone(),
                exists: true,
                mtime_ms: Some(mtime_ms_of(md.modified().ok())),
                size: Some(md.len()),
            },
            Err(_) => BatchStatDto {
                path: p.clone(),
                exists: false,
                mtime_ms: None,
                size: None,
            },
        })
        .collect()
}

#[tauri::command]
fn rename_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    from: String,
    to: String,
) -> Result<(), String> {
    // rename 同时改动 from（移走）与 to（写入），两端都在允许域内才放行
    ensure_write_allowed(&app, &state, Path::new(&from), "rename_src")?;
    ensure_write_allowed(&app, &state, Path::new(&to), "rename_dst")?;
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    from: String,
    to: String,
) -> Result<(), String> {
    // from 是读取源（读路径不受允许域限制）；to 是写入目标，必须过闸
    ensure_write_allowed(&app, &state, Path::new(&to), "copy_dst")?;
    if let Some(parent) = Path::new(&to).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
) -> Result<(), String> {
    ensure_write_allowed(&app, &state, Path::new(&path), "remove")?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// 递归删除目录（不存在则幂等成功；同写允许域第二道闸）。
#[tauri::command]
fn remove_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
) -> Result<(), String> {
    ensure_write_allowed(&app, &state, Path::new(&path), "remove_dir")?;
    match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ---------------------------- 对话框 / 环境 ---------------------------- */

#[tauri::command]
async fn choose_directory(title: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    Ok(dialog
        .pick_folder()
        .await
        .map(|h| h.path().to_string_lossy().to_string()))
}

/// 自选**项目位置**（2026-10-14 新建口上项目自选位置批）。
///
/// **对话框即授权，且授权与对话框绑在这一个命令内**：用户在系统目录对话框里选定后，
/// 本命令立刻把它追加进常驻授权根（`WriteDomainState::extra_roots`）、落盘
/// `<appDataDir>/workspace_roots.txt`，再把路径返回给 JS。
/// 用户取消 → 返回 `None`，内存与磁盘状态都不动。
///
/// 铁律 6 的落点：**没有任何命令接受路径参数来"授予"写权限**。
/// 写允许域只能经这条"弹对话框 → 用户选定"的路径变宽；
/// JS 侧不存在"给我一个路径我就放行"的入口（对照 `export_file` 的同一形态）。
#[tauri::command]
async fn choose_workspace_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    let picked = match dialog.pick_folder().await {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(None), // 取消 = 不改任何授权状态
    };
    // 快照在锁内取、落盘在块外做：不持着锁去做磁盘 IO
    let snapshot = {
        let mut guard = state
            .extra_roots
            .lock()
            .map_err(|_| "write domain state poisoned".to_string())?;
        push_extra_root(&mut guard, &picked);
        guard.clone()
    };
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    write_workspace_roots(&app_dir, &snapshot)?;
    eprintln!(
        "[choose_workspace_root] 项目位置已授权并登记：{}（常驻根共 {} 个）",
        picked.display(),
        snapshot.len()
    );
    Ok(Some(picked.to_string_lossy().to_string()))
}

/// 只读：当前常驻授权的**自选**项目位置根（不含默认工作区根——那由内核自己拼）。
///
/// 取值 = 内存 ∪ 磁盘清单（去重、保授权顺序），并剔掉磁盘上已不存在的目录
/// （作者删了那个文件夹 / 换了机器），剔的时候出声。
/// `setup` 已经把清单读进内存，这里再合并一次是为了：setup 读失败也不能让前端永远看不见已授权根。
#[tauri::command]
fn workspace_roots(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let memory = state
        .extra_roots
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .clone();
    let mut merged: Vec<PathBuf> = Vec::new();
    for p in memory.into_iter().chain(read_workspace_roots(&app_dir)) {
        if !merged.iter().any(|q| is_same_path(q, &p)) {
            merged.push(p);
        }
    }
    let mut out = Vec::new();
    for p in merged {
        if !p.is_dir() {
            eprintln!("[workspace_roots] 授权根不存在，跳过：{}", p.display());
            continue;
        }
        out.push(p.to_string_lossy().to_string());
    }
    Ok(out)
}

/// 导出**单个文件**到用户选定的位置（ZIP 发布包用；base64 过 IPC，与 `write_file_bytes` 同口径）。
///
/// 落点在写域之外是设计意图：**授权来自用户在系统保存对话框里的
/// 显式选择，且对话框与写盘绑在同一个命令内**（JS 拿不到落点决定权，也就无法把写操作
/// 引导到任意路径）。因此这里刻意不过 `ensure_write_allowed`。
///
/// 这是全仓唯一一条"写到允许域之外"的法定通道（曾有的同形态命令 `export_directory`
/// 因无调用方已删，见 IMPLEMENTATION-LOG §5.97）。新增绕闸能力必须照本命令的形态。
///
/// `file_name` 只是对话框的**预填建议**，不是落点：仍剥掉路径分隔符，避免一个坏名字
/// 把对话框初始目录带偏。
#[tauri::command]
async fn export_file(
    file_name: String,
    data: String,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let bytes = B64.decode(&data).map_err(|e| format!("base64 decode: {e}"))?;
    let suggestion = file_name.replace(['/', '\\'], "_");

    let mut dialog = rfd::AsyncFileDialog::new()
        .set_file_name(&suggestion)
        .add_filter("ZIP 压缩包", &["zip"]);
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    let picked = match dialog.save_file().await {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(None),
    };
    if let Some(parent) = picked.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败：{e}"))?;
    }
    std::fs::write(&picked, &bytes).map_err(|e| format!("导出写入失败：{e}"))?;
    eprintln!(
        "[export_file] {} 字节 → {}",
        bytes.len(),
        picked.display()
    );
    Ok(Some(picked.to_string_lossy().to_string()))
}

#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/* ------------------------------ 编解码 ------------------------------ */

fn encoding_for(name: &str) -> Result<&'static encoding_rs::Encoding, String> {
    Ok(match name {
        "utf-8" | "utf-8-bom" => encoding_rs::UTF_8,
        "shift_jis" => encoding_rs::SHIFT_JIS,
        "utf-16le" => encoding_rs::UTF_16LE,
        "utf-16be" => encoding_rs::UTF_16BE,
        other => return Err(format!("unsupported encoding: {other}")),
    })
}

/// 字节 → 字符串（BOM 由 encoding_rs decode 自动剥离）。
/// **读路径已不再调用它**（2026-10-13 §5.90 实机复测：每读一个文件为此多跑一趟 IPC，整份字节
/// base64 送回 Rust 只解码一次）。命令保留注册——它是"客户端 TextDecoder vs encoding_rs"
/// 等价性验证的对照物（两者实现同一份 WHATWG Encoding 标准）。
/// 注意：Shift-JIS 等非严格解码遇无法映射字节会替换为 U+FFFD（`had_errors`
/// 当前未上抛——只读浏览不宜硬阻塞；写回时由 `encode_string` 的
/// had_errors 检查兜底，U+FFFD 无法再编码 → 拒绝保存，损坏不落盘）。
#[tauri::command]
fn decode_bytes(data: String, encoding: String) -> Result<String, String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    let enc = encoding_for(&encoding)?;
    let (text, _actual, had_errors) = enc.decode(&bytes);
    if had_errors {
        // 显式记录（stderr），不静默；文本仍返回供只读浏览
        eprintln!("[decode_bytes] {encoding}: replacement chars present (input not fully valid)");
    }
    Ok(text.into_owned())
}

/// 字符串 → 字节；`utf-8-bom` 显式加 BOM。
/// 审阅 M2 修复（2026-10-10）：encoding_rs 对不可映射字符默认输出 HTML
/// numeric entity（`&#NNNN;`），静默写入即数据损坏（引擎读为字面乱码）。
/// 有 had_errors 一律拒绝并报错，由调用方提示"内容含该编码无法表示的字符"。
#[tauri::command]
fn encode_string(text: String, encoding: String) -> Result<String, String> {
    let buf: Vec<u8> = match encoding.as_str() {
        "utf-8" => text.into_bytes(),
        "utf-8-bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(text.as_bytes());
            v
        }
        other => {
            let enc = encoding_for(other)?;
            let (encoded, _, had_errors) = enc.encode(&text);
            if had_errors {
                return Err(format!(
                    "内容含 {other} 无法表示的字符（如简体字/Emoji 被替换为 HTML 实体），已拒绝写入以防乱码；请先移除这些字符或将文件转为 UTF-8"
                ));
            }
            encoded.into_owned()
        }
    };
    Ok(B64.encode(buf))
}

/* ---------------------------- 文件监视（BUG-5） ---------------------------- */
//
// 本层只做两件事：起 notify 递归监视、把**原始**事件逐条转发给 WebView。
// 去抖 / 合并 / 「是不是我自己写的」判定全在内核 TS（口径见
// `packages/plugin-api/src/platform.ts` 的 `WatchCallback` 注释：
// 「内核会在平台事件之上做去抖与归一化」）。
//
// 唯一的例外是下面 `is_atomic_write_temp`：那是**本文件自己的原子写产物**
// （`write_file_bytes` 造 `.{name}.{pid}.kojo-tmp` 再 rename），属于 IO 机械噪声，
// 留在 IO 层滤掉，不算业务策略。

/// WebView 事件名：原始文件变更。payload = `{ kind, path }`。
const FS_CHANGED_EVENT: &str = "kojo:fs-changed";
/// WebView 事件名：监视器自身出错（目录被卸载 / 句柄失效等）。payload = `{ error }`。
/// 单独一条通道而不是塞进 FS_CHANGED_EVENT，是为了让前端**显式降级**而不是静默失灵。
const FS_WATCH_ERROR_EVENT: &str = "kojo:fs-watch-error";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    /// 与 `plugin-api` 的 `FileChangeKind` 一一对应
    kind: &'static str,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchErrorPayload {
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedRoot {
    path: String,
    error: String,
}

/// `start_watch` 回执：哪些根真的监视上了、哪些没有以及为什么。
/// 全空不算错误（返回 Ok），由前端据此进入「监视不可用」的显式降级态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchReport {
    watched: Vec<String>,
    failed: Vec<FailedRoot>,
}

/// 原子写的临时文件不算内容变更：rename 之后目标路径会自己出一条事件，
/// 临时文件那两条（create / remove）纯属重复噪声，还会让消费方读到半成品。
fn is_atomic_write_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with('.') && name.ends_with(".kojo-tmp"))
        .unwrap_or(false)
}

/// notify 事件类别 → 契约三态（纯函数，可单测）。`None` = 本层丢弃。
fn normalize_event_kind(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("add"),
        EventKind::Remove(_) => Some("unlink"),
        // 改名前的旧名 = 那个路径的东西没了
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some("unlink"),
        // RenameTo / RenameBoth 归 change：消费方按「盘上内容可能变了」重读，
        // 比按「新文件」处理更保守（Both 场景下两个路径谁是谁都分不清）。
        EventKind::Modify(_) => Some("change"),
        // 分不出类别的变更宁可多报，由消费方的内容比对收敛（绝不静默丢事件）
        EventKind::Any | EventKind::Other => Some("change"),
        // 纯读取：索引构建本来就在成千次读盘，转发会变成事件风暴
        EventKind::Access(_) => None,
    }
}

/// 托管状态：当前唯一的监视会话。
/// 内核是 `watchDirs` 的唯一调用方 ⇒ 不做多会话引用计数；重复 start = 换一批根目录
/// （旧 watcher 在这里被赋值 Drop，notify 的 Drop 会注销底层句柄）。
#[derive(Default)]
struct WatchState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// notify 回调 → WebView 事件。零判断，逐条透传。
struct WebviewForwarder {
    app: tauri::AppHandle,
}

impl notify::EventHandler for WebviewForwarder {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        use tauri::Emitter;
        match event {
            Ok(ev) => {
                let Some(kind) = normalize_event_kind(&ev.kind) else {
                    return;
                };
                for path in ev.paths {
                    if is_atomic_write_temp(&path) {
                        continue;
                    }
                    let Some(path) = path.to_str() else {
                        continue; // 非 UTF-8 路径：IPC 走 JSON，无法承载；不静默——见前端 roots 计数
                    };
                    let _ = self.app.emit(
                        FS_CHANGED_EVENT,
                        FsChangedPayload {
                            kind,
                            path: path.to_string(),
                        },
                    );
                }
            }
            Err(err) => {
                let _ = self.app.emit(
                    FS_WATCH_ERROR_EVENT,
                    WatchErrorPayload {
                        error: err.to_string(),
                    },
                );
            }
        }
    }
}

/// 起（或换）监视会话：递归监视 `paths`，原始事件转发到 WebView。
#[tauri::command]
fn start_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    paths: Vec<String>,
) -> Result<WatchReport, String> {
    use notify::Watcher;
    let mut watcher = notify::RecommendedWatcher::new(
        WebviewForwarder { app },
        notify::Config::default(),
    )
    .map_err(|e| format!("创建文件监视器失败: {e}"))?;

    let mut watched = Vec::new();
    let mut failed = Vec::new();
    for p in paths {
        match watcher.watch(Path::new(&p), notify::RecursiveMode::Recursive) {
            Ok(()) => watched.push(p),
            Err(e) => failed.push(FailedRoot {
                path: p,
                error: e.to_string(),
            }),
        }
    }

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "watch state poisoned".to_string())?;
    *guard = Some(watcher);
    Ok(WatchReport { watched, failed })
}

/// 停监视（project.closed / 桥卸载）。丢弃 watcher 即注销句柄。
#[tauri::command]
fn stop_watch(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "watch state poisoned".to_string())?;
    *guard = None;
    Ok(())
}

/* ------------------------- 外部文件拖放（drag-drop 批） ------------------------- */
//
// Tauri v2 的 `dragDropEnabled` 默认为 true：OS 文件拖放被 webview 层拦截，
// HTML5 `drop` 事件拿不到本地路径 ⇒ 唯一可靠通道是在这里接窗口事件并转发。
// 本链路**只负责把路径说给前端听**；前端只拿去打开（读），不参与任何写授权
// ⇒ 零新增命令、零写允许域改动。

/// WebView 事件名：OS 文件拖放。payload = `{ phase, paths }`。
const DRAG_DROP_EVENT: &str = "kojo:drag-drop";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragDropPayload {
    /// 'enter' | 'over' | 'leave' | 'drop'——前端覆盖提示状态机直接消费
    phase: &'static str,
    /// 仅 drop 携带路径；其余 phase 恒为空数组（理由见 `map_drag_drop`）
    paths: Vec<String>,
}

/// Tauri 拖放事件 → 转发载荷（纯函数，可单测）。
/// `drop` 之外的 phase 刻意丢掉路径：enter/over 每秒刷屏几十次，
/// 前端只用它们亮/灭覆盖提示，转发路径只会白撑 IPC 载荷。
fn map_drag_drop(event: tauri::DragDropEvent) -> Option<DragDropPayload> {
    use tauri::DragDropEvent as D;
    let (phase, paths) = match event {
        D::Enter { .. } => ("enter", Vec::new()),
        D::Over { .. } => ("over", Vec::new()),
        D::Drop { paths, .. } => (
            "drop",
            paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect(),
        ),
        D::Leave => ("leave", Vec::new()),
        // #[non_exhaustive]：上游将来新增 phase 时不冒充已知状态——宁可不提示也不给错的
        _ => return None,
    };
    Some(DragDropPayload { phase, paths })
}

/* -------------------- 全文检索（通用 IO 原语，零游戏知识） -------------------- */
//
// ADR-0003：本层只做 IO 原语——"读盘 + 匹配 + 切行"是纯机械活，不认识任何领域概念
// （哪个目录是口上、哪个文件是剧本，全由调用方给 `roots`，本层只当路径用）。
//
// 为什么下沉到 Rust 而不是前端 Worker 池：语料 3.8k 文件 / 4.1M 行，索引阶段单是
// 读盘就累计 45.1s（并发 8 摊到 ~9.0s 墙钟）；检索每次查询都要**全量重读**，把这份
// 字节搬过 IPC 再在 JS 里匹配，等于把最贵的一段压在最热的路径上（还顺手把 4M 行的
// 副本留在 WebView 内存里）。原生线程 + regex 在同一份字节上匹配，只有命中行过 IPC。
//
// 编码口径：**先解码再匹配**（不是"ASCII 按字节匹配 + 命中行再解码"）。
// 理由：混编码语料里 utf-16 文件按字节永远匹配不到，字节路径必须特判；而"正则 /
// 全词 / 大小写"三个开关在两条路径上会各有一套语义（正则根本无法按字节解释非 ASCII）。
// 统一解码只有一套语义，代价是每文件多一趟解码——`byte_prefilter` 把大多数文件挡在
// 解码之前（字面量 + 纯 ASCII + 大小写敏感时，命中必然在原始字节里出现）。

/// 命中条数硬顶（前端上限之上再兜一层：IPC 载荷不许失控）
const SEARCH_HARD_CAP: usize = 5000;
/// 单文件命中上限（一个巨型文件不许吃掉全部结果）
const SEARCH_PER_FILE_CAP: usize = 500;
/// 命中行预览长度上限（UTF-16 code unit）
const SEARCH_PREVIEW_UNITS: usize = 240;
/// 大文件跳过阈值（字节）；跳过一律计数上报，不静默
const SEARCH_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// 二进制嗅探窗口（字节）
const SEARCH_SNIFF_BYTES: usize = 8192;
/// 进度节流：文件数或时间先到者报
const SEARCH_PROGRESS_FILES: usize = 200;
const SEARCH_PROGRESS_MS: u128 = 150;
/// 缺省并行度（与实际读盘段同量级：索引阶段就是 8 路并发）
const SEARCH_DEFAULT_THREADS: usize = 8;

/// WebView 事件名：检索进度。payload = `SearchProgressPayload`。
const SEARCH_PROGRESS_EVENT: &str = "kojo:search-progress";

/// 取消集合：`cancel_search` 写入、检索线程逐文件读取。
/// 用 id 而不是布尔——同一时刻可能有多条检索（前端 id 自增），
/// 取消必须精确命中一条，不许把别人的检索一起掐掉。
#[derive(Default)]
struct SearchState {
    cancelled: std::sync::Arc<Mutex<HashSet<u64>>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SearchOptionsDto {
    is_regex: Option<bool>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    /// 限定扩展名（大小写与点号由本层再归一化一道：调用方给脏数据也不放行）
    extensions: Option<Vec<String>>,
    max_results: Option<usize>,
    /// 并行度（缺省 8；上限 32 防"给我 512 线程"这类输入）
    threads: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SearchRequestDto {
    /// 调用方自增 id：进度事件按它过滤，取消按它认领
    search_id: u64,
    /// 检索根（一个或多个；重叠/嵌套由本层去重）
    roots: Vec<String>,
    query: String,
    options: SearchOptionsDto,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatchDto {
    /// 1 基行号
    line: u32,
    /// 1 基列号（UTF-16 code unit，与 JS / Monaco 同口径）
    column: u32,
    /// 命中行文本（超长时以命中为中心开窗，两端的省略号算在窗口里）
    preview: String,
    /// 命中区间在 `preview` 内的起止（UTF-16 code unit，半开）
    start: u32,
    end: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchFileDto {
    path: String,
    matches: Vec<SearchMatchDto>,
}

#[derive(Serialize, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
struct SearchSkippedDto {
    /// 含 NUL 且非 utf-16（二进制：不参与检索，但要说得清跳过了多少）
    binary: u32,
    too_large: u32,
    /// 读不到的文件（metadata / 读字节失败 + 遍历条目失败）——两者都是"这个文件没被检索"
    unreadable: u32,
    /// 扩展名过滤挡下的文件数
    filtered: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultDto {
    /// 按路径升序（并行合并后排序 ⇒ 线程数不影响输出顺序）
    files: Vec<SearchFileDto>,
    total_matches: u64,
    /// 结果不完整（命中上限 / 单文件上限 / 取消）——前端必须显式说明，不许看起来"搜完了"
    truncated: bool,
    cancelled: bool,
    files_scanned: u32,
    skipped: SearchSkippedDto,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchProgressPayload {
    search_id: u64,
    files_scanned: u32,
    total_files: u32,
    match_count: u64,
}

/// UTF-16 code unit 长度（JS 字符串下标的口径）
fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

fn utf16_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// 省略号（U+2026）——作为 UTF-16 单元直接塞进窗口
const ELLIPSIS_UNIT: u16 = 0x2026;

/// 命中行 → 预览窗口。超长行以命中为中心开窗；两端截断时加省略号（计入窗口）。
/// 返回 (窗口单元, 命中起点, 命中终点)，偏移**相对返回的窗口**。
fn preview_window(units: &[u16], start: usize, end: usize, cap: usize) -> (Vec<u16>, u32, u32) {
    let total = units.len();
    if total <= cap {
        return (units.to_vec(), start as u32, end as u32);
    }
    // 命中比窗口还长时，窗口至少装得下整段命中（宁可超一截预览，不可把命中切没）
    let hit_len = end.saturating_sub(start);
    let window = cap.max(hit_len);
    let half = window.saturating_sub(hit_len) / 2;
    let from = start.saturating_sub(half).min(total.saturating_sub(window));
    let to = (from + window).min(total);
    let head_trim = from > 0;
    let tail_trim = to < total;
    let mut out: Vec<u16> = Vec::with_capacity(window + 2);
    if head_trim {
        out.push(ELLIPSIS_UNIT);
    }
    out.extend_from_slice(&units[from..to]);
    if tail_trim {
        out.push(ELLIPSIS_UNIT);
    }
    let lead = if head_trim { 1 } else { 0 };
    (
        out,
        (lead + start - from) as u32,
        (lead + end - from) as u32,
    )
}

/// 模式 + 三个开关 → 匹配器。口径 = **逐行匹配**（grep 语义：`^`/`$` 落在行首行尾，
/// 跨行模式不参与；这与"点开能看到行号"的宿主呈现是一致的）。
/// 全词 = `\b` 包夹，与主流编辑器同口径：首尾是非词字符的模式在全词模式下匹配不到，
/// 那是 `\b` 的语义本身，不另发明一套"相邻字符判定"。
fn build_matcher(
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Regex, String> {
    let body = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let body = if whole_word {
        format!(r"\b(?:{body})\b")
    } else {
        body
    };
    let pattern = if case_sensitive {
        body
    } else {
        format!("(?i){body}")
    };
    Regex::new(&pattern).map_err(|e| format!("正则无效：{e}"))
}

/// 字节级预筛：只在"字面量 + 纯 ASCII + 大小写敏感"时成立——
/// 此时命中必然在原始字节里原样出现（utf-8 / shift_jis 对 ASCII 段逐字节相同），
/// 字节里没有就不必解码（utf-16 由调用方先排除）。
/// 大小写不敏感不做预筛：Unicode 简单大小写折叠（如 U+212A KELVIN ↔ 'k'）会让
/// "字节里有"与"文本里能匹配"不再等价——省下的解码不值一次漏报。
fn byte_prefilter(query: &str, is_regex: bool, case_sensitive: bool) -> Option<regex::bytes::Regex> {
    if is_regex || !case_sensitive || query.is_empty() || !query.is_ascii() {
        return None;
    }
    regex::bytes::Regex::new(&regex::escape(query)).ok()
}

/// utf-16 BOM → 对应编码（FF FE = LE / FE FF = BE）
fn utf16_bom_encoding(bytes: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        Some(encoding_rs::UTF_16LE)
    } else if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        Some(encoding_rs::UTF_16BE)
    } else {
        None
    }
}

/// 二进制判定：utf-16 的 NUL 是编码产物（不是二进制信号），故带 BOM 的那支不算。
fn looks_binary(bytes: &[u8], utf16ish: bool) -> bool {
    !utf16ish && bytes[..bytes.len().min(SEARCH_SNIFF_BYTES)].contains(&0)
}

/// 字节 → 检索用文本。探测口径与内核 `probeEncoding` **逐条一致**
/// （BOM → UTF-8 严格校验 → shift_jis 兜底；utf-16 只认 BOM 那一支）：
/// 命中行的预览必须与编辑器打开同一文件看到的文本相同，两套探测会让"搜索结果"
/// 与"点进去看到的正文"对不上——那比漏几个文件更坏。
/// 代价：无 BOM 的 utf-16 会按 shift_jis 解成乱码，且因含 NUL 被计入 `skipped.binary`
/// （可见、可数，不是静默漏报）。
/// 解码失败不阻断（与 `decode_bytes` 同口径：替换字符只出声，只读检索不该硬失败）。
fn decode_for_search(bytes: &[u8]) -> Cow<'_, str> {
    if let Some(enc) = utf16_bom_encoding(bytes) {
        let (text, _, had_errors) = enc.decode(bytes);
        if had_errors {
            eprintln!("[search] utf-16 解码出现替换字符（输入非法或不完整）");
        }
        return Cow::Owned(text.into_owned());
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => {
            let (text, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
            Cow::Owned(text.into_owned())
        }
    }
}

/// 一份文本 → 命中（受 `cap` 限制）。返回 (命中, 是否因上限截断)。
///
/// 截断判定 = **真的又出现了一个装不下的命中**（不是"恰好装满就算截断"）：
/// 恰好装满时结果其实是完整的，报截断会让作者去调上限，白折腾。
fn scan_text(text: &str, matcher: &Regex, cap: usize) -> (Vec<SearchMatchDto>, bool) {
    let cap = cap.max(1);
    let mut out: Vec<SearchMatchDto> = Vec::new();
    for (idx, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let mut units: Option<Vec<u16>> = None;
        for m in matcher.find_iter(line) {
            if out.len() >= cap {
                return (out, true);
            }
            let u = units.get_or_insert_with(|| utf16_units(line));
            let start = utf16_len(&line[..m.start()]);
            let end = utf16_len(&line[..m.end()]);
            let (win, ws, we) = preview_window(u.as_slice(), start, end, SEARCH_PREVIEW_UNITS);
            out.push(SearchMatchDto {
                line: idx as u32 + 1,
                column: start as u32 + 1,
                preview: String::from_utf16_lossy(&win),
                start: ws,
                end: we,
            });
        }
    }
    (out, false)
}

enum FileOutcome {
    Hits(Vec<SearchMatchDto>, bool),
    Miss,
    Binary,
    TooLarge,
    Unreadable,
}

fn scan_file(
    path: &Path,
    matcher: &Regex,
    prefilter: Option<&regex::bytes::Regex>,
    cap: usize,
) -> FileOutcome {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return FileOutcome::Unreadable,
    };
    if meta.len() > SEARCH_MAX_FILE_BYTES {
        return FileOutcome::TooLarge;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return FileOutcome::Unreadable,
    };
    // 二进制判定放在预筛**之前**：`skipped.binary` 得是"这批候选里的二进制文件数"，
    // 与查询词无关；反过来（先预筛）会让这个数字随查询漂——同一个目录换个词，
    // 界面上的"跳过 N 个二进制文件"就变，那种读数没法信。
    let utf16ish = utf16_bom_encoding(&bytes).is_some();
    if looks_binary(&bytes, utf16ish) {
        return FileOutcome::Binary;
    }
    // 字节级预筛：不命中的文件整个跳过解码（utf-16 的字节被 0 隔开，预筛对它不成立）
    if !utf16ish {
        if let Some(pre) = prefilter {
            if !pre.is_match(&bytes) {
                return FileOutcome::Miss;
            }
        }
    }
    let text = decode_for_search(&bytes);
    let (hits, clipped) = scan_text(&text, matcher, cap);
    if hits.is_empty() {
        FileOutcome::Miss
    } else {
        FileOutcome::Hits(hits, clipped)
    }
}

/// 隐藏项（`.git` / 编辑器临时文件）整棵跳过：与 ripgrep 缺省一致，也顺手绕开
/// 版本库元数据这种"搜了全是噪声"的目录。
fn is_hidden_entry(e: &walkdir::DirEntry) -> bool {
    e.file_name()
        .to_str()
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

/// 收集候选文件（去重 + 路径升序 ⇒ 并行合并后输出顺序与线程数无关）。
///
/// 遍历失败**计数 + 出声**（前若干条打 stderr，其余只计数）：walkdir 逐个条目返回 Result，
/// 一个读不到 metadata 的条目（超长路径 / 权限 / 句柄）若被 filter 掉就再无声息——
/// 那正是"搜不到某个文件却没有任何说法"的形状。计数汇入 `skipped.unreadable`。
fn collect_files(
    roots: &[String],
    extensions: &[String],
    filtered: &mut u32,
    walk_errors: &mut u32,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut reported = 0usize;
    for root in roots {
        let walker = walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !is_hidden_entry(e));
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(err) => {
                    *walk_errors += 1;
                    if reported < 5 {
                        reported += 1;
                        eprintln!("[search] 遍历条目失败（已计入 skipped.unreadable）：{err}");
                    }
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if !extensions.is_empty() {
                let ext = p
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                if !extensions.iter().any(|x| *x == ext) {
                    *filtered += 1;
                    continue;
                }
            }
            out.push(p.to_path_buf());
        }
    }
    out.sort_by(|a, b| {
        a.to_string_lossy()
            .to_lowercase()
            .cmp(&b.to_string_lossy().to_lowercase())
    });
    out.dedup_by(|a, b| a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase());
    out
}

#[derive(Default)]
struct SkipCounters {
    binary: AtomicU32,
    too_large: AtomicU32,
    unreadable: AtomicU32,
}

impl SkipCounters {
    fn to_dto(&self, filtered: u32, walk_errors: u32) -> SearchSkippedDto {
        SearchSkippedDto {
            binary: self.binary.load(Ordering::Relaxed),
            too_large: self.too_large.load(Ordering::Relaxed),
            unreadable: self.unreadable.load(Ordering::Relaxed) + walk_errors,
            filtered,
        }
    }
}

fn is_cancelled(cancel: &Mutex<HashSet<u64>>, id: u64) -> bool {
    cancel.lock().map(|g| g.contains(&id)).unwrap_or(false)
}

/// 检索主体。`emit` 注入而非直接用 `AppHandle`：单测要能在没有 Tauri 运行时的情况下
/// 跑真语料（进度回调对判据无影响，凭这一层把"并行检索"整段变成可测代码）。
fn run_search(
    emit: &(dyn Fn(SearchProgressPayload) + Sync),
    cancel: &Mutex<HashSet<u64>>,
    req: &SearchRequestDto,
) -> Result<SearchResultDto, String> {
    let started = std::time::Instant::now();
    if req.query.is_empty() {
        return Err("检索词为空".to_string());
    }
    let o = &req.options;
    let is_regex = o.is_regex.unwrap_or(false);
    let case_sensitive = o.case_sensitive.unwrap_or(false);
    let whole_word = o.whole_word.unwrap_or(false);
    let matcher = build_matcher(&req.query, is_regex, case_sensitive, whole_word)?;
    let prefilter = byte_prefilter(&req.query, is_regex, case_sensitive);
    let max_results = o.max_results.unwrap_or(2000).clamp(1, SEARCH_HARD_CAP);
    let threads = o
        .threads
        .unwrap_or(SEARCH_DEFAULT_THREADS)
        .clamp(1, 32);
    let extensions: Vec<String> = o
        .extensions
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();

    let mut filtered: u32 = 0;
    let mut walk_errors: u32 = 0;
    let files = collect_files(&req.roots, &extensions, &mut filtered, &mut walk_errors);
    let total_files = files.len() as u32;

    let next = AtomicUsize::new(0);
    let scanned = AtomicUsize::new(0);
    let hits_total = AtomicU64::new(0);
    let overflow = AtomicBool::new(false);
    let cancelled = AtomicBool::new(false);
    let counters = SkipCounters::default();
    let last_emit = Mutex::new(std::time::Instant::now());

    let batches: Vec<Vec<SearchFileDto>> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..threads {
            handles.push(scope.spawn(|| {
                let mut local: Vec<SearchFileDto> = Vec::new();
                loop {
                    if is_cancelled(cancel, req.search_id) {
                        cancelled.store(true, Ordering::Relaxed);
                        break;
                    }
                    if overflow.load(Ordering::Relaxed) {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= files.len() {
                        break;
                    }
                    let remaining = max_results
                        .saturating_sub(hits_total.load(Ordering::Relaxed) as usize);
                    if remaining == 0 {
                        overflow.store(true, Ordering::Relaxed);
                        break;
                    }
                    let cap = SEARCH_PER_FILE_CAP.min(remaining);
                    match scan_file(&files[i], &matcher, prefilter.as_ref(), cap) {
                        FileOutcome::Hits(hits, clipped) => {
                            if clipped {
                                overflow.store(true, Ordering::Relaxed);
                            }
                            hits_total.fetch_add(hits.len() as u64, Ordering::Relaxed);
                            local.push(SearchFileDto {
                                path: files[i].to_string_lossy().into_owned(),
                                matches: hits,
                            });
                        }
                        FileOutcome::Binary => {
                            counters.binary.fetch_add(1, Ordering::Relaxed);
                        }
                        FileOutcome::TooLarge => {
                            counters.too_large.fetch_add(1, Ordering::Relaxed);
                        }
                        FileOutcome::Unreadable => {
                            counters.unreadable.fetch_add(1, Ordering::Relaxed);
                        }
                        FileOutcome::Miss => {}
                    }
                    let done = scanned.fetch_add(1, Ordering::SeqCst) + 1;
                    let due = done % SEARCH_PROGRESS_FILES == 0
                        || last_emit
                            .lock()
                            .map(|g| g.elapsed().as_millis() >= SEARCH_PROGRESS_MS)
                            .unwrap_or(false);
                    if due {
                        if let Ok(mut g) = last_emit.lock() {
                            *g = std::time::Instant::now();
                        }
                        emit(SearchProgressPayload {
                            search_id: req.search_id,
                            files_scanned: done as u32,
                            total_files,
                            match_count: hits_total.load(Ordering::Relaxed),
                        });
                    }
                }
                local
            }));
        }
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });

    let mut out_files: Vec<SearchFileDto> = batches.into_iter().flatten().collect();
    out_files.sort_by(|a, b| a.path.cmp(&b.path));
    let total_matches: u64 = out_files.iter().map(|f| f.matches.len() as u64).sum();
    if let Ok(mut g) = cancel.lock() {
        g.remove(&req.search_id); // 本次取消标记用完即清，不留给下一次
    }
    Ok(SearchResultDto {
        files: out_files,
        total_matches,
        truncated: overflow.load(Ordering::Relaxed),
        cancelled: cancelled.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::SeqCst) as u32,
        skipped: counters.to_dto(filtered, walk_errors),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 全文检索：多线程读盘 + 行内匹配，逐文件上报进度，命中行才过 IPC。
/// 结果上限（`maxResults` / 单文件上限）与取消都会在返回值里显式说明（不静默截断）。
#[tauri::command]
async fn search_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, SearchState>,
    request: SearchRequestDto,
) -> Result<SearchResultDto, String> {
    use tauri::Emitter;
    let cancel = state.cancelled.clone();
    // 命令本体跑在阻塞线程池上：这是纯 CPU + 磁盘的活，不许占住异步运行时的执行线程
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |p: SearchProgressPayload| {
            let _ = app.emit(SEARCH_PROGRESS_EVENT, p);
        };
        run_search(&emit, &cancel, &request)
    })
    .await
    .map_err(|e| format!("检索线程失败：{e}"))?
}

/// 请求取消某条检索（按 `searchId`）。检索线程逐文件检查，命中即提前收尾并如实回报。
#[tauri::command]
fn cancel_search(state: tauri::State<'_, SearchState>, search_id: u64) -> Result<(), String> {
    let mut guard = state
        .cancelled
        .lock()
        .map_err(|_| "search state poisoned".to_string())?;
    guard.insert(search_id);
    Ok(())
}

/* ------------------------------- 入口 ------------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WriteDomainState::default())
        .manage(WatchState::default())
        .manage(SearchState::default())
        .on_window_event(|window, event| {
            use tauri::Emitter;
            if let tauri::WindowEvent::DragDrop(ev) = event {
                if let Some(payload) = map_drag_drop(ev.clone()) {
                    let _ = window.emit(DRAG_DROP_EVENT, payload);
                }
            }
        })
        .setup(|app| {
            use tauri::Manager;
            // 常驻授权根读回（自选项目位置的持久化半边）。
            // 文件不存在 = 首次运行，正常态；读失败已在 `read_workspace_roots` 里出声。
            let handle = app.handle().clone();
            let Ok(app_dir) = handle.path().app_data_dir() else {
                eprintln!("[setup] 无 app_data_dir，常驻授权根保持为空");
                return Ok(());
            };
            let persisted = read_workspace_roots(&app_dir);
            if persisted.is_empty() {
                return Ok(());
            }
            let state = handle.state::<WriteDomainState>();
            let mut guard = state
                .extra_roots
                .lock()
                .map_err(|_| "write domain state poisoned".to_string())?;
            for root in persisted {
                push_extra_root(&mut guard, &root);
            }
            eprintln!("[setup] 常驻授权根读回 {} 个", guard.len());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            read_file_bytes_raw,
            write_file_bytes,
            ensure_dir,
            list_dir,
            walk_dir,
            path_exists,
            stat_file,
            read_files_raw,
            stat_files,
            rename_path,
            copy_file,
            remove_file,
            remove_dir,
            choose_directory,
            choose_workspace_root,
            workspace_roots,
            export_file,
            app_data_dir,
            register_write_domain,
            clear_write_domain,
            decode_bytes,
            encode_string,
            start_watch,
            stop_watch,
            search_text,
            cancel_search,
            market::market_download,
            market::market_extract
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ------------------------------- 单测（M3） ------------------------------- */

/// 全文检索的判据独立成文件（`src/search_tests.rs`）：一整套编码 / 切行 / 并行的用例
/// 塞进本文件会把 IO 原语的正文淹掉。
#[cfg(test)]
mod search_tests;

/// 市场 IO 原语的判据（白名单逐跳 / 暂存名字面 / 解压闸 / 真实容器对平）同理由独立成文件。
#[cfg(test)]
mod market_tests;

#[cfg(test)]
mod write_domain_tests {
    use super::{
        canonicalize_deep, ensure_in_write_domain, is_same_path, is_within, push_extra_root,
        read_workspace_roots, write_workspace_roots,
    };
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kojo-m3-{}-{}-{tag}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mkdir(p: &Path) -> PathBuf {
        std::fs::create_dir_all(p).unwrap();
        p.to_path_buf()
    }

    #[test]
    fn inside_project_root_allowed() {
        let root = temp_root("in");
        let sub = mkdir(&root.join("scenario").join("ERB"));
        // 深层不存在文件（原子写待建目标）也应在域内
        ensure_in_write_domain(
            Some(&root),
            &temp_root("appdata"),
            &[],
            &sub.join("new.erb"),
            "write",
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_data_dir_always_allowed() {
        let appdata = temp_root("app");
        let project = temp_root("proj");
        ensure_in_write_domain(
            Some(&project),
            &appdata,
            &[],
            &appdata.join("backup").join("v1.dat"),
            "write",
        )
        .unwrap();
    }

    #[test]
    fn outside_domain_rejected() {
        let project = temp_root("proj");
        let other = temp_root("other");
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &other.join("evil.erb"),
            "write",
        )
        .unwrap_err();
        assert!(err.contains("写允许域拒绝"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn no_project_root_registered_rejects_everything_but_appdata() {
        let other = temp_root("other");
        let appdata = temp_root("appdata");
        // 未注册项目（None）：域外路径一律拒绝
        let err =
            ensure_in_write_domain(None, &appdata, &[], &other.join("x.erb"), "write").unwrap_err();
        assert!(err.contains("写允许域拒绝"), "unexpected: {err}");
        // appDataDir 仍可写（备份 / 配置）
        ensure_in_write_domain(None, &appdata, &[], &appdata.join("config.json"), "write").unwrap();
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&appdata);
    }

    #[test]
    fn traversal_via_dotdot_rejected() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        let outside = mkdir(&base.join("outside"));
        // 字符串以项目根开头，但 .. 穿越到域外
        let sneaky = project.join("sub").join("..").join("..").join("outside").join("x.erb");
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &sneaky,
            "write",
        )
        .unwrap_err();
        assert!(err.contains("写允许域拒绝"), "unexpected: {err}");
        let _ = outside; // 保持存在
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn traversal_resolved_when_target_exists_rejected() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        let outside = mkdir(&base.join("outside"));
        std::fs::write(outside.join("secret.erb"), "x").unwrap();
        let sneaky = project.join("..").join("outside").join("secret.erb");
        assert!(ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &sneaky,
            "remove"
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn symlink_escaping_domain_rejected() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        let outside = mkdir(&base.join("outside"));
        let link = project.join("link");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &link.join("evil.erb"),
            "write",
        )
        .unwrap_err();
        assert!(err.contains("写允许域拒绝"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prefix_is_component_wise_not_string_prefix() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        // sibling 目录名是项目根的字符串前缀（projec vs project）
        let sibling = mkdir(&base.join("projec"));
        assert!(ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &sibling.join("f.txt"),
            "write"
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn canonicalize_deep_keeps_missing_tail() {
        let base = temp_root("base");
        let root = mkdir(&base.join("root"));
        let target = root.join("a").join("b").join("new.txt");
        let canon = canonicalize_deep(&target).unwrap();
        assert!(is_within(&canon, &root.canonicalize().unwrap()));
        assert!(canon.ends_with("new.txt"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /* -------- 常驻授权根（自选项目位置，2026-10-14 批） -------- */

    /// 正向：未打开任何项目，但落点在用户经对话框自选并授权的根之下 ⇒ 放行
    #[test]
    fn extra_root_authorized_when_no_project_registered() {
        let appdata = temp_root("appdata");
        let chosen = mkdir(&temp_root("chosen"));
        let target = chosen.join("我的作品").join("包").join("事件.ERB");
        ensure_in_write_domain(None, &appdata, &[chosen], &target, "write").unwrap();
    }

    /// 负向：授权根之外的兄弟目录仍被拒——**判定域只宽不松**，
    /// 一次授权绝不变成"整个磁盘可写"
    #[test]
    fn outside_extra_root_still_rejected() {
        let appdata = temp_root("appdata");
        let base = temp_root("base");
        let chosen = mkdir(&base.join("chosen"));
        let sibling = mkdir(&base.join("sibling"));
        let err = ensure_in_write_domain(
            None,
            &appdata,
            &[chosen],
            &sibling.join("evil.erb"),
            "write",
        )
        .unwrap_err();
        assert!(err.contains("写允许域拒绝"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 授权根去重：同一个目录的两种写法（大小写 / 规范化前后）只登记一次
    #[test]
    fn push_extra_root_dedups_same_directory() {
        let chosen = mkdir(&temp_root("chosen"));
        let mut list: Vec<PathBuf> = Vec::new();
        assert!(push_extra_root(&mut list, &chosen));
        assert!(!push_extra_root(&mut list, &chosen.join(".")));
        assert_eq!(list.len(), 1);
        assert!(is_same_path(&chosen, &chosen.join(".")));
        let other = mkdir(&temp_root("other"));
        assert!(push_extra_root(&mut list, &other));
        assert_eq!(list.len(), 2);
    }

    /// 授权根持久化：写下去读得回（一行一路径），文件不存在 = 空列表不报错
    #[test]
    fn workspace_roots_file_roundtrip() {
        let appdata = temp_root("appdata");
        assert!(read_workspace_roots(&appdata).is_empty());
        let a = mkdir(&temp_root("a"));
        let b = mkdir(&temp_root("b"));
        write_workspace_roots(&appdata, &[a.clone(), b.clone()]).unwrap();
        let back = read_workspace_roots(&appdata);
        assert_eq!(back.len(), 2);
        assert!(is_same_path(&back[0], &a));
        assert!(is_same_path(&back[1], &b));
        // 整表重写 ⇒ 重复项不会越写越多
        write_workspace_roots(&appdata, &[a.clone()]).unwrap();
        assert_eq!(read_workspace_roots(&appdata).len(), 1);
    }
}

#[cfg(test)]
mod watch_tests {
    use super::{is_atomic_write_temp, normalize_event_kind};
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
    use std::path::Path;

    #[test]
    fn create_is_add_and_remove_is_unlink() {
        assert_eq!(normalize_event_kind(&EventKind::Create(CreateKind::Any)), Some("add"));
        assert_eq!(
            normalize_event_kind(&EventKind::Create(CreateKind::Folder)),
            Some("add")
        );
        assert_eq!(normalize_event_kind(&EventKind::Remove(RemoveKind::Any)), Some("unlink"));
        assert_eq!(
            normalize_event_kind(&EventKind::Remove(RemoveKind::File)),
            Some("unlink")
        );
    }

    #[test]
    fn rename_from_is_unlink_and_rename_to_is_change() {
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::From))),
            Some("unlink")
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::To))),
            Some("change")
        );
        // Both：一个事件两条路径、谁是谁分不清 ⇒ 一律 change，让消费方按内容比对收敛
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some("change")
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::Any))),
            Some("change")
        );
    }

    #[test]
    fn unclassifiable_kinds_are_reported_not_dropped() {
        // 绝不静默：分不出类别的变更也要报出去
        assert_eq!(normalize_event_kind(&EventKind::Any), Some("change"));
        assert_eq!(normalize_event_kind(&EventKind::Other), Some("change"));
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Any)),
            Some("change")
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Metadata(
                notify::event::MetadataKind::Any
            ))),
            Some("change")
        );
    }

    #[test]
    fn pure_reads_are_dropped() {
        // 索引构建本身就在成千次读盘：Access 事件转发出去就是事件风暴
        assert_eq!(
            normalize_event_kind(&EventKind::Access(AccessKind::Read)),
            None
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Access(AccessKind::Any)),
            None
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Access(AccessKind::Open(AccessMode::Execute))),
            None
        );
    }

    #[test]
    fn atomic_write_temp_is_filtered_and_real_files_are_not() {
        // write_file_bytes 的产物：.{name}.{pid}.kojo-tmp
        assert!(is_atomic_write_temp(Path::new(
            r"C:\data\dir\.payload.txt.4242.kojo-tmp"
        )));
        // 真实文件与相邻命名都不该被误滤
        assert!(!is_atomic_write_temp(Path::new(
            r"C:\data\dir\payload.txt"
        )));
        assert!(!is_atomic_write_temp(Path::new(
            r"C:\data\dir\.payload.txt.4242.other-tmp"
        )));
        assert!(!is_atomic_write_temp(Path::new(r"C:\data\dir\notes.kojo-tmp")));
        assert!(!is_atomic_write_temp(Path::new(r"C:\data\dir\.hidden")));
        // 目录名恰好带点也不能升级成"临时文件"
        assert!(!is_atomic_write_temp(Path::new(r"C:\data\a.kojo-tmp\b.txt")));
    }
}

#[cfg(test)]
mod watch_runtime_tests {
    //! 真实监视器投递验证（BUG-5 判据②的 Rust 半边）。
    //!
    //! `WebviewForwarder` 要 `AppHandle`，单测造不出 Tauri 运行时 ⇒
    //! WebView 那一段仍留人工清单。但"**递归监视在这台机器上到底收不收得到事件**"
    //! 不需要 WebView 也能证：这里用 channel 当接收端，事件照样过
    //! `normalize_event_kind` 纯映射——那才是本层唯一有判断的地方。
    use super::normalize_event_kind;
    use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
    use notify::{Watcher, RecursiveMode};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kojo-watch-{}-{tag}-{n}",
            std::process::id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 收到 `path` 上的一条可映射事件即算成功；超时 5s（轮询监视在慢机上会晚到）
    fn wait_for(rx: &std::sync::mpsc::Receiver<notify::Result<notify::Event>>) -> Vec<(String, &'static str)> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(ev)) => {
                    let Some(kind) = normalize_event_kind(&ev.kind) else {
                        continue;
                    };
                    for p in ev.paths {
                        seen.push((p.to_string_lossy().into_owned(), kind));
                    }
                }
                Ok(Err(_)) => continue, // 监视器自身报错：继续收，另有测试管降级
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        seen
    }

    #[test]
    fn recursive_watch_delivers_nested_create_and_modify() {
        let root = temp_root("nested");
        let deep = root.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();

        let (tx, rx) = channel();
        let mut watcher =
            notify::RecommendedWatcher::new(move |res| {
                let _ = tx.send(res);
            }, notify::Config::default())
            .expect("RecommendedWatcher 应能创建");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("递归监视应能登记");

        let target = deep.join("payload.txt");
        std::fs::write(&target, "first").unwrap();
        std::fs::write(&target, "second").unwrap();

        let seen = wait_for(&rx);
        let hit = seen.iter().any(|(p, _)| p.ends_with("payload.txt"));
        assert!(
            hit,
            "深层目录里的写入没有收到任何事件；实际收到 = {:?}",
            seen
        );
        // 分类必须落在契约三态内（新建 → add，改写 → change；两者都算投递成功）
        let kinds: Vec<&str> = seen.iter().map(|(_, k)| *k).collect();
        assert!(
            kinds.iter().all(|k| matches!(*k, "add" | "change" | "unlink")),
            "映射产物越界：{:?}",
            kinds
        );

        drop(watcher); // Drop 即注销底层句柄
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mapping_covers_the_kinds_this_backend_actually_emits() {
        // 与 windows.rs 的投递形态对齐：Create(Any) / Remove(Any) / Modify(Any) /
        // Modify(Name(From|To))。后端换了类别也不该导致事件被吞掉。
        assert_eq!(normalize_event_kind(&EventKind::Create(CreateKind::Any)), Some("add"));
        assert_eq!(normalize_event_kind(&EventKind::Remove(RemoveKind::Any)), Some("unlink"));
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Any)),
            Some("change")
        );
    }
}

#[cfg(test)]
mod io_primitives_tests {
    use crate::{stat_file, walk_dir, WalkOptionsDto};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-io-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `walk_dir(withMetadata)` 带回的 mtime/size 必须与 `stat_file` **逐位同值**——
    /// 索引的体量指纹、逐文件复用判据、以及已经躺在盘上的快照全都以此为前提。
    /// 值一漂，等价于把老项目的缓存整批无谓作废（所以这条测在 Rust，而不是只测假 io）。
    #[test]
    fn walk_with_metadata_matches_stat_file_exactly() {
        let dir = temp_dir("walkmeta");
        std::fs::write(dir.join("a.ERB"), "hello").unwrap();
        std::fs::write(dir.join("b.ERB"), "longer content here").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();

        let opts = WalkOptionsDto {
            max_depth: None,
            include_files: Some(true),
            include_dirs: Some(true),
            with_metadata: Some(true),
        };
        let entries = walk_dir(dir.to_string_lossy().to_string(), Some(opts)).unwrap();
        assert!(entries.iter().any(|e| e.is_directory), "目录条目应仍在");

        let mut files = 0;
        for e in &entries {
            if e.is_directory {
                assert!(e.mtime_ms.is_none(), "目录条目不带元数据 ⇒ 调用方退化回 stat");
                continue;
            }
            let st = stat_file(e.path.clone()).expect("stat_file 应成功");
            assert_eq!(e.mtime_ms, Some(st.mtime_ms), "mtime 必须逐位同值：{}", e.path);
            assert_eq!(e.size, Some(st.size), "size 必须逐位同值：{}", e.path);
            files += 1;
        }
        assert_eq!(files, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不带 `withMetadata` 时输出形态必须与改造前**逐字一致**：两个键整个不出现，
    /// 而不是出现成 `null`——前端靠 `typeof === 'number'` 判可用，`null` 会被读成"取到了值"。
    #[test]
    fn walk_without_metadata_omits_the_keys_entirely() {
        let dir = temp_dir("nometa");
        std::fs::write(dir.join("a.ERB"), "x").unwrap();
        let entries = walk_dir(dir.to_string_lossy().to_string(), None).unwrap();
        let json = serde_json::to_string(&entries).unwrap();
        assert!(!json.contains("mtimeMs"), "不该出现该键：{json}");
        assert!(!json.contains("\"size\""), "不该出现该键：{json}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod batch_io_tests {
    //! 批量读帧格式与批量 stat 的判据。
    //!
    //! 帧是 Rust 与 JS 解帧器（`packages/app/src/bridge/read-files-frame.ts`）之间的
    //! **逐字节契约**：字段一漂，前端不是报错而是静默错位（读到的"内容"错位成别的字段），
    //! 所以这里自带一份解帧器做**往返对拍**——两份解码独立写、以帧格式为唯一真源。
    use super::{read_files_frame, stat_files, FRAME_STATUS_NOT_FOUND, FRAME_STATUS_OK, FRAME_STATUS_READ_ERROR};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-batch-io-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 测试用解帧器（与 JS 侧 DataView 解帧器同格式）：(path, status, mtimeMs, size, data)
    fn decode_frame(frame: &[u8]) -> Vec<(String, u32, i64, u64, Vec<u8>)> {
        let u32_at = |off: usize| u32::from_le_bytes(frame[off..off + 4].try_into().unwrap());
        let mut off = 0usize;
        let count = u32_at(off) as usize;
        off += 4;
        let mut out = Vec::new();
        for _ in 0..count {
            let plen = u32_at(off) as usize;
            off += 4;
            let path = String::from_utf8(frame[off..off + plen].to_vec()).unwrap();
            off += plen;
            let status = u32_at(off);
            off += 4;
            let mtime = i64::from_le_bytes(frame[off..off + 8].try_into().unwrap());
            off += 8;
            let size = u64::from_le_bytes(frame[off..off + 8].try_into().unwrap());
            off += 8;
            let dlen = u64::from_le_bytes(frame[off..off + 8].try_into().unwrap()) as usize;
            off += 8;
            let data = frame[off..off + dlen].to_vec();
            off += dlen;
            out.push((path, status, mtime, size, data));
        }
        assert_eq!(off, frame.len(), "帧尾不应有多余字节");
        out
    }

    /// 正常路径：多文件按**入参顺序**回位，字节原样、size/mtime 与 stat_file 同值
    #[test]
    fn reads_multiple_files_in_input_order() {
        let dir = temp_dir("multi");
        let a = dir.join("a.ERB");
        let b = dir.join("b.ERB");
        std::fs::write(&a, "@A\nPRINTL 甲\n").unwrap();
        std::fs::write(&b, "@B\n").unwrap();
        let paths = vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ];
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].0, paths[0]);
        assert_eq!(decoded[1].0, paths[1]);
        assert_eq!(decoded[0].1, FRAME_STATUS_OK);
        assert_eq!(decoded[1].1, FRAME_STATUS_OK);
        assert_eq!(decoded[0].4, "@A\nPRINTL 甲\n".as_bytes());
        assert_eq!(decoded[1].4, "@B\n".as_bytes());
        let st = super::stat_file(paths[0].clone()).unwrap();
        assert_eq!(decoded[0].2, st.mtime_ms as i64, "mtime 必须与 stat_file 逐位同值");
        assert_eq!(decoded[0].3, st.size);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 缺文件：status=1（不存在）、空数据，且**不影响同批其它文件**（批量不整批失败）
    #[test]
    fn missing_file_is_not_found_and_rest_of_batch_survives() {
        let dir = temp_dir("missing");
        let ok = dir.join("ok.ERB");
        std::fs::write(&ok, "x").unwrap();
        let missing = dir.join("nope.ERB");
        let paths = vec![
            missing.to_string_lossy().to_string(),
            ok.to_string_lossy().to_string(),
        ];
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded[0].1, FRAME_STATUS_NOT_FOUND);
        assert!(decoded[0].4.is_empty());
        assert_eq!(decoded[1].1, FRAME_STATUS_OK);
        assert_eq!(decoded[1].4, b"x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空数组：count=0 的合法帧（不是错误；调用方按"零结果"处理）
    #[test]
    fn empty_path_list_yields_zero_count_frame() {
        let frame = read_files_frame(&[]);
        assert_eq!(frame, vec![0, 0, 0, 0]);
        assert!(decode_frame(&frame).is_empty());
    }

    /// 非 ASCII（多字节 UTF-8）路径：pathLen 按**字节**量、往返逐字一致
    /// （Rust 入参是 String，路径字节必为 UTF-8；这条钉的是帧内长度口径不是字符数）
    #[test]
    fn multibyte_utf8_path_roundtrips_in_frame() {
        let dir = temp_dir("utf8path");
        let f = dir.join("事件·測試.ERB");
        std::fs::write(&f, "@福\n").unwrap();
        let paths = vec![f.to_string_lossy().to_string()];
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded[0].0, paths[0]);
        assert_eq!(decoded[0].1, FRAME_STATUS_OK);
        assert_eq!(decoded[0].4, "@福\n".as_bytes());
        // 不存在的多字节路径同样如实回 None 态（不是读取错误）
        let ghost = dir.join("不存在.ERB").to_string_lossy().to_string();
        let decoded2 = decode_frame(&read_files_frame(&[ghost.clone()]));
        assert_eq!(decoded2[0].0, ghost);
        assert_eq!(decoded2[0].1, FRAME_STATUS_NOT_FOUND);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空文件：status=0 + size=0 + dataLen=0（合法的零长内容，不是"读错"）
    #[test]
    fn empty_file_is_ok_with_zero_len() {
        let dir = temp_dir("empty");
        let f = dir.join("empty.ERB");
        std::fs::write(&f, "").unwrap();
        let path = f.to_string_lossy().to_string();
        let decoded = decode_frame(&read_files_frame(&[path]));
        assert_eq!(decoded[0].1, FRAME_STATUS_OK);
        assert_eq!(decoded[0].3, 0);
        assert!(decoded[0].4.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 读错（目录当文件读）：status=2——与"不存在"分开报，两类失败都可见
    #[test]
    fn directory_read_is_read_error_not_not_found() {
        let dir = temp_dir("dirread");
        let path = dir.to_string_lossy().to_string();
        let decoded = decode_frame(&read_files_frame(&[path]));
        assert_eq!(decoded[0].1, FRAME_STATUS_READ_ERROR);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// stat_files：存在项与 stat_file 同源同值；缺项 exists=false + null 数值
    #[test]
    fn stat_files_matches_stat_file_and_reports_missing() {
        let dir = temp_dir("statbatch");
        let f = dir.join("s.ERB");
        std::fs::write(&f, "hello").unwrap();
        let missing = dir.join("gone.ERB");
        let out = stat_files(vec![
            f.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ]);
        let st = super::stat_file(f.to_string_lossy().to_string()).unwrap();
        assert!(out[0].exists);
        assert_eq!(out[0].size, Some(st.size));
        assert_eq!(out[0].mtime_ms, Some(st.mtime_ms));
        assert!(!out[1].exists);
        assert_eq!(out[1].mtime_ms, None);
        assert_eq!(out[1].size, None);
        // JSON 形态：camelCase 键 + 缺项为 null（前端按 null 判"不可用"）
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"mtimeMs\":null"), "缺项应为 null：{json}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod drag_drop_tests {
    //! phase 映射与载荷形状：这是与前端 `subscribeDragDrop` 的契约——
    //! camelCase、仅 drop 带路径，漂一条覆盖提示或开文件就断。
    use super::map_drag_drop;
    use serde_json::json;
    use std::path::PathBuf;
    use tauri::{DragDropEvent, PhysicalPosition};

    fn pos() -> PhysicalPosition<f64> {
        PhysicalPosition::new(1.0, 2.0)
    }

    #[test]
    fn only_drop_carries_paths() {
        let p = PathBuf::from("C:\\temp\\事件.ERB");
        let dropped = map_drag_drop(DragDropEvent::Drop {
            paths: vec![p.clone()],
            position: pos(),
        })
        .unwrap();
        assert_eq!(dropped.phase, "drop");
        assert_eq!(dropped.paths, vec![p.to_string_lossy().to_string()]);

        for (ev, want) in [
            (
                DragDropEvent::Enter {
                    paths: vec![p.clone()],
                    position: pos(),
                },
                "enter",
            ),
            (DragDropEvent::Over { position: pos() }, "over"),
            (DragDropEvent::Leave, "leave"),
        ] {
            let got = map_drag_drop(ev).unwrap();
            assert_eq!(got.phase, want);
            assert!(got.paths.is_empty(), "{want} 相位不该带路径");
        }
    }

    #[test]
    fn payload_json_is_camel_case_with_both_keys() {
        let payload = map_drag_drop(DragDropEvent::Drop {
            paths: vec![PathBuf::from("a b.erm")],
            position: pos(),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({ "phase": "drop", "paths": ["a b.erm"] })
        );
    }
}
