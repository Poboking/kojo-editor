# 桌面壳端到端冒烟清单（tauri dev · 真实 IPC）

> 用途：验证 **Rust 双闸**在真实 IPC 下的表现——这是沙箱会话跑不出的部分（曾遇 `BeforeDevCommand`
> 经宿主 shell 管道耗尽 `os error 231`）。**每批发布前人工过一遍**；能自动化的部分已固化为
> `tools/smoke-tauri-ipc.mjs`（CDP 进 WebView 直调真实 `invoke`，非伪造）。
>
> 命令原文（本机 2026-10 实测）：
> - 自动探针：`node tools/smoke-tauri-ipc.mjs "<本机真实 eraTW 根目录>"`
>   —— **语料路径按主机而定**（本机 `C:\game\eratw-…`，QA 机 `<本机目录>\eratw\eratw-…`）；
>   不给参数或给了不存在的目录，探针现在**一开头就退出码 2 报错**，不会跑到一半才莫名失败。
> - 进程/DOM 冒烟：`node tools/smoke-tauri-dom.mjs 130`
> - 手工：`pnpm --filter @kojo/app tauri dev`（或 `pnpm tauri dev`）
>
> **DOM 口径（2026-10-13 随 UI 重设计更正）**：已经没有 `.project-header` / `.proj-dir` / `.proj-stats`。
> 项目根读**工具栏左侧 `.tb-project` 的 `title`**（可见文字是项目名，不是路径）；
> 索引水位读**状态栏 `.sb-idx`**（索引中显示「索引构建中…」，完成是「N 文件 · M 函数」）；
> 「关闭项目」在**工具栏右区 `.toolbar`**。探针曾因为拿旧选择器断言而整轮红——
> 那是**探针过期**，不是产品回归，别再照着它找 bug。

## 0. 前置

- [ ] 游戏目录存在：`<本机目录>\eratw\eratw-4.980基线语料`
- [ ] `%APPDATA%\dev.kojo.editor\store\_global\` 下无该游戏目录的批准记录（否则 a2 不弹窗）
- [ ] 端口 1420 / 9222 空闲（上一轮 tauri dev 已退出）
- [ ] 已 `pnpm install`；`cargo` 增量可编译（首次 build 已完成）

## 1. 自动探针（覆盖 a–e，推荐先跑）

```bash
node tools/smoke-tauri-ipc.mjs
# 退出码 0 = 全 PASS
```

探针做的事（均为**真实 IPC**，走 app 同一条 `__TAURI_INTERNALS__` 通道）：

| 步骤 | 动作 | 断言 |
|---|---|---|
| a | 欢迎页点「最近打开」中的游戏目录 | 项目头 rootDir = 游戏目录 |
| a2 | 首次弹出「写权限确认」→ 点「允许写入」 | 弹窗关闭 |
| b | 展开文件树 → 点 ERB → Monaco 插入标记 → 保存 | 磁盘含标记 **且** `{appData}/backup/**` 新增 `.bak` |
| c | `invoke('write_file_bytes', {path:'C:\Windows\Temp\…'})` | 抛错且文案含「可写范围拒绝」 |
| e | `invoke('app_data_dir')` → 写该目录 | 成功且可读回 |
| d | 点「关闭项目」→ 再写游戏目录文件 | 抛错且文案含「可写范围拒绝」 |

探针会自动还原：store（recent + approved-writable）、被测文件原字节、本次新增的 `.bak` 与临时文件。

## 2. 手工清单（勾选项 + 预期结果）

### a. 打开真实游戏目录
- [ ] 欢迎页点「最近打开」的游戏目录（或「选择 eraTW 游戏目录」→ 原生选目录框选它）
- **预期**：进入项目视图；header `rootDir` = 游戏目录；stats ≈ `角色 168 / 文件 2285 / 函数 99104`；首次弹「写权限确认」（点「允许写入」后下次自动放行）

### b. 域内写正常（编辑 ERB + 保存 → 落盘 + 备份）
- **前置（不是缺陷，别看错）**：这一条要求目标游戏目录已在 `{appData}\approved_roots.txt` 里（= 曾用系统文件夹对话框/拖放交付给过宿主）。不在册时 a/a2/b0/b1 会全过、保存却恒被拒成「不在可写范围内」——那是写允许域双闸在 fail-close（PITFALLS §143 / §160）。机器冒烟把这条打在 `[b1-diag] store 前置` 的 `gameDirAdmitted` 上；人工核对请换到在册目录，或在真界面里用「选择 eraTW 游戏目录」重新交付一次。
- [ ] 左侧「口上文件」→ 点任一角色组头展开 → 任点一个 `.ERB`（工具条「展开全部」按钮已撤，改点组头）
- **预期**：编辑器加载，状态栏显示 `<encoding> · <EOL> · N 行`
- [ ] 改动内容 → Ctrl+S（或点「保存 (Ctrl+S)」）
- **预期**：脏点消失、状态栏「已保存 HH:MM:SS」；磁盘文件已更新；`{appData}\backup\<sanitized>-<hash>\` 下新增 `<时间戳>.bak`

### c. 域外写被拒（第二道闸）
- [ ] 在 devtools console 执行：
  ```js
  await window.__TAURI_INTERNALS__.invoke('write_file_bytes',
    { path: 'C:\\Windows\\Temp\\kojo-smoke-outside.txt', data: btoa('evil') })
  ```
- **预期**：**抛错**，文案含「可写范围拒绝（write）：… 不在可写范围内（允许 = 项目根目录 / appDataDir）」

### d. 关闭项目后再写游戏目录 → 被拒
- [ ] 点「关闭项目」→ 回到欢迎页
- [ ] console 调 `invoke('write_file_bytes', { path: '<游戏目录>\\_probe.txt', data: btoa('x') })`
- **预期**：抛错含「可写范围拒绝」；此时 `project_root` 已清（回到仅 appDataDir）

### e. appDataDir 写正常（配置/备份链路不受影响）
- [ ] console：`const d = await invoke('app_data_dir')` → 再 `invoke('ensure_dir',{path:d+'\\_probe'})`、`write_file_bytes` 写入
- **预期**：均成功（appDataDir 常驻允许）

### f.（可选）第一道闸：kernel writablePaths 子集
- [ ] 项目打开时，console 写**项目根内但不在 writablePaths** 的文件（如 `<根>\CSV\_probe.csv`）
- **预期**：被 **kernel io** 拒绝（`WriteNotAllowedError`）——即便 Rust 允许域放行（项目根整体），更严的 kernel 白名单仍拦下（双闸以更严者为准）

## 3. 本批实测结论（2026-10-10 · 第十七批）

环境：Trae 终端（PowerShell 7）· Node 24.14 · pnpm 11.22 · cargo/rustc 1.99 · `pnpm tauri dev` 可跑（**os error 231 未复现**）
探针：`node tools/smoke-tauri-ipc.mjs`（最终一次干净运行，退出码 0）

| 项 | 结论 | 现象记录 |
|---|---|---|
| a 打开真实游戏目录 | **PASS** | rootDir = `<本机目录>\eratw\…<基线语料>`；stats `角色 168 / 文件 2285 / 函数 99104` |
| a2 写权限确认弹窗 | **PASS** | 首次弹窗 → 点「允许写入」→ 关闭，批准持久化（下次自动放行；探针结束时还原 store） |
| b 域内写正常 | **PASS** | 改 `…\個人口上\001 Reimu [霊夢]\of_new_kojo_api_TEST.ERB` → 落盘含 marker ✓；备份新增 1 个 `.bak`（`{appData}\backup\of_new_kojo_api_TEST.ERB-dafcdd60\…bak`）；原字节已还原 |
| c 域外写被拒 | **PASS** | `C:\Windows\Temp\kojo-smoke-outside.txt` → 抛「写允许域拒绝（write）：… 不在允许域内」 |
| d 关项目后写游戏目录被拒 | **PASS** | 关闭后写 `<游戏目录>\_kojo_smoke_after_close.txt` → 同样抛「可写范围拒绝」 |
| e appDataDir 写正常 | **PASS** | `appData_dir` → `ensure_dir` + `write_file_bytes` 成功并可读回 |
| f 第一道闸（kernel 子集） | 未跑 | 需 devtools 直取 kernel 句柄；kernel io 单测已覆盖，留人工抽验 |

**结论：Rust 双闸在真实 IPC 下表现符合设计——域内（项目根 + appDataDir）放行、域外明确拒绝（fail-closed、文案清晰）、关闭项目后回到仅 appDataDir。C7/M3 的端到端验证欠账已还。**

### 已知抖动（非缺陷）
- **首轮冷启动**：若 vite 触发 `Re-optimizing dependencies because lockfile has changed`，页面会在项目打开后被 HMR 重载 → 回欢迎页（表现为探针 `.proj-stats` 一度为空）。跑第二次即稳定。探针已加端口预检 + 180s 等待缓解。
- 上一轮 `tauri dev` 进程未完全退出时会占 1420/9222 → 探针加 `waitPortsFree` 预检；手工时先确认端口空闲。

## 4. 安全不变量（改动前默念）

- 允许域 = **项目根整体（含游戏目录）+ appDataDir**；其余一律拒绝，**不静默、fail-closed**。
- 双闸并存：kernel `writablePaths`（用户批准子集，第一道）+ Rust 允许域（第二道），**以更严者为准**。
- 注册/清除随 `project.opened` / `project.closed`（`App.tsx`，`isTauri()` 守卫内）；注册失败 fail-closed + 显式报错。
- 读路径不受限（只读浏览永远可用）。