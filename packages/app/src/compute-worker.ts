/**
 * 并行计算 worker 入口（2026-10-12「内核优化」批）。
 *
 * 只做一件事：收发消息 + 交给公共包里的协议处理器。**协议与任务表都不在这里定义**
 * （分别住 `@kojo/plugin-api` 与 `./compute-tasks`），避免两侧漂移。
 *
 * 铁律：本文件不得引入任何宿主 UI（React / Monaco / 内核 io）——它跑在独立线程里。
 */
import { handleComputeRequest } from '@kojo/plugin-api';
import { computeTasks } from './compute-tasks';

/** worker 全局（模块 worker）的最小面——用结构化类型，避免 DOM `Window` 重载干扰 */
const workerScope = self as unknown as {
  addEventListener(type: 'message', handler: (ev: { data: unknown }) => void): void;
  postMessage(data: unknown): void;
};

workerScope.addEventListener('message', (ev) => {
  void handleComputeRequest(computeTasks, ev.data).then((res) => workerScope.postMessage(res));
});
