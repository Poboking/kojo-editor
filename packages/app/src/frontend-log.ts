/**
 * 前端兜底错误落盘（P0-3 ③）：`window` 的 `error` / `unhandledrejection` 捕获后经
 * Rust 命令 `append_frontend_log` 追加写入宿主日志目录（appData/kojo-logs/frontend-*.log）。
 *
 * 口径：
 * - **console 原生行为保留**：只监听、不 preventDefault——WebView / 浏览器的原生报错
 *   照旧上屏（开发态第一取证面不被动）；
 * - **发送失败自吞**（console.warn 留痕）：兜底通道自己绝不能再抛出未处理 rejection，
 *   否则就是"错误日志器触发错误日志"的死循环；
 * - **纯浏览器壳跳过发送**（无 `__TAURI_INTERNALS__`）：console 本身就是开发态取证面，
 *   不为它反复弹"IPC 不可用"警告；
 * - 事件字段**防御式读取**：error 事件在真实壳是 ErrorEvent，但注入 / 测试 / 某些浏览器
 *   场景可能是裸 Event——有 message 用 message，没有就退化到 error 对象，再没有就报
 *   事件类型本身，绝不为"形状不对"丢掉一次取证。
 */
import { invoke, isTauri } from './bridge/invoke';

export type FrontendErrorLevel = 'error' | 'unhandledrejection';

export interface FrontendErrorRecord {
  level: FrontendErrorLevel;
  message: string;
  detail?: string;
}

/** 任意 rejection reason → 可读文本（Error 提取 name/message；其它值 JSON 化，失败退 String） */
export function serializeReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === 'string') return reason;
  if (reason == null) return String(reason);
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

/** 任意 error 事件的载荷 → stack 文本（Error 才有；其它形态返回 undefined） */
function stackOf(error: unknown): string | undefined {
  return error instanceof Error && error.stack ? error.stack : undefined;
}

/** `window` `error` 事件 → 记录。返回 null = 事件里一点可用的文本都没有（极罕见）。 */
export function recordFromErrorEvent(ev: unknown): FrontendErrorRecord | null {
  const e = ev as { message?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown; error?: unknown };
  const message =
    typeof e.message === 'string' && e.message.trim()
      ? e.message.trim()
      : e.error instanceof Error
        ? `${e.error.name}: ${e.error.message}`
        : typeof e.error === 'string' && e.error.trim()
          ? e.error.trim()
          : undefined;
  if (!message) return null;
  const where =
    typeof e.filename === 'string' && e.filename
      ? ` (${e.filename}:${typeof e.lineno === 'number' ? e.lineno : 0}:${typeof e.colno === 'number' ? e.colno : 0})`
      : '';
  const detail = stackOf(e.error);
  return detail
    ? { level: 'error', message: `${message}${where}`, detail }
    : { level: 'error', message: `${message}${where}` };
}

/** `unhandledrejection` 事件 → 记录（reason 任意形态都给一条文本）。 */
export function recordFromRejectionEvent(ev: unknown): FrontendErrorRecord {
  const reason = (ev as { reason?: unknown }).reason;
  const message = serializeReason(reason) || '(空 reason)';
  const detail = stackOf(reason);
  return detail ? { level: 'unhandledrejection', message, detail } : { level: 'unhandledrejection', message };
}

/** 生产发送器：走 `append_frontend_log`（Rust 侧纯 IO 原语，落点写死 appData 日志目录） */
async function sendRecord(rec: FrontendErrorRecord): Promise<void> {
  if (!isTauri()) return; // 浏览器壳：console 即取证面，不发明知会失败的 IPC
  await invoke('append_frontend_log', {
    level: rec.level,
    message: rec.message,
    detail: rec.detail ?? null,
  });
}

export type FrontendLogSender = (rec: FrontendErrorRecord) => Promise<void>;

/** 已装配标志：HMR / 重复装配不再多挂（多挂 = 同一错误写两份日志） */
let installed = false;

/**
 * 装配兜底捕获。返回卸载函数（测试用；生产装一次不卸）。
 * `send` 可注入（测试 mock IPC）；缺省走真实 IPC。
 */
export function installFrontendErrorLog(send: FrontendLogSender = sendRecord): () => void {
  const noop = () => undefined;
  if (typeof window === 'undefined') return noop; // 非 window 环境（SSR / 纯 node）：无事可装
  if (installed) return noop; // 幂等
  installed = true;

  const dispatch = (rec: FrontendErrorRecord | null) => {
    if (!rec) return;
    // 发送失败必须自吞：这是兜底通道，它自己再抛就是 unhandledrejection 死循环
    Promise.resolve(send(rec)).catch((err: unknown) => {
      console.warn('[前端错误落盘] 发送失败，仅 console 留痕：', err);
    });
  };
  const onError = (ev: unknown) => dispatch(recordFromErrorEvent(ev));
  const onRejection = (ev: unknown) => dispatch(recordFromRejectionEvent(ev));

  window.addEventListener('error', onError as EventListener);
  window.addEventListener('unhandledrejection', onRejection as EventListener);
  return () => {
    installed = false;
    window.removeEventListener('error', onError as EventListener);
    window.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}