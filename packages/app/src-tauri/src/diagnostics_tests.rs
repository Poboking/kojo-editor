//! 崩溃取证判据（P0-3）：panic hook 落盘、前端日志追加、大小上限截断、轮转清理、
//! UTC 时间戳锚点。照 `shell_tests` 的分文件先例。
//!
//! 双开行为（P0-4，tauri-plugin-single-instance）属真壳判据：见交付回执的手工验证记录。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use crate::diagnostics::{
    append_frontend_line, format_utc_timestamp, prune_logs, LOG_SIZE_CAP_BYTES, KEEP_PER_FAMILY,
};

/// 测试专用临时目录（照 `batch_io_tests::temp_dir` 形态）
fn temp_dir(tag: &str) -> PathBuf {
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("kojo-diag-{}-{n}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/* ------------------------------ UTC 时间戳 ------------------------------ */

#[test]
fn utc_timestamp_matches_known_epoch_anchors() {
    assert_eq!(format_utc_timestamp(SystemTime::UNIX_EPOCH), "19700101-000000");
    // 2001-09-09 01:46:40 UTC
    assert_eq!(
        format_utc_timestamp(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000)),
        "20010909-014640"
    );
    // 2038-01-19 03:14:08 UTC（32 位秒边界）
    assert_eq!(
        format_utc_timestamp(SystemTime::UNIX_EPOCH + Duration::from_secs(1 << 31)),
        "20380119-031408"
    );
    // 闰日：2024-02-29 12:00:00 UTC = 1709208000
    assert_eq!(
        format_utc_timestamp(SystemTime::UNIX_EPOCH + Duration::from_secs(1_709_208_000)),
        "20240229-120000"
    );
}

#[test]
fn utc_timestamp_shape_is_always_15_chars() {
    let s = format_utc_timestamp(SystemTime::now());
    assert_eq!(s.len(), 15);
    assert!(s.as_bytes()[8] == b'-', "日期与时间以 '-' 相隔：{s}");
}

/* ------------------------------ 前端日志追加 ------------------------------ */

#[test]
fn frontend_line_carries_timestamp_level_and_indented_detail() {
    let dir = temp_dir("fmt");
    append_frontend_line(&dir, "error", "加载失败：X", Some("第 1 行\n第 2 行")).unwrap();
    let files: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
    assert_eq!(files.len(), 1, "一次追加恰好一个当日文件");
    let name = files[0].file_name().to_string_lossy().into_owned();
    assert!(name.starts_with("frontend-"), "文件名前缀：{name}");
    assert!(name.ends_with(".log"), "文件名后缀：{name}");
    let body = std::fs::read_to_string(files[0].path()).unwrap();
    assert!(body.contains("[error] 加载失败：X"), "级别与消息：{body}");
    // 时间戳行首 + 详情多行缩进对齐
    let ts = body.strip_prefix('[').and_then(|r| r.split(']').next()).unwrap();
    assert_eq!(ts.len(), 15, "行首应是 15 位时间戳：{body}");
    assert!(body.contains("\n  详情: 第 1 行\n  第 2 行"), "多行详情逐行缩进：{body}");
    // 再追加一条：同一文件、两行正文都在
    append_frontend_line(&dir, "unhandledrejection", "第二条", None).unwrap();
    let body2 = std::fs::read_to_string(files[0].path()).unwrap();
    assert!(body2.contains("加载失败：X") && body2.contains("第二条"), "追加不覆盖：{body2}");
}

#[test]
fn frontend_line_empty_detail_is_omitted() {
    let dir = temp_dir("nodedetail");
    append_frontend_line(&dir, "error", "只有消息", Some("   ")).unwrap();
    let body = std::fs::read_to_string(dir.join(frontend_file_of(&dir))).unwrap();
    assert!(!body.contains("详情"), "空白详情整个不出现：{body}");
}

/// 目录里唯一的 frontend-*.log 文件名（测试辅助）
fn frontend_file_of(dir: &Path) -> String {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with("frontend-"))
        .expect("应有 frontend 日志文件")
}

/* ------------------------------ 大小上限截断 ------------------------------ */

/// 当日 UTC 日期串（与实现的当日文件名对齐）
fn today_tag() -> String {
    format_utc_timestamp(SystemTime::now())[..8].to_string()
}

#[test]
fn oversized_log_is_truncated_from_the_head_keeping_the_tail() {
    let dir = temp_dir("cap");
    let file = dir.join(format!("frontend-{}.log", today_tag()));
    // 头部超上限的整行垃圾 + 尾部一行标记行：截断必须保尾（取证要最新的）
    let mut junk: Vec<u8> = Vec::new();
    while junk.len() < LOG_SIZE_CAP_BYTES as usize + 1024 * 1024 {
        junk.extend_from_slice(&[b'x'; 1023]);
        junk.push(b'\n');
    }
    junk.extend_from_slice(b"TAIL-MARKER-LINE\n");
    std::fs::write(&file, &junk).unwrap();

    append_frontend_line(&dir, "error", "截断后的新错误", None).unwrap();

    let body = std::fs::read_to_string(&file).unwrap();
    assert!(body.contains("TAIL-MARKER-LINE"), "尾部行必须保留：{}", body.len());
    assert!(body.contains("截断后的新错误"), "新追加的记录在尾部：{}", body.len());
    assert!(body.starts_with("（日志超过"), "头部应是截断标记：{}", &body[..40]);
    assert!(
        body.len() <= LOG_SIZE_CAP_BYTES as usize + 1024,
        "截断后总体积应贴着上限（含标记与新行）：{}",
        body.len()
    );
    // 垃圾 x 段被切掉了一大半
    let x_count = body.bytes().filter(|&b| b == b'x').count();
    assert!(x_count < LOG_SIZE_CAP_BYTES as usize, "头部垃圾应被裁掉：{x_count}");
}

#[test]
fn under_cap_file_is_not_rewritten() {
    let dir = temp_dir("nocap");
    let file = dir.join(format!("frontend-{}.log", today_tag()));
    std::fs::write(&file, "small\n").unwrap();
    append_frontend_line(&dir, "error", "新行", None).unwrap();
    let body = std::fs::read_to_string(&file).unwrap();
    assert!(body.starts_with("small\n"), "不超限不重写头部：{body}");
    assert!(body.contains("新行"), "追加在同文件：{body}");
}

/* ------------------------------ panic hook ------------------------------ */

#[test]
fn panic_hook_writes_the_scene_to_disk_and_restores_console_hook() {
    let dir = temp_dir("panic");
    // 保存默认 hook → 装我们的 → 真触发一次 panic → 恢复。
    // 并行测试窗口内其它用例若 panic 会被写进本目录（无害），hook 已在末尾恢复。
    let prev = std::panic::take_hook();
    crate::diagnostics::install_panic_hook(dir.clone());
    let caught = std::panic::catch_unwind(|| {
        panic!("取证专用崩溃载荷 12345");
    });
    std::panic::set_hook(prev);
    assert!(caught.is_err(), "catch_unwind 应捕获到 panic");

    let file = dir.join(panic_file_of(&dir));
    let body = std::fs::read_to_string(&file).unwrap();
    assert!(body.contains("取证专用崩溃载荷 12345"), "payload 必须落盘：{body}");
    assert!(body.contains("panic:"), "记录类别：{body}");
    assert!(body.contains("位置:"), "位置行：{body}");
    assert!(body.contains("回溯:"), "回溯行：{body}");
    assert!(body.contains("diagnostics_tests.rs"), "位置应指向测试源文件：{body}");
}

/// 目录里唯一的 panic-*.log 文件名（测试辅助）
fn panic_file_of(dir: &Path) -> String {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with("panic-"))
        .expect("应有 panic 日志文件")
}

/* ------------------------------ 轮转 ------------------------------ */

/// 造一个带指定 mtime 的文件（mtime 决定轮转的保留序）
fn stamp(path: &Path, older_by_secs: u64) {
    std::fs::write(path, "x").unwrap();
    let f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - Duration::from_secs(older_by_secs)).unwrap();
}

#[test]
fn prune_keeps_newest_per_family_and_ignores_other_files() {
    let dir = temp_dir("prune");
    let keep = 3;
    // 两族各造 5 个（mtime 递减：i 越大越旧），外加 1 个无关文件
    for i in 0..5u64 {
        stamp(&dir.join(format!("panic-{i}.log")), i * 10);
        stamp(&dir.join(format!("frontend-{i}.log")), 100 + i * 10);
    }
    stamp(&dir.join("notes.txt"), 0);

    let removed = prune_logs(&dir, keep).unwrap();

    assert_eq!(removed.len(), 4, "两族各删 2 个最旧的：{removed:?}");
    for i in 0..5u64 {
        let p = dir.join(format!("panic-{i}.log"));
        let f = dir.join(format!("frontend-{i}.log"));
        // 最新 keep 个（i = 0..3）保留，最旧（i = 3,4）删除
        assert_eq!(p.exists(), i < keep as u64, "panic-{i} 保留判定");
        assert_eq!(f.exists(), i < keep as u64, "frontend-{i} 保留判定");
    }
    assert!(dir.join("notes.txt").exists(), "非日志文件不碰");
}

#[test]
fn prune_with_fewer_files_than_keep_removes_nothing() {
    let dir = temp_dir("prune-none");
    stamp(&dir.join("panic-a.log"), 10);
    stamp(&dir.join("frontend-a.log"), 5);
    let removed = prune_logs(&dir, KEEP_PER_FAMILY).unwrap();
    assert!(removed.is_empty(), "文件数未达保留数时零删除：{removed:?}");
    assert!(dir.join("panic-a.log").exists());
    assert!(dir.join("frontend-a.log").exists());
}

#[test]
fn prune_on_missing_directory_is_ok_and_empty() {
    let gone = temp_dir("prune-missing").join("kojo-logs");
    let removed = prune_logs(&gone, 5).unwrap();
    assert!(removed.is_empty());
}

/* ------------------------------ 单条钳制 ------------------------------ */

#[test]
fn oversize_record_is_clamped_with_marker() {
    let dir = temp_dir("clamp");
    let huge = "超".repeat(40 * 1024); // 120KB 字节量，超 64KB 上限
    append_frontend_line(&dir, "error", &huge, None).unwrap();
    let file = dir.join(frontend_file_of(&dir));
    let body = std::fs::read(&file).unwrap();
    assert!(body.len() < 128 * 1024, "巨型记录必须被钳制：{}", body.len());
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("记录超长，已截断"), "截断标记：{}", &text[text.len().saturating_sub(80)..]);
    // 截尾处仍是合法 UTF-8（首行可整体解码）
    let line = text.lines().next().unwrap();
    assert!(line.contains("panic") || line.contains("error") || line.contains("超"), "行首仍是完整记录：{line}");
}