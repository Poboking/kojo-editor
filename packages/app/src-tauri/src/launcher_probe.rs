//! **启动器进程原语的一次性实测探针**（不是生产模块）。
//!
//! 目的只有一个：用可复跑的读数回答 `docs/LAUNCHER-ARCHITECTURE.md` §8.2 铁律 2 / 7 落地前
//! 必须先量清楚的六件事——挂起创建、Job 收尸、应用退出即收尸、日志泵、env 白名单、argv 直传。
//! 每条结论都配一条断言（见 `q1`…`q7` 各测试），跑法：
//!
//! ```text
//! node -e "require('child_process').execSync('cargo test --lib launcher_probe -- --nocapture --test-threads=1',{cwd:'packages/app/src-tauri',stdio:'inherit'})"
//! ```
//!
//! 设计约束（照本批任务书）：
//! - 全部内容在 `#[cfg(windows)]` 的测试模块里（`lib.rs` 只多一行 `#[cfg(test)] mod launcher_probe;`），
//!   **不注册任何 tauri 命令**、不碰 `market.rs` / `plugin-api`；
//! - 夹具 = **测试二进制自我重启**：`current_exe()` + `--exact --ignored launcher_probe::fixture_entry`
//!   + `KOJO_PROBE_ROLE` 角色开关。不依赖任何外部 exe（不装软件、不写仓库、不碰游戏目录）；
//! - 所有临时文件在 `std::env::temp_dir()` 下的唯一子目录里，`ProbeDir::drop` 先按 pid 强杀
//!   自己拉起过的进程、再删目录 ⇒ 跑完不留进程、不留文件；
//! - 唯一 `#[ignore]` 的是夹具入口本身（它只该由测试以子进程身份拉起，单独跑没有任何断言）。
//!
//! 实测读数（本机 Win10/11 + rustc 1.99，读数抄自 `--nocapture` 首跑，只记量级）：
//! - **挂起创建**：`CREATE_SUSPENDED` 在本链路可用（std 与 CreateProcessW 两条路都对）；
//!   `AssignProcessToJobObject` 在挂起态耗时 40~235 µs；`NtResumeProcess` 返回 0、总耗时 ~73 µs；
//!   文档化的"枚举线程再 ResumeThread"也能过，但要 ~150 ms（Toolhelp 快照扫全系统）。
//! - **收尸**：`TerminateJobObject` 与"关最后一个句柄"都在 **25 ms** 内让子+孙一起消失；
//!   Job 进程计数 2 → 0；孙进程心跳同时停摆。
//! - **应用退出即收尸**：宿主 `TerminateProcess(self)` 后 26 ms 内子+孙都没了；还有一份句柄在握时
//!   （`DuplicateHandle`）树**活着**，关掉最后一份才死 —— `KILL_ON_JOB_CLOSE` 认的是句柄计数归零。
//! - **不挂起的代价**：子进程从创建到自己第一次 `CreateProcessW` 只有 **18~23 ms**；assign 晚于它
//!   = 孙进程逃出 Job（25 ms 档 6/6 逃逸）。而 `CreateProcessW` 本身阻塞 **280~375 ms** 才返回。
//! - **日志泵**：20 万行 / 18.6 MB 并发双通道读完，泵侧 42~46 ms（≈430 万行/秒、≈390 MiB/s，
//!   端到端含启动 0.31~0.39 s）；非 UTF-8 字节逐字节保真；"先堵满 stderr 再写 stdout"不死锁。
//! - **env**：`env_clear` + 4 个显式变量后子进程只看得到这 4 个（`HTTP_PROXY` / `SystemRoot` 均 absent），
//!   与 `CREATE_SUSPENDED` 同用互不影响；手拼 env 块（`CreateProcessW`）得到同一份结果。
//! - **argv**：`&` `|` 空格 引号 空串 尾反斜杠 `%PATH%` 中文 tab 全部逐字到达，std 与手拼命令行两条路一致。
//!
//! 逐条结论的完整版写在每个测试的文档注释里；`windows-sys` 的引入代价见 `Cargo.toml` 的
//! dev-dependencies 注释。

#![cfg(windows)]

use std::collections::BTreeMap;
use std::ffi::c_void;
use std::fs;
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, DuplicateHandle, GetLastError, SetHandleInformation, DUPLICATE_SAME_ACCESS, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, OpenProcess,
    OpenThread, ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
    STARTUPINFOW,
};

/// 子进程由 `CreateProcessW` 创建时需要这几位访问权（`PROCESS_ACCESS_RIGHTS` 字面值，
/// 本探针只用到这几位，手写常量比再点一堆 feature 便宜）。
const PROCESS_TERMINATE: u32 = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const THREAD_SUSPEND_RESUME: u32 = 0x0002;

/// 夹具角色 / 目录开关：只走环境变量，命令行留给"被测的 argv"本身。
const ROLE_ENV: &str = "KOJO_PROBE_ROLE";
const DIR_ENV: &str = "KOJO_PROBE_DIR";
/// 夹具入口的 libtest 全名（`--exact` 用）。
const FIXTURE_NAME: &str = "launcher_probe::fixture_entry";

// `NtResumeProcess` 是 **ntdll 的未文档化导出**（任务书路线 (b)）。它不在 windows-sys 里，
// 只能手写 extern；这里只做探针，生产若采用必须另有退路（见 q1b2 的文档化路线）。
#[link(name = "ntdll")]
extern "system" {
    fn NtResumeProcess(processhandle: HANDLE) -> i32;
}

/* ============================================================================
 * 一、临时目录 / 进程存活 / Job / 挂起创建 —— 探针的地基
 * ========================================================================== */

/// 唯一临时子目录 + 自己拉起过的 pid 台账。
///
/// `drop` 的顺序有意为之：**先按台账强杀**（含逃出 Job 的孙进程），再删目录（win 上残留句柄
/// 会让 `remove_dir_all` 报错，故重试几次后放弃——不制造噪声，但要尽力收干净）。
struct ProbeDir {
    path: PathBuf,
    pids: Mutex<Vec<u32>>,
}

impl ProbeDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "kojo-launcher-probe-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("探针临时目录必须能建");
        Self {
            path,
            pids: Mutex::new(Vec::new()),
        }
    }

    fn dir(&self) -> &Path {
        &self.path
    }

    fn file(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    /// 登记一个本探针拉起的进程（含孙进程）。drop 时强杀。
    fn track(&self, pid: u32) {
        self.pids.lock().unwrap().push(pid);
    }
}

impl Drop for ProbeDir {
    fn drop(&mut self) {
        let pids = std::mem::take(&mut *self.pids.lock().unwrap());
        for pid in pids {
            if pid_alive(pid) {
                kill_pid(pid);
            }
        }
        for _ in 0..10 {
            match fs::remove_dir_all(&self.path) {
                Ok(()) => return,
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

fn pid_alive(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let w = WaitForSingleObject(h, 0);
        CloseHandle(h);
        w == WAIT_TIMEOUT
    }
}

fn kill_pid(pid: u32) {
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return;
        }
        TerminateProcess(h, 0xDEAD_10CC);
        WaitForSingleObject(h, 2000);
        CloseHandle(h);
    }
}

fn wait_pid_dead(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !pid_alive(pid)
}

fn wait_until(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if cond() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 某个 pid 是否在指定 Job 里（`None` = 查不动，多半是进程已退出）。
fn is_in_job(pid: u32, job: HANDLE) -> Option<bool> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut result: i32 = -1;
        let ok = IsProcessInJob(h, job, &mut result);
        CloseHandle(h);
        if ok == 0 {
            None
        } else {
            Some(result != 0)
        }
    }
}

fn read_trim(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
}

fn read_pid(path: &Path) -> Option<u32> {
    read_trim(path).and_then(|s| s.parse::<u32>().ok())
}

/// Job Object 句柄的 RAII 壳：`KILL_ON_JOB_CLOSE` 是 **句柄计数归零** 时生效，
/// 所以"把句柄留在别的变量里"这件事在本探针里是一等公民（q3b 专门验它）。
struct Job(HANDLE);

impl Job {
    fn kill_on_close() -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(format!("CreateJobObjectW 失败 err={}", GetLastError()));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let err = GetLastError();
                CloseHandle(handle);
                return Err(format!("SetInformationJobObject 失败 err={err}"));
            }
            Ok(Self(handle))
        }
    }

    fn assign(&self, process: HANDLE) -> Result<(), String> {
        let ok = unsafe { AssignProcessToJobObject(self.0, process) };
        if ok == 0 {
            Err(format!(
                "AssignProcessToJobObject 失败 err={}",
                unsafe { GetLastError() }
            ))
        } else {
            Ok(())
        }
    }

    /// 只读查询用（`IsProcessInJob`），不转移所有权。
    fn handle_for_query(&self) -> HANDLE {
        self.0
    }

    fn terminate(&self, code: u32) -> Result<(), String> {
        let ok = unsafe { TerminateJobObject(self.0, code) };
        if ok == 0 {
            Err(format!(
                "TerminateJobObject 失败 err={}",
                unsafe { GetLastError() }
            ))
        } else {
            Ok(())
        }
    }

    /// Job 里当前挂了几个进程（q2 的见证：杀之前 2、杀之后 0）。
    fn process_count(&self) -> Option<u32> {
        #[repr(C)]
        struct IdList {
            number_of_assigned: u32,
            number_in_list: u32,
            pids: [usize; 64],
        }
        let mut list = IdList {
            number_of_assigned: 0,
            number_in_list: 0,
            pids: [0; 64],
        };
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicProcessIdList,
                &mut list as *mut _ as *mut c_void,
                std::mem::size_of::<IdList>() as u32,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            None
        } else {
            Some(list.number_of_assigned)
        }
    }

    /// 复制一份句柄（同一个 Job 对象、同一进程内两个句柄）——q3b 用它制造"还有人握着"的状态。
    fn duplicate(&self) -> Result<HANDLE, String> {
        let mut out: HANDLE = std::ptr::null_mut();
        let ok = unsafe {
            DuplicateHandle(
                GetCurrentProcess(),
                self.0,
                GetCurrentProcess(),
                &mut out,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 {
            Err(format!(
                "DuplicateHandle 失败 err={}",
                unsafe { GetLastError() }
            ))
        } else {
            Ok(out)
        }
    }

    /// 关掉原始句柄但**不让 Drop 再关一次**（q3b：只剩副本活着）。
    fn close_original(self) {
        unsafe { CloseHandle(self.0) };
        std::mem::forget(self);
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/* --------------------------- CreateProcessW 路线 (a) ---------------------------
 * std 的 `Command` 不给主线程句柄 ⇒ 想 `ResumeThread` 就得自己 CreateProcessW。
 * 自己创建意味着**四件事全得自己干**：命令行引号、env 块、标准句柄继承、进程/线程句柄。
 * 下面这几个函数就是那份成本的可执行清单（q6/q5 用同一套函数与 std 路线对拍）。
 * ---------------------------------------------------------------------------- */

/// MSVC CRT 的 argv 解析规则反推：需要引号 iff 空串或含空格/制表/引号；
/// 引号内 `\` 只在 `"` 前与串尾翻倍。
fn win_quote(arg: &str) -> String {
    let need = arg.is_empty() || arg.chars().any(|c| c == ' ' || c == '\t' || c == '"');
    if !need {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // 引号前的反斜杠要翻倍，引号本身转义
                for _ in 0..backslashes {
                    out.push('\\');
                }
                out.push('"');
                out.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                out.push(c);
            }
        }
    }
    // 串尾反斜杠翻倍（否则会把收尾引号吃掉）
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

fn build_command_line(argv: &[String]) -> Vec<u16> {
    let joined = argv
        .iter()
        .map(|a| win_quote(a))
        .collect::<Vec<_>>()
        .join(" ");
    // 命令行**不能**用 `\0` 结尾之后的推断：CreateProcessW 要可变缓冲，故这里自带终止符。
    let mut wide: Vec<u16> = joined.encode_utf16().collect();
    wide.push(0);
    wide
}

/// Windows env 块：`K=V\0K=V\0\0`，**按名字不区分大小写排序**（未排序会静默错乱），
/// 配合 `CREATE_UNICODE_ENVIRONMENT` 用 UTF-16。
fn build_env_block(vars: &BTreeMap<String, String>) -> Vec<u16> {
    let mut sorted: Vec<(&String, &String)> = vars.iter().collect();
    sorted.sort_by_key(|(k, _)| k.to_ascii_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in sorted {
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

/// `CreateProcessW` 拉起来的子进程：只暴露本探针要用的三件（pid / 进程句柄 / 线程句柄）。
struct RawChild {
    process: HANDLE,
    thread: HANDLE,
    pid: u32,
}

impl RawChild {
    fn create(
        argv: &[String],
        env: &BTreeMap<String, String>,
        suspended: bool,
        out_file: Option<&Path>,
        err_file: Option<&Path>,
    ) -> Result<Self, String> {
        // 标准句柄走**可继承文件**而不是管道：这条路线的管道版还要 CreatePipe + 两个
        // 可继承写端（见交付说明的"生产成本"），探针只需证明 CreateProcessW 能接住挂起标志。
        let mut keep: Vec<fs::File> = Vec::new();
        let mut out_handle: HANDLE = std::ptr::null_mut();
        let mut err_handle: HANDLE = std::ptr::null_mut();
        for (path, slot) in [(out_file, &mut out_handle), (err_file, &mut err_handle)] {
            if let Some(p) = path {
                let f = fs::File::create(p).map_err(|e| format!("建标准输出文件失败: {e}"))?;
                let h = f.as_raw_handle() as HANDLE;
                let ok = unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
                if ok == 0 {
                    return Err(format!("SetHandleInformation 失败 err={}", unsafe {
                        GetLastError()
                    }));
                }
                *slot = h;
                keep.push(f);
            }
        }
        let use_std = out_file.is_some() || err_file.is_some();

        let mut cmdline = build_command_line(argv);
        let env_block = build_env_block(env);
        let exe: Vec<u16> = argv[0].encode_utf16().chain(std::iter::once(0)).collect();

        let mut si: STARTUPINFOW = unsafe { std::mem::zeroed() };
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        if use_std {
            let nul = fs::File::create("NUL").map_err(|e| format!("打不开 NUL: {e}"))?;
            let nul_h = nul.as_raw_handle() as HANDLE;
            unsafe { SetHandleInformation(nul_h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) };
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = nul_h;
            si.hStdOutput = if out_handle.is_null() { nul_h } else { out_handle };
            si.hStdError = if err_handle.is_null() { nul_h } else { err_handle };
            keep.push(nul); // 先于 CreateProcessW 存活即可
        }
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        let mut flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
        if suspended {
            flags |= CREATE_SUSPENDED;
        }
        let ok = unsafe {
            CreateProcessW(
                exe.as_ptr(),
                cmdline.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                if use_std { 1 } else { 0 },
                flags,
                env_block.as_ptr() as *const c_void,
                std::ptr::null(),
                &si,
                &mut pi,
            )
        };
        if ok == 0 {
            return Err(format!("CreateProcessW 失败 err={}", unsafe {
                GetLastError()
            }));
        }
        // `keep` 在子进程创建后才可放手：Windows 在 CreateProcessW 返回时已把句柄复制给子进程。
        drop(keep);
        Ok(Self {
            process: pi.hProcess,
            thread: pi.hThread,
            pid: pi.dwProcessId,
        })
    }

    fn resume(&self) -> u32 {
        unsafe { ResumeThread(self.thread) }
    }

    fn wait_exit(&self, timeout: Duration) -> Option<u32> {
        let w = unsafe { WaitForSingleObject(self.process, timeout.as_millis() as u32) };
        if w != WAIT_OBJECT_0 {
            return None;
        }
        let mut code: u32 = u32::MAX;
        unsafe { GetExitCodeProcess(self.process, &mut code) };
        Some(code)
    }
}

impl Drop for RawChild {
    fn drop(&mut self) {
        unsafe {
            if !self.thread.is_null() && self.thread != INVALID_HANDLE_VALUE {
                CloseHandle(self.thread);
            }
            if !self.process.is_null() && self.process != INVALID_HANDLE_VALUE {
                CloseHandle(self.process);
            }
        }
    }
}

/* ============================================================================
 * 二、夹具（测试二进制自我重启）
 * ========================================================================== */

/// 给夹具子进程端备一条命令：`current_exe() --exact --ignored launcher_probe::fixture_entry`。
///
/// 为什么让 **libtest 自己去挑那一条 `#[ignore]` 用例**而不是"按 argv[1] 自己动手"：
/// 测试二进制是 libtest 的 main，任何"不认识的 argv"都会被它当过滤器或直接报错；
/// `--exact --ignored <全名>` 是它**保证会执行到指定用例**的唯一手势，且不跑别的用例。
fn fixture_command(exe: &Path, role: &str, dir: &Path) -> Command {
    let mut cmd = Command::new(exe);
    cmd.arg("--exact")
        .arg("--ignored")
        .arg(FIXTURE_NAME)
        .env(ROLE_ENV, role)
        .env(DIR_ENV, dir.display().to_string())
        .stdin(Stdio::null())
        // 夹具自己在 libtest 里的摘要（"running 1 test / test result: ok"）会混进本进程的
        // 测试输出，看着像多跑了几条用例；除日志泵（会自己改 piped）外一律静音。
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

fn fixture_exe() -> PathBuf {
    std::env::current_exe().expect("测试二进制路径必须拿得到")
}

fn probe_line() -> Vec<u8> {
    // 90 字节可读 + 4 字节非法 UTF-8（0xFF 0xFE 0x80 0xC3 单独出现都不成序列）+ `\n` = 95
    let mut line = Vec::with_capacity(96);
    line.extend_from_slice(b"[kojo-probe]0123456789012345678901234567890123456789012345678901234567890123456789012345");
    line.extend_from_slice(&[0xFF, 0xFE, 0x80, 0xC1]);
    line.push(b'\n');
    line
}

/// **夹具入口**：不写断言，只按 `KOJO_PROBE_ROLE` 扮演一个角色然后退出。
///
/// `#[ignore]` 的唯一理由：单独跑它什么都测不到（没有任何 assert），它的身份是"被拉起的子进程"。
/// 它不出弹窗、不卡死，`cargo test --lib` 不选中它（只计入 ignored）。
#[test]
#[ignore = "夹具入口：只由测试以 current_exe() + --exact --ignored 拉起，不单独跑"]
fn fixture_entry() {
    let role = std::env::var(ROLE_ENV).unwrap_or_default();
    let dir = PathBuf::from(
        std::env::var_os(DIR_ENV).expect("夹具子进程必须带 KOJO_PROBE_DIR（否则无处落见证）"),
    );

    match role.as_str() {
        "echo-args" => fixture_echo_args(&dir),
        "env-dump" => fixture_env_dump(&dir),
        "heartbeat" => fixture_heartbeat(&dir),
        "spawn-tree" => fixture_spawn_tree(&dir),
        "gate-tree" => fixture_gate_tree(&dir),
        "spew" => fixture_spew(),
        "spew-both" => fixture_spew_both(),
        "host-exit" => fixture_host_exit(&dir, false),
        "nested-host" => fixture_host_exit(&dir, true),
        other => panic!("未知夹具角色: {other}"),
    }
}

fn esc(arg: &str) -> String {
    arg.replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn fixture_echo_args(dir: &Path) {
    // 逐行、按 `esc()` 转义写盘：与测试侧期望值逐字对比（q6）。
    let mut body = String::new();
    for a in std::env::args() {
        body.push_str(&esc(&a));
        body.push('\n');
    }
    fs::write(dir.join("args.txt"), body).expect("argv 见证必须写得出去");
}

fn fixture_env_dump(dir: &Path) {
    let mut body = String::new();
    let all: BTreeMap<String, String> = std::env::vars().collect();
    body.push_str(&format!("COUNT={}\n", all.len()));
    for key in ["HTTP_PROXY", "PATH", "KOJO_PROBE_CUSTOM", "SystemRoot"] {
        let (present, value) = match all.get(key) {
            Some(v) => ("present", v.clone()),
            None => ("absent", String::new()),
        };
        body.push_str(&format!("{key}\t{present}\t{}\n", esc(&value)));
    }
    fs::write(dir.join("env.txt"), body).expect("env 见证必须写得出去");
}

/// 孙进程：写自己的 pid，然后 50ms 一跳地刷心跳计数（直到被收尸或 60s 超时）。
fn fixture_heartbeat(dir: &Path) {
    fs::write(dir.join("gc.pid"), std::process::id().to_string()).ok();
    let hb = dir.join("hb.txt");
    let tmp = dir.join("hb.tmp");
    for tick in 1..=1200u32 {
        if fs::write(&tmp, tick.to_string()).is_ok() {
            let _ = fs::rename(&tmp, &hb);
        }
        std::thread::sleep(Duration::from_millis(50));
        if dir.join("stop").exists() {
            break;
        }
    }
}

/// 子进程：自己的 pid 落盘 → 起孙进程 → 等孙进程登记 → 报 ready → 驻留（等被杀或 60s）。
fn fixture_spawn_tree(dir: &Path) {
    fs::write(dir.join("child.pid"), std::process::id().to_string()).ok();
    let exe = std::env::current_exe().expect("孙进程需要 current_exe");
    // `CreateProcessW` 是**阻塞**的：进程对象在调用开头就已存在，而调用本身要几百毫秒才返回
    // （重载 exe + 杀软扫描）。所以"派生发生的时刻"要用**调用前**这枚见证，而不是调用后写的那枚。
    fs::write(dir.join("gc.derive.begin"), "1").ok();
    let child = fixture_command(&exe, "heartbeat", dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("孙进程必须起得来");
    fs::write(dir.join("gc.spawned.pid"), child.id().to_string()).ok();
    fs::write(dir.join("gc.direct.pid"), child.id().to_string()).ok();
    wait_until_settle(|| dir.join("gc.pid").exists(), Duration::from_secs(10));
    fs::write(dir.join("tree-ready.txt"), "1").ok();
    for _ in 0..1200 {
        if dir.join("stop").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    kill_pid(child.id()); // 正常路径下这里等不到；兜底防孤儿
}

fn wait_until_settle(mut cond: impl FnMut() -> bool, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !cond() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 门控夹具：先报到，**等 `go.txt` 才派生孙进程**。用来把"assign 发生的时刻"与"派生发生的时刻"
/// 彻底解耦 —— 这是判定"晚 assign 会不会让孙进程逃出 Job"唯一干净的形状。
fn fixture_gate_tree(dir: &Path) {
    fs::write(dir.join("child.pid"), std::process::id().to_string()).ok();
    fs::write(dir.join("child-ready.txt"), "1").ok();
    wait_until_settle(|| dir.join("go.txt").exists(), Duration::from_secs(30));
    let exe = std::env::current_exe().expect("孙进程需要 current_exe");
    fs::write(dir.join("gc.derive.begin"), "1").ok();
    let child = fixture_command(&exe, "heartbeat", dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("孙进程必须起得来");
    fs::write(dir.join("gc.spawned.pid"), child.id().to_string()).ok();
    fs::write(dir.join("tree-ready.txt"), "1").ok();
    for _ in 0..1200 {
        if dir.join("stop").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    kill_pid(child.id());
}

/// 日志泵夹具：尽力以最高速率写 `KOJO_PROBE_LINES` 行（默认 20 万行、每行 95 字节 ≈ 19 MB），
/// 每 1000 行顺带一行 stderr（两条管道同时活跃，专治"只读一条"的死锁）。
fn fixture_spew() {
    let lines: usize = std::env::var("KOJO_PROBE_LINES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    let line = probe_line();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 16);
    let mut err = std::io::stderr();
    out.write_all(BEGUN).expect("stdout 写失败");
    for i in 0..lines {
        buf.extend_from_slice(&line);
        if buf.len() >= (1 << 15) {
            out.write_all(&buf).expect("stdout 写失败");
            buf.clear();
        }
        if i % 1000 == 0 {
            let _ = err.write_all(b"[kojo-probe-stderr]\n");
        }
    }
    out.write_all(&buf).expect("stdout 写失败");
    out.write_all(ENDED).expect("stdout 写失败");
    out.flush().ok();
}

/// 死锁夹具：**先把 stderr 塞满 1 MiB、再写 stdout 1 MiB**。
/// 顺序读（先读完 stdout 再读 stderr）在这份输出上必然互锁；并发读则一遍过。
fn fixture_spew_both() {
    let chunk = vec![0xFFu8; 1 << 16];
    let stderr = std::io::stderr();
    let mut err = stderr.lock();
    err.write_all(BEGUN).expect("stderr 写失败");
    for _ in 0..16 {
        err.write_all(&chunk).expect("stderr 写失败");
    }
    err.write_all(ENDED).expect("stderr 写失败");
    err.flush().ok();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    out.write_all(BEGUN).expect("stdout 写失败");
    for _ in 0..16 {
        out.write_all(&chunk).expect("stdout 写失败");
    }
    out.write_all(ENDED).expect("stdout 写失败");
    out.flush().ok();
}

/// "应用宿主退出"夹具：自己建 Job（KILL_ON_JOB_CLOSE）→ 挂起拉起子进程 → assign → resume →
/// 等孙进程就位 → 报答 → **TerminateProcess 自己**。
///
/// `nested = true` 时先把自己 assign 到一个外层 Job，再让子进程进内层 Job —— 用来回答
/// "宿主本身已经在一个 Job 里（IDE / 任务计划 / 容器）时，我们自己的 Job 还灵不灵"。
fn fixture_host_exit(dir: &Path, nested: bool) {
    let mut report = String::new();

    let _outer = if nested {
        let outer = Job::kill_on_close().expect("外层 Job 必须能建");
        let ok = outer.assign(unsafe { GetCurrentProcess() });
        report.push_str(&format!("outer_assign_self={ok:?}\n"));
        // 落到见证文件里，避免父进程只看到"进程没了"
        fs::write(dir.join("nested.txt"), &report).ok();
        Some(outer)
    } else {
        None
    };

    let job = Job::kill_on_close().expect("Job 必须能建");
    let exe = std::env::current_exe().expect("current_exe");
    let mut cmd = fixture_command(&exe, "spawn-tree", dir);
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED);
    let mut child = cmd.spawn().expect("挂起子进程必须起得来");
    let h = child.as_raw_handle() as HANDLE;
    let assigned = job.assign(h);
    report.push_str(&format!("inner_assign={assigned:?}\n"));
    report.push_str(&format!("job_count_after_assign={:?}\n", job.process_count()));
    let status = unsafe { NtResumeProcess(h) };
    report.push_str(&format!("nt_resume_status={status}\n"));
    fs::write(dir.join("nested.txt"), &report).ok();

    wait_until_settle(|| dir.join("gc.pid").exists(), Duration::from_secs(15));
    fs::write(dir.join("host-ready.txt"), "1").ok();

    // 让子/孙进程各自跑起来再退：确认心跳在动（不然"退出后消失"可能只是没起来）
    wait_until_settle(
        || read_trim(&dir.join("hb.txt")).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0) >= 3,
        Duration::from_secs(10),
    );

    // 真·应用退出的等价动作：进程自己终止（OS 关掉它名下所有句柄）。
    unsafe {
        TerminateProcess(GetCurrentProcess(), 0);
    }
    std::thread::sleep(Duration::from_secs(5)); // TerminateProcess(self) 不返回；兜底
    let _ = child.wait();
    drop(job);
    let _ = _outer;
}

/* ============================================================================
 * 三、六个问题的实测 —— 每条断言都对应任务书里的一问
 * ========================================================================== */

/// **Q7（前置）**：宿主自己是不是已经在某个 Job 里？——决定"嵌套 Job"要不要当风险项。
/// 不断言具体值（取决于谁拉起测试进程），只把读数打出来，并验证 API 可用。
#[test]
fn q7_host_job_membership_report() {
    let mut in_job: i32 = -1;
    let ok = unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) };
    println!(
        "[probe][q7] pid={} IsProcessInJob(self, any) ok={ok} in_job={in_job}",
        unsafe { GetCurrentProcessId() }
    );
    assert_ne!(ok, 0, "IsProcessInJob 必须能回答（否则无权查询本进程）");
    // 当前进程一定能被 assign 到 Job 的**前提**是它有 SET_QUOTA/TERMINATE 权限；这里只报告。
}

/// **Q1-(a)**：`CreateProcessW` + `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `ResumeThread`
/// 这条路在本进程里走得通吗？代价是什么？
///
/// 见证：挂起后 300ms 内子进程**不能**有 argv 落盘（真挂起）→ assign 成功且 Job 里恰有 1 个进程
/// → `ResumeThread` 返回挂起计数 1 → 子进程落盘 → 退出码 0。
#[test]
fn q1a_create_process_w_suspended_assign_resume() {
    let dir = ProbeDir::new("q1a");
    let exe = fixture_exe();
    let job = Job::kill_on_close().expect("Job 必须能建");

    let mut env = BTreeMap::new();
    env.insert(ROLE_ENV.to_string(), "echo-args".to_string());
    env.insert(DIR_ENV.to_string(), dir.dir().display().to_string());
    env.insert("KOJO_PROBE_MARK".to_string(), "a".to_string());

    let argv: Vec<String> = vec![
        exe.display().to_string(),
        "--exact".to_string(),
        "--ignored".to_string(),
        FIXTURE_NAME.to_string(),
    ];

    let t0 = Instant::now();
    let child = RawChild::create(
        &argv,
        &env,
        true,
        Some(&dir.file("stdout.txt")),
        Some(&dir.file("stderr.txt")),
    )
    .expect("CreateProcessW(挂起) 必须成功");
    dir.track(child.pid);
    let t_create = t0.elapsed();

    // 真挂起判定：给足时间，见证文件仍不该出现
    std::thread::sleep(Duration::from_millis(300));
    let witness_while_suspended = dir.file("args.txt").exists();

    let t_assign0 = Instant::now();
    job.assign(child.process).expect("挂起态 assign 必须成功");
    let t_assign = t_assign0.elapsed();
    let count_after_assign = job.process_count();

    let suspend_count = child.resume();
    let t_resume = t0.elapsed();

    let saw = wait_until(|| dir.file("args.txt").exists(), Duration::from_secs(10));
    let code = child.wait_exit(Duration::from_secs(10));

    println!(
        "[probe][q1a] create={:?} assign={:?} until-resume={:?} suspend_count={suspend_count} \
         job_count={count_after_assign:?} witness_while_suspended={witness_while_suspended} \
         saw={saw} exit={code:?}",
        t_create, t_assign, t_resume
    );

    assert!(
        !witness_while_suspended,
        "CREATE_SUSPENDED 没真挂起：子进程在 resume 之前就跑了（见证 {} 已存在）",
        dir.file("args.txt").display()
    );
    assert_eq!(count_after_assign, Some(1), "挂起态 assign 后 Job 里应恰有 1 个进程");
    assert_eq!(suspend_count, 1, "ResumeThread 应返回初始挂起计数 1");
    assert!(saw, "resume 之后子进程必须落盘 argv 见证");
    assert_eq!(code, Some(0), "子进程退出码必须是 0");
}

/// **Q1-(b)**：`std::process::Command` + `CREATE_SUSPENDED`，再用 **`NtResumeProcess`**（未文档化）
/// resume —— 省掉了自己拼命令行 / env 块 / 句柄继承，代价是一个 ntdll 未文档化导出。
///
/// 见证：挂起期间无见证；`NtResumeProcess` 返回 `STATUS_SUCCESS(0)`；子进程落盘并 0 退出。
#[test]
fn q1b_std_suspended_plus_nt_resume_process() {
    let dir = ProbeDir::new("q1b");
    let job = Job::kill_on_close().expect("Job 必须能建");
    let mut cmd = fixture_command(&fixture_exe(), "echo-args", dir.dir());
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED);
    let mut child = cmd.spawn().expect("std + CREATE_SUSPENDED 必须起得来");
    dir.track(child.id());

    std::thread::sleep(Duration::from_millis(300));
    let witness_while_suspended = dir.file("args.txt").exists();

    let h = child.as_raw_handle() as HANDLE;
    let t0 = Instant::now();
    job.assign(h).expect("挂起态 assign 必须成功");
    let assign = t0.elapsed();
    let status = unsafe { NtResumeProcess(h) };
    let resume = t0.elapsed();

    let saw = wait_until(|| dir.file("args.txt").exists(), Duration::from_secs(10));
    let mut tried = 0;
    let exit = wait_until(
        || {
            tried += 1;
            matches!(child.try_wait(), Ok(Some(_)))
        },
        Duration::from_secs(10),
    );
    let code = child.try_wait().ok().flatten().and_then(|s| s.code());

    println!(
        "[probe][q1b] suspend_flag=ok witness_while_suspended={witness_while_suspended} \
         nt_status=0x{status:08X} assign={assign:?} assign+resume={resume:?} \
         witness={saw} exited={exit} (polls={tried}) exit_code={code:?}"
    );
    assert!(!witness_while_suspended, "std 的 CREATE_SUSPENDED 没真挂起");
    assert_eq!(status, 0, "NtResumeProcess 必须返回 STATUS_SUCCESS");
    assert!(saw, "resume 后子进程必须落盘");
    assert_eq!(code, Some(0), "子进程退出码必须是 0");
}

/// **Q1-(b')**：同样挂起，但 resume 走**全文档化**的线程枚举
/// （`CreateToolhelp32Snapshot` + `Thread32First/Next` + `OpenThread(THREAD_SUSPEND_RESUME)` + `ResumeThread`）。
/// 这是"不想吃未文档化导出"时的退路，代价是多一次快照遍历。
#[test]
fn q1b2_std_suspended_plus_documented_thread_enum_resume() {
    let dir = ProbeDir::new("q1b2");
    let mut cmd = fixture_command(&fixture_exe(), "echo-args", dir.dir());
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED);
    let mut child = cmd.spawn().expect("std + CREATE_SUSPENDED 必须起得来");
    dir.track(child.id());
    std::thread::sleep(Duration::from_millis(300));
    let witness_while_suspended = dir.file("args.txt").exists();

    let t0 = Instant::now();
    let (found, resumed) = resume_all_threads_of(child.id());
    let elapsed = t0.elapsed();

    let saw = wait_until(|| dir.file("args.txt").exists(), Duration::from_secs(10));
    let exit = wait_until(
        || matches!(child.try_wait(), Ok(Some(_))),
        Duration::from_secs(10),
    );
    let code = child.try_wait().ok().flatten().and_then(|s| s.code());

    println!(
        "[probe][q1b2] threads_found={found} resumed={resumed} enum+resume={elapsed:?} \
         witness_while_suspended={witness_while_suspended} witness={saw} exited={exit} code={code:?}"
    );
    assert!(!witness_while_suspended, "std 的 CREATE_SUSPENDED 没真挂起");
    assert!(found >= 1, "进程里至少该有一个线程");
    assert_eq!(resumed, found, "每个线程都该 resume 成功");
    assert!(saw && exit, "枚举 resume 之后子进程必须跑起来并退出");
    assert_eq!(code, Some(0), "子进程退出码必须是 0");
}

fn resume_all_threads_of(pid: u32) -> (u32, u32) {
    let mut found = 0u32;
    let mut resumed = 0u32;
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return (0, 0);
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snap, &mut entry);
        while more != 0 {
            if entry.th32OwnerProcessID == pid {
                found += 1;
                let h = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !h.is_null() && h != INVALID_HANDLE_VALUE {
                    if ResumeThread(h) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(h);
                }
            }
            more = Thread32Next(snap, &mut entry);
        }
        CloseHandle(snap);
    }
    (found, resumed)
}

/// **Q1-(c)**：不挂起、拉起后立刻 assign —— 竞态窗口到底有多宽？
///
/// 做法：给 assign 前加不同延迟（0/10/25/100 ms），看"孙进程逃出 Job"从哪一档开始出现，
/// 并对每个孙进程直接问一次 `IsProcessInJob(grandchild, job)`（逃逸与"不在 Job 里"必须一一对应）。
/// 逃出来的孙进程由探针显式 `TerminateProcess` 收掉（它们已不在 Job 里，只能手杀）。
///
/// **窗口的右边界不是"孙进程写 pid 的时刻"**：子进程调用 `CreateProcessW` 会阻塞几百毫秒
/// （本机实测 280~375 ms，见 `gc_pid_visible_ms`），而进程对象在调用开头就已存在。所以真正的
/// 边界是夹具在**调用前**写下的 `gc.derive.begin`（`derive_begin_ms`，实测 18~23 ms）——首跑用
/// "写 pid 的时刻"当边界，把窗口量大了十倍，读数自相矛盾（assign 在 25 ms、派生在 350 ms，孙进程却逃了）。
#[test]
fn q1c_unsuspended_assign_race_window() {
    let dir = ProbeDir::new("q1c");
    let mut report: Vec<String> = Vec::new();
    // 逐轮台账：判据只认**先后关系**（assign 是否早于派生），不认绝对毫秒数——
    // 并行测试线程会把这个窗口拉宽，钉死"N 毫秒内必须安全"的写法注定假红。
    struct Rec {
        assign_done_ms: u128,
        derive_ms: u128,
        in_job: Option<bool>,
        escaped: bool,
    }
    let mut recs: Vec<Rec> = Vec::new();

    for delay_ms in [0u64, 10, 25, 100] {
        let mut escaped_count = 0;
        let mut ok_count = 0;
        let mut assign_failures: Vec<String> = Vec::new();
        let mut latencies: Vec<u128> = Vec::new();
        let mut derive_latencies: Vec<u128> = Vec::new();
        let mut assign_call_us: Vec<u128> = Vec::new();
        let mut spawn_to_assign_ms: Vec<u128> = Vec::new();
        let (mut in_job, mut out_job, mut unknown_job) = (0u32, 0u32, 0u32);
        for iter in 0..5u32 {
            let sub = dir.dir().join(format!("race-{delay_ms}-{iter}"));
            fs::create_dir_all(&sub).expect("子目录");
            let job = Job::kill_on_close().expect("Job 必须能建");
            let mut cmd = fixture_command(&fixture_exe(), "spawn-tree", &sub);
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
            let t0 = Instant::now();
            let mut child = cmd.spawn().expect("子进程必须起得来");
            dir.track(child.id());
            let spawned = t0.elapsed();
            // 独立看门线程从 spawn 那刻起死盯"派生开始"这枚见证：写在 assign 之后再去看它，
            // 只要 assign 晚于派生，看到的就永远只是自己的延迟（首版就是这么把自己的 sleep 量成窗口的）。
            let watch = {
                let path = sub.join("gc.derive.begin");
                std::thread::spawn(move || {
                    let deadline = t0 + Duration::from_secs(6);
                    while Instant::now() < deadline {
                        if path.exists() {
                            return Some((t0.elapsed() - spawned).as_millis());
                        }
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    None
                })
            };
            if delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(delay_ms));
            }
            let assign_at = t0.elapsed();
            let assigned = job.assign(child.as_raw_handle() as HANDLE);
            if let Err(e) = &assigned {
                assign_failures.push(e.clone());
            }
            let assign_done = t0.elapsed();
            // 两条读数：assign 调用自身耗时（µs）与"spawn 返回 → assign 开始"的间隔（ms）。
            // 后者才是我们真正押上的安全余量。
            assign_call_us.push((assign_done - assign_at).as_micros());
            spawn_to_assign_ms.push((assign_at - spawned).as_millis());

            // **派生时刻**（子进程调用 CreateProcessW 之前写的那枚见证）：这才是竞态窗口的右边界。
            // 它之后的 `gc.spawned.pid` 要等子进程从 CreateProcessW 返回才写，晚几百毫秒。
            if let Some(ms) = watch.join().unwrap_or(None) {
                derive_latencies.push(ms);
            }
            let parent_in_our_job =
                is_in_job(child.id(), job.handle_for_query()).unwrap_or(false);
            let parent_in_any_job = is_in_job(child.id(), std::ptr::null_mut()).unwrap_or(false);
            let mut gc_membership = None;
            let mut gc_any_job = None;
            let _ = wait_until(
                || sub.join("gc.spawned.pid").exists(),
                Duration::from_secs(6),
            );
            if let Some(p) = read_pid(&sub.join("gc.spawned.pid")) {
                dir.track(p);
                gc_membership = is_in_job(p, job.handle_for_query());
                gc_any_job = is_in_job(p, std::ptr::null_mut());
                match gc_membership {
                    Some(true) => in_job += 1,
                    Some(false) => out_job += 1,
                    None => unknown_job += 1,
                }
            }
            let saw_gc = wait_until(
                || sub.join("gc.pid").exists(),
                Duration::from_secs(6),
            );
            let gc_at = t0.elapsed();
            let gpid = read_pid(&sub.join("gc.pid"));
            if let Some(p) = gpid {
                dir.track(p);
            }
            if saw_gc {
                latencies.push((gc_at - spawned).as_millis());
            }

            // 关掉 Job 的最后一个句柄 ⇒ Job 里的成员被杀；逃出去的不受影响
            drop(job);
            std::thread::sleep(Duration::from_millis(300));
            let escaped = matches!(gpid, Some(p) if pid_alive(p));
            if escaped {
                escaped_count += 1;
                if let Some(p) = gpid {
                    kill_pid(p);
                }
            } else if assigned.is_ok() && saw_gc {
                ok_count += 1;
            }
            if let Some(derive_ms) = derive_latencies.last().copied() {
                recs.push(Rec {
                    assign_done_ms: (assign_done - spawned).as_millis(),
                    derive_ms,
                    in_job: gc_membership,
                    escaped,
                });
            }
            kill_pid(child.id());
            let _ = child.wait();
            fs::write(sub.join("stop"), "1").ok();
            println!(
                "[probe][q1c][iter] delay={delay_ms} iter={iter} parent_in_job={parent_in_our_job} \
                 parent_in_any_job={parent_in_any_job} gc_in_job={gc_membership:?} \
                 gc_in_any_job={gc_any_job:?} escaped={escaped}"
            );
        }
        latencies.sort_unstable();
        derive_latencies.sort_unstable();
        assign_call_us.sort_unstable();
        spawn_to_assign_ms.sort_unstable();
        assign_failures.dedup();
        report.push(format!(
            "delay={delay_ms}ms escapes={escaped_count}/5 killed_with_job={ok_count}/5 \
             assign_failures={:?} spawn_to_assign_ms={:?} derive_begin_ms={:?} \
             grandchild_in_job={{in:{in_job} out:{out_job} unknown:{unknown_job}}} \
             assign_call_us={:?} gc_pid_visible_ms={:?}",
            assign_failures, spawn_to_assign_ms, derive_latencies, assign_call_us, latencies
        ));
    }

    for line in &report {
        println!("[probe][q1c] {line}");
    }

    // 判据（关系式，抗并行负载）：**assign 早于派生 ⇒ 孙进程归 Job 且随句柄关闭而死；
    // assign 晚于派生 ⇒ 孙进程一定在 Job 外且活下来**。两个桶都要有足够样本，才算真量到了边界。
    // 毫秒级读数在"25ms 档"会撞上同值，故只有相差 ≥ 2ms 的轮次进桶，差得更小的算"临界"单列。
    let mut before = 0;
    let mut after = 0;
    let mut after_escaped = 0;
    let mut edge = 0;
    for r in &recs {
        assert!(
            r.in_job.is_some(),
            "孙进程必须查得动 Job 归属（否则该轮读数作废）"
        );
        assert_eq!(
            r.escaped,
            r.in_job == Some(false),
            "逃逸与「不在 Job 里」必须一一对应（assign_done={}ms derive={}ms）",
            r.assign_done_ms,
            r.derive_ms
        );
        let gap = r.assign_done_ms as i128 - r.derive_ms as i128;
        if gap <= -2 {
            // **硬判据**：assign 明显早于"派生开始"这枚见证 ⇒ 孙进程必然归 Job。
            before += 1;
            assert!(
                r.in_job == Some(true),
                "assign（{}ms）早于派生（{}ms）时孙进程必须归 Job",
                r.assign_done_ms,
                r.derive_ms
            );
        } else if gap >= 2 {
            // 只记账不下死判：见证写在调用**之前**，并行负载下子进程写完就被抢占时，
            // 晚到的 assign 仍可能挤进去把它抓住（实测确有这一档），所以这里只统计逃逸率。
            after += 1;
            if r.escaped {
                after_escaped += 1;
            }
        } else {
            edge += 1;
        }
    }
    println!(
        "[probe][q1c] records={} assign_before_derive={before} \
         assign_after_derive={after} (escaped {after_escaped}/{after}) edge(±<2ms)={edge}",
        recs.len()
    );
    assert!(before >= 8, "早 assign 的样本太少（{before}），边界没量到");
    assert!(after >= 4, "晚 assign 的样本太少（{after}），边界没量到");
    assert!(
        after_escaped * 2 >= after,
        "assign 晚于派生之后仍有半数以上被抓住（{after_escaped}/{after}）——夹具没造出竞态，读数作废"
    );
}

/// **Q1-(c')**：把"assign 时刻"与"派生时刻"解耦后的**确定性**判据。
///
/// 门控夹具先报到、等 `go.txt` 才派生孙进程，于是四种形态可以逐字对比：
/// ① 先 assign 再放行（不挂起）；② 挂起 → assign → resume → 再放行；③ 先放行（派生已在路上）再 assign；
/// ④ 子进程活 300 ms 之后才 assign，再放行（排除"进程年龄"这个干扰项）。
/// 这条测试回答的是"晚 assign 到底会丢什么"——不只是逃逸的那一下，还有**之后所有后代**是否还归 Job 管。
#[test]
fn q1c2_gate_assign_before_derive_is_deterministic() {
    let dir = ProbeDir::new("q1c2");
    let mut lines: Vec<String> = Vec::new();

    // 形态 ①：不挂起 → 立即 assign → 再放行派生
    {
        let sub = dir.dir().join("before");
        fs::create_dir_all(&sub).expect("子目录");
        let job = Job::kill_on_close().expect("Job 必须能建");
        let mut cmd = fixture_command(&fixture_exe(), "gate-tree", &sub);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().expect("门控子进程必须起得来");
        dir.track(child.id());
        job.assign(child.as_raw_handle() as HANDLE)
            .expect("assign 必须成功");
        assert!(
            wait_until(|| sub.join("child-ready.txt").exists(), Duration::from_secs(20)),
            "门控子进程没报到"
        );
        fs::write(sub.join("go.txt"), "1").ok();
        assert!(
            wait_until(
                || sub.join("gc.spawned.pid").exists(),
                Duration::from_secs(20)
            ),
            "放行后孙进程必须在 20s 内派生"
        );
        let gpid = read_pid(&sub.join("gc.spawned.pid")).expect("孙进程 pid");
        dir.track(gpid);
        let in_job = is_in_job(gpid, job.handle_for_query());
        drop(job);
        std::thread::sleep(Duration::from_millis(600));
        let dead = !pid_alive(gpid);
        if !dead {
            kill_pid(gpid);
        }
        lines.push(format!(
            "form=assign-before-derive grandchild_in_job={in_job:?} dead_after_handle_close={dead}"
        ));
        kill_pid(child.id());
    }

    // 形态 ②：挂起 → assign → resume → 再放行派生（铁律 2 的完整配方）
    {
        let sub = dir.dir().join("suspend");
        fs::create_dir_all(&sub).expect("子目录");
        let job = Job::kill_on_close().expect("Job 必须能建");
        let mut cmd = fixture_command(&fixture_exe(), "gate-tree", &sub);
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_SUSPENDED);
        let child = cmd.spawn().expect("门控子进程必须起得来");
        dir.track(child.id());
        job.assign(child.as_raw_handle() as HANDLE)
            .expect("挂起态 assign 必须成功");
        assert_eq!(
            unsafe { NtResumeProcess(child.as_raw_handle() as HANDLE) },
            0,
            "NtResumeProcess 必须成功"
        );
        assert!(
            wait_until(|| sub.join("child-ready.txt").exists(), Duration::from_secs(20)),
            "门控子进程没报到"
        );
        fs::write(sub.join("go.txt"), "1").ok();
        assert!(
            wait_until(
                || sub.join("gc.spawned.pid").exists(),
                Duration::from_secs(20)
            ),
            "放行后孙进程必须在 20s 内派生"
        );
        let gpid = read_pid(&sub.join("gc.spawned.pid")).expect("孙进程 pid");
        dir.track(gpid);
        let in_job = is_in_job(gpid, job.handle_for_query());
        drop(job);
        std::thread::sleep(Duration::from_millis(600));
        let dead = !pid_alive(gpid);
        if !dead {
            kill_pid(gpid);
        }
        lines.push(format!(
            "form=suspend-assign-resume grandchild_in_job={in_job:?} dead_after_handle_close={dead}"
        ));
        kill_pid(child.id());
    }

    // 形态 ③：先放行（孙进程已在派生路上）→ 隔 40ms 再 assign
    {
        let sub = dir.dir().join("late");
        fs::create_dir_all(&sub).expect("子目录");
        let job = Job::kill_on_close().expect("Job 必须能建");
        let mut cmd = fixture_command(&fixture_exe(), "gate-tree", &sub);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().expect("门控子进程必须起得来");
        dir.track(child.id());
        assert!(
            wait_until(|| sub.join("child-ready.txt").exists(), Duration::from_secs(20)),
            "门控子进程没报到"
        );
        fs::write(sub.join("go.txt"), "1").ok();
        std::thread::sleep(Duration::from_millis(40));
        job.assign(child.as_raw_handle() as HANDLE)
            .expect("晚 assign 也必须能成功");
        assert!(
            wait_until(
                || sub.join("gc.spawned.pid").exists(),
                Duration::from_secs(20)
            ),
            "孙进程必须在 20s 内派生"
        );
        let gpid = read_pid(&sub.join("gc.spawned.pid")).expect("孙进程 pid");
        dir.track(gpid);
        let in_job = is_in_job(gpid, job.handle_for_query());
        drop(job);
        std::thread::sleep(Duration::from_millis(600));
        let dead = !pid_alive(gpid);
        if !dead {
            kill_pid(gpid);
        }
        lines.push(format!(
            "form=assign-after-derive grandchild_in_job={in_job:?} dead_after_handle_close={dead}"
        ));
        kill_pid(child.id());
    }

    // 形态 ④：**先让子进程活 300ms 再 assign**（仍早于放行派生）——专测"子进程的年龄"有没有影响。
    {
        let sub = dir.dir().join("aged");
        fs::create_dir_all(&sub).expect("子目录");
        let job = Job::kill_on_close().expect("Job 必须能建");
        let mut cmd = fixture_command(&fixture_exe(), "gate-tree", &sub);
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().expect("门控子进程必须起得来");
        dir.track(child.id());
        assert!(
            wait_until(|| sub.join("child-ready.txt").exists(), Duration::from_secs(20)),
            "门控子进程没报到"
        );
        std::thread::sleep(Duration::from_millis(300));
        job.assign(child.as_raw_handle() as HANDLE)
            .expect("晚 assign 也必须能成功");
        std::thread::sleep(Duration::from_millis(100));
        fs::write(sub.join("go.txt"), "1").ok();
        assert!(
            wait_until(
                || sub.join("gc.spawned.pid").exists(),
                Duration::from_secs(20)
            ),
            "孙进程必须在 20s 内派生"
        );
        let gpid = read_pid(&sub.join("gc.spawned.pid")).expect("孙进程 pid");
        dir.track(gpid);
        let in_job = is_in_job(gpid, job.handle_for_query());
        let any_job = is_in_job(gpid, std::ptr::null_mut());
        drop(job);
        std::thread::sleep(Duration::from_millis(600));
        let dead = !pid_alive(gpid);
        if !dead {
            kill_pid(gpid);
        }
        lines.push(format!(
            "form=aged-child-then-assign-then-derive grandchild_in_job={in_job:?} \
             grandchild_in_any_job={any_job:?} dead_after_handle_close={dead}"
        ));
        kill_pid(child.id());
    }

    for l in &lines {
        println!("[probe][q1c2] {l}");
    }

    // ①②必须抓住孙进程（这是挂起配方的全部理由）；③必须逃掉（否则说明"晚 assign"其实无害，
    // 而那样的结论与 q1c 的逃逸读数矛盾，读数需重来）。
    assert!(
        lines[0].contains("grandchild_in_job=Some(true)")
            && lines[0].contains("dead_after_handle_close=true"),
        "不挂起但**先 assign 再派生**时，孙进程必须归 Job 管并随之消失: {}",
        lines[0]
    );
    assert!(
        lines[1].contains("grandchild_in_job=Some(true)")
            && lines[1].contains("dead_after_handle_close=true"),
        "挂起→assign→resume 之后派生的孙进程必须归 Job 管: {}",
        lines[1]
    );
    assert!(
        lines[2].contains("grandchild_in_job=Some(false)")
            && lines[2].contains("dead_after_handle_close=false"),
        "派生已经在路上时再 assign，孙进程必须逃掉（这就是必须挂起的理由）: {}",
        lines[2]
    );
    assert!(
        lines[3].contains("grandchild_in_job=Some(true)")
            && lines[3].contains("dead_after_handle_close=true"),
        "子进程活了 300ms 才 assign、但 assign 仍早于派生时，孙进程仍必须被抓住\
         （⇒ 判据只有 assign 与派生的先后，与进程年龄无关）: {}",
        lines[3]
    );
}

/// **Q2**：`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `TerminateJobObject` 能不能连**孙进程**一起杀？
///
/// 见证：Job 里进程数（assign 后 = 1，孙进程起来后 = 2）；孙进程心跳计数在涨（真在跑）；
/// `TerminateJobObject` 之后**父与孙都**在 3s 内消失，且心跳计数不再变化。
#[test]
fn q2_terminate_job_kills_grandchild() {
    let dir = ProbeDir::new("q2");
    let job = Job::kill_on_close().expect("Job 必须能建");
    let mut cmd = fixture_command(&fixture_exe(), "spawn-tree", dir.dir());
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED);
    let mut child = cmd.spawn().expect("子进程必须起得来");
    let cpid = child.id();
    dir.track(cpid);
    job.assign(child.as_raw_handle() as HANDLE)
        .expect("挂起态 assign 必须成功");
    let status = unsafe { NtResumeProcess(child.as_raw_handle() as HANDLE) };
    assert_eq!(status, 0, "NtResumeProcess 必须成功");

    let saw = wait_until(|| dir.file("gc.pid").exists(), Duration::from_secs(15));
    assert!(saw, "孙进程必须在 15s 内就位");
    let gpid = read_pid(&dir.file("gc.pid")).expect("孙进程 pid 必须可读");
    dir.track(gpid);

    let hb_ok = wait_until(
        || parse_u32(&dir.file("hb.txt")).unwrap_or(0) >= 3,
        Duration::from_secs(10),
    );
    let hb_before = parse_u32(&dir.file("hb.txt")).unwrap_or(0);
    let count_before = job.process_count();
    let alive_before = (pid_alive(cpid), pid_alive(gpid));

    let t0 = Instant::now();
    job.terminate(0xDEAD_0001).expect("TerminateJobObject 必须成功");
    let parent_dead = wait_pid_dead(cpid, Duration::from_secs(3));
    let child_dead = wait_pid_dead(gpid, Duration::from_secs(3));
    let elapsed = t0.elapsed();
    std::thread::sleep(Duration::from_millis(300));
    let hb_after = parse_u32(&dir.file("hb.txt")).unwrap_or(0);
    let count_after = job.process_count();
    std::thread::sleep(Duration::from_millis(300));

    println!(
        "[probe][q2] cpid={cpid} gpid={gpid} alive_before={alive_before:?} \
         job_count_before={count_before:?} job_count_after={count_after:?} hb={hb_before}->{hb_after} \
         hb_running={hb_ok} terminate_to_dead={elapsed:?} parent_dead={parent_dead} grandchild_dead={child_dead}"
    );

    assert_eq!(alive_before, (true, true), "杀之前父子都该活着");
    assert!(hb_ok, "孙进程心跳没动，说明它没真跑起来，本读数作废");
    assert_eq!(count_before, Some(2), "Job 里应含子 + 孙共 2 个进程");
    assert_eq!(count_after, Some(0), "TerminateJobObject 之后 Job 里应为 0");
    assert!(parent_dead && child_dead, "TerminateJobObject 必须连孙进程一起收");
    assert_eq!(hb_before, hb_after, "孙进程死后心跳不该再涨（{hb_before}->{hb_after}）");
    let _ = child.wait();
}

fn parse_u32(path: &Path) -> Option<u32> {
    read_trim(path).and_then(|s| s.parse().ok())
}

/// **Q3-(a)**：不显式 `TerminateJobObject`，只**关掉最后一个 Job 句柄**，整棵树会不会自己没？
/// （= "应用退出即收尸"的最小模型：应用只握着这一个句柄）
#[test]
fn q3a_closing_last_job_handle_kills_tree() {
    let dir = ProbeDir::new("q3a");
    let job = Job::kill_on_close().expect("Job 必须能建");
    let (cpid, gpid, mut child) = spawn_tree_into_job(&dir, &job);
    assert_eq!(job.process_count(), Some(2), "Job 里应含子 + 孙共 2 个进程");

    let t0 = Instant::now();
    drop(job); // ← 唯一动作：关句柄
    let parent_dead = wait_pid_dead(cpid, Duration::from_secs(5));
    let child_dead = wait_pid_dead(gpid, Duration::from_secs(5));
    let elapsed = t0.elapsed();

    println!(
        "[probe][q3a] close_handle_to_dead={elapsed:?} parent_dead={parent_dead} grandchild_dead={child_dead}"
    );
    assert!(parent_dead && child_dead, "KILL_ON_JOB_CLOSE 必须在最后一个句柄关闭时收掉整棵树");
    let _ = child.wait();
}

/// **Q3-(b)**：`KILL_ON_JOB_CLOSE` 是否**只在句柄全关时**生效？
///
/// 做法：同一进程内 `DuplicateHandle` 出第二个 Job 句柄 → 关掉原始句柄 → 树必须**还活着**
/// （1.5s 采样）→ 再关副本（最后一个）→ 树必须死。
#[test]
fn q3b_kill_on_close_waits_for_the_last_handle() {
    let dir = ProbeDir::new("q3b");
    let job = Job::kill_on_close().expect("Job 必须能建");
    let (cpid, gpid, mut child) = spawn_tree_into_job(&dir, &job);
    let dup = job.duplicate().expect("DuplicateHandle 必须成功");
    job.close_original(); // 现在只剩 dup 一个句柄

    let t0 = Instant::now();
    std::thread::sleep(Duration::from_millis(1500));
    let alive_with_dup = (pid_alive(cpid), pid_alive(gpid));

    unsafe { CloseHandle(dup) }; // 关掉最后一个句柄
    let parent_dead = wait_pid_dead(cpid, Duration::from_secs(5));
    let child_dead = wait_pid_dead(gpid, Duration::from_secs(5));
    let elapsed = t0.elapsed();

    println!(
        "[probe][q3b] alive_with_dup_handle={alive_with_dup:?} after_last_close_dead={:?} \
         parent_dead={parent_dead} grandchild_dead={child_dead}",
        elapsed
    );
    assert_eq!(
        alive_with_dup,
        (true, true),
        "还有一份 Job 句柄在握时，KILL_ON_JOB_CLOSE 不该杀树"
    );
    assert!(parent_dead && child_dead, "最后一个句柄关闭后整棵树必须死");
    let _ = child.wait();
}

fn spawn_tree_into_job(dir: &ProbeDir, job: &Job) -> (u32, u32, Child) {
    let mut cmd = fixture_command(&fixture_exe(), "spawn-tree", dir.dir());
    cmd.stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED);
    let child = cmd.spawn().expect("子进程必须起得来");
    let cpid = child.id();
    dir.track(cpid);
    job.assign(child.as_raw_handle() as HANDLE)
        .expect("挂起态 assign 必须成功");
    assert_eq!(
        unsafe { NtResumeProcess(child.as_raw_handle() as HANDLE) },
        0,
        "NtResumeProcess 必须成功"
    );
    let saw = wait_until(|| dir.file("gc.pid").exists(), Duration::from_secs(15));
    assert!(saw, "孙进程必须在 15s 内就位");
    let gpid = read_pid(&dir.file("gc.pid")).expect("孙进程 pid 必须可读");
    dir.track(gpid);
    assert!(
        wait_until(
            || parse_u32(&dir.file("hb.txt")).unwrap_or(0) >= 3,
            Duration::from_secs(10)
        ),
        "孙进程心跳没动，读数作废"
    );
    assert_eq!(job.process_count(), Some(2), "Job 里应含子 + 孙共 2 个进程");
    (cpid, gpid, child)
}

/// **Q3-(c)**：**宿主进程自己退出**（不是关句柄，而是 `TerminateProcess(self)`）时树会不会消失？
/// 这条是"应用退出即收尸"的真身：退出时 OS 回收宿主名下所有句柄，Job 的最后一个句柄随之关闭。
///
/// 见证：`nested.txt`（宿主自己写的 assign / resume 结果）+ 孙进程心跳在退前涨过 → 宿主退出后
/// 父与孙都在 5s 内消失。
#[test]
fn q3c_host_process_exit_takes_the_tree_down() {
    let dir = ProbeDir::new("q3c");
    let mut cmd = fixture_command(&fixture_exe(), "host-exit", dir.dir());
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut host = cmd.spawn().expect("宿主夹具必须起得来");
    let hpid = host.id();
    dir.track(hpid);

    let ready = wait_until(|| dir.file("host-ready.txt").exists(), Duration::from_secs(25));
    let report = read_trim(&dir.file("nested.txt")).unwrap_or_default();
    let gpid = read_pid(&dir.file("gc.pid"));
    if let Some(p) = gpid {
        dir.track(p);
    }
    let alive_before = gpid.map(|p| (pid_alive(hpid), pid_alive(p)));

    let host_exited = wait_until(
        || matches!(host.try_wait(), Ok(Some(_))),
        Duration::from_secs(10),
    );
    let t0 = Instant::now();
    let grandchild_dead = gpid
        .map(|p| wait_pid_dead(p, Duration::from_secs(5)))
        .unwrap_or(false);
    let child_pid = read_pid(&dir.file("child.pid"));
    if let Some(p) = child_pid {
        dir.track(p);
    }
    let child_dead = child_pid
        .map(|p| wait_pid_dead(p, Duration::from_secs(5)))
        .unwrap_or(false);

    println!(
        "[probe][q3c] host={hpid} ready={ready} alive_before={alive_before:?} \
         host_exited={host_exited} child_pid={child_pid:?} child_dead={child_dead} \
         grandchild_pid={gpid:?} grandchild_dead={grandchild_dead} \
         death_within={:?} report={{ {} }}",
        t0.elapsed(),
        report.replace('\n', " ")
    );

    assert!(ready, "宿主夹具没报到（25s）");
    assert_eq!(alive_before, Some((true, true)), "宿主退出前 子+孙 都该活着");
    assert!(host_exited, "宿主夹具必须自己退出");
    assert!(child_dead, "宿主进程退出后子进程必须消失");
    assert!(grandchild_dead, "宿主进程退出后孙进程必须消失");
}

/// **Q3-(d)**：宿主**本身已经在一个 Job 里**（嵌套 Job，Win8+ 支持）时，我们自己的 Job 还灵不灵？
/// 这条专治"Job 在 Tauri 运行时下失效"的担忧：如果 app 被 IDE / 任务计划塞进 Job，内层 Job 失败就会
/// 让收尸静默失效。
#[test]
fn q3d_nested_job_still_collects_tree() {
    let dir = ProbeDir::new("q3d");
    let mut cmd = fixture_command(&fixture_exe(), "nested-host", dir.dir());
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut host = cmd.spawn().expect("嵌套宿主夹具必须起得来");
    let hpid = host.id();
    dir.track(hpid);

    let ready = wait_until(|| dir.file("host-ready.txt").exists(), Duration::from_secs(25));
    let report = read_trim(&dir.file("nested.txt")).unwrap_or_default();
    let gpid = read_pid(&dir.file("gc.pid"));
    if let Some(p) = gpid {
        dir.track(p);
    }
    let exited = wait_until(
        || matches!(host.try_wait(), Ok(Some(_))),
        Duration::from_secs(10),
    );
    let grandchild_dead = gpid
        .map(|p| wait_pid_dead(p, Duration::from_secs(5)))
        .unwrap_or(false);

    println!(
        "[probe][q3d] host={hpid} ready={ready} exited={exited} grandchild_dead={grandchild_dead} \
         report={{ {} }}",
        report.replace('\n', " ")
    );

    assert!(ready, "嵌套宿主夹具没报到（25s）");
    assert!(
        report.contains("inner_assign=Ok"),
        "内层 Job 的 assign 必须成功（否则收尸失效）: {report}"
    );
    assert!(exited, "嵌套宿主必须自己退出");
    assert!(grandchild_dead, "嵌套 Job 场景下孙进程也必须随之消失");
}

/// **Q4**：`Stdio::piped()` 的 stdout/stderr 用两条独立线程逐块读（含非 UTF-8 字节）会不会死锁？
/// 20 万行 / ≈18 MB 的吞吐是多少（任务书要的 10k 行/秒量级够不够）？
///
/// 见证：夹具在载荷前后各写一枚哨兵（`<<PROBE-BEGIN>>` / `<<PROBE-END>>`）——**libtest 自己的
/// "running 1 test / test result: ok" 也走 stdout**（首跑实测多出 156 字节，正是它），
/// 按整条流计数会假红。只认哨兵之间的字节：长度 == 行数 × 行长、`0xFF` 计数 == 行数
/// （非 UTF-8 原样穿过）、stderr 行数对得上、整个泵在超时内收尾（不死锁）。
#[test]
fn q4_log_pump_throughput_and_non_utf8_integrity() {
    const LINES: usize = 200_000;
    let line_len = probe_line().len();
    let dir = ProbeDir::new("q4");
    let mut cmd = fixture_command(&fixture_exe(), "spew", dir.dir());
    cmd.env("KOJO_PROBE_LINES", LINES.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let t0 = Instant::now();
    let mut child = cmd.spawn().expect("spew 夹具必须起得来");
    dir.track(child.id());

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_thread = std::thread::spawn(move || pump(stdout));
    let err_thread = std::thread::spawn(move || pump(stderr));

    let exited = wait_until(
        || matches!(child.try_wait(), Ok(Some(_))),
        Duration::from_secs(60),
    );
    let (out_all, out_span) = out_thread.join().expect("stdout 线程必须正常收尾");
    let (err_all, _) = err_thread.join().expect("stderr 线程必须正常收尾");
    let elapsed = t0.elapsed();

    let payload = between(&out_all, BEGUN, ENDED).expect("stdout 里必须找得到哨兵");
    let out_ff = payload.iter().filter(|b| **b == 0xFF).count();
    let out_nl = payload.iter().filter(|b| **b == b'\n').count();
    let mb = payload.len() as f64 / (1024.0 * 1024.0);
    // 吞吐按"泵收字节的时间跨度"算（不含子进程启动 / libtest 启动），端到端另记一份。
    let span = out_span.max(Duration::from_millis(1));
    let lines_per_sec = LINES as f64 / span.as_secs_f64();
    let mb_per_sec = mb / span.as_secs_f64();
    let err_lines = err_all
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .count();

    println!(
        "[probe][q4] lines={LINES} line_len={line_len} payload_bytes={} raw_stdout_bytes={} \
         raw_stderr_bytes={} stderr_lines={err_lines} ff_bytes={out_ff} nl={out_nl} \
         pump_span={span:?} end_to_end={elapsed:?} \
         throughput={lines_per_sec:.0} lines/s = {mb_per_sec:.1} MiB/s exited={exited}",
        payload.len(),
        out_all.len(),
        err_all.len()
    );

    assert!(exited, "spew 夹具必须在 60s 内退出（否则就是泵死锁）");
    assert_eq!(
        payload.len(),
        LINES * line_len,
        "哨兵之间的字节数必须逐字节对上"
    );
    assert_eq!(out_nl, LINES, "行数必须对得上");
    assert_eq!(out_ff, LINES, "非 UTF-8 字节 0xFF 必须原样穿过（每行一枚）");
    assert!(err_lines > 0, "stderr 通道必须也读到了数据");
    assert!(
        lines_per_sec > 10_000.0,
        "吞吐必须显著高于 10k 行/秒（实测 {lines_per_sec:.0}）"
    );
}

/// 哨兵：夹具在载荷前后各写一枚，测试只认它俩之间的字节。
const BEGUN: &[u8] = b"<<PROBE-BEGIN>>\n";
const ENDED: &[u8] = b"<<PROBE-END>>\n";

/// 逐块读到 EOF，返回**原始字节全量** + 首块到末块的时间跨度（= 泵的真实吞吐口径）。
fn pump(mut r: impl Read) -> (Vec<u8>, Duration) {
    let mut buf = vec![0u8; 1 << 18];
    let mut all: Vec<u8> = Vec::new();
    let mut first: Option<Instant> = None;
    let mut last = Instant::now();
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if first.is_none() {
                    first = Some(Instant::now());
                }
                last = Instant::now();
                all.extend_from_slice(&buf[..n]);
            }
            Err(_) => break,
        }
    }
    let span = first.map(|f| last - f).unwrap_or_default();
    (all, span)
}

fn between<'a>(hay: &'a [u8], open: &[u8], close: &[u8]) -> Option<&'a [u8]> {
    let start = find_sub(hay, open)? + open.len();
    let end = find_sub(&hay[start..], close)? + start;
    Some(&hay[start..end])
}

fn find_sub(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// **Q4-(b)**：**先堵满 stderr、再写 stdout** 的对抗性输出（顺序读必死锁）在并发读下能不能过？
#[test]
fn q4b_no_deadlock_when_stderr_fills_first() {
    let dir = ProbeDir::new("q4b");
    let mut cmd = fixture_command(&fixture_exe(), "spew-both", dir.dir());
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let t0 = Instant::now();
    let mut child = cmd.spawn().expect("spew-both 夹具必须起得来");
    dir.track(child.id());
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_thread = std::thread::spawn(move || pump(stdout));
    let err_thread = std::thread::spawn(move || pump(stderr));

    let exited = wait_until(
        || matches!(child.try_wait(), Ok(Some(_))),
        Duration::from_secs(45),
    );
    let (out_all, out_span) = out_thread.join().expect("stdout 线程必须正常收尾");
    let (err_all, err_span) = err_thread.join().expect("stderr 线程必须正常收尾");
    let out_payload = between(&out_all, BEGUN, ENDED);
    let err_payload = between(&err_all, BEGUN, ENDED);
    println!(
        "[probe][q4b] stdout_payload={:?} stderr_payload={:?} raw_stdout={} raw_stderr={} \
         spans={out_span:?}/{err_span:?} exited={exited} elapsed={:?}",
        out_payload.map(|p| p.len()),
        err_payload.map(|p| p.len()),
        out_all.len(),
        err_all.len(),
        t0.elapsed()
    );
    assert!(exited, "对抗性输出下泵必须不死锁（45s 内收尾）");
    assert_eq!(
        out_payload.map(|p| p.len()),
        Some(1 << 20),
        "stdout 必须收满 1 MiB"
    );
    assert_eq!(
        err_payload.map(|p| p.len()),
        Some(1 << 20),
        "stderr 必须收满 1 MiB"
    );
    assert!(
        out_payload.unwrap().iter().all(|b| *b == 0xFF),
        "对抗载荷必须逐字节保真（全 0xFF）"
    );
}

/// **Q5**：`env_clear()` + 显式追加之后，子进程真的拿不到宿主环境吗？`CREATE_SUSPENDED` 能否同用？
///
/// 三档：继承（对照）→ `env_clear` + 3 个显式变量（std 路线）→ 同上但挂起创建（证明两者不冲突）。
#[test]
fn q5_env_whitelist_and_suspended_combo() {
    let dir = ProbeDir::new("q5");

    // ① 对照：不清环境 ⇒ 宿主设的 HTTP_PROXY 会被继承
    let mut cmd = fixture_command(&fixture_exe(), "env-dump", dir.dir());
    cmd.env("HTTP_PROXY", "http://inherit.example:1234")
        .env("KOJO_PROBE_CUSTOM", "from-host");
    let mut child = cmd.spawn().expect("对照进程必须起得来");
    dir.track(child.id());
    assert!(wait_until(
        || dir.file("env.txt").exists(),
        Duration::from_secs(15)
    ));
    let _ = child.wait();
    let inherited = read_trim(&dir.file("env.txt")).unwrap_or_default();
    let inherited_count = env_count(&inherited);

    // ② env_clear + 白名单（std 路线）
    fs::remove_file(dir.file("env.txt")).ok();
    let mut cmd = fixture_command(&fixture_exe(), "env-dump", dir.dir());
    cmd.env_clear()
        .env("PATH", r"C:\Windows\System32")
        .env("KOJO_PROBE_CUSTOM", "from-whitelist")
        .env(ROLE_ENV, "env-dump")
        .env(DIR_ENV, dir.dir().display().to_string());
    let mut child = cmd.spawn().expect("白名单进程必须起得来");
    dir.track(child.id());
    assert!(wait_until(
        || dir.file("env.txt").exists(),
        Duration::from_secs(15)
    ));
    let _ = child.wait();
    let cleared = read_trim(&dir.file("env.txt")).unwrap_or_default();
    let cleared_count = env_count(&cleared);

    // ③ env_clear + CREATE_SUSPENDED（两者同用）
    fs::remove_file(dir.file("env.txt")).ok();
    let mut cmd = fixture_command(&fixture_exe(), "env-dump", dir.dir());
    cmd.env_clear()
        .env("PATH", r"C:\Windows\System32")
        .env("KOJO_PROBE_CUSTOM", "from-whitelist")
        .env(ROLE_ENV, "env-dump")
        .env(DIR_ENV, dir.dir().display().to_string())
        .creation_flags(CREATE_SUSPENDED);
    let mut child = cmd.spawn().expect("挂起+白名单进程必须起得来");
    dir.track(child.id());
    std::thread::sleep(Duration::from_millis(300));
    let witness_while_suspended = dir.file("env.txt").exists();
    assert_eq!(
        unsafe { NtResumeProcess(child.as_raw_handle() as HANDLE) },
        0,
        "NtResumeProcess 必须成功"
    );
    assert!(wait_until(
        || dir.file("env.txt").exists(),
        Duration::from_secs(15)
    ));
    let _ = child.wait();
    let suspended_dump = read_trim(&dir.file("env.txt")).unwrap_or_default();
    let suspended_count = env_count(&suspended_dump);

    println!(
        "[probe][q5] inherit={{count={inherited_count} http_proxy={} }} \
         cleared={{count={cleared_count}}} suspended_cleared={{count={suspended_count} \
         witness_while_suspended={witness_while_suspended}}}",
        env_field(&inherited, "HTTP_PROXY")
    );
    println!(
        "[probe][q5] cleared_dump=[{}] suspended_dump=[{}]",
        cleared.replace('\n', " | "),
        suspended_dump.replace('\n', " | ")
    );

    // 对照档：宿主环境是继承来的，行数必然远多于 4 个白名单项
    assert!(
        inherited_count > 10,
        "对照组证明不清环境时会继承宿主环境（实测只看到 {inherited_count} 个变量，读数作废）"
    );
    assert!(
        env_field(&inherited, "HTTP_PROXY").starts_with("present\thttp://inherit.example"),
        "对照组必须能看见宿主设的 HTTP_PROXY: {}",
        env_field(&inherited, "HTTP_PROXY")
    );
    // 白名单档：只剩 4 个（3 个显式 + KOJO_PROBE_DIR 也算显式；ROLE 亦显式）
    assert_eq!(cleared_count, 4, "env_clear 后应恰有 4 个变量: {cleared}");
    assert!(
        env_field(&cleared, "HTTP_PROXY").starts_with("absent"),
        "env_clear 后 HTTP_PROXY 必须不可见: {}",
        env_field(&cleared, "HTTP_PROXY")
    );
    assert!(
        env_field(&cleared, "PATH").starts_with("present\tC:\\\\Windows\\\\System32"),
        "显式追加的 PATH 必须原样到位: {}",
        env_field(&cleared, "PATH")
    );
    assert!(
        env_field(&cleared, "SystemRoot").starts_with("absent"),
        "SystemRoot 也不该漏进来（证明不是只挡了一个变量）"
    );
    assert_eq!(
        (suspended_count, suspended_dump.as_str()),
        (cleared_count, cleared.as_str()),
        "CREATE_SUSPENDED 与 env_clear 必须互不影响"
    );
    assert!(!witness_while_suspended, "挂起档必须真挂起");
}

fn env_count(dump: &str) -> usize {
    dump.lines()
        .find_map(|l| l.strip_prefix("COUNT="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn env_field(dump: &str, key: &str) -> String {
    dump.lines()
        .find(|l| l.starts_with(&format!("{key}\t")))
        .map(|l| l[key.len() + 1..].to_string())
        .unwrap_or_default()
}

/// **Q5-(b)**：自己拼 env 块（`CreateProcessW` 路线）能不能得到同一份白名单？
/// 这条是路线 (a) 的第二项成本：**env 块要自己排好序、自己 UTF-16 编码、自己补双 `\0`**。
#[test]
fn q5b_env_block_built_by_hand() {
    let dir = ProbeDir::new("q5b");
    let exe = fixture_exe();
    let mut env = BTreeMap::new();
    env.insert(ROLE_ENV.to_string(), "env-dump".to_string());
    env.insert(DIR_ENV.to_string(), dir.dir().display().to_string());
    env.insert("PATH".to_string(), r"C:\Windows\System32".to_string());
    env.insert("KOJO_PROBE_CUSTOM".to_string(), "from-manual-block".to_string());

    let argv: Vec<String> = vec![
        exe.display().to_string(),
        "--exact".to_string(),
        "--ignored".to_string(),
        FIXTURE_NAME.to_string(),
    ];
    let child = RawChild::create(&argv, &env, false, None, None).expect("CreateProcessW 必须成功");
    dir.track(child.pid);
    let saw = wait_until(|| dir.file("env.txt").exists(), Duration::from_secs(15));
    let code = child.wait_exit(Duration::from_secs(15));
    let dump = read_trim(&dir.file("env.txt")).unwrap_or_default();

    println!(
        "[probe][q5b] saw={saw} exit={code:?} dump=[{}]",
        dump.replace('\n', " | ")
    );
    assert!(saw, "手拼 env 块的子进程必须落盘");
    assert_eq!(code, Some(0), "子进程退出码必须是 0");
    assert_eq!(env_count(&dump), 4, "手拼 env 块应恰有 4 个变量: {dump}");
    assert!(env_field(&dump, "HTTP_PROXY").starts_with("absent"));
    assert!(env_field(&dump, "PATH").starts_with("present\tC:\\\\Windows\\\\System32"));
}

/// **Q6**：带 `&`、`|`、空格、引号、空串、中文、`%VAR%` 的 argv 是否原样到达（不经 shell）？
/// 走 std 路线的直传（`Command` 语义 = argv 数组）。
#[test]
fn q6_argv_passthrough_via_std_command() {
    let dir = ProbeDir::new("q6");
    let payload = tricky_args();
    let mut cmd = fixture_command(&fixture_exe(), "echo-args", dir.dir());
    for a in &payload {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().expect("argv 夹具必须起得来");
    dir.track(child.id());
    assert!(wait_until(
        || dir.file("args.txt").exists(),
        Duration::from_secs(15)
    ));
    let code = wait_until(
        || matches!(child.try_wait(), Ok(Some(_))),
        Duration::from_secs(15),
    );
    let _ = child.wait();
    let dump = fs::read_to_string(dir.file("args.txt")).unwrap_or_default();
    let seen: Vec<String> = dump.lines().map(|s| s.to_string()).collect();
    let tail: Vec<String> = seen
        .iter()
        .rev()
        .take(payload.len())
        .rev()
        .cloned()
        .collect();
    let expect: Vec<String> = payload.iter().map(|a| esc(a)).collect();

    println!(
        "[probe][q6] spawned_exited={code} argc={} tail=[{}]",
        seen.len(),
        tail.join(" , ")
    );
    assert_eq!(tail, expect, "std 路线 argv 必须逐字原样到达（含 &、|、空格、引号、空串）");
}

/// **Q6-(b)**：同一批 argv 走 `CreateProcessW` 的手拼命令行 —— 验证 `win_quote` 与 CRT 解析对得上。
#[test]
fn q6b_argv_passthrough_via_create_process_w() {
    let dir = ProbeDir::new("q6b");
    let payload = tricky_args();
    let exe = fixture_exe();
    let mut argv: Vec<String> = vec![
        exe.display().to_string(),
        "--exact".to_string(),
        "--ignored".to_string(),
        FIXTURE_NAME.to_string(),
    ];
    argv.extend(payload.iter().cloned());

    let mut env = BTreeMap::new();
    env.insert(ROLE_ENV.to_string(), "echo-args".to_string());
    env.insert(DIR_ENV.to_string(), dir.dir().display().to_string());

    let child = RawChild::create(&argv, &env, false, None, None).expect("CreateProcessW 必须成功");
    dir.track(child.pid);
    assert!(wait_until(
        || dir.file("args.txt").exists(),
        Duration::from_secs(15)
    ));
    let code = child.wait_exit(Duration::from_secs(15));
    let dump = fs::read_to_string(dir.file("args.txt")).unwrap_or_default();
    let seen: Vec<String> = dump.lines().map(|s| s.to_string()).collect();
    let tail: Vec<String> = seen
        .iter()
        .rev()
        .take(payload.len())
        .rev()
        .cloned()
        .collect();
    let expect: Vec<String> = payload.iter().map(|a| esc(a)).collect();

    println!(
        "[probe][q6b] argc={} exit={code:?} tail=[{}]",
        seen.len(),
        tail.join(" , ")
    );
    assert_eq!(code, Some(0), "子进程退出码必须是 0");
    assert_eq!(tail, expect, "手拼命令行必须与 argv 数组逐字等价（含空串 / 尾反斜杠 / 引号）");
}

/// 一批"会咬人"的 argv：shell 元字符、空白、引号、空串、尾反斜杠、`%VAR%`、中文。
fn tricky_args() -> Vec<String> {
    vec![
        "a&b".to_string(),
        "c|d".to_string(),
        "e f  g".to_string(),
        r#"g"h"#.to_string(),
        String::new(),
        r"i\j\".to_string(),
        "中文口上".to_string(),
        "  lead".to_string(),
        "^!%.*".to_string(),
        "semi;colon".to_string(),
        "%PATH%".to_string(),
        "tab\there".to_string(),
    ]
}
