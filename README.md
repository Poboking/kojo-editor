<div align="center">
  <img src="docs/assets/logo.png" alt="kojo-editor" width="128">

# kojo-editor

**简体中文** | [English](README_EN.md) | [日本語](README_JA.md)

![License](https://img.shields.io/badge/license-GPL--3.0--or--later-263146?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows-0078d6?style=flat-square)
![Built with](https://img.shields.io/badge/Tauri_2_·_React_19_·_Monaco-24C8DB?style=flat-square)
![Latest Release](https://img.shields.io/github/v/release/Poboking/kojo-editor?style=flat-square)
![Downloads](https://img.shields.io/github/downloads/Poboking/kojo-editor/total?style=flat-square)
![CI](https://github.com/Poboking/kojo-editor/actions/workflows/ci.yml/badge.svg)

> 给口上作者的编辑器。  
> 几千份口上文件、几万个函数，不用再「记事本 + 全文搜索」——  
> 浏览、校验、试写、回放，一站完成。

![kojo-editor 主界面：左侧口上文件树与函数树，右侧 .kojo 编辑视图，底部是教程与语法全表入口](docs/assets/app-editor.jpg)

</div>

---

## 为什么做这个

era 系游戏（eraTW 等）的口上生态已经积累了非常可观的规模：两千多份口上文件、  
九万多个函数。但作者手里的工具，至今还是原始。

于是这些事每天都在发生：

- 函数名写错一个字母，**整段口上静默失效**——游戏里没人说话，也不报错；
- 想知道「这句台词什么时候触发」，只能全文搜索，在几十个同名函数里翻；
- 改一行台词要「开游戏 → 玩到对应状态 → 肉眼验收」，深层条件得刷十几分钟；
- 文件编码五花八门，一存盘，乱码就来了。

kojo-editor 想把这一切变成「打开就知道、改完就确认」。

## 它能做什么

**🗂 结构化浏览**  
打开游戏目录，口上文件按角色归类，函数按「角色 → 家族 → 面」成树展开，  
条件徽章一眼可见，点击直达。九万多个函数，索引只要几秒。

**🧭 条件矩阵**  
把全项目的「状态 / 时机 × 事件 / 面」铺成一张矩阵，格子里直接标出命中的函数数量。  
想知道某个角色在某个时机有哪些口上、哪些条件，点一格就到对应函数。  
支持中日对照、未归属分档与虚拟滚动，十万级函数也不卡。

![条件矩阵：按角色与状态/时机铺开，点击格子直达对应口上函数](docs/assets/app-condition-matrix.jpg)

**✅ 写错即报**  
函数名拼错、家族缺件、格式不符——「约定校验」面板把问题列成清单，  
点一条直接跳到出问题的那一行。错误不再静默。  
全项目一键校验、按角色/家族聚合修法、未定义 `CALL` 与结构未闭合提示都已接入。

**✍️ 用「.kojo 语言」写口上**  
一门为口上设计的中文书写语言：`如果 好感度 ≤ 5：` 这样的语感，  
保存时自动编译成游戏原样读取的脚本文件——原编码、原换行，一字不乱地保持。  
控制流（如果 / 选择 / 循环 / 跳转）、数据表、随机块、选项、演出、别名与插值都有中文写法；  
不想改写的部分照旧手写原文件，两种方式可以混用。

**📖 语法全表（附录）**  
每一种 `.kojo` 写法的取值、编译产物、写错时的提示，都收在一张对照表里。  
教程浮层内可跳转查阅，不用在文档与编辑器之间来回切。

![语法全表附录：写法、必填、取值、编译成什么、写错时的提示一一对照](docs/assets/app-syntax-reference.jpg)

**⌨️ 补全像 VS Code 一样自然**  
ERB 指令、变量族、`#DIM` 声明名、用户函数、`$标签` 与 `.kojo` 原生区都有补全；  
停手即弹、延迟可调，台词 / 旁白 / 注释行不打扰。查找引用、跳转定义、重命名、  
行内实参提示、签名帮助、面包屑与折叠也已覆盖。

**▶ 状态回放 / 💉 状态注入**  
选一份存档、一个角色，每条触发条件的真假、分支走向直接铺开，不用开游戏刷状态。  
需要特定数值时写入**测试存档**——两步确认、自动备份、回读验证，  
真实存档和游戏本体永远只读。

**🛒 口上市场**  
在应用内浏览、安装、更新口上包与字典包，可按包名或作者过滤；  
发布向导支持工作区直接发布与普通 ZIP 口上包导入，上传前本地预校验，  
成功后会生成市场审核单，作者无需再操作 GitHub。

![口上市场：浏览注册表、安装口上包与字典包、发布自己的作品](docs/assets/app-market.jpg)

**🛡 数据安全与稳定性**  
保存走可写范围与原子写；外部改动支持三方合并，脏文件不会被静默覆盖；  
操作级撤销、回收站与批操作回滚常驻。自动保存、崩溃恢复、  
多根工作区、标签栏与分屏让长任务不容易丢进度。

## 安装

**Windows 10 / 11（x64）**，从 [Releases](https://github.com/Poboking/kojo-editor/releases/latest) 下载：

- **安装版**：`kojo-editor_0.4.1_x64-setup.exe`，双击安装；  
  安装后可在「设置 → 更新」中一键检查并安装后续版本。
- **绿色版**：`kojo-editor_0.4.1_x64-portable.zip`，解压即用，不写注册表、不建开始菜单；  
  更新时重新下载新版压缩包即可（系统需具备 WebView2 运行时，Windows 11 自带）。

首次启动：选择游戏目录 → 工具自动识别并索引 → 完成。  
不批准写权限也完全可用（浏览、校验、回放都是只读的）。

## 开发

```bash
pnpm install
pnpm test               # 全量测试（功能池 + 计时池，7700+ 通过）
pnpm typecheck          # 类型检查（root + app 双跑）
pnpm audit:decoupling   # 「一切皆插件」解耦审计
pnpm --filter @kojo/app tauri dev   # 桌面壳开发（首次编译约 20-30 分钟）
```

架构采用**一切皆插件**的设计：内核零游戏知识，扩展新游戏 = 新增一个适配器插件。  
设计细节见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，  
协作与贡献流程见 [AGENTS.md](AGENTS.md)。

## 路线

| 版本            | 内容                                             | 状态     |
| ------------- | ---------------------------------------------- | ------ |
| v0.4.0-beta.1 | 保存闭环 · 文件监视 · 自动更新 · 设置页 · 打包分发              | ✅      |
| v0.4.1        | 口上市场 · 条件矩阵 · 语法全表 · 补全增强 · 性能与稳定性             | ✅      |
| v0.4.2-beta.1 | eraAkumaMaid 适配 · tree-sitter 语法层 · 编辑器体感批 · ERB 语言服务 · 检索/补全增强 · 分屏与导航 | 🧪 预发布（当前） |
| 后续            | 继续打磨 `.kojo` 语言面、市场生态与大规模项目性能                 | 🚧     |

## 反馈

遇到问题或有想提的功能，欢迎[提交 Issue](https://github.com/Poboking/kojo-editor/issues)。

开发者：[**Poboking**](https://github.com/Poboking)  
<a href="https://github.com/Poboking"><img src="https://github.com/Poboking.png" width="24" alt="Poboking" style="border-radius: 50%"></a>

## 许可

[GPL-3.0-or-later](LICENSE)（内核与工具代码）。

仓库不内置任何游戏内容——截图与测试所需的口上文件均来自本机已安装的游戏。  
感谢 eraTW 及整个 era 社区多年来的创作积累。
