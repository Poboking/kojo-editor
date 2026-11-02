<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="120">

# kojo-editor

**简体中文** | [English](README_EN.md) | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

**era 系游戏口上脚本（`.ERB` / `.kojo`）编辑器。**  
找得到函数、看得懂别人的口上、写错当场提醒、改完一键进游戏。Windows 10 / 11。

</div>

<div align="center">
  <img src="docs/assets/erb-definition.gif" width="760" alt="跳转定义">
  <br><sub>光标停在调用处按 <code>F12</code>，跳进<b>另一份文件</b>里的定义</sub>
</div>

## 功能

- **按结构找口上**：角色 → 家族 → 面 → 函数一棵树逛完，不必记 `M_KOJO_K12_MESSAGE_COM_310` 这种全名。
- **看得懂别人的 `.ERB`**：把 `IF` / `PRINTFORMW` 就地显示成「如果 …：」和一行行台词。**只改显示，文件一个字节都不动**。
- **IDE 的动作都有**：跳转定义、查引用、改名（跨文件一起改）、悬停看作者注释、参数提示、按符号跳转。
- **写错当场说**：函数名拼错、家族不完整、分支漏了兜底，红线标在行上，点一条跳过去。
- **自己的作品单独管**：写在你自己的口上项目里，一键**导出** zip 发给别人，或**部署**进游戏目录。
- **改完不用开游戏反复试**：状态回放按现有存档算给你「这句会不会说」；状态注入器把变量改成目标状态再验。

## 演示

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/erb-references.gif" width="420" alt="查找引用"></td>
    <td valign="middle"><b>查找引用</b> <code>Shift+F12</code><br>改一个角色之前，先看清调用点散在哪几份文件里。</td>
  </tr>
</table>

<table>
  <tr>
    <td valign="middle"><b>补全</b> <code>Ctrl+Space</code> / 输入即弹<br>台词、注释、字符串里不弹——只在你真需要候选的位置出现。</td>
    <td width="46%" align="center"><img src="docs/assets/erb-completion.gif" width="420" alt="补全"></td>
  </tr>
</table>

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/editor-folding.gif" width="420" alt="折叠"></td>
    <td valign="middle"><b>折叠</b><br>按函数体和区块收起来。一份上万行的口上，能折叠才读得下去。</td>
  </tr>
</table>

<table>
  <tr>
    <td valign="middle"><b>命令面板</b> <code>Ctrl+Shift+P</code><br>界面上能做的事这里都搜得到，键位也能在这儿改。</td>
    <td width="46%" align="center"><img src="docs/assets/editor-palette.gif" width="420" alt="命令面板"></td>
  </tr>
</table>

<table>
  <tr>
    <td width="46%" align="center"><img src="docs/assets/editor-search.gif" width="420" alt="全工程检索"></td>
    <td valign="middle"><b>全工程检索</b><br>只记得一句台词或一个片段时用它，命中按文件分组。</td>
  </tr>
</table>

## 界面

<table>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-editor.jpg" width="480" alt="主界面"><br><sub><b>主界面</b></sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-condition-matrix.jpg" width="480" alt="条件矩阵"><br><sub><b>条件矩阵</b> —— 点已填色的格子跳到对应口上</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="docs/assets/app-syntax-reference.jpg" width="480" alt="语法全表"><br><sub><b>语法全表</b> —— 怎么写、编译成什么、写错提示什么</sub></td>
    <td width="50%" align="center"><img src="docs/assets/app-market.jpg" width="480" alt="口上市场"><br><sub><b>口上市场</b> —— 安装别人发布的口上包</sub></td>
  </tr>
</table>

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

## 许可证

[GPL-3.0-or-later](LICENSE)。仓库不含任何游戏内容：README 里的动图与截图都来自合成样本，
测试用的真实语料只在本机已安装、由使用者自行授权的目录里被只读访问。

感谢 eraTW 与整个 era 社区这些年的创作积累。

作者：[**Poboking**](https://github.com/Poboking) · 问题与建议欢迎开 [Issue](https://github.com/Poboking/kojo-editor/issues)
