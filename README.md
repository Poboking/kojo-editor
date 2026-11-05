<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

**简体中文** | [English](README_EN.md) | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Built with](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![Downloads](https://img.shields.io/github/downloads/Poboking/kojo-editor/total?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**era 系游戏口上脚本（`.ERB` / `.kojo`）编辑器。**  
找得到函数、看得懂别人的口上、写错当场提醒、改完一键进游戏。Windows 10 / 11。

</div>

<div align="center">
  <img src="docs/assets/erb-definition.gif" width="760" alt="跳转定义">
  <br><sub>光标停在调用处按 <code>F12</code>，跳进<b>另一份文件</b>里的定义</sub>
</div>

## 亮点

- **按结构找口上，不用记全名**。角色 → 家族 → 面 → 函数一棵树逛完，`M_KOJO_K12_MESSAGE_COM_310` 这种名字交给工具去拼。鼠标停在函数上会浮出作者写在函数上方的注释块，比只看大写函数名好认得多。
- **看得懂别人的 `.ERB`**。打开游戏目录里的文件，`IF` / `PRINTFORMW` 就地显示成「如果 …：」和一行行台词，缩进代替 `ENDIF`。**只改显示，文件一个字节都不动**，随时 `Ctrl+Alt+T` 切回原样。
- **IDE 该有的动作都有，而且是跨文件的**。跳转定义 `F12`、速览 `Alt+F12`、跳到实现 `Ctrl+F12`、查找引用 `Shift+F12`（peek 浮窗按文件分组给命中数）、改名 `F2`（调用点一起改）、悬停看注释与形参表、参数提示、`Ctrl+Shift+O` 按符号跳转、同符号高亮与智能扩选。
- **写错当场说，不等到游戏里才发现没生效**。函数名拼错、家族不完整、分支漏了兜底、条件写法可疑，红线标在行上，点一条就跳过去；状态栏常驻计数，`Ctrl+Shift+M` 打开问题面板，`Alt+F8` 逐条走。
- **编码与换行逐字节保持**。按声明编码读取（Shift-JIS / GBK / UTF-8 / UTF-16），写回保持原文件的换行风格与 BOM 形态——改一行不会把整份文件重排，也不会把 Shift-JIS 变成 UTF-8。
- **游戏目录默认只读**。第一次真键入才弹确认，解锁只在这份文件、这次会话有效，重启回到只读；你自己的作品住在独立的口上项目工作区里，始终可写，不受授权影响。
- **自己的作品单独管，写完一键进游戏**。新建项目给你 8 个核心面起手文件与一份中文 README，许可协议可以选 LTOL / CC BY-NC / MIT / BSD-2 / ISC 或不生成。**导出**给你可发布的 zip，**部署**先把落点亮给你确认再写；目标已存在直接报错不覆盖，转译失败整批拒绝，不给你缺文件的半成品包。
- **改完不用开游戏反复试**。状态回放按现有存档算给你「这句会不会说、走哪个分支」；状态注入器把变量改成目标状态写进**测试档**，带二次确认、自动备份、回读验证。
- **想知道「这句什么时候会说」**。条件矩阵把状态键 × 时机面摊成一张表，点已填色的格子直接跳到对应口上函数。
- **能查、能改键、能扩展**。命令面板 100+ 条命令，界面能做的事这里都搜得到，键位也能改；内置 `.kojo` 语言教程与语法全表（怎么写、编译成什么、写错提示什么，逐条对照）；口上市场可拉取注册表安装别人发布的包，逐文件校验 sha256。

## 下载与安装

到 [Releases](https://github.com/Poboking/kojo-editor/releases/latest) 下载：

- **安装版** `kojo-editor_<版本>_x64-setup.exe`：双击按向导装，后续版本在「设置 → 更新」里一键升级。
- **绿色版** `kojo-editor_<版本>_x64-portable.zip`：解压后运行 `kojo-editor.exe`，不写注册表。需要系统装有 WebView2（Windows 11 自带，Windows 10 可能要[先装运行时](https://developer.microsoft.com/microsoft-edge/webview2/)）。

每个 Release 都附 `SHA256SUMS.txt` 可核对。安装包**没有代码签名**，首次运行 Windows 可能弹「已保护你的电脑」，点「更多信息 → 仍要运行」即可。

## 第一次打开

1. 启动后进欢迎页，点「选择游戏目录」，选中你的 eraTW 根目录；
2. 接着会问要不要给写权限——**只想读就点拒绝**，浏览、查错、回放照常可用；
3. 左侧「口上文件」挑一个角色的 `.ERB` 打开，第一次会问要不要开「`.kojo` 预览」；
4. 想写自己的：左侧「我的口上项目」→「＋ 新建」。

完整操作手册（新建项目、导出与部署、许可协议怎么选、状态注入的安全说明）在
[docs/USER-GUIDE.md](docs/USER-GUIDE.md)。

## 从源码运行

```bash
corepack enable
pnpm install
pnpm --filter @kojo/app tauri dev      # 开发运行（首次 cargo 编译约 20–30 分钟）
pnpm --filter @kojo/app tauri build    # 产出安装包
```

需要 Node.js 22、pnpm 11.22.0、Rust stable（MSVC 工具链）。环境矩阵、验证命令、插件与游戏适配器开发、发版流程见 [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md)。

## 常见问题

| 问题 | 回答 |
|---|---|
| 会不会改坏我的游戏目录？ | 游戏目录默认只读，只有你批准的路径可写；写前自动备份，并保持原编码与换行。 |
| 支持哪些游戏？ | 已接 8 款 era 系游戏。eraTW 打磨得最细，eraFL 的口上是 XML 数据文件，其余几款的覆盖度不一。 |
| 和我直接编辑 `.ERB` 冲突吗？ | 不冲突。原生写法照常编辑，中文表层只是可选的读法。 |
| 有 macOS / Linux 版吗？ | 暂时没有，只有 Windows 10 / 11 x64。 |
| 装进游戏没反应？ | 引擎只读 `.ERB`。请用「导出」或「部署」，别直接把源文件拷进游戏目录。 |

## 文档

| 文档 | 给谁看 |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | 口上作者：怎么用（不讲实现，目前中文） |
| [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) | 开发者：环境、验证、插件与适配器、发版 |
| [docs/KOJO-2.0-LANGUAGE-SPEC.md](docs/KOJO-2.0-LANGUAGE-SPEC.md) | `.kojo` 语言规格 |
| [docs/STATE.md](docs/STATE.md) | 测试与性能读数、已知欠账 |
| [AGENTS.md](AGENTS.md) | 给 AI 协作者的规矩与命令 |

## 贡献

欢迎。动手前请先读 [AGENTS.md](AGENTS.md)（铁律与协作纪律），改动前扫一眼
[docs/PITFALLS.md](docs/PITFALLS.md)。想加一款新游戏，看 [docs/DIALECT-AUTHORING.md](docs/DIALECT-AUTHORING.md)。
提 PR 之前先开一个 Issue 说一声，避免白做。

## 截图与演示

动图都从真界面录制，一条命令可重录（方法见 [docs/DEVELOPER-GUIDE.md](docs/DEVELOPER-GUIDE.md) §8）；
演示数据全为合成样本。静止截图摄于 2026-10-20 的界面，面板归位随批次会调整，以应用内实际为准。

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/erb-references.gif" width="420" alt="查找引用"><br><sub><b>查找引用</b> <code>Shift+F12</code> —— 改之前先看调用点散在哪几份文件</sub></td>
    <td width="50%" align="center"><img src="docs/assets/erb-completion.gif" width="420" alt="补全"><br><sub><b>补全</b> —— 台词、注释、字符串里不弹</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/editor-folding.gif" width="420" alt="折叠"><br><sub><b>折叠</b> —— 按函数体与区块收起来</sub></td>
    <td width="50%" align="center"><img src="docs/assets/editor-palette.gif" width="420" alt="命令面板"><br><sub><b>命令面板</b> <code>Ctrl+Shift+P</code> —— 搜命令、改键位</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/editor-search.gif" width="420" alt="全工程检索"><br><sub><b>全工程检索</b> —— 只记得一句台词时用它</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-editor.jpg" width="420" alt="主界面"><br><sub><b>主界面</b></sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-condition-matrix.jpg" width="420" alt="条件矩阵"><br><sub><b>条件矩阵</b> —— 点已填色的格子跳到对应口上</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-syntax-reference.jpg" width="420" alt="语法全表"><br><sub><b>语法全表</b> —— 怎么写、编译成什么、写错提示什么</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-market.jpg" width="420" alt="口上市场"><br><sub><b>口上市场</b> —— 安装别人发布的口上包（图示为合成演示包）</sub></td>
    <td></td>
  </tr>
</table>

## 许可证

[GPL-3.0-or-later](LICENSE)。仓库不含任何游戏内容：README 里的动图与截图都来自合成样本，
测试用的真实语料只在本机已安装、由使用者自行授权的目录里被只读访问。

感谢 eraTW 与整个 era 社区这些年的创作积累。

作者：[**Poboking**](https://github.com/Poboking) · 问题与建议欢迎开 [Issue](https://github.com/Poboking/kojo-editor/issues)
