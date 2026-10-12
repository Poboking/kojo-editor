/**
 * 派生缓存的项目体量指纹（2026-10-12「体感丝滑」批）。
 *
 * ## 为什么存在
 * 开项目级联有三段：ERB 索引（已按文件 mtime 增量复扫）→ 条件抽取（真实语料实测
 * **11.3 s**）→ 约定校验（实测 **3.1 s**）。后两段是**整项目粒度**的纯函数：输入 =
 * 项目内全部 ERB 的内容 + 插件自身的语义版本。"文件一个字节都没变"时产出必然相同，
 * 因此可以整块落盘、下次直接复用——而它们此前每次都全量重跑，正是用户等的那十秒。
 *
 * ## 三条纪律
 * - **保守失效**：任一文件的 mtime 或 size 不可得 ⇒ 返回 `null`（= 调用方不缓存、
 *   不命中）。宁可慢，不拿不确定的判据换命中；
 * - **顺序无关**：先按路径排序再哈希，`walkDir` 的遍历顺序变化不改变指纹；
 * - **判据强度**：53 位非加密哈希（14 位十六进制）。规模量级 = 数千文件 × 数十次重开，
 *   生日碰撞概率可忽略；各插件另叠自己的**语义版本 salt**，改代码不会因指纹相同而误命中。
 *
 * ## 已知边界（诚实记录）
 * 判据是 `(路径, mtime, 字节数)`，**不读内容**。因此"mtime 与 size 同时不变的正文改动"
 * 检不出来（手工编辑几乎不可能同时满足这两条）。这与索引快照的失效判据同源同风险，
 * 要收紧就一起收紧（升级为内容哈希 ⇒ 代价是全盘读，正与"不用再等"的目标相违）。
 */

/** 单个文件的体量信息（来自 `FileIO.stat`，与索引快照同源口径） */
export interface FileStamp {
  readonly path: string;
  /** null = 平台未提供或 stat 失败 ⇒ 整个指纹不可信 */
  readonly mtimeMs: number | null;
  /** null 同上 */
  readonly size: number | null;
}

/**
 * 派生缓存的三重命中判据：**项目根 + 适配器 + 体量指纹**。
 *
 * 三者都一致才允许复用：项目根防串项目；适配器防语义标签（`variableSchema` 提供的
 * `schema` 描述）跟着别的游戏走；指纹防"文件动过而结果没重算"。
 * 各插件的快照存储键是**固定常量**（快照本体自带这三项，不匹配即弃用），
 * 因此指纹变化是覆盖旧快照而不是累积垃圾文件。
 */
export interface CacheExpect {
  readonly projectRoot: string;
  readonly adapterId: string;
  readonly fingerprint: string;
}

/**
 * cyrb53：53 位字符串哈希（JS 位运算只有 32 位，故用两个 32 位通道拼出 53 位）。
 * 非加密用途，只为"输入变没变"判据。
 */
function cyrb53(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * 计算项目体量指纹。
 *
 * @returns 14 位十六进制串；任一文件缺 mtime/size 时返回 `null`（调用方据此跳过缓存）
 */
export function projectFingerprintOf(stamps: Iterable<FileStamp>): string | null {
  const rows: string[] = [];
  for (const s of stamps) {
    if (s.mtimeMs === null || s.mtimeMs === undefined) return null;
    if (s.size === null || s.size === undefined) return null;
    // `\u0000` 作分隔：路径里不可能出现它，数字段也不会含它 ⇒ 拼接无歧义
    rows.push(`${s.path}\u0000${s.mtimeMs}\u0000${s.size}`);
  }
  rows.sort();
  return cyrb53(rows.join('\u0001'));
}
