//! 进程托管（§8 状态机 / §13.2 九步校验链）。
//!
//! 形状（为什么这么排）：
//! - **命令 async、真正干活在工作线程**：`CreateProcessW` 实测阻塞 280~375 ms
//!   （`launcher_probe.rs`，PITFALLS 221），放 UI 线程就是整窗卡死；
//! - **挂起创建 → 挂 Job → resume**：窗口只有十几毫秒，顺序错一格孙进程就逃出 Job
//!   （PITFALLS 221 的实测关系式）；resume 走**全文档化**的线程枚举 + `ResumeThread`
//!   （探针实测 ≈150 ms，一次性成本，换掉未文档化的 `NtResumeProcess`）；
//! - **日志泵双线程 + 监视线程**：两条管道必须并行读（先堵满 stderr 再写 stdout 的
//!   夹具在顺序读下必然互锁，见 `launcher_probe.rs::q4b`）；
//! - **每实例单进程**：内存表 + `running.lock` 双保险；重复 `start` 报
//!   `LAUNCHER_INSTANCE_BUSY`（契约 §5.6 里没有 `LAUNCHER_ALREADY_RUNNING` 这个码）。
//!
//! 明确**未做**（不假装）：优雅期 `WM_CLOSE`（首版 `stop` 直接 `TerminateJobObject` 杀树，
//! 退出原因按 `force` 记 `user` / `killed`）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;

use super::error::{io_failure, platform_unsupported, ErrorCode, LauncherErrorDto, LauncherResult};
use super::job::{JobHandle, STOP_EXIT_CODE};
use super::logs;
use super::paths;
use super::store::{self, StoredExit, StoredInstance, StoredLock};
use super::{iso_now, LauncherHost, EVENT_PROCESS};

/// 停止时的默认等待上限（契约常量：优雅期 5 s；首版是直接杀树，同样封顶）。
pub const DEFAULT_STOP_TIMEOUT_MS: u64 = 5_000;
/// 停止等待的硬上限（再久就是"UI 永久转圈"，不允许）。
pub const MAX_STOP_TIMEOUT_MS: u64 = 30_000;

/// 进程读数（`ProcessStatus` 同形）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatusDto {
    pub instance_id: String,
    pub state: String,
    pub pid: Option<u32>,
    pub session_id: Option<String>,
    pub started_at: Option<String>,
    pub elapsed_ms: u64,
    pub exit_code: Option<i64>,
    pub exit_reason: Option<String>,
    pub last_error: Option<LauncherErrorDto>,
}

impl ProcessStatusDto {
    pub fn idle(instance_id: &str) -> Self {
        Self {
            instance_id: instance_id.to_string(),
            state: "idle".to_string(),
            pid: None,
            session_id: None,
            started_at: None,
            elapsed_ms: 0,
            exit_code: None,
            exit_reason: None,
            last_error: None,
        }
    }
}

/// 停止标记：`stop` 与监视线程之间唯一的通信。
#[derive(Debug, Default)]
pub struct StopFlag {
    pub requested: AtomicBool,
    pub forced: AtomicBool,
}

/// 内存里的"正在运行"记录。
pub struct RunningProc {
    pub pid: u32,
    pub session_id: String,
    pub started_at: String,
    pub started: Instant,
    pub job: Arc<JobHandle>,
    pub stop: Arc<StopFlag>,
}

/* ------------------------- 平台原语（Windows 真实现） ------------------------- */

#[cfg(windows)]
mod sys {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, OpenThread, ResumeThread, TerminateProcess,
        WaitForSingleObject,
    };

    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;

    /// 进程是否还活着（`WaitForSingleObject(0)` = 未 signaled）。
    ///
    /// 生产路径用的是 `process_start_ticks`（存活 + 身份一起答）；本函数留给测试直读。
    #[allow(dead_code)]
    pub fn pid_alive(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let wait = WaitForSingleObject(handle, 0);
            CloseHandle(handle);
            wait == WAIT_TIMEOUT
        }
    }

    /// 进程创建时间（FILETIME ticks）：用来识别 pid 复用，陈旧锁的判据之一。
    pub fn process_start_ticks(pid: u32) -> Option<u64> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut creation: FILETIME = std::mem::zeroed();
            let mut exit: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
        }
    }

    /// 强制结束单个进程（只给"挂进 Job 之前失败"的兜底用）。
    pub fn terminate_pid(pid: u32) {
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                return;
            }
            TerminateProcess(handle, 0xDEAD_10CC);
            CloseHandle(handle);
        }
    }

    /// 枚举该进程的线程并逐个 `ResumeThread`（全文档化路线）。
    ///
    /// 探针实测 ≈150 ms（Toolhelp 快照扫全系统）——只在启动时付一次，换取不吃
    /// ntdll 的未文档化 `NtResumeProcess`。
    pub fn resume_process_threads(pid: u32) -> Result<u32, String> {
        let mut found = 0u32;
        let mut resumed = 0u32;
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
                return Err(format!("CreateToolhelp32Snapshot err={}", GetLastError()));
            }
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            let mut more = Thread32First(snapshot, &mut entry);
            while more != 0 {
                if entry.th32OwnerProcessID == pid {
                    found += 1;
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !thread.is_null() && thread != INVALID_HANDLE_VALUE {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
        }
        if found == 0 {
            return Err("挂起进程没有任何线程（枚举失败）".to_string());
        }
        if resumed != found {
            return Err(format!("只恢复 {resumed}/{found} 个线程"));
        }
        Ok(resumed)
    }

    /// 让 `Child` 的句柄对 `windows-sys` 可见。
    pub fn raw_handle(child: &std::process::Child) -> HANDLE {
        child.as_raw_handle() as HANDLE
    }
}

#[cfg(not(windows))]
mod sys {
    pub fn pid_alive(_pid: u32) -> bool {
        false
    }
    pub fn process_start_ticks(_pid: u32) -> Option<u64> {
        None
    }
    pub fn terminate_pid(_pid: u32) {}
    pub fn resume_process_threads(_pid: u32) -> Result<u32, String> {
        Err("unsupported".to_string())
    }
}

pub(crate) use sys::process_start_ticks;

fn platform_gate() -> LauncherResult<()> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err(platform_unsupported("进程托管"))
    }
}

/* ------------------------------- 启动参数 ------------------------------- */

/// 宿主白名单：`env_clear` 后**只**给这几位（都是子进程自己跑起来的最低需要）。
/// 实例显式声明的 `env` 在此之上追加（用户 / adapter 的选择，写进 `instance.json`）。
pub const ENV_WHITELIST: [&str; 6] = [
    "SystemRoot",
    "SystemDrive",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
];

fn validate_env(key: &str, value: &str) -> LauncherResult<()> {
    if key.is_empty() || key.len() > 128 {
        return Err(LauncherErrorDto::new(
            ErrorCode::ExecutableInvalid,
            "启动环境变量名为空或过长",
        ));
    }
    if key.contains('=') || key.contains('\0') || value.contains('\0') {
        return Err(
            LauncherErrorDto::new(ErrorCode::ExecutableInvalid, "启动环境变量含非法字符")
                .detail(format!("key={key}")),
        );
    }
    Ok(())
}

/// 白名单 + 实例追加项（后者可覆盖前者——它更具体）。
pub fn build_env(explicit: &BTreeMap<String, String>) -> LauncherResult<BTreeMap<String, String>> {
    let mut env = BTreeMap::new();
    for key in ENV_WHITELIST {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                env.insert(key.to_string(), value);
            }
        }
    }
    for (key, value) in explicit {
        validate_env(key, value)?;
        env.insert(key.clone(), value.clone());
    }
    Ok(env)
}

/// argv 只做形状闸（NUL / 总长）；**不做任何拼接**——参数原样进 `Command::args`，
/// 不经过 `cmd.exe` / PowerShell。
pub fn validate_argv(args: &[String]) -> LauncherResult<()> {
    let mut total = 0usize;
    for arg in args {
        if arg.contains('\0') {
            return Err(LauncherErrorDto::new(
                ErrorCode::ExecutableInvalid,
                "启动参数含 NUL 字符",
            ));
        }
        total = total.saturating_add(arg.len() + 3);
    }
    // Windows 命令行上限 32767（含终止符）；留出程序路径与空白余量
    if total > 30_000 {
        return Err(LauncherErrorDto::new(
            ErrorCode::ExecutableInvalid,
            "启动参数总长超过系统上限",
        )
        .detail(format!("约 {total} 字节")));
    }
    Ok(())
}

/// 只认 `.exe`：`.bat` / `.cmd` / `.ps1` / `.lnk` 一律拒（它们要么过 shell，要么是转发器）。
pub const ALLOWED_EXE_EXTENSION: &str = "exe";

/// §13.2 第 2~5 步：相对路径形状 → 拼绝对 → 逐段无 reparse → 常规文件 → 扩展名。
pub fn resolve_executable(instance: &StoredInstance, game_root: &Path) -> LauncherResult<PathBuf> {
    let relative = instance.executable.relative_path.trim();
    if relative.is_empty() {
        return Err(LauncherErrorDto::new(
            ErrorCode::ExecutableInvalid,
            "实例没有登记可执行文件",
        ));
    }
    let target = paths::resolve_relative(game_root, relative)?;
    let extension = target
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if extension != ALLOWED_EXE_EXTENSION {
        return Err(LauncherErrorDto::new(
            ErrorCode::ExecutableInvalid,
            "只允许启动 .exe 程序（批处理 / 脚本 / 快捷方式一律拒绝）",
        )
        .detail(format!("relativePath={relative}")));
    }
    paths::assert_no_reparse_between(game_root, &target)?;
    let meta = match std::fs::metadata(&target) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err(
                LauncherErrorDto::new(ErrorCode::ExecutableInvalid, "可执行文件不存在")
                    .detail(target.display().to_string()),
            )
        }
        Err(err) => return Err(io_failure("读取可执行文件信息", &target, &err)),
    };
    if !meta.is_file() {
        return Err(
            LauncherErrorDto::new(ErrorCode::ExecutableInvalid, "可执行路径不是一个文件")
                .detail(target.display().to_string()),
        );
    }
    paths::assert_inside_existing(game_root, &target)?;
    Ok(target)
}

/* ------------------------------- 启动 ------------------------------- */

/// 一次启动的完整计划（在阻塞线程里算好，之后只做"创建 + 挂 Job + resume"）。
struct SpawnPlan {
    exe: PathBuf,
    cwd: PathBuf,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    window_mode: String,
    session_id: String,
}

struct Spawned {
    child: Child,
    job: Arc<JobHandle>,
    pid: u32,
    /// 本次会话 id：日志文件名、运行锁、事件载荷共用同一枚（不重新生成）。
    session_id: String,
}

fn new_session_id(seq: u64) -> String {
    format!("{}-{}-{seq:04}", super::session_stamp(), std::process::id())
}

/// 校验链（§13.2 第 1~8 步）+ 起进程（第 9 步前半）。**只在阻塞线程里调用**。
fn prepare_and_spawn(host: &LauncherHost, instance: &StoredInstance) -> LauncherResult<Spawned> {
    let game_root = instance.game_root(&host.layout)?;
    let exe = resolve_executable(instance, &game_root)?;
    let digest = super::trust::sha256_file(&exe)?;
    super::trust::verify_trust(instance.executable_trust.as_ref(), &digest)?;
    if let Some(runtime_id) = instance.runtime_id.as_deref() {
        // 运行时解析是 P1（`launcher_runtime_*` 一组命令尚未落地）：**fail-closed**，
        // 不假装已解析——否则就是"看起来能跑"的静默降级。
        return Err(LauncherErrorDto::new(
            ErrorCode::RuntimeMissing,
            "实例声明了运行时，但本机还没有可解析的运行时记录",
        )
        .detail(format!("runtimeId={runtime_id}（运行时管理属 P1）")));
    }
    validate_argv(&instance.executable.args)?;
    let env = build_env(&instance.executable.env)?;
    let plan = SpawnPlan {
        exe,
        cwd: game_root,
        args: instance.executable.args.clone(),
        env,
        window_mode: instance.executable.window_mode.clone(),
        session_id: new_session_id(host.next_seq()),
    };

    let mut command = Command::new(&plan.exe);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        // 环境变量**只**留白名单 + 实例显式项（§13.1「环境变量泄露令牌」）
        .env_clear()
        .envs(&plan.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut flags = CREATE_SUSPENDED;
        if plan.window_mode == "hidden" {
            flags |= CREATE_NO_WINDOW;
        }
        command.creation_flags(flags);
    }

    let job = JobHandle::create_kill_on_close()?;
    let mut child = command.spawn().map_err(|err| {
        LauncherErrorDto::new(ErrorCode::ExecutableInvalid, "启动进程失败")
            .detail(format!("{}：{err}", plan.exe.display()))
    })?;
    let pid = child.id();

    #[cfg(windows)]
    {
        if let Err(err) = job.assign(sys::raw_handle(&child)) {
            sys::terminate_pid(pid);
            let _ = child.wait();
            return Err(err.detail(format!("pid={pid} 已被收回")));
        }
        if let Err(detail) = sys::resume_process_threads(pid) {
            sys::terminate_pid(pid);
            let _ = child.wait();
            return Err(super::error::internal("恢复挂起进程失败").detail(detail));
        }
    }

    Ok(Spawned {
        child,
        job,
        pid,
        session_id: plan.session_id.clone(),
    })
}

/// `start` 的同步实现（命令层用 `spawn_blocking` 包起来）。
pub fn start_blocking(
    host: &Arc<LauncherHost>,
    instance_id: &str,
) -> LauncherResult<ProcessStatusDto> {
    platform_gate()?;
    let instance = store::load_instance(&host.layout, instance_id)?;
    if instance.state != "ready" {
        return Err(LauncherErrorDto::new(
            ErrorCode::InstanceNotReady,
            "实例还没准备好（复制中或已损坏）",
        )
        .detail(format!("state={}", instance.state)));
    }
    if host.running_map().contains_key(instance_id) {
        return Err(busy_error(instance_id, "本机已有该实例的运行进程"));
    }
    if let Some(lock) = store::read_lock(&host.layout, instance_id)? {
        if !store::lock_is_stale(&lock) {
            return Err(busy_error(
                instance_id,
                &format!("另一个宿主进程正在运行它（pid={}）", lock.pid),
            ));
        }
        // 陈旧锁：pid 不存在 / 创建时间不符 ⇒ 上次异常退出，就地清理
        let _ = std::fs::remove_file(host.layout.lock_file(instance_id)?);
    }

    let mut starting = ProcessStatusDto::idle(instance_id);
    starting.state = "starting".to_string();
    host.set_status(starting.clone());
    host.emit_event(
        EVENT_PROCESS,
        json!({ "instanceId": instance_id, "status": starting }),
    );

    let spawned = match prepare_and_spawn(host, &instance) {
        Ok(spawned) => spawned,
        Err(err) => {
            let mut failed = ProcessStatusDto::idle(instance_id);
            failed.last_error = Some(err.clone());
            host.set_status(failed.clone());
            host.emit_event(
                EVENT_PROCESS,
                json!({ "instanceId": instance_id, "status": failed }),
            );
            return Err(err);
        }
    };

    attach(host, &instance, spawned)
}

fn busy_error(instance_id: &str, detail: &str) -> LauncherErrorDto {
    LauncherErrorDto::new(ErrorCode::InstanceBusy, "这个实例已经在运行")
        .detail(format!("instance={instance_id}：{detail}"))
}

/// 建会话日志 → 写运行锁 → 登记内存表 → 起日志泵与监视线程。
fn attach(
    host: &Arc<LauncherHost>,
    instance: &StoredInstance,
    mut spawned: Spawned,
) -> LauncherResult<ProcessStatusDto> {
    // 会话 id 由 prepare 生成并随 `Spawned` 带出来——不要在这里再生成一枚。
    let session_id = spawned.session_id.clone();
    let started_at = iso_now();
    let instance_id = instance.id.clone();

    let logs_dir = match host.layout.logs_dir(&instance_id) {
        Ok(dir) => dir,
        Err(err) => {
            sys::terminate_pid(spawned.pid);
            let _ = spawned.child.wait();
            return Err(err);
        }
    };
    if let Err(err) = logs::begin_session(&host.layout, &instance_id, &session_id, &started_at) {
        // 会话文件都建不出来 ⇒ 进程不能留在外面（"启动失败"必须真的没进程）
        sys::terminate_pid(spawned.pid);
        let _ = spawned.child.wait();
        return Err(err);
    }
    let lock = StoredLock {
        schema_version: store::SCHEMA_VERSION,
        instance_id: instance_id.clone(),
        pid: spawned.pid,
        session_id: session_id.clone(),
        started_at: started_at.clone(),
        process_start_ticks: process_start_ticks(spawned.pid),
        written_at: iso_now(),
    };
    if let Err(err) = store::write_lock(&host.layout, &lock) {
        sys::terminate_pid(spawned.pid);
        let _ = spawned.child.wait();
        return Err(err);
    }

    let counters = Arc::new(logs::StreamCounters::default());
    let mut pumps = Vec::new();
    if let Some(stdout) = spawned.child.stdout.take() {
        pumps.push(logs::spawn_pump(
            host.clone(),
            instance_id.clone(),
            session_id.clone(),
            "stdout",
            logs_dir.join(format!("{session_id}.stdout.log")),
            Box::new(stdout),
            counters.clone(),
        ));
    }
    if let Some(stderr) = spawned.child.stderr.take() {
        pumps.push(logs::spawn_pump(
            host.clone(),
            instance_id.clone(),
            session_id.clone(),
            "stderr",
            logs_dir.join(format!("{session_id}.stderr.log")),
            Box::new(stderr),
            counters.clone(),
        ));
    }

    let stop = Arc::new(StopFlag::default());
    host.running_map().insert(
        instance_id.clone(),
        RunningProc {
            pid: spawned.pid,
            session_id: session_id.clone(),
            started_at: started_at.clone(),
            started: Instant::now(),
            job: spawned.job.clone(),
            stop: stop.clone(),
        },
    );

    let status = ProcessStatusDto {
        instance_id: instance_id.clone(),
        state: "running".to_string(),
        pid: Some(spawned.pid),
        session_id: Some(session_id.clone()),
        started_at: Some(started_at.clone()),
        elapsed_ms: 0,
        exit_code: None,
        exit_reason: None,
        last_error: None,
    };
    host.set_status(status.clone());
    host.emit_event(
        EVENT_PROCESS,
        json!({ "instanceId": instance_id, "status": status }),
    );

    // 启动次数（清单读-改-写，与退出记录共用同一把闸）
    {
        let instance_id = instance_id.clone();
        let started_at = started_at.clone();
        let _ = host.with_manifest(|layout| {
            let mut latest = store::load_instance(layout, &instance_id)?;
            latest.launch_count = latest.launch_count.saturating_add(1);
            latest.last_launched_at = Some(started_at);
            latest.updated_at = iso_now();
            store::save_instance(layout, &latest)
        });
    }

    // 监视线程起不来时要能回头收拾现场：会话 / 实例 id 先各留一份
    let cleanup_instance = instance_id.clone();
    let cleanup_session = session_id.clone();
    let host_for_monitor = host.clone();
    let child = spawned.child;
    let monitor = std::thread::Builder::new()
        .name(format!("launcher-monitor-{instance_id}"))
        .spawn(move || {
            monitor_loop(
                host_for_monitor,
                instance_id,
                child,
                session_id,
                started_at,
                stop,
                counters,
                pumps,
            )
        });
    if let Err(err) = monitor {
        // 监视线程起不来 = 退出没人收尸 ⇒ 立刻杀树 + 摘表 + 清锁，别留孤儿与假 running
        let _ = spawned.job.terminate(STOP_EXIT_CODE);
        let _ = logs::finish_session(
            &host.layout,
            &cleanup_instance,
            &cleanup_session,
            &iso_now(),
            None,
            0,
            0,
        );
        store::clear_lock(&host.layout, &cleanup_instance, &cleanup_session);
        host.finish_running(&cleanup_instance, &cleanup_session);
        let mut failed = ProcessStatusDto::idle(&cleanup_instance);
        failed.last_error =
            Some(super::error::internal("启动监视线程失败").detail(err.to_string()));
        host.set_status(failed);
        return Err(super::error::internal("启动监视线程失败").detail(err.to_string()));
    }

    Ok(status)
}

#[allow(clippy::too_many_arguments)]
fn monitor_loop(
    host: Arc<LauncherHost>,
    instance_id: String,
    mut child: Child,
    session_id: String,
    started_at: String,
    stop: Arc<StopFlag>,
    counters: Arc<logs::StreamCounters>,
    pumps: Vec<std::thread::JoinHandle<()>>,
) {
    let started = Instant::now();
    let exit = child.wait();
    let exit_code = exit.ok().and_then(|status| status.code()).map(i64::from);
    // 泵线程在子进程退出后读到 EOF 才收尾：等它们把最后一块字节写完再记字节数
    for pump in pumps {
        let _ = pump.join();
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let (stdout_bytes, stderr_bytes) = counters.snapshot();
    let ended_at = iso_now();
    let reason = if stop.requested.load(Ordering::SeqCst) {
        if stop.forced.load(Ordering::SeqCst) {
            "killed"
        } else {
            "user"
        }
    } else if exit_code == Some(0) {
        "clean"
    } else {
        "crash"
    };

    let _ = logs::finish_session(
        &host.layout,
        &instance_id,
        &session_id,
        &ended_at,
        exit_code,
        stdout_bytes,
        stderr_bytes,
    );

    // 清单里的退出记录（崩溃摘要与「意外退出」提示的判据）
    {
        let instance_id = instance_id.clone();
        let session_id_for_write = session_id.clone();
        let started_at = started_at.clone();
        let ended_at = ended_at.clone();
        let _ = host.with_manifest(|layout| {
            let mut latest = store::load_instance(layout, &instance_id)?;
            latest.last_exit = Some(StoredExit {
                session_id: session_id_for_write,
                started_at,
                ended_at: ended_at.clone(),
                exit_code,
                reason: reason.to_string(),
            });
            latest.updated_at = ended_at.clone();
            store::save_instance(layout, &latest)
        });
    }
    store::clear_lock(&host.layout, &instance_id, &session_id);
    // 先摘运行记录再查状态：`stop` 等的是"表里没有它"
    host.finish_running(&instance_id, &session_id);

    let status = ProcessStatusDto {
        instance_id: instance_id.clone(),
        state: if reason == "crash" {
            "crashed".to_string()
        } else {
            "exited".to_string()
        },
        pid: None,
        session_id: Some(session_id),
        started_at: Some(started_at),
        elapsed_ms,
        exit_code,
        exit_reason: Some(reason.to_string()),
        last_error: if reason == "crash" {
            Some(
                LauncherErrorDto::new(ErrorCode::Internal, describe_exit_code(exit_code))
                    .detail(format!("退出原因={reason}，会话日志已落盘")),
            )
        } else {
            None
        },
    };
    host.set_status(status.clone());
    host.emit_event(
        EVENT_PROCESS,
        json!({ "instanceId": instance_id, "status": status }),
    );
}

/// Windows 退出码的中文解释（`0xC0000005` 这类 NTSTATUS 直接说人话，§8.2 铁律 4）。
pub fn describe_exit_code(code: Option<i64>) -> String {
    let Some(code) = code else {
        return "进程没有给出退出码".to_string();
    };
    let as_u32 = code as u32;
    match as_u32 {
        0xC000_0005 => "进程因访问冲突（0xC0000005）退出".to_string(),
        0xC000_0135 => "进程因找不到依赖库（0xC0000135）退出".to_string(),
        0xC000_013A => "进程因入口点缺失（0xC000013A）退出".to_string(),
        0xC000_0142 => "进程因未处理的异常（0xC0000142）退出".to_string(),
        0xC000_0409 => "进程因快速失败（0xC0000409）退出".to_string(),
        0xC000_001D => "进程因非法指令（0xC000001D）退出".to_string(),
        _ if code == 0 => "进程正常退出".to_string(),
        _ => format!("进程异常退出，退出码 {code}（0x{as_u32:08X}）"),
    }
}

/* ------------------------------- 停止 / 查询 ------------------------------- */

/// `stop` 的同步实现：`TerminateJobObject` → 等 Job 进程计数归零 → 等监视线程收尾。
pub fn stop_blocking(
    host: &Arc<LauncherHost>,
    instance_id: &str,
    force: bool,
    timeout_ms: Option<u64>,
) -> LauncherResult<ProcessStatusDto> {
    platform_gate()?;
    let (job, stop, session_id, pid, started_at) = {
        let map = host.running_map();
        match map.get(instance_id) {
            Some(proc) => (
                proc.job.clone(),
                proc.stop.clone(),
                proc.session_id.clone(),
                proc.pid,
                proc.started_at.clone(),
            ),
            // 没在跑：按"当前读数"回答（幂等，不报错）
            None => return Ok(status(host, instance_id)),
        }
    };

    stop.forced.store(force, Ordering::SeqCst);
    stop.requested.store(true, Ordering::SeqCst);

    let stopping = ProcessStatusDto {
        instance_id: instance_id.to_string(),
        state: "stopping".to_string(),
        pid: Some(pid),
        session_id: Some(session_id.clone()),
        started_at: Some(started_at),
        elapsed_ms: 0,
        exit_code: None,
        exit_reason: None,
        last_error: None,
    };
    host.set_status(stopping.clone());
    host.emit_event(
        EVENT_PROCESS,
        json!({ "instanceId": instance_id, "status": stopping }),
    );

    job.terminate(STOP_EXIT_CODE)?;

    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_STOP_TIMEOUT_MS)
            .min(MAX_STOP_TIMEOUT_MS),
    );
    let deadline = Instant::now() + timeout;
    loop {
        let empty = job.process_count().map(|count| count == 0).unwrap_or(true);
        if empty || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // 监视线程还要落退出记录 / 清锁：给它一小段时间，但绝不无限等
    let deadline = Instant::now() + Duration::from_secs(3);
    while host.running_map().contains_key(instance_id) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(status(host, instance_id))
}

/// 单个实例的当前读数（运行中用实时耗时，否则用最近一次快照）。
pub fn status(host: &LauncherHost, instance_id: &str) -> ProcessStatusDto {
    if let Some(proc) = host.running_map().get(instance_id) {
        return ProcessStatusDto {
            instance_id: instance_id.to_string(),
            state: "running".to_string(),
            pid: Some(proc.pid),
            session_id: Some(proc.session_id.clone()),
            started_at: Some(proc.started_at.clone()),
            elapsed_ms: proc.started.elapsed().as_millis() as u64,
            exit_code: None,
            exit_reason: None,
            last_error: None,
        };
    }
    host.last
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(instance_id)
        .cloned()
        .unwrap_or_else(|| ProcessStatusDto::idle(instance_id))
}

/// 全部进程读数（运行中优先于历史快照）。
pub fn list(host: &LauncherHost) -> Vec<ProcessStatusDto> {
    let mut out: Vec<ProcessStatusDto> = Vec::new();
    let ids: Vec<String> = host.running_map().keys().cloned().collect();
    for id in ids {
        out.push(status(host, &id));
    }
    let last = host.last.lock().unwrap_or_else(|e| e.into_inner());
    for (id, snapshot) in last.iter() {
        if out.iter().any(|item| &item.instance_id == id) {
            continue;
        }
        out.push(snapshot.clone());
    }
    out.sort_by(|a, b| a.instance_id.cmp(&b.instance_id));
    out
}
