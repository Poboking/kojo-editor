//! 崩溃取证（P0-3）：panic 现场 + 前端兜底错误的日志落盘。
//!
//! 分层口径：
//! - **panic hook 直写文件**（`std::fs`，不走 IPC——panic 时 IPC 不可靠），落点
//!   `<appDataDir>/kojo-logs/panic-YYYYMMDD.log`（UTC 按日聚合，追加写）；
//!   hook 末尾交回默认 hook，console 输出保持原样。
//! - **前端错误**（`window.onerror` / `unhandledrejection`）经 `append_frontend_log`
//!   命令追加写入 `frontend-YYYYMMDD.log`。命令是纯 IO 原语：**不接受路径参数**，
//!   落点由宿主定死在 appData 日志目录 ⇒ 无越权面（与 `export_file` 的"无路径参数"
//!   同哲学），也不经过写允许域第二道闸（宿主自己的日志不是用户数据）。
//! - **轮转**：每族（panic-* / frontend-*）保留最近 20 个文件；单文件超 5MB 保尾截断。
//!   裁剪动作写进日志自证（截断标记 + 轮转记录），不静默。
//!
//! 时间戳一律 UTC（无本地时区依赖，取证时按日志内时间戳对事件即可）。

use std::borrow::Cow;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 日志目录名（appDataDir 之下）
const LOG_DIR_NAME: &str = "kojo-logs";
/// 每族（panic- / frontend- 前缀）保留的文件数上限
pub const KEEP_PER_FAMILY: usize = 20;
/// 单文件字节上限：超限保尾截断（取证要最新的，截头不截尾）
pub const LOG_SIZE_CAP_BYTES: u64 = 5 * 1024 * 1024;
/// 单条记录的体积上限（防一条巨型 message 把整份日志撑穿）
const RECORD_MAX_BYTES: usize = 64 * 1024;

/// 日志目录：`<appDataDir>/kojo-logs`
pub fn log_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LOG_DIR_NAME)
}

/// 当日 UTC 日期串（YYYYMMDD）
fn today_utc() -> String {
    format_utc_timestamp(SystemTime::now())[..8].to_string()
}

/* ------------------------------ UTC 时间戳 ------------------------------ */

/// epoch 天数 → 公历（Howard Hinnant `civil_from_days`；纯函数，锚点对拍见测试）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// SystemTime → `YYYYMMDD-HHMMSS`（UTC）
pub fn format_utc_timestamp(t: SystemTime) -> String {
    let secs = t
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, mo, d) = civil_from_days(days as i64);
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        y,
        mo,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/* ------------------------------ 追加写 ------------------------------ */

/// 追加一行（目录不存在则建；纯 std::fs，panic 时也可用）
fn append_line(file: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    f.write_all(line.as_bytes())
}

/// 单条记录体积钳制：超长按字节截尾（对齐 UTF-8 字符边界）+ 截断标记
fn clamp_record(s: &str) -> Cow<'_, str> {
    if s.len() <= RECORD_MAX_BYTES {
        return Cow::Borrowed(s);
    }
    let mut end = RECORD_MAX_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    Cow::Owned(format!(
        "{}…（记录超长，已截断）",
        &s[..end]
    ))
}

/// 单文件大小上限：超限时**保尾截断**——重写为「截断标记 + 尾部不超过上限的字节
/// （对齐行首，避免切半个多字节字符）」。不超限 = 完全不动。
fn enforce_size_cap(file: &Path) -> Result<(), String> {
    let Ok(md) = std::fs::metadata(file) else {
        return Ok(()); // 文件还不存在：正常态
    };
    if md.len() <= LOG_SIZE_CAP_BYTES {
        return Ok(());
    }
    let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
    let start = bytes.len().saturating_sub(LOG_SIZE_CAP_BYTES as usize);
    // 从裁切线往后找第一个换行：保留段从完整行开始（顺带保证 UTF-8 边界）
    let start = bytes[start..]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(start);
    let mut out = format!(
        "（日志超过 {} 字节上限，前文已截断；原 {} 字节）\n",
        LOG_SIZE_CAP_BYTES,
        bytes.len()
    )
    .into_bytes();
    out.extend_from_slice(&bytes[start..]);
    super::atomic_write(file, &out).map_err(|e| e.to_string())
}

/* ------------------------------ panic hook ------------------------------ */

/// panic 载荷 → 文本（&str / String / 其它）
fn payload_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "（非文本 panic 载荷）".to_string()
    }
}

/// panic 记录文本（时间戳 + 载荷 + 位置 + 回溯可得部分）
fn panic_record(payload: &str, location: &str, backtrace: &str) -> String {
    format!(
        "[{}] panic: {payload}\n  位置: {location}\n  回溯: {backtrace}\n",
        format_utc_timestamp(SystemTime::now())
    )
}

/// panic 记录落盘（直写文件；失败只剩 stderr 一条命——panic 里没有更可靠的通道了）
fn write_panic_record(dir: &Path, record: &str) {
    let file = dir.join(format!("panic-{}.log", today_utc()));
    if let Err(e) = enforce_size_cap(&file).and_then(|()| append_line(&file, record).map_err(|e| e.to_string())) {
        eprintln!("[panic-hook] 落盘失败 {}: {e}", file.display());
    }
}

/// 装 panic hook：panic 现场直写 kojo-logs（不走 IPC），末尾交回默认 hook 保 console。
pub fn install_panic_hook(dir: PathBuf) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = payload_text(info.payload());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "未知".to_string());
        // force_capture 无视 RUST_BACKTRACE 开关——取证场景要的就是"可得部分"全拿
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        write_panic_record(&dir, &panic_record(&payload, &location, &bt));
        prev(info);
    }));
}

/* ------------------------------ 前端错误日志 ------------------------------ */

/// 前端兜底日志的同步核心（可单测）：时间戳 + 级别 + 消息 + 可选详情（多行缩进对齐）
pub fn append_frontend_line(
    dir: &Path,
    level: &str,
    message: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    let file = dir.join(format!("frontend-{}.log", today_utc()));
    let message = clamp_record(message);
    let mut line = format!(
        "[{}] [{}] {}",
        format_utc_timestamp(SystemTime::now()),
        clamp_record(level),
        message
    );
    if let Some(d) = detail.map(str::trim).filter(|d| !d.is_empty()) {
        let d = clamp_record(d);
        line.push_str("\n  详情: ");
        line.push_str(&d.replace('\n', "\n  "));
    }
    line.push('\n');
    enforce_size_cap(&file)?;
    append_line(&file, &line).map_err(|e| e.to_string())
}

/// 前端兜底错误落盘（P0-3 ③）：`window.onerror` / `unhandledrejection` 捕获的
/// 现场追加写入 appData 日志目录。console 原生行为不动（前端不 preventDefault）。
///
/// 纯 IO 原语：不接受路径参数、落点写死 ⇒ 无越权面，不过写允许域闸（同 `export_file`
/// 的"无路径参数"哲学；宿主自己的日志目录恒为 appData）。
#[tauri::command]
pub fn append_frontend_log(
    app: tauri::AppHandle,
    level: String,
    message: String,
    detail: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    append_frontend_line(&log_dir(&app_dir), &level, &message, detail.as_deref())
}

/* ------------------------------ 轮转 ------------------------------ */

/// 启动时轮转：每族（panic- / frontend- 前缀的 .log）按 mtime 各保留最近 `keep` 个，
/// 删除其余。返回删除清单——**调用方负责写自证记录**（不静默）。
/// 非 `panic-*.log` / `frontend-*.log` 命名的文件一律不碰；目录不存在 = 没东西可删。
pub fn prune_logs(dir: &Path, keep: usize) -> std::io::Result<Vec<PathBuf>> {
    let mut families: [Vec<(PathBuf, SystemTime)>; 2] = [Vec::new(), Vec::new()];
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let idx = if name.starts_with("panic-") && name.ends_with(".log") {
            0
        } else if name.starts_with("frontend-") && name.ends_with(".log") {
            1
        } else {
            continue;
        };
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        families[idx].push((entry.path(), mtime));
    }
    let mut removed = Vec::new();
    for fam in &mut families {
        // 新 → 旧；保留前 keep 个
        fam.sort_by(|a, b| b.1.cmp(&a.1));
        for (p, _) in fam.iter().skip(keep) {
            if std::fs::remove_file(p).is_ok() {
                removed.push(p.clone());
            }
        }
    }
    Ok(removed)
}

/// 启动装配：装 panic hook + 轮转清理（裁剪动作写日志自证）。
/// 任何一步失败都不阻断启动（取证设施自己是最后顺位），但都出声。
pub fn setup_diagnostics(app_data_dir: &Path) {
    let dir = log_dir(app_data_dir);
    install_panic_hook(dir.clone());
    match prune_logs(&dir, KEEP_PER_FAMILY) {
        Ok(removed) if removed.is_empty() => {}
        Ok(removed) => {
            // 自证：裁剪记录写进当日前端日志（+ stderr 一份），删了什么、删了多少可见
            let names: Vec<String> = removed
                .iter()
                .map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
                .collect();
            let _ = append_frontend_line(
                &dir,
                "rotate",
                &format!("日志轮转：删除了 {} 个超出保留数（{}）的旧文件", removed.len(), KEEP_PER_FAMILY),
                Some(&names.join("\n")),
            );
            eprintln!(
                "[diagnostics] 日志轮转：删除 {} 个旧文件（每族保留 {}）",
                removed.len(),
                KEEP_PER_FAMILY
            );
        }
        Err(e) => eprintln!("[diagnostics] 日志轮转失败 {}: {e}", dir.display()),
    }
}