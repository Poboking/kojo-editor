import type { Kernel } from '@kojo/kernel';
import type { ErbIndexState, ErbParserService } from '@kojo/plugin-api';
import { MODEL_TOKEN_CLASS } from '@kojo/plugin-api';
import { kojoReferencesViaSlot, listKojoSourceTexts } from './kojo-source-scan';
import { nameLedgerIndexCopy } from './index-state-copy';
import {
  erbOccurrences,
  findNameTokenPositions,
  mergeOccurrences,
  occurrencesFromLocations,
  type ReferenceOccurrence,
} from './reference-utils';

/**
 * 「这个名字在全项目出现在哪」的**宿主取数腿**（W8 XLANG-RENAME 接线批）——
 * F2 改名与搜索面板「全部替换」读的是**同一份**出现点台账，不是两份近似实现。
 *
 * ## 为什么要有这一份
 *
 * `ui/search-replace-exec.ts` 的 `nameLedger` 是 W8 交付好的**判据入口**：替换收尾时它把
 * 「检索范围外还有 N 处同名记号」说出来，两个写通道（F2 / 全部替换）从此互不知情这件事
 * 才不可能复发。入口在，**供数的人不在**（宿主没接）⇒ 跨语言腿只看得到已开标签，
 * 未打开的 `.kojo` 源里那些记号永远不会被点名。本模块就是补上的那条供数腿。
 *
 * ## 两条腿，零新判据
 *
 * - `.erb` 侧：`erb.parser` 服务的 `referencesTo`（反向索引 `bySymbol` 的唯一出口，
 *   与 rename 逐字同一个调用），经 `erbOccurrences` 进台账（`kind` 原样带，不抹平）。
 * - `.kojo` 侧：`ui/kojo-source-scan` 的**同一对**取数——`listKojoSourceTexts`（全项目糖源，
 *   含未开标签；枚举/读文失败一律抛）+ `kojoReferencesViaSlot`（探针交糖线判读，
 *   转译器当判官，本模块零语法知识）。判读回来的位置经 `occurrencesFromLocations`
 *   补 `endColumn`（= 列 + 名字长度，与反向索引同一条派生纪律）。
 * - 两份表进 `mergeOccurrences`（按位置去重、同位取最具体分类），出口形状就是
 *   `ReferenceOccurrence[]`——`search-replace-exec` 只看 `filePath`，别的字段一概不许它自己再算。
 *
 * ## 判据缺席时**说话**，不装哑
 *
 * 台账缺席时"范围外 0 处"是谎话（看不见 ≠ 没有），所以这里**抛**：执行器那侧已有
 * `引用判据核对失败（不影响本次替换结果）` 这条可见回执，替换照落、差额照说。
 * 与 rename 的区别只在后果——那边判据缺席必须整批拒绝（写一半 = 下次保存被糖源冲掉），
 * 这边是只读回执，没有可破坏的东西。
 * 「名字根本不在索引里」则是另一件事：判据答"没有这个名字的出现点"⇒ 空数组，
 * 不去翻糖源（一次全项目 walkDir 不该花在一个没有名字可核对的检索词上）。
 */

/** 整串是记号才算一个"名字"（正则检索词 / 带空格的短语不是：那些没有引用口径可谈） */
const NAME_TOKEN_RE = new RegExp(`^${MODEL_TOKEN_CLASS}+$`, 'u');

/** 归一化检索词 → 可核对的名字；`null` = 这个词不是一个记号，判据无话可说 */
function normalizedNameOf(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed === '' || !NAME_TOKEN_RE.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/** `.erb` 侧台账（`referencesTo` 唯一出口）；判据缺席 ⇒ 抛（不装成"没有出现点"） */
function erbSide(kernel: Kernel, normalizedName: string): readonly ReferenceOccurrence[] {
  const parser = kernel.services.tryGet<ErbParserService>('erb.parser');
  if (!parser?.referencesTo || !parser.currentIndex) {
    throw new Error('ERB 引用判据缺席（erb.parser 未提供 referencesTo），无法核对同名记号');
  }
  // 索引这一轮的**可查事实**（ST-CONSUMERS）：原来这一格只会说"未建（仍在构建）"，
  // 于是"一个可扫的位置都没走到"与"扫了什么都没有"都被说成"稍后再试"——作者会一直等。
  // 现在按 phase 查表（判据单源 `erb-parser/index-state.ts`，表见 `ui/index-state-copy.ts`）；
  // 提供方没交事实（旧实现）⇒ 逐字退回原句。
  if (!parser.currentIndex()) {
    let indexState: ErbIndexState | null = null;
    try {
      indexState = parser.indexState?.() ?? null;
    } catch {
      indexState = null; // 事实面自己抛错 ⇒ 退回旧读数（台账这一腿不该因文案层失联）
    }
    throw new Error(`${nameLedgerIndexCopy(indexState)}，无法核对同名记号`);
  }
  return erbOccurrences(parser.referencesTo(normalizedName) ?? []);
}

/**
 * `.kojo` 侧台账：全项目糖源里有同名记号的那几份，逐份交糖线判读，只收**可证明**的引用点。
 * 枚举/读文/判读任一失败都原样上抛（抛错 ≠ 判官答"这些记号不是引用"，后者是正常空集）。
 */
async function kojoSide(kernel: Kernel, normalizedName: string): Promise<readonly ReferenceOccurrence[]> {
  const sources = await listKojoSourceTexts(kernel);
  const out: ReferenceOccurrence[] = [];
  for (const file of sources) {
    const positions = findNameTokenPositions(file.text, normalizedName);
    if (positions.length === 0) continue; // 这份源里没有同名记号 ⇒ 与本判据无关
    const first = positions[0]!;
    const locations = kojoReferencesViaSlot(kernel.slots.query('ui.editor.languageService'), kernel, {
      filePath: file.filePath,
      text: file.text,
      line: first.line,
      column: first.column,
    });
    // 糖的引用面是文件局部的（规范 §7.2）：越界一律不收，不猜
    out.push(...occurrencesFromLocations(
      locations.filter((location) => location.filePath === file.filePath),
      normalizedName.length,
    ));
  }
  return out;
}

/**
 * 装配一份**随 kernel 生命周期**的名字台账（宿主接线点：`ProjectView` 装替换执行器时注入）。
 * 返回的函数每次现取索引与槽表（项目开闭 / 插件退场都要能被下一次替换看见）。
 */
export function createProjectNameLedger(
  kernel: Kernel,
): (query: string) => Promise<readonly ReferenceOccurrence[]> {
  return async (query: string) => {
    const normalizedName = normalizedNameOf(query);
    if (normalizedName === null) return [];
    const erb = erbSide(kernel, normalizedName);
    if (erb.length === 0) return [];
    return mergeOccurrences([erb, await kojoSide(kernel, normalizedName)]);
  };
}
