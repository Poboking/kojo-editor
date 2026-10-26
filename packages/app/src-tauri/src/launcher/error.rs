//! 启动器的结构化错误（`LauncherErrorDto`）。
//!
//! 三条口径（`docs/LAUNCHER-ARCHITECTURE.md` §5.6 / §7.1）：
//! - **码是契约字面量**：本枚举只抄 §5.6 里宿主这一批命令真会用到的那些，一个自造同义词都
//!   不许有（`LauncherErrorCode` 在 `plugin-api/src/launcher.ts` 是同一份清单）；
//! - **`message` 是中文人话**，不把 OS 英文错误串直接透传（详情进 `detail`，UI 可折叠）；
//! - **`retryable` 恒有**：契约里它不是可选字段（`LauncherError.retryable: boolean`），
//!   这里只给宿主侧默认值，消费方可以覆盖，UI 只按它决定是否给「重试」按钮。

use serde::Serialize;

/// 宿主会用到的错误码。字面量逐字对齐 §5.6，**不得新增契约里没有的码**。
///
/// L3a 只点亮其中一部分；L3b（内容包 / 存档）会用到剩下的几个（归档、任务冲突等），
/// 因此整份留着——新增码必须先在 `plugin-api` 的 `LauncherErrorCode` 里出现。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InstanceNotFound,
    InstanceBusy,
    InstanceNotReady,
    TrustRequired,
    TrustChanged,
    ExecutableInvalid,
    RuntimeMissing,
    SourceNotApproved,
    PathEscape,
    ArchiveInvalid,
    TaskBusy,
    TaskCancelled,
    SchemaUnsupported,
    PlatformUnsupported,
    Internal,
}

impl ErrorCode {
    /// 契约字面量（`LAUNCHER_*`）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InstanceNotFound => "LAUNCHER_INSTANCE_NOT_FOUND",
            Self::InstanceBusy => "LAUNCHER_INSTANCE_BUSY",
            Self::InstanceNotReady => "LAUNCHER_INSTANCE_NOT_READY",
            Self::TrustRequired => "LAUNCHER_TRUST_REQUIRED",
            Self::TrustChanged => "LAUNCHER_TRUST_CHANGED",
            Self::ExecutableInvalid => "LAUNCHER_EXECUTABLE_INVALID",
            Self::RuntimeMissing => "LAUNCHER_RUNTIME_MISSING",
            Self::SourceNotApproved => "LAUNCHER_SOURCE_NOT_APPROVED",
            Self::PathEscape => "LAUNCHER_PATH_ESCAPE",
            Self::ArchiveInvalid => "LAUNCHER_ARCHIVE_INVALID",
            Self::TaskBusy => "LAUNCHER_TASK_BUSY",
            Self::TaskCancelled => "LAUNCHER_TASK_CANCELLED",
            Self::SchemaUnsupported => "LAUNCHER_SCHEMA_UNSUPPORTED",
            Self::PlatformUnsupported => "LAUNCHER_PLATFORM_UNSUPPORTED",
            Self::Internal => "LAUNCHER_INTERNAL",
        }
    }

    /// 宿主侧默认的「可重试」判定：用户能自己再走一遍的才给重试。
    ///
    /// 例：`INSTANCE_BUSY`（等它停）、`TRUST_REQUIRED` / `TRUST_CHANGED`（重新确认）、
    /// `SOURCE_NOT_APPROVED`（重新授权）、`RUNTIME_MISSING`（补运行时）；
    /// `PATH_ESCAPE` / `EXECUTABLE_INVALID` / `SCHEMA_UNSUPPORTED` 重试没有意义。
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::InstanceBusy
                | Self::TaskBusy
                | Self::TrustRequired
                | Self::TrustChanged
                | Self::SourceNotApproved
                | Self::RuntimeMissing
        )
    }
}

/// 宿主 → 前端（与 `LauncherError` 同形）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherErrorDto {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub retryable: bool,
}

impl LauncherErrorDto {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.as_str().to_string(),
            message: message.into(),
            detail: None,
            retryable: code.retryable(),
        }
    }

    /// 排障细节（路径、退出码、条目名）。**只进 `detail`**，不进 `message`。
    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let text = detail.into();
        if !text.is_empty() {
            self.detail = Some(text);
        }
        self
    }

    /// 显式覆盖可重试判定（少数码在具体上下文里要翻面）。
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }
}

pub type LauncherResult<T> = Result<T, LauncherErrorDto>;

/// 内部错（读失败 / 解析失败 / 线程池失败…）：一律 `LAUNCHER_INTERNAL` + 细节。
pub fn internal(message: impl Into<String>) -> LauncherErrorDto {
    LauncherErrorDto::new(ErrorCode::Internal, message)
}

/// 写盘 / 读盘失败的统一包装：人话在前面，OS 串进 `detail`。
pub fn io_failure(what: &str, path: &std::path::Path, err: &std::io::Error) -> LauncherErrorDto {
    LauncherErrorDto::new(ErrorCode::Internal, format!("{what}失败"))
        .detail(format!("{}：{err}", path.display()))
}

/// 平台闸：非 Windows 一律 `LAUNCHER_PLATFORM_UNSUPPORTED`，不做 shell 兜底。
pub fn platform_unsupported(what: &str) -> LauncherErrorDto {
    LauncherErrorDto::new(
        ErrorCode::PlatformUnsupported,
        format!("{what}当前平台不支持"),
    )
    .detail("启动进程只做 Windows 实现（Job Object 杀树）；其它平台明确不提供，不做 shell 兜底。")
}
