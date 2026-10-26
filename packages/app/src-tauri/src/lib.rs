//! kojo-editor Tauri 宿主。
//!
//! 本层的全部职责 = 为 WebView 内的内核提供 **PlatformBridge 原语**：
//! 文件字节读写（原子写）、目录遍历、编解码（encoding_rs）、目录对话框、应用数据目录、
//! 文件监视（notify 原始事件转发；去抖与判定在内核 TS）。
//! **零游戏知识、零业务逻辑**——一切领域逻辑都在前端的内核与插件中。
//!
//! 二进制数据经 base64 字符串跨 IPC（确定性强；口上文件体量下开销可忽略）。

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::Event;
use regex::Regex;
use serde::{Deserialize, Serialize};

/// 市场 IO 原语（远程下载 + ZIP 安全解压）独立成文件：它自带一整套安全闸与 fixture，
/// 塞进本文件会把既有 IO 正文淹掉（照 `search_tests` 的分文件先例）。
mod market;

/// 归档容器守卫（ZIP 容器原语与解压安全闸）：市场解压与启动器（内容包 / 存档备份 / 整合包）
/// 复用同一份实现，不复制第二份；网络与发布面留在 `market`。
mod archive_guard;

/// OS 外壳原语（在系统资源管理器中显示）：只读、无写盘副作用，独立成文件
/// 照 `market` 同形态。
mod shell;

/// 崩溃取证 + 单实例配套的日志落盘（P0-3）：panic hook 直写 + 前端兜底日志 + 轮转。
/// 独立成文件，照 `market` / `shell` 同形态。
mod diagnostics;

/// 更新检查的环境代理（REL-1 收尾）：读标准环境变量交前端透传进 updater 的
/// `check({ proxy })`；独立成文件，照 `market` / `shell` 同形态。
mod updater_proxy;

/* --------------------- 写允许域（审阅 M3：纵深防御） --------------------- */
//
// JS 层 kernel io 的 writablePaths 白名单是第一道闸；本层是第二道闸：
// 即便 JS 层被绕过，Rust 命令也只接受「允许域」内的写路径。
//
// 允许域 = 项目根目录（project.opened 时经 `register_write_domain` 注册；project.closed 后清除）
//        + appDataDir（备份 / 配置 / 存储，常驻允许）。
// 注册本身带**准入门**：`register_write_domain` 只接受宿主亲自交付过的目录（系统目录对话框
// 选定项 / OS 拖放），JS 凭空递一个路径不会成为项目根。
// 其余路径一律拒绝并返回明确错误（不静默、fail-closed）。
//
// 判定域语义与 kernel writablePaths 一致：项目根目录整体（含游戏目录）。
// 注意 JS 层的 writablePaths 是项目根的**子集**（用户显式批准）——
// 语义以更严者为准，双闸并存不冲突。

/// Tauri 托管状态：当前注册的项目根目录（None = 仅 appDataDir 可写）
/// + **常驻授权的项目位置根**（`extra_roots`，2026-10-14 新建项目自选位置批）
/// + **宿主亲自见过的可开项目根**（`approved_roots`）。
///
/// `extra_roots` 的唯一来源是 `choose_workspace_root` 里**用户在系统目录对话框中选定**
/// 的目录（对话框即授权）与磁盘清单 `<appDataDir>/workspace_roots.txt` 的读回。
///
/// `approved_roots` 是 `register_write_domain` 的**准入门**：只有**由宿主亲自交付给 WebView
/// 的路径**才进得来——即系统目录对话框返回的选定项（`choose_directory` / `choose_workspace_root`）
/// 与 OS 文件拖放（`WindowEvent::DragDrop` 的 drop 相位）交来的目录。清单同样落盘
/// `<appDataDir>/approved_roots.txt`，故"最近项目 / 常驻根"重开时其根早已在册、照常放行。
/// **没有任何命令接受路径参数来授予写权限**——JS 侧递来一个字符串就放行的入口不存在；
/// `register_write_domain` 只把"确实被宿主交出去过"的目录（或其子目录）认作项目根。
/// 这两份清单本身就是凭据 ⇒ 命令侧对它们一律拒写（`is_reserved_state_file`，
/// 拦写入 / 改名 / 拷贝 / 删除），只有宿主的 `read_*` / `write_*` 私有函数能改。
#[derive(Default)]
struct WriteDomainState {
    project_root: Mutex<Option<PathBuf>>,
    extra_roots: Mutex<Vec<PathBuf>>,
    approved_roots: Mutex<Vec<PathBuf>>,
    /// **允许域根的规范化备忘录**（PS-1 加速层，2026-10-18）。
    /// 键 = 注册表里的原始写法，值 = `canonicalize_deep` 的成功结果。
    /// 命中只在该原始路径**此刻仍是目录**时才采信，否则作废重算 ⇒
    /// 判定结果与"每次写都重新 canonicalize 一遍根"逐字相同（含根解析失败的错误文案），
    /// 省掉的只是重复的系统调用与两份 Vec 克隆。被任何根变更点整体清空。
    canon_roots: Mutex<HashMap<PathBuf, PathBuf>>,
    /// **备忘录代际**（短锁版专用）：`invalidate_canon_roots` 先抬代际再清表。
    /// 短锁版在 `is_dir` / `canonicalize_deep` 期间不持锁，若只靠"清表"，
    /// 在途的旧计算会在清表后把陈旧根重新插回去（等于越过了那次变更）。
    /// 命中与写入各复核一次代际：代际变了就不采信/不落缓存 ⇒ 陈旧条目不会复活。
    canon_epoch: AtomicU64,
    /// **允许域变更序号**（REF-FRONT-PERF，2026-10-20）：`register_write_domain` 改 async 后，
    /// 它的"规范化 + 准入门判定"在阻塞线程池上跑，期间 `clear_write_domain`（项目关闭）或另一次
    /// 注册可能插进来——旧实现全在主线程、天然串行。判定前取快照 + 落定前复核把顺序找回来：
    /// 落定与清除共用 `project_root` 锁，序号不等 = 期间发生过清除/成功落定 ⇒ 本次作废
    /// （fail-closed 报错，决不把已关闭的项目根复活）。
    /// **只有成功落定才抬代际**：判定失败本身不是一次允许域变更，不许作废另一个在途的成功注册。
    domain_epoch: AtomicU64,
}

/// 观察当前「允许域变更」序号（register 在耗时判定前取快照；落定前复核）。
/// **不抬代际**：判定失败不得取消在途的成功注册。
fn domain_change_snapshot(state: &WriteDomainState) -> u64 {
    state.domain_epoch.load(Ordering::SeqCst)
}

/// 注册落定：复核取快照后允许域没被并发变更，再写入项目根并抬代际。
/// 与清除共用 `project_root` 锁 ⇒ "检查—落定"与清除线性化（后发生的清除恒胜）；
/// 两个同时通过判定的注册也由此串行，先落定者胜、后者的快照已过期 ⇒ fail-closed。
fn commit_project_root(
    state: &WriteDomainState,
    root: PathBuf,
    observed: u64,
) -> Result<(), String> {
    let mut guard = state
        .project_root
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?;
    if state.domain_epoch.load(Ordering::SeqCst) != observed {
        return Err(
            "可写范围注册被并发变更取消（判定期间项目被关闭或换开）：请重新打开项目".to_string(),
        );
    }
    state.domain_epoch.fetch_add(1, Ordering::SeqCst);
    *guard = Some(root);
    drop(guard);
    // 允许域变了 ⇒ 规范化备忘录整体作废（见 `canonical_root_cached`）
    invalidate_canon_roots(state);
    Ok(())
}

/// 清除的同步核心（命令侧只是包装；单测直接打这一层）：抬代际（在途注册一律作废）+ 清根。
fn clear_domain_core(state: &WriteDomainState) -> Result<(), String> {
    let mut guard = state
        .project_root
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?;
    state.domain_epoch.fetch_add(1, Ordering::SeqCst);
    *guard = None;
    drop(guard);
    invalidate_canon_roots(state);
    Ok(())
}

/// 规范化路径：找到最深的已存在祖先做 canonicalize（解析 `..` 与符号链接），
/// 再把其余组件追加回去。不存在于磁盘的目标（原子写的待建文件）同样可判定。
fn canonicalize_deep(path: &Path) -> std::io::Result<PathBuf> {
    let mut cur = path;
    let mut extra: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match cur.canonicalize() {
            Ok(canon) => {
                let mut result = canon;
                for seg in extra.into_iter().rev() {
                    result.push(seg);
                }
                return Ok(result);
            }
            Err(_) => match (cur.parent(), cur.file_name()) {
                (Some(parent), Some(name)) => {
                    extra.push(name.to_os_string());
                    cur = parent;
                }
                _ => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "no existing ancestor to canonicalize",
                    ))
                }
            },
        }
    }
}

/// 路径 → 小写组件序列（Windows 大小写不敏感；同义写法折叠成同一个键）。
fn lowered_components(p: &Path) -> Vec<String> {
    p.components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// 组件级前缀比较（Windows 大小写不敏感；`foo` 与 `foobar` 不会误判为包含）。
fn is_within(canonical_path: &Path, canonical_root: &Path) -> bool {
    let p = lowered_components(canonical_path);
    let r = lowered_components(canonical_root);
    p.len() >= r.len() && p.iter().zip(r.iter()).all(|(a, b)| a == b)
}

/// 同一个目录的两种写法（大小写 / 尾分隔符）算一个根：整串组件相等才算。
fn is_same_path(a: &Path, b: &Path) -> bool {
    lowered_components(a) == lowered_components(b)
}

/// 追加常驻授权根（按规范化路径去重）；返回是否真的新增。
/// 去重要经 `canonicalize_deep`——对话框回来的路径常带 `\\?\` 前缀或大小写差异，
/// 纯字符串比较会把同一个目录认成两次授权。
fn push_extra_root(list: &mut Vec<PathBuf>, root: &Path) -> bool {
    let same = |p: &Path| -> bool {
        match (canonicalize_deep(p), canonicalize_deep(root)) {
            (Ok(a), Ok(b)) => is_same_path(&a, &b),
            _ => is_same_path(p, root),
        }
    };
    if list.iter().any(|p| same(p)) {
        return false;
    }
    list.push(root.to_path_buf());
    true
}

/// 常驻授权根清单文件（appDataDir 下，一行一路径，UTF-8）。
const WORKSPACE_ROOTS_FILE: &str = "workspace_roots.txt";

fn workspace_roots_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(WORKSPACE_ROOTS_FILE)
}

/// 从磁盘读回常驻授权根：文件不存在 = 空列表（首次运行的正常态）；
/// 读失败**出声**（stderr）后按空处理——不静默，也不连累启动。
fn read_workspace_roots(app_data_dir: &Path) -> Vec<PathBuf> {
    let file = workspace_roots_file(app_data_dir);
    match std::fs::read_to_string(&file) {
        Ok(text) => text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            eprintln!(
                "[workspace_roots] 读取授权根清单失败（按空处理）{}: {e}",
                file.display()
            );
            Vec::new()
        }
    }
}

/// 落盘常驻授权根清单（整表重写 ⇒ 天然去重、无追加竞态）。
fn write_workspace_roots(app_data_dir: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let file = workspace_roots_file(app_data_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建授权根清单目录失败 {}: {e}", parent.display()))?;
    }
    let mut body = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    std::fs::write(&file, body).map_err(|e| format!("写授权根清单失败 {}: {e}", file.display()))
}

/// 宿主亲自交付过（对话框选定 / OS 拖放）的可开项目根清单文件。
const APPROVED_ROOTS_FILE: &str = "approved_roots.txt";

fn approved_roots_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(APPROVED_ROOTS_FILE)
}

/// 宿主授权清单（两份文件名）：`register_write_domain` 的准入**唯一凭据**（见 `is_root_approved`）。
/// 它们即使落在 appDataDir（本身是常驻允许域）内，也不许经任何命令写入 / 改名 / 拷贝 / 删除——
/// 否则 WebView 侧先写一份 `C:\` 进 `approved_roots.txt`，重启后 `register_write_domain("C:\\")`
/// 就通过准入 ⇒ 任意路径可写、只读游戏目录保护失效。
/// 宿主自己的读写走 `read_*` / `write_*` 私有函数（直接 `std::fs`，不经命令），故不受影响。
const RESERVED_STATE_FILES: [&str; 2] = [WORKSPACE_ROOTS_FILE, APPROVED_ROOTS_FILE];

/// 纯判定：`target` 的文件名命中保留清单**且**落点确实在 `app_data_dir` 内 ⇒ true。
/// 只按名字拒会误伤用户项目里恰好同名的普通文件，故必须同时判落点。
/// 落点判定先 `canonicalize_deep`（短路径 / `..` / 大小写 / 符号链接都要挡住）；
/// 规范化失败时**不放行**，退回原始组件的 `is_within` 比较（此时判定只会更严，不会更松）。
fn is_reserved_state_file(app_data_dir: &Path, target: &Path) -> bool {
    let Some(name) = target.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let hit_name = RESERVED_STATE_FILES
        .iter()
        .any(|reserved| name.eq_ignore_ascii_case(reserved));
    if !hit_name {
        return false;
    }
    match (canonicalize_deep(target), canonicalize_deep(app_data_dir)) {
        (Ok(canon_target), Ok(canon_app)) => is_within(&canon_target, &canon_app),
        _ => is_within(target, app_data_dir),
    }
}

/// 从磁盘读回准入根清单：不存在 = 空（首次运行正常态）；读失败出声后按空处理。
fn read_approved_roots(app_data_dir: &Path) -> Vec<PathBuf> {
    let file = approved_roots_file(app_data_dir);
    match std::fs::read_to_string(&file) {
        Ok(text) => text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            eprintln!(
                "[approved_roots] 读取准入根清单失败（按空处理）{}: {e}",
                file.display()
            );
            Vec::new()
        }
    }
}

/// 落盘准入根清单（整表重写 ⇒ 天然去重、无追加竞态）。
fn write_approved_roots(app_data_dir: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let file = approved_roots_file(app_data_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建准入根清单目录失败 {}: {e}", parent.display()))?;
    }
    let mut body = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    std::fs::write(&file, body).map_err(|e| format!("写准入根清单失败 {}: {e}", file.display()))
}

/// 追加一个准入根（按规范化路径去重，同一目录的多种写法只留一条）。
fn push_approved_root(list: &mut Vec<PathBuf>, root: &Path) -> bool {
    let canon = match canonicalize_deep(root) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[approved_roots] 规范化失败，仍按原样登记 {}: {e}",
                root.display()
            );
            root.to_path_buf()
        }
    };
    let dup = |p: &Path| -> bool {
        match (canonicalize_deep(p), canonicalize_deep(&canon)) {
            (Ok(a), Ok(b)) => is_same_path(&a, &b),
            _ => is_same_path(p, &canon),
        }
    };
    if list.iter().any(|p| dup(p)) {
        return false;
    }
    list.push(canon);
    true
}

/// 纯判定（可单测，不依赖 Tauri 类型）：`register_write_domain` 想把 `root` 认作项目根，
/// 必须满足 `root`（已规范化）等于或落在**宿主亲自交付过的**某个准入根内。
/// `approved_roots` = 对话框/拖放交来的目录清单；`extra_roots` = 常驻自选项目位置根
/// （其新建项目的实际根常是它的一个子目录 ⇒ 一并算作准入来源）。
/// `app_data_dir` 本身也是常驻允许域 ⇒ 一并放行。
fn is_root_approved(
    app_data_dir: &Path,
    approved_roots: &[PathBuf],
    extra_roots: &[PathBuf],
    canon_root: &Path,
) -> bool {
    let canon_app = canonicalize_deep(app_data_dir).ok();
    if let Some(app) = canon_app.as_ref() {
        if is_within(canon_root, app) {
            return true;
        }
    }
    for list in [approved_roots, extra_roots] {
        for root in list {
            if let Ok(canon) = canonicalize_deep(root) {
                if is_within(canon_root, &canon) {
                    return true;
                }
            }
        }
    }
    false
}

/// 登记一个宿主亲自交付的目录为准入根，并落盘（对话框 / OS 拖放共用）。
/// 落盘失败只出声不阻断（内存态已更新，本次会话内仍可注册；清单是持久化半边）。
fn record_approved_root(
    state: &WriteDomainState,
    app_data_dir: &Path,
    root: &Path,
) -> Result<(), String> {
    let snapshot = {
        let mut guard = state
            .approved_roots
            .lock()
            .map_err(|_| "write domain state poisoned".to_string())?;
        if push_approved_root(&mut guard, root) {
            guard.clone()
        } else {
            // 已在册：仍取一份快照落盘（幂等重写，与磁盘对齐；不新增条目）
            guard.clone()
        }
    };
    if let Err(e) = write_approved_roots(app_data_dir, &snapshot) {
        eprintln!("[approved_roots] 落盘失败（内存态已更新）：{e}");
    }
    Ok(())
}

/// 目标路径 → 允许域判定的规范化形态（**只有一份**：直算 / 备忘录 / 命令侧三条路共用 ⇒
/// "目标解析失败"的文案逐字相同）。这一步要开文件句柄（`canonicalize`），
/// 放在取锁**之前**做：写域的锁只保护三份状态，不该把一次系统调用圈在锁里。
fn canonicalize_target_for_domain(path: &Path, op: &str) -> Result<PathBuf, String> {
    canonicalize_deep(path)
        .map_err(|e| format!("可写范围（{op}）：路径解析失败 {path_display}: {e}", path_display = path.display()))
}

/// 允许域判定的**唯一实现**：`resolve_root` 只换"根怎么规范化"这一步（每次直算 / 走备忘录），
/// 判序、包含关系与三条文案（目标解析失败 / 根解析失败 / 域外拒绝）都只有一份 ⇒
/// 加速层不可能把判定改形。入参用引用（`Option<&Path>` / `&[PathBuf]`）：判定过程不再构造
/// `Vec<PathBuf>`（原先每次写都要克隆一遍全部根）。
///
/// 目标已由 [`canonicalize_target_for_domain`] 规范化 ⇒ 命令侧可以先在锁外算好再进来
/// （`ensure_write_allowed`），判序与文案不变。
fn ensure_canon_target_in_domain_with<R>(
    canon_target: &Path,
    app_data_dir: &Path,
    project_root: Option<&Path>,
    extra_roots: &[PathBuf],
    path: &Path,
    op: &str,
    mut resolve_root: R,
) -> Result<(), String>
where
    R: FnMut(&Path) -> Result<PathBuf, String>,
{
    let mut roots: Vec<&Path> = vec![app_data_dir];
    if let Some(r) = project_root {
        roots.push(r);
    }
    roots.extend(extra_roots.iter().map(|p| p.as_path()));
    for root in roots {
        let canon_root = resolve_root(root)?;
        if is_within(canon_target, &canon_root) {
            return Ok(());
        }
    }
    Err(format!(
        "可写范围拒绝（{op}）：{} 不在可写范围内（允许 = 项目根目录 / appDataDir / 自选项目位置；未打开项目时仅 appDataDir + 自选项目位置）",
        path.display()
    ))
}

/// 判定入口（参照实现 / 单测用）：目标规范化 + [`ensure_canon_target_in_domain_with`]。
#[cfg(test)]
fn ensure_in_domain_with<R>(
    project_root: Option<&Path>,
    app_data_dir: &Path,
    extra_roots: &[PathBuf],
    path: &Path,
    op: &str,
    resolve_root: R,
) -> Result<(), String>
where
    R: FnMut(&Path) -> Result<PathBuf, String>,
{
    let canon_target = canonicalize_target_for_domain(path, op)?;
    ensure_canon_target_in_domain_with(
        &canon_target,
        app_data_dir,
        project_root,
        extra_roots,
        path,
        op,
        resolve_root,
    )
}

/// 允许域根解析失败的文案（**只有一份**：直算与备忘录两条路共用 ⇒ 逐字相同）。
fn root_unresolved_message(op: &str, root: &Path, reason: &str) -> String {
    format!(
        "可写范围（{op}）：根目录解析失败 {}: {reason}",
        root.display()
    )
}

/// 纯逻辑判定（**判序参照**，可单测、不依赖 Tauri 类型）：
/// `project_root` = 当前注册的项目根（可为 None），`app_data_dir` 常驻允许，
/// `extra_roots` = 用户经对话框自选并常驻授权的项目位置根。
/// 生产路径走 `ensure_write_allowed`（备忘录版）；这一支是"**每个根每次都直算**"的参照实现，
/// 与生产共用同一个 `ensure_canon_target_in_domain_with` ⇒ 判序不可能分叉，
/// `write_domain_tests` 就靠它钉"缓存版与直算版逐字同判定"（含三条错误文案）。
#[cfg(test)]
fn ensure_in_write_domain(
    project_root: Option<&Path>,
    app_data_dir: &Path,
    extra_roots: &[PathBuf],
    path: &Path,
    op: &str,
) -> Result<(), String> {
    ensure_in_domain_with(project_root, app_data_dir, extra_roots, path, op, |root| {
        canonicalize_deep(root).map_err(|e| root_unresolved_message(op, root, &e.to_string()))
    })
}

/// 备忘录版根规范化：命中且该原始写法**此刻仍是一个目录** ⇒ 采信缓存；
/// 未命中 / 已不是目录（被删、换卷、改成文件）⇒ 作废重算。失败**不进缓存**，
/// 下次仍按实时结果重算 ⇒ 错误文案与直算逐字一致（判定的三条分支一条都没少）。
#[cfg(test)]
fn canonical_root_cached(
    memo: &mut HashMap<PathBuf, PathBuf>,
    root: &Path,
    op: &str,
) -> Result<PathBuf, String> {
    if let Some(hit) = memo.get(root) {
        if root.is_dir() {
            return Ok(hit.clone());
        }
        memo.remove(root);
    }
    let canon = canonicalize_deep(root).map_err(|e| root_unresolved_message(op, root, &e.to_string()))?;
    if root.is_dir() {
        memo.insert(root.to_path_buf(), canon.clone());
    }
    Ok(canon)
}

/// 备忘录的**生产版**（短锁）：与 [`canonical_root_cached`] 逐条同语义，但锁只在
/// map 的读/写上持有——`root.is_dir()` 与 `canonicalize_deep` 都是系统调用
/// （实测目录 `is_dir` ~0.13ms、目标 canonicalize ~0.2ms），不许圈在写域的锁里。
fn canonical_root_cached_short(
    state: &WriteDomainState,
    root: &Path,
    op: &str,
) -> Result<PathBuf, String> {
    let epoch = state.canon_epoch.load(Ordering::SeqCst);
    let hit = state
        .canon_roots
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .get(root)
        .cloned();
    if let Some(hit) = hit {
        if root.is_dir() {
            // 命中期间发生允许域变更 ⇒ 这次命中可能来自变更前，按未命中重算。
            if state.canon_epoch.load(Ordering::SeqCst) == epoch {
                return Ok(hit);
            }
        } else if let Ok(mut memo) = state.canon_roots.lock() {
            memo.remove(root);
        }
    }
    let canon = canonicalize_deep(root).map_err(|e| root_unresolved_message(op, root, &e.to_string()))?;
    if root.is_dir() {
        memo_insert_canon_if_current(state, root, &canon, epoch);
    }
    Ok(canon)
}

/// 仅当备忘录代际未变时才落表（REF-FRONT-PERF 复核）：把"计算期间发生过
/// invalidate"的旧结果挡在表外；调用方在锁外算 canon，不能只看"root 仍是目录"。
fn memo_insert_canon_if_current(
    state: &WriteDomainState,
    root: &Path,
    canon: &Path,
    epoch: u64,
) {
    if let Ok(mut memo) = state.canon_roots.lock() {
        if state.canon_epoch.load(Ordering::SeqCst) == epoch {
            memo.insert(root.to_path_buf(), canon.to_path_buf());
        }
    }
}

/// 命令侧包装：取 appDataDir + 当前注册的项目根 + 常驻授权根，执行判定（走备忘录）。
///
/// **锁内只取快照，锁外做系统调用**（REF-FRONT-PERF）：目标 canonicalize、根的
/// `is_dir` / `canonicalize_deep` 都要开句柄（合计每写 ~0.4ms 量级），与被保护的三份状态
/// 无关 ⇒ 三把锁各自只在"克隆几个路径 / 读写 map"的瞬间持有。判序、文案与拒绝/放行结果
/// 逐字不变（同一个 `ensure_canon_target_in_domain_with`）；快照只在"允许域变更"瞬间
/// 才可能过时，而写域变更是项目级低频事件（判定本身也从不承诺与它原子）。
/// 命令侧判定核心（纯逻辑壳，可单测、不依赖 Tauri 类型）：保留名闸 → 目标规范化 →
/// 允许域判定（备忘录版）。`ensure_write_allowed` 只负责取 appDataDir 与状态快照。
///
/// 保留名闸必须在域判定**之前**：appDataDir 是常驻允许域，若不做这一步，
/// `write_file_bytes` / `rename_path` / `copy_file` / `remove_file` / `remove_dir`
/// 都能改到 `approved_roots.txt` / `workspace_roots.txt`，等于让 JS 自己签发写权限。
fn ensure_write_allowed_from_parts(
    app_data_dir: &Path,
    state: &WriteDomainState,
    path: &Path,
    op: &str,
) -> Result<(), String> {
    // 这两份文件是准入门的唯一凭据：JS 面任何写 / 改名 / 拷贝 / 删除都不许碰。
    // 宿主自己的读写走 `read_*` / `write_*` 私有函数（直接 `std::fs`），不经命令，故不受影响。
    if is_reserved_state_file(app_data_dir, path) {
        return Err(format!(
            "拒绝写入宿主授权清单（只由宿主维护）：{}",
            path.display()
        ));
    }
    let canon_target = canonicalize_target_for_domain(path, op)?;
    // 快照：两个小 Vec/PathBuf 的克隆（纳秒级），换掉锁内两条 `is_dir` 系统调用
    let (project, extras) = {
        let project = state
            .project_root
            .lock()
            .map_err(|_| "write domain state poisoned".to_string())?
            .clone();
        let extras = state
            .extra_roots
            .lock()
            .map_err(|_| "write domain state poisoned".to_string())?
            .clone();
        (project, extras)
    };
    ensure_canon_target_in_domain_with(
        &canon_target,
        app_data_dir,
        project.as_deref(),
        &extras,
        path,
        op,
        |root| canonical_root_cached_short(state, root, op),
    )
}

/// 命令侧包装：取 appDataDir，其余判定交给 [`ensure_write_allowed_from_parts`]。
fn ensure_write_allowed(
    app: &tauri::AppHandle,
    state: &WriteDomainState,
    path: &Path,
    op: &str,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    ensure_write_allowed_from_parts(&app_dir, state, path, op)
}

/// 允许域任何一处变更（项目根注册 / 清除 / 常驻根增减）⇒ 备忘录整体作废。
/// 判定的正确性不依赖这一句（命中还要求原路径仍是目录），但它把陈旧窗口压到零。
fn invalidate_canon_roots(state: &WriteDomainState) {
    // 先抬代际再清表：短锁版在系统调用期间不持锁，落缓存前会复核这一代际。
    state.canon_epoch.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut memo) = state.canon_roots.lock() {
        memo.clear();
    }
}

/// project.opened：前端注册项目根目录（允许域 = 项目根 + appDataDir）。
///
/// **准入门**（审阅批：修复"接受任意 JS 路径"的漏洞）：只有 `root`（规范化后）等于或落在
/// **宿主亲自交付过的某个目录**之内才放行——即系统目录对话框（`choose_directory` /
/// `choose_workspace_root`）返回项或 OS 拖放（`WindowEvent::DragDrop`）交来的目录，或其子目录
/// （新建项目落自选位置下的一层），或 appDataDir 本身。
/// 恶意 WebView JS 直接 `invoke('register_write_domain',{root:"<任意路径>"})` 会因不在准入清单而拒；
/// 合法开项目路径（对话框/拖放选定 → 已登记 → 注册）照常放行。注册失败即 fail-closed，
/// 前端据此退回"仅 appDataDir 可写"并显式报错。
///
/// UNC（`\\...`）在规范化之前先拒：既绕开网络命名空间触发的凭据外泄与主线程阻塞，
/// 拖放/对话框也从不交付 UNC 作为可写根。
#[tauri::command]
async fn register_write_domain(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    root: String,
) -> Result<(), String> {
    use tauri::Manager;
    if root.starts_with(r"\\") {
        return Err("可写范围注册拒绝：不接受网络路径（UNC）作为项目根".to_string());
    }
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let approved = state
        .approved_roots
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .clone();
    let extras = state
        .extra_roots
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .clone();
    // 准入门判定要 canonicalize 目标根（慢盘 / 网络盘上可阻塞）：上阻塞线程池。
    // 判定用的两份清单是取锁快照——准入根与常驻根只增不减，快照不会把"该放的"判成"不该放"。
    // 快照在判定之前：判定期间项目被关闭 / 换开 ⇒ 落定前复核会发现序号已变（fail-closed）。
    // 判定失败不会抬代际 ⇒ 另一个在途的成功注册仍能照常落定。
    let observed = domain_change_snapshot(&state);
    let root_for_check = root.clone();
    run_blocking("register_write_domain", move || {
        let canon_root = canonicalize_deep(Path::new(&root_for_check))
            .map_err(|e| format!("可写范围注册失败：路径解析失败 {root_for_check}: {e}"))?;
        if !is_root_approved(&app_dir, &approved, &extras, &canon_root) {
            return Err(format!(
                "可写范围注册拒绝：{root_for_check} 未经系统目录对话框或拖放由宿主交付，不在准入清单内"
            ));
        }
        Ok(())
    })
    .await?;
    commit_project_root(&state, PathBuf::from(root), observed)
}

/// project.closed：清除项目根（回到仅 appDataDir 可写）。
#[tauri::command]
fn clear_write_domain(state: tauri::State<'_, WriteDomainState>) -> Result<(), String> {
    clear_domain_core(&state)
}

/* ------------------------------- DTO ------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryDto {
    name: String,
    path: String,
    is_directory: bool,
    /// `walkDir({withMetadata:true})` 时填充；其余情况**整个键不出现**（前端拿到 undefined，
    /// 而不是被当成 0）。取值走 `mtime_ms_of`，与 `stat_file` 逐位同值 ⇒ 才有资格省掉那次 stat。
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Serialize, Debug, PartialEq)]
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
    /// true ⇒ 每个文件条目顺带带回 mtime/size（省掉调用方的逐文件 `stat_file` 往返）。
    /// 默认 false：既有调用的开销形态不变。
    with_metadata: Option<bool>,
}

/// mtime → epoch 毫秒。`stat_file` 与 `walk_dir(withMetadata)` **共用这一份实现**：
/// 只有逐位同值，索引的体量指纹与逐文件复用判据才不会因为换了取数路径而变化。
fn mtime_ms_of(t: Option<std::time::SystemTime>) -> f64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/* ---------------------------- 文件原语 ---------------------------- */

/// **同步命令 = 在 IPC handler 线程（WebView 主线程）内联执行**：一次 512 份 .erb ≈ 21 MB 的
/// 批量读、一份 2.35 MB 的编码转换，都会把整个界面冻在那一段时间里（`market.rs` 的
/// `extract_staging_off_thread` 记着同一条 hazard，`search_text` 是仓里已有的解法先例）。
/// PS-1 把这条形态推广到其余纯 IO / 纯 CPU 命令：命令体改 `async`，活挪到阻塞线程池，
/// **判定与授权仍留在命令内、与写盘同命令**（铁律 6 的形态不变）。
/// 前端一律 `await invoke(...)`，载荷形状逐字不变 ⇒ JS 侧零改动。
async fn run_blocking<T: Send + 'static>(
    op: &str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("{op}：宿主线程池失败：{e}"))?
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<String, String> {
    run_blocking("read_file_bytes", move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        Ok(B64.encode(bytes))
    })
    .await
}

/// 同一件事，但**响应以二进制过界**：Tauri 把 `ipc::Response` 的 body 原样送到前端，
/// 前端拿到 `ArrayBuffer`。省掉 base64 的 1.34× 膨胀和 JS 侧逐字节还原——
/// 开项目热路径每轮要读两份 10 MB 级快照（IMPLEMENTATION-LOG §5.91 实机读数）。
/// `read_file_bytes` 保留：它仍是 smoke 脚本与"两条通道逐字节对照"探针的参照物。
#[tauri::command]
async fn read_file_bytes_raw(path: String) -> Result<tauri::ipc::Response, String> {
    run_blocking("read_file_bytes_raw", move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

/// 原子写临时名的唯一段：`{pid}-{进程内单调序号}`。
/// 只用 pid 时，同进程两条并发写命令拿到的是同一个临时名——`fs::write` 互踩截断、
/// rename 抢跑，结果是一方报成功、盘上却是他方字节（或败者假性 NotFound）。
/// pid 隔开跨进程并发，序号隔开进程内并发，两段合取才唯一。
static ATOMIC_WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_unique_id() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        ATOMIC_WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// 原子写核心（可单测，不依赖 Tauri 类型）：同目录临时文件 + rename（Windows 上
/// rename 覆盖已存在文件）。临时名带 `tmp_unique_id` ⇒ 同一目标的并发写各用各的
/// 临时文件，rename 原子生效：读方任一时刻读到的都是某一次**完整**写入。
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let dir = target.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("no parent directory: {}", target.display()),
        )
    })?;
    std::fs::create_dir_all(dir)
        .map_err(|e| std::io::Error::new(e.kind(), format!("mkdir {}: {e}", dir.display())))?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("unnamed");
    let tmp = dir.join(format!(".{file_name}.{}.kojo-tmp", tmp_unique_id()));
    std::fs::write(&tmp, bytes)
        .map_err(|e| std::io::Error::new(e.kind(), format!("write tmp: {e}")))?;
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(std::io::Error::new(e.kind(), format!("rename: {e}")));
    }
    Ok(())
}

/// 原子写：同目录临时文件 + rename。写允许域第二道闸（M3）：目标路径必须在允许域内。
/// 闸口（含路径解析）留在命令内、与写盘同命令；真正落盘的一段上阻塞线程池。
#[tauri::command]
async fn write_file_bytes(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
    data: String,
) -> Result<(), String> {
    let target = Path::new(&path);
    ensure_write_allowed(&app, &state, target, "write")?;
    let target = target.to_path_buf();
    // base64 解码与落盘同属"量随文件走"的活 ⇒ 一起挪走（解码也在阻塞线程上做）
    run_blocking("write_file_bytes", move || {
        let bytes = B64.decode(data).map_err(|e| format!("base64 decode: {e}"))?;
        atomic_write(&target, &bytes).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn ensure_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
) -> Result<(), String> {
    // 闸口（含目标 canonicalize）留在命令内、与写盘同命令；落盘一段上阻塞线程池
    ensure_write_allowed(&app, &state, Path::new(&path), "ensure_dir")?;
    run_blocking("ensure_dir", move || {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
}

/// 列目录的同步核心（命令侧只是 async 壳；单测直接打这一层）。
fn list_dir_of(path: &str) -> Result<Vec<DirEntryDto>, String> {
    let mut out = Vec::new();
    // 铁律 4（内核不许静默）：只有"目录不存在"折叠成空列表（与 NodeBridge 语义一致，
    // 首次运行/尚未创建的目录是正常态）；其它 `read_dir` 错误（权限、路径是文件、句柄失效、
    // 网络名不可达……）必须**如实报错上抛**，绝不与"空目录"混为一谈。
    let read = match std::fs::read_dir(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("列目录失败 {path}: {e}")),
    };
    for entry in read.flatten() {
        let md = entry.metadata().ok();
        out.push(DirEntryDto {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory: md.map(|m| m.is_dir()).unwrap_or(false),
            // listDir 没有 withMetadata 选项：输出形态与改造前逐字一致（键直接不出现）
            mtime_ms: None,
            size: None,
        });
    }
    Ok(out)
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntryDto>, String> {
    // 一次目录列举的条目数随语料走（成千条）：不许把 read_dir 的活内联在 IPC 线程上。
    run_blocking("list_dir", move || list_dir_of(&path)).await
}

/// 递归列举的同步核心（命令侧只是 async 壳；单测直接打这一层）。
///
/// **手工 `read_dir` 走查**（REF-FRONT-PERF，2026-10-20）：不再经 walkdir。两点实证
/// （2,000 文件 / 50 目录合成盘，同机 debug 交替计时探针，walkdir 与手工各 15 轮取中位）：
/// ① 限深（`maxDepth`）**5.2×**（41ms → 8ms）：walkdir 对每个到达深度上限的目录仍会
///    先 `read_dir` 打开句柄再立刻丢弃（`push` 不判深度）；
/// ② 常规全量走查基本持平（57.6ms → 56.2ms，差异在探针噪声内）：本条的主收益在 ①，
///    以及"不再需要每条目克隆 walkdir 的 metadata 与错误包装"。
/// 语义逐条保持原口径：前序 DFS、子序 = `read_dir` 顺序（与 walkdir 相同）；`maxDepth`
/// 计**根之下的层数**（`maxDepth: 0` = 仅直接子项，与 TS 桥同口径）；不跟随符号链接
/// （符号链接目录本身照常作为条目输出）；读不了的条目静默跳过（与旧实现
/// `filter_map(|e| e.ok())` 同形——错误可见性由调用方的计数兜底）。
fn walk_dir_of(path: &str, o: WalkOptionsDto) -> Result<Vec<DirEntryDto>, String> {
    let include_files = o.include_files.unwrap_or(true);
    let include_dirs = o.include_dirs.unwrap_or(false);
    let max_depth = o.max_depth.unwrap_or(usize::MAX);
    let with_metadata = o.with_metadata.unwrap_or(false);
    // 深度口径与 walkdir 对齐：根为 0，直接子项为 1；用户 maxDepth 再加 1
    let walk_max = if max_depth == usize::MAX { usize::MAX } else { max_depth + 1 };

    let mut out = Vec::new();
    let root = Path::new(path);
    let root_read = match std::fs::read_dir(root) {
        // 根读不了 = 空结果（walkdir 把根错误作为一条 Err 交给 filter_map 丢弃 ⇒ 同形）
        Err(_) => return Ok(out),
        Ok(r) => r,
    };
    // 显式栈 = (目录, 该目录的迭代器, 该目录里条目的深度)；栈顶即当前目录 ⇒ 输出恒为前序 DFS
    let mut stack: Vec<(PathBuf, std::fs::ReadDir, usize)> = vec![(root.to_path_buf(), root_read, 1)];
    loop {
        let next = match stack.last_mut() {
            Some((_, it, _)) => it.next(),
            None => break,
        };
        let entry = match next {
            Some(Ok(e)) => e,
            Some(Err(_)) => continue,
            None => {
                stack.pop();
                continue;
            }
        };
        let depth = match stack.last() {
            Some((_, _, d)) => *d,
            None => break,
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_dir = file_type.is_dir();
        let entry_path = entry.path();
        // include_dirs / include_files 只控制“是否输出条目”，递归不受影响
        if (is_dir && include_dirs) || (!is_dir && include_files) {
            // 顺路取元数据：Windows 上 `DirEntry::metadata()` 用的是枚举时已经拿到的信息，
            // 不再额外系统调用——**这正是"一次遍历替掉 N 次 stat"成立的前提**。
            // 取不到就留空（前端退化回 stat_file），绝不伪造 0。
            let (mtime_ms, size) = match (with_metadata, is_dir) {
                (true, false) => match entry.metadata() {
                    Ok(md) => (Some(mtime_ms_of(md.modified().ok())), Some(md.len())),
                    Err(_) => (None, None),
                },
                _ => (None, None),
            };
            out.push(DirEntryDto {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry_path.to_string_lossy().to_string(),
                is_directory: is_dir,
                mtime_ms,
                size,
            });
        }
        // 符号链接目录与 walkdir 一样不深入（防环）；到达深度上限的目录连 read_dir 都不做
        if is_dir && !file_type.is_symlink() && depth < walk_max {
            if let Ok(child) = std::fs::read_dir(&entry_path) {
                stack.push((entry_path, child, depth + 1));
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn walk_dir(path: String, opts: Option<WalkOptionsDto>) -> Result<Vec<DirEntryDto>, String> {
    let o = opts.unwrap_or_default();
    // 冷开索引期的整树走查是"量随语料走"的活 ⇒ 上阻塞线程池
    run_blocking("walk_dir", move || walk_dir_of(&path, o)).await
}

/// 存在性判定的同步核心（命令侧只是它的 async 壳；测试直接打这一层）。
fn path_exists_at(path: &str) -> bool {
    Path::new(path).exists()
}

#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    // 一次 `exists()` 就是一次 CreateFile 往返：热路径上（逐文件判在不在盘）几百次
    // 串在主线程 ⇒ 一并挪到阻塞线程池。
    // 失败**如实报错**而不是回 `false`——把"宿主线程池炸了"伪装成"文件不存在"
    // 会让上层据此走"新建"分支，那是数据层面的错（铁律 4）。
    run_blocking("path_exists", move || Ok(path_exists_at(&path)))
        .await
}

/// 单文件元数据的同步核心：与 `stat_files` / `walk_dir(withMetadata)` 共用 `mtime_ms_of`。
fn stat_file_at(path: &str) -> Option<FileStatDto> {
    let md = std::fs::metadata(path).ok()?;
    let mtime_ms = mtime_ms_of(md.modified().ok());
    Some(FileStatDto {
        size: md.len(),
        mtime_ms,
        is_directory: md.is_dir(),
    })
}

#[tauri::command]
async fn stat_file(path: String) -> Result<Option<FileStatDto>, String> {
    // "取不到元数据"仍是既有的 `null`（前端按 null 退避），只有线程池本身炸了才报错
    run_blocking("stat_file", move || Ok(stat_file_at(&path))).await
}

/* --------------------- 批量读（二进制帧，2026-10-16 批量 IO 批） --------------------- */
//
// 冷开一次项目要对语料做 ~9,000 次单文件读，而 JS 侧每读一个文件要 2 趟 IPC
// （read_file_bytes_raw + stat_file）。本段把"读一批文件 + 带回元数据"压成一个命令一趟 IPC
// —— 仍是纯 IO 原语（不认识任何领域概念，批大小与使用姿势全由调用方定）。
//
// 帧格式刻意朴素（定长头 + 长度前缀，全小端；JS 侧解帧器是纯 DataView 函数，
// 见 packages/app/src/bridge/read-files-frame.ts，两份实现成对演进）：
//   [u32 文件数]
//   每文件：[u32 pathLen][path(utf-8 字节)][u32 status][i64 mtimeMs][u64 size][u64 dataLen][data]
//
// 设计口径：
// - 逐文件失败**不失败整批**：status 三态（0=ok / 1=不存在 / 2=读错）如实带回；
// - 输出顺序 = 入参顺序（并行只影响内部完成次序，结果按下标回位）；
// - 字节原样进帧（不转码、不剥 BOM）——解码口径归调用方（内核 encoding.ts 单一真源）。

/// 帧内单文件状态码（与 JS 侧解帧器逐字对应）
const FRAME_STATUS_OK: u32 = 0;
const FRAME_STATUS_NOT_FOUND: u32 = 1;
const FRAME_STATUS_READ_ERROR: u32 = 2;

/// 批量读的并行度（与检索段缺省同量级：索引/抽取段的读盘并发本就是 8）
const BATCH_READ_THREADS: usize = 8;

/// mtime → epoch 毫秒（i64 帧字段）。与 `mtime_ms_of`（f64）同源；ms 级整数在 f64 里
/// 可精确表示 ⇒ 两侧比等值不会漂。
fn mtime_ms_i64(t: Option<std::time::SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 单文件读取结果（帧编码前的中介形态；纯数据）
struct RawFileRead {
    path: String,
    status: u32,
    mtime_ms: i64,
    size: u64,
    data: Vec<u8>,
}

/// 读失败的分类（NotFound 与其它 IO 错误分开报，让调用方能区分"文件没了"与"读不动"——
/// 两类都不可静默）。三态口径与改造前逐字相同。
fn read_failure(path: &str, e: &std::io::Error) -> RawFileRead {
    RawFileRead {
        path: path.to_string(),
        status: if e.kind() == std::io::ErrorKind::NotFound {
            FRAME_STATUS_NOT_FOUND
        } else {
            FRAME_STATUS_READ_ERROR
        },
        mtime_ms: 0,
        size: 0,
        data: Vec::new(),
    }
}

/// `File::open` 之后允许预分配的上限（防一个谎报体积的文件把整批的内存一次吃掉；
/// 真实语料最大单文件 2.35 MB，上限只是兜底不是判据）。
const READ_PREALLOC_MAX: u64 = 64 * 1024 * 1024;

/// 读一个文件（含元数据）：**开一次句柄，元数据从同一个句柄取**。
/// 旧实现是 `fs::read` + `fs::metadata` ⇒ 每个文件两次"打开—查询—关闭"，
/// 一次冷开 6,855 个路径就是白多 6,855 趟元数据往返（PS-1 §4）。
/// 读不到时的分类、mtime 取值口径与旧实现逐字一致（`mtime_ms_i64` 未动）。
fn read_one_file(path: &str) -> RawFileRead {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return read_failure(path, &e),
    };
    // 元数据取不到不致命（退化为 0 + 实读字节数；缓存判据要求 stat 两侧都有值才命中，不会误中）
    let hinted = file.metadata().ok();
    let mtime_ms = hinted
        .as_ref()
        .map(|md| mtime_ms_i64(md.modified().ok()))
        .unwrap_or(0);
    let prealloc = hinted
        .as_ref()
        .map(|md| md.len())
        .unwrap_or(0)
        .min(READ_PREALLOC_MAX) as usize;
    let mut data: Vec<u8> = Vec::with_capacity(prealloc);
    if let Err(e) = std::io::Read::read_to_end(&mut file, &mut data) {
        return read_failure(path, &e);
    }
    let size = match hinted {
        // 同一句柄的 size 与实读字节数同源于一次打开；metadata 取不到时如实回实读长度
        Some(md) if md.is_file() => md.len(),
        _ => data.len() as u64,
    };
    RawFileRead {
        path: path.to_string(),
        status: FRAME_STATUS_OK,
        mtime_ms,
        size,
        data,
    }
}

/// 并行映射（PS-1）：**按下标领取、按下标回位** ⇒ 输出顺序恒等于入参顺序，
/// 并行只影响内部完成次序。`len <= 1` 不铺线程；worker 数 = `min(len, threads)`。
/// 某个 worker 崩了 ⇒ 它那一段结果缺席（与 `read_files_frame` 改造前的既有口径逐字相同：
/// 整批不失败、缺的条目由调用方按"数量对不上"自行退避）。
fn fan_out<T, F>(len: usize, threads: usize, f: F) -> Vec<T>
where
    T: Send,
    F: Fn(usize) -> T + Sync + Send,
{
    if len == 0 {
        return Vec::new();
    }
    if len <= 1 {
        return vec![f(0)];
    }
    let next = AtomicUsize::new(0);
    let workers = len.min(threads);
    let mut collected: Vec<(usize, T)> = std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let next = &next;
            let f = &f;
            handles.push(scope.spawn(move || {
                let mut local: Vec<(usize, T)> = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= len {
                        break;
                    }
                    local.push((i, f(i)));
                }
                local
            }));
        }
        let mut merged: Vec<(usize, T)> = Vec::with_capacity(len);
        for h in handles {
            if let Ok(mut local) = h.join() {
                merged.append(&mut local);
            }
        }
        merged
    });
    collected.sort_by_key(|(i, _)| *i);
    collected.into_iter().map(|(_, v)| v).collect()
}

/// 帧字节数（定长头 + 每项 32 字节元信息 + 两段变长内容）：**先算准再一次分配**。
/// 旧实现从 `Vec::new()` 起写 21 MB ⇒ ~25 次 realloc、累计 ~40 MB memcpy（PS-1 §5）。
fn frame_capacity(results: &[RawFileRead]) -> usize {
    4usize
        + results.iter().map(|r| {
            4 + r.path.len() + 4 + 8 + 8 + 8 + r.data.len()
        }).sum::<usize>()
}

/// 批量读并编码成帧（并行读、按下标回位；`len<=1` 不铺线程）。
/// 纯函数面独立出来是为了可单测（帧一旦漂，前端解帧器静默错位——比读失败更坏）。
fn read_files_frame(paths: &[String]) -> Vec<u8> {
    let results: Vec<RawFileRead> =
        fan_out(paths.len(), BATCH_READ_THREADS, |i| read_one_file(&paths[i]));

    let mut out: Vec<u8> = Vec::with_capacity(frame_capacity(&results));
    out.extend_from_slice(&(results.len() as u32).to_le_bytes());
    for r in &results {
        let path_bytes = r.path.as_bytes();
        out.extend_from_slice(&(path_bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(path_bytes);
        out.extend_from_slice(&r.status.to_le_bytes());
        out.extend_from_slice(&r.mtime_ms.to_le_bytes());
        out.extend_from_slice(&r.size.to_le_bytes());
        out.extend_from_slice(&(r.data.len() as u64).to_le_bytes());
        out.extend_from_slice(&r.data);
    }
    out
}

/// 批量读：一次 IPC 带回多文件原始字节 + 元数据（`ipc::Response` 二进制过界，无 base64 膨胀）。
/// 逐文件失败不改整批的成败（status 三态在帧里），故本命令无 Result 错误面。
/// 但**整批的读盘 + 组帧曾是 21 MB 级的主线程内联活** ⇒ 上阻塞线程池（PS-1 §1）。
#[tauri::command]
async fn read_files_raw(paths: Vec<String>) -> Result<tauri::ipc::Response, String> {
    run_blocking("read_files_raw", move || {
        Ok(tauri::ipc::Response::new(read_files_frame(&paths)))
    })
    .await
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BatchStatDto {
    path: String,
    exists: bool,
    /// 存在时与 `stat_file` 同源同值；不存在 ⇒ null（不拿 0 兜底）
    mtime_ms: Option<f64>,
    size: Option<u64>,
}

/// 批量 stat 的同步核心：**逐项一次 `fs::metadata` 串行跑在调用线程上**
/// （6,855 个路径 = 14 趟 × 512）⇒ 复用批量读那套 `fan_out` 铺 8 路（PS-1 §2）。
/// 输出顺序 = 入参顺序（`fan_out` 按下标回位），与旧实现逐字同形。
fn stat_files_of(paths: &[String]) -> Vec<BatchStatDto> {
    fan_out(paths.len(), BATCH_READ_THREADS, |i| {
        match std::fs::metadata(&paths[i]) {
            Ok(md) => BatchStatDto {
                path: paths[i].clone(),
                exists: true,
                mtime_ms: Some(mtime_ms_of(md.modified().ok())),
                size: Some(md.len()),
            },
            Err(_) => BatchStatDto {
                path: paths[i].clone(),
                exists: false,
                mtime_ms: None,
                size: None,
            },
        }
    })
}

/// 批量 stat（小载荷，JSON 形态）：与 `stat_file` 共用 `mtime_ms_of`（判据同源不漂）。
/// 逐文件失败 ⇒ `exists:false`，不抛整批（与 `read_files_raw` 同口径）。
#[tauri::command]
async fn stat_files(paths: Vec<String>) -> Result<Vec<BatchStatDto>, String> {
    run_blocking("stat_files", move || Ok(stat_files_of(&paths))).await
}

#[tauri::command]
async fn rename_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    from: String,
    to: String,
) -> Result<(), String> {
    // rename 同时改动 from（移走）与 to（写入），两端都在允许域内才放行（闸口留在命令内）
    ensure_write_allowed(&app, &state, Path::new(&from), "rename_src")?;
    ensure_write_allowed(&app, &state, Path::new(&to), "rename_dst")?;
    run_blocking("rename_path", move || {
        std::fs::rename(&from, &to).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn copy_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    from: String,
    to: String,
) -> Result<(), String> {
    // from 是读取源（读路径不受允许域限制）；to 是写入目标，必须过闸（闸口留在命令内）
    ensure_write_allowed(&app, &state, Path::new(&to), "copy_dst")?;
    run_blocking("copy_file", move || {
        if let Some(parent) = Path::new(&to).parent() {
            // 铁律 4：建目录失败不许静默吞掉（吞了会把"父目录建不出来"伪装成"copy 失败"、
            // 丢掉真正的 IO 错）。create_dir_all 对已存在目录返回 Ok ⇒ 只有真错才上抛。
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目标目录失败 {}: {e}", parent.display()))?;
        }
        std::fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn remove_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
) -> Result<(), String> {
    ensure_write_allowed(&app, &state, Path::new(&path), "remove")?;
    run_blocking("remove_file", move || {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    })
    .await
}

/// 递归删除目录（不存在则幂等成功；同写允许域第二道闸）。
#[tauri::command]
async fn remove_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    path: String,
) -> Result<(), String> {
    ensure_write_allowed(&app, &state, Path::new(&path), "remove_dir")?;
    // 整棵树的删除是"量随目录走"的活 ⇒ 上阻塞线程池
    run_blocking("remove_dir", move || match std::fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
}

/* ---------------------------- 对话框 / 环境 ---------------------------- */

/// 系统目录对话框选一个目录返回给前端。**选定的目录同时登记进准入根清单**
/// （`approved_roots`）——这是"对话框即授权"：用户在原生对话框里点选的目录才是宿主亲自
/// 交付过的路径，`register_write_domain` 据此放行。取消（None）不改任何状态。
#[tauri::command]
async fn choose_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    let Some(handle) = dialog.pick_folder().await else {
        return Ok(None); // 取消 = 不登记、不返回
    };
    let picked = handle.path();
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    record_approved_root(&state, &app_dir, &picked)?;
    Ok(Some(picked.to_string_lossy().to_string()))
}

/// 文件对话框的扩展名过滤项（JS 侧原样递来；扩展名不带点）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePickFilterDto {
    name: String,
    extensions: Vec<String>,
}

/// 文件选择对话框（2026-10-16 发布通道批）：让作者从磁盘上**选定一个文件**，返回完整路径，
/// 取消 → `None`。**只选不读不写**：本命令不授予任何写许可（不是写允许域的入口），
/// 读侧无闸是既有口径（`read_file_bytes` 同样读任意路径）——授权语义照 `export_file`
/// 的"对话框即授权"哲学：路径来自用户的显式选择，而不是调用方随手给的参数。
#[tauri::command]
async fn choose_file(
    title: Option<String>,
    filters: Option<Vec<FilePickFilterDto>>,
) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    if let Some(list) = filters.as_deref() {
        for f in list {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&f.name, &exts);
        }
    }
    Ok(dialog
        .pick_file()
        .await
        .map(|h| h.path().to_string_lossy().to_string()))
}

/// 自选**项目位置**（2026-10-14 新建口上项目自选位置批）。
///
/// **对话框即授权，且授权与对话框绑在这一个命令内**：用户在系统目录对话框里选定后，
/// 本命令立刻把它追加进常驻授权根（`WriteDomainState::extra_roots`）、落盘
/// `<appDataDir>/workspace_roots.txt`，再把路径返回给 JS。
/// 用户取消 → 返回 `None`，内存与磁盘状态都不动。
///
/// 铁律 6 的落点：**没有任何命令接受路径参数来"授予"写权限**。
/// 写允许域只能经这条"弹对话框 → 用户选定"的路径变宽；
/// JS 侧不存在"给我一个路径我就放行"的入口（对照 `export_file` 的同一形态）。
#[tauri::command]
async fn choose_workspace_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    let picked = match dialog.pick_folder().await {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(None), // 取消 = 不改任何授权状态
    };
    // 快照在锁内取、落盘在块外做：不持着锁去做磁盘 IO
    let snapshot = {
        let mut guard = state
            .extra_roots
            .lock()
            .map_err(|_| "write domain state poisoned".to_string())?;
        push_extra_root(&mut guard, &picked);
        guard.clone()
    };
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    write_workspace_roots(&app_dir, &snapshot)?;
    // 同时登记为准入根：新建项目落在此自选位置的一层子目录下，`register_write_domain`
    // 走 `extra_roots` 前缀判定已能放行，这里再登记让"直接在选定根开项目"也留痕于准入清单。
    record_approved_root(&state, &app_dir, &picked)?;
    eprintln!(
        "[choose_workspace_root] 项目位置已授权并登记：{}（常驻根共 {} 个）",
        picked.display(),
        snapshot.len()
    );
    Ok(Some(picked.to_string_lossy().to_string()))
}

/// 内存 ∪ 磁盘清单的去重与失效剔除（**纯函数**，可单测）：保授权顺序、
/// 剔掉盘上已不存在的目录（剔的时候出声）。
fn merge_workspace_roots(app_data_dir: &Path, memory: Vec<PathBuf>) -> Vec<String> {
    let mut merged: Vec<PathBuf> = Vec::new();
    for p in memory.into_iter().chain(read_workspace_roots(app_data_dir)) {
        if !merged.iter().any(|q| is_same_path(q, &p)) {
            merged.push(p);
        }
    }
    let mut out = Vec::new();
    for p in merged {
        if !p.is_dir() {
            eprintln!("[workspace_roots] 授权根不存在，跳过：{}", p.display());
            continue;
        }
        out.push(p.to_string_lossy().to_string());
    }
    out
}

/// 只读：当前常驻授权的**自选**项目位置根（不含默认工作区根——那由内核自己拼）。
///
/// 取值 = 内存 ∪ 磁盘清单（去重、保授权顺序），并剔掉磁盘上已不存在的目录
/// （作者删了那个文件夹 / 换了机器），剔的时候出声。
/// `setup` 已经把清单读进内存，这里再合并一次是为了：setup 读失败也不能让前端永远看不见已授权根。
#[tauri::command]
async fn workspace_roots(
    app: tauri::AppHandle,
    state: tauri::State<'_, WriteDomainState>,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let memory = state
        .extra_roots
        .lock()
        .map_err(|_| "write domain state poisoned".to_string())?
        .clone();
    // 读清单文件 + 逐个 is_dir 都是盘上活 ⇒ 阻塞线程池（快照在锁内取、锁外做 IO）
    run_blocking("workspace_roots", move || {
        Ok(merge_workspace_roots(&app_dir, memory))
    })
    .await
}

/// 导出**单个文件**到用户选定的位置（ZIP 发布包用；base64 过 IPC，与 `write_file_bytes` 同口径）。
///
/// 落点在写域之外是设计意图：**授权来自用户在系统保存对话框里的
/// 显式选择，且对话框与写盘绑在同一个命令内**（JS 拿不到落点决定权，也就无法把写操作
/// 引导到任意路径）。因此这里刻意不过 `ensure_write_allowed`。
///
/// 这是全仓唯一一条"写到允许域之外"的法定通道（曾有的同形态命令 `export_directory`
/// 因无调用方已删，见 IMPLEMENTATION-LOG §5.97）。新增绕闸能力必须照本命令的形态。
///
/// `file_name` 只是对话框的**预填建议**，不是落点：仍剥掉路径分隔符，避免一个坏名字
/// 把对话框初始目录带偏。
#[tauri::command]
async fn export_file(
    file_name: String,
    data: String,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let bytes = B64.decode(&data).map_err(|e| format!("base64 decode: {e}"))?;
    let suggestion = file_name.replace(['/', '\\'], "_");

    let mut dialog = rfd::AsyncFileDialog::new()
        .set_file_name(&suggestion)
        .add_filter("ZIP 压缩包", &["zip"]);
    if let Some(t) = title.as_deref() {
        dialog = dialog.set_title(t);
    }
    let picked = match dialog.save_file().await {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(None),
    };
    if let Some(parent) = picked.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败：{e}"))?;
    }
    std::fs::write(&picked, &bytes).map_err(|e| format!("导出写入失败：{e}"))?;
    eprintln!(
        "[export_file] {} 字节 → {}",
        bytes.len(),
        picked.display()
    );
    Ok(Some(picked.to_string_lossy().to_string()))
}

#[tauri::command]
fn app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/* ------------------------------ 编码（写向 + 检索读判据） ------------------------------ */

fn encoding_for(name: &str) -> Result<&'static encoding_rs::Encoding, String> {
    Ok(match name {
        "utf-8" | "utf-8-bom" => encoding_rs::UTF_8,
        "shift_jis" => encoding_rs::SHIFT_JIS,
        // CJK 三族（2026-10-17 编码标签批）：WHATWG Encoding Standard 的一等标签，
        // 与客户端 TextDecoder('gbk'/'gb18030'/'big5') 同表同规则（探测口径见 `cjk_family_score`）
        "gbk" => encoding_rs::GBK,
        "gb18030" => encoding_rs::GB18030,
        "big5" => encoding_rs::BIG5,
        "utf-16le" => encoding_rs::UTF_16LE,
        "utf-16be" => encoding_rs::UTF_16BE,
        other => return Err(format!("unsupported encoding: {other}")),
    })
}

// `decode_bytes` 命令（Rust encoding_rs 对照探针）已删除（W12 ENC-SRC，2026-10-16 判据合一）。
// 它当年对照的是"客户端 TextDecoder vs encoding_rs 逐字等价性"（§5.90 实机复测：真实语料
// 114 文件 + 16 合成例，唯一分叉 = 非法字节连跑在 utf-8 标签下的替换字符数）。判序与
// fatal/替换策略合一进共享常量表 `plugin-api/src/decode-probe-policy.json` 后，检索侧由
// `utf8_decode_whatwg` 与 TextDecoder 逐字节对齐，对照物不再存在 ⇒ 旁路连同命令一并拆除。

/* -------- 解码判据共享常量表（W12 ENC-SRC：TS 内核与本宿主共读同一份，不许有第二份 if 链） -------- */

/// 表体 = `packages/plugin-api/src/decode-probe-policy.json`（**编译期内嵌**，不是运行期可丢的外部文件）。
/// TS 侧镜像常量 `DECODE_PROBE_POLICY` 与本文件的逐字对拍钉在
/// `packages/kernel/tests/encoding-decode-policy.test.ts`；Rust 消费本表钉在
/// `search_tests.rs::policy_table_decodes_golden_samples`（同一组字节样本 + 同一组期望文本）。
const DECODE_PROBE_POLICY_JSON: &str =
    include_str!("../../../plugin-api/src/decode-probe-policy.json");

#[derive(Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct DecodeBomRuleDto {
    /// BOM 字节前缀（判序第一环）
    bom: Vec<u8>,
    /// 命中后的编码名（`FileEncoding` 取值；经 `encoding_for` 查解码器）
    encoding: String,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct DecodeProbePolicyDto {
    /// 策略形状的版本闸：v1 = "BOM 判序 → UTF-8 严格（fatal）→ fallback 不严格（U+FFFD 替换）"
    version: u32,
    bom_rules: Vec<DecodeBomRuleDto>,
    fallback_encoding: String,
}

impl DecodeProbePolicyDto {
    /// 机械校验（不静默）：版本、条目非空、BOM 非空、每个编码名都能落到解码器。
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!("解码策略版本不受支持：{}（本宿主只实现 v1 形状）", self.version));
        }
        if self.bom_rules.is_empty() {
            return Err("解码策略缺 BOM 判序条目".to_string());
        }
        for r in &self.bom_rules {
            if r.bom.is_empty() {
                return Err("解码策略的 BOM 条目为空串".to_string());
            }
            encoding_for(&r.encoding)?;
        }
        encoding_for(&self.fallback_encoding)?;
        Ok(())
    }

    /// 判序第一环：按表序逐条做 BOM 前缀匹配（第一条命中即短路）。
    fn bom_rule_for(&self, bytes: &[u8]) -> Option<&DecodeBomRuleDto> {
        self.bom_rules.iter().find(|r| bytes.starts_with(&r.bom))
    }
}

/// 内嵌表的惰性解析 + 校验（失败 = 检索命令显式报错，不静默降级）。
fn decode_policy() -> Result<&'static DecodeProbePolicyDto, String> {
    static POLICY: OnceLock<DecodeProbePolicyDto> = OnceLock::new();
    static FAILED: OnceLock<String> = OnceLock::new();
    if let Some(e) = FAILED.get() {
        return Err(e.clone());
    }
    if let Some(p) = POLICY.get() {
        return Ok(p);
    }
    let parsed: DecodeProbePolicyDto = serde_json::from_str(DECODE_PROBE_POLICY_JSON)
        .map_err(|e| format!("内嵌解码策略表解析失败：{e}"))?;
    parsed.validate().map_err(|e| format!("内嵌解码策略表非法：{e}"))?;
    Ok(POLICY.get_or_init(|| parsed))
}

/// WHATWG Encoding Standard 的 UTF-8 decode（不严格口径），**逐错误事件一个 U+FFFD**：
/// - 非法引导字节 / 序列中途遇到非法后续字节 ⇒ 一个 U+FFFD，游标只前进一个字节（失败字节重进状态机）；
/// - 合法前缀在流尾截断 ⇒ 整个未完成序列只出一个 U+FFFD。
///
/// 为什么宿主不直接用 `encoding_rs::UTF_8.decode`：它把**连跑的非法字节段**合并成一个 U+FFFD，
/// 而浏览器 TextDecoder 按上面规则逐错误给（§5.90 对照探针实测的唯一分叉）。检索命中的行文本
/// 要与编辑器读出逐字相同，这一支就必须按 TextDecoder 的口径实现。合法输入与
/// `String::from_utf8` 逐字一致（先整体校验直通，非法才走本函数）。
fn utf8_decode_whatwg(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            out.push(b as char);
            i += 1;
            continue;
        }
        // (序列总长, 第二个字节的合法区间下界, 上界)；None = 非法引导字节
        let spec = match b {
            0xC2..=0xDF => Some((2usize, 0x80u8, 0xBF)),
            0xE0 => Some((3, 0xA0, 0xBF)),
            0xE1..=0xEC | 0xEE..=0xEF => Some((3, 0x80, 0xBF)),
            0xED => Some((3, 0x80, 0x9F)), // 代理区排除（WTF-8 拒绝，与 std 同口径）
            0xF0 => Some((4, 0x90, 0xBF)), // 过短编码排除
            0xF1..=0xF3 => Some((4, 0x80, 0xBF)),
            0xF4 => Some((4, 0x80, 0x8F)), // 超过 U+10FFFF 排除
            _ => None,
        };
        let Some((len, lo, hi)) = spec else {
            out.push('\u{FFFD}');
            i += 1;
            continue;
        };
        let mut j = i + 1;
        let mut status = 0u8; // 0=OK 推进中；1=非法续字节；2=流尾截断
        while j < i + len {
            if j >= bytes.len() {
                status = 2;
                break;
            }
            let c = bytes[j];
            let ok = if j == i + 1 { c >= lo && c <= hi } else { (0x80..=0xBF).contains(&c) };
            if !ok {
                status = 1;
                break;
            }
            j += 1;
        }
        match status {
            0 => {
                // 序列完整且合法：按 str 直落（from_utf8 不可能失败——上面按表逐字节核过）
                out.push_str(std::str::from_utf8(&bytes[i..i + len]).unwrap_or("\u{FFFD}"));
                i += len;
            }
            1 => {
                // 序列中途非法：一个替换字符，游标只进一个字节（失败字节下一轮重进状态机）
                out.push('\u{FFFD}');
                i += 1;
            }
            _ => {
                // 流尾截断：整个未完成缓冲只出一个替换字符
                out.push('\u{FFFD}');
                i = bytes.len();
            }
        }
    }
    out
}

/// 字节 → 文本，判据 = `policy`（TS 内核 `decodeWithProbe` 的另一名解释者，逐条同形）：
/// BOM 命中 ⇒ 该编码不严格解码（BOM 由解码器按标准剥掉）；否则 UTF-8 严格校验直通
/// （零拷贝借用语义保留）；再否则**三族裁决**（shift_jis / gbk / big5，与内核
/// `decodeWithProbe` → `probeLegacyCjk` 同判序；表里 `fallbackEncoding` 就是裁决的基准族
/// shift_jis ⇒ 三族零分时逐字节等价于旧的单族兜底）。
/// 与 TS 侧的逐字一致性由对拍测试钉死；替换字符出现时出声（不静默），文本照旧返回。
fn decode_with_policy<'a>(bytes: &'a [u8], policy: &DecodeProbePolicyDto) -> Result<Cow<'a, str>, String> {
    if let Some(rule) = policy.bom_rule_for(bytes) {
        return Ok(match rule.encoding.as_str() {
            // utf-8 家族：不严格支必须与 TextDecoder 逐错误等量 ⇒ 自带 WHATWG 解释器
            "utf-8" | "utf-8-bom" => {
                let body = bytes.strip_prefix(rule.bom.as_slice()).unwrap_or(bytes);
                match std::str::from_utf8(body) {
                    Ok(s) => Cow::Borrowed(s),
                    Err(_) => {
                        eprintln!("[search] {}：非法 UTF-8 序列已按 WHATWG 口径替换为 U+FFFD", rule.encoding);
                        Cow::Owned(utf8_decode_whatwg(body))
                    }
                }
            }
            other => {
                let enc = encoding_for(other)?;
                let (text, _actual, had_errors) = enc.decode(bytes);
                if had_errors {
                    eprintln!("[search] {other}：解码出现替换字符（输入非法或不完整）");
                }
                Cow::Owned(text.into_owned())
            }
        });
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Ok(Cow::Borrowed(s)),
        Err(_) => {
            // PS-1 §6：这里曾是"按表单族（shift_jis）解一遍"，与内核的三族裁决脱节
            // —— 裁决那一份（`decode_legacy_family`）当时是死代码。GBK/Big5 的中文正文
            // 因此在检索预览里是 SJIS 乱码、且中文查询词匹配不上，而编辑器打开同一份
            // 字节看到的是裁决后的文本。现在两条判序合成一条。
            if policy.fallback_encoding == "shift_jis" {
                return Ok(decode_legacy_family(bytes));
            }
            // 表被改成别的兜底族时**不**悄悄套用三族裁决（裁决的基准族是 shift_jis）：
            // 按表原样解码，让"表说了算"这条不褪色。
            let enc = encoding_for(&policy.fallback_encoding)?;
            let (text, _, had_errors) = enc.decode(bytes);
            if had_errors {
                eprintln!("[search] {}：解码出现替换字符", policy.fallback_encoding);
            }
            Ok(Cow::Owned(text.into_owned()))
        }
    }
}

/// 字符串 → 字节的同步核心（`utf-8-bom` 显式加 BOM）。
/// 审阅 M2 修复（2026-10-10）：encoding_rs 对不可映射字符默认输出 HTML
/// numeric entity（`&#NNNN;`），静默写入即数据损坏（引擎读为字面乱码）。
/// 有 had_errors 一律拒绝并报错，由调用方提示"内容含该编码无法表示的字符"。
///
/// 这一支是**整篇转码**（一份 2.35 MB / 52,601 行的口上按 shift_jis 编一遍不是零成本），
/// 曾与命令同体跑在 IPC handler 线程上 ⇒ 拆成同步核心 + async 壳（PS-1 §1）。
fn encode_string_of(text: String, encoding: &str) -> Result<Vec<u8>, String> {
    Ok(match encoding {
        "utf-8" => text.into_bytes(),
        "utf-8-bom" => {
            let mut v = Vec::with_capacity(3 + text.len());
            v.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            v.extend_from_slice(text.as_bytes());
            v
        }
        other => {
            let enc = encoding_for(other)?;
            let (encoded, _, had_errors) = enc.encode(&text);
            if had_errors {
                return Err(format!(
                    "内容含 {other} 无法表示的字符（如简体字/Emoji 被替换为 HTML 实体），已拒绝写入以防乱码；请先移除这些字符或将文件转为 UTF-8"
                ));
            }
            encoded.into_owned()
        }
    })
}

#[tauri::command]
async fn encode_string(text: String, encoding: String) -> Result<String, String> {
    run_blocking("encode_string", move || {
        encode_string_of(text, &encoding).map(|buf| B64.encode(buf))
    })
    .await
}

/* ---------------------------- 文件监视（BUG-5） ---------------------------- */
//
// 本层只做两件事：起 notify 递归监视、把**原始**事件逐条转发给 WebView。
// 去抖 / 合并 / 「是不是我自己写的」判定全在内核 TS（口径见
// `packages/plugin-api/src/platform.ts` 的 `WatchCallback` 注释：
// 「内核会在平台事件之上做去抖与归一化」）。
//
// 唯一的例外是下面 `is_atomic_write_temp`：那是**本文件自己的原子写产物**
// （`write_file_bytes` 造 `.{name}.{pid}-{序号}.kojo-tmp` 再 rename），属于 IO 机械噪声，
// 留在 IO 层滤掉，不算业务策略。

/// WebView 事件名：原始文件变更。payload = `{ kind, path }`。
const FS_CHANGED_EVENT: &str = "kojo:fs-changed";
/// WebView 事件名：监视器自身出错（目录被卸载 / 句柄失效等）。payload = `{ error }`。
/// 单独一条通道而不是塞进 FS_CHANGED_EVENT，是为了让前端**显式降级**而不是静默失灵。
const FS_WATCH_ERROR_EVENT: &str = "kojo:fs-watch-error";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangedPayload {
    /// 与 `plugin-api` 的 `FileChangeKind` 一一对应
    kind: &'static str,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchErrorPayload {
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedRoot {
    path: String,
    error: String,
}

/// `start_watch` 回执：哪些根真的监视上了、哪些没有以及为什么。
/// 全空不算错误（返回 Ok），由前端据此进入「监视不可用」的显式降级态。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchReport {
    watched: Vec<String>,
    failed: Vec<FailedRoot>,
}

/// 原子写的临时文件不算内容变更：rename 之后目标路径会自己出一条事件，
/// 临时文件那两条（create / remove）纯属重复噪声，还会让消费方读到半成品。
fn is_atomic_write_temp(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with('.') && name.ends_with(".kojo-tmp"))
        .unwrap_or(false)
}

/// 监视忽略目录段（P0-5）：事件路径**任一段**命中此表 ⇒ 整条丢弃（不入 watch 事件）。
///
/// 保守清单——只排 VCS / 依赖 / 编辑器自身临时目录（`.kojo-tmp` 是 `write_file_bytes`
/// 临时文件的目录段形态，文件名级过滤见上）。eraTW 语料的 CSV / ERB / ERH / ERD
/// 与一切作者内容**不在此列**：忽略表宁可小，多收的事件去抖层自会收敛，
/// 反过来误排作者目录就是静默失明。搜索侧的 `is_hidden_entry`（跳过一切点开头）
/// 口径更宽，那是**读取面**的取舍，不许照搬到监视面。
const WATCH_IGNORED_SEGMENTS: [&str; 3] = [".git", "node_modules", ".kojo-tmp"];

/// 路径任一段命中忽略表（精确段匹配 + 大小写不敏感——Windows 上 `.GIT` 与 `.git`
/// 是同一目录）。`.git-repo` 这类**前缀相似**的名字不命中。
fn is_watch_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| {
                WATCH_IGNORED_SEGMENTS
                    .iter()
                    .any(|seg| s.eq_ignore_ascii_case(seg))
            })
            .unwrap_or(false)
    })
}

/// notify 事件类别 → 契约三态（纯函数，可单测）。`None` = 本层丢弃。
fn normalize_event_kind(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("add"),
        EventKind::Remove(_) => Some("unlink"),
        // 改名前的旧名 = 那个路径的东西没了
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some("unlink"),
        // RenameTo / RenameBoth 归 change：消费方按「盘上内容可能变了」重读，
        // 比按「新文件」处理更保守（Both 场景下两个路径谁是谁都分不清）。
        EventKind::Modify(_) => Some("change"),
        // 分不出类别的变更宁可多报，由消费方的内容比对收敛（绝不静默丢事件）
        EventKind::Any | EventKind::Other => Some("change"),
        // 纯读取：索引构建本来就在成千次读盘，转发会变成事件风暴
        EventKind::Access(_) => None,
    }
}

/// 托管状态：当前唯一的监视会话。
/// 内核是 `watchDirs` 的唯一调用方 ⇒ 不做多会话引用计数；重复 start = 换一批根目录
/// （旧 watcher 在这里被赋值 Drop，notify 的 Drop 会注销底层句柄）。
#[derive(Default)]
struct WatchState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    // 刻意保持同步命令（REF-FRONT-PERF 复核）：监视会话没有 token，stop 只认"当前
    // watcher"。若把 start 挪到阻塞线程池，两次 start 重叠时旧 start 的返回值会让
    // 内核的 stale-session un() 调到同一个 stop_watch —— 旧会话会把新会话的句柄停掉。
    // 要异步化必须先给 start/stop 加会话 token；这条是低频路径，不值得在本批引入。
}

/// notify 回调 → WebView 事件。零判断，逐条透传。
struct WebviewForwarder {
    app: tauri::AppHandle,
}

impl notify::EventHandler for WebviewForwarder {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        use tauri::Emitter;
        match event {
            Ok(ev) => {
                let Some(kind) = normalize_event_kind(&ev.kind) else {
                    return;
                };
                for path in ev.paths {
                    if is_atomic_write_temp(&path) || is_watch_ignored(&path) {
                        continue;
                    }
                    let Some(path) = path.to_str() else {
                        continue; // 非 UTF-8 路径：IPC 走 JSON，无法承载；不静默——见前端 roots 计数
                    };
                    let _ = self.app.emit(
                        FS_CHANGED_EVENT,
                        FsChangedPayload {
                            kind,
                            path: path.to_string(),
                        },
                    );
                }
            }
            Err(err) => {
                let _ = self.app.emit(
                    FS_WATCH_ERROR_EVENT,
                    WatchErrorPayload {
                        error: err.to_string(),
                    },
                );
            }
        }
    }
}

/// 起（或换）监视会话：递归监视 `paths`，原始事件转发到 WebView。
#[tauri::command]
fn start_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    paths: Vec<String>,
) -> Result<WatchReport, String> {
    use notify::Watcher;
    // P0-5 缓冲调优：显式给出 poll 间隔（不再吃 `Config::default()` 的静默值）。
    // 两条已核实的边界（notify 8.2 源码取证，本 crate 无更大 API 面）：
    // ① `with_poll_interval` 只作用于 PollWatcher 退化路径——Windows 主路径
    //    （ReadDirectoryChangesW）不受影响，但 RecommendedWatcher 在个别环境会
    //    退化成轮询，500ms 保证退化时也能较快跟上盘面；
    // ② Windows 主路径的 OS 缓冲是 notify 内部常量 `BUF_SIZE = 16384`（16KB），
    //    **没有公开配置项**；事件风暴撑爆缓冲时 notify 报 Err → 走
    //    `FS_WATCH_ERROR_EVENT` → 前端重连状态机接管重建（P0-5 的 TS 半边），
    //    这就是"缓冲溢出不丢事件、变成一次可见的失效-自愈"的闭环。
    let config = notify::Config::default().with_poll_interval(std::time::Duration::from_millis(500));
    // 同步建监视器 + 逐根登记：与 stop_watch 在同一条 IPC 串行语义里，避免
    // "旧 start 的 stop 杀掉新 watcher"（见 WatchState 的说明）。
    let mut watcher = notify::RecommendedWatcher::new(WebviewForwarder { app }, config)
        .map_err(|e| format!("创建文件监视器失败: {e}"))?;

    let mut watched = Vec::new();
    let mut failed = Vec::new();
    for p in paths {
        match watcher.watch(Path::new(&p), notify::RecursiveMode::Recursive) {
            Ok(()) => watched.push(p),
            Err(e) => failed.push(FailedRoot {
                path: p,
                error: e.to_string(),
            }),
        }
    }

    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "watch state poisoned".to_string())?;
    *guard = Some(watcher);
    Ok(WatchReport { watched, failed })
}

/// 停监视（project.closed / 桥卸载）。丢弃 watcher 即注销句柄。
#[tauri::command]
fn stop_watch(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "watch state poisoned".to_string())?;
    *guard = None;
    Ok(())
}

/* ------------------------- 外部文件拖放（drag-drop 批） ------------------------- */
//
// Tauri v2 的 `dragDropEnabled` 默认为 true：OS 文件拖放被 webview 层拦截，
// HTML5 `drop` 事件拿不到本地路径 ⇒ 唯一可靠通道是在这里接窗口事件并转发。
// 本链路**只负责把路径说给前端听**；前端只拿去打开（读），不参与任何写授权
// ⇒ 零新增命令、零写允许域改动。

/// WebView 事件名：OS 文件拖放。payload = `{ phase, paths }`。
const DRAG_DROP_EVENT: &str = "kojo:drag-drop";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DragDropPayload {
    /// 'enter' | 'over' | 'leave' | 'drop'——前端覆盖提示状态机直接消费
    phase: &'static str,
    /// 仅 drop 携带路径；其余 phase 恒为空数组（理由见 `map_drag_drop`）
    paths: Vec<String>,
    /// 光标坐标（B6）：enter/over/drop 携带，leave 为 None（None 时整个字段不序列化，
    /// 老前端少读一个字段不炸——向后兼容口径）。语义见 `map_drag_drop`。
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<f64>,
}

/// Tauri 拖放事件 → 转发载荷（纯函数，可单测）。
/// `drop` 之外的 phase 刻意丢掉路径：enter/over 每秒刷屏几十次，
/// 前端只用它们亮/灭覆盖提示，转发路径只会白撑 IPC 载荷。
/// 坐标（B6）例外地三个相位都透传：over 的坐标是"拖悬高亮哪个目录行"的命入口——
/// 每秒几十次也只是两个 f64，比前端自己起一套坐标系便宜得多。
///
/// 坐标语义（wry webview2 `ScreenToClient` 兑换过）：**webview 客户区物理像素**；
/// 前端除以 `devicePixelRatio` 即 `elementFromPoint` 要的 CSS 像素。
fn map_drag_drop(event: tauri::DragDropEvent) -> Option<DragDropPayload> {
    use tauri::DragDropEvent as D;
    let (phase, paths, pos) = match event {
        D::Enter { position, .. } => ("enter", Vec::new(), Some(position)),
        D::Over { position } => ("over", Vec::new(), Some(position)),
        D::Drop { paths, position } => {
            let paths = paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            ("drop", paths, Some(position))
        }
        D::Leave => ("leave", Vec::new(), None),
        // #[non_exhaustive]：上游将来新增 phase 时不冒充已知状态——宁可不提示也不给错的
        _ => return None,
    };
    Some(DragDropPayload {
        phase,
        paths,
        x: pos.map(|p| p.x),
        y: pos.map(|p| p.y),
    })
}

/* -------------------- 全文检索（通用 IO 原语，零游戏知识） -------------------- */
//
// ADR-0003：本层只做 IO 原语——"读盘 + 匹配 + 切行"是纯机械活，不认识任何领域概念
// （哪个目录是口上、哪个文件是剧本，全由调用方给 `roots`，本层只当路径用）。
//
// 为什么下沉到 Rust 而不是前端 Worker 池：语料 3.8k 文件 / 4.1M 行，索引阶段单是
// 读盘就累计 45.1s（并发 8 摊到 ~9.0s 墙钟）；检索每次查询都要**全量重读**，把这份
// 字节搬过 IPC 再在 JS 里匹配，等于把最贵的一段压在最热的路径上（还顺手把 4M 行的
// 副本留在 WebView 内存里）。原生线程 + regex 在同一份字节上匹配，只有命中行过 IPC。
//
// 编码口径：**先解码再匹配**（不是"ASCII 按字节匹配 + 命中行再解码"）。
// 理由：混编码语料里 utf-16 文件按字节永远匹配不到，字节路径必须特判；而"正则 /
// 全词 / 大小写"三个开关在两条路径上会各有一套语义（正则根本无法按字节解释非 ASCII）。
// 统一解码只有一套语义，代价是每文件多一趟解码——`byte_prefilter` 把大多数文件挡在
// 解码之前（字面量 + 大小写敏感时，查询的**宽度等价形**仍以原字节出现在合法 UTF-8
// 文件里；遗留族不预筛，见 `byte_prefilter` 的半径说明）。
//
// 宽度折叠（2026-10-20）：字面量查询在匹配前做**全角/半角折叠**（U+FF01–U+FF5E ↔
// U+0021–U+007E、U+3000 ↔ 空格；只折宽度，不折繁简/假名/大小写）。实现不是改写查询与
// 正文，而是把查询逐字符展开成"宽度等价类"（一个同时含 `(` 与 `（` 的字符类）——
// 命中偏移仍落在原文上，预览/高亮/替换坐标无需二次换算。恒开，无开关；需要精确宽度时
// 用正则模式（作者拥有 pattern，本层不折）。与 TS 替换侧同表同样例，见
// `search_tests.rs` 的 `WIDTH_FOLD_CASES`。

/// 命中条数硬顶（前端上限之上再兜一层：IPC 载荷不许失控）
const SEARCH_HARD_CAP: usize = 5000;
/// 单文件命中上限（一个巨型文件不许吃掉全部结果）
const SEARCH_PER_FILE_CAP: usize = 500;
/// 命中行预览长度上限（UTF-16 code unit）
const SEARCH_PREVIEW_UNITS: usize = 240;
/// 大文件跳过阈值（字节）；跳过一律计数上报，不静默
const SEARCH_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// 二进制嗅探窗口（字节）
const SEARCH_SNIFF_BYTES: usize = 8192;
/// 进度节流：文件数或时间先到者报
const SEARCH_PROGRESS_FILES: usize = 200;
const SEARCH_PROGRESS_MS: u128 = 150;
/// 缺省并行度（与实际读盘段同量级：索引阶段就是 8 路并发）
const SEARCH_DEFAULT_THREADS: usize = 8;

/// WebView 事件名：检索进度。payload = `SearchProgressPayload`。
const SEARCH_PROGRESS_EVENT: &str = "kojo:search-progress";
/// WebView 事件名：检索命中文件增量（P2-11 流式检索）。payload = `SearchFilesPayload`。
///
/// 与进度事件**同一处节流点**发出（`SEARCH_PROGRESS_FILES` / `SEARCH_PROGRESS_MS`，
/// 见 `run_search_with_files`）：命中文件随扫随到，壳层随到随画；收口后再补最后一批
/// （`done: true`，带残留文件与终态标志）。**完成态仍以 `search_text` 的返回值为准**，
/// 事件只做增量累积——两者的对齐契约见 `SearchFilesPayload` 的文档。
const SEARCH_FILES_EVENT: &str = "kojo:search-files";

/// 取消集合：`cancel_search` 写入、检索线程逐文件读取。
/// 用 id 而不是布尔——同一时刻可能有多条检索（前端 id 自增），
/// 取消必须精确命中一条，不许把别人的检索一起掐掉。
#[derive(Default)]
struct SearchState {
    cancelled: std::sync::Arc<Mutex<HashSet<u64>>>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SearchOptionsDto {
    is_regex: Option<bool>,
    case_sensitive: Option<bool>,
    whole_word: Option<bool>,
    /// 限定扩展名（大小写与点号由本层再归一化一道：调用方给脏数据也不放行）
    extensions: Option<Vec<String>>,
    /// 限定路径形态（glob：`*.kojo` / `src/**/*.erb` / `?`；P2-15）。
    /// 与 `extensions` 是**且**的关系（两者都满足才扫）；空 / None = 不按形态过滤
    /// （老调用方零改动）。大小写**敏感**——glob 是作者显式写的路径模式，
    /// 与扩展名"折小写再比"的口径刻意不同（要宽松请写全小写，语料扩展名本就小写）。
    /// 翻译与匹配规则见 `glob_to_regex` / `collect_files`。
    globs: Option<Vec<String>>,
    max_results: Option<usize>,
    /// 并行度（缺省 8；上限 32 防"给我 512 线程"这类输入）
    threads: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SearchRequestDto {
    /// 调用方自增 id：进度事件按它过滤，取消按它认领
    search_id: u64,
    /// 检索根（一个或多个；重叠/嵌套由本层去重）
    roots: Vec<String>,
    query: String,
    options: SearchOptionsDto,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct SearchMatchDto {
    /// 1 基行号
    line: u32,
    /// 1 基列号（UTF-16 code unit，与 JS / Monaco 同口径）
    column: u32,
    /// 命中行文本（超长时以命中为中心开窗，两端的省略号算在窗口里）
    preview: String,
    /// 命中区间在 `preview` 内的起止（UTF-16 code unit，半开）
    start: u32,
    end: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchFileDto {
    path: String,
    matches: Vec<SearchMatchDto>,
}

#[derive(Serialize, Default, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
struct SearchSkippedDto {
    /// 含 NUL 且非 utf-16（二进制：不参与检索，但要说得清跳过了多少）
    binary: u32,
    too_large: u32,
    /// 读不到的文件（metadata / 读字节失败 + 遍历条目失败）——两者都是"这个文件没被检索"
    unreadable: u32,
    /// 扩展名过滤挡下的文件数
    filtered: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResultDto {
    /// 按路径升序（并行合并后排序 ⇒ 线程数不影响输出顺序）
    files: Vec<SearchFileDto>,
    total_matches: u64,
    /// 结果不完整（命中上限 / 单文件上限 / 取消）——前端必须显式说明，不许看起来"搜完了"
    truncated: bool,
    cancelled: bool,
    files_scanned: u32,
    skipped: SearchSkippedDto,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchProgressPayload {
    search_id: u64,
    files_scanned: u32,
    total_files: u32,
    match_count: u64,
}

/// 流式批次载荷（P2-11）：节流点把累积的命中文件分批送出。
///
/// `files` 是**借用**（`&[SearchFileDto]`）：批次 drain 出去后一份 emit、一份留进
/// 收口 accumulator，两边都要用 ⇒ 借用让"零拷贝、零 Clone"成立（`SearchFileDto`
/// 不需要为此长出 `Clone`）。序列化形状与 owned `Vec` 逐字相同（壳层拿到的是
/// 同一个 JSON 数组）。
///
/// 对齐契约（壳层 `search-store.ts` 的收口逻辑据此写）：
/// **最终结果 = 已 emit 的批次 ∪ 收口时的残留批次**，且完成态按路径排序、带上限裁决，
/// 因此 `search_text` 的返回值必是事件流的超集——壳层收口时以完成态为准，
/// 绝不会出现"事件说三条、最终态说两条"。`done` 只有最后一批为 true
/// （残留文件 + 终态标志；中途批次的 `truncated` / `cancelled` 只是当时所知，不作准）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilesPayload<'a> {
    search_id: u64,
    files: &'a [SearchFileDto],
    done: bool,
    truncated: bool,
    cancelled: bool,
}

/// UTF-16 code unit 长度（JS 字符串下标的口径）
fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

fn utf16_units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// 省略号（U+2026）——作为 UTF-16 单元直接塞进窗口
const ELLIPSIS_UNIT: u16 = 0x2026;

/// 命中行 → 预览窗口。超长行以命中为中心开窗；两端截断时加省略号（计入窗口）。
/// 返回 (窗口单元, 命中起点, 命中终点)，偏移**相对返回的窗口**。
///
/// **不截断时返回借用切片**（PS-1 §3）：命中行绝大多数本来就短于 240 单元，
/// 旧口径为每个命中先 `to_vec()` 复制整行单元、再 `String::from_utf16_lossy` 复制一遍。
fn preview_window<'a>(
    units: &'a [u16],
    start: usize,
    end: usize,
    cap: usize,
) -> (Cow<'a, [u16]>, u32, u32) {
    let total = units.len();
    if total <= cap {
        return (Cow::Borrowed(units), start as u32, end as u32);
    }
    // 命中比窗口还长时，窗口至少装得下整段命中（宁可超一截预览，不可把命中切没）
    let hit_len = end.saturating_sub(start);
    let window = cap.max(hit_len);
    let half = window.saturating_sub(hit_len) / 2;
    let from = start.saturating_sub(half).min(total.saturating_sub(window));
    let to = (from + window).min(total);
    let head_trim = from > 0;
    let tail_trim = to < total;
    let mut out: Vec<u16> = Vec::with_capacity(window + 2);
    if head_trim {
        out.push(ELLIPSIS_UNIT);
    }
    out.extend_from_slice(&units[from..to]);
    if tail_trim {
        out.push(ELLIPSIS_UNIT);
    }
    let lead = if head_trim { 1 } else { 0 };
    (
        Cow::Owned(out),
        (lead + start - from) as u32,
        (lead + end - from) as u32,
    )
}

/// 宽度折叠的**规范形**（半角）：全角 ASCII 区 U+FF01–U+FF5E 折回 U+0021–U+007E，
/// U+3000（全角空格）折成 U+0020，其余字符原样。**只折宽度**——不折繁简（`髙`≠`高`）、
/// 不折假名（`ｱ` 在 U+FF71，表外）、不折大小写（那是 `case_sensitive` 开关的事）。
///
/// 跨语言契约：与 TS `packages/app/src/ui/search-replace.ts` 的 `foldWidth` **同一张表**
/// （同一组码点区间与位移 0xFEE0）；两侧样例数组 `WIDTH_FOLD_CASES` 逐字同源——
/// **改一处必须改两处**（两套测试各有自己的加载面，不引共享数据文件）。
fn fold_width(ch: char) -> char {
    let cp = ch as u32;
    if (0xFF01..=0xFF5E).contains(&cp) {
        char::from_u32(cp - 0xFEE0).unwrap_or(ch)
    } else if cp == 0x3000 {
        ' '
    } else {
        ch
    }
}

/// 规范半角形 → 另一半（全角形）：U+0021–U+007E → U+FF01–U+FF5E，空格 → U+3000，
/// 其余原样。与 [`fold_width`] 合成一个宽度等价类（两种形态）。
fn unfold_width(ch: char) -> char {
    let cp = ch as u32;
    if (0x0021..=0x007E).contains(&cp) {
        char::from_u32(cp + 0xFEE0).unwrap_or(ch)
    } else if cp == 0x0020 {
        '\u{3000}'
    } else {
        ch
    }
}

/// 字面量查询 → **宽度折叠等价**的正则源码：每个字符展开成它的宽度等价类
/// （`（` 展开成一个同时含 `(` 与 `（` 的字符类；`Ａ` 展开成含 `A` 与 `Ａ` 的类；
/// U+3000 展开成含空格与全角空格的类；单形字符照常转义）。
/// 逐字符一一展开、长度不变 ⇒ 命中偏移仍落在原文上，预览与替换坐标不用二次换算。
///
/// **只用于非正则查询**：正则模式下作者拥有 pattern 的解释权，折叠字符会改写转义 /
/// 字符类 / 量词的语义（如 `\x{FF08}`），故原样编译、不折——这也正是"需要精确宽度
/// 匹配"时的逃生口。
fn literal_width_pattern(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 4);
    for ch in query.chars() {
        let half = fold_width(ch);
        let full = unfold_width(half);
        if half == full {
            out.push_str(&regex::escape(&half.to_string()));
        } else {
            // 字符类内只需防 `\` / `]` / `^` / `-`；`regex::escape` 转义得更宽（`(` 等
            // 也带反斜杠），但那些转义在类内同样合法，预览不会因此变化
            out.push('[');
            out.push_str(&regex::escape(&half.to_string()));
            out.push_str(&regex::escape(&full.to_string()));
            out.push(']');
        }
    }
    out
}

/// 标识字符（与前端 `search-replace.ts` 的 `IDENT_RE = /[\p{L}\p{N}_]/u` 同一字符集）。
///
/// **不用 `\b`**：regex crate 的 Unicode `\b` 以 `\w` 为词符（含组合记号与 Join_Control），
/// 而且要求模式首尾两侧是"词符↔非词符"的过渡——模式自身首尾是非词字符（如 `（测试）`）
/// 时，它在行首/行尾永远等不到边界，与替换侧（逐格看相邻字符）对同一份样例给出相反裁决。
///
/// **先折宽度再判**：`＿`（U+FF3F）折成 `_` 后是标识字符，与半角写法同判；其余全角
/// 标点/字母折成 ASCII 后与半角同判。调用方传入的应是 [`fold_width`] 之后的形式
/// （见 [`SearchMatcher::whole_word_ok`]）。
///
/// **非 BMP 字符按"非标识"处理**：前端取相邻的是**一个 UTF-16 单元**（`line[start - 1]`），
/// 代理对的一半永远匹配不上 `\p{L}\p{N}` ⇒ 前端把任何非 BMP 字符当非标识字符。
/// 这里保持同一判据（`len_utf16() == 1`），跨语言对账才逐字同判。
fn is_ident_char(ch: char) -> bool {
    static IDENT: OnceLock<Regex> = OnceLock::new();
    // ASCII 快道：与 `[\p{L}\p{N}_]` 的 ASCII 子集逐字相同（英文字母 / 数字 / 下划线）
    if ch.is_ascii() {
        return ch.is_ascii_alphanumeric() || ch == '_';
    }
    if ch.len_utf16() != 1 {
        return false;
    }
    let re = IDENT.get_or_init(|| Regex::new(r"^[\p{L}\p{N}_]$").expect("IDENT 字符类必须可编译"));
    let mut buf = [0u8; 4];
    re.is_match(ch.encode_utf8(&mut buf))
}

/// 全词匹配器：`re` 只装模式本身，全词边界在命中后**逐侧看一格字符**
/// （与 TS 侧 `wholeWordOk` 同一判据；行首/行尾 = 该侧没有相邻字符）。
#[derive(Debug)]
struct SearchMatcher {
    re: Regex,
    whole_word: bool,
}

impl SearchMatcher {
    /// 命中区间两侧都不是标识字符（或没有相邻字符）才算全词。
    /// 相邻格先做宽度折叠（`＿` → `_` 等），与 TS 侧 `wholeWordOk` 同判。
    fn whole_word_ok(&self, text: &str, start: usize, end: usize) -> bool {
        if !self.whole_word {
            return true;
        }
        let before = text[..start].chars().next_back().map(fold_width);
        let after = text[end..].chars().next().map(fold_width);
        !before.is_some_and(is_ident_char) && !after.is_some_and(is_ident_char)
    }

    /// 命中迭代（全词在此过滤）。`find_iter` 的不重叠推进与 TS 侧 `g` 正则一致：
    /// 被全词判据拒掉的命中不会让引擎回头寻找"重叠"的下一处。
    fn find_iter<'t>(&'t self, text: &'t str) -> impl Iterator<Item = regex::Match<'t>> + 't {
        let whole_word = self.whole_word;
        self.re
            .find_iter(text)
            .filter(move |m| !whole_word || self.whole_word_ok(text, m.start(), m.end()))
    }

    /// 单测直读用（生产路径只经 `find_iter`）。
    #[cfg(test)]
    fn is_match(&self, text: &str) -> bool {
        self.find_iter(text).next().is_some()
    }
}

/// 模式 + 三个开关 → 匹配器。口径 = **逐行匹配**（grep 语义：`^`/`$` 落在行首行尾，
/// 跨行模式不参与；这与"点开能看到行号"的宿主呈现是一致的）。
/// 全词判据见 [`is_ident_char`] / [`SearchMatcher::whole_word_ok`]（与替换侧同一把尺）。
///
/// 字面量查询先做宽度折叠（[`literal_width_pattern`]）；正则查询原样编译（不折，
/// 作者拥有 pattern）。大小写开关仍由 `(?i)` 统一施加——宽度与大小写是两个维度。
fn build_matcher(
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<SearchMatcher, String> {
    let body = if is_regex {
        query.to_string()
    } else {
        literal_width_pattern(query)
    };
    let pattern = if case_sensitive {
        body
    } else {
        format!("(?i){body}")
    };
    Regex::new(&pattern)
        .map(|re| SearchMatcher { re, whole_word })
        .map_err(|e| format!("正则无效：{e}"))
}

/// 字节级预筛的产物：匹配器 + 一条"这份预筛对哪些文件成立"的强度标记（PS-1 §3）。
struct BytePrefilter {
    /// 按**宽度折叠等价类**编译的字节正则（`abc` → `[aａ][bｂ][cｃ]`）。
    re: regex::bytes::Regex,
    /// true ⇒ 查询是纯 ASCII 且**没有任何可折字符**（控制字符一类）：**所有** ASCII 兼容族
    /// （utf-8 / shift_jis / gbk / big5）都把它逐字节透传，字节里没有就等于文本里没有
    /// （legacy 族的双字节尾字节可能撞出误报，但误报只是多做一次解码，不漏报）。
    /// 一旦查询含可折字符（正常查询几乎都含），全角形的遗留族编码与 UTF-8 不同 ⇒
    /// 这条通道关闭，只对"整份字节是合法 UTF-8"的文件预筛。
    ascii_safe: bool,
}

/// 字面量 + 大小写敏感 ⇒ 可以在原始字节上先过一遍筛。
///
/// **口径放宽（PS-1 §3）**：旧实现只认"查询纯 ASCII"，而本产品缺省查询是中文
/// （`口上` 一类），于是 12,657 个候选文件**一个都预筛不掉**，全部解码 + 全文匹配。
/// 现在多一条成立通道：**整份字节本身是合法 UTF-8** 时，解码不改一个字节
/// （BOM 也只是剥前缀、命中文本仍在剩余字节里），字面量要命中就必然以同一串 UTF-8
/// 字节原样出现 ⇒ 非 ASCII 查询对 99.5% 的语料（utf-8 + utf-8-bom 6,690 + 5,907 份）同样能预筛。
/// 遗留族（shift_jis/gbk/big5，字节形不同）只在 `ascii_safe` 那条通道下被筛，否则照常解码匹配。
///
/// **宽度折叠（2026-10-20）**：预筛正则与匹配器用**同一份**宽度等价类（[`literal_width_pattern`]），
/// 否则半角查询会被字节层误杀全角正文（`A` 与 `Ａ` 的 UTF-8 字节不同）。折叠让
/// `ascii_safe` 通道对正常查询关闭：遗留族里全角形的字节与 UTF-8 不同，按 UTF-8 字节筛
/// 会漏杀。剩下 60 余份遗留族文件退回解码后匹配——只多一趟解码，绝不多一条漏报。
///
/// 大小写不敏感一律不预筛：Unicode 简单大小写折叠（如 U+212A KELVIN ↔ 'k'）会让
/// "字节里有"与"文本里能匹配"不再等价——省下的解码不值一次漏报。
///
/// **全词模式一律不预筛**：全词判据在**解码后的字符**上（相邻一格是不是 `[\p{L}\p{N}_]`）。
/// 把这条判据下推到字节层不可能保持等价——遗留族（shift_jis / gbk / big5）的尾字节
/// 可以落在 ASCII 标识字符区间（反之亦然），按字节判"边界"会筛掉解码后其实是全词命中的
/// 文件 = 漏报。预筛只许过近似、不许漏杀；而"裸字面量"预筛虽不漏，却完全不体现
/// whole_word。本层选择：全词模式不建预筛（宁可多解码，不可少结果），把该开关显式纳入判据。
fn byte_prefilter(
    query: &str,
    is_regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Option<BytePrefilter> {
    if is_regex || !case_sensitive || whole_word || query.is_empty() {
        return None;
    }
    regex::bytes::Regex::new(&literal_width_pattern(query))
        .ok()
        .map(|re| BytePrefilter {
            // 纯 ASCII 且无可折字符 ⇒ 旧通道仍成立；含可折字符（正常查询几乎都含）
            // ⇒ 只能对合法 UTF-8 文件预筛（见上）
            ascii_safe: query.is_ascii()
                && query.chars().all(|c| {
                    let half = fold_width(c);
                    half == c && unfold_width(half) == c
                }),
            re,
        })
}

/// 二进制判定：utf-16 的 NUL 是编码产物（不是二进制信号），故策略表里 utf-16 系 BOM
/// 命中的那支不算。判序仍然只读 `decode_policy()` 那一张表——检索不再自带第二份 BOM 判据。
fn is_utf16_bom_hit(bytes: &[u8], policy: &DecodeProbePolicyDto) -> bool {
    policy
        .bom_rule_for(bytes)
        .map(|r| r.encoding.starts_with("utf-16"))
        .unwrap_or(false)
}

fn looks_binary(bytes: &[u8], utf16ish: bool) -> bool {
    !utf16ish && bytes[..bytes.len().min(SEARCH_SNIFF_BYTES)].contains(&0)
}

/// 族评分：与内核 `encoding.ts` 的 `scoreLegacyFamily` **逐条一致**
/// （CJK 表意文字 / 中日韩标点与全角形式各 +1；假名族是日文独有证据、只计给 shift_jis、+2；
/// ASCII 与 U+FFFD 不计；半角片假名 U+FF61–U+FF9F 故意不计——GBK 垃圾按 SJIS 解的典型产物）。
fn cjk_family_score(text: &str, is_sjis: bool) -> i32 {
    let mut score = 0i32;
    for ch in text.chars() {
        let cp = ch as u32;
        if cp < 0x80 || cp == 0xFFFD {
            continue;
        }
        if (0x4E00..=0x9FFF).contains(&cp)
            || (0x3000..=0x303F).contains(&cp)
            || (0xFF01..=0xFF60).contains(&cp)
        {
            score += 1;
        } else if is_sjis
            && ((0x3041..=0x3096).contains(&cp) || (0x30A1..=0x30FA).contains(&cp) || cp == 0x30FC)
        {
            score += 2;
        }
    }
    score
}

/// 非 UTF-8 字节的三族裁决（shift_jis / gbk / big5），与内核 `probeLegacyCjk` 同规则：
/// gbk / big5 必须**全文件零替换字符**且分数**严格大于**当前最好者才上位；
/// 顺序 sjis → gbk → big5（平局归先者），三族零分 ⇒ 兜底 shift_jis（与旧口径逐字节一致）。
/// 检索预览与编辑器必须对同一份字节给出同一文本，两套探测会让结果与正文对不上。
///
/// **这一支现在是活路径**（PS-1 §6）：它曾只被 `search_tests` 引用（`decode_with_policy`
/// 的兜底只按表单族 shift_jis 解码），于是 GBK/Big5 正文在检索预览里是 SJIS 乱码、
/// 且中文查询词根本匹配不上——而编辑器打开同一份字节看到的是裁决后的文本。
/// 三族零分/含替换字符时照旧出声（铁律 4）。
fn decode_legacy_family(bytes: &[u8]) -> Cow<'_, str> {
    let (sjis, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
    let mut best: (i32, Cow<str>) = (cjk_family_score(&sjis, true), Cow::Owned(sjis.into_owned()));
    for enc in [encoding_rs::GBK, encoding_rs::BIG5] {
        let (text, _, had_errors) = enc.decode(bytes);
        if had_errors {
            continue;
        }
        let score = cjk_family_score(&text, false);
        if score > best.0 {
            best = (score, Cow::Owned(text.into_owned()));
        }
    }
    if best.1.contains('\u{FFFD}') {
        eprintln!("[search] 三族裁决后仍有非法字节（按替换字符呈现，不硬失败）");
    }
    best.1
}

/// 字节 → 检索用文本的**判序参照壳**（PS-1 §6）。
///
/// 曾经这里自带一份 BOM if 链（`utf16_bom_encoding`）+ 一份 UTF-8 校验 + 三族裁决，
/// 而活路径（`scan_file` → `decode_with_policy`）只按表单族 shift_jis 兜底 ⇒ 两套探测
/// 对同一份字节给出不同文本：检索预览与编辑器正文对不上，GBK/Big5 的中文查询词还整份
/// 匹配不上。现在三族裁决（`decode_legacy_family`）已接进 `decode_with_policy` 这条活路，
/// 那份自带的 BOM if 链随之删除；本壳只是把"表 + 裁决"这条**唯一判序**以最少的参数
/// 暴露给判据 ⇒ `search_tests` 里钉 GBK/Big5 不被强扭成 shift_jis 的用例，钉的是活行为。
/// 探测口径与内核 `probeEncoding` / `decodeWithProbe` 逐条一致：
/// BOM（表逐条）→ UTF-8 严格校验 → 三族评分 shift_jis/gbk/big5 → shift_jis 兜底。
/// 代价照旧：无 BOM 的 utf-16 会按兜底族解成乱码，且因含 NUL 被计入 `skipped.binary`
/// （可见、可数，不是静默漏报）。解码不硬失败（只读检索不该因单个坏文件报错），但出声。
#[cfg(test)]
fn decode_for_search(bytes: &[u8]) -> Cow<'_, str> {
    match decode_policy().and_then(|p| decode_with_policy(bytes, p)) {
        Ok(text) => text,
        Err(e) => {
            // 表坏 = 宿主与表脱节：出声，并按同一份"UTF-8 严格 → 三族裁决"降级，
            // 绝不悄悄换一套 BOM 判据（那正是"结果与正文对不上"的成因）
            eprintln!("[search] 内嵌解码策略表不可用，按 UTF-8/三族同一判序降级：{e}");
            match std::str::from_utf8(bytes) {
                Ok(s) => Cow::Borrowed(s),
                Err(_) => decode_legacy_family(bytes),
            }
        }
    }
}

/// 一份文本 → 命中（受 `cap` 限制），**逐行**匹配的正则口径：
/// grep 语义（`^`/`$` 落在行首行尾、跨行模式不参与），与"点开能看到行号"的呈现一致。
/// 返回 (命中, 是否因上限截断)。
///
/// 截断判定 = **真的又出现了一个装不下的命中**（不是"恰好装满就算截断"）：
/// 恰好装满时结果其实是完整的，报截断会让作者去调上限，白折腾。
fn scan_text(text: &str, matcher: &SearchMatcher, cap: usize) -> (Vec<SearchMatchDto>, bool) {
    let cap = cap.max(1);
    let mut out: Vec<SearchMatchDto> = Vec::new();
    for (idx, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let mut units: Option<Vec<u16>> = None;
        for m in matcher.find_iter(line) {
            if out.len() >= cap {
                return (out, true);
            }
            let u = units.get_or_insert_with(|| utf16_units(line));
            let start = utf16_len(&line[..m.start()]);
            let end = utf16_len(&line[..m.end()]);
            let (win, ws, we) = preview_window(u.as_slice(), start, end, SEARCH_PREVIEW_UNITS);
            out.push(SearchMatchDto {
                line: idx as u32 + 1,
                column: start as u32 + 1,
                preview: String::from_utf16_lossy(win.as_ref()),
                start: ws,
                end: we,
            });
        }
    }
    (out, false)
}

/// **字面量单趟快道**（PS-1 §3）：整个文本只建**一次** `find_iter`，
/// 行号 / UTF-16 列靠增量计数；旧口径逐行建迭代器（真语料一轮 4.4M 次构造），
/// 且每个命中都从头重走一遍行前缀去算列。
///
/// **准入条件由调用方保证**：`is_regex == false` 且查询串内不含 `\n`/`\r`。
/// 满足时本函数与 [`scan_text`] **逐字同产出**（对拍钉在
/// `scan_text_flat_matches_line_by_line`）：
/// - 字面量 pattern 里没有 `^`/`$`，锚点语义无从改变（正则查询因此**不走**这条，
///   整篇扫会把 `^` 缩成"仅文件首"、把 CRLF 文件的 `$` 落到 `\r` 之后）；
/// - 不含换行的字面量不可能跨行命中；全词判据（相邻一格是不是标识字符）在行边界
///   两侧同判——`\n`/`\r` 都不是标识字符，与"行首/行尾 = 没有相邻字符"一致。
fn scan_text_flat(text: &str, matcher: &SearchMatcher, cap: usize) -> (Vec<SearchMatchDto>, bool) {
    let cap = cap.max(1);
    let mut out: Vec<SearchMatchDto> = Vec::new();
    // 行游标：当前行的字节范围是 line_start..line_end（line_end 指向 '\n' 或文本尾）
    let mut line_no: u32 = 1;
    let mut line_start = 0usize;
    let mut line_end = text.find('\n').unwrap_or(text.len());
    // 列游标：col_units = line_start..col_pos 的 UTF-16 单元数（只往前走，不回扫行前缀）
    let mut col_pos = 0usize;
    let mut col_units = 0usize;
    // 预览开窗要整行的 UTF-16 单元：同一行的多个命中共用一份
    let mut units_of_line_start = usize::MAX;
    let mut units: Vec<u16> = Vec::new();

    for m in matcher.find_iter(text) {
        let (ms, me) = (m.start(), m.end());
        if ms >= line_end {
            // 命中落在后面的行里 ⇒ 一行一行推进（每行一次 memchr，总代价 = 扫过文本一次）
            let mut p = line_end + 1;
            loop {
                line_no += 1;
                let next = text[p..].find('\n').map(|k| p + k).unwrap_or(text.len());
                line_start = p;
                line_end = next;
                if ms < line_end || line_end >= text.len() {
                    break;
                }
                p = line_end + 1;
            }
            col_pos = line_start;
            col_units = 0;
        }
        if ms > col_pos {
            col_units += utf16_len(&text[col_pos..ms]);
            col_pos = ms;
        }
        if out.len() >= cap {
            return (out, true);
        }
        let raw = &text[line_start..line_end];
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let start = col_units;
        let end = col_units + utf16_len(&text[ms..me]);
        if units_of_line_start != line_start {
            units = utf16_units(line);
            units_of_line_start = line_start;
        }
        let (win, ws, we) = preview_window(&units, start, end, SEARCH_PREVIEW_UNITS);
        out.push(SearchMatchDto {
            line: line_no,
            column: start as u32 + 1,
            preview: String::from_utf16_lossy(win.as_ref()),
            start: ws,
            end: we,
        });
        debug_assert!(me <= line_end, "字面量命中不该跨过换行");
    }
    (out, false)
}

/// 两条扫描路径的分流点（口径见 [`scan_text_flat`] 的准入条件）。
fn scan_hits(
    text: &str,
    matcher: &SearchMatcher,
    cap: usize,
    literal_single_pass: bool,
) -> (Vec<SearchMatchDto>, bool) {
    if literal_single_pass {
        scan_text_flat(text, matcher, cap)
    } else {
        scan_text(text, matcher, cap)
    }
}

enum FileOutcome {
    Hits(Vec<SearchMatchDto>, bool),
    Miss,
    Binary,
    TooLarge,
    Unreadable,
}

/// 检索单个文件。
///
/// `size_hint` = **遍历时顺路拿到的字节数**（PS-1 §4）：`collect_files` 已经在 walkdir
/// 的枚举结果上取过一次元数据，旧口径这里再 `fs::metadata` 一遍 ⇒ 12,657 个候选文件
/// 白多 12,657 趟元数据往返。取不到（遍历失败 / 跨平台差异）⇒ 退回逐文件 stat，
/// 判定与计数分档（超大 / 读失败）逐字不变。
fn scan_file(
    path: &Path,
    size_hint: Option<u64>,
    matcher: &SearchMatcher,
    prefilter: Option<&BytePrefilter>,
    cap: usize,
    policy: &DecodeProbePolicyDto,
    literal_single_pass: bool,
) -> FileOutcome {
    let len = match size_hint {
        Some(n) => n,
        None => match std::fs::metadata(path) {
            Ok(m) => m.len(),
            Err(_) => return FileOutcome::Unreadable,
        },
    };
    if len > SEARCH_MAX_FILE_BYTES {
        return FileOutcome::TooLarge;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return FileOutcome::Unreadable,
    };
    // 二进制判定放在预筛**之前**：`skipped.binary` 得是"这批候选里的二进制文件数"，
    // 与查询词无关；反过来（先预筛）会让这个数字随查询漂——同一个目录换个词，
    // 界面上的"跳过 N 个二进制文件"就变，那种读数没法信。
    let utf16ish = is_utf16_bom_hit(&bytes, policy);
    if looks_binary(&bytes, utf16ish) {
        return FileOutcome::Binary;
    }
    // 字节级预筛：不命中的文件整个跳过解码。成立条件两条（口径见 `byte_prefilter`）：
    // 无可折字符的 ASCII 字面量对所有 ASCII 兼容族成立，或**这份字节本身就是合法 UTF-8**
    // （解码不改字节 ⇒ 字面量命中必然以同一串字节出现；折叠后的两种宽度形态都已编进
    // 预筛正则）。utf-16 的字节被 0 隔开，预筛对它不成立。
    if !utf16ish {
        if let Some(pre) = prefilter {
            let applies = pre.ascii_safe || std::str::from_utf8(&bytes).is_ok();
            if applies && !pre.re.is_match(&bytes) {
                return FileOutcome::Miss;
            }
        }
    }
    let text = match decode_with_policy(&bytes, policy) {
        Ok(t) => t,
        Err(e) => {
            // 表已在 run_search 入口整体校验过，走到这里 = 解释器与表脱节：可见、可数，不静默
            eprintln!("[search] 解码失败（计入 skipped.unreadable）：{}：{e}", path.display());
            return FileOutcome::Unreadable;
        }
    };
    let (hits, clipped) = scan_hits(&text, matcher, cap, literal_single_pass);
    if hits.is_empty() {
        FileOutcome::Miss
    } else {
        FileOutcome::Hits(hits, clipped)
    }
}

/// 隐藏项（`.git` / 编辑器临时文件）整棵跳过：与 ripgrep 缺省一致，也顺手绕开
/// 版本库元数据这种"搜了全是噪声"的目录。
fn is_hidden_entry(e: &walkdir::DirEntry) -> bool {
    e.file_name()
        .to_str()
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

/* ------------------------------ glob 文件过滤（P2-15） ------------------------------ */
//
// 扩展名过滤管"第几段后缀"，作者按位置问的形态（`src` 下的 erb、任意深度的
// `*.kojo`、`**/x/*.erb`）写不成扩展名——于是有这一个 glob 框。**不引 glob crate**：
// 通配符只有四个，翻成 regex 现成的（本检索本来就链在 regex 上），为四个字符
// 引一个依赖树不值。
//
// 翻译规则（与前端 `packages/app/tests/search-glob.test.ts` 的 TS 镜像逐字对拍）：
//   `*` → `[^/]*`（不跨目录）、`?` → `[^/]`（不跨目录）、其余字符一律
//   `regex::escape`（`. + ( )` 等元字符是字面）；整串 `^…$` 全匹配。
//   **分隔符先按 `/` 归一**（Windows 反斜杠换成 `/`）——glob 写法是按仓库相对
//   位置想的，分隔符不该有两种。
//
// `**`（跨目录）按规则表译成 `.*`；另有一条**工程修正**：`**/` 这一序列整体译成
// `(.*/)?`（要么带前缀路径、要么直档就在该目录下）。理由：不修正的话
// `src/**/*.erb` 翻成 `^src/.*/[^/]*\.erb$`，**匹配不到 `src/a.erb` 这类直档
// 子文件**——而作者写 `**/` 时期望的正是"任意层（含 0 层）"。裸 `**`（后面不是
// `/`）仍按 `.*`（跨目录、含分隔符）。
//
// 匹配基准 = **相对检索根的路径**（不是全路径）：glob 是按仓库相对位置写的
// （`src/**/*.erb` 指的是"仓库里的 src"），拿全路径去匹配只会让 `**` 前缀的
// 写法永远对不上盘符。多个根各自相对自己的根。

/// glob → regex 源码（**纯函数**；通配符之外的字符全转义 ⇒ 产出必然合法，
/// `Regex::new` 不会失败——真失败了也由调用方 eprintln 出声，不静默放过）。
fn glob_to_regex(glob: &str) -> String {
    let norm = glob.replace('\\', "/");
    let chars: Vec<char> = norm.chars().collect();
    let mut out = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                if i + 2 < chars.len() && chars[i + 2] == '/' {
                    out.push_str("(.*/)?"); // `**/`：任意层（含 0 层）——见上面的工程修正
                    i += 3;
                } else {
                    out.push_str(".*"); // 裸 `**`：跨目录
                    i += 2;
                }
            }
            '*' => {
                out.push_str("[^/]*"); // `*` 不跨目录
                i += 1;
            }
            '?' => {
                out.push_str("[^/]"); // `?` 不跨目录
                i += 1;
            }
            c => {
                out.push_str(&regex::escape(&c.to_string()));
                i += 1;
            }
        }
    }
    out.push('$');
    out
}

/// glob 清单 → 编译好的正则（空串 / 全空白项丢弃；编译失败不可能发生，
/// 万一发生也 eprintln 出声并忽略那一条，绝不静默放过）。
fn compile_globs(globs: &[String]) -> Vec<regex::Regex> {
    globs
        .iter()
        .map(|g| g.trim())
        .filter(|g| !g.is_empty())
        .filter_map(|g| match regex::Regex::new(&glob_to_regex(g)) {
            Ok(re) => Some(re),
            Err(err) => {
                eprintln!("[search] glob 编译失败（该条已忽略）：{g} -> {err}");
                None
            }
        })
        .collect()
}

/// 相对路径形态（分隔符归一成 `/`）：`strip_prefix` 失败（符号链接等让条目
/// 逃出根外）时回落全路径——**宁可多匹配也不漏匹配**，且全路径同样按 `/` 归一。
fn relative_slash_path(root: &std::path::Path, path: &std::path::Path) -> String {
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    rel.trim_start_matches('/').to_string()
}

/// 收集候选文件（去重 + 路径升序 ⇒ 并行合并后输出顺序与线程数无关）。
///
/// 排序口径**逐字不变**（小写整路径的升序、稳定序、按同键去重），但**每条路径只算一次
/// 小写键**（PS-1 §3）：旧实现把 `to_string_lossy().to_lowercase()` 写在比较器里，
/// 12,657 条路径的排序要 ~35 万次 String 分配（比较器被调 O(N log N) 次，每趟两次）。
///
/// 遍历失败**计数 + 出声**（前若干条打 stderr，其余只计数）：walkdir 逐个条目返回 Result，
/// 一个读不到 metadata 的条目（超长路径 / 权限 / 句柄）若被 filter 掉就再无声息——
/// 那正是"搜不到某个文件却没有任何说法"的形状。计数汇入 `skipped.unreadable`。
///
/// `globs`（P2-15）：路径形态过滤，与扩展名是**且**的关系（两者都满足才扫；
/// 空 = 不按形态过滤 = 今天行为逐字不变）。被任一方挡下的文件都计入 `filtered`
/// （界面上与"被类型过滤挡下"同一行读数——glob 也是类型过滤的一种形态，不静默）。
fn collect_files(
    roots: &[String],
    extensions: &[String],
    globs: &[String],
    filtered: &mut u32,
    walk_errors: &mut u32,
) -> Vec<SearchFile> {
    let glob_res = compile_globs(globs);
    let mut out: Vec<(String, PathBuf, Option<u64>)> = Vec::new();
    let mut reported = 0usize;
    for root in roots {
        let root_path = std::path::Path::new(root);
        let walker = walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !is_hidden_entry(e));
        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(err) => {
                    *walk_errors += 1;
                    if reported < 5 {
                        reported += 1;
                        eprintln!("[search] 遍历条目失败（已计入 skipped.unreadable）：{err}");
                    }
                    continue;
                }
            };
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if !extensions.is_empty() {
                let ext = p
                    .extension()
                    .map(|e| e.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_default();
                if !extensions.iter().any(|x| *x == ext) {
                    *filtered += 1;
                    continue;
                }
            }
            if !glob_res.is_empty() {
                let rel = relative_slash_path(root_path, p);
                if !glob_res.iter().any(|re| re.is_match(&rel)) {
                    *filtered += 1;
                    continue;
                }
            }
            let path = p.to_path_buf();
            // 顺路把体积带走：Windows 上这是枚举结果里的现成信息，不再额外系统调用
            // （`walk_dir(withMetadata)` 同一条前提）。取不到 ⇒ None ⇒ 扫描时退回 stat。
            let size = entry.metadata().ok().filter(|m| m.is_file()).map(|m| m.len());
            let key = path.to_string_lossy().to_lowercase();
            out.push((key, path, size));
        }
    }
    // 稳定排序 ⇒ 同键（同一个目录的两种写法）保持遍历先后，与旧实现同形
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.dedup_by(|a, b| a.0 == b.0);
    out.into_iter()
        .map(|(_, path, size)| SearchFile { path, size })
        .collect()
}

/// 检索候选文件：路径 + **遍历顺路拿到的体积**（`None` = 没拿到，扫描时补一次 stat）。
/// 带着体积走是为了让 `scan_file` 省掉"每个候选文件再 metadata 一遍"（PS-1 §4）。
struct SearchFile {
    path: PathBuf,
    size: Option<u64>,
}

#[derive(Default)]
struct SkipCounters {
    binary: AtomicU32,
    too_large: AtomicU32,
    unreadable: AtomicU32,
}

impl SkipCounters {
    fn to_dto(&self, filtered: u32, walk_errors: u32) -> SearchSkippedDto {
        SearchSkippedDto {
            binary: self.binary.load(Ordering::Relaxed),
            too_large: self.too_large.load(Ordering::Relaxed),
            unreadable: self.unreadable.load(Ordering::Relaxed) + walk_errors,
            filtered,
        }
    }
}

fn is_cancelled(cancel: &Mutex<HashSet<u64>>, id: u64) -> bool {
    cancel.lock().map(|g| g.contains(&id)).unwrap_or(false)
}

/// 检索主体的**只收进度**入口：生产路径走 `run_search_with_files`（命中文件随扫随到），
/// 这个三参包装为既有单测保留（它们逐字调用 `run_search(&emit, &cancel, req)`，
/// 一个都不用改）——故只在 test 构建里存在。
#[cfg(test)]
fn run_search(
    emit: &(dyn Fn(SearchProgressPayload) + Sync),
    cancel: &Mutex<HashSet<u64>>,
    req: &SearchRequestDto,
) -> Result<SearchResultDto, String> {
    run_search_with_files(emit, &|_batch| {}, cancel, req)
}

/// 检索主体（P2-11 流式版）：进度与命中文件**共用同一处节流点**。
///
/// `emit` / `emit_files` 注入而非直接用 `AppHandle`：单测要能在没有 Tauri 运行时的
/// 情况下跑真语料（回调对判据无影响，凭这一层把"并行检索"整段变成可测代码）。
///
/// 每个工作线程把命中文件攒在本地 `local` 里，节流点一到就整批 drain 出去：
/// 一份 emit 给壳层（`kojo:search-files`，随扫随到），一份留进 `emitted` accumulator
/// ——完成态必须是**已 emit 批次 ∪ 残留批次**（见 `SearchFilesPayload` 的对齐契约），
/// 所以 drain 出去的文件在收口处原样回到最终结果里，一条不丢、一条不多。
/// 末批（`done: true`）在 scope 结束后补：没赶上节流点的残留文件 + 终态标志。
fn run_search_with_files(
    emit: &(dyn Fn(SearchProgressPayload) + Sync),
    emit_files: &(dyn for<'a, 'b> Fn(&'a SearchFilesPayload<'b>) + Sync),
    cancel: &Mutex<HashSet<u64>>,
    req: &SearchRequestDto,
) -> Result<SearchResultDto, String> {
    let started = std::time::Instant::now();
    if req.query.is_empty() {
        return Err("检索词为空".to_string());
    }
    // 解码判据 = 编译期内嵌的共享常量表（W12 ENC-SRC）；坏表在这里就显式报错终止检索，
    // 绝不静默换一套判据（那正是"搜索结果与编辑器正文对不上"的成因）。
    let policy = decode_policy()?;
    let o = &req.options;
    let is_regex = o.is_regex.unwrap_or(false);
    let case_sensitive = o.case_sensitive.unwrap_or(false);
    let whole_word = o.whole_word.unwrap_or(false);
    let matcher = build_matcher(&req.query, is_regex, case_sensitive, whole_word)?;
    let prefilter = byte_prefilter(&req.query, is_regex, case_sensitive, whole_word);
    // 字面量单趟快道的准入（口径与"为什么等价"见 `scan_text_flat`）：正则查询一律走逐行原口径
    let literal_single_pass = !is_regex && !req.query.contains(['\n', '\r']);
    let max_results = o.max_results.unwrap_or(2000).clamp(1, SEARCH_HARD_CAP);
    let threads = o
        .threads
        .unwrap_or(SEARCH_DEFAULT_THREADS)
        .clamp(1, 32);
    let extensions: Vec<String> = o
        .extensions
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect();

    let mut filtered: u32 = 0;
    let mut walk_errors: u32 = 0;
    // P2-15：globs 必须从 DTO 流进 collect_files（glob 翻译在 collect_files 段内做），
    // 这是本批触及 run_search 的**唯一一行**——只加实参，逻辑一行未动
    let files = collect_files(
        &req.roots,
        &extensions,
        o.globs.as_deref().unwrap_or(&[]),
        &mut filtered,
        &mut walk_errors,
    );
    let total_files = files.len() as u32;

    let next = AtomicUsize::new(0);
    let scanned = AtomicUsize::new(0);
    let hits_total = AtomicU64::new(0);
    let overflow = AtomicBool::new(false);
    let cancelled = AtomicBool::new(false);
    let counters = SkipCounters::default();
    let last_emit = Mutex::new(std::time::Instant::now());
    // 已 emit 批次的累积（收口时与残留批次合并成完成态 ⇒ 事件流与返回值逐条对得上）
    let emitted: Mutex<Vec<SearchFileDto>> = Mutex::new(Vec::new());

    let batches: Vec<Vec<SearchFileDto>> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..threads {
            handles.push(scope.spawn(|| {
                let mut local: Vec<SearchFileDto> = Vec::new();
                loop {
                    if is_cancelled(cancel, req.search_id) {
                        cancelled.store(true, Ordering::Relaxed);
                        break;
                    }
                    if overflow.load(Ordering::Relaxed) {
                        break;
                    }
                    let i = next.fetch_add(1, Ordering::SeqCst);
                    if i >= files.len() {
                        break;
                    }
                    let remaining = max_results
                        .saturating_sub(hits_total.load(Ordering::Relaxed) as usize);
                    if remaining == 0 {
                        overflow.store(true, Ordering::Relaxed);
                        break;
                    }
                    let cap = SEARCH_PER_FILE_CAP.min(remaining);
                    match scan_file(
                        &files[i].path,
                        files[i].size,
                        &matcher,
                        prefilter.as_ref(),
                        cap,
                        policy,
                        literal_single_pass,
                    ) {
                        FileOutcome::Hits(hits, clipped) => {
                            if clipped {
                                overflow.store(true, Ordering::Relaxed);
                            }
                            hits_total.fetch_add(hits.len() as u64, Ordering::Relaxed);
                            local.push(SearchFileDto {
                                path: files[i].path.to_string_lossy().into_owned(),
                                matches: hits,
                            });
                        }
                        FileOutcome::Binary => {
                            counters.binary.fetch_add(1, Ordering::Relaxed);
                        }
                        FileOutcome::TooLarge => {
                            counters.too_large.fetch_add(1, Ordering::Relaxed);
                        }
                        FileOutcome::Unreadable => {
                            counters.unreadable.fetch_add(1, Ordering::Relaxed);
                        }
                        FileOutcome::Miss => {}
                    }
                    let done = scanned.fetch_add(1, Ordering::SeqCst) + 1;
                    let due = done % SEARCH_PROGRESS_FILES == 0
                        || last_emit
                            .lock()
                            .map(|g| g.elapsed().as_millis() >= SEARCH_PROGRESS_MS)
                            .unwrap_or(false);
                    if due {
                        if let Ok(mut g) = last_emit.lock() {
                            *g = std::time::Instant::now();
                        }
                        emit(SearchProgressPayload {
                            search_id: req.search_id,
                            files_scanned: done as u32,
                            total_files,
                            match_count: hits_total.load(Ordering::Relaxed),
                        });
                        // 流式批次：与进度同一节流点，把攒到的命中文件整批送出
                        // （不是每个文件都 emit——口径与进度事件一致，别把 IPC 打爆）。
                        if !local.is_empty() {
                            let batch = std::mem::take(&mut local);
                            emit_files(&SearchFilesPayload {
                                search_id: req.search_id,
                                files: &batch,
                                done: false,
                                // 中途批次的终态标志只是当时所知，壳层不作准（以完成态为准）
                                truncated: overflow.load(Ordering::Relaxed),
                                cancelled: cancelled.load(Ordering::Relaxed),
                            });
                            // emit 完再收进 accumulator（移动，不拷贝）：完成态必须是
                            // 已 emit 批次 ∪ 残留批次，一条不丢
                            if let Ok(mut g) = emitted.lock() {
                                g.extend(batch);
                            }
                        }
                    }
                }
                local
            }));
        }
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });

    // 收口：没赶上节流点的残留文件作为最后一批送出（done = true，终态标志此时才作准），
    // 再与已 emit 的批次合并成完成态 ⇒ 最终结果 = 累积 ∪ 残留，与事件流逐条对得上。
    let leftover: Vec<SearchFileDto> = batches.into_iter().flatten().collect();
    emit_files(&SearchFilesPayload {
        search_id: req.search_id,
        files: &leftover,
        done: true,
        truncated: overflow.load(Ordering::Relaxed),
        cancelled: cancelled.load(Ordering::Relaxed),
    });
    // 锁中毒（线程在持锁时 panic）也要把已 emit 的批次收回来：丢了它们，
    // 完成态就会比事件流少文件——那正是"事件说三条、最终态说两条"的裂缝。
    let mut out_files: Vec<SearchFileDto> = emitted
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    out_files.extend(leftover);
    out_files.sort_by(|a, b| a.path.cmp(&b.path));
    let total_matches: u64 = out_files.iter().map(|f| f.matches.len() as u64).sum();
    if let Ok(mut g) = cancel.lock() {
        g.remove(&req.search_id); // 本次取消标记用完即清，不留给下一次
    }
    Ok(SearchResultDto {
        files: out_files,
        total_matches,
        truncated: overflow.load(Ordering::Relaxed),
        cancelled: cancelled.load(Ordering::Relaxed),
        files_scanned: scanned.load(Ordering::SeqCst) as u32,
        skipped: counters.to_dto(filtered, walk_errors),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 全文检索：多线程读盘 + 行内匹配，逐文件上报进度，命中行才过 IPC。
/// 结果上限（`maxResults` / 单文件上限）与取消都会在返回值里显式说明（不静默截断）。
/// P2-11 起命中文件随扫随到（`kojo:search-files`，与进度同一节流点）；完成态仍由本命令
/// 的返回值收口，事件只做增量累积。
#[tauri::command]
async fn search_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, SearchState>,
    request: SearchRequestDto,
) -> Result<SearchResultDto, String> {
    use tauri::Emitter;
    let cancel = state.cancelled.clone();
    // 命令本体跑在阻塞线程池上：这是纯 CPU + 磁盘的活，不许占住异步运行时的执行线程
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |p: SearchProgressPayload| {
            let _ = app.emit(SEARCH_PROGRESS_EVENT, p);
        };
        let emit_files = |batch: &SearchFilesPayload<'_>| {
            let _ = app.emit(SEARCH_FILES_EVENT, batch.clone());
        };
        run_search_with_files(&emit, &emit_files, &cancel, &request)
    })
    .await
    .map_err(|e| format!("检索线程失败：{e}"))?
}

/// 请求取消某条检索（按 `searchId`）。检索线程逐文件检查，命中即提前收尾并如实回报。
#[tauri::command]
fn cancel_search(state: tauri::State<'_, SearchState>, search_id: u64) -> Result<(), String> {
    let mut guard = state
        .cancelled
        .lock()
        .map_err(|_| "search state poisoned".to_string())?;
    guard.insert(search_id);
    Ok(())
}

/* ------------------------------- 入口 ------------------------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例锁（P0-4）必须**第一个**注册（官方口径：抢在其它插件初始化之前判重）。
        // 第二实例起即发现已有实例 → 经命名管道通知主进程执行本回调（把主窗口带到
        // 前台）→ 第二进程立即退出，不弹 Web UI 对话框。
        // 取舍：官方插件第二实例以 exit(0) 退出（exit code 非零未满足字面），换取
        // 官方维护的跨进程通知细节——行为口径「直接退出 + 聚焦已有窗口」逐条达成。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(WriteDomainState::default())
        .manage(WatchState::default())
        .manage(SearchState::default())
        .on_window_event(|window, event| {
            use tauri::Emitter;
            use tauri::Manager;
            if let tauri::WindowEvent::DragDrop(ev) = event {
                // OS 拖放 = 用户显式动作、路径由宿主（而非 JS）交付 ⇒ 与目录对话框同信任级。
                // 把 drop 到的**本地目录**登记进准入根清单，让"拖入开项目"仍能注册写允许域；
                // UNC（网络路径）与非目录一律不登记（既防凭据外泄，也不给文件路径升格成根）。
                if let tauri::DragDropEvent::Drop { paths, .. } = ev {
                    let state = window.state::<WriteDomainState>();
                    if let Ok(app_dir) = window.path().app_data_dir() {
                        for p in paths {
                            if p.to_string_lossy().starts_with(r"\\") {
                                continue;
                            }
                            if !p.is_dir() {
                                continue;
                            }
                            let _ = record_approved_root(&state, &app_dir, p);
                        }
                    }
                }
                if let Some(payload) = map_drag_drop(ev.clone()) {
                    let _ = window.emit(DRAG_DROP_EVENT, payload);
                }
            }
        })
        .setup(|app| {
            use tauri::Manager;
            // 崩溃取证最先装（P0-3）：后续 setup 代码 panic 也在抓取面内。
            // 失败不阻断启动（取证设施自己是最后顺位），内部已出声。
            if let Ok(app_dir) = app.path().app_data_dir() {
                diagnostics::setup_diagnostics(&app_dir);
            } else {
                eprintln!("[setup] 无 app_data_dir，崩溃取证未装配");
            }
            // 常驻授权根 + 准入根清单读回（自选项目位置的持久化半边 + 开项目准入门的持久化半边）。
            // 文件不存在 = 首次运行，正常态；读失败已在各自函数里出声。
            let handle = app.handle().clone();
            let Ok(app_dir) = handle.path().app_data_dir() else {
                eprintln!("[setup] 无 app_data_dir，常驻授权根与准入根保持为空");
                return Ok(());
            };
            let state = handle.state::<WriteDomainState>();
            let persisted = read_workspace_roots(&app_dir);
            if !persisted.is_empty() {
                let mut guard = state
                    .extra_roots
                    .lock()
                    .map_err(|_| "write domain state poisoned".to_string())?;
                for root in persisted {
                    push_extra_root(&mut guard, &root);
                }
                eprintln!("[setup] 常驻授权根读回 {} 个", guard.len());
            }
            let approved = read_approved_roots(&app_dir);
            if !approved.is_empty() {
                let mut guard = state
                    .approved_roots
                    .lock()
                    .map_err(|_| "write domain state poisoned".to_string())?;
                for root in approved {
                    push_approved_root(&mut guard, &root);
                }
                eprintln!("[setup] 准入根读回 {} 个", guard.len());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file_bytes,
            read_file_bytes_raw,
            write_file_bytes,
            ensure_dir,
            list_dir,
            walk_dir,
            path_exists,
            stat_file,
            read_files_raw,
            stat_files,
            rename_path,
            copy_file,
            remove_file,
            remove_dir,
            choose_directory,
            choose_file,
            choose_workspace_root,
            workspace_roots,
            export_file,
            app_data_dir,
            register_write_domain,
            clear_write_domain,
            encode_string,
            start_watch,
            stop_watch,
            search_text,
            cancel_search,
            market::market_download,
            market::market_fetch_text,
            market::market_extract,
            market::market_publish,
            market::market_device_token,
            shell::show_in_folder,
            shell::open_url_external,
            diagnostics::append_frontend_log,
            updater_proxy::updater_env_proxy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ------------------------------- 单测（M3） ------------------------------- */

/// 全文检索的判据独立成文件（`src/search_tests.rs`）：一整套编码 / 切行 / 并行的用例
/// 塞进本文件会把 IO 原语的正文淹掉。
#[cfg(test)]
mod search_tests;

/// 市场 IO 原语的判据（白名单逐跳 / 暂存名字面 / 解压闸 / 真实容器对平）同理由独立成文件。
#[cfg(test)]
mod market_tests;

/// OS 外壳原语的判据（路径 → 各平台命令 argv 的纯构造）独立成文件。
#[cfg(test)]
mod shell_tests;

/// 崩溃取证的判据（panic 落盘 / 截断 / 轮转 / 时间戳锚点）独立成文件。
#[cfg(test)]
mod diagnostics_tests;

#[cfg(test)]
mod write_domain_tests {
    use super::{
        canonical_root_cached, canonical_root_cached_short, canonicalize_deep,
        clear_domain_core, commit_project_root, domain_change_snapshot, ensure_in_domain_with,
        ensure_in_write_domain, ensure_write_allowed_from_parts,
        invalidate_canon_roots, is_reserved_state_file, is_root_approved, is_same_path, is_within,
        memo_insert_canon_if_current,
        merge_workspace_roots, push_approved_root, push_extra_root, read_approved_roots,
        read_workspace_roots, write_approved_roots, write_workspace_roots, WriteDomainState,
    };
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kojo-m3-{}-{}-{tag}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mkdir(p: &Path) -> PathBuf {
        std::fs::create_dir_all(p).unwrap();
        p.to_path_buf()
    }

    #[test]
    fn inside_project_root_allowed() {
        let root = temp_root("in");
        let sub = mkdir(&root.join("scenario").join("ERB"));
        // 深层不存在文件（原子写待建目标）也应在域内
        ensure_in_write_domain(
            Some(&root),
            &temp_root("appdata"),
            &[],
            &sub.join("new.erb"),
            "write",
        )
        .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_data_dir_always_allowed() {
        let appdata = temp_root("app");
        let project = temp_root("proj");
        ensure_in_write_domain(
            Some(&project),
            &appdata,
            &[],
            &appdata.join("backup").join("v1.dat"),
            "write",
        )
        .unwrap();
    }

    #[test]
    fn outside_domain_rejected() {
        let project = temp_root("proj");
        let other = temp_root("other");
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &other.join("evil.erb"),
            "write",
        )
        .unwrap_err();
        assert!(err.contains("可写范围拒绝"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&project);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn no_project_root_registered_rejects_everything_but_appdata() {
        let other = temp_root("other");
        let appdata = temp_root("appdata");
        // 未注册项目（None）：域外路径一律拒绝
        let err =
            ensure_in_write_domain(None, &appdata, &[], &other.join("x.erb"), "write").unwrap_err();
        assert!(err.contains("可写范围拒绝"), "unexpected: {err}");
        // appDataDir 仍可写（备份 / 配置）
        ensure_in_write_domain(None, &appdata, &[], &appdata.join("config.json"), "write").unwrap();
        let _ = std::fs::remove_dir_all(&other);
        let _ = std::fs::remove_dir_all(&appdata);
    }

    #[test]
    fn traversal_via_dotdot_rejected() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        let outside = mkdir(&base.join("outside"));
        // 字符串以项目根开头，但 .. 穿越到域外
        let sneaky = project.join("sub").join("..").join("..").join("outside").join("x.erb");
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &sneaky,
            "write",
        )
        .unwrap_err();
        assert!(err.contains("可写范围拒绝"), "unexpected: {err}");
        let _ = outside; // 保持存在
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn traversal_resolved_when_target_exists_rejected() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        let outside = mkdir(&base.join("outside"));
        std::fs::write(outside.join("secret.erb"), "x").unwrap();
        let sneaky = project.join("..").join("outside").join("secret.erb");
        assert!(ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &sneaky,
            "remove"
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn symlink_escaping_domain_rejected() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        let outside = mkdir(&base.join("outside"));
        let link = project.join("link");
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        let err = ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &link.join("evil.erb"),
            "write",
        )
        .unwrap_err();
        assert!(err.contains("可写范围拒绝"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prefix_is_component_wise_not_string_prefix() {
        let base = temp_root("base");
        let project = mkdir(&base.join("project"));
        // sibling 目录名是项目根的字符串前缀（projec vs project）
        let sibling = mkdir(&base.join("projec"));
        assert!(ensure_in_write_domain(
            Some(&project),
            &temp_root("appdata"),
            &[],
            &sibling.join("f.txt"),
            "write"
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn canonicalize_deep_keeps_missing_tail() {
        let base = temp_root("base");
        let root = mkdir(&base.join("root"));
        let target = root.join("a").join("b").join("new.txt");
        let canon = canonicalize_deep(&target).unwrap();
        assert!(is_within(&canon, &root.canonicalize().unwrap()));
        assert!(canon.ends_with("new.txt"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /* -------- 常驻授权根（自选项目位置，2026-10-14 批） -------- */

    /// 正向：未打开任何项目，但落点在用户经对话框自选并授权的根之下 ⇒ 放行
    #[test]
    fn extra_root_authorized_when_no_project_registered() {
        let appdata = temp_root("appdata");
        let chosen = mkdir(&temp_root("chosen"));
        let target = chosen.join("我的作品").join("包").join("事件.ERB");
        ensure_in_write_domain(None, &appdata, &[chosen], &target, "write").unwrap();
    }

    /// 负向：授权根之外的兄弟目录仍被拒——**判定域只宽不松**，
    /// 一次授权绝不变成"整个磁盘可写"
    #[test]
    fn outside_extra_root_still_rejected() {
        let appdata = temp_root("appdata");
        let base = temp_root("base");
        let chosen = mkdir(&base.join("chosen"));
        let sibling = mkdir(&base.join("sibling"));
        let err = ensure_in_write_domain(
            None,
            &appdata,
            &[chosen],
            &sibling.join("evil.erb"),
            "write",
        )
        .unwrap_err();
        assert!(err.contains("可写范围拒绝"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 授权根去重：同一个目录的两种写法（大小写 / 规范化前后）只登记一次
    #[test]
    fn push_extra_root_dedups_same_directory() {
        let chosen = mkdir(&temp_root("chosen"));
        let mut list: Vec<PathBuf> = Vec::new();
        assert!(push_extra_root(&mut list, &chosen));
        assert!(!push_extra_root(&mut list, &chosen.join(".")));
        assert_eq!(list.len(), 1);
        assert!(is_same_path(&chosen, &chosen.join(".")));
        let other = mkdir(&temp_root("other"));
        assert!(push_extra_root(&mut list, &other));
        assert_eq!(list.len(), 2);
    }

    /// 授权根持久化：写下去读得回（一行一路径），文件不存在 = 空列表不报错
    #[test]
    fn workspace_roots_file_roundtrip() {
        let appdata = temp_root("appdata");
        assert!(read_workspace_roots(&appdata).is_empty());
        let a = mkdir(&temp_root("a"));
        let b = mkdir(&temp_root("b"));
        write_workspace_roots(&appdata, &[a.clone(), b.clone()]).unwrap();
        let back = read_workspace_roots(&appdata);
        assert_eq!(back.len(), 2);
        assert!(is_same_path(&back[0], &a));
        assert!(is_same_path(&back[1], &b));
        // 整表重写 ⇒ 重复项不会越写越多
        write_workspace_roots(&appdata, &[a.clone()]).unwrap();
        assert_eq!(read_workspace_roots(&appdata).len(), 1);
    }

    /// `workspace_roots` 的纯核心（async 壳只负责把盘上活挪走）：内存在前、磁盘在后，
    /// 同一目录两种写法只留一条，盘上已不存在的根剔除（顺序 = 授权顺序）。
    #[test]
    fn merge_workspace_roots_keeps_order_dedups_and_drops_missing() {
        let appdata = temp_root("merge");
        let a = mkdir(&temp_root("a"));
        let b = mkdir(&temp_root("b"));
        let c = mkdir(&temp_root("c"));
        let missing = temp_root("missing").join("gone");
        // 磁盘清单里有 b / a / 一个已删除的根；内存里有 a（重复）与 c
        write_workspace_roots(&appdata, &[b.clone(), a.clone(), missing]).unwrap();
        let out = merge_workspace_roots(&appdata, vec![a.clone(), c.clone()]);
        assert_eq!(out.len(), 3, "重复项应合并、缺失项应剔除：{out:?}");
        assert!(is_same_path(Path::new(&out[0]), &a), "内存快照在前：{out:?}");
        assert!(is_same_path(Path::new(&out[1]), &c));
        assert!(is_same_path(Path::new(&out[2]), &b), "磁盘清单按原序补后：{out:?}");
    }

    /* -------- 开项目准入门（register_write_domain 的纯判定半边，2026-10 安全审阅批） -------- */

    fn canon(p: &Path) -> PathBuf {
        canonicalize_deep(p).unwrap()
    }

    /// 准入门正向：对话框交付的目录本身、及其子目录（新建项目落自选根的一层下）都放行
    #[test]
    fn approved_root_admits_itself_and_subdirectories() {
        let appdata = temp_root("appdata");
        let picked = mkdir(&temp_root("picked"));
        let sub = mkdir(&picked.join("作品").join("包"));
        let approved = vec![canon(&picked)];
        assert!(is_root_approved(&appdata, &approved, &[], &canon(&picked)));
        assert!(is_root_approved(&appdata, &approved, &[], &canon(&sub)));
    }

    /// 准入门负向：一个 JS 凭空的任意路径（与准入根无包含关系的兄弟目录）被拒——
    /// 正是"给个路径就放行"漏洞的回归锚
    #[test]
    fn arbitrary_root_outside_approved_set_is_rejected() {
        let appdata = temp_root("appdata");
        let base = temp_root("base");
        let picked = mkdir(&base.join("picked"));
        let victim = mkdir(&base.join("victim"));
        let approved = vec![canon(&picked)];
        assert!(
            !is_root_approved(&appdata, &approved, &[], &canon(&victim)),
            "准入根之外的路径被放行（写允许域被 JS 任意放宽）"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// appDataDir 恒为准入（常驻允许域），无需先登记
    #[test]
    fn app_data_dir_is_always_approved() {
        let appdata = temp_root("appdata");
        let inside = mkdir(&appdata.join("store"));
        assert!(is_root_approved(&appdata, &[], &[], &canon(&inside)));
    }

    /// 常驻自选根（extra_roots）也是准入来源：新建项目落其子目录 ⇒ 放行
    #[test]
    fn extra_workspace_root_admits_new_project_subdir() {
        let appdata = temp_root("appdata");
        let chosen = mkdir(&temp_root("chosen"));
        let new_project = mkdir(&chosen.join("我的作品"));
        assert!(is_root_approved(&appdata, &[], &[canon(&chosen)], &canon(&new_project)));
    }

    /// 准入根去重：同一目录两种写法只留一条（与 push_extra_root 同口径）
    #[test]
    fn push_approved_root_dedups_same_directory() {
        let picked = mkdir(&temp_root("picked"));
        let mut list: Vec<PathBuf> = Vec::new();
        assert!(push_approved_root(&mut list, &picked));
        assert!(!push_approved_root(&mut list, &picked.join(".")));
        assert_eq!(list.len(), 1);
        let other = mkdir(&temp_root("other"));
        assert!(push_approved_root(&mut list, &other));
        assert_eq!(list.len(), 2);
    }

    /// 准入根持久化：写下去读得回；文件不存在 = 空列表不报错
    #[test]
    fn approved_roots_file_roundtrip() {
        let appdata = temp_root("appdata");
        assert!(read_approved_roots(&appdata).is_empty());
        let a = mkdir(&temp_root("a"));
        let b = mkdir(&temp_root("b"));
        write_approved_roots(&appdata, &[a.clone(), b.clone()]).unwrap();
        let back = read_approved_roots(&appdata);
        assert_eq!(back.len(), 2);
        assert!(is_same_path(&canon(&back[0]), &canon(&a)));
        assert!(is_same_path(&canon(&back[1]), &canon(&b)));
        write_approved_roots(&appdata, &[a.clone()]).unwrap();
        assert_eq!(read_approved_roots(&appdata).len(), 1);
    }

    /* -------- 允许域变更序号（REF-FRONT-PERF：register 异步化后的顺序找回） -------- */

    /// `register_write_domain` 的判定挪到阻塞线程池之后，"判定 → 落定"之间可能插进
    /// `clear_write_domain`（项目关闭）或另一次成功落定。快照复核必须让**后发生的变更恒胜**：
    /// 清除之后，任何在途注册都不许把已关闭的项目根复活（fail-closed + 可见报错）。
    /// 判定失败**不抬代际** ⇒ 不取消另一个在途的成功注册（它没改变允许域）。
    #[test]
    fn pending_registration_is_cancelled_by_clear_or_newer_registration() {
        let state = WriteDomainState::default();
        let a = PathBuf::from(r"C:\projects\a");
        let b = PathBuf::from(r"C:\projects\b");

        // 场景 1：判定期间项目被关闭 ⇒ 落定被拒，根保持空（不复活）
        let epoch = domain_change_snapshot(&state);
        clear_domain_core(&state).unwrap();
        let err = commit_project_root(&state, a.clone(), epoch).unwrap_err();
        assert!(err.contains("并发变更"), "拒因应说清并发变更：{err}");
        assert!(
            state.project_root.lock().unwrap().is_none(),
            "清除之后的在途注册不许落下"
        );

        // 场景 2：两个在途注册都通过判定，先落定者胜 ⇒ 后者快照过期作废
        let first = domain_change_snapshot(&state);
        let second = domain_change_snapshot(&state);
        commit_project_root(&state, b.clone(), second).unwrap();
        assert!(commit_project_root(&state, a, first).is_err(), "先落定之后的第二笔必须作废");
        assert_eq!(
            state.project_root.lock().unwrap().as_deref(),
            Some(b.as_path()),
            "先落定者胜，后落定者的快照已过期"
        );

        // 场景 3：正常路径（快照未被并发变更）照常落定
        clear_domain_core(&state).unwrap();
        let epoch = domain_change_snapshot(&state);
        commit_project_root(&state, b.clone(), epoch).unwrap();
        assert_eq!(state.project_root.lock().unwrap().as_deref(), Some(b.as_path()));

        // 场景 4：另一笔注册**判定失败**（只取快照、不落定）不得取消在途的成功注册
        clear_domain_core(&state).unwrap();
        let healthy = domain_change_snapshot(&state);
        let failed = domain_change_snapshot(&state);
        assert_eq!(healthy, failed, "判定失败不改变代际");
        commit_project_root(&state, b.clone(), healthy).unwrap();
        assert_eq!(
            state.project_root.lock().unwrap().as_deref(),
            Some(b.as_path()),
            "失败的那笔不应让成功的那笔吃并发变更错误"
        );
    }

    /* -------- 允许域根的规范化备忘录（PS-1 §8：安全闸的加速层） -------- */

    /// 备忘录与"每个根每次直算"的参照实现必须**逐字同判定**：
    /// 放行同放行、域外拒绝同拒绝、错误串同串（这一条是"只快不改"的全部承诺）。
    #[test]
    fn canon_root_memo_agrees_with_direct_resolution() {
        let base = temp_root("memo");
        let project = mkdir(&base.join("project"));
        let appdata = mkdir(&base.join("appdata"));
        let sibling = mkdir(&base.join("sibling"));
        let chosen = mkdir(&base.join("chosen"));
        let extras = vec![chosen.clone()];
        let targets = [
            project.join("包").join("事件.ERB"), // 项目根内（含新建待落盘的深层）
            appdata.join("store.json"),          // 常驻允许
            sibling.join("evil.erb"),            // 域外
            project.join("..").join("sibling").join("evil.erb"), // .. 穿越
            chosen.join("新项目").join("a.erb"),  // 自选常驻根的子目录
            base.join("nowhere").join("b.erb"),  // 整条不存在的深层
        ];
        let mut memo: HashMap<PathBuf, PathBuf> = HashMap::new();
        for t in &targets {
            let direct = ensure_in_write_domain(Some(&project), &appdata, &extras, t, "write");
            let cached = ensure_in_domain_with(
                Some(&project),
                &appdata,
                &extras,
                t,
                "write",
                |root| canonical_root_cached(&mut memo, root, "write"),
            );
            match (direct, cached) {
                (Ok(()), Ok(())) => {}
                (Err(a), Err(b)) => assert_eq!(a, b, "错误文案漂：{a} / {b}"),
                (a, b) => panic!("判定不同形：直算={a:?} 备忘录={b:?}（目标 {}）", t.display()),
            }
        }
        assert!(memo.len() >= 2, "跑了一整轮却没缓存住根：{memo:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 生产版备忘录（**短锁**：map 读写才持锁，`is_dir` / `canonicalize_deep` 都在锁外）
    /// 必须与参照版逐条同语义：命中须仍为目录、失败不缓存、重算结果与直算同值同文案。
    /// 这一条钉"锁外系统调用"没有把缓存判据改形。
    #[test]
    fn short_lock_memo_matches_the_reference_and_refuses_stale_entries() {
        let base = temp_root("shortmemo");
        let root = mkdir(&base.join("root"));
        let state = WriteDomainState::default();

        let first = canonical_root_cached_short(&state, &root, "write").unwrap();
        assert_eq!(first, canonicalize_deep(&root).unwrap(), "首次结果应与直算同值");
        assert_eq!(
            state.canon_roots.lock().unwrap().get(&root),
            Some(&first),
            "首次成功应写进缓存"
        );
        assert_eq!(
            canonical_root_cached_short(&state, &root, "write").unwrap(),
            first,
            "命中路径应返回同一份规范化结果"
        );

        // 原始写法不再是目录（删掉换成文件）⇒ 作废重算，且不再缓存
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::write(&root, "file now").unwrap();
        let again = canonical_root_cached_short(&state, &root, "write").unwrap();
        assert_eq!(again, canonicalize_deep(&root).unwrap());
        assert!(
            !state.canon_roots.lock().unwrap().contains_key(&root),
            "陈旧条目应被移除且不再缓存"
        );

        // 解析失败的根不进缓存，文案与参照版逐字相同
        let gone = PathBuf::from(r"Z:\kojo-no-such-drive\root");
        let direct = canonical_root_cached(&mut HashMap::new(), &gone, "write").unwrap_err();
        let cached = canonical_root_cached_short(&state, &gone, "write").unwrap_err();
        assert_eq!(cached, direct, "两条路的根解析失败文案必须逐字相同");
        assert!(!state.canon_roots.lock().unwrap().contains_key(&gone));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 缓存条目只在"该原始写法**此刻仍是一个目录**"时采信：把它删了 / 换成文件 ⇒ 作废重算。
    /// 陈旧规范化是这一层唯一的放宽风险（根被换指向别处），这一条把口子钉死。
    /// 另一半：解析**失败**的根不许进缓存（否则一次故障会永久改掉判定文案），
    /// 且两条路径的错误串逐字相同 —— "根解析失败"那支文案的钉子在这里。
    #[test]
    fn canon_root_memo_refuses_stale_and_failed_entries() {
        let base = temp_root("memostale");
        let root = mkdir(&base.join("root"));
        let appdata = mkdir(&base.join("appdata"));
        let target = mkdir(&base.join("elsewhere")).join("x.erb");
        let mut memo: HashMap<PathBuf, PathBuf> = HashMap::new();
        let first = canonical_root_cached(&mut memo, &root, "write");
        assert!(first.is_ok() && memo.contains_key(&root), "首次该算成并存下缓存");
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::write(&root, "i am a file now").unwrap();
        let again = canonical_root_cached(&mut memo, &root, "write");
        assert_eq!(
            again.as_ref().unwrap(),
            &canonicalize_deep(&root).unwrap(),
            "原始写法不再是目录 ⇒ 不许采信缓存里那份，重算结果必须与直算逐字相同"
        );

        // 指向一个连祖先都不存在的根（未挂载的盘）：失败不缓存，且与直算同形同文案
        let gone = PathBuf::from(r"Z:\kojo-no-such-drive\root");
        let mut memo2: HashMap<PathBuf, PathBuf> = HashMap::new();
        let direct = ensure_in_write_domain(None, &appdata, &[gone.clone()], &target, "write");
        let cached = ensure_in_domain_with(None, &appdata, &[gone.clone()], &target, "write", |r| {
            canonical_root_cached(&mut memo2, r, "write")
        });
        assert!(direct.is_err(), "夹具：这条根解析不动时判定必须失败");
        assert_eq!(
            cached.unwrap_err(),
            direct.unwrap_err(),
            "'根目录解析失败' 这一支两条路径文案不一致"
        );
        assert!(
            !memo2.contains_key(&gone),
            "解析失败的根不许进缓存：{memo2:?}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// REF-FRONT-PERF 复核补：短锁版在锁外算 canon，invalidate 可能发生在计算中途。
    /// 代际闸必须让"旧代际的结果"进不了表，否则清表之后会被在途线程写回陈旧根。
    #[test]
    fn canon_epoch_guard_refuses_stale_insert_and_invalidate_bumps() {
        let state = WriteDomainState::default();
        let root = PathBuf::from(r"C:\kojo-epoch-root");
        let canon = PathBuf::from(r"C:\kojo-epoch-root\canon");
        let stale_epoch = state.canon_epoch.load(Ordering::SeqCst);

        invalidate_canon_roots(&state);
        memo_insert_canon_if_current(&state, &root, &canon, stale_epoch);
        assert!(
            state.canon_roots.lock().unwrap().is_empty(),
            "变更前算出的根不许在清表后复活"
        );

        let fresh_epoch = state.canon_epoch.load(Ordering::SeqCst);
        memo_insert_canon_if_current(&state, &root, &canon, fresh_epoch);
        assert_eq!(
            state.canon_roots.lock().unwrap().get(&root),
            Some(&canon),
            "当代际的结果应正常落表"
        );
    }

    /// 授权清单（`approved_roots.txt` / `workspace_roots.txt`）是准入门的唯一凭据，
    /// 即使落在常驻允许域 appDataDir 内也必须命中；命名判据含大小写与 `..` 穿越。
    #[test]
    fn reserved_state_file_names_hit_only_inside_appdata() {
        let appdata = temp_root("reserved");
        let nested = mkdir(&appdata.join("a"));
        assert!(is_reserved_state_file(
            &appdata,
            &appdata.join("approved_roots.txt")
        ));
        assert!(
            is_reserved_state_file(&appdata, &appdata.join("WORKSPACE_ROOTS.TXT")),
            "Windows 大小写不敏感：大写写法也是同一份清单"
        );
        assert!(
            is_reserved_state_file(
                &appdata,
                &nested.join("..").join("approved_roots.txt")
            ),
            "`..` 落回 appDataDir 的写法不许绕过"
        );
        assert!(!is_reserved_state_file(
            &appdata,
            &appdata.join("other.txt")
        ));
        // 用户项目里恰好同名：不在 appDataDir 下，不许误伤
        let project = temp_root("reserved-proj");
        assert!(!is_reserved_state_file(
            &appdata,
            &project.join("approved_roots.txt")
        ));
        let _ = std::fs::remove_dir_all(&appdata);
        let _ = std::fs::remove_dir_all(&project);
    }

    /// 行为级：命令侧判定壳必须拒保留名（含改名 / 拷贝 / 删除），普通名照常放行。
    #[test]
    fn reserved_state_file_blocked_by_command_gate() {
        let appdata = temp_root("reservedgate");
        let state = WriteDomainState::default();
        for op in ["write", "rename", "copy", "remove"] {
            let err = ensure_write_allowed_from_parts(
                &appdata,
                &state,
                &appdata.join("approved_roots.txt"),
                op,
            )
            .unwrap_err();
            assert!(err.contains("宿主授权清单"), "{op} unexpected: {err}");
        }
        assert!(ensure_write_allowed_from_parts(
            &appdata,
            &state,
            &appdata.join("Workspace_Roots.txt"),
            "write"
        )
        .is_err());
        // appDataDir 仍是允许域：普通文件名不受影响
        ensure_write_allowed_from_parts(&appdata, &state, &appdata.join("other.txt"), "write")
            .unwrap();
        let _ = std::fs::remove_dir_all(&appdata);
    }
}

#[cfg(test)]
mod watch_tests {
    use super::{is_atomic_write_temp, is_watch_ignored, normalize_event_kind};
    use notify::event::{AccessKind, AccessMode, CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
    use std::path::Path;

    #[test]
    fn create_is_add_and_remove_is_unlink() {
        assert_eq!(normalize_event_kind(&EventKind::Create(CreateKind::Any)), Some("add"));
        assert_eq!(
            normalize_event_kind(&EventKind::Create(CreateKind::Folder)),
            Some("add")
        );
        assert_eq!(normalize_event_kind(&EventKind::Remove(RemoveKind::Any)), Some("unlink"));
        assert_eq!(
            normalize_event_kind(&EventKind::Remove(RemoveKind::File)),
            Some("unlink")
        );
    }

    #[test]
    fn rename_from_is_unlink_and_rename_to_is_change() {
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::From))),
            Some("unlink")
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::To))),
            Some("change")
        );
        // Both：一个事件两条路径、谁是谁分不清 ⇒ 一律 change，让消费方按内容比对收敛
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some("change")
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Name(RenameMode::Any))),
            Some("change")
        );
    }

    #[test]
    fn unclassifiable_kinds_are_reported_not_dropped() {
        // 绝不静默：分不出类别的变更也要报出去
        assert_eq!(normalize_event_kind(&EventKind::Any), Some("change"));
        assert_eq!(normalize_event_kind(&EventKind::Other), Some("change"));
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Any)),
            Some("change")
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Metadata(
                notify::event::MetadataKind::Any
            ))),
            Some("change")
        );
    }

    #[test]
    fn pure_reads_are_dropped() {
        // 索引构建本身就在成千次读盘：Access 事件转发出去就是事件风暴
        assert_eq!(
            normalize_event_kind(&EventKind::Access(AccessKind::Read)),
            None
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Access(AccessKind::Any)),
            None
        );
        assert_eq!(
            normalize_event_kind(&EventKind::Access(AccessKind::Open(AccessMode::Execute))),
            None
        );
    }

    #[test]
    fn atomic_write_temp_is_filtered_and_real_files_are_not() {
        // write_file_bytes 的产物：.{name}.{pid}-{序号}.kojo-tmp
        assert!(is_atomic_write_temp(Path::new(
            r"C:\data\dir\.payload.txt.4242-7.kojo-tmp"
        )));
        // 真实文件与相邻命名都不该被误滤
        assert!(!is_atomic_write_temp(Path::new(
            r"C:\data\dir\payload.txt"
        )));
        assert!(!is_atomic_write_temp(Path::new(
            r"C:\data\dir\.payload.txt.4242.other-tmp"
        )));
        assert!(!is_atomic_write_temp(Path::new(r"C:\data\dir\notes.kojo-tmp")));
        assert!(!is_atomic_write_temp(Path::new(r"C:\data\dir\.hidden")));
        // 目录名恰好带点也不能升级成"临时文件"
        assert!(!is_atomic_write_temp(Path::new(r"C:\data\a.kojo-tmp\b.txt")));
    }

    #[test]
    fn watch_ignored_segments_are_filtered() {
        // VCS / 依赖 / 编辑器临时目录：任一段命中即整条丢弃
        assert!(is_watch_ignored(Path::new(r"C:\repo\.git\HEAD")));
        assert!(is_watch_ignored(Path::new(r"C:\repo\.git\objects\ab\cd1234")));
        assert!(is_watch_ignored(Path::new(r"C:\repo\node_modules\vite\dist\index.js")));
        assert!(is_watch_ignored(Path::new(r"C:\repo\src\.kojo-tmp\leftover.bin")));
        // Windows 上 `.GIT` 与 `.git` 是同一目录，大小写不敏感
        assert!(is_watch_ignored(Path::new(r"C:\repo\.GIT\config")));
    }

    #[test]
    fn watch_ignored_exact_segment_matching_not_prefix() {
        // 前缀相似的名字不命中（精确段匹配，不是 starts_with / contains）
        assert!(!is_watch_ignored(Path::new(r"C:\repo\.git-repo\hook")));
        assert!(!is_watch_ignored(Path::new(r"C:\repo\.gitignore")));
        assert!(!is_watch_ignored(Path::new(r"C:\repo\node_modules-backup\x.js")));
        assert!(!is_watch_ignored(Path::new(r"C:\repo\my.kojo-tmp-notes\a.txt")));
    }

    #[test]
    fn watch_ignored_never_excludes_corpus_content() {
        // 语料的真实扩展名与 CJK 目录段一个都不许滤（样例用中性根名——
        // 判据钉在「段不命中忽略表」，游戏专名不进宿主，audit A 同口径）
        assert!(!is_watch_ignored(Path::new(r"C:\game\corpus\CSV\ABL.CSV")));
        assert!(!is_watch_ignored(Path::new(
            r"C:\game\corpus\ERB\口上・メッセージ関連\表_K12.ERB"
        )));
        assert!(!is_watch_ignored(Path::new(r"C:\game\corpus\ERB\声明.ERH")));
        assert!(!is_watch_ignored(Path::new(r"C:\game\corpus\资源\列表.ERD")));
        assert!(!is_watch_ignored(Path::new(r"C:\game\corpus\JUEL.als")));
        assert!(!is_watch_ignored(Path::new(r"C:\game\corpus\存档\save03.dat")));
        assert!(!is_watch_ignored(Path::new(r"C:\game\corpus\剧本\桥段.kojo")));
    }

    #[test]
    fn watch_ignored_when_root_is_itself_ignored_dir() {
        // 边界：监视根本身就是忽略目录（用户把项目根开在 .git 里）——
        // 事件路径的段里必然含它 ⇒ 全部丢弃 = 事实上不监视（宁可零事件也不进噪声）
        assert!(is_watch_ignored(Path::new(r"C:\repo\.git")));
        assert!(is_watch_ignored(Path::new(r"C:\repo\node_modules")));
        assert!(is_watch_ignored(Path::new(r"C:\repo\.git\")));
        // 反过来：根本身是正常目录、只有子目录被忽略 ⇒ 根上的事件照常透传
        assert!(!is_watch_ignored(Path::new(r"C:\repo\README.md")));
        assert!(!is_watch_ignored(Path::new(r"C:\repo")));
    }

}

#[cfg(test)]
mod watch_runtime_tests {
    //! 真实监视器投递验证（BUG-5 判据②的 Rust 半边）。
    //!
    //! `WebviewForwarder` 要 `AppHandle`，单测造不出 Tauri 运行时 ⇒
    //! WebView 那一段仍留人工清单。但"**递归监视在这台机器上到底收不收得到事件**"
    //! 不需要 WebView 也能证：这里用 channel 当接收端，事件照样过
    //! `normalize_event_kind` 纯映射——那才是本层唯一有判断的地方。
    use super::{is_watch_ignored, normalize_event_kind};
    use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
    use notify::{Watcher, RecursiveMode};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;
    use std::time::{Duration, Instant};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_root(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "kojo-watch-{}-{tag}-{n}",
            std::process::id(),
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 收到 `path` 上的一条可映射事件即算成功；超时 5s（轮询监视在慢机上会晚到）
    fn wait_for(rx: &std::sync::mpsc::Receiver<notify::Result<notify::Event>>) -> Vec<(String, &'static str)> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Ok(ev)) => {
                    let Some(kind) = normalize_event_kind(&ev.kind) else {
                        continue;
                    };
                    for p in ev.paths {
                        seen.push((p.to_string_lossy().into_owned(), kind));
                    }
                }
                Ok(Err(_)) => continue, // 监视器自身报错：继续收，另有测试管降级
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        seen
    }

    #[test]
    fn recursive_watch_delivers_nested_create_and_modify() {
        let root = temp_root("nested");
        let deep = root.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();

        let (tx, rx) = channel();
        let mut watcher =
            notify::RecommendedWatcher::new(move |res| {
                let _ = tx.send(res);
            }, notify::Config::default())
            .expect("RecommendedWatcher 应能创建");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("递归监视应能登记");

        let target = deep.join("payload.txt");
        std::fs::write(&target, "first").unwrap();
        std::fs::write(&target, "second").unwrap();

        let seen = wait_for(&rx);
        let hit = seen.iter().any(|(p, _)| p.ends_with("payload.txt"));
        assert!(
            hit,
            "深层目录里的写入没有收到任何事件；实际收到 = {:?}",
            seen
        );
        // 分类必须落在契约三态内（新建 → add，改写 → change；两者都算投递成功）
        let kinds: Vec<&str> = seen.iter().map(|(_, k)| *k).collect();
        assert!(
            kinds.iter().all(|k| matches!(*k, "add" | "change" | "unlink")),
            "映射产物越界：{:?}",
            kinds
        );

        drop(watcher); // Drop 即注销底层句柄
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mapping_covers_the_kinds_this_backend_actually_emits() {
        // 与 windows.rs 的投递形态对齐：Create(Any) / Remove(Any) / Modify(Any) /
        // Modify(Name(From|To))。后端换了类别也不该导致事件被吞掉。
        assert_eq!(normalize_event_kind(&EventKind::Create(CreateKind::Any)), Some("add"));
        assert_eq!(normalize_event_kind(&EventKind::Remove(RemoveKind::Any)), Some("unlink"));
        assert_eq!(
            normalize_event_kind(&EventKind::Modify(ModifyKind::Any)),
            Some("change")
        );
    }

    /// P0-5 组合证据：`.git` 子目录的写入在这台机器上**真的会**投出事件
    /// （⇒ 过滤是必要的，不是防御幻想），而 `is_watch_ignored` 对这些
    /// 真实路径**全部**判忽略（⇒ 生产链路 `handle_event` 里先滤再转发，
    /// 忽略目录的事件一个也到不了 WebView）。两半合起来才是"零外泄"。
    #[test]
    fn git_dir_events_are_real_and_fully_covered_by_ignore_table() {
        let root = temp_root("gitdir");
        let git_dir = root.join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();

        let (tx, rx) = channel();
        let mut watcher = notify::RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            notify::Config::default(),
        )
        .expect("RecommendedWatcher 应能创建");
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .expect("递归监视应能登记");

        let git_file = git_dir.join("HEAD");
        let real_file = root.join("口上.ERB");
        std::fs::write(&git_file, "ref: refs/heads/master\n").unwrap();
        std::fs::write(&real_file, "PRINTL 测试").unwrap();

        let seen = wait_for(&rx);
        let git_seen: Vec<&(String, &'static str)> = seen
            .iter()
            .filter(|(p, _)| p.contains(".git"))
            .collect();
        assert!(
            !git_seen.is_empty(),
            "本机对 .git 子目录没有投出任何事件 ⇒ 本用例失去证据力，需重估（实际收到 = {:?}）",
            seen
        );
        for (p, _) in &git_seen {
            assert!(
                is_watch_ignored(Path::new(p)),
                "忽略表漏了真实投出的 .git 路径：{p}"
            );
        }
        let real_seen = seen
            .iter()
            .any(|(p, _)| p.ends_with("口上.ERB") && !is_watch_ignored(Path::new(p)));
        assert!(real_seen, "语料形态的 ERB 写入必须照常透传；实际收到 = {seen:?}");

        drop(watcher);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod io_primitives_tests {
    use crate::{list_dir_of, stat_file_at, walk_dir_of, WalkOptionsDto};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-io-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `walk_dir(withMetadata)` 带回的 mtime/size 必须与 `stat_file` **逐位同值**——
    /// 索引的体量指纹、逐文件复用判据、以及已经躺在盘上的快照全都以此为前提。
    /// 值一漂，等价于把老项目的缓存整批无谓作废（所以这条测在 Rust，而不是只测假 io）。
    #[test]
    fn walk_with_metadata_matches_stat_file_exactly() {
        let dir = temp_dir("walkmeta");
        std::fs::write(dir.join("a.ERB"), "hello").unwrap();
        std::fs::write(dir.join("b.ERB"), "longer content here").unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();

        let opts = WalkOptionsDto {
            max_depth: None,
            include_files: Some(true),
            include_dirs: Some(true),
            with_metadata: Some(true),
        };
        let entries = walk_dir_of(&dir.to_string_lossy(), opts).unwrap();
        assert!(entries.iter().any(|e| e.is_directory), "目录条目应仍在");

        let mut files = 0;
        for e in &entries {
            if e.is_directory {
                assert!(e.mtime_ms.is_none(), "目录条目不带元数据 ⇒ 调用方退化回 stat");
                continue;
            }
            let st = stat_file_at(&e.path).expect("stat_file 应成功");
            assert_eq!(e.mtime_ms, Some(st.mtime_ms), "mtime 必须逐位同值：{}", e.path);
            assert_eq!(e.size, Some(st.size), "size 必须逐位同值：{}", e.path);
            files += 1;
        }
        assert_eq!(files, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不带 `withMetadata` 时输出形态必须与改造前**逐字一致**：两个键整个不出现，
    /// 而不是出现成 `null`——前端靠 `typeof === 'number'` 判可用，`null` 会被读成"取到了值"。
    #[test]
    fn walk_without_metadata_omits_the_keys_entirely() {
        let dir = temp_dir("nometa");
        std::fs::write(dir.join("a.ERB"), "x").unwrap();
        let entries = walk_dir_of(&dir.to_string_lossy(), WalkOptionsDto::default()).unwrap();
        let json = serde_json::to_string(&entries).unwrap();
        assert!(!json.contains("mtimeMs"), "不该出现该键：{json}");
        assert!(!json.contains("\"size\""), "不该出现该键：{json}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 铁律 4：`list_dir` 只把"目录不存在"折叠成空列表，其它 IO 错误必须如实上抛——
    /// 绝不与"空目录"混为一谈（旧实现把所有 read_dir 错误都吞成 Ok([])）。
    #[test]
    fn list_dir_folds_only_not_found_and_propagates_other_errors() {
        let dir = temp_dir("listdir");
        std::fs::write(dir.join("a.ERB"), "x").unwrap();

        // 已存在目录 ⇒ Ok + 条目
        let ok = list_dir_of(&dir.to_string_lossy()).unwrap();
        assert!(ok.iter().any(|e| e.name == "a.ERB"), "正常目录没列出条目");

        // 不存在的目录 ⇒ Ok(空)（首次运行/尚未创建的目录是正常态，与 NodeBridge 一致）
        let missing = dir.join("nope").to_string_lossy().to_string();
        assert_eq!(list_dir_of(&missing).unwrap().len(), 0, "不存在应折叠成空列表");

        // 其它错误 ⇒ Err：路径含内嵌 NUL ⇒ std 在进入文件系统前就返回 InvalidInput
        // （非 NotFound、跨平台确定），旧实现会把它误吞成 Ok([])
        let nul = format!("{}\0bad", dir.display());
        assert!(list_dir_of(&nul).is_err(), "非 NotFound 的 read_dir 错误被静默吞掉");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 深度口径（手工走查重写后的钉子）：`maxDepth` 计的是**根之下的层数**，
    /// `maxDepth: 0` = 仅直接子项。这组数字同时是 TS 桥口径（`walkdir-bridge-equivalence`
    /// 的 `maxDepth: 0` 用例）与旧 walkdir 实现的逐层平移。
    #[test]
    fn walk_depth_counts_levels_below_the_root() {
        let dir = temp_dir("walkdepth");
        std::fs::create_dir_all(dir.join("a").join("b")).unwrap();
        std::fs::write(dir.join("top.ERB"), "x").unwrap();
        std::fs::write(dir.join("a").join("mid.ERB"), "x").unwrap();
        std::fs::write(dir.join("a").join("b").join("deep.ERB"), "x").unwrap();
        let root = dir.to_string_lossy().to_string();
        let names = |depth: Option<usize>, dirs: bool| -> Vec<String> {
            let mut v: Vec<String> = walk_dir_of(
                &root,
                WalkOptionsDto {
                    max_depth: depth,
                    include_files: Some(!dirs),
                    include_dirs: Some(dirs),
                    with_metadata: None,
                },
            )
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
            v.sort();
            v
        };

        assert_eq!(names(Some(0), false), vec!["top.ERB".to_string()], "maxDepth 0 = 直接子项");
        assert_eq!(
            names(Some(1), false),
            vec!["mid.ERB".to_string(), "top.ERB".to_string()],
            "maxDepth 1 = 根下两层"
        );
        assert_eq!(
            names(Some(2), false),
            vec!["deep.ERB".to_string(), "mid.ERB".to_string(), "top.ERB".to_string()]
        );
        assert_eq!(names(None, false).len(), 3, "不限深 = 全部");
        // 目录条目与文件条目共用同一口径（includeDirs 只筛输出，不影响递归）
        assert_eq!(names(Some(0), true), vec!["a".to_string()], "maxDepth 0 的目录侧");
        assert_eq!(names(Some(1), true), vec!["a".to_string(), "b".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `includeFiles` / `includeDirs` 只筛**输出条目**，不剪枝：只要目录时深层目录仍到达，
    /// 只要文件时深层文件仍到达（旧 walkdir 实现的同一条契约）。
    #[test]
    fn include_flags_filter_output_not_recursion() {
        let dir = temp_dir("walkflags");
        std::fs::create_dir_all(dir.join("a").join("b")).unwrap();
        std::fs::write(dir.join("a").join("b").join("x.ERB"), "x").unwrap();
        let root = dir.to_string_lossy().to_string();

        let dirs = walk_dir_of(
            &root,
            WalkOptionsDto {
                max_depth: None,
                include_files: Some(false),
                include_dirs: Some(true),
                with_metadata: None,
            },
        )
        .unwrap();
        let names: Vec<&str> = dirs.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"a") && names.contains(&"b"), "目录侧递归被过滤剪掉了：{names:?}");
        assert!(dirs.iter().all(|e| e.is_directory));

        let files = walk_dir_of(
            &root,
            WalkOptionsDto {
                max_depth: None,
                include_files: Some(true),
                include_dirs: Some(false),
                with_metadata: None,
            },
        )
        .unwrap();
        assert_eq!(files.len(), 1, "深层文件应照常输出");
        assert_eq!(files[0].name, "x.ERB");
        assert!(!files[0].is_directory);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 前序 DFS：目录条目必须先于它的全部子孙出现（旧 walkdir 同序；树形消费按此折叠）。
    #[test]
    fn walk_preorder_keeps_parent_directory_before_children() {
        use std::path::MAIN_SEPARATOR_STR;
        let dir = temp_dir("walkorder");
        for sub in ["a", "b"] {
            std::fs::create_dir_all(dir.join(sub).join("inner")).unwrap();
            std::fs::write(dir.join(sub).join("inner").join("f.ERB"), "x").unwrap();
        }
        let entries = walk_dir_of(
            &dir.to_string_lossy(),
            WalkOptionsDto {
                max_depth: None,
                include_files: Some(true),
                include_dirs: Some(true),
                with_metadata: None,
            },
        )
        .unwrap();
        for (i, e) in entries.iter().enumerate() {
            if !e.is_directory {
                continue;
            }
            let prefix = format!("{}{sep}", e.path, sep = MAIN_SEPARATOR_STR);
            for (j, child) in entries.iter().enumerate() {
                if child.path.starts_with(&prefix) {
                    assert!(j > i, "父目录条目必须在其子项之前：{}", e.path);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod atomic_write_tests {
    //! 原子写的判据：临时名进程内唯一（同目标并发写不互踩）、
    //! 并发写期间读方任一时刻读到的都是某一次**完整**写入、不留临时残骸。
    use super::{atomic_write, is_atomic_write_temp, tmp_unique_id};
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-atomic-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 回归锚（tmp 名只含 pid 的互踩缺陷）：临时名必须进程内逐次唯一，
    /// 且新形态 `.{name}.{pid}-{seq}.kojo-tmp` 仍被文件监视的噪声滤网命中。
    #[test]
    fn tmp_names_are_unique_within_process_and_still_watch_filtered() {
        let a = tmp_unique_id();
        let b = tmp_unique_id();
        assert_ne!(a, b, "连续两次取号必须不同：{a} vs {b}");
        let dir = temp_dir("uniq");
        let tmp = dir.join(format!(".snap.json.{a}.kojo-tmp"));
        assert!(
            is_atomic_write_temp(&tmp),
            "新临时名仍应被 is_atomic_write_temp 滤掉：{}",
            tmp.display()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 顺序替换：目标逐字一致，目录里只剩目标本身（rename 成功 ⇒ 临时文件消失）。
    #[test]
    fn sequential_write_replaces_content_and_leaves_no_tmp() {
        let dir = temp_dir("seq");
        let target = dir.join("a.ERB");
        atomic_write(&target, b"first").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        atomic_write(&target, b"second-payload").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second-payload");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["a.ERB".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归（同目标并发写互踩）：多线程反复写同一目标，读者全程采样。
    /// 断言每次读到的都是某一次**完整**载荷（无交错半截）；读者遇到任何混入即测败。
    /// Windows 上并发 rename 覆盖同一目标可能瞬时 ACCESS_DENIED（delete-pending），
    /// 写者对这类瞬时错做有界重试——同一载荷重写不改「读到必完整」的判据。
    #[test]
    fn concurrent_writes_to_same_target_are_always_read_whole() {
        const WRITERS: usize = 8;
        const ROUNDS: usize = 8;
        let dir = temp_dir("conc");
        let target = dir.join("save.json");

        // 每线程一份固定载荷（字节值与长度都互异，混入即穿帮）
        let payloads: Vec<Vec<u8>> = (0..WRITERS)
            .map(|w| vec![w as u8 + 1; 8192 + w * 333])
            .collect();
        let known: Arc<HashSet<Vec<u8>>> = Arc::new(payloads.iter().cloned().collect());

        // 先落一粒种子，读者起点起目标恒存在（瞬时 NotFound 仍按噪声容忍并计数）
        atomic_write(&target, &payloads[0]).unwrap();

        let done = Arc::new(AtomicBool::new(false));
        let barrier = Arc::new(Barrier::new(WRITERS + 1));
        let reader = {
            let done = done.clone();
            let known = known.clone();
            let target = target.clone();
            std::thread::spawn(move || {
                let mut samples = 0usize;
                let mut transient_missing = 0usize;
                while !done.load(Ordering::SeqCst) {
                    match std::fs::read(&target) {
                        Ok(bytes) => {
                            assert!(
                                known.contains(&bytes),
                                "读到交错半截：len={}（合法载荷长度集={:?}）",
                                bytes.len(),
                                known.iter().map(|p| p.len()).collect::<Vec<_>>()
                            );
                            samples += 1;
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                            transient_missing += 1;
                            assert!(
                                transient_missing <= 100,
                                "目标反复消失：{transient_missing}"
                            );
                        }
                        Err(e) => panic!("读者读目标失败：{e}"),
                    }
                }
                assert!(samples > 0, "读者一次都没读到");
            })
        };

        let mut handles = Vec::new();
        for (w, payload) in payloads.iter().enumerate() {
            let barrier = barrier.clone();
            let target = target.clone();
            let payload = payload.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait(); // 全体写者同时开跑，把并发窗拉到最大
                for _ in 0..ROUNDS {
                    let mut attempts = 0usize;
                    loop {
                        match atomic_write(&target, &payload) {
                            Ok(()) => break,
                            Err(e) => {
                                attempts += 1;
                                assert!(
                                    attempts <= 200,
                                    "writer {w} 连续 {attempts} 次失败：{e}"
                                );
                                std::thread::sleep(std::time::Duration::from_millis(1));
                            }
                        }
                    }
                }
            }));
        }
        barrier.wait();
        for h in handles {
            h.join().unwrap();
        }
        done.store(true, Ordering::SeqCst);
        reader.join().unwrap();

        // 收尾：终值必是某一次完整写入，且无临时残骸
        let final_bytes = std::fs::read(&target).unwrap();
        assert!(known.contains(&final_bytes), "终值不是完整载荷");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            leftovers,
            vec!["save.json".to_string()],
            "留了临时残骸：{leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod batch_io_tests {
    //! 批量读帧格式与批量 stat 的判据。
    //!
    //! 帧是 Rust 与 JS 解帧器（`packages/app/src/bridge/read-files-frame.ts`）之间的
    //! **逐字节契约**：字段一漂，前端不是报错而是静默错位（读到的"内容"错位成别的字段），
    //! 所以这里自带一份解帧器做**往返对拍**——两份解码独立写、以帧格式为唯一真源。
    use super::{
        read_files_frame, stat_files_of, BATCH_READ_THREADS, FRAME_STATUS_NOT_FOUND,
        FRAME_STATUS_OK, FRAME_STATUS_READ_ERROR,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-batch-io-{}-{tag}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 测试用解帧器（与 JS 侧 DataView 解帧器同格式）：(path, status, mtimeMs, size, data)
    fn decode_frame(frame: &[u8]) -> Vec<(String, u32, i64, u64, Vec<u8>)> {
        let u32_at = |off: usize| u32::from_le_bytes(frame[off..off + 4].try_into().unwrap());
        let mut off = 0usize;
        let count = u32_at(off) as usize;
        off += 4;
        let mut out = Vec::new();
        for _ in 0..count {
            let plen = u32_at(off) as usize;
            off += 4;
            let path = String::from_utf8(frame[off..off + plen].to_vec()).unwrap();
            off += plen;
            let status = u32_at(off);
            off += 4;
            let mtime = i64::from_le_bytes(frame[off..off + 8].try_into().unwrap());
            off += 8;
            let size = u64::from_le_bytes(frame[off..off + 8].try_into().unwrap());
            off += 8;
            let dlen = u64::from_le_bytes(frame[off..off + 8].try_into().unwrap()) as usize;
            off += 8;
            let data = frame[off..off + dlen].to_vec();
            off += dlen;
            out.push((path, status, mtime, size, data));
        }
        assert_eq!(off, frame.len(), "帧尾不应有多余字节");
        out
    }

    /// 正常路径：多文件按**入参顺序**回位，字节原样、size/mtime 与 stat_file 同值
    #[test]
    fn reads_multiple_files_in_input_order() {
        let dir = temp_dir("multi");
        let a = dir.join("a.ERB");
        let b = dir.join("b.ERB");
        std::fs::write(&a, "@A\nPRINTL 甲\n").unwrap();
        std::fs::write(&b, "@B\n").unwrap();
        let paths = vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
        ];
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].0, paths[0]);
        assert_eq!(decoded[1].0, paths[1]);
        assert_eq!(decoded[0].1, FRAME_STATUS_OK);
        assert_eq!(decoded[1].1, FRAME_STATUS_OK);
        assert_eq!(decoded[0].4, "@A\nPRINTL 甲\n".as_bytes());
        assert_eq!(decoded[1].4, "@B\n".as_bytes());
        let st = super::stat_file_at(&paths[0]).unwrap();
        assert_eq!(decoded[0].2, st.mtime_ms as i64, "mtime 必须与 stat_file 逐位同值");
        assert_eq!(decoded[0].3, st.size);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 缺文件：status=1（不存在）、空数据，且**不影响同批其它文件**（批量不整批失败）
    #[test]
    fn missing_file_is_not_found_and_rest_of_batch_survives() {
        let dir = temp_dir("missing");
        let ok = dir.join("ok.ERB");
        std::fs::write(&ok, "x").unwrap();
        let missing = dir.join("nope.ERB");
        let paths = vec![
            missing.to_string_lossy().to_string(),
            ok.to_string_lossy().to_string(),
        ];
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded[0].1, FRAME_STATUS_NOT_FOUND);
        assert!(decoded[0].4.is_empty());
        assert_eq!(decoded[1].1, FRAME_STATUS_OK);
        assert_eq!(decoded[1].4, b"x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空数组：count=0 的合法帧（不是错误；调用方按"零结果"处理）
    #[test]
    fn empty_path_list_yields_zero_count_frame() {
        let frame = read_files_frame(&[]);
        assert_eq!(frame, vec![0, 0, 0, 0]);
        assert!(decode_frame(&frame).is_empty());
    }

    /// 非 ASCII（多字节 UTF-8）路径：pathLen 按**字节**量、往返逐字一致
    /// （Rust 入参是 String，路径字节必为 UTF-8；这条钉的是帧内长度口径不是字符数）
    #[test]
    fn multibyte_utf8_path_roundtrips_in_frame() {
        let dir = temp_dir("utf8path");
        let f = dir.join("事件·測試.ERB");
        std::fs::write(&f, "@福\n").unwrap();
        let paths = vec![f.to_string_lossy().to_string()];
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded[0].0, paths[0]);
        assert_eq!(decoded[0].1, FRAME_STATUS_OK);
        assert_eq!(decoded[0].4, "@福\n".as_bytes());
        // 不存在的多字节路径同样如实回 None 态（不是读取错误）
        let ghost = dir.join("不存在.ERB").to_string_lossy().to_string();
        let decoded2 = decode_frame(&read_files_frame(&[ghost.clone()]));
        assert_eq!(decoded2[0].0, ghost);
        assert_eq!(decoded2[0].1, FRAME_STATUS_NOT_FOUND);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 空文件：status=0 + size=0 + dataLen=0（合法的零长内容，不是"读错"）
    #[test]
    fn empty_file_is_ok_with_zero_len() {
        let dir = temp_dir("empty");
        let f = dir.join("empty.ERB");
        std::fs::write(&f, "").unwrap();
        let path = f.to_string_lossy().to_string();
        let decoded = decode_frame(&read_files_frame(&[path]));
        assert_eq!(decoded[0].1, FRAME_STATUS_OK);
        assert_eq!(decoded[0].3, 0);
        assert!(decoded[0].4.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 读错（目录当文件读）：status=2——与"不存在"分开报，两类失败都可见
    #[test]
    fn directory_read_is_read_error_not_not_found() {
        let dir = temp_dir("dirread");
        let path = dir.to_string_lossy().to_string();
        let decoded = decode_frame(&read_files_frame(&[path]));
        assert_eq!(decoded[0].1, FRAME_STATUS_READ_ERROR);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 预分配容量（PS-1 §5）按字段算死 ⇒ 这条同时钉住两头：算少了 = 一帧几十 MB 要
    /// realloc 二十几轮（预分配白做），算多了 = 帧尾挂零字节（前端解帧器直接报
    /// "帧尾部有多余字节"）。`decode_frame` 内部已断言后者，这里把总长也逐字节对平。
    #[test]
    fn frame_length_is_exactly_the_sum_of_its_fields() {
        let dir = temp_dir("framesize");
        let files = [
            (dir.join("a.ERB"), "@A\nPRINTL 甲\n"),
            (dir.join("事件·測試.ERB"), ""),
            (dir.join("c.ERB"), "x"),
            (dir.join("missing.ERB"), ""),
        ];
        let mut paths: Vec<String> = Vec::new();
        for (i, (p, body)) in files.iter().enumerate() {
            if i != 3 {
                std::fs::write(p, body).unwrap();
            }
            paths.push(p.to_string_lossy().into_owned());
        }
        let frame = read_files_frame(&paths);
        let decoded = decode_frame(&frame);
        let expect: usize = 4
            + decoded
                .iter()
                .map(|(p, _, _, _, d)| 4 + p.len() + 4 + 8 + 8 + 8 + d.len())
                .sum::<usize>();
        assert_eq!(frame.len(), expect, "帧长与字段和不符 ⇒ 容量算式漂了");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// stat_files：存在项与 stat_file 同源同值；缺项 exists=false + null 数值
    #[test]
    fn stat_files_matches_stat_file_and_reports_missing() {
        let dir = temp_dir("statbatch");
        let f = dir.join("s.ERB");
        std::fs::write(&f, "hello").unwrap();
        let missing = dir.join("gone.ERB");
        let out = stat_files_of(&[
            f.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ]);
        let st = super::stat_file_at(&f.to_string_lossy().to_string()).unwrap();
        assert!(out[0].exists);
        assert_eq!(out[0].size, Some(st.size));
        assert_eq!(out[0].mtime_ms, Some(st.mtime_ms));
        assert!(!out[1].exists);
        assert_eq!(out[1].mtime_ms, None);
        assert_eq!(out[1].size, None);
        // JSON 形态：camelCase 键 + 缺项为 null（前端按 null 判"不可用"）
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"mtimeMs\":null"), "缺项应为 null：{json}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 批量 stat 铺并行之后**仍必须按入参顺序回位**（前端按下标认领，顺序漂 = 把 A 的
    /// 体积记到 B 头上）；条目数跨过 worker 数 ⇒ 真走并行分支（PS-1 §2 的回归锚）。
    #[test]
    fn stat_files_keeps_input_order_beyond_the_worker_count() {
        let dir = temp_dir("statorder");
        let mut paths: Vec<String> = Vec::new();
        for i in 0..(BATCH_READ_THREADS * 3) {
            let p = dir.join(format!("f{i:03}.ERB"));
            // 一半存在、一半不存在：两类都要按位回位
            if i % 2 == 0 {
                std::fs::write(&p, format!("{i}")).unwrap();
            }
            paths.push(p.to_string_lossy().into_owned());
        }
        let out = stat_files_of(&paths);
        assert_eq!(out.len(), paths.len());
        for (i, item) in out.iter().enumerate() {
            assert_eq!(item.path, paths[i], "第 {i} 项路径漂了");
            assert_eq!(item.exists, i % 2 == 0, "第 {i} 项存在性漂了");
            if i % 2 == 0 {
                // 内容是十进制序号本身 ⇒ 长度 = 该序号的字符数
                assert_eq!(
                    item.size,
                    Some(i.to_string().len() as u64),
                    "第 {i} 项体积漂了：{item:?}"
                );
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 批量读同理：并行铺开后条目数与顺序都不许动（帧里连 path 一起按位回位）。
    #[test]
    fn read_files_frame_keeps_input_order_and_count_across_threads() {
        let dir = temp_dir("frameorder");
        let mut paths: Vec<String> = Vec::new();
        for i in 0..(BATCH_READ_THREADS * 3) {
            let p = dir.join(format!("r{i:03}.ERB"));
            if i % 3 != 1 {
                std::fs::write(&p, format!("body-{i}\n")).unwrap();
            }
            paths.push(p.to_string_lossy().into_owned());
        }
        let decoded = decode_frame(&read_files_frame(&paths));
        assert_eq!(decoded.len(), paths.len(), "帧内条目数必须等于入参数");
        for (i, (path, status, _, size, data)) in decoded.iter().enumerate() {
            assert_eq!(path, &paths[i], "第 {i} 项路径漂了");
            if i % 3 == 1 {
                assert_eq!(*status, FRAME_STATUS_NOT_FOUND, "第 {i} 项应是不存在");
                assert_eq!(*size, 0);
                assert!(data.is_empty());
            } else {
                assert_eq!(*status, FRAME_STATUS_OK);
                assert_eq!(data.as_slice(), format!("body-{i}\n").as_bytes());
                assert_eq!(*size, data.len() as u64, "size 与实读字节数同源");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

}

#[cfg(test)]
mod async_command_tests {
    //! **async 壳 ⇔ 同步核心 逐字同结果**（PS-1 §1 的回归锚）。
    //!
    //! 把同步命令改成 `async` + `spawn_blocking` 的全部风险都在"过界形态漂了"：
    //! 前端一律 `await invoke(...)`，成功载荷的字节/形状一变就是静默错位（帧解歪、
    //! `null` 变 `undefined`、base64 多个前缀……）。`market_tests` 早有先例用
    //! `tauri::async_runtime::block_on` 直接驱动 async 命令体，这里同一形态打没有
    //! `State` 参数的几条；要 `State` 的写侧命令只能靠"闸的判定核心对平 + 编译期"，
    //! 命令级端到端属真壳判据（本批未跑真壳，见交付说明）。
    use super::{
        encode_string, list_dir, list_dir_of, path_exists, read_file_bytes, read_file_bytes_raw,
        read_files_raw, stat_file, stat_file_at, stat_files, stat_files_of, walk_dir, walk_dir_of,
        WalkOptionsDto, B64,
    };
    use base64::Engine as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::ipc::{IpcResponse, InvokeResponseBody};

    /// 二进制响应取回裸字节（非 Raw 形态即判为漂）
    fn raw_body(resp: tauri::ipc::Response) -> Vec<u8> {
        match resp.body().expect("响应体应可取回") {
            InvokeResponseBody::Raw(bytes) => bytes,
            InvokeResponseBody::Json(text) => panic!("二进制命令不该回 JSON：{text}"),
        }
    }

    /// 本模块自带一份最小解帧器（`batch_io_tests` 那份是模块私有的）：
    /// 只解判据要用的字段，帧格式一变就在这里先炸。
    fn frame_entries(frame: &[u8]) -> Vec<(String, u32, Vec<u8>)> {
        let u32_at = |off: usize| u32::from_le_bytes(frame[off..off + 4].try_into().unwrap());
        let mut off = 0usize;
        let count = u32_at(off) as usize;
        off += 4;
        let mut out = Vec::new();
        for _ in 0..count {
            let plen = u32_at(off) as usize;
            off += 4;
            let path = String::from_utf8(frame[off..off + plen].to_vec()).unwrap();
            off += plen;
            let status = u32_at(off);
            off += 4;
            off += 8; // mtimeMs
            off += 8; // size
            let dlen = u64::from_le_bytes(frame[off..off + 8].try_into().unwrap()) as usize;
            off += 8;
            out.push((path, status, frame[off..off + dlen].to_vec()));
            off += dlen;
        }
        assert_eq!(off, frame.len(), "帧尾不应有多余字节");
        out
    }

    #[test]
    fn async_wrappers_match_their_sync_cores_field_by_field() {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-async-cmd-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.ERB");
        std::fs::write(&f, "hello\n").unwrap();
        let p = f.to_string_lossy().to_string();
        let gone = dir.join("nope.ERB").to_string_lossy().to_string();

        // read_file_bytes：base64 文本过界，还原后逐字节等于盘上内容
        let b64 = tauri::async_runtime::block_on(read_file_bytes(p.clone())).unwrap();
        assert_eq!(B64.decode(&b64).unwrap(), b"hello\n");

        // read_file_bytes_raw：二进制过界，一个前缀都不许多
        let resp = tauri::async_runtime::block_on(read_file_bytes_raw(p.clone())).unwrap();
        assert_eq!(raw_body(resp), b"hello\n");
        assert!(
            tauri::async_runtime::block_on(read_file_bytes_raw(gone.clone())).is_err(),
            "读不到的文件必须报错，不许回一个空 body"
        );

        // path_exists / stat_file：形态与旧口径同（缺文件 ⇒ false / null，而不是 Err）
        assert!(tauri::async_runtime::block_on(path_exists(p.clone())).unwrap());
        assert!(!tauri::async_runtime::block_on(path_exists(gone.clone())).unwrap());
        let st = tauri::async_runtime::block_on(stat_file(p.clone()))
            .unwrap()
            .expect("stat_file 该有值");
        assert_eq!(st.size, 6);
        assert_eq!(st, stat_file_at(&p).expect("async 壳与同步核心不同形"));
        assert!(tauri::async_runtime::block_on(stat_file(gone.clone()))
            .unwrap()
            .is_none());

        // stat_files：与 stat_file 同源同值（并行化不许让 mtime 判据漂）
        let batch = tauri::async_runtime::block_on(stat_files(vec![p.clone(), gone.clone()]))
            .unwrap();
        assert_eq!(batch, stat_files_of(&[p.clone(), gone.clone()]));
        assert_eq!(batch[0].mtime_ms, Some(st.mtime_ms));
        assert!(!batch[1].exists);

        // read_files_raw：帧逐字节对平（前端解帧器按同一份格式读）
        let frame =
            tauri::async_runtime::block_on(read_files_raw(vec![p.clone(), gone.clone()])).unwrap();
        let decoded = frame_entries(&raw_body(frame));
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].0, p);
        assert_eq!(decoded[0].1, super::FRAME_STATUS_OK);
        assert_eq!(decoded[0].2, b"hello\n");
        assert_eq!(decoded[1].1, super::FRAME_STATUS_NOT_FOUND);

        // encode_string：非 UTF-8 族转码照旧；不可映射字符照旧**拒绝**（M2 数据损坏闸）
        let sjis =
            tauri::async_runtime::block_on(encode_string("あ".to_string(), "shift_jis".to_string()))
                .unwrap();
        assert_eq!(B64.decode(&sjis).unwrap(), vec![0x82, 0xA0]);
        let err = tauri::async_runtime::block_on(encode_string(
            "你好".to_string(),
            "shift_jis".to_string(),
        ))
        .expect_err("不可映射字符必须被拒，不许悄悄写成 HTML 实体");
        assert!(err.contains("无法表示的字符"), "拒因不符：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 阻塞下放的核心承诺（所有 async 壳共用）：活真的**不在调用线程**上跑，
    /// 且业务错误串原样过界（线程池只可能在"池本身炸了"时加自己的前缀）。
    #[test]
    fn run_blocking_moves_work_off_the_calling_thread_and_keeps_errors_verbatim() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(super::run_blocking("probe", move || {
            Ok::<_, String>(std::thread::current().id())
        }))
        .unwrap();
        assert_ne!(caller, worker, "活仍跑在调用线程上（阻塞下放没生效）");

        let err = tauri::async_runtime::block_on(super::run_blocking("probe", || {
            Err::<(), _>("原样错误串".to_string())
        }))
        .unwrap_err();
        assert_eq!(err, "原样错误串", "业务错误串被线程池改写");
    }

    /// `list_dir` / `walk_dir` 的 async 壳与同步核心**逐字节同形**（JSON 对平）：
    /// 把目录列举挪到阻塞线程池之后，前端载荷与错误口径一条都不许变。
    #[test]
    fn async_dir_listing_wrappers_match_their_sync_cores() {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kojo-async-dir-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.ERB"), "x").unwrap();
        std::fs::write(dir.join("sub").join("b.ERB"), "y").unwrap();
        let root = dir.to_string_lossy().to_string();
        let gone = dir.join("nope").to_string_lossy().to_string();

        // list_dir：正常目录逐字节对平；不存在仍折叠成空（不是 Err）
        let listed = tauri::async_runtime::block_on(list_dir(root.clone())).unwrap();
        assert_eq!(
            serde_json::to_string(&listed).unwrap(),
            serde_json::to_string(&list_dir_of(&root).unwrap()).unwrap(),
            "list_dir 的 async 壳与同步核心形状漂了"
        );
        assert_eq!(
            tauri::async_runtime::block_on(list_dir(gone)).unwrap().len(),
            0,
            "不存在目录仍应折叠成空列表"
        );

        // walk_dir：选项走同一份 DTO，结果逐字节对平（含 withMetadata 的键）
        let walked = tauri::async_runtime::block_on(walk_dir(
            root.clone(),
            Some(WalkOptionsDto {
                max_depth: None,
                include_files: Some(true),
                include_dirs: Some(true),
                with_metadata: Some(true),
            }),
        ))
        .unwrap();
        let sync_walked = walk_dir_of(
            &root,
            WalkOptionsDto {
                max_depth: None,
                include_files: Some(true),
                include_dirs: Some(true),
                with_metadata: Some(true),
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&walked).unwrap(),
            serde_json::to_string(&sync_walked).unwrap(),
            "walk_dir 的 async 壳与同步核心形状漂了"
        );
        assert_eq!(walked.len(), 3, "a.ERB + sub + sub/b.ERB");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod drag_drop_tests {
    //! phase 映射与载荷形状：这是与前端 `subscribeDragDrop` 的契约——
    //! camelCase、仅 drop 带路径，漂一条覆盖提示或开文件就断。
    use super::map_drag_drop;
    use serde_json::json;
    use std::path::PathBuf;
    use tauri::{DragDropEvent, PhysicalPosition};

    fn pos() -> PhysicalPosition<f64> {
        PhysicalPosition::new(1.0, 2.0)
    }

    #[test]
    fn only_drop_carries_paths() {
        let p = PathBuf::from("C:\\temp\\事件.ERB");
        let dropped = map_drag_drop(DragDropEvent::Drop {
            paths: vec![p.clone()],
            position: pos(),
        })
        .unwrap();
        assert_eq!(dropped.phase, "drop");
        assert_eq!(dropped.paths, vec![p.to_string_lossy().to_string()]);
        // B6：drop 同时携带光标坐标（前端按坐标命中目录行）
        assert_eq!(dropped.x, Some(1.0));
        assert_eq!(dropped.y, Some(2.0));

        for (ev, want) in [
            (
                DragDropEvent::Enter {
                    paths: vec![p.clone()],
                    position: pos(),
                },
                "enter",
            ),
            (DragDropEvent::Over { position: pos() }, "over"),
            (DragDropEvent::Leave, "leave"),
        ] {
            let got = map_drag_drop(ev).unwrap();
            assert_eq!(got.phase, want);
            assert!(got.paths.is_empty(), "{want} 相位不该带路径");
            // enter/over 带坐标（over 的拖悬高亮命入口）；leave 坐标与路径一并无
            if want == "leave" {
                assert_eq!(got.x, None);
                assert_eq!(got.y, None);
            } else {
                assert_eq!(got.x, Some(1.0));
                assert_eq!(got.y, Some(2.0));
            }
        }
    }

    #[test]
    fn payload_json_is_camel_case_with_both_keys() {
        let payload = map_drag_drop(DragDropEvent::Drop {
            paths: vec![PathBuf::from("a b.erm")],
            position: pos(),
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            json!({ "phase": "drop", "paths": ["a b.erm"], "x": 1.0, "y": 2.0 })
        );
    }

    #[test]
    fn leave_json_omits_coordinates() {
        // B6 向后兼容口径：None 坐标整个字段不序列化——老前端少读一个字段不炸
        let payload = map_drag_drop(DragDropEvent::Leave).unwrap();
        assert_eq!(serde_json::to_value(&payload).unwrap(), json!({ "phase": "leave", "paths": [] }));
    }
}
