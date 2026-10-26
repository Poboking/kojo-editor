//! Job Object 封装（**应用退出即收尸**的唯一手段，§8.2 铁律 2/7）。
//!
//! 口径（探针实测，见 `launcher_probe.rs` 文件头）：
//! - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：**句柄计数归零**时整棵树被杀 ⇒ 宿主退出（含被强杀）
//!   时 OS 关掉它名下所有句柄，子进程与孙进程一起消失，不依赖游戏自己退出；
//! - **禁 breakaway**：不设 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` 也不设 `SILENT_BREAKAWAY_OK`
//!   （默认即禁止），子进程不能自己跳出 Job；
//! - `CreateProcessW` 返回后**先 assign 再 resume**（挂起态窗口 ≤10 ms 就够，见 PITFALLS 221）。
//!
//! 非 Windows 一律明确不支持（`LAUNCHER_PLATFORM_UNSUPPORTED`），不做 shell 兜底。

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::sync::Arc;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    use super::super::error::{internal, LauncherResult};

    /// Job 句柄的 RAII 壳。
    ///
    /// `Send + Sync`：句柄本身是内核对象引用（不是线程亲和资源），`stop` 线程与监视线程
    /// 都会用它；**并发 `TerminateJobObject` 是安全的**（幂等，Windows 允许重复终止）。
    pub struct JobHandle(HANDLE);

    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    impl JobHandle {
        /// 建 Job 并设 `KILL_ON_JOB_CLOSE`；**不设**两个 breakaway 标志（默认禁逃逸）。
        pub fn create_kill_on_close() -> LauncherResult<Arc<Self>> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(internal("创建 Job Object 失败")
                        .detail(format!("CreateJobObjectW err={}", GetLastError())));
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
                    return Err(internal("配置 Job Object 失败")
                        .detail(format!("SetInformationJobObject err={err}")));
                }
                Ok(Arc::new(Self(handle)))
            }
        }

        /// 把**挂起态**进程挂进 Job（必须先于 `ResumeThread`）。
        pub fn assign(&self, process: HANDLE) -> LauncherResult<()> {
            let ok = unsafe { AssignProcessToJobObject(self.0, process) };
            if ok == 0 {
                return Err(internal("把进程挂进 Job 失败")
                    .detail(format!("AssignProcessToJobObject err={}", unsafe {
                        GetLastError()
                    })));
            }
            Ok(())
        }

        /// 杀整棵树（`stop` 的唯一动作）；`code` 是树内进程收到的退出码。
        pub fn terminate(&self, code: u32) -> LauncherResult<()> {
            let ok = unsafe { TerminateJobObject(self.0, code) };
            if ok == 0 {
                return Err(internal("结束进程树失败")
                    .detail(format!("TerminateJobObject err={}", unsafe {
                        GetLastError()
                    })));
            }
            Ok(())
        }

        /// Job 里当前挂着的进程数（`stop` 等它归零；`None` = 查询失败）。
        pub fn process_count(&self) -> Option<u32> {
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
                    windows_sys::Win32::System::JobObjects::JobObjectBasicProcessIdList,
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
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            // 关最后一个句柄 = 整棵树被杀（本模块唯一的"忘记停"兜底）
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::sync::Arc;

    use super::super::error::{platform_unsupported, LauncherResult};

    pub struct JobHandle;

    impl JobHandle {
        pub fn create_kill_on_close() -> LauncherResult<Arc<Self>> {
            Err(platform_unsupported("进程托管"))
        }

        pub fn assign(&self, _process: usize) -> LauncherResult<()> {
            Err(platform_unsupported("进程托管"))
        }

        pub fn terminate(&self, _code: u32) -> LauncherResult<()> {
            Err(platform_unsupported("进程托管"))
        }

        pub fn process_count(&self) -> Option<u32> {
            None
        }
    }
}

pub use imp::JobHandle;

/// 杀树时写进进程的退出码（`stop` 的标记；真正"为什么停"由停止标记决定，不看码）。
pub const STOP_EXIT_CODE: u32 = 0x4C41_554E;
