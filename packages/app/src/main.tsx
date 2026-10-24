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

// 不用 StrictMode：内核 bootstrap 有副作用（建立 IPC / 存储域），开发模式双调用会重复初始化
// 通知中心在入口层装配：App 自身也是消费者（打开失败 / 授权失败必须可见，否则故障静默）
createRoot(container).render(
  <NotificationCenter>
    <App />
  </NotificationCenter>,
);
