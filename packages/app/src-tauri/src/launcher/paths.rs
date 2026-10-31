//! 磁盘布局与路径判据（§9.2 / §9.3）。
//!
//! **所有写落点都由本模块拼**：命令一律不接受任意目标路径（Rust 侧的接口形状里根本没有
//! 那个参数）。这里的三条判据是全批共用的唯一一份：
//!
//! 1. `normalize_relative`：`instance.json` 里的内部路径只许 **posix 相对路径**——拒空、
//!    拒绝对路径、拒盘符、拒 UNC、拒 `..` / `.`、拒 ADS 冒号、拒尾点 / 尾空格、拒 Windows
//!    设备保留名（`CON` / `NUL` / `COM1`…）；
//! 2. `resolve_relative`：拼绝对路径后按**组件级前缀**复核（不是字符串前缀——
//!    `C:\a\bc` 不该被 `C:\a\b` 认为在域内）；
//! 3. `assert_no_reparse_between`：逐段拒绝 reparse point（符号链接 / junction），
//!    免得"看起来在实例根内、其实链到别处"。
//!
//! 实例目录名 = 宿主生成的 id（UUID 形态：ASCII 字母数字 + `-`），**绝不用用户输入拼路径**
//! （重名 / 中文 / 表情 / `..` 全在这一层无效化）。

use std::path::{Component, Path, PathBuf};

use super::error::{ErrorCode, LauncherErrorDto, LauncherResult};

pub const LAUNCHER_DIR: &str = "launcher";
pub const REGISTRY_FILE: &str = "registry.json";
pub const APPROVALS_FILE: &str = "approvals.json";
pub const INSTANCE_MANIFEST: &str = "instance.json";
pub const LOCK_FILE: &str = "running.lock";
pub const INSTANCES_DIR: &str = "instances";
pub const RUNTIME_DIR: &str = "runtime";
pub const TRASH_DIR: &str = "trash";
/// 插件源码项目解包暂存（`launcher/project-staging/{id}/`；§7.2 `launcher_project_extract`）。
/// 与实例暂存（`instances/{id}/staging/`）分开：那是内容包计划，这是**不带实例**的项目提取。
pub const PROJECT_STAGING_DIR: &str = "project-staging";

pub const GAME_SUBDIR: &str = "game";
pub const LOGS_SUBDIR: &str = "logs";
pub const BACKUPS_SUBDIR: &str = "backups";
pub const STAGING_SUBDIR: &str = "staging";
/// 内容包 / 游戏插件的安装区（§9.2：同一命名空间，kind 见 `pack.json`）。
pub const CONTENT_SUBDIR: &str = "content";
pub const PACK_MANIFEST_FILE: &str = "pack.json";
pub const OWNERSHIP_FILE: &str = "ownership.json";
pub const PACK_STATE_FILE: &str = "state.json";
pub const PAYLOAD_SUBDIR: &str = "payload";
/// `backups/packs/{packId}/`（基础快照 + 每次操作的当次快照）。
pub const PACK_BACKUPS_SUBDIR: &str = "packs";
/// `backups/saves/`（存档备份 ZIP + 同名 `.json` 元数据）。
pub const SAVE_BACKUPS_SUBDIR: &str = "saves";
/// 首次安装前的基础文件快照（升级不覆盖，§10.1 第 [7] 步）。
pub const ORIGINAL_SNAPSHOT_DIR: &str = "original";

/// 实例 id 的形状闸：宿主生成的 UUID（含 `-`）。任何来自 JS 的 id 都先过这一关——
/// 它同时是「不能拿它拼出路径逃逸」的判据。
pub fn valid_instance_id(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// 单段名字（计划 id / 备份 id / 包 id）的形状闸。
///
/// 判据只回答「能不能当目录名」：ASCII 字母数字与 `-` `_` `.`，长度 1..=64，不许纯点、
/// 不许以点开头（`..foo` 这类在 Windows 上会被折叠，干脆一律不让进）。**不**在这里
/// 判业务字符集：包 id 更严的那一版（`^[a-z0-9][a-z0-9._-]{0,63}$`）归清单校验，
/// 这里只保证它落不成路径。
pub fn valid_component(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 64
        && !raw.starts_with('.')
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn escape(message: &str, detail: String) -> LauncherErrorDto {
    LauncherErrorDto::new(ErrorCode::PathEscape, message.to_string()).detail(detail)
}

/// Windows 设备名（大小写不敏感；带扩展名同样拦：`nul.txt` 也是设备）。不判 `CONIN$` 之类的
/// 控制台别名——它们不在本仓的路径面里出现，黑名单只留真会被"文件名"撞上的那批。
fn is_reserved_name(segment: &str) -> bool {
    let base = segment.split('.').next().unwrap_or(segment);
    let upper = base.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$") {
        return true;
    }
    // COM0-9 / LPT0-9（含 COM¹ 这类上标形态不在此列：盘上文件名极少用，且不在契约表内）
    let bytes = upper.as_bytes();
    if bytes.len() == 4 {
        let (head, digit) = bytes.split_at(3);
        if (head == b"COM" || head == b"LPT") && digit[0].is_ascii_digit() {
            return true;
        }
    }
    false
}

/// posix 相对路径的规范化（不改大小写；只做"能不能用"的判定）。
///
/// 返回规范化后的字符串（`/` 分隔）；**不**做 `..` 折叠——出现 `..` 就是拒绝，折叠会把
/// 「试图逃逸」洗成「合法路径」。
pub fn normalize_relative(raw: &str) -> LauncherResult<String> {
    if raw.is_empty() {
        return Err(escape("内部路径为空", "relativePath 不能为空".into()));
    }
    if raw.contains('\0') {
        return Err(escape("内部路径含非法字符", "relativePath 含 NUL".into()));
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(escape(
            "内部路径必须是相对路径",
            format!("relativePath={raw}"),
        ));
    }
    if raw.contains('\\') {
        return Err(escape(
            "内部路径分隔符必须是 /",
            format!("relativePath={raw}"),
        ));
    }
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(escape("内部路径不许带盘符", format!("relativePath={raw}")));
    }
    if raw.contains(':') {
        return Err(escape(
            "内部路径不许含冒号（NTFS 备用数据流）",
            format!("relativePath={raw}"),
        ));
    }
    let mut parts: Vec<&str> = Vec::new();
    for segment in raw.split('/') {
        if segment.is_empty() {
            return Err(escape(
                "内部路径含空段",
                format!("relativePath={raw}（双斜杠 / 首尾斜杠）"),
            ));
        }
        if segment == "." || segment == ".." {
            return Err(escape(
                "内部路径不许含 . / ..",
                format!("relativePath={raw}"),
            ));
        }
        if segment.len() > 255 {
            return Err(escape("内部路径单段过长", format!("segment={segment}")));
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(escape(
                "内部路径段不许以点或空格结尾",
                format!("segment={segment}"),
            ));
        }
        if segment.chars().any(|c| c.is_control()) {
            return Err(escape("内部路径含控制字符", format!("segment={segment}")));
        }
        if is_reserved_name(segment) {
            return Err(escape(
                "内部路径命中 Windows 设备保留名",
                format!("segment={segment}"),
            ));
        }
        parts.push(segment);
    }
    Ok(parts.join("/"))
}

/// **组件级**前缀判据（大小写不敏感在 Windows 上，其它平台精确比较）。
///
/// 用 `Path::components()` 而不是 `str::starts_with`：后者会把 `C:\a\bc` 判成在
/// `C:\a\b` 域内。
pub fn path_has_prefix(root: &Path, target: &Path) -> bool {
    let mut root_parts = root.components();
    let mut target_parts = target.components();
    loop {
        match (root_parts.next(), target_parts.next()) {
            (None, _) => return true,
            (Some(a), Some(b)) => {
                if !component_eq(a, b) {
                    return false;
                }
            }
            (Some(_), None) => return false,
        }
    }
}

#[cfg(windows)]
fn component_eq(a: Component<'_>, b: Component<'_>) -> bool {
    a.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn component_eq(a: Component<'_>, b: Component<'_>) -> bool {
    a.as_os_str() == b.as_os_str()
}

/// 相对路径 → 绝对路径（不碰盘；只做词法拼装 + 组件级包含复核）。
pub fn resolve_relative(root: &Path, raw: &str) -> LauncherResult<PathBuf> {
    let normalized = normalize_relative(raw)?;
    let joined = normalized
        .split('/')
        .fold(root.to_path_buf(), |acc, segment| acc.join(segment));
    if !path_has_prefix(root, &joined) {
        return Err(escape(
            "拼装后的路径逃出了根目录",
            format!("root={} target={}", root.display(), joined.display()),
        ));
    }
    Ok(joined)
}

/// 单点 reparse point 闸（叶子存在时查）。
pub fn assert_not_reparse(path: &Path) -> LauncherResult<()> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        // 不存在 = 无话可说（新建落点由调用方自己保证父目录干净）
        Err(_) => return Ok(()),
    };
    if is_reparse(&meta) {
        return Err(escape(
            "路径是符号链接 / junction，拒绝穿越",
            path.display().to_string(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// 从 `root` 到 `target` 的**每一段已存在组件**都不得是 reparse point（含 `root` 自己）。
///
/// 逐段而不是只看叶子：`game\link\to\evil.exe` 里的 `link` 才是逃逸点。
pub fn assert_no_reparse_between(root: &Path, target: &Path) -> LauncherResult<()> {
    assert_not_reparse(root)?;
    let rel = match target.strip_prefix(root) {
        Ok(rel) => rel,
        Err(_) => {
            return Err(escape(
                "目标不在根目录内",
                format!("root={} target={}", root.display(), target.display()),
            ))
        }
    };
    let mut current = root.to_path_buf();
    for part in rel.components() {
        current.push(part);
        if !current.exists() {
            // 后续段尚不存在：上面已查过的祖先就是全部可能被替换的位置
            break;
        }
        assert_not_reparse(&current)?;
    }
    Ok(())
}

/// 规范化 + "仍以根为前缀"的合取判据（用于已存在的目录/文件）。
pub fn assert_inside_existing(root: &Path, target: &Path) -> LauncherResult<()> {
    let root_real = std::fs::canonicalize(root).map_err(|e| {
        LauncherErrorDto::new(ErrorCode::PathEscape, "根目录不可解析")
            .detail(format!("{}：{e}", root.display()))
    })?;
    let target_real = std::fs::canonicalize(target).map_err(|e| {
        LauncherErrorDto::new(ErrorCode::PathEscape, "目标路径不可解析")
            .detail(format!("{}：{e}", target.display()))
    })?;
    if !path_has_prefix(&root_real, &target_real) {
        return Err(escape(
            "规范化后目标逃出了根目录",
            format!(
                "root={} target={}",
                root_real.display(),
                target_real.display()
            ),
        ));
    }
    Ok(())
}

/// `<appData>/launcher` 下的全部落点。
#[derive(Clone, Debug)]
pub struct LauncherLayout {
    root: PathBuf,
}

impl LauncherLayout {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            root: app_data_dir.join(LAUNCHER_DIR),
        }
    }

    /// 启动器根（`<appData>/launcher`）：诊断与日志用，业务一律走具体落点函数。
    #[allow(dead_code)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 根目录骨架（`launcher/`、`instances/`、`runtime/`、`project-staging/`）。
    pub fn ensure_root(&self) -> LauncherResult<()> {
        for dir in [
            self.root.clone(),
            self.instances_dir(),
            self.runtime_dir(),
            self.project_staging_root(),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| super::error::io_failure("创建启动器目录", &dir, &e))?;
        }
        Ok(())
    }

    pub fn registry_file(&self) -> PathBuf {
        self.root.join(REGISTRY_FILE)
    }

    pub fn approvals_file(&self) -> PathBuf {
        self.root.join(APPROVALS_FILE)
    }

    pub fn instances_dir(&self) -> PathBuf {
        self.root.join(INSTANCES_DIR)
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.root.join(RUNTIME_DIR)
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    /// 插件项目解包暂存的根：`launcher/project-staging/`（只有宿主往里拼，命令不接受落点）。
    pub fn project_staging_root(&self) -> PathBuf {
        self.root.join(PROJECT_STAGING_DIR)
    }

    /// 一次插件项目解包的暂存目录：`project-staging/{id}/`（id 先过单段名字闸）。
    pub fn project_staging_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        if !valid_component(id) {
            return Err(escape("暂存 id 形状非法", format!("id={id}")));
        }
        Ok(self.project_staging_root().join(id))
    }

    /// 实例根。**id 必须先过形状闸**——这是"用户输入不参与拼路径"的唯一执行点。
    pub fn instance_root(&self, id: &str) -> LauncherResult<PathBuf> {
        if !valid_instance_id(id) {
            return Err(escape("实例 id 形状非法", format!("id={id}")));
        }
        Ok(self.instances_dir().join(id))
    }

    pub fn manifest_file(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(INSTANCE_MANIFEST))
    }

    pub fn game_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(GAME_SUBDIR))
    }

    pub fn logs_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(LOGS_SUBDIR))
    }

    pub fn backups_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(BACKUPS_SUBDIR))
    }

    pub fn staging_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(STAGING_SUBDIR))
    }

    /// 一次预检的暂存目录（内容包 / 存档导入共用）：`staging/{planId}/`。
    pub fn staging_plan_dir(&self, id: &str, plan_id: &str) -> LauncherResult<PathBuf> {
        if !valid_component(plan_id) {
            return Err(escape("计划 id 形状非法", format!("planId={plan_id}")));
        }
        Ok(self.staging_dir(id)?.join(plan_id))
    }

    /// 内容包安装区根：`content/`。目录名即包 id（**先过形状闸**）。
    pub fn content_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(CONTENT_SUBDIR))
    }

    pub fn pack_dir(&self, id: &str, pack_id: &str) -> LauncherResult<PathBuf> {
        if !valid_component(pack_id) {
            return Err(escape("包 id 形状非法", format!("packId={pack_id}")));
        }
        Ok(self.content_dir(id)?.join(pack_id))
    }

    pub fn pack_payload_dir(&self, id: &str, pack_id: &str) -> LauncherResult<PathBuf> {
        Ok(self.pack_dir(id, pack_id)?.join(PAYLOAD_SUBDIR))
    }

    /// `backups/packs/{packId}/`：`original/` 与每次操作的 `{timestamp}/` 都在这里。
    pub fn pack_backups_dir(&self, id: &str, pack_id: &str) -> LauncherResult<PathBuf> {
        if !valid_component(pack_id) {
            return Err(escape("包 id 形状非法", format!("packId={pack_id}")));
        }
        Ok(self
            .backups_dir(id)?
            .join(PACK_BACKUPS_SUBDIR)
            .join(pack_id))
    }

    /// `backups/saves/`：存档备份的唯一落点（**只在实例根内**）。
    pub fn save_backups_dir(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.backups_dir(id)?.join(SAVE_BACKUPS_SUBDIR))
    }

    pub fn lock_file(&self, id: &str) -> LauncherResult<PathBuf> {
        Ok(self.instance_root(id)?.join(LOCK_FILE))
    }

    /// 实例目录骨架（`logs/` `backups/` `staging/`；`game/` 只由 copy 流程建）。
    pub fn ensure_instance_dirs(&self, id: &str) -> LauncherResult<PathBuf> {
        let root = self.instance_root(id)?;
        for dir in [
            root.clone(),
            self.logs_dir(id)?,
            self.backups_dir(id)?,
            self.staging_dir(id)?,
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| super::error::io_failure("创建实例目录", &dir, &e))?;
        }
        Ok(root)
    }

    /// 实例的"游戏根"：`shared` = 用户批准的源根；`copy` = 实例内 `game/`。
    ///
    /// `overlay` 是 P2，宿主按 `shared` 的形态回答（不假装支持合并视图），调用方必须
    /// 在看 `isolation` 的地方自己拒——本函数只回答"路径在哪"。
    pub fn game_root(
        &self,
        id: &str,
        isolation: &str,
        source_root: Option<&str>,
    ) -> LauncherResult<PathBuf> {
        if isolation == "copy" {
            return self.game_dir(id);
        }
        let source = source_root.ok_or_else(|| {
            LauncherErrorDto::new(ErrorCode::InstanceNotReady, "实例缺少游戏根")
                .detail(format!("instance={id} isolation={isolation}"))
        })?;
        let path = PathBuf::from(source);
        if !path.is_absolute() {
            return Err(escape(
                "实例的游戏根不是绝对路径",
                format!("sourceRoot={source}"),
            ));
        }
        Ok(path)
    }
}
