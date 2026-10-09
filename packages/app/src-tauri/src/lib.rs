//! kojo-editor Tauri 宿主。
//!
//! 本层的全部职责 = 为 WebView 内的内核提供 **PlatformBridge 原语**：
//! 文件字节读写（原子写）、目录遍历、编解码（encoding_rs）、目录对话框、应用数据目录。
//! **零游戏知识、零业务逻辑**——一切领域逻辑都在前端的内核与插件中。
//!
//! 二进制数据经 base64 字符串跨 IPC（确定性强；口上文件体量下开销可忽略）。

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

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
#[tauri::command]
fn write_file_bytes(path: String, data: String) -> Result<(), String> {
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
fn ensure_dir(path: String) -> Result<(), String> {
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
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_file(from: String, to: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&to).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
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
#[tauri::command]
fn decode_bytes(data: String, encoding: String) -> Result<String, String> {
    let bytes = B64.decode(data).map_err(|e| e.to_string())?;
    let enc = encoding_for(&encoding)?;
    let (text, _actual, _had_errors) = enc.decode(&bytes);
    Ok(text.into_owned())
}

/// 字符串 → 字节；`utf-8-bom` 显式加 BOM。
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
            let (encoded, _, _) = enc.encode(&text);
            encoded.into_owned()
        }
    };
    Ok(B64.encode(buf))
}

/* ------------------------------- 入口 ------------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            decode_bytes,
            encode_string
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
