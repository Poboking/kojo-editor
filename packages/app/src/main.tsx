import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { NotificationCenter } from './ui/NotificationCenter';
import { ingestInlineBootMarks } from './perf';
import './styles.css';
// 主题覆盖（2026-10-17 主题系统）：必须在 styles.css 之后引入，`:root[data-theme=…]` 特异性
// 才能压过基础 `:root`。缺省 dark 无对应文件块（基础 :root 即深色），light/mint 各自翻 token。
import './themes/light.css';
import './themes/mint-dark.css';
// PS-18：market.css 不再进首屏——市场面板是项目态，且它对 styles.css 里 `.mk-*` 基础段的
// 9 组「同特异性后来者胜」叠加（mk-row/mk-head/mk-name…，见 styles-split.equivalence.test.ts
// 的冲突审计）只有在**全量样式表之后**到达才成立。它现在随 loadProjectView 的重档链
// （styles-project.css → market.css）进项目时加载，级联相对顺序与拆分前逐字一致。

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

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
