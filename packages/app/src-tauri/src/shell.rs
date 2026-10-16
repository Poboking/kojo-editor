//! 「在系统资源管理器中显示」的 OS 原语：拉起外部文件管理器并选中目标。
//!
//! **天然只读**（铁律 6 之外的零接触区）：这条链路不打开任何文件句柄、不创建 /
//! 改名 / 删除任何盘上内容——它只向 OS 派发一个"请打开你的文件管理器"的进程请求，
//! 之后的一切（窗口、选中高亮）都发生在本进程之外。因此它**不碰
//! `WriteDomainState`、不需要任何允许域检查**，形态与 `choose_directory` 同类
//! （纯"唤起 OS UI"原语），不需要也不应该有写路径判据。
//!
//! 平台派发（`#[cfg]` 只出现在 `current_target_os` 一个点）：
//! - Windows：`explorer /select,"<path>"`（实测结论见 `reveal_command` 注释）
//! - macOS：`open -R <path>`（Finder 中显示；**未实测**——本机只有 Windows）
//! - Linux：`xdg-open <父目录>`（Linux 无"选中"协议，只能开到所在文件夹；**未实测**）

use std::path::Path;

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

/// 「在系统资源管理器中显示」：只读原语，见模块头注释。
/// 失败只可能是「目标不存在」或「拉不起文件管理器进程」，中文人话返回。
pub(crate) fn reveal_in_folder(path: &Path) -> Result<(), String> {
    let shown = path.display().to_string();
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
#[tauri::command]
pub(crate) fn show_in_folder(path: String) -> Result<(), String> {
    reveal_in_folder(Path::new(&path))
}
