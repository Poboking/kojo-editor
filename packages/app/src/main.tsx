import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// 不用 StrictMode：内核 bootstrap 有副作用（建立 IPC / 存储域），开发模式双调用会重复初始化
createRoot(container).render(<App />);
