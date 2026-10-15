import type { EditorCodeLens, ErbFunction, ErbReference } from '@kojo/plugin-api';

/**
 * 行上内联注解（B8，2026-10-16 行内注解批）——函数定义行「被谁用到」这一句话的**纯逻辑**。
 *
 * ## 为什么这条判据住在本包（而不是任何 UI 插件）
 *
 * 这句话只用两件事实：缓冲区里有哪些定义（`parseErbText`）、某个名字被谁用到
 * （`index.references` / `referencesOf`）。两件都是**本包私产**，其中反向边的口径
 * （什么算引用、什么不算：注释 / 字符串内容 / `[SKIPSTART]` / `*CALLFORM` 参数）逐条写在
 * 契约 `plugin-api/erb.ts` 的 `ErbReference.kind` 与 `./references.ts` 头注里。
 * 搬到别的插件就得把那套口径抄第二遍，而抄的那份永远不知道原件什么时候改过——
 * 与本包 `erb-definition` / `erb-workspace-symbols` 两枚注册的取舍同一条理由。
 *
 * `referencesTo` 自 H2 批交付以来在测试之外**零消费者**；本批是它的第一个。
 *
 * ## 为什么是「被 N 处用到」这一条信号（逐一对照过既有呈现面：同一状态只在一处显示）
 *
 * | 面 | 答的问题 | 与本批的关系 |
 * |---|---|---|
 * | 悬停（`app/src/monaco/kojo-hover.ts`） | 光标下这个**记号**的中文名是什么 | 正向词义，零重叠 |
 * | 转到定义 / Peek（D4，`kojo-definition.ts`） | 这个名字**定义在哪** | **正向**边；本批给**反向**边（谁用到了我） |
 * | 文档大纲 B3 / 折叠 D3 / 面包屑 D1 | 这篇文档的**结构** | 本批不动结构，只在结构行上补一句话 |
 * | 工作区符号 D2（`ctrl+T` / `Palette.tsx`） | 全项目里**谁叫这个名字** | 名字→定义；本批是 定义→用量 |
 * | 问题面板 / 波浪线（B9） | 这一行**写错了**吗 | 用量不是对错 |
 * | 条件矩阵面板 | 这个函数**在什么条件下会走到** | 已有一处权威呈现，本批刻意不在行上重复 |
 * | 函数树面板（`ui-kojo-navigator`） | 项目里**有哪些函数** | 名录不含用量 |
 *
 * 一句话：**「这一处定义被用了几次」此前哪一面都给不出**。
 */

/* 口径一：**「没人调用」不说**。真实语料 110,123 个唯一定义里 **70,612 个（64.1%）**拿不到任何反向
 * 引用——`*CALLFORM` 的参数、`JUMP`/`GOTO` 目标、CSV 数据驱动的派发都在引用口径之外
 * （契约 `ErbReference.kind` 的「已知排除」）。那不是「没人调用」，是「我证明不了有人调用」；
 * 把后一句写成前一句等于给三分之二的函数扣一顶帽子，而且**每两个函数点一个**——满屏标记
 * 不是信息。⇒ 只在有可证明的东西可说时开口：一条引用都没有 ⇒ 这一行闭嘴。
 * 缺席 =「无话可说」这一个含义必须保住，所以下面那条大数降噪用「换个说法」而不是「闭嘴」。
 *
 * 重名函数同样不计数：反向边按**名字**聚合，两处定义无从分账，给谁都是猜。
 * 实测全库 12 个重名、涉及 71 处定义（占定义 0.06%）⇒ 让开这 0.1% 换「每条注解都可核对」。
 */

/* 口径二：**大数不报精确数**。语料 39,511 个可标注名字的处数分布 P50=1 / P90=1 / P99=31 /
 * P99.9=495 / P99.99=3,003 / max=67,302（`HPH_PRINT`；次位 `FIRSTTIME` 15,174，再 3,326 /
 * 3,003 / 2,983 / 2,839……）。这条尾巴是**引擎级工具函数**与**作者手写口上函数**的分界，
 * 不是连续体的两端：五位数的「被 67302 处用到」对作者没有动作含义（他既改不动也不该改），
 * 但「这条是系统级、满项目都在用」确实是信息。
 * ⇒ 处数严格大于 {@link USAGE_LENS_BIG_COUNT} 就改报 `1000+`。界线取 P99.9（495）的**下一个
 * 数量级** ⇒ 手写函数（99.9% 的名字）一律拿到真数，全库只有 16 个名字（占可标注 0.04%）
 * 进这一档，标签最宽五个数字，不会撑破那一行。
 * 刻意**不消音**：消音会让「这一行没有注解」同时表示「证明不了」与「用得太多了」两件事，
 * 而作者无从分辨——宿主那侧「预算全有或全无」护的是同一条不变量（缺席只许有一个含义）。
 * 这条口径住在**本包**：什么算「系统级」是 ERB 反向索引的事实，宿主 UI 不许认识 `HPH_*`（铁律 1）。
 */

/**
 * 「大数」界线：处数**严格大于**它才改报 `+`（读数与取舍见上一段）。
 * 1,000 = 语料 P99.9（495）的下一个数量级，故作者手写的函数一律拿到精确数。
 */
export const USAGE_LENS_BIG_COUNT = 1000;

/** 计数判据要问的两件事（都只读已建好的项目索引；缺席即不答，见注册注） */
export interface UsageLensSource {
  /** 这个**归一化**名字在项目里有几处定义（`0` = 缓冲区里刚写出来、索引还不认识） */
  definitionsOf(normalizedName: string): number;
  /** 这个**原样**名字的全部出现（含定义行自身；口径见契约 `ErbReference.kind`） */
  referencesOf(normalizedName: string): readonly ErbReference[];
}

/** 一处使用的去重键：同一文件同一行写两遍（`PRINT F, F`）算**一处**——标签说的是「处」 */
const siteKey = (ref: ErbReference): string => `${ref.filePath}\u0000${ref.line}`;

/**
 * 定义列表 → 行上注解（**纯函数**）。
 *
 * 只给「有非定义引用」且「全项目只此一处定义」的名字说话（两条口径见文件头）。
 * 落点取该名字**第一条**可证明的使用处（索引序 = 文件遍历序 → 行 → 列，确定）——
 * 作者是「从这个函数出发去看谁在用它」，第一处就是入口；余下由点击后继续 F12 / 搜索走。
 * 计数在越过 {@link USAGE_LENS_BIG_COUNT} 后**立即早停**：那里只想知道「过没过界」，
 * 于是最坏一名（`HPH_PRINT` 67,303 个引用点）也只建 1,001 个键，不再为无意义的精确数
 * 走完整张表。
 */
export function usageLenses(functions: readonly ErbFunction[], source: UsageLensSource): EditorCodeLens[] {
  const out: EditorCodeLens[] = [];
  for (const fn of functions) {
    // 只有一处定义才谈得上「这一处被用了几次」
    if (source.definitionsOf(fn.normalizedName) !== 1) continue;
    let count = 0;
    let first: ErbReference | undefined;
    const seen = new Set<string>();
    for (const ref of source.referencesOf(fn.name)) {
      if (ref.kind === 'definition') continue;
      const key = siteKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
      first ??= ref;
      if (count > USAGE_LENS_BIG_COUNT) break; // 只要知道过没过界
    }
    if (!first) continue; // 只有定义行自身 = 证明不了有人用它 ⇒ 闭嘴
    out.push({
      line: fn.startLine,
      label: count > USAGE_LENS_BIG_COUNT ? `被 ${USAGE_LENS_BIG_COUNT}+ 处用到` : `被 ${count} 处用到`,
      target: { filePath: first.filePath, line: first.line, column: first.column },
    });
  }
  return out.sort((a, b) => a.line - b.line);
}