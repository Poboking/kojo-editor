//! 端点参数级档位绑定真源表（B25 拆出独立文件）。
//!
//! 登记「工具名.参数名」在端点侧的最低会话档位：写腿的路径 / 根标识入参绑 edit，
//! 只读面绑 read。运行时工具级档位由 `protocol::host_required_tier()` 判定、
//! 参数名落点黑名单由 `protocol::is_forbidden_target_key()` 判定；本表是这两者之上的
//! 「逐入参点名」登记真源，判据 `mcp-file-family-gaps.test.ts` 组① 逐条现场对拍，
//! 与 `SUPPLEMENTAL_TOOL_SPECS` 的 required / properties 双向对账，防新入参漏登。
//!
//! B25 批逐枚点名六枚新入参：`fs.copyFile` 的 srcRelPath / relPath / rootId，
//! `fs.ensureDir` 的 relPath / rootId，只读面 `fs.readFileBytes` 的 relPath。
//! 只读面那枚刻意绑 read，绝不因为带 relPath 就被抬进写腿档。

/// 端点参数级档位绑定（`工具名.参数名`）。B25 六枚新入参逐枚在册。
#[allow(dead_code)]
pub const PARAM_TIER_EXACT: &[&str] = &[
    "fs.copyFile.srcRelPath",
    "fs.copyFile.relPath",
    "fs.copyFile.rootId",
    "fs.ensureDir.relPath",
    "fs.ensureDir.rootId",
    "fs.readFileBytes.relPath",
];
