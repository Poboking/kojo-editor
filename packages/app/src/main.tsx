import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { NotificationCenter } from './ui/NotificationCenter';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// 不用 StrictMode：内核 bootstrap 有副作用（建立 IPC / 存储域），开发模式双调用会重复初始化
// 通知中心在入口层装配：App 自身也是消费者（打开失败 / 授权失败必须可见，否则故障静默）
createRoot(container).render(
  <NotificationCenter>
    <App />
  </NotificationCenter>,
);
