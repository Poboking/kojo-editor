import type * as Monaco from './entry';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import type { CompletionDeclaration, CompletionDeclarationScanner } from './completion-core';
import { errorText } from '@kojo/plugin-api';

/**
 * COMPL-SHARED · `.kojo` **文件级声明名**（`别名` / `常量`）——判据只此一份，来自解析器。
 *
 * ## 为什么不再有第二份正则
 *
 * 旧实现是装配文件里的一枚 `ALIAS_DECL` 正则（`/^\\s*(?:别名|alias)\\s+([^\\s=：:,，]+)/gm`），
 * 它是**第三份**别名判据（另两枚在 `kojo-sugar` 的 lexer / parser，第四枚在 convention-linter）。
 * 正则与 parser 的口径分叉是实测过的：不认 `常量`、`;` 注释行里的 `别名` 当声明、引号内的
 * `别名` 当声明、全角空白分隔认不全。本模块把判据交回 `sugar.transpile` 的 `parse`——
 * **同一个 parser、同一套行分类与注释 / 字符串剥离**，顺带把 `常量` 名一并给出。
 *
 * ## 取哪一层
 *
 * 判据取 `doc.topLevel` 里 `kind === 'aliasDecl' | 'constDecl'` 的节点，而不是
 * `frontMatter.aliases`：后者只收**文件头**的声明（写在时机块之后会报 `alias-not-in-header`），
 * 而补全问的是"作者在本文件里起过哪些名字"，按 `topLevel` 取才与旧正则的可见集**零回归**
 * （旧正则也是全文扫），并且多出的只有 `常量` 一路。
 *
 * ## 注入优先
 *
 * 表上给了 `kojoDeclarations`（宿主可把内核里那一枚服务实例递进来）⇒ 用它；未给 ⇒ 本模块懒建
 * 一枚**只解析**实例（`createSugarTranspileService()` 无参 = 零 adapter 依赖、零 IO，`parse` 不转译
 * 不落盘）。两条路都是同一个 parser，**不是两套判据**。
 *
 * `parse` 按契约不抛（转译器内部异常落进 `doc.diagnostics` 并返回空骨架）；这里仍兜一层 try/catch
 * 拦住**注入的扫描器**抛错 ⇒ 该路零候选 + 一行 warn（不静默、不崩整轮补全）。
 */

/** 缺省扫描器所用的只解析服务实例（懒建一次；`parse` 是纯函数，跨文件复用安全） */
let defaultParseService: ReturnType<typeof createSugarTranspileService> | undefined;

const defaultScanner: CompletionDeclarationScanner = (text, filePath) => {
  try {
    defaultParseService ??= createSugarTranspileService();
    const doc = defaultParseService.parse(text, { filePath });
    const out: CompletionDeclaration[] = [];
    const seen = new Set<string>();
    for (const node of doc.topLevel) {
      if (node.kind !== 'aliasDecl' && node.kind !== 'constDecl') continue;
      const name = node.name;
      if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, kind: node.kind === 'aliasDecl' ? 'alias' : 'const' });
    }
    return out;
  } catch (e: unknown) {
    console.warn(`[kojo-completion] 声明名解析抛错，该路零候选（不猜）：${errorText(e)}`);
    return [];
  }
};

/** model 的文件路径（桩 model 没有 `uri` ⇒ 空串；解析器只用它做诊断定位，不影响声明名） */
function filePathOf(model: Monaco.editor.ITextModel): string {
  const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return '';
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  return typeof uri.path === 'string' ? uri.path : '';
}

/** model 的全文（桩 model / 旧运行时可能没有 `getValue` ⇒ 空文本：该路自然落空，不抛） */
function textOf(model: Monaco.editor.ITextModel): string {
  const getValue = (model as { getValue?: () => string }).getValue;
  return typeof getValue === 'function' ? getValue.call(model) ?? '' : '';
}

/**
 * 按 model 记忆化的声明表（与 `erb-completion-labels.ts` 的标签缓存同一纪律）。
 *
 * 全文解析是每击键 `O(文件大小)`；同一版本（未编辑）下声明**必不变** ⇒ 复用上次结果。
 * 版本号缺席（桩 model / 旧运行时）⇒ 退化为按**文本身份**记忆化：同一份文本只解析一次。
 * 两者都拿不到 ⇒ 每次重扫（行为正确，仅失去缓存；**不假定字段存在**）。
 * `WeakMap` 按 model 身份：编辑器关闭即回收，不产生无界增长。
 */
const DECL_CACHE = new WeakMap<
  Monaco.editor.ITextModel,
  {
    readonly versionId: number | undefined;
    readonly text: string;
    readonly declarations: readonly CompletionDeclaration[];
  }
>();

export function kojoDeclarationsOf(
  model: Monaco.editor.ITextModel,
  scan: CompletionDeclarationScanner | undefined,
): readonly CompletionDeclaration[] {
  const scanner = scan ?? defaultScanner;
  const getVersionId = (model as { getVersionId?: () => number }).getVersionId;
  const versionId = typeof getVersionId === 'function' ? getVersionId.call(model) : undefined;

  const text = textOf(model);
  if (text.length === 0) return [];
  const cached = DECL_CACHE.get(model);
  if (cached !== undefined) {
    const fresh = typeof versionId === 'number' ? cached.versionId === versionId : cached.text === text;
    if (fresh) return cached.declarations;
  }

  let declarations: readonly CompletionDeclaration[];
  try {
    declarations = scanner(text, filePathOf(model));
  } catch (e: unknown) {
    // 注入的扫描器抛错 ⇒ 该路零候选 + 一行可见降级（**不抛、不猜**，也**不缓存失败**：
    // 解析器随后就位时下一击键自然恢复）
    console.warn(`[kojo-completion] 声明名扫描抛错，该路零候选（不猜）：${errorText(e)}`);
    return [];
  }
  DECL_CACHE.set(model, { versionId, text, declarations });
  return declarations;
}
