//! kojo-editor Tauri 宿主。
//!
//! 本层的全部职责 = 为 WebView 内的内核提供 **PlatformBridge 原语**：
//! 文件字节读写（原子写）、目录遍历、编解码（encoding_rs）、目录对话框、应用数据目录、
//! 文件监视（notify 原始事件转发；去抖与判定在内核 TS）。
//! **零游戏知识、零业务逻辑**——一切领域逻辑都在前端的内核与插件中。
//!
//! 二进制数据经 base64 字符串跨 IPC（确定性强；口上文件体量下开销可忽略）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::Event;
use serde::{Deserialize, Serialize};

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

/// Tauri 托管状态：当前注册的项目根目录（None = 仅 appDataDir 可写）。
#[derive(Default)]
struct WriteDomainState {
    project_root: Mutex<Option<PathBuf>>,
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

/// 组件级前缀比较（Windows 大小写不敏感；`foo` 与 `foobar` 不会误判为包含）。
fn is_within(canonical_path: &Path, canonical_root: &Path) -> bool {
    let lower = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let p = lower(canonical_path);
    let r = lower(canonical_root);
    p.len() >= r.len() && p.iter().zip(r.iter()).all(|(a, b)| a == b)
}

/// 纯逻辑判定（可单测，不依赖 Tauri 类型）：
/// `project_root` = 当前注册的项目根（可为 None），`app_data_dir` 常驻允许。
fn ensure_in_write_domain(
    project_root: Option<&Path>,
    app_data_dir: &Path,
    path: &Path,
    op: &str,
) -> Result<(), String> {
    let canon_target = canonicalize_deep(path)
        .map_err(|e| format!("写允许域（{op}）：路径解析失败 {path_display}: {e}", path_display = path.display()))?;
    let mut roots: Vec<PathBuf> = vec![app_data_dir.to_path_buf()];
    if let Some(r) = project_root {
        roots.push(r.to_path_buf());
    }
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
        "写允许域拒绝（{op}）：{} 不在允许域内（允许 = 项目根目录 / appDataDir；未打开项目时仅 appDataDir）",
        path.display()
    ))
}

/// 命令侧包装：取 appDataDir + 当前注册的项目根，执行判定。
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
    ensure_in_write_domain(root.as_deref(), &app_dir, path, op)
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
        });
    }
    Ok(out)
}

#[tauri::command]
fn walk_dir(path: String, opts: Option<WalkOptionsDto>) -> Result<Vec<DirEntryDto>, String> {
    let o = opts.unwrap_or(WalkOptionsDto {
        max_depth: None,
        include_files: Some(true),
        include_dirs: Some(false),
    });
    let include_files = o.include_files.unwrap_or(true);
    let include_dirs = o.include_dirs.unwrap_or(false);
    let max_depth = o.max_depth.unwrap_or(usize::MAX);

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
        out.push(DirEntryDto {
            name: entry.file_name().to_string_lossy().to_string(),
            path: p.to_string_lossy().to_string(),
            is_directory: is_dir,
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
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(FileStatDto {
        size: md.len(),
        mtime_ms,
        is_directory: md.is_dir(),
    })
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

/// 递归复制目录内容：把 `src` 的**内容**复制进 `dst`（`dst` 不存在则创建）。
/// 返回复制的文件数。纯文件系统操作、不依赖 Tauri 类型 → 可单测。
///
/// 符号链接不解引用为链接、按 `std::fs::copy` 语义复制其**内容**
/// （导出的目的是得到一份可独立分发的副本，留下悬空链接没有意义）。
fn copy_dir_contents(src: &Path, dst: &Path) -> Result<u64, String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录 {}: {e}", dst.display()))?;
    let mut files = 0u64;
    for entry in walkdir::WalkDir::new(src).min_depth(1) {
        let entry = entry.map_err(|e| format!("遍历 {}: {e}", src.display()))?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(|e| format!("计算相对路径 {}: {e}", entry.path().display()))?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录 {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {}: {e}", parent.display()))?;
        }
        std::fs::copy(entry.path(), &target).map_err(|e| {
            format!(
                "复制 {} → {}: {e}",
                entry.path().display(),
                target.display()
            )
        })?;
        files += 1;
    }
    Ok(files)
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

/// 导出目录：系统对话框选目的地 + 整目录复制，**两步绑定在本命令内**。
///
/// 授权模型（与写允许域第二道闸的关系）：落点由用户在系统对话框里显式选定，
/// **对话框本身即授权**，故落点刻意**不过** `ensure_write_allowed`——导出的意义
/// 正是落到允许域之外（桌面 / 发布目录）。越权面为零：JS 侧只能传源目录与标题，
/// 拿不到落点决定权，无法借本命令往任意路径写。
///
/// 目标已存在同名目录 → 报错不覆盖（不静默吃掉用户既有文件）。
/// 用户取消对话框 → `Ok(None)`（取消是正常路径，不是错误）。
///
/// 复制是阻塞 IO，跑在 Tauri 的 async 命令线程上；口上包体量（百来个小文件）
/// 下耗时可忽略，无需再切线程。
#[tauri::command]
async fn export_directory(src_dir: String, title: Option<String>) -> Result<Option<String>, String> {
    let src = PathBuf::from(&src_dir);
    if !src.is_dir() {
        return Err(format!("导出源不是目录：{src_dir}"));
    }
    let dir_name = src
        .file_name()
        .map(|s| s.to_os_string())
        .ok_or_else(|| format!("导出源无目录名：{src_dir}"))?;

    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    let picked = match dialog.pick_folder().await {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(None),
    };

    let target = picked.join(&dir_name);
    // 已存在即拒绝：同时挡掉「目的地选到源目录自身父级」这类自我复制
    if target.exists() {
        return Err(format!("目标已存在，未覆盖：{}", target.display()));
    }
    let files = copy_dir_contents(&src, &target)?;
    eprintln!("[export_directory] {files} 个文件 → {}", target.display());
    Ok(Some(target.to_string_lossy().to_string()))
}

/// 导出**单个文件**到用户选定的位置（ZIP 发布包用；base64 过 IPC，与 `write_file_bytes` 同口径）。
///
/// 落点在写域之外是设计意图，与 `export_directory` 同理：授权来自用户在系统保存对话框里的
/// 显式选择，且**对话框与写盘绑在同一个命令内**（JS 拿不到落点决定权，也就无法把写操作
/// 引导到任意路径）。因此这里刻意不过 `ensure_write_allowed`。
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

/* ------------------------------- 入口 ------------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WriteDomainState::default())
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            read_file_bytes_raw,
            write_file_bytes,
            ensure_dir,
            list_dir,
            walk_dir,
            path_exists,
            stat_file,
            rename_path,
            copy_file,
            remove_file,
            remove_dir,
            choose_directory,
            export_directory,
            export_file,
            app_data_dir,
            register_write_domain,
            clear_write_domain,
            decode_bytes,
            encode_string,
            start_watch,
            stop_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ------------------------------- 单测（M3） ------------------------------- */

#[cfg(test)]
mod write_domain_tests {
    use super::{canonicalize_deep, ensure_in_write_domain, is_within};
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
        ensure_in_write_domain(Some(&root), &temp_root("appdata"), &sub.join("new.erb"), "write")
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_data_dir_always_allowed() {
        let appdata = temp_root("app");
        let project = temp_root("proj");
        ensure_in_write_domain(Some(&project), &appdata, &appdata.join("backup").join("v1.dat"), "write")
            .unwrap();
    }

    #[test]
    fn outside_domain_rejected() {
        let project = temp_root("proj");
        let other = temp_root("other");
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
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
        let err = ensure_in_write_domain(None, &appdata, &other.join("x.erb"), "write").unwrap_err();
        assert!(err.contains("写允许域拒绝"), "unexpected: {err}");
        // appDataDir 仍可写（备份 / 配置）
        ensure_in_write_domain(None, &appdata, &appdata.join("config.json"), "write").unwrap();
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
        let err =
            ensure_in_write_domain(Some(&project), &temp_root("appdata"), &sneaky, "write").unwrap_err();
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
        assert!(
            ensure_in_write_domain(Some(&project), &temp_root("appdata"), &sneaky, "remove").is_err()
        );
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
        assert!(
            ensure_in_write_domain(Some(&project), &temp_root("appdata"), &sibling.join("f.txt"), "write")
                .is_err()
        );
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
}

/* ------------------------- 单测（P-D 导出复制） ------------------------- */

#[cfg(test)]
mod export_copy_tests {
    use super::copy_dir_contents;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kojo-pd-{}-{}-{tag}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(p: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }

    /// 嵌套结构 + 空子目录一并复制，文件数只数文件（目录不计）
    #[test]
    fn copies_nested_tree_and_empty_dirs() {
        let base = temp_root("nested");
        let src = base.join("src");
        write(&src.join("README.txt"), b"readme");
        write(&src.join("ERB").join("a.erb"), b"a");
        write(&src.join("ERB").join("deep").join("b.erb"), b"b");
        std::fs::create_dir_all(src.join("empty")).unwrap();

        let dst = base.join("out");
        let n = copy_dir_contents(&src, &dst).unwrap();

        assert_eq!(n, 3, "应复制 3 个文件");
        assert_eq!(std::fs::read(dst.join("README.txt")).unwrap(), b"readme");
        assert_eq!(std::fs::read(dst.join("ERB/deep/b.erb")).unwrap(), b"b");
        assert!(dst.join("empty").is_dir(), "空子目录应保留（包结构不能塌）");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 字节保真：非 UTF-8（Shift-JIS）字节逐字节原样落地，不经任何转码
    #[test]
    fn preserves_non_utf8_bytes() {
        let base = temp_root("bytes");
        let src = base.join("src");
        // 「主人」的 Shift-JIS 字节序列（非合法 UTF-8）
        let sjis: [u8; 4] = [0x8E, 0xE8, 0x90, 0x6C];
        write(&src.join("kojo.erb"), &sjis);

        let dst = base.join("out");
        copy_dir_contents(&src, &dst).unwrap();

        assert_eq!(std::fs::read(dst.join("kojo.erb")).unwrap(), sjis);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 空源目录：只建目标目录，0 文件，不报错
    #[test]
    fn empty_source_yields_empty_target() {
        let base = temp_root("empty-src");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();

        let dst = base.join("out");
        let n = copy_dir_contents(&src, &dst).unwrap();

        assert_eq!(n, 0);
        assert!(dst.is_dir());
        let _ = std::fs::remove_dir_all(&base);
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
