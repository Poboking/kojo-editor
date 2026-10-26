import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { NotificationCenter } from './ui/NotificationCenter';
import { ingestInlineBootMarks } from './perf';
import { installFrontendErrorLog } from './frontend-log';
// 设计 token 单源（视觉批十一 L01）：必须排在一切样式引入之前——styles.css / styles-project.css
// 与 themes/*.css 全部经 var() 取它，裸 :root 已从两份副本删除（E 闸钉死，见
// styles-split.equivalence.test.ts）。
import './tokens.css';
// 右键面：教程面（1023 覆盖面批 · WP4.8）。模块加载即登记到面注册表，不需要任何
// 生命周期协作；教程正文由插件渲染，宿主只能按 DOM 标记认代码块 / 目录条目（见该模块头注）。
import './ui/tutorial-context-menu';
import './styles.css';
// ui-kit 基座（批次十一 L14）：`KitField/KitCheck/KitSelect/KitSegmented/KitIconButton/
// KitKbd/KitCount/KitEmpty/KitSkeleton` 的样式真源。排在 styles.css 之后、各域切片
// （problem-panel.css / search-panel.css …）之前——kit 是底座，域切片要能后压它。
// L14 交付时在 `ui-kit.css` 头注里写了"由 main.tsx 加载"却没真加这行，集成时补上并
// 用 `deadcss` 口径复扫（只认 import 语句，注释里提到文件名不算接线）。
import './ui-kit/ui-kit.css';
// 主题覆盖（2026-10-17 主题系统）：必须在 tokens.css 之后引入，`:root[data-theme=…]` 特异性
// 才能压过基础 `:root`。缺省 dark 无对应文件块（tokens.css 的基础 :root 即深色），light/mint 各自翻 token。
import './themes/light.css';
import './themes/mint-dark.css';
// 底部「问题」面板（批次十一 L03）：与 `search-panel.css` 同族的一套 `.prob-*` 规则。
// 面板根类 `.prob` + 双类选择器提特异性，故它与"谁先到"无关——放链尾只为让新面板的
// 覆盖意图读起来明确（`styles-project.css` 里遗留的单类 `.prob-*` 已在同批删净）。
import './problem-panel.css';
// 视觉批十一 L16 切片：标签栏溢出 affordance（滚动箭头/▾工具族）`tabs-bar.css` 与
// 文件树缩进导轨 `file-tree.css`。两条都只声明 styles-project.css 里没有的新类/新属性
// （无同属性对撞），在级联里的位次不改变任何既有终值；`css-slices-wired` 钉死本行存在。
import './tabs-bar.css';
import './file-tree.css';
// 视觉批十一 R5 壳层呈现切片（通知让位 / toast 文案密度 / 状态栏次组 / light·mint 遮罩）：
// 排在 themes/*.css 之后——与主题同分的选择器要后置才赢；压过懒档 styles-project.css 靠自身特异性。
import './shell-notices.css';
// 教程浮层的宿主侧 override（视觉批十一 R4 · 按 L19 记号从 dev-note.css 搬成独立切片）：
// 行内芯片补档 / 代码井凹槽与"还有内容"边 / 目录条目静息只显标题。欢迎页（轻档）与
// 项目态（重档）都吃得到，所以必须留在**静态链**、且排在 themes/*.css 之后
// （与 light 档那枚同特异性的井身反相内衬赢平靠位次，判据见切片文件头）。
import './tutorial-surface.css';
// 编辑器动效切片（1026 阅读面批 C1/C4/C5）：只含 `.monaco-*` / 滚动条选择器，不归两份样式表的
// 「轻档 ⊆ 重档」三闸管（理由与三条纪律见该文件头注）。
import './motion-editor.css';
// 动效收口切片（1026 动效批）：toast 退场 / 标签脏点与保存微光 / 效果库接线 / 合成层提示。
// 每条规则都靠复合选择器（`html:root` / 双类）压过既有面，不靠位次。
import './motion-exit.css';
// 壳层布局动效（B1–B5）：侧栏 / 底部区开合、视图交叉淡入、编辑器组入场、zen 换场。
// 本片只声明 transition/animation 这类 `styles-project.css` **没有写过的属性**（见文件头纪律 ②），
// 所以位次不改变任何既有终值。
import './motion-layout.css';
// 动效视觉切片（D4）：主题切换的圆形揭示（View Transition + clip-path）。
// 它服务的是换主题这一下，两个相位（欢迎 / 项目）都可能发生，所以不能进项目态懒档。
// 必须压在四个动效切片的最后一位：`::view-transition-*` 只认最后一套同名声明。
import './motion-visual.css';
// PS-18：market.css 不再进首屏——市场面板是项目态，且它对 styles.css 里 `.mk-*` 基础段的
// 9 组「同特异性后来者胜」叠加（mk-row/mk-head/mk-name…，见 styles-split.equivalence.test.ts
// 的冲突审计）只有在**全量样式表之后**到达才成立。它现在随 loadProjectView 的重档链
// （styles-project.css → market.css）进项目时加载，级联相对顺序与拆分前逐字一致。

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// 前端兜底错误落盘（P0-3）最先装：此后任何模块（含 React 渲染链）的未捕获错误 /
// 未处理 rejection 都会经 append_frontend_log 写进 appData/kojo-logs/。console 原生
// 行为不动；浏览器开发壳自动跳过发送（见 frontend-log.ts 头注）。
installFrontendErrorLog();

// L1-0 引导标记收编（首屏批）：htmlParsed / firstPaint 已由 index.html 内联脚本落在
// performance 时间轴上，这里趁最早一处应用代码把它们折进 __kojoPerf（另两枚在
// App 内核就绪与 EditorPane 挂载处现场记；口径见 perf.ts 的 bootMark）。
ingestInlineBootMarks();

// 调试模式（2026-10-24 调试模式批）：页面带 `?kojo-debug` 时装载 `window.__kojoDebug`
// 调试面（命令注册表 / 内核 / 事件旁听 / 编辑器受控读写 / DOM 结构快照）。
// 刻意动态 import 且只在选入时装载——开机图闸（ps10-eager-graph）零影响；
// 不带参数的桌面壳与普通浏览器页永远不执行调试面代码。
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('kojo-debug')) {
  void import('./debug/install-debug')
    .then((m) => m.installDebug())
    .catch((err: unknown) => {
      console.error('[kojo-debug] 调试面装载失败：', err);
    });
}

// 不用 StrictMode：内核 bootstrap 有副作用（建立 IPC / 存储域），开发模式双调用会重复初始化
// 通知中心在入口层装配：App 自身也是消费者（打开失败 / 授权失败必须可见，否则故障静默）
createRoot(container).render(
  <NotificationCenter>
    <App />
  </NotificationCenter>,
);

// 字体档位的冷启动播种（批十二 L20 生效链的最后一格，2026-10-24 组长真壳复验补）：
// 写侧（设置页改档）当场应用早已接好，但**重启后**只有一条路径会把存的档位落到根元素——
// Monaco 创建时经过 `editorDisplayFontPatch()`。欢迎页没有编辑器 ⇒ 作者选的界面/代码字体在首屏
// 不生效（实测：reload 停在欢迎页时根元素两个内联变量都是空的、body 仍是系统栈；进项目才恢复）。
// 为什么走动态 import（同 PS-18 把 market.css 挪出首屏同一把尺）：静态引 `editor-display-prefs`
// 会把它的依赖子树（editor-options → word-separators / layout-pref / find-pref）一起拽进开机图，
// 实测 209 文件/3066 KB → 215/3151 KB，`ps10-eager-graph` 当场红 ⇒ 首屏为此多背 85 KB 不值。
// 代价是欢迎页可能有一帧用系统栈、种子到位后换面——默认档根本不写内联变量（`applyFontStackCssPrefs`
// 按"等于内置栈即 removeProperty"），没动过字体项的作者一帧都不闪。
void import('./ui/editor-display-prefs')
  .then((m) => m.applyFontStackCssPrefs())
  .catch(() => {
    // 播种失败 = 首屏沿用内置栈；这条链的失败不该惊动用户（写侧与编辑器 create 仍会各自应用）
  });
