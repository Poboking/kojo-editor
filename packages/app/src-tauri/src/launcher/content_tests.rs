//! 内容包宿主面的判据（`cargo test --lib`；全部跑在 `temp_dir()` 下的临时目录，不碰真游戏目录）。
//!
//! 夹具只手造两样东西：实例清单（`content::install_test_instance`）与 ZIP（`zip::ZipWriter`）。
//! 每个用例都从"空实例 + 一只包"开始，断言的是**盘上事实**（文件内容 / ownership / 暂存 /
//! 备份目录），不是中间状态。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::content::{self, ResolutionDto};
use super::error::ErrorCode;
use super::paths;
use super::store;
use super::trust;
use super::{EmitFn, LauncherHost};

static SEQ: AtomicU64 = AtomicU64::new(0);

/* ------------------------------- 夹具 ------------------------------- */

pub(super) struct TestDir {
    path: PathBuf,
}

impl TestDir {
    pub(super) fn new(tag: &str) -> Self {
        let unique = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "kojo-content-{tag}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("测试临时目录必须能建");
        Self { path }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    pub(super) fn path_of(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        for _ in 0..10 {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(30)),
            }
        }
    }
}

pub(super) fn test_host(app_data: &Path) -> Arc<LauncherHost> {
    let emit: EmitFn = Arc::new(|_event: &str, _payload: Value| {});
    LauncherHost::new(app_data, emit)
}

/// 内容根声明（`ContentRootSpec` 的宿主子集）。
pub(super) fn content_root_json(id: &str, relative: &str) -> Value {
    json!({
        "id": id,
        "label": id,
        "relativePath": relative,
        "kind": "script",
        "accepts": ["script", "resource", "data", "plugin"],
        "writableInShared": true,
    })
}

pub(super) fn save_root_json(id: &str, relative: &str) -> Value {
    json!({
        "id": id,
        "label": id,
        "relativePath": relative,
        "format": "test",
        "writableInShared": true,
    })
}

pub(super) fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let file = std::fs::File::create(path).expect("ZIP 必须能建");
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer.start_file(name.as_str(), options).expect("条目");
        writer.write_all(bytes).expect("写条目");
    }
    writer.finish().expect("收尾");
}

/// 造一只包：`pack.json` + 载荷（条目名 = `{rootId}/{path}`）。
pub(super) fn make_pack_with(
    dir: &TestDir,
    pack_id: &str,
    manifest_file_entries: Vec<Value>,
    payload: &[(String, Vec<u8>)],
) -> PathBuf {
    let manifest = json!({
        "schemaVersion": 1,
        "id": pack_id,
        "name": format!("测试包 {pack_id}"),
        "version": "1.0.0",
        "kind": "script",
        "gameId": "test-game",
        "files": manifest_file_entries,
        "loadOrder": 0,
    });
    let mut entries: Vec<(String, Vec<u8>)> = vec![(
        "pack.json".to_string(),
        serde_json::to_vec_pretty(&manifest).expect("清单序列化"),
    )];
    entries.extend(payload.iter().cloned());
    let path = dir.join(&format!("{pack_id}.zip"));
    write_zip(&path, &entries);
    path
}

/// 造一只包（文件清单由 `(rootId, path, 内容)` 给出）。
pub(super) fn make_pack(
    dir: &TestDir,
    pack_id: &str,
    files: &[(&str, &str, &[u8])],
) -> PathBuf {
    let manifest_entries: Vec<Value> = files
        .iter()
        .map(|(root, path, bytes)| {
            json!({
                "rootId": root,
                "path": path,
                "sha256": trust::sha256_bytes(bytes),
                "size": bytes.len() as u64,
            })
        })
        .collect();
    let payload: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(root, path, bytes)| (format!("{root}/{path}"), bytes.to_vec()))
        .collect();
    make_pack_with(dir, pack_id, manifest_entries, &payload)
}

/// 一个 copy 实例（游戏目录 = `instances/{id}/game/`，由宿主自己建）。
fn copy_instance(host: &Arc<LauncherHost>, dir: &TestDir, id: &str) -> PathBuf {
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
    host.layout.game_dir(id).expect("游戏目录")
}

fn apply_ok(
    host: &Arc<LauncherHost>,
    plan_id: &str,
    resolutions: Option<Vec<ResolutionDto>>,
) -> super::tasks::TaskDto {
    content::apply(host, plan_id, resolutions).expect("应用必须成功")
}

/* ------------------------------- 预检 ------------------------------- */

#[test]
fn plan_only_touches_staging_and_reports_expiry() {
    let dir = TestDir::new("plan-staging");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-plan");
    let archive = make_pack(&dir, "demo.pack", &[("data", "a.txt", b"hello")]);

    let plan = content::plan(&host, "inst-plan", &archive.to_string_lossy(), None).expect("预检");
    assert_eq!(plan.additions.len(), 1, "新文件应记为 additions");
    assert!(plan.overwrites.is_empty());
    assert!(plan.conflicts.is_empty());
    assert!(
        content::parse_iso_ms(&plan.expires_at).expect("过期时刻") > super::unix_ms(),
        "计划必须带未来的 expiresAt"
    );
    // 计划只落暂存，**游戏根一个字节都不写**
    assert!(!game.join("data").join("a.txt").exists(), "预检不得写游戏根");
    let staging = host
        .layout
        .staging_plan_dir("inst-plan", &plan.plan_id)
        .expect("暂存目录");
    assert!(staging.join("plan.json").is_file(), "计划文件必须落盘");
    assert!(
        staging.join("unpacked").join("pack.json").is_file(),
        "载荷应解在暂存区"
    );
}

#[test]
fn plan_rejects_entries_over_limit() {
    let dir = TestDir::new("plan-entries");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-limit");
    let archive = make_pack(
        &dir,
        "demo.limit",
        &[("data", "a.txt", b"a"), ("data", "b.txt", b"bb")],
    );
    let limits = crate::archive_guard::StagingLimits {
        max_entries: 1,
        max_depth: 12,
        max_unpacked_bytes: 1024,
    };
    let err = content::plan(&host, "inst-limit", &archive.to_string_lossy(), Some(limits))
        .expect_err("超限必须拒");
    assert_eq!(err.code, ErrorCode::ArchiveLimit.as_str(), "{}", err.message);
}

#[test]
fn plan_rejects_bytes_over_limit() {
    let dir = TestDir::new("plan-bytes");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-bytes");
    let archive = make_pack(&dir, "demo.bytes", &[("data", "big.txt", b"0123456789")]);
    let limits = crate::archive_guard::StagingLimits {
        max_entries: 100,
        max_depth: 12,
        max_unpacked_bytes: 4,
    };
    let err = content::plan(&host, "inst-bytes", &archive.to_string_lossy(), Some(limits))
        .expect_err("超字节必须拒");
    assert_eq!(err.code, ErrorCode::ArchiveLimit.as_str(), "{}", err.message);
}

#[test]
fn plan_rejects_manifest_path_escape() {
    let dir = TestDir::new("plan-escape");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-escape");
    let manifest_entries = vec![json!({
        "rootId": "data",
        "path": "../evil.txt",
        "sha256": trust::sha256_bytes(b"x"),
        "size": 1
    })];
    let archive = make_pack_with(&dir, "demo.escape", manifest_entries, &[]);
    let err = content::plan(&host, "inst-escape", &archive.to_string_lossy(), None)
        .expect_err("越界路径必须拒");
    assert_eq!(err.code, ErrorCode::PathEscape.as_str(), "{}", err.message);
}

#[test]
fn plan_reports_base_file_conflict_and_apply_needs_decision() {
    let dir = TestDir::new("plan-base");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-base");
    std::fs::create_dir_all(game.join("data")).expect("目录");
    std::fs::write(game.join("data").join("a.txt"), b"base").expect("基础文件");

    let archive = make_pack(&dir, "demo.base", &[("data", "a.txt", b"pack")]);
    let plan = content::plan(&host, "inst-base", &archive.to_string_lossy(), None).expect("预检");
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].kind, "base-file");
    assert!(plan.additions.is_empty());

    let err = content::apply(&host, &plan.plan_id, None).expect_err("未决议必须拒");
    assert_eq!(err.code, ErrorCode::ContentConflict.as_str(), "{}", err.message);
    // 拒绝之后什么都没写
    assert_eq!(
        std::fs::read(game.join("data").join("a.txt")).expect("基础文件还在"),
        b"base"
    );
}

/* ------------------------------- 应用 ------------------------------- */

#[test]
fn apply_writes_files_ownership_and_state() {
    let dir = TestDir::new("apply-ok");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-apply");
    let archive = make_pack(
        &dir,
        "demo.apply",
        &[("data", "a.txt", b"hello"), ("data", "nested/b.bin", b"\x00\x01")],
    );
    let plan = content::plan(&host, "inst-apply", &archive.to_string_lossy(), None).expect("预检");
    let task = apply_ok(&host, &plan.plan_id, None);
    assert_eq!(task.state, "succeeded");

    assert_eq!(
        std::fs::read(game.join("data").join("a.txt")).expect("落盘"),
        b"hello"
    );
    assert_eq!(
        std::fs::read(game.join("data").join("nested").join("b.bin")).expect("落盘"),
        b"\x00\x01"
    );
    let ownership = store::read_json::<content::OwnershipDoc>(
        &host
            .layout
            .pack_dir("inst-apply", "demo.apply")
            .expect("包目录")
            .join("ownership.json"),
        "ownership",
    )
    .expect("读 ownership")
    .expect("ownership 必须存在");
    assert_eq!(ownership.files.len(), 2);
    assert_eq!(ownership.files[0].root_id, "data");
    assert_eq!(ownership.files[0].path, "a.txt");
    assert_eq!(ownership.files[0].sha256, trust::sha256_bytes(b"hello"));
    assert!(!ownership.files[0].written_at.is_empty(), "要记写入时刻");

    // 暂存被消费掉
    assert!(!host
        .layout
        .staging_plan_dir("inst-apply", &plan.plan_id)
        .expect("暂存")
        .exists());
}

#[test]
fn apply_rejects_expired_plan() {
    let dir = TestDir::new("apply-expired");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-exp");
    let archive = make_pack(&dir, "demo.exp", &[("data", "a.txt", b"hello")]);
    let plan = content::plan(&host, "inst-exp", &archive.to_string_lossy(), None).expect("预检");

    // 把计划的过期时刻改到过去（模拟"用户确认拖了很久"）
    let path = host
        .layout
        .staging_plan_dir("inst-exp", &plan.plan_id)
        .expect("暂存")
        .join("plan.json");
    let mut stored: Value =
        serde_json::from_slice(&std::fs::read(&path).expect("读计划")).expect("解析");
    stored["expiresAt"] = json!("2020-01-01T00:00:00Z");
    std::fs::write(&path, serde_json::to_vec_pretty(&stored).expect("写")).expect("写计划");

    let err = content::apply(&host, &plan.plan_id, None).expect_err("过期必须拒");
    assert_eq!(err.code, ErrorCode::Internal.as_str(), "{}", err.message);
    assert!(!game.join("data").join("a.txt").exists());
}

#[test]
fn apply_is_single_flight_per_instance() {
    let dir = TestDir::new("apply-busy");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-busy");
    let archive = make_pack(&dir, "demo.busy", &[("data", "a.txt", b"x")]);
    let plan = content::plan(&host, "inst-busy", &archive.to_string_lossy(), None).expect("预检");

    let hold = content::flight_enter("content:inst-busy", "占位", "测试".to_string()).expect("占位");
    let err = content::apply(&host, &plan.plan_id, None).expect_err("并发必须拒");
    assert_eq!(err.code, ErrorCode::TaskBusy.as_str(), "{}", err.message);
    drop(hold);
    apply_ok(&host, &plan.plan_id, None);
}

#[test]
fn cancelled_apply_leaves_no_ownership_and_no_files() {
    let dir = TestDir::new("apply-cancel");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-cancel");
    let archive = make_pack(
        &dir,
        "demo.cancel",
        &[("data", "a.txt", b"x"), ("data", "b.txt", b"y")],
    );
    let plan = content::plan(&host, "inst-cancel", &archive.to_string_lossy(), None).expect("预检");

    let cancel = Arc::new(AtomicBool::new(true));
    let err = content::apply_with(&host, &plan.plan_id, None, Some(cancel))
        .expect_err("取消必须报错");
    assert_eq!(err.code, ErrorCode::TaskCancelled.as_str(), "{}", err.message);
    assert!(!game.join("data").join("a.txt").exists(), "取消后不许留文件");
    assert!(!game.join("data").join("b.txt").exists());
    assert!(
        !host
            .layout
            .pack_dir("inst-cancel", "demo.cancel")
            .expect("包目录")
            .join("ownership.json")
            .exists(),
        "取消后 ownership 不许落盘"
    );
    assert!(
        !host
            .layout
            .staging_plan_dir("inst-cancel", &plan.plan_id)
            .expect("暂存")
            .exists(),
        "取消后暂存要收干净"
    );
}

#[test]
fn failed_apply_rolls_back_earlier_files() {
    let dir = TestDir::new("apply-rollback");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-rb");
    // `data/b` 是个**文件**：写 `data/b/c.txt` 时父目录建不出来 ⇒ 第二个文件失败
    std::fs::create_dir_all(game.join("data")).expect("目录");
    std::fs::write(game.join("data").join("b"), b"i am a file").expect("占位文件");
    let archive = make_pack(
        &dir,
        "demo.rb",
        &[("data", "a.txt", b"first"), ("data", "b/c.txt", b"second")],
    );
    let plan = content::plan(&host, "inst-rb", &archive.to_string_lossy(), None).expect("预检");
    let err = content::apply(&host, &plan.plan_id, None).expect_err("必须失败");
    assert_eq!(err.code, ErrorCode::Internal.as_str(), "{}", err.message);
    assert!(
        !game.join("data").join("a.txt").exists(),
        "先写的文件必须被逆序撤回"
    );
    assert_eq!(
        std::fs::read(game.join("data").join("b")).expect("占位文件还在"),
        b"i am a file"
    );
    assert!(!host
        .layout
        .pack_dir("inst-rb", "demo.rb")
        .expect("包目录")
        .join("ownership.json")
        .exists());
    // 回滚台账也要收干净：包目录与当次快照都不该留下空壳
    assert!(
        !host
            .layout
            .pack_dir("inst-rb", "demo.rb")
            .expect("包目录")
            .exists(),
        "首装失败后包目录要删掉"
    );
    let backup_root = host
        .layout
        .pack_backups_dir("inst-rb", "demo.rb")
        .expect("包备份目录");
    let leftovers: Vec<std::path::PathBuf> = std::fs::read_dir(&backup_root)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "当次快照要走回收干净：{leftovers:?}");
}

#[test]
fn original_snapshot_is_never_overwritten_by_upgrade() {
    let dir = TestDir::new("apply-original");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-up");
    std::fs::create_dir_all(game.join("data")).expect("目录");
    std::fs::write(game.join("data").join("a.txt"), b"v0-base").expect("基础文件");

    let v1 = make_pack(&dir, "demo.up", &[("data", "a.txt", b"v1")]);
    let plan = content::plan(&host, "inst-up", &v1.to_string_lossy(), None).expect("预检 v1");
    assert_eq!(plan.conflicts.len(), 1, "首装是 base-file 冲突");
    apply_ok(
        &host,
        &plan.plan_id,
        Some(vec![ResolutionDto {
            root_id: "data".to_string(),
            path: "a.txt".to_string(),
            action: "overwrite".to_string(),
        }]),
    );
    let original = host
        .layout
        .pack_backups_dir("inst-up", "demo.up")
        .expect("包备份目录")
        .join(paths::ORIGINAL_SNAPSHOT_DIR)
        .join("data")
        .join("a.txt");
    assert_eq!(std::fs::read(&original).expect("原始快照"), b"v0-base");

    // 升级：同一个包 id，新内容
    let v2 = make_pack_named(&dir, "demo.up-2.zip", "demo.up", &[("data", "a.txt", b"v2")]);
    let plan2 = content::plan(&host, "inst-up", &v2.to_string_lossy(), None).expect("预检 v2");
    assert!(plan2.conflicts.is_empty(), "升级自己的文件不算冲突");
    assert_eq!(plan2.overwrites.len(), 1);
    apply_ok(&host, &plan2.plan_id, None);

    assert_eq!(
        std::fs::read(&original).expect("原始快照仍在"),
        b"v0-base",
        "升级不得覆盖 original/"
    );
    assert_eq!(
        std::fs::read(game.join("data").join("a.txt")).expect("升级后内容"),
        b"v2"
    );
    // 当次快照（每次操作一份，按时间戳排序）：最后一次里应是升级前的内容（不是原始内容）
    let mut ops: Vec<PathBuf> = std::fs::read_dir(
        host.layout
            .pack_backups_dir("inst-up", "demo.up")
            .expect("包备份目录"),
    )
    .expect("列目录")
    .flatten()
    .map(|entry| entry.path())
    .filter(|path| path.is_dir() && path.file_name() != Some(std::ffi::OsStr::new("original")))
    .collect();
    ops.sort();
    assert_eq!(ops.len(), 2, "首装 + 升级各一份当次快照");
    assert_eq!(
        std::fs::read(ops[1].join("data").join("a.txt")).expect("当次快照"),
        b"v1"
    );
}

/// 同 id、不同 ZIP 文件名（同一个包的第二版）。
fn make_pack_named(dir: &TestDir, zip_name: &str, pack_id: &str, files: &[(&str, &str, &[u8])]) -> PathBuf {
    let manifest_entries: Vec<Value> = files
        .iter()
        .map(|(root, path, bytes)| {
            json!({
                "rootId": root,
                "path": path,
                "sha256": trust::sha256_bytes(bytes),
                "size": bytes.len() as u64,
            })
        })
        .collect();
    let payload: Vec<(String, Vec<u8>)> = files
        .iter()
        .map(|(root, path, bytes)| (format!("{root}/{path}"), bytes.to_vec()))
        .collect();
    let manifest = json!({
        "schemaVersion": 1,
        "id": pack_id,
        "name": format!("测试包 {pack_id}"),
        "version": "1.0.0",
        "kind": "script",
        "gameId": "test-game",
        "files": manifest_entries,
        "loadOrder": 0,
    });
    let mut entries: Vec<(String, Vec<u8>)> = vec![(
        "pack.json".to_string(),
        serde_json::to_vec_pretty(&manifest).expect("清单序列化"),
    )];
    entries.extend(payload);
    let path = dir.join(zip_name);
    write_zip(&path, &entries);
    path
}

#[test]
fn same_path_in_two_packs_is_other_pack_conflict() {
    let dir = TestDir::new("apply-shared-path");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-two");
    let a = make_pack(&dir, "pack.a", &[("data", "same.txt", b"from-a")]);
    let plan_a = content::plan(&host, "inst-two", &a.to_string_lossy(), None).expect("预检 A");
    apply_ok(&host, &plan_a.plan_id, None);

    let b = make_pack(&dir, "pack.b", &[("data", "same.txt", b"from-b")]);
    let plan_b = content::plan(&host, "inst-two", &b.to_string_lossy(), None).expect("预检 B");
    assert_eq!(plan_b.conflicts.len(), 1);
    assert_eq!(plan_b.conflicts[0].kind, "other-pack");
    assert_eq!(
        plan_b.conflicts[0].existing_pack_id.as_deref(),
        Some("pack.a")
    );

    // skip：A 的文件不许被碰
    apply_ok(
        &host,
        &plan_b.plan_id,
        Some(vec![ResolutionDto {
            root_id: "data".to_string(),
            path: "same.txt".to_string(),
            action: "skip".to_string(),
        }]),
    );
    assert_eq!(
        std::fs::read(game.join("data").join("same.txt")).expect("A 的文件"),
        b"from-a"
    );
    let ownership_b = store::read_json::<content::OwnershipDoc>(
        &host
            .layout
            .pack_dir("inst-two", "pack.b")
            .expect("B 目录")
            .join("ownership.json"),
        "ownership",
    )
    .expect("读")
    .expect("B 的 ownership");
    assert!(ownership_b.files.is_empty(), "skip 的文件不归 B");
}

#[test]
fn replace_transfers_ownership_from_other_pack() {
    let dir = TestDir::new("apply-replace");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-replace");
    let a = make_pack(&dir, "pack.a", &[("data", "same.txt", b"from-a")]);
    let plan_a = content::plan(&host, "inst-replace", &a.to_string_lossy(), None).expect("A");
    apply_ok(&host, &plan_a.plan_id, None);

    let b = make_pack(&dir, "pack.b", &[("data", "same.txt", b"from-b")]);
    let plan_b = content::plan(&host, "inst-replace", &b.to_string_lossy(), None).expect("B");
    apply_ok(
        &host,
        &plan_b.plan_id,
        Some(vec![ResolutionDto {
            root_id: "data".to_string(),
            path: "same.txt".to_string(),
            action: "replace".to_string(),
        }]),
    );
    let ownership_a = store::read_json::<content::OwnershipDoc>(
        &host
            .layout
            .pack_dir("inst-replace", "pack.a")
            .expect("A 目录")
            .join("ownership.json"),
        "ownership",
    )
    .expect("读")
    .expect("A 的 ownership");
    assert!(ownership_a.files.is_empty(), "归属已转移，A 不该再声明这条");
    let ownership_b = store::read_json::<content::OwnershipDoc>(
        &host
            .layout
            .pack_dir("inst-replace", "pack.b")
            .expect("B 目录")
            .join("ownership.json"),
        "ownership",
    )
    .expect("读")
    .expect("B 的 ownership");
    assert_eq!(ownership_b.files.len(), 1);

    // 现在卸载 A 不许删掉 B 的文件
    content::uninstall(&host, "inst-replace", "pack.a", None).expect("卸载 A");
    assert!(
        host.layout
            .game_dir("inst-replace")
            .expect("游戏目录")
            .join("data")
            .join("same.txt")
            .is_file(),
        "文件已归 B，卸载 A 不许删"
    );
}

/* ------------------------------- 卸载 / 启停 ------------------------------- */

#[test]
fn uninstall_restores_base_file_and_keeps_other_packs() {
    let dir = TestDir::new("uninstall");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-un");
    std::fs::create_dir_all(game.join("data")).expect("目录");
    std::fs::write(game.join("data").join("base.txt"), b"original-base").expect("基础文件");
    std::fs::write(game.join("data").join("keep.txt"), b"other-pack").expect("别的包的文件");
    // 让 keep.txt 归 pack.b
    let b = make_pack_named(&dir, "b.zip", "pack.b", &[("data", "keep.txt", b"other-pack")]);
    let plan_b = content::plan(&host, "inst-un", &b.to_string_lossy(), None).expect("B");
    apply_ok(
        &host,
        &plan_b.plan_id,
        Some(vec![ResolutionDto {
            root_id: "data".to_string(),
            path: "keep.txt".to_string(),
            action: "overwrite".to_string(),
        }]),
    );

    let a = make_pack(&dir, "pack.a", &[("data", "base.txt", b"pack-content")]);
    let plan_a = content::plan(&host, "inst-un", &a.to_string_lossy(), None).expect("A");
    apply_ok(
        &host,
        &plan_a.plan_id,
        Some(vec![ResolutionDto {
            root_id: "data".to_string(),
            path: "base.txt".to_string(),
            action: "overwrite".to_string(),
        }]),
    );
    assert_eq!(
        std::fs::read(game.join("data").join("base.txt")).expect("被覆盖"),
        b"pack-content"
    );

    content::uninstall(&host, "inst-un", "pack.a", None).expect("卸载 A");
    assert_eq!(
        std::fs::read(game.join("data").join("base.txt")).expect("基础文件"),
        b"original-base",
        "卸载要回到装之前"
    );
    assert_eq!(
        std::fs::read(game.join("data").join("keep.txt")).expect("B 的文件"),
        b"other-pack",
        "别的包的文件不许被碰"
    );
    assert!(
        !host
            .layout
            .pack_dir("inst-un", "pack.a")
            .expect("A 目录")
            .exists(),
        "A 的安装目录要删掉"
    );
    assert!(
        !host
            .layout
            .pack_backups_dir("inst-un", "pack.a")
            .expect("A 备份目录")
            .exists(),
        "A 的快照要清掉（下次重装重新取）"
    );
}

#[test]
fn disable_then_enable_replays_from_payload() {
    let dir = TestDir::new("enable");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-en");
    let archive = make_pack(&dir, "demo.en", &[("data", "a.txt", b"payload-content")]);
    let plan = content::plan(&host, "inst-en", &archive.to_string_lossy(), None).expect("预检");
    apply_ok(&host, &plan.plan_id, None);

    content::set_enabled(&host, "inst-en", "demo.en", false).expect("停用");
    assert!(!game.join("data").join("a.txt").exists(), "停用要撤下文件");
    let listed = content::list(&host, "inst-en").expect("列表");
    assert_eq!(listed.len(), 1);
    assert!(!listed[0].enabled);

    content::set_enabled(&host, "inst-en", "demo.en", true).expect("启用");
    assert_eq!(
        std::fs::read(game.join("data").join("a.txt")).expect("重放"),
        b"payload-content"
    );
    let listed = content::list(&host, "inst-en").expect("列表");
    assert!(listed[0].enabled);
}

#[test]
fn set_order_requires_installed_permutation() {
    let dir = TestDir::new("order");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-order");
    for (pack, file) in [("pack.a", "a.txt"), ("pack.b", "b.txt")] {
        let archive = make_pack_named(&dir, &format!("{pack}.zip"), pack, &[("data", file, b"x")]);
        let plan = content::plan(&host, "inst-order", &archive.to_string_lossy(), None).expect("预检");
        apply_ok(&host, &plan.plan_id, None);
    }

    let err = content::set_order(
        &host,
        "inst-order",
        &["pack.a".to_string(), "pack.zzz".to_string()],
    )
    .expect_err("未安装的 id 必须拒");
    assert_eq!(err.code, ErrorCode::ContentConflict.as_str(), "{}", err.message);

    content::set_order(
        &host,
        "inst-order",
        &["pack.b".to_string(), "pack.a".to_string()],
    )
    .expect("排列合法");
    let listed = content::list(&host, "inst-order").expect("列表");
    let ids: Vec<&str> = listed.iter().map(|pack| pack.manifest.id.as_str()).collect();
    assert_eq!(ids, vec!["pack.b", "pack.a"], "顺序按 set_order 落盘");
}

#[test]
fn diagnose_reports_missing_file_and_hash_mismatch() {
    let dir = TestDir::new("diagnose");
    let host = test_host(dir.path());
    let game = copy_instance(&host, &dir, "inst-diag");
    let archive = make_pack(
        &dir,
        "demo.diag",
        &[("data", "gone.txt", b"x"), ("data", "changed.txt", b"y")],
    );
    let plan = content::plan(&host, "inst-diag", &archive.to_string_lossy(), None).expect("预检");
    apply_ok(&host, &plan.plan_id, None);

    std::fs::remove_file(game.join("data").join("gone.txt")).expect("删");
    std::fs::write(game.join("data").join("changed.txt"), b"tampered").expect("改");

    let report = content::diagnose(&host, "inst-diag").expect("诊断");
    let codes: Vec<&str> = report.issues.iter().map(|issue| issue.code.as_str()).collect();
    assert!(codes.contains(&"missing-file"), "{codes:?}");
    assert!(codes.contains(&"hash-mismatch"), "{codes:?}");
    let listed = content::list(&host, "inst-diag").expect("列表");
    assert_eq!(listed[0].status, "conflict", "坏掉的包要如实标 conflict");
}

/* ------------------------------- shared 实例 ------------------------------- */

#[test]
fn shared_instance_without_approval_is_rejected() {
    let dir = TestDir::new("shared-unapproved");
    let host = test_host(dir.path());
    let game_root = dir.join("game");
    std::fs::create_dir_all(game_root.join("data")).expect("游戏目录");
    content::install_test_instance(
        &host.layout,
        "inst-shared",
        &game_root,
        "shared",
        vec![content_root_json("data", "data")],
    )
    .expect("实例");
    let archive = make_pack(&dir, "demo.shared", &[("data", "a.txt", b"x")]);

    let err = content::plan(&host, "inst-shared", &archive.to_string_lossy(), None)
        .expect_err("未授权必须拒");
    assert_eq!(
        err.code,
        ErrorCode::SourceNotApproved.as_str(),
        "{}",
        err.message
    );
    assert!(!game_root.join("data").join("a.txt").exists());
}

#[test]
fn shared_instance_writes_only_inside_approved_root() {
    let dir = TestDir::new("shared-approved");
    let host = test_host(dir.path());
    let game_root = dir.join("game");
    std::fs::create_dir_all(game_root.join("data")).expect("游戏目录");
    content::install_test_instance(
        &host.layout,
        "inst-shared2",
        &game_root,
        "shared",
        vec![content_root_json("data", "data")],
    )
    .expect("实例");
    store::approve_write_root(
        &host.layout,
        "inst-shared2",
        "data",
        &game_root.join("data"),
        "2026-01-01T00:00:00Z",
    )
    .expect("授权");

    let archive = make_pack(&dir, "demo.shared2", &[("data", "a.txt", b"written")]);
    let plan = content::plan(&host, "inst-shared2", &archive.to_string_lossy(), None).expect("预检");
    apply_ok(&host, &plan.plan_id, None);
    assert_eq!(
        std::fs::read(game_root.join("data").join("a.txt")).expect("写进共享根"),
        b"written"
    );
}

#[test]
fn list_reports_installed_pack_shape() {
    let dir = TestDir::new("list");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-list");
    let archive = make_pack(&dir, "demo.list", &[("data", "a.txt", b"x")]);
    let plan = content::plan(&host, "inst-list", &archive.to_string_lossy(), None).expect("预检");
    apply_ok(&host, &plan.plan_id, None);

    let listed = content::list(&host, "inst-list").expect("列表");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].manifest.id, "demo.list");
    assert_eq!(listed[0].manifest.game_id, "test-game");
    assert!(listed[0].enabled);
    assert_eq!(listed[0].order, 0);
    assert_eq!(listed[0].owned_files.len(), 1);
    assert_eq!(listed[0].owned_files[0].path, "a.txt");
    assert_eq!(listed[0].status, "ok");
}

#[test]
fn plan_rejects_unknown_content_root() {
    let dir = TestDir::new("plan-unknown-root");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-unknown");
    let archive = make_pack(&dir, "demo.unknown", &[("elsewhere", "a.txt", b"x")]);
    let err = content::plan(&host, "inst-unknown", &archive.to_string_lossy(), None)
        .expect_err("未声明的根必须拒");
    assert_eq!(
        err.code,
        ErrorCode::SourceNotApproved.as_str(),
        "{}",
        err.message
    );
}

#[test]
fn plan_rejects_manifest_file_missing_from_archive() {
    let dir = TestDir::new("plan-missing-entry");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-missing");
    let manifest_entries = vec![json!({
        "rootId": "data",
        "path": "a.txt",
        "sha256": trust::sha256_bytes(b"x"),
        "size": 1
    })];
    // 包里只有 pack.json，载荷缺条目
    let archive = make_pack_with(&dir, "demo.missing", manifest_entries, &[]);
    let err = content::plan(&host, "inst-missing", &archive.to_string_lossy(), None)
        .expect_err("清单与包不一致必须拒");
    assert_eq!(err.code, ErrorCode::ArchiveInvalid.as_str(), "{}", err.message);
}

#[test]
fn plan_rejects_tampered_payload() {
    let dir = TestDir::new("plan-tampered");
    let host = test_host(dir.path());
    copy_instance(&host, &dir, "inst-tamper");
    let manifest_entries = vec![json!({
        "rootId": "data",
        "path": "a.txt",
        "sha256": trust::sha256_bytes(b"declared"),
        "size": 8
    })];
    let archive = make_pack_with(
        &dir,
        "demo.tamper",
        manifest_entries,
        &[("data/a.txt".to_string(), b"actual!!".to_vec())],
    );
    let err = content::plan(&host, "inst-tamper", &archive.to_string_lossy(), None)
        .expect_err("哈希不符必须拒");
    assert_eq!(err.code, ErrorCode::ArchiveInvalid.as_str(), "{}", err.message);
}
