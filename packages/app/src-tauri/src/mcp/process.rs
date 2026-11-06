//! 宿主进程侧的具名写面档位真源表（B25 拆出独立文件）。
//!
//! 与 `protocol::EDIT_TOOLS_EXACT` / `protocol::MULTIROOT_WRITE_TOOLS` **同批维护**：
//! 任何新增的「命名空间.动词」点号写名，必须同时进这几张表，否则端点
//! `host_required_tier()` 判 `McpTier::Read`、read 会话零批准即可落盘 ⇒ 后门
//! （池级红线：不同批＝造后门）。判据 `mcp-file-family-gaps.test.ts` 组① 逐条现场
//! 对拍，不 cargo。
//!
//! 逐根复验那一路由 `MULTIROOT_WRITE_TOOLS` 承担；本表只登记「具名写面」这一路的
//! 宿主侧口径，由 `protocol::is_edit_tool()` 真实消费（与 `EDIT_TOOLS_EXACT` 互为
//! 镜像，任一表登记即生效）；只读面（如 `fs.readFileBytes`）一律不进本表。

/// 具名 edit 工具（与 `protocol::EDIT_TOOLS_EXACT` 同批、逐字对齐）。
/// 名字刻意用 snake_case 与判据锚点 `host_required_tiers` 一致（端点侧档位真源表口径）。
#[allow(non_upper_case_globals)]
pub const host_required_tiers: &[&str] = &[
    "fileTree.create",
    "fileTree.update",
    "fileTree.applyChangeset",
    "problems.quickFix",
    "tasks.start",
    "tasks.cancel",
    "editor.setValue",
    "editor.type",
    "editor.setCursor",
    "editor.setSelection",
    "editor.revealLine",
    "editor.openDocument",
    "fs.copyFile",
    "fs.ensureDir",
];
