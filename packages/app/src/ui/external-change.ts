/**
 * 外部写盘后的「model 重载决策」纯逻辑（2026-10-12 审阅补丁，修 B1）。
 *
 * 背景：💡 升糖等**经服务写盘**的操作会在成功路径上发内核事件 `file.changed`
 * （谁改盘谁发，见 events.ts / kojo-sugar 事件纪律）。此时编辑器里对应的 model
 * 仍是旧内容——若不重载，用户随后 `Ctrl+S` 会用旧文本**覆盖**磁盘上的新内容
 * （真实数据丢失）。宿主据此事件重载 model。
 *
 * 决策必须**区分「model 有无未保存修改」**，否则会引入反向数据丢失：
 * - `noop`：磁盘内容与 model 相同（多为自身保存的「回声」）→ 不做任何事，
 *   避免无谓重置撤销栈与光标；
 * - `reload`：磁盘变了、model **干净** → 静默重载（可安全用磁盘内容替换）；
 * - `conflict`：磁盘变了、model **脏** → **绝不静默覆盖**：重载会丢用户的
 *   未保存修改，不重载则用户保存会覆盖磁盘——两条路都有损，只能交给用户选。
 *
 * 抽成纯函数以便单测（React 组件内的分支不便在无 DOM 环境覆盖）。
 */
import { isPathUnder } from '@kojo/plugin-api';

export type ExternalChangeDecision = 'noop' | 'reload' | 'conflict';

/**
 * @param modelText 当前编辑器 model 的文本
 * @param diskText  重新从磁盘读到的文本
 * @param dirty     model 是否有未保存修改（相对已保存基线）
 */
export function decideExternalChange(
  modelText: string,
  diskText: string,
  dirty: boolean,
): ExternalChangeDecision {
  if (modelText === diskText) return 'noop';
  return dirty ? 'conflict' : 'reload';
}

/**
 * 外部改动是否影响**口上文件树**的目录列举（HK-5，2026-10-13；接 §5.87 留下的欠账）。
 *
 * 监视根是「项目根 ∪ 口上域」（见 `App.tsx` 的 `fileWatch.start`），也就是游戏运行时
 * 写存档、写图片缓存同样会投递 `file.changed`。而文件树只列举口上域里的目录，
 * 所以这里必须先做一条**零 IO 的路径分野**——否则每一次外部写入都要重列一遍树，
 * 而绝大多数写入跟树上显示的东西根本无关（§5.87 立的"首动作零 IO"纪律，这次由我自己执行）。
 */
export function affectsKojoTree(path: string, kojoPaths: readonly string[]): boolean {
  return kojoPaths.some((root) => isPathUnder(root, path));
}

/**
 * 事件合批（HK-5）：一次外部写入常常炸出多条事件（原子写的临时文件 + rename、
 * 游戏连写几份档、备份落一份）。树不需要逐条响应——**尾缘一个窗口内重列一次**即可。
 *
 * 窗口从**首条**事件起算、且**不随后续事件重置**：这是 §5.84 在内核去抖器上实测过的坑
 * （重置版在持续写入流里永远等不到落地）。这里同理：一直写 ≠ 一直不刷新。
 */
export interface EventCoalescer {
  push(): void;
  dispose(): void;
}

export function createEventCoalescer(fire: () => void, windowMs: number): EventCoalescer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(): void {
      if (timer !== null) return; // 已在窗口内排上了：不重复排、也不重置
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, windowMs);
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}