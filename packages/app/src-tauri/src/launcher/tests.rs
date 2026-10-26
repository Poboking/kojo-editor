//! 启动器宿主面的判据（`cargo test --lib`）。
//!
//! 进程类用例全部用**测试二进制自我重启**做夹具（手法照 `launcher_probe.rs`，PITFALLS 222）：
//! `current_exe() --exact --ignored launcher::tests::fixture_entry` + 角色环境变量。
//! 不依赖任何外部 exe、不写仓库、不碰游戏目录；临时目录在 `temp_dir()` 下，`TestDir::drop`
//! 先停进程再删目录。

#![cfg(windows)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::error::LauncherResult;
use super::paths::{self, LauncherLayout};
use super::store::{self, StoredExecutable, StoredInstance, StoredLock, StoredTrust};
use super::trust;
use super::{EmitFn, LauncherHost};

const ROLE_ENV: &str = "KOJO_LAUNCHER_ROLE";
const DIR_ENV: &str = "KOJO_LAUNCHER_DIR";
const EXIT_ENV: &str = "KOJO_LAUNCHER_EXIT";
const FIXTURE_NAME: &str = "launcher::tests::fixture_entry";

/* ------------------------------- 夹具 ------------------------------- */

static SEQ: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(tag: &str) -> Self {
        let unique = SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "kojo-launcher-{tag}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("测试临时目录必须能建");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        for _ in 0..10 {
            match std::fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(_) => std::thread::sleep(Duration::from_millis(30)),
            }
        }
    }
}

fn test_host(app_data: &Path) -> (Arc<LauncherHost>, Arc<Mutex<Vec<(String, Value)>>>) {
    let sink: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let writer = sink.clone();
    let emit: EmitFn = Arc::new(move |event: &str, payload: Value| {
        writer.lock().unwrap().push((event.to_string(), payload));
    });
    (LauncherHost::new(app_data, emit), sink)
}

fn wait_until(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    cond()
}

/// 把测试二进制所在目录当"游戏根"：exe 就是测试二进制本身（零拷贝、零外部依赖）。
fn fixture_root() -> PathBuf {
    std::env::current_exe()
        .expect("测试二进制路径必须拿得到")
        .parent()
        .expect("测试二进制必有父目录")
        .to_path_buf()
}

fn fixture_exe_name() -> String {
    std::env::current_exe()
        .expect("current_exe")
        .file_name()
        .expect("file_name")
        .to_string_lossy()
        .to_string()
}

fn fixture_args() -> Vec<String> {
    vec![
        "--exact".to_string(),
        "--ignored".to_string(),
        FIXTURE_NAME.to_string(),
    ]
}

fn fixture_env(role: &str, dir: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    env.insert(ROLE_ENV.to_string(), role.to_string());
    env.insert(DIR_ENV.to_string(), dir.display().to_string());
    env
}

/// 记忆化的"已批准来源根"：同一个 deps 目录会被每个用例重复批准。
fn approve_once(host: &LauncherHost, root: &Path) {
    store::approve_source_root(&host.layout, root, "2026-01-01T00:00:00Z").expect("批准来源根");
}

/// 建一份可启动的实例（shared，exe = 测试二进制），并**直接写信任记录**。
///
/// 生产路径里信任只能由原生对话框产生（`trust::make_trust` 只在 `launcher_trust_executable`
/// 里被调用）；测试没有对话框，只能在这里模拟"用户点了是"。记录形状与生产逐字相同。
fn make_launch_instance(
    host: &Arc<LauncherHost>,
    id: &str,
    role: &str,
    witness: &Path,
) -> LauncherResult<()> {
    host.layout.ensure_root()?;
    let root = fixture_root();
    approve_once(host, &root);
    let mut instance = StoredInstance {
        schema_version: store::INSTANCE_SCHEMA_VERSION,
        id: id.to_string(),
        name: format!("测试实例 {id}"),
        adapter_id: "test-adapter".to_string(),
        game_id: "test-game".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        source_root: Some(root.to_string_lossy().to_string()),
        isolation: "shared".to_string(),
        state: "ready".to_string(),
        executable: StoredExecutable {
            relative_path: fixture_exe_name(),
            args: fixture_args(),
            env: fixture_env(role, witness),
            window_mode: "hidden".to_string(),
            sha256: None,
        },
        runtime_id: None,
        locale: None,
        encoding: None,
        save_roots: Vec::new(),
        content_roots: Vec::new(),
        executable_trust: None,
        launch_count: 0,
        last_launched_at: None,
        last_exit: None,
        notes: None,
        tags: None,
    };
    let game_root = instance.game_root(&host.layout)?;
    let target = super::process::resolve_executable(&instance, &game_root)?;
    let digest = trust::sha256_file(&target)?;
    instance.executable.sha256 = Some(digest.sha256.clone());
    instance.executable_trust = Some(trust::make_trust(&digest, "2026-01-01T00:00:00Z"));
    host.layout.ensure_instance_dirs(id)?;
    store::save_instance(&host.layout, &instance)?;
    let mut registry = store::load_registry(&host.layout)?;
    registry.upsert(instance.registry_entry());
    store::save_registry(&host.layout, &mut registry)?;
    Ok(())
}

/// **夹具入口**：只由测试以子进程身份拉起（`--exact --ignored`），单独跑没有任何断言。
#[test]
#[ignore = "夹具入口：只由测试以 current_exe() + --exact --ignored 拉起，不单独跑"]
fn fixture_entry() {
    let role = std::env::var(ROLE_ENV).unwrap_or_default();
    let dir = PathBuf::from(std::env::var_os(DIR_ENV).expect("夹具必须带见证目录"));
    match role.as_str() {
        "sleep" => {
            std::fs::write(dir.join("child.ready"), std::process::id().to_string()).ok();
            std::thread::sleep(Duration::from_secs(60));
        }
        "emit" => {
            use std::io::Write;
            // 一段可读标记 + 非法 UTF-8 字节：宿主必须逐字节保真
            let mut stdout = std::io::stdout();
            stdout.write_all(b"[launcher-test]hello\n").ok();
            stdout.write_all(&[0xFF, 0xFE, 0x80, b'\n']).ok();
            stdout.flush().ok();
            let mut stderr = std::io::stderr();
            stderr.write_all(b"[launcher-test]err\n").ok();
            stderr.flush().ok();
        }
        "exit-code" => {
            let code: i32 = std::env::var(EXIT_ENV)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3);
            std::process::exit(code);
        }
        "spawn-child" => {
            std::fs::write(dir.join("child.ready"), std::process::id().to_string()).ok();
            let exe = std::env::current_exe().expect("current_exe");
            let mut command = std::process::Command::new(exe);
            command
                .args(fixture_args())
                .env(ROLE_ENV, "sleep")
                .env(DIR_ENV, dir.display().to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let mut grandchild = command.spawn().expect("孙进程必须起得来");
            std::fs::write(dir.join("grandchild.pid"), grandchild.id().to_string()).ok();
            std::thread::sleep(Duration::from_secs(60));
            let _ = grandchild.kill();
        }
        other => panic!("未知夹具角色: {other}"),
    }
}

fn read_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

fn pid_alive(pid: u32) -> bool {
    super::process::process_start_ticks(pid).is_some()
}

/* ------------------------------- 纯判据 ------------------------------- */

#[test]
fn iso_time_matches_known_epoch_and_round_trip() {
    assert_eq!(super::iso_from_unix_ms(0), "1970-01-01T00:00:00Z");
    // 2026-10-26T00:00:00Z = 1792972800 s
    assert_eq!(
        super::iso_from_unix_ms(1_792_972_800_000),
        "2026-10-26T00:00:00Z"
    );
    // 闰日：2024-02-29T12:34:56Z
    assert_eq!(
        super::iso_from_unix_ms(1_709_210_096_000),
        "2024-02-29T12:34:56Z"
    );
}

#[test]
fn relative_paths_reject_every_escape_shape() {
    let ok = |raw: &str| paths::normalize_relative(raw);
    assert_eq!(ok("game.exe").unwrap(), "game.exe");
    assert_eq!(ok("sub/dir/game.exe").unwrap(), "sub/dir/game.exe");
    for bad in [
        "",
        "/abs/game.exe",
        r"\abs\game.exe",
        r"sub\game.exe",
        "C:/game.exe",
        "C:game.exe",
        "../game.exe",
        "sub/../../game.exe",
        "sub/./game.exe",
        "sub//game.exe",
        "sub/game.exe/",
        "file.exe:stream",
        "dir./game.exe",
        "dir /game.exe",
        "CON/game.exe",
        "nul.txt",
        "COM1/x.exe",
    ] {
        assert!(
            ok(bad).is_err(),
            "这个形状必须被拒：{bad:?}（得 {:?}）",
            ok(bad)
        );
    }
}

#[test]
fn layout_paths_are_component_contained() {
    let app = TestDir::new("layout");
    let layout = LauncherLayout::new(app.path());
    let root = layout.instance_root("abc-123").unwrap();
    assert!(paths::path_has_prefix(&layout.instances_dir(), &root));
    assert!(layout.instance_root("../escape").is_err());
    assert!(layout.instance_root("a/b").is_err());
    assert!(layout.instance_root("").is_err());
    assert!(!paths::path_has_prefix(
        Path::new(r"C:\a\b"),
        Path::new(r"C:\a\bc\d.exe")
    ));
    assert!(paths::path_has_prefix(
        Path::new(r"C:\a\b"),
        Path::new(r"C:\A\B\c\d.exe")
    ));
}

#[test]
fn registry_roundtrip_and_fail_closed_on_corruption() {
    let app = TestDir::new("registry");
    let host = test_host(app.path()).0;
    let mut registry = store::load_registry(&host.layout).unwrap();
    assert_eq!(registry.rev, 0);
    registry.upsert(store::RegistryEntry {
        id: "id-1".to_string(),
        name: "一".to_string(),
        adapter_id: "a".to_string(),
        game_id: "g".to_string(),
        isolation: "shared".to_string(),
        state: "ready".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    });
    store::save_registry(&host.layout, &mut registry).unwrap();
    let loaded = store::load_registry(&host.layout).unwrap();
    assert_eq!(loaded.instances.len(), 1);
    assert_eq!(loaded.rev, 1);

    // 半份 JSON ⇒ fail-closed（不是"当成空表"）
    std::fs::write(host.layout.registry_file(), b"{ this is not json").unwrap();
    let err = store::load_registry(&host.layout).unwrap_err();
    assert_eq!(err.code, "LAUNCHER_INTERNAL");
}

#[test]
fn stale_lock_uses_pid_and_start_time() {
    let _dir = TestDir::new("lock");
    let pid = std::process::id();
    let ticks = super::process::process_start_ticks(pid).expect("本进程创建时间必须拿得到");
    let live = StoredLock {
        schema_version: store::SCHEMA_VERSION,
        instance_id: "id-1".to_string(),
        pid,
        session_id: "s-1".to_string(),
        started_at: "2026-01-01T00:00:00Z".to_string(),
        process_start_ticks: Some(ticks),
        written_at: "2026-01-01T00:00:00Z".to_string(),
    };
    assert!(!store::lock_is_stale(&live));

    // 同一 pid、创建时间不符 ⇒ pid 复用 ⇒ 陈旧
    let mut reused = live.clone();
    reused.process_start_ticks = Some(ticks ^ 0xFFFF);
    assert!(store::lock_is_stale(&reused));

    // 已消失的 pid ⇒ 陈旧
    let mut dead = live.clone();
    dead.pid = 0xFFFF_FFF0;
    dead.process_start_ticks = None;
    assert!(store::lock_is_stale(&dead));
}

#[test]
fn approvals_are_granular_and_persisted() {
    let app = TestDir::new("approvals");
    let host = test_host(app.path()).0;
    host.layout.ensure_root().unwrap();
    let source = TestDir::new("approvals-src");
    store::approve_source_root(&host.layout, source.path(), "2026-01-01T00:00:00Z").unwrap();
    assert!(store::is_source_approved(&host.layout, source.path()).unwrap());
    let other = TestDir::new("approvals-other");
    assert!(!store::is_source_approved(&host.layout, other.path()).unwrap());

    store::approve_write_root(
        &host.layout,
        "id-1",
        "saves",
        source.path(),
        "2026-01-01T00:00:00Z",
    )
    .unwrap();
    assert_eq!(
        store::approved_write_root(&host.layout, "id-1", "saves").unwrap(),
        Some(source.path().to_path_buf())
    );
    // 粒度是「实例 × rootId」：换一个 id 就不认
    assert_eq!(
        store::approved_write_root(&host.layout, "id-2", "saves").unwrap(),
        None
    );
    assert_eq!(
        store::approved_write_root(&host.layout, "id-1", "content").unwrap(),
        None
    );
}

#[test]
fn log_page_marks_truncation_and_keeps_raw_bytes() {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    let app = TestDir::new("logpage");
    let host = test_host(app.path()).0;
    host.layout.ensure_instance_dirs("id-log").unwrap();
    super::logs::begin_session(&host.layout, "id-log", "sess-1", "2026-01-01T00:00:00Z").unwrap();
    let path = host
        .layout
        .logs_dir("id-log")
        .unwrap()
        .join("sess-1.stdout.log");
    std::fs::write(&path, [b'a', b'b', 0xFF, b'c', b'd']).unwrap();

    let page = super::logs::tail(
        &host.layout,
        "id-log",
        &super::logs::LogQuery {
            max_bytes: Some(3),
            stream: Some("stdout".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(page.truncated, "超过 maxBytes 必须标截断");
    assert_eq!(page.chunks.len(), 1);
    let chunk = &page.chunks[0];
    assert_eq!(chunk.stream, "stdout");
    let bytes = B64.decode(&chunk.bytes_base64).unwrap();
    assert_eq!(bytes, vec![0xFF, b'c', b'd'], "只回尾部且逐字节保真");
    assert!(chunk.truncated);
}

#[test]
fn log_export_bytes_carry_streams_and_hide_absolute_paths() {
    let app = TestDir::new("export");
    let host = test_host(app.path()).0;
    host.layout.ensure_instance_dirs("id-export").unwrap();
    super::logs::begin_session(&host.layout, "id-export", "sess-9", "2026-01-01T00:00:00Z")
        .unwrap();
    let logs_dir = host.layout.logs_dir("id-export").unwrap();
    std::fs::write(logs_dir.join("sess-9.stdout.log"), b"out\xff").unwrap();
    std::fs::write(logs_dir.join("sess-9.stderr.log"), b"err").unwrap();
    super::logs::finish_session(
        &host.layout,
        "id-export",
        "sess-9",
        "2026-01-01T00:01:00Z",
        Some(0),
        4,
        3,
    )
    .unwrap();

    let mut instance = store::StoredInstance {
        schema_version: store::INSTANCE_SCHEMA_VERSION,
        id: "id-export".to_string(),
        name: "导出".to_string(),
        adapter_id: "a".to_string(),
        game_id: "g".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
        source_root: Some(app.path().to_string_lossy().to_string()),
        isolation: "shared".to_string(),
        state: "ready".to_string(),
        executable: StoredExecutable::default(),
        runtime_id: None,
        locale: None,
        encoding: None,
        save_roots: Vec::new(),
        content_roots: Vec::new(),
        executable_trust: None,
        launch_count: 0,
        last_launched_at: None,
        last_exit: None,
        notes: None,
        tags: None,
    };
    instance.executable.relative_path = "game.exe".to_string();

    let (suggested, bytes) =
        super::logs::export_bytes(&host.layout, &instance, None, true).unwrap();
    assert!(suggested.ends_with(".log"));
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("--- stdout ---") && text.contains("--- stderr ---"));
    assert!(text.contains("out") && text.contains("err"));
    assert!(text.contains("--- diagnostics ---"));
    assert!(
        !text.contains(&app.path().to_string_lossy().to_string()),
        "导出内容不许带绝对路径"
    );
    assert!(bytes.windows(4).any(|window| window == b"out\xff"));
}

#[test]
fn trust_change_is_detected_by_hash() {
    let app = TestDir::new("trust");
    let host = test_host(app.path()).0;
    host.layout.ensure_instance_dirs("id-trust").unwrap();
    let file = app.join("program.exe");
    std::fs::write(&file, b"first").unwrap();
    let digest = trust::sha256_file(&file).unwrap();
    let record = trust::make_trust(&digest, "2026-01-01T00:00:00Z");
    assert_eq!(record.approved_by, "native-dialog");
    trust::verify_trust(Some(&record), &digest).unwrap();

    std::fs::write(&file, b"second").unwrap();
    let changed = trust::sha256_file(&file).unwrap();
    let err = trust::verify_trust(Some(&record), &changed).unwrap_err();
    assert_eq!(err.code, "LAUNCHER_TRUST_CHANGED");
    let required = trust::verify_trust(None, &changed).unwrap_err();
    assert_eq!(required.code, "LAUNCHER_TRUST_REQUIRED");
}

#[test]
fn command_surface_never_takes_a_target_path() {
    for name in super::commands::COMMAND_NAMES {
        assert!(name.starts_with("launcher_"), "{name}");
        for forbidden in ["_path", "spawn", "start_path", "exec_path"] {
            assert!(
                !name.contains(forbidden),
                "命令名里不许出现 {forbidden}：{name}"
            );
        }
    }
    // 注册表必须把上面每一条都登记进 invoke_handler（少一条就红）
    let lib_rs = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("lib.rs"),
    )
    .expect("读 lib.rs");
    for name in super::commands::COMMAND_NAMES {
        assert!(
            lib_rs.contains(&format!("launcher::commands::{name}")),
            "lib.rs 的 invoke_handler 漏了 {name}"
        );
    }
}

/* ------------------------------- 进程 ------------------------------- */

#[test]
fn start_stop_lifecycle_clears_lock_and_marks_user_stop() {
    let app = TestDir::new("lifecycle");
    let witness = TestDir::new("lifecycle-witness");
    let (host, events) = test_host(app.path());
    make_launch_instance(&host, "id-life", "sleep", witness.path()).unwrap();
    // 上次异常退出留下的陈旧锁（pid 已不存在）必须被就地清掉，而不是拦住本次启动
    store::write_lock(
        &host.layout,
        &StoredLock {
            schema_version: store::SCHEMA_VERSION,
            instance_id: "id-life".to_string(),
            pid: 0xFFFF_FFF0,
            session_id: "stale-session".to_string(),
            started_at: "2026-01-01T00:00:00Z".to_string(),
            process_start_ticks: None,
            written_at: "2026-01-01T00:00:00Z".to_string(),
        },
    )
    .unwrap();

    let status = super::process::start_blocking(&host, "id-life").unwrap();
    assert_eq!(status.state, "running");
    let pid = status.pid.expect("running 必须给 pid");
    assert!(pid_alive(pid));
    let session_id = status.session_id.clone().expect("running 必须有 sessionId");
    assert!(wait_until(
        || witness.join("child.ready").exists(),
        Duration::from_secs(10)
    ));
    assert!(
        store::read_lock(&host.layout, "id-life").unwrap().is_some(),
        "运行中必须有 running.lock"
    );

    // 日志会话文件三件齐
    let logs_dir = host.layout.logs_dir("id-life").unwrap();
    for suffix in ["stdout.log", "stderr.log", "json"] {
        assert!(
            logs_dir.join(format!("{session_id}.{suffix}")).exists(),
            "缺 {session_id}.{suffix}"
        );
    }
    // 每实例单进程：第二发 start 必须是 INSTANCE_BUSY（不是再拉一个）
    let busy = super::process::start_blocking(&host, "id-life").unwrap_err();
    assert_eq!(busy.code, "LAUNCHER_INSTANCE_BUSY");

    let stopped = super::process::stop_blocking(&host, "id-life", false, Some(10_000)).unwrap();
    assert!(
        matches!(stopped.state.as_str(), "exited" | "crashed"),
        "停完应是终态，得 {}",
        stopped.state
    );
    assert_eq!(stopped.exit_reason.as_deref(), Some("user"));
    assert!(wait_until(|| !pid_alive(pid), Duration::from_secs(5)));
    assert!(
        store::read_lock(&host.layout, "id-life").unwrap().is_none(),
        "退出后 running.lock 必须清掉"
    );

    // 退出记录落进清单
    let instance = store::load_instance(&host.layout, "id-life").unwrap();
    assert_eq!(instance.launch_count, 1);
    assert_eq!(
        instance.last_exit.as_ref().map(|exit| exit.reason.as_str()),
        Some("user")
    );

    // 事件序号严格递增
    let sink = events.lock().unwrap();
    let seqs: Vec<u64> = sink
        .iter()
        .filter_map(|(event, payload)| {
            if event.starts_with("kojo:launcher-") {
                payload.get("seq").and_then(Value::as_u64)
            } else {
                None
            }
        })
        .collect();
    assert!(seqs.len() >= 3, "至少要有 starting / running / 终态三条");
    assert!(
        seqs.windows(2).all(|pair| pair[1] > pair[0]),
        "seq 必须严格递增：{seqs:?}"
    );
}

#[test]
fn log_pump_keeps_non_utf8_bytes_and_session_totals() {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;

    let app = TestDir::new("logs");
    let witness = TestDir::new("logs-witness");
    let (host, events) = test_host(app.path());
    make_launch_instance(&host, "id-log", "emit", witness.path()).unwrap();

    let started = super::process::start_blocking(&host, "id-log").unwrap();
    let session_id = started.session_id.clone().unwrap();
    assert!(wait_until(
        || {
            let status = super::process::status(&host, "id-log");
            status.state == "exited" || status.state == "crashed"
        },
        Duration::from_secs(20)
    ));

    let page = super::logs::read(
        &host.layout,
        &session_id,
        &super::logs::LogQuery {
            stream: Some("stdout".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(page.chunks.len(), 1);
    let bytes = B64.decode(&page.chunks[0].bytes_base64).unwrap();
    assert!(
        bytes
            .windows(20)
            .any(|window| window == b"[launcher-test]hello"),
        "stdout 必须带上夹具标记"
    );
    assert!(
        bytes
            .windows(4)
            .any(|window| window == [0xFF, 0xFE, 0x80, b'\n']),
        "非法 UTF-8 字节必须逐字节保真"
    );

    // 事件通道同样只送原始字节（base64），宿主不解码
    let sink = events.lock().unwrap();
    let log_events: Vec<&Value> = sink
        .iter()
        .filter(|(event, _)| event == super::EVENT_LOG)
        .map(|(_, payload)| payload)
        .collect();
    assert!(!log_events.is_empty(), "日志泵必须发 kojo:launcher-log");
    assert!(
        log_events
            .iter()
            .all(|payload| payload.get("bytesBase64").and_then(Value::as_str).is_some()),
        "日志事件载荷必须是 bytesBase64 而不是已解码文本"
    );
    let emitted: Vec<u8> = log_events
        .iter()
        .filter(|payload| payload["sessionId"] == session_id.as_str())
        .filter_map(|payload| payload["bytesBase64"].as_str())
        .flat_map(|text| B64.decode(text).unwrap())
        .collect();
    assert!(
        emitted
            .windows(20)
            .any(|window| window == b"[launcher-test]hello"),
        "事件流里也要能拼回同一段字节"
    );
    drop(sink);

    let sessions = super::logs::sessions(&host.layout, "id-log").unwrap();
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].ended_at.is_some(), "会话收尾必须写 endedAt");
    assert_eq!(sessions[0].exit_code, Some(0));
    assert!(sessions[0].stdout_bytes > 20);
}

#[test]
fn trust_required_and_changed_block_start() {
    let app = TestDir::new("trustgate");
    let witness = TestDir::new("trustgate-witness");
    let (host, _events) = test_host(app.path());
    make_launch_instance(&host, "id-gate", "emit", witness.path()).unwrap();

    // 抹掉信任记录 ⇒ 启动被拦
    {
        let mut instance = store::load_instance(&host.layout, "id-gate").unwrap();
        instance.executable_trust = None;
        store::save_instance(&host.layout, &instance).unwrap();
    }
    let err = super::process::start_blocking(&host, "id-gate").unwrap_err();
    assert_eq!(err.code, "LAUNCHER_TRUST_REQUIRED");

    // 复算后写进一份"错哈希"的信任 ⇒ TRUST_CHANGED
    {
        let mut instance = store::load_instance(&host.layout, "id-gate").unwrap();
        instance.executable_trust = Some(StoredTrust {
            sha256: "0".repeat(64),
            size: 1,
            approved_at: "2026-01-01T00:00:00Z".to_string(),
            approved_by: "native-dialog".to_string(),
        });
        store::save_instance(&host.layout, &instance).unwrap();
    }
    let err = super::process::start_blocking(&host, "id-gate").unwrap_err();
    assert_eq!(err.code, "LAUNCHER_TRUST_CHANGED");
}

#[test]
fn bad_executable_paths_are_rejected_before_spawn() {
    let app = TestDir::new("execheck");
    let witness = TestDir::new("execheck-witness");
    let (host, _events) = test_host(app.path());
    make_launch_instance(&host, "id-exe", "sleep", witness.path()).unwrap();

    for (relative, expected) in [
        ("../evil.exe", "LAUNCHER_PATH_ESCAPE"),
        ("C:/Windows/system32/cmd.exe", "LAUNCHER_PATH_ESCAPE"),
        ("run.bat", "LAUNCHER_EXECUTABLE_INVALID"),
        ("missing.exe", "LAUNCHER_EXECUTABLE_INVALID"),
    ] {
        let mut instance = store::load_instance(&host.layout, "id-exe").unwrap();
        instance.executable.relative_path = relative.to_string();
        store::save_instance(&host.layout, &instance).unwrap();
        let err = super::process::start_blocking(&host, "id-exe").unwrap_err();
        assert_eq!(err.code, expected, "relativePath={relative}");
    }
}

#[test]
fn stop_kills_the_whole_tree() {
    let app = TestDir::new("tree");
    let witness = TestDir::new("tree-witness");
    let (host, _events) = test_host(app.path());
    make_launch_instance(&host, "id-tree", "spawn-child", witness.path()).unwrap();

    let status = super::process::start_blocking(&host, "id-tree").unwrap();
    let parent = status.pid.expect("pid");
    assert!(
        wait_until(
            || read_pid(&witness.join("grandchild.pid")).is_some(),
            Duration::from_secs(20)
        ),
        "孙进程必须在时限内报到"
    );
    let grandchild = read_pid(&witness.join("grandchild.pid")).unwrap();
    assert!(pid_alive(grandchild), "孙进程应活着");

    super::process::stop_blocking(&host, "id-tree", true, Some(10_000)).unwrap();
    assert!(wait_until(|| !pid_alive(parent), Duration::from_secs(5)));
    assert!(
        wait_until(|| !pid_alive(grandchild), Duration::from_secs(5)),
        "Job 收尸必须连孙进程一起（pid={grandchild} 仍活着）"
    );
}

#[test]
fn crash_exit_code_is_classified_as_crashed() {
    let app = TestDir::new("crash");
    let witness = TestDir::new("crash-witness");
    let (host, _events) = test_host(app.path());
    make_launch_instance(&host, "id-crash", "exit-code", witness.path()).unwrap();
    // 夹具从 env 读退出码：改清单里的 env
    {
        let mut instance = store::load_instance(&host.layout, "id-crash").unwrap();
        instance
            .executable
            .env
            .insert(EXIT_ENV.to_string(), "3".to_string());
        store::save_instance(&host.layout, &instance).unwrap();
    }

    let status = super::process::start_blocking(&host, "id-crash").unwrap();
    // 极短的进程可能在 start 返回前就已经退出：两种读数都合法
    assert!(matches!(
        status.state.as_str(),
        "running" | "exited" | "crashed"
    ));
    assert!(wait_until(
        || super::process::status(&host, "id-crash").state == "crashed",
        Duration::from_secs(20)
    ));
    let final_status = super::process::status(&host, "id-crash");
    assert_eq!(final_status.exit_code, Some(3));
    assert_eq!(final_status.exit_reason.as_deref(), Some("crash"));
    assert!(final_status.last_error.is_some(), "崩溃必须带人话解释");
}

/* ------------------------------- 实例复制 ------------------------------- */

#[test]
fn remove_instance_deletes_files_then_drops_registry_entry() {
    let app = TestDir::new("remove-app");
    let source = TestDir::new("remove-src");
    let (host, events) = test_host(app.path());
    host.layout.ensure_root().unwrap();
    std::fs::write(source.join("game.exe"), b"fake-exe").unwrap();
    approve_once(&host, source.path());

    let request = super::commands::CreateInstanceRequest {
        name: "待删实例".to_string(),
        source_root: source.path().to_string_lossy().to_string(),
        adapter_id: "test-adapter".to_string(),
        game_id: "test-game".to_string(),
        candidate_id: "c1".to_string(),
        isolation: "shared".to_string(),
        include_saves: false,
        runtime_id: None,
        locale: None,
        encoding: None,
        notes: None,
    };
    let profile = super::commands::LaunchProfileDto {
        candidate_id: "c1".to_string(),
        executable: super::commands::ExecutableInputDto {
            relative_path: "game.exe".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            window_mode: "auto".to_string(),
        },
        cwd_relative: ".".to_string(),
        runtime: None,
        locale: None,
        encoding: None,
        save_roots: Vec::new(),
        content_roots: Vec::new(),
        warnings: Vec::new(),
    };
    let creation = super::commands::create_instance(&host, request, profile).unwrap();
    let id = creation.instance.instance.id.clone();
    assert!(creation.task.is_none(), "shared 实例不产生复制任务");
    let root = host.layout.instance_root(&id).unwrap();
    assert!(root.is_dir());

    super::commands::remove_instance(&host, &id, true, false).unwrap();
    assert!(!root.exists(), "实例目录必须删掉");
    assert!(
        store::load_registry(&host.layout)
            .unwrap()
            .instances
            .is_empty(),
        "注册表条目必须摘掉"
    );
    let sink = events.lock().unwrap();
    assert!(
        sink.iter()
            .any(|(event, payload)| event == super::EVENT_INSTANCE && payload["kind"] == "removed"),
        "删除必须发 kojo:launcher-instance(kind=removed)"
    );
}

#[test]
fn copy_instance_task_completes_and_marks_ready() {
    let app = TestDir::new("copy-app");
    let source = TestDir::new("copy-src");
    let (host, _events) = test_host(app.path());
    host.layout.ensure_root().unwrap();
    std::fs::create_dir_all(source.join("sub")).unwrap();
    std::fs::write(source.join("game.exe"), b"fake-exe-bytes").unwrap();
    std::fs::write(source.join("sub").join("data.bin"), vec![7u8; 2048]).unwrap();
    std::fs::write(source.join("run.log"), b"skip me").unwrap();
    approve_once(&host, source.path());

    let request = super::commands::CreateInstanceRequest {
        name: "复制实例".to_string(),
        source_root: source.path().to_string_lossy().to_string(),
        adapter_id: "test-adapter".to_string(),
        game_id: "test-game".to_string(),
        candidate_id: "c1".to_string(),
        isolation: "copy".to_string(),
        include_saves: false,
        runtime_id: None,
        locale: None,
        encoding: None,
        notes: None,
    };
    let profile = super::commands::LaunchProfileDto {
        candidate_id: "c1".to_string(),
        executable: super::commands::ExecutableInputDto {
            relative_path: "game.exe".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            window_mode: "auto".to_string(),
        },
        cwd_relative: ".".to_string(),
        runtime: None,
        locale: None,
        encoding: None,
        save_roots: Vec::new(),
        content_roots: Vec::new(),
        warnings: Vec::new(),
    };
    let creation = super::commands::create_instance(&host, request, profile).unwrap();
    let task = creation.task.expect("copy 实例必须返回任务");
    assert_eq!(task.kind, "instance-copy");
    let id = creation.instance.instance.id.clone();

    let task_id = task.id.clone();
    assert!(
        wait_until(
            || {
                super::tasks::list(&host)
                    .into_iter()
                    .any(|current| current.id == task_id && current.state == "succeeded")
            },
            Duration::from_secs(20)
        ),
        "复制任务必须在时限内成功（当前：{:?}）",
        super::tasks::list(&host)
    );
    let instance = store::load_instance(&host.layout, &id).unwrap();
    assert_eq!(instance.state, "ready");
    let game = host.layout.game_dir(&id).unwrap();
    assert!(game.join("game.exe").exists());
    assert!(game.join("sub").join("data.bin").exists());
    assert!(!game.join("run.log").exists(), "*.log 默认跳过");
}
