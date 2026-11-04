//! 更新完成后的**立即重启**（UPD-B · 给 UpdateDialog `done` 态的「立即重启」按钮一条真通道）。
//!
//! 背景：`UpdateDialog` 的 done 态早已留好可选 `onRestart` prop（没传就不画按钮、
//! 只提示手动重启），代码注释里登记着「当前宿主尚无重启命令」的待办——本模块就是那条线：
//! 一条最小命令 `updater_relaunch`，JS 侧包装 `appRelaunch()` 接进 `ShellLayout` 的弹窗渲染。
//!
//! 设计取舍：
//! - **不用 tauri-plugin-process**：那插件带的 `restart` / `exit` / `relaunch` 是一整套
//!   permission 面，而本仓 Rust 宿主只做 IO 原语、依赖极简——核心自带的
//!   `AppHandle::restart` 一行就够，不为此新增一个编译单元（插件 crate）。
//!   （API 已对版本核实：tauri 2.12.2，`src/app.rs:606` `pub fn restart(&self) -> !`，
//!   底层落 `tauri::process::restart(&self.env())`（`src/process.rs:74`：spawn 自身
//!   带原参数 + `exit(0)`）；`tauri.conf.json` 是 v2 口径，Cargo.lock 钉 2.12.2。）
//! - **返回类型 `-> !`（永不返回）属预期**：重启成功 = 进程被替换，JS 侧 invoke
//!   不必等它 resolve（包装层 fire-and-forget + 静默吞错，见 `update-relaunch.ts`）。
//!   真要失败也不经由这条命令上报——`process::restart` spawn 失败会打日志后 `exit(0)`，
//!   应用仍然退出，用户按提示手动重开即可，不会出现"按了没反应还假活着"的中间态。
//! - **Windows NSIS 口径**：passive 安装通常在安装时就把旧进程带走，done 态一闪而过
//!   甚至看不见——「立即重启」按钮就是给**装完进程还在**的平台（macOS/Linux）与场景
//!   （安装器行为变化 / 用户动作快过安装器）兜底的，不是主路径。
//! - 不涉写盘、不碰 writablePaths / capability（invoke_handler 里注册的自定义命令
//!   不需要额外 capability，见 capabilities/default.json 注释）。

/// 重启应用：`done` 态「立即重启」按钮的落点。永不返回（进程被替换）。
#[tauri::command]
pub fn updater_relaunch(app: tauri::AppHandle) {
    app.restart();
}
