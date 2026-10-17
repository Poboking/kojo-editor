import type { Kernel } from '@kojo/kernel';
import type { EditorLanguageServiceContribution, EditorSymbolLocation } from '@kojo/plugin-api';
import type { KojoReferenceProbe, KojoSourceFile } from '../monaco/erb-rename';
import { isKojoSourcePath } from './reference-utils';
import { workspaceRootsOf } from './workspace-roots';

/**
 * F2 改名跨语言腿的**宿主取数侧**（W8 XLANG-RENAME 接线批，2026-12-28）。
 *
 * `monaco/erb-rename.ts` 把"这些同名记号到底是不是这个函数的引用"判读放在
 * `ui.editor.languageService` 槽（糖线探针法，转译器当判官），把"改哪些文件、
 * 怎么落盘"放在它自己那一侧；中间**缺的就是这两条取数**：
 *
 * 1. `listKojoSourceTexts`：项目里**所有** `.kojo` 源（含未打开标签）。只做后缀枚举
 *    与读文，**零糖语法知识**——本模块不认识 `函数` / `调用` 任何一个词，
 *    也不许在这里判读（判读在糖线，抄第二份就漂，见 `ui/reference-utils.ts` 头注）。
 *    检索根口径与搜索面板**同源**：项目根 ∪ 作者工作区全部根（工作区自 2026-10-14
 *    起是多个根，只搜项目根会把作者自己写的糖源整批漏掉）。
 * 2. `kojoReferencesViaSlot`：把探针交给槽，收回可证明的引用点。
 *
 * ## 为什么失败必须**抛**，不许退成空数组
 *
 * `.kojo` 是源、`.erb` 是产物：只改 `.erb` 半边 ⇒ 下一次保存 `.kojo` 把改名结果
 * 重新生成的产物**盖回去**（数据损坏级）。`erb-rename` 据此把"枚举抛错 / 判读抛错 /
 * 无人应答"都判为**不可证明 ⇒ 整批拒绝**。所以：
 * - 枚举或读文失败 ⇒ 抛（看不见 ≠ 没有引用；`ui/commands.ts` 的 `listSourceFiles`
 *   会吞掉坏根，那条通道在这里**不能用**）；
 * - 供方抛错 ⇒ 原样上抛（抛错 ≠ 判官答"这些记号不是引用"，那必须是正常返回空集）；
 * - 没有任何供方认这个请求 ⇒ 抛（空数组的语义是"认了这份文件、但这些不是引用"）。
 */

/** 枚举失败 / 读文失败（交 `erb-rename` 整批拒绝，不静默少改） */
export class KojoSourceEnumerateError extends Error {}

/** 引用判读缺席（没有供方应答这份 `.kojo` 探针） */
export class KojoReferenceUnansweredError extends Error {}

/**
 * 项目内全部 `.kojo` 源（路径 + 全文）。
 * 逐根一次递归列举、整批一次 `readTexts`（每批一次 IPC，命中会话级文本缓存）。
 */
export async function listKojoSourceTexts(kernel: Kernel): Promise<readonly KojoSourceFile[]> {
  const project = kernel.project.current();
  if (!project) return [];
  const roots = [...new Set([project.rootDir, ...workspaceRootsOf(kernel)])];
  const paths: string[] = [];
  for (const root of roots) {
    if (root === '') continue;
    let entries;
    try {
      entries = await kernel.io.walkDir(root, {
        includeFiles: true,
        includeDirs: false,
        filter: (e) => e.isDirectory || isKojoSourcePath(e.name),
      });
    } catch (e: unknown) {
      throw new KojoSourceEnumerateError(
        `.kojo 源枚举失败（${root}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const e of entries) if (!e.isDirectory && isKojoSourcePath(e.name)) paths.push(e.path);
  }
  if (paths.length === 0) return [];
  let texts;
  try {
    texts = await kernel.io.readTexts(paths);
  } catch (e: unknown) {
    throw new KojoSourceEnumerateError(`.kojo 源批量读失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const out: KojoSourceFile[] = [];
  const unreadable: string[] = [];
  texts.forEach((file, i) => {
    const path = paths[i]!;
    if (!file) unreadable.push(path);
    else out.push({ filePath: path, text: file.text });
  });
  if (unreadable.length > 0) {
    const shown = unreadable.slice(0, 3).join('、');
    throw new KojoSourceEnumerateError(
      `${unreadable.length} 份 .kojo 源读不到（${shown}${unreadable.length > 3 ? ' 等' : ''}）`,
    );
  }
  return out;
}

/**
 * 糖侧引用判读：问 `ui.editor.languageService` 槽的 `references` 成员，只收**本文件**的
 * 判读结果（糖的引用面是文件局部的，规范 §7.2；越界一律不收，不猜）。
 */
export function kojoReferencesViaSlot(
  contributions: readonly EditorLanguageServiceContribution[],
  kernel: Kernel,
  probe: KojoReferenceProbe,
): readonly EditorSymbolLocation[] {
  const project = kernel.project.current();
  const locations: EditorSymbolLocation[] = [];
  let answered = false;
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide({
        kind: 'references',
        path: probe.filePath,
        text: probe.text,
        line: probe.line,
        column: probe.column,
        project,
      });
    } catch (e: unknown) {
      throw new Error(
        `引用判读抛错（'${contribution.id}'）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!result || result.kind !== 'references') continue;
    answered = true;
    for (const location of result.locations) {
      if (location.filePath === probe.filePath) locations.push(location);
    }
  }
  if (!answered) {
    throw new KojoReferenceUnansweredError(
      `没有任何语言服务供方应答这份 .kojo 引用判读（${probe.filePath}）`,
    );
  }
  return locations;
}
