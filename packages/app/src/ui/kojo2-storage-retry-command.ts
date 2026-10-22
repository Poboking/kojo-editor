/**
 * K2-STORAGE-RECYCLED-UI：回收槽位阻断的**命令表出口**（`ShellCommandSpec`）。
 *
 * 主入口是回收阻断通知上的动作按钮（`NotificationCenter` 原生支持 action，见
 * `kojo2-storage-service.ts` 的 `surface(problems, action)`）；本命令是给「toast 已被
 * 手快关掉 / 作者从命令面板找路」留的**同一条动作的第二入口**，不是第二套通知系统。
 *
 * 三条只关心「没有可做的事」的分支在这里给一句人话；成功 / 失败的上屏仍由服务自己的
 * 既有失败面负责（失败会写 `kojo2:storage` 问题簇 + 一条 error toast，成功会清簇 + 一条
 * info toast），本模块不重复弹。
 */
import type { ShellCommandSpec } from './commands';
import type {
  Kojo2StorageRetryResult,
  Kojo2StorageService,
} from './kojo2-storage-service';

export const KOJO2_STORAGE_RETRY_COMMAND_ID = 'kojo2.storage.retry-recycled';
export const KOJO2_STORAGE_RETRY_COMMAND_TITLE = 'Kojo 2.0：放行回收槽位并重试落账';
export const KOJO2_STORAGE_RETRY_COMMAND_CATEGORY = 'Kojo 2.0';

export interface Kojo2StorageRetryCommandDeps {
  /** 只取重试这一格：命令不该顺带拿到打开/关闭的能力 */
  readonly service: Pick<Kojo2StorageService, 'retryWithRecycledAllowed'>;
  /** 人话通道（只在「没有可做的事」时用；成功/失败由服务自己上屏） */
  readonly notify: (notice: { readonly kind: 'info'; readonly message: string }) => void;
}

/**
 * 命令的真实执行体（导出以便测试直接 await；`ShellCommandSpec.run` 是同步签名）。
 * **永不抛**：服务自己兜异常，这里只兜病态端口。
 */
export async function runKojo2StorageRetryCommand(
  deps: Kojo2StorageRetryCommandDeps,
): Promise<Kojo2StorageRetryResult | null> {
  /** 人话通道本身也可能病态；命令是 UI 入口，绝不把异常抛回命令面板 */
  function say(message: string): void {
    try {
      deps.notify({ kind: 'info', message });
    } catch (error) {
      console.error('[kojo2-storage-retry] 命令回执失败：', error);
    }
  }
  let result: Kojo2StorageRetryResult;
  try {
    result = await deps.service.retryWithRecycledAllowed();
  } catch (error) {
    say(
      `槽位账本重试没有跑起来（账本原样保留）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  switch (result.kind) {
    case 'nothing-to-retry':
      say('当前没有待放行的回收槽位。');
      break;
    case 'disabled':
      say('Kojo 2.0 开关关着：槽位账本未参与本次会话，没有可放行的回收槽位。');
      break;
    case 'busy':
      say('槽位账本正在处理上一次打开/刷新，请等它结束后再试。');
      break;
    case 'nothing-to-refresh':
      say('当前没有已打开的槽位账本可刷新。');
      break;
    default:
      // opened / refreshed / recycled / blocked / skipped：服务已按既有失败面/庆功面上屏
      break;
  }
  return result;
}

/** 命令表条目：id / 标题 / 分类固定，`run` 只点火、不阻塞命令面板 */
export function createKojo2StorageRetryCommand(
  deps: Kojo2StorageRetryCommandDeps,
): ShellCommandSpec {
  return {
    id: KOJO2_STORAGE_RETRY_COMMAND_ID,
    title: KOJO2_STORAGE_RETRY_COMMAND_TITLE,
    category: KOJO2_STORAGE_RETRY_COMMAND_CATEGORY,
    run: () => {
      void runKojo2StorageRetryCommand(deps);
    },
  };
}
