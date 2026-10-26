//! 存档宿主面的判据（`cargo test --lib`；临时目录，不碰真游戏目录）。
//!
//! 夹具复用 `content_tests` 的实例 / ZIP 工具：存档面与内容面共用同一套"实例根 + 相对路径"
//! 口径，测试也应当从同一处起手。

use std::path::PathBuf;

use serde_json::json;

use super::content;
use super::content_tests::{content_root_json, save_root_json, test_host, write_zip, TestDir};
use super::error::ErrorCode;
use super::saves::{self, SaveBackupRequestDto, SaveExportRequestDto, SaveFileRefDto};
use super::store;
use super::LauncherHost;
use std::sync::Arc;

/// 一个 copy 实例 + 一个存档根 `saves`（`instances/{id}/game/saves/`）。
fn save_instance(host: &Arc<LauncherHost>, dir: &TestDir, id: &str) -> PathBuf {
    let game_root = dir.join("source");
    std::fs::create_dir_all(&game_root).expect("源根");
    content::install_test_instance(
        &host.layout,
        id,
        &game_root,
        "copy",
        vec![content_root_json("data", "data")],
    )
    .expect("实例");
    saves::set_save_roots(
        &host.layout,
        id,
        vec![save_root_json("saves", "saves")],
    )
    .expect("存档根");
    let root = host
        .layout
        .game_dir(id)
        .expect("游戏目录")
        .join("saves");
    std::fs::create_dir_all(&root).expect("存档目录");
    root
}

fn write_save(root: &std::path::Path, name: &str, bytes: &[u8]) {
    let path = root.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("目录");
    }
    std::fs::write(&path, bytes).expect("写存档");
}

/* ------------------------------- 列表 / 备份 ------------------------------- */

#[test]
fn save_list_reports_entries_and_approval() {
    let dir = TestDir::new("save-list");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-saves");
    write_save(&root, "slot1.sav", b"one");
    write_save(&root, "auto/slot2.sav", b"two");

    let listing = saves::list(&host, "inst-saves").expect("列表");
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.roots.len(), 1);
    assert!(listing.roots[0].approved, "copy 实例恒已授权");
    assert!(listing.roots[0].exists);
    let paths: Vec<&str> = listing.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec!["auto/slot2.sav", "slot1.sav"]);
    assert_eq!(listing.entries[1].bytes, 3);
    assert_eq!(listing.entries[1].root_id, "saves");
}

#[test]
fn backup_writes_zip_and_metadata_and_can_be_listed() {
    let dir = TestDir::new("save-backup");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-bk");
    write_save(&root, "slot1.sav", b"payload");

    let task = saves::backup(
        &host,
        "inst-bk",
        SaveBackupRequestDto {
            label: Some("我的备份".to_string()),
            reason: None,
            entries: None,
        },
    )
    .expect("备份");
    assert_eq!(task.state, "succeeded");
    let id = task
        .result
        .as_ref()
        .and_then(|result| result.get("backupId"))
        .and_then(|value| value.as_str())
        .expect("要回备份 id")
        .to_string();

    let listing = saves::backups(&host, "inst-bk").expect("备份列表");
    assert_eq!(listing.len(), 1);
    assert_eq!(listing[0].id, id);
    assert_eq!(listing[0].label, "我的备份");
    assert_eq!(listing[0].reason, "manual");
    assert_eq!(listing[0].entry_count, 1);
    assert_eq!(listing[0].bytes, 7);
    assert!(
        host.layout
            .save_backups_dir("inst-bk")
            .expect("备份目录")
            .join(format!("{id}.zip"))
            .is_file(),
        "备份 = ZIP + 元数据"
    );
}

#[test]
fn restore_backs_up_current_before_writing() {
    let dir = TestDir::new("save-restore");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-rs");
    write_save(&root, "slot1.sav", b"v1");

    let first = saves::backup(&host, "inst-rs", SaveBackupRequestDto::default()).expect("备份 v1");
    let id = first
        .result
        .as_ref()
        .and_then(|result| result.get("backupId"))
        .and_then(|value| value.as_str())
        .expect("id")
        .to_string();

    write_save(&root, "slot1.sav", b"v2-tampered");
    let task = saves::restore(&host, "inst-rs", &id, Default::default()).expect("恢复");
    assert_eq!(task.state, "succeeded");
    assert_eq!(
        std::fs::read(root.join("slot1.sav")).expect("恢复后"),
        b"v1"
    );
    let backups = saves::backups(&host, "inst-rs").expect("列表");
    assert!(
        backups.iter().any(|item| item.reason == "pre-restore"),
        "恢复前必须自动备份当前（§11.3）"
    );
    assert_eq!(backups.len(), 2);
}

#[test]
fn restore_unknown_backup_is_rejected() {
    let dir = TestDir::new("save-restore-missing");
    let host = test_host(dir.path());
    save_instance(&host, &dir, "inst-rs2");
    let err = saves::restore(&host, "inst-rs2", "bk-nope", Default::default())
        .expect_err("找不到必须拒");
    assert_eq!(
        err.code,
        ErrorCode::SaveRestoreFailed.as_str(),
        "{}",
        err.message
    );

    let err = saves::restore(&host, "inst-rs2", "../../etc/passwd", Default::default())
        .expect_err("形状闸必须拒");
    assert_eq!(err.code, ErrorCode::PathEscape.as_str(), "{}", err.message);
}

#[test]
fn delete_backup_removes_only_that_one() {
    let dir = TestDir::new("save-delete");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-del");
    write_save(&root, "slot1.sav", b"one");

    let mut ids = Vec::new();
    for _ in 0..2 {
        let task = saves::backup(&host, "inst-del", SaveBackupRequestDto::default()).expect("备份");
        ids.push(
            task.result
                .as_ref()
                .and_then(|result| result.get("backupId"))
                .and_then(|value| value.as_str())
                .expect("id")
                .to_string(),
        );
    }
    saves::delete_backup(&host, "inst-del", &ids[0]).expect("删");
    let left = saves::backups(&host, "inst-del").expect("列表");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, ids[1]);

    let err = saves::delete_backup(&host, "inst-del", "..").expect_err("越界 id 必须拒");
    assert_eq!(err.code, ErrorCode::PathEscape.as_str());
}

#[test]
fn backup_retention_keeps_newest_and_spares_safety_backups() {
    let dir = TestDir::new("save-retention");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-keep");
    write_save(&root, "slot1.sav", b"x");

    for _ in 0..3 {
        saves::backup(&host, "inst-keep", SaveBackupRequestDto::default()).expect("手动备份");
    }
    // 一份安全回退点（不占配额）
    saves::restore(
        &host,
        "inst-keep",
        &saves::backups(&host, "inst-keep").expect("列表")[0].id.clone(),
        Default::default(),
    )
    .expect("恢复（顺带产生 pre-restore 备份）");

    let removed = saves::prune_backups(&host.layout, "inst-keep", 2).expect("清理");
    assert_eq!(removed, 1, "只删超额的那一份 manual");
    let left = saves::backups(&host, "inst-keep").expect("列表");
    assert_eq!(
        left.iter().filter(|item| item.reason == "manual").count(),
        2,
        "manual 只留 2 份"
    );
    assert!(
        left.iter().any(|item| item.reason == "pre-restore"),
        "安全回退点永不自动删"
    );
}

/* ------------------------------- 导入 / 导出 ------------------------------- */

fn make_save_import(dir: &TestDir, name: &str, files: &[(&str, &[u8])]) -> PathBuf {
    let entries: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(path, bytes)| (format!("saves/{path}"), bytes.to_vec()))
        .collect();
    let path = dir.join(name);
    write_zip(&path, &entries);
    path
}

#[test]
fn import_is_two_phase() {
    let dir = TestDir::new("save-import");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-imp");
    write_save(&root, "slot1.sav", b"local");
    let archive = make_save_import(&dir, "import.zip", &[("slot1.sav", b"imported")]);

    let plan = saves::plan_import(&host, "inst-imp", &archive.to_string_lossy()).expect("预检");
    assert_eq!(plan.entry_count, 1);
    assert_eq!(plan.overwrites, vec!["slot1.sav".to_string()]);
    assert!(!plan.backup_id.is_empty());
    assert_eq!(
        std::fs::read(root.join("slot1.sav")).expect("预检不写"),
        b"local",
        "导入预检不得动存档"
    );

    let task = saves::apply_import(&host, &plan.plan_id, None).expect("应用");
    assert_eq!(task.state, "succeeded");
    assert_eq!(
        std::fs::read(root.join("slot1.sav")).expect("导入后"),
        b"imported"
    );

    // 计划一次性消费
    let err = saves::apply_import(&host, &plan.plan_id, None).expect_err("同一计划不能重放");
    assert_eq!(err.code, ErrorCode::Internal.as_str(), "{}", err.message);
}

#[test]
fn import_plan_expires() {
    let dir = TestDir::new("save-import-exp");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-imp2");
    write_save(&root, "slot1.sav", b"local");
    let archive = make_save_import(&dir, "import2.zip", &[("slot1.sav", b"imported")]);
    let plan = saves::plan_import(&host, "inst-imp2", &archive.to_string_lossy()).expect("预检");

    let path = host
        .layout
        .staging_plan_dir("inst-imp2", &plan.plan_id)
        .expect("暂存")
        .join("plan.json");
    let mut stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("读")).expect("解析");
    stored["expiresAt"] = json!("2020-01-01T00:00:00Z");
    std::fs::write(&path, serde_json::to_vec_pretty(&stored).expect("写")).expect("写");

    let err = saves::apply_import(&host, &plan.plan_id, None).expect_err("过期必须拒");
    assert_eq!(err.code, ErrorCode::Internal.as_str(), "{}", err.message);
    assert_eq!(
        std::fs::read(root.join("slot1.sav")).expect("没被写"),
        b"local"
    );
}

#[test]
fn import_rejects_unknown_save_root() {
    let dir = TestDir::new("save-import-root");
    let host = test_host(dir.path());
    save_instance(&host, &dir, "inst-imp3");
    let archive = dir.join("bad.zip");
    write_zip(
        &archive,
        &[("elsewhere/slot1.sav".to_string(), b"x".to_vec())],
    );
    let err = saves::plan_import(&host, "inst-imp3", &archive.to_string_lossy())
        .expect_err("未声明的根必须拒");
    assert_eq!(
        err.code,
        ErrorCode::SourceNotApproved.as_str(),
        "{}",
        err.message
    );
}

#[test]
fn export_writes_zip_under_root_entry_names() {
    let dir = TestDir::new("save-export");
    let host = test_host(dir.path());
    let root = save_instance(&host, &dir, "inst-exp");
    write_save(&root, "slot1.sav", b"one");
    write_save(&root, "auto/slot2.sav", b"two");

    let dest = dir.join("out").join("saves.zip");
    saves::export_to(
        &host,
        "inst-exp",
        SaveExportRequestDto::default(),
        &dest,
    )
    .expect("导出");
    let file = std::fs::File::open(&dest).expect("导出文件");
    let mut archive = zip::ZipArchive::new(file).expect("是 ZIP");
    let mut names: Vec<String> = (0..archive.len())
        .map(|index| archive.by_index(index).expect("条目").name().to_string())
        .collect();
    names.sort();
    assert_eq!(names, vec!["saves/auto/slot2.sav", "saves/slot1.sav"]);
}

#[test]
fn export_selection_must_be_relative_and_known() {
    let dir = TestDir::new("save-export-escape");
    let host = test_host(dir.path());
    save_instance(&host, &dir, "inst-exp2");
    let req = SaveExportRequestDto {
        label: None,
        entries: Some(vec![SaveFileRefDto {
            root_id: "saves".to_string(),
            path: "../../evil.sav".to_string(),
        }]),
    };
    let err = saves::export_to(&host, "inst-exp2", req, &dir.join("x.zip"))
        .expect_err("越界相对名必须拒");
    assert_eq!(err.code, ErrorCode::PathEscape.as_str(), "{}", err.message);
}

/* ------------------------------- shared 实例 ------------------------------- */

#[test]
fn shared_save_root_requires_approval_before_write() {
    let dir = TestDir::new("save-shared");
    let host = test_host(dir.path());
    let game_root = dir.join("game");
    std::fs::create_dir_all(game_root.join("saves")).expect("存档目录");
    content::install_test_instance(
        &host.layout,
        "inst-shared-save",
        &game_root,
        "shared",
        Vec::new(),
    )
    .expect("实例");
    saves::set_save_roots(
        &host.layout,
        "inst-shared-save",
        vec![save_root_json("saves", "saves")],
    )
    .expect("存档根");
    std::fs::write(game_root.join("saves").join("slot1.sav"), b"v1").expect("存档");

    // 备份只读 → 可以（落点在实例备份目录）
    let task = saves::backup(&host, "inst-shared-save", SaveBackupRequestDto::default())
        .expect("备份可做");
    let id = task
        .result
        .as_ref()
        .and_then(|result| result.get("backupId"))
        .and_then(|value| value.as_str())
        .expect("id")
        .to_string();

    // 写回没有授权 → 拒（不静默跳过）
    let err = saves::restore(&host, "inst-shared-save", &id, Default::default())
        .expect_err("未授权写回必须拒");
    assert_eq!(
        err.code,
        ErrorCode::SourceNotApproved.as_str(),
        "{}",
        err.message
    );

    // 授权后可以写回
    store::approve_write_root(
        &host.layout,
        "inst-shared-save",
        "saves",
        &game_root.join("saves"),
        "2026-01-01T00:00:00Z",
    )
    .expect("授权");
    saves::restore(&host, "inst-shared-save", &id, Default::default()).expect("授权后恢复");
    assert_eq!(
        std::fs::read(game_root.join("saves").join("slot1.sav")).expect("写回"),
        b"v1"
    );
}

#[test]
fn save_tools_are_reachable_from_command_names() {
    // 命令清单与 lib.rs 的注册表由 `tests.rs` 钉住；这里只确认本模块的八条名字都在清单里。
    for name in [
        "launcher_save_list",
        "launcher_save_backups",
        "launcher_save_backup",
        "launcher_save_restore",
        "launcher_save_delete_backup",
        "launcher_save_import",
        "launcher_save_apply_import",
        "launcher_save_export",
    ] {
        assert!(
            super::commands::COMMAND_NAMES.contains(&name),
            "命令清单缺 {name}"
        );
    }
    for name in [
        "launcher_content_list",
        "launcher_content_plan",
        "launcher_content_apply",
        "launcher_content_uninstall",
        "launcher_content_set_enabled",
        "launcher_content_set_order",
        "launcher_content_diagnose",
        "launcher_pick_archive",
    ] {
        assert!(
            super::commands::COMMAND_NAMES.contains(&name),
            "命令清单缺 {name}"
        );
    }
}
