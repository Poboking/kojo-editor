/**
 * 命令面板的**最近使用**账（WS-16：对标 VS Code 的 MRU 置顶）。
 *
 * ## 为什么要它
 *
 * 注册表按「分类 + 标题码点」稳定排序（`commands.filterCommands`），对**第一次**用的人最友好，
 * 对天天用的人却是反的：作者反复执行的那几枚（拆分编辑器 / 关闭组 / 打开最近项目）永远躺在
 * 自己分类的位置上，每次都要重打两三个字。VS Code 的答案是最近使用置顶，本模块就是那一份账。
 *
 * ## 边界（每条都有理由，不是随手画的线）
 *
 * - **只记面板里点过的那几条**：键位直达与工具条按钮的执行腿在 `ShellLayout`（开机图可达），
 *   在这里记账等于把一枚新依赖拽进开机静态图（守门见 `tests/ps10-eager-graph.test.ts`）。
 *   代价说清楚：用键位跑掉的命令不会因为它常用就浮到面板顶上——面板是"想不起来键位的人"用的，
 *   那群人记的正是自己点过的东西。
 * - 存储形态照 `search-store` 的最近检索与 `format-pref.ts` 先例：localStorage 里一条 JSON 数组，
 *   **队首 = 最新**。不新造第二套偏好机制。
 * - 上限 12 条 ≈ 两到三屏（面板一行一条），再多置顶就失去"置顶"的意义；
 *   条数与一条 id 的长度都压在几百字节，不撑存储。
 * - 读不到 / 坏 JSON / 元素不是字符串 ⇒ 空清单（缺省 = 与改动前逐字一致的码点序，绝不猜）。
 * - 写失败静默（隐私模式 / 配额满）：只影响下次开面板，本次会话照常。
 * - **注册表里已经不存在的 id 不改判据**：清单只是"顺序提示"，取顺序时按在场命令求交
 *   （`orderCommandsByMru`），插件卸载后留下的旧条目自然失效，下一次写入时被上限挤掉。
 */

/** 存储键（与 `search-store` 的几枚同族命名：`kojo.` 前缀 + 面 + 用途） */
export const COMMAND_MRU_KEY = 'kojo.palette.commandMru';

/** 置顶清单的条数上限（约两到三屏；再多就不叫置顶） */
export const COMMAND_MRU_LIMIT = 12;

/** 清洗盘上清单：只收非空字符串、去重保序（队首仍是最新） */
export function normalizeCommandMru(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= COMMAND_MRU_LIMIT) break;
  }
  return out;
}

/**
 * 记一次使用：新写入到队首，旧的同 id 条目撤掉（同一条命令恒只占一格，
 * 再点一次只是把它提前——不是往清单里再塞一份）。纯函数，便于单测与批量预演。
 */
export function touchCommandMru(
  mru: readonly string[],
  id: string,
  limit: number = COMMAND_MRU_LIMIT,
): string[] {
  if (typeof id !== 'string' || id.trim() === '') return [...mru];
  const cap = Math.max(1, Math.trunc(limit));
  return [id, ...mru.filter((x) => x !== id)].slice(0, cap);
}

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响面板） */
function mruStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读清单（任何异常 ⇒ 空清单，与"没记过"同形态） */
export function loadCommandMru(): string[] {
  const storage = mruStorage();
  if (storage === null) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(COMMAND_MRU_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeCommandMru(parsed) : [];
  } catch {
    return [];
  }
}

/** 写清单（写不进去不算错：只影响下次开面板） */
export function saveCommandMru(mru: readonly string[]): void {
  const storage = mruStorage();
  if (storage === null) return;
  try {
    storage.setItem(COMMAND_MRU_KEY, JSON.stringify([...mru]));
  } catch {
    /* 隐私模式 / 配额满：清单留在内存里，本次会话照常 */
  }
}

/**
 * 记一次并落盘，返回**落盘后的那份清单**（调用方直接拿它当现算的置顶序，
 * 不必再回读存储——回读读到的是上一条写，不是这一条）。
 */
export function recordCommandUse(id: string): string[] {
  const next = touchCommandMru(loadCommandMru(), id);
  saveCommandMru(next);
  return next;
}
