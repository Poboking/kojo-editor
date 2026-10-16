//! 「唤起 OS」类原语：**在资源管理器中显示**（拉起外部文件管理器并选中目标）与
//! **在系统浏览器打开外链**（拉起默认浏览器访问白名单 https URL）。
//!
//! 两条都**天然只读**（铁律 6 之外的零接触区）：不打开任何文件句柄、不创建 /
//! 改名 / 删除任何盘上内容——只向 OS 派发一个"请打开你的某程序"的进程请求，
//! 之后的一切（窗口、浏览器页面）都发生在本进程之外。因此**不碰
//! `WriteDomainState`、不需要任何允许域检查**，形态与 `choose_directory` 同类
//! （纯"唤起 OS UI"原语），不需要也不应该有写路径判据。
//!
//! 平台派发（`#[cfg]` 只出现在 `current_target_os` 一个点）：
//! - reveal：Windows `explorer /select,"<path>"`（实测结论见 `reveal_command` 注释）、
//!   macOS `open -R <path>`（Finder 中显示；**未实测**——本机只有 Windows）、
//!   Linux `xdg-open <父目录>`（Linux 无"选中"协议，只能开到所在文件夹；**未实测**）
//! - 外链：Windows `explorer <url>` / macOS `open <url>` / Linux `xdg-open <url>`（见 `open_url_command`）

use std::path::Path;

use crate::market::url_problem;

/* ---------------------------- 纯判定（可单测） ---------------------------- */

/// 目标平台：判据的参数化替身。真平台只在派发点经 `current_target_os` 进来一次，
/// 纯函数吃这个枚举 ⇒ 三个平台的 argv 构造在**任何**开发机上都能被单测钉住。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetOs {
    Windows,
    MacOS,
    Linux,
}

pub(crate) fn current_target_os() -> TargetOs {
    if cfg!(target_os = "windows") {
        TargetOs::Windows
    } else if cfg!(target_os = "macos") {
        TargetOs::MacOS
    } else {
        TargetOs::Linux
    }
}

/// 派发给 OS 的完整命令（程序名 + argv），由 `reveal_command` 纯构造。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RevealCommand {
    pub program: &'static str,
    pub args: Vec<String>,
}

/// Windows 修剪尾巴后的路径必须还站得住：盘符根 `C:\` 剪成 `C:` 会让 explorer
/// 去选中"驱动器"这一怪目标；至少留回一个分隔符。
pub(crate) fn trim_trailing_separators(raw: &str) -> String {
    let trimmed = raw.trim_end_matches(['\\', '/']);
    if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' {
        // `C:` → `C:\`（explorer 的 /select 对裸盘符行为未定义，别赌）
        return format!("{trimmed}\\");
    }
    trimmed.to_string()
}

/// 路径 → 平台命令 argv 的**纯构造**（不碰进程、不碰磁盘）。
///
/// 实测/查证结论（Windows）：
/// - 正确形态是 `/select,` 与路径**之间没有空格**、路径整体带引号：
///   `/select,"C:\my dir\a.ERB"`。带空格的 `/select, "C:\..."` 会退化为"打开默认
///   文件夹、不选中"。
/// - `std::process::Command` 的普通 `.arg()` 会按 MSVCRT 规则给含空格的参数**整体
///   加引号**，把 `/select,` 一起包进去变成 `"/select,C:\..."`——explorer 直接忽略。
///   因此派发点必须用 `CommandExt::raw_arg`（原样拼接、不加引号），引号由本函数
///   自带在字符串里（Windows 路径不可能含 `"`，无注入面）。
/// - 目录目标同样有效：`/select,"<目录>"` = 在父文件夹里选中该目录，无需分叉。
/// - **explorer 的退出码不可信**：成功也常返回 1，故派发点只认 `spawn()` 本身的
///   错误，绝不用 exit code 判成败。
pub(crate) fn reveal_command(os: TargetOs, path: &Path) -> RevealCommand {
    match os {
        TargetOs::Windows => {
            let p = trim_trailing_separators(&path.display().to_string());
            RevealCommand {
                program: "explorer",
                args: vec![format!("/select,\"{p}\"")],
            }
        }
        // macOS：`open -R` 在 Finder 里显示并选中（文件与目录都支持）。
        // **未实测**（开发机是 Windows）：形态来自 `man open` 的 -R 语义。
        TargetOs::MacOS => RevealCommand {
            program: "open",
            args: vec!["-R".to_string(), path.display().to_string()],
        },
        // Linux：没有跨 DE 的"选中"协议，`xdg-open` 只能开目录 ⇒ 开**父目录**，
        // 让用户自己看到目标。目标没有父目录（根）就开它本身。
        // **未实测**（开发机是 Windows）：xdg-open 对文件会调默认应用，所以必须传父目录。
        TargetOs::Linux => {
            let dir = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(path);
            RevealCommand {
                program: "xdg-open",
                args: vec![dir.display().to_string()],
            }
        }
    }
}

/* ---------------------------- 派发（副作用） ---------------------------- */

/// UNC 路径判定（纯函数，可单测）：以 `\\` 开头的网络命名空间路径。
///
/// 交给 explorer / 做 `path.exists()` 之前必须早退拒掉：`\\attacker\share` 会让
/// `exists()` 触发 SMB 认证、**泄漏 NTLM 凭据**并阻塞调用线程最长约 30 秒；本原语天然只读，
/// 更没有理由为"显示一个文件"去够网络路径。`\\?\` 设备命名空间前缀同理一并拒（本地路径
/// 从不需要它，而它同样能裹住 UNC/怪路径）。
pub(crate) fn unc_path_problem(path: &str) -> Option<String> {
    if path.starts_with(r"\\") {
        Some(format!("拒绝网络/设备命名空间路径（UNC）：{path}"))
    } else {
        None
    }
}

/// 「在系统资源管理器中显示」：只读原语，见模块头注释。
/// 失败只可能是「目标不存在」或「拉不起文件管理器进程」，中文人话返回。
pub(crate) fn reveal_in_folder(path: &Path) -> Result<(), String> {
    let shown = path.display().to_string();
    if let Some(problem) = unc_path_problem(&shown) {
        return Err(problem);
    }
    if !path.exists() {
        return Err(format!("路径不存在，无法在资源管理器中显示：{shown}"));
    }
    let cmd = reveal_command(current_target_os(), path);
    let mut command = std::process::Command::new(cmd.program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        // 引号已由 reveal_command 自带（见其注释），raw_arg 原样拼接、绝不再加工
        for a in &cmd.args {
            command.raw_arg(a);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        command.args(&cmd.args);
    }
    // 只认 spawn 失败（程序不存在 / 权限拒绝）；explorer 的非零退出码**不是**失败
    // （成功也常返回 1），所以不 wait、不看 code——窗口开没开是用户看得见的事。
    match command.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!(
            "无法打开系统资源管理器（{}）：{e}",
            cmd.program
        )),
    }
}

/// Tauri 命令：`show_in_folder(path)`。
///
/// 天然只读、无写盘副作用 ⇒ 不取 `WriteDomainState`、不做允许域检查（见模块头）。
/// `async` + `spawn_blocking`：`path.exists()` 是可能触盘的阻塞调用，主线程（WebView IPC 线程）
/// 上跑它——即便已拒 UNC，一个慢/离线卷仍会冻住界面 ⇒ 挪到阻塞线程池，形态照 `search_text`。
#[tauri::command]
pub(crate) async fn show_in_folder(path: String) -> Result<(), String> {
    if let Some(problem) = unc_path_problem(&path) {
        return Err(problem);
    }
    tauri::async_runtime::spawn_blocking(move || reveal_in_folder(Path::new(&path)))
        .await
        .map_err(|e| format!("在资源管理器中显示线程失败：{e}"))?
}

/* ---------------------------- 外链（浏览器打开） ---------------------------- */

/// 外链双闸（纯判定）：scheme 必须 https、主机过市场白名单。
///
/// 判定**整体复用** market 的 `url_problem` 而不是自己再写一份——那正是"第二份
/// 真相必然漂"的形状：能被下载闸放行的 URL 才可能出现在索引 `sourceUrl` 上，
/// 外开闸与它是同一份函数（userinfo / 非默认端口两闸是顺带的加固，不是分叉）。
/// 返回 WHATWG 规范化后的 URL 串供 argv 使用（`Ok` = 放行，`Err` = 拒因直接可示人）。
pub(crate) fn external_url_problem(raw: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw).map_err(|e| format!("URL 解析失败 {raw}: {e}"))?;
    if let Some(problem) = url_problem(&parsed) {
        return Err(format!("外链被平台闸拒绝（{problem}）"));
    }
    Ok(parsed.to_string())
}

/// 派发给 OS 的外链命令（程序名 + argv），由 `open_url_command` 纯构造。
pub(crate) struct ExternalUrlCommand {
    pub program: &'static str,
    pub args: Vec<String>,
}

/// URL → 平台命令 argv 的**纯构造**（不碰进程）。
///
/// URL **恒是单个 argv 元素**，三平台同形、只有程序名不同——`cmd /c start` 那条路
/// 是注入洞（URL 里的 `&` / 空格会逃逸成 shell 语法），本原语从形态上封死它：
/// `std::process::Command` 直接把 argv 交给 OS，不存在解释层。
/// （explorer / open / xdg-open 对单参 URL 都交给默认浏览器处理。）
pub(crate) fn open_url_command(os: TargetOs, url: &str) -> ExternalUrlCommand {
    let program = match os {
        TargetOs::Windows => "explorer",
        TargetOs::MacOS => "open",
        TargetOs::Linux => "xdg-open",
    };
    ExternalUrlCommand { program, args: vec![url.to_string()] }
}

/// 「在系统浏览器打开外链」：只读原语，见模块头。
/// 闸（双闸见 `external_url_problem`）的**唯一执法点**就在这里——TS 侧不复制白名单。
pub(crate) fn spawn_external_url(raw: &str) -> Result<(), String> {
    let url = external_url_problem(raw)?;
    let cmd = open_url_command(current_target_os(), &url);
    let mut command = std::process::Command::new(cmd.program);
    // URL 无引号需求（WHATWG 序列化不出 `"` 与裸空格），普通 arg 走标准 argv 通道；
    // 不经 shell ⇒ 参数内容不可能变成命令语法。
    command.args(&cmd.args);
    // 只认 spawn 失败（程序不存在 / 权限拒绝）；浏览器开没开是用户看得见的事，不 wait。
    match command.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("无法调用系统浏览器（{}）：{e}", cmd.program)),
    }
}

/// Tauri 命令：`open_url_external(url)`。
///
/// 天然只读、无写盘副作用 ⇒ 不取 `WriteDomainState`、不做允许域检查（见模块头）；
/// 出网面的闸（https + 主机白名单）即在本函数链路内，插件侧与 JS 桥都不复述。
#[tauri::command]
pub(crate) fn open_url_external(url: String) -> Result<(), String> {
    spawn_external_url(&url)
}
