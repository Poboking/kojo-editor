import type * as Monaco from './entry';
import type { EditorCompletionFacts, ErbFile, ErbIndex, GameAdapter } from '@kojo/plugin-api';
import { activeGameAdapter } from '@kojo/plugin-api';
import { SYSTEM_FUNCTION_REVERSE } from '@kojo/kojo-vocab/system-functions';
import { makeLookup } from '@kojo/kojo-vocab/engine';
import { ERB_DIRECTIVES, mergeDirectiveWords } from './erb-language';
import { requireKernel } from '../ui/editor-pane-registry';
import { loadWordBasedSuggestionsPref } from '../ui/suggest-pref';
import type { Kernel } from '@kojo/kernel';

/**
 * ERB 补全的**事实收集**（LAU-4 补全腿第三批，2026-10-31）。
 *
 * ## 这个文件为什么只剩这一件事
 *
 * ERB 补全的**判据**（位置门、十一路候选的生成 / 去重 / 排序 / 详情）已整块住进常驻插件
 * `@kojo/plugin-erb-parser`（`src/completion.ts`）。插件读不到 adapter 槽、项目索引与设置
 * ——那些是**宿主事实**。本模块把"宿主恰好有、插件恰好取不到"的那批数据打成一袋
 * （`EditorCompletionFacts`），随补全请求递下去；插件拿它算候选，宿主对"哪个词是引擎族头"
 * 一无所知（M2：宿主不认识语言）。
 *
 * 判据搬完之后，原宿主侧那十一枚 `monaco/erb-completion-*.ts`（候选源 / 形状翻译）与
 * `installErbCompletion`（自装配 provider）一并**删除**：同一门语言只留**一枚** provider
 * ——共享槽腿（`slot-service-providers.ts` 的 `legOf('completion', …)`）问
 * `ui.editor.languageService` 槽、由插件作答。两枚 provider 并存时 Monaco 对补全是**并集**，
 * 作者会看到同一份候选两遍。
 *
 * ## 收集口径（一条都不猜）
 *
 * - `variableSchema` / `callProtocol`：当前项目 adapter 的贡献（`game.adapter` 槽 + 项目
 *   `adapterId` 认定；无项目 / 无同 id 贡献 ⇒ 不带，依赖它的两路零候选）；
 * - `dictionary`：变量名的原生引用反查（adapter 的 `lookup`；缺席 ⇒ 详情少一条事实）；
 * - `directiveWords`：**宿主词表单一真源** `ERB_DIRECTIVES` ∪ adapter 指令名，合并口径与
 *   Monarch 高亮同一个 `mergeDirectiveWords`（大小写不敏感去重，先见者胜）；
 * - `systemFunctionAliases`：糖层中文别名反查表（`SYSTEM_FUNCTION_REVERSE`，查不到就空）；
 * - `wordBasedSuggestions`：设置页偏好（每轮现取，翻开关下一个候选轮即生效）；
 * - `dimNames` / `labelNames` / `functionNames`：解析器索引派生件（`#DIM` 名 / 光标行所属
 *   函数的 `$` 标签名 / 项目全部函数名）。**`undefined` 与 `[]` 严格分家**：前者 = 未索引
 *   ⇒ 插件回退当前缓冲区；后者 = 已索引确无该项 ⇒ 零候选。
 *
 * 全程 try/catch：索引在途 / 解析器缺席 / 表求值抛错 ⇒ 该格不带（**退化可见**：依赖它的
 * 那一路零候选），绝不把异常送进补全 seam。
 */

/** 取当前项目 adapter（与 `.kojo` 补全 seam 的 `editorTables` 同一条判据） */
function adapterNow(kernel: Kernel): GameAdapter | undefined {
  try {
    const contributions = kernel.slots.query('game.adapter');
    return activeGameAdapter(contributions, kernel.project.current()?.adapterId);
  } catch {
    return undefined;
  }
}

/** 解析器索引（`erb.parser` 服务软取；缺席 / 在途 / 抛错 ⇒ `null`） */
function erbIndexNow(kernel: Kernel): ErbIndex | null {
  try {
    const service = kernel.services.tryGet('erb.parser') as { index?: () => ErbIndex | null } | undefined;
    return service?.index?.() ?? null;
  } catch {
    return null;
  }
}

/** 路径键归一（Windows 上分隔符 / 大小写不一致；与 `ui/external-change.ts` 的 `matchOpenedPath` 同向） */
function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** 索引里按归一化路径找文件（找不到 / 索引缺席 ⇒ `null`，**不猜**） */
function fileForPath(index: ErbIndex | null, path: string): ErbFile | null {
  if (!index) return null;
  const want = pathKey(path);
  for (const [key, file] of index.files) {
    if (pathKey(key) === want) return file;
  }
  return null;
}

/** model 的磁盘路径（宿主事实：多数情况下就是 `uri.fsPath`；桩 model 防御） */
function pathOf(model: Monaco.editor.ITextModel): string {
  const uri = (model as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === null || typeof uri !== 'object') return '';
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  return typeof uri.path === 'string' ? uri.path : '';
}

/**
 * 把「取当前 `ErbIndex`」的记忆化为「函数名（已排序）提供者」——与搬家前 `erbTables` 的
 * `erbFunctionNames` **同一份实现**（这里只是从 `erb-completion.ts` 原位保留：补全判据搬进
 * 插件之后，事实侧仍需要"按指纹失效"的那一份记忆化）。
 *
 * 展示名取**首个定义的原拼写**（`ErbFunctionRef.name`）：`byName` 的键是归一化大写名，
 * 直接拿键当候选会把作者写的 `M_Kojo_Message` 显示成 `M_KOJO_MESSAGE`。
 * 失效判据 = `ErbIndex.fingerprint`；指纹 `null`（有文件取不到 stat）⇒ 一律重算（保守失效）。
 * 索引缺席 ⇒ 空数组（**无候选**，不猜）；`getIndex` 抛错 ⇒ 空数组（绝不让补全 seam 崩）。
 */
export function memoizedErbFunctionNames(getIndex: () => ErbIndex | null | undefined): () => readonly string[] {
  let memo: readonly string[] = [];
  let memoFingerprint: string | null = null;
  let hasMemo = false;
  return (): readonly string[] => {
    let index: ErbIndex | null | undefined;
    try {
      index = getIndex();
    } catch {
      return [];
    }
    if (!index) return [];
    const fp = index.fingerprint ?? null;
    if (fp !== null && hasMemo && fp === memoFingerprint) return memo;
    const keys = [...index.byName.keys()].sort();
    const names: string[] = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      names[i] = index.byName.get(key)?.[0]?.name ?? key;
    }
    memo = names;
    memoFingerprint = fp;
    hasMemo = true;
    return memo;
  };
}

/** 文档词补全偏好（每轮现取；读不到 ⇒ `false` = 不供词，与搬家前同向） */
function wordBasedSuggestionsPref(): boolean {
  try {
    return loadWordBasedSuggestionsPref() === true;
  } catch {
    return false;
  }
}

/**
 * 每 kernel 一份的「函数名（已排序）」记忆化件（与搬家前 `editorTables` 的
 * `erbFunctionNames` 同一份实现：按 `ErbIndex.fingerprint` 失效，指纹不变不重排）。
 */
const functionNamesByKernel = new WeakMap<Kernel, () => readonly string[]>();

function functionNamesOf(kernel: Kernel): readonly string[] {
  let provider = functionNamesByKernel.get(kernel);
  if (provider === undefined) {
    provider = memoizedErbFunctionNames(() => erbIndexNow(kernel));
    functionNamesByKernel.set(kernel, provider);
  }
  return provider();
}

/**
 * 当前 model 的补全**事实袋**（共享槽腿在 `descriptor.completionFacts` 打了点子的语言上
 * 每轮现取；本模块不判语言 id——那一格是 descriptor 的事）。
 *
 * 返回 `undefined` = 这一轮没有可用事实（内核未就绪）⇒ 请求里不带 `facts`，
 * 与"旧宿主还没有事实袋"逐字相同。
 */
export function erbCompletionFactsOf(
  model: Monaco.editor.ITextModel,
  line: number,
): EditorCompletionFacts | undefined {
  let kernel: Kernel;
  try {
    kernel = requireKernel();
  } catch {
    return undefined;
  }
  const path = pathOf(model);
  const index = erbIndexNow(kernel);
  const file = fileForPath(index, path);
  const adapter = adapterNow(kernel);

  /** 变量字典：`lookup` 的两格（原生引用 / 族头反解）；抛错 ⇒ 不带这一格 */
  let dictionary: EditorCompletionFacts['dictionary'];
  if (adapter?.variableSchema !== undefined) {
    try {
      dictionary = makeLookup(adapter.variableSchema);
    } catch {
      dictionary = undefined;
    }
  }

  /** adapter 指令名（可选能力；表缺席 / `names` 抛错 ⇒ 只用静态词表） */
  let instructionNames: readonly string[] | undefined;
  try {
    const raw = adapter?.kojoInstructionTable?.names?.();
    instructionNames = Array.isArray(raw) ? raw : undefined;
  } catch {
    instructionNames = undefined;
  }

  let dimNames: readonly string[] | undefined;
  let labelNames: readonly string[] | undefined;
  try {
    if (file !== null) {
      dimNames = [...new Set(file.dims.map((d) => d.name))];
      const fn = file.functions.find((f) => f.startLine <= line && line <= f.endLine);
      labelNames =
        fn === undefined
          ? []
          : [...new Set((file.labels ?? []).filter((l) => l.functionStartLine === fn.startLine).map((l) => l.name))];
    }
  } catch {
    dimNames = undefined;
    labelNames = undefined;
  }

  let functionNames: readonly string[] | undefined;
  try {
    functionNames = functionNamesOf(kernel);
  } catch {
    functionNames = undefined;
  }

  return {
    ...(adapter?.variableSchema !== undefined ? { variableSchema: adapter.variableSchema } : {}),
    ...(dictionary !== undefined ? { dictionary } : {}),
    ...(adapter?.kojoCallProtocol !== undefined ? { callProtocol: adapter.kojoCallProtocol } : {}),
    // 词表合并口径与 Monarch 高亮**同一个合并件**（`mergeDirectiveWords`）：静态表 ∪ adapter 指令名
    directiveWords: mergeDirectiveWords(ERB_DIRECTIVES, instructionNames),
    systemFunctionAliases: [...SYSTEM_FUNCTION_REVERSE.entries()],
    wordBasedSuggestions: wordBasedSuggestionsPref(),
    ...(dimNames !== undefined ? { dimNames } : {}),
    ...(labelNames !== undefined ? { labelNames } : {}),
    ...(functionNames !== undefined ? { functionNames } : {}),
  };
}