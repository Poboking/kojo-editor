import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { NotificationCenter } from './ui/NotificationCenter';
import { ingestInlineBootMarks } from './perf';
import './styles.css';

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
