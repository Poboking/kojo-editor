//! kojo-editor Tauri 宿主。
//!
//! 本层的全部职责 = 为 WebView 内的内核提供 **PlatformBridge 原语**：
//! 文件字节读写（原子写）、目录遍历、编解码（encoding_rs）、目录对话框、应用数据目录。
//! **零游戏知识、零业务逻辑**——一切领域逻辑都在前端的内核与插件中。
//!
//! 二进制数据经 base64 字符串跨 IPC（确定性强；口上文件体量下开销可忽略）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
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

/* ------------------------------- 入口 ------------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WriteDomainState::default())
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            write_file_bytes,
            ensure_dir,
            list_dir,
            walk_dir,
            path_exists,
            stat_file,
            rename_path,
            copy_file,
            remove_file,
            choose_directory,
            app_data_dir,
            register_write_domain,
            clear_write_domain,
            decode_bytes,
            encode_string
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
