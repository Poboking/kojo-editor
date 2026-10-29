/**
 * Kojo 2.0 **文档符号的 Monaco 翻译层**（K2-EDITOR-SYMBOLS 的宿主半边）。
 *
 * B1（2026-10-24）把这一面切成两半：**判据在 `@kojo/kojo-lang`**（`symbols.ts`）
 * （源码文本进，符号事实 / 名字链出，零 Monaco），**翻译在本文**。
 * 切法不是按行数，是按"谁能被插件复用"——插件拿不到 Monaco 实例，也就不该被迫
 * 认识 `SymbolKind`；而 `SymbolKind` 的映射只此一份（下文 `kojo2SymbolKindToMonaco`），
 * 不因为搬走一半就出现第二张表。
 *
 * 本文件里没有一条判据认识 `# 幕` / `@函` / `# 池`：它只把包里给的事实按 Monaco 的
 * 协议形状摆好，异常一律吞成空数组（理由见下）。
 *
 * `installKojo2DocumentSymbolProvider` 只挂 `kojo2` 语言 id，**不看 cutover 开关**
 * （K2-STRUCTURE-GATE，批次十一：大纲是只读呈现面，与写回 / 迁移 / 切解析器解耦）；
 * provider 内任何异常（坏文件 / 取文抛错 / 模型已释放）一律回 `[]`——Monaco 把 provider
 * 的 throw 吞成"大纲突然空了"，作者看不到任何原因，空数组才是它能读出的唯一形状。
 */
import type * as Monaco from './entry';
import { KOJO2_LANGUAGE_ID, kojo2DocumentSymbols } from '@kojo/kojo-lang';
import type { Kojo2SymbolFact, Kojo2SymbolKind, Kojo2SymbolRange } from '@kojo/kojo-lang';

/* ============================== Monaco 翻译层 ============================== */

/**
 * 符号种类 → Monaco `SymbolKind`（**唯一映射表**）。
 *
 * 分档理由：
 * - `# 幕` = `Module`：一篇文件里的大段（大纲折叠它就能收起整段）；
 * - `# 视` = `Variable`：视角目标是一个"绑到谁"的值；
 * - `# 机` / `@织` = `Event`：两者都是事件钩子（`# 机` 挂本文件、`@织` 挂监听；
 *   detail 里的声明词区分它们）；
 * - `# 变量` = `Variable`、`# 常量` = `Constant`：与声明语义一一对应；
 * - `# 对照表` = `Struct`、`# 池` = `Enum`：与补全层的 `CompletionItemKind` 映射同口径
 *   （表是多行记录、池是分支枚举）；
 * - `# 模` = `Method`、`@函` = `Function`：两者都可带参调用，用不同图标区分
 *   "编译期展开的模"与"运行期函数"。
 */
export function kojo2SymbolKindToMonaco(
  monaco: typeof Monaco,
  kind: Kojo2SymbolKind,
): Monaco.languages.SymbolKind {
  const K = monaco.languages.SymbolKind;
  switch (kind) {
    case 'scene':
      return K.Module;
    case 'view':
      return K.Variable;
    case 'machine':
      return K.Event;
    case 'variable':
      return K.Variable;
    case 'constant':
      return K.Constant;
    case 'table':
      return K.Struct;
    case 'pool':
      return K.Enum;
    case 'template':
      return K.Method;
    case 'function':
      return K.Function;
    case 'weave':
      return K.Event;
  }
}

/** 1 基区间 → `Monaco.IRange`（字段名换一遍，数值不动） */
function toMonacoRange(range: Kojo2SymbolRange): Monaco.IRange {
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  };
}

/**
 * 平铺事实 → `DocumentSymbol` 树（大纲 / Ctrl+Shift+O 的形状）。
 *
 * `container` 缺失 / 越界 / 不早于自己（直接调用方手工构造的坏数据）⇒ 那一枚当**顶层**：
 * 宁可让它多出一个根，也不许把树接成环或接到后面的兄弟上。
 * 空 `children` 不挂（Monaco 会画一个点不开的假箭头）。
 */
export function kojo2DocumentSymbolTree(
  monaco: typeof Monaco,
  facts: readonly Kojo2SymbolFact[],
): Monaco.languages.DocumentSymbol[] {
  const nodes: Monaco.languages.DocumentSymbol[] = facts.map((fact) => ({
    name: fact.name,
    detail: fact.detail,
    kind: kojo2SymbolKindToMonaco(monaco, fact.kind),
    tags: [],
    range: toMonacoRange(fact.range),
    selectionRange: toMonacoRange(fact.selectionRange),
  }));
  const roots: Monaco.languages.DocumentSymbol[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const parent = facts[i]?.container;
    if (parent === undefined || parent < 0 || parent >= i) {
      roots.push(node);
      continue;
    }
    const parentNode = nodes[parent];
    if (parentNode === undefined) {
      roots.push(node);
      continue;
    }
    const children = parentNode.children ?? [];
    children.push(node);
    parentNode.children = children;
  }
  return roots;
}

/* ============================== 安装 ============================== */

/**
 * 为 `kojo2` 语言注册文档符号 provider，返回**幂等**的 disposable。
 *
 * - **不看 cutover 开关**（K2-STRUCTURE-GATE，批次十一）：大纲是只读呈现面，`.kojo2`
 *   一打开就该有 Ctrl+Shift+O，与"写回 / 迁移 / 切解析器"的切流开关无关；
 * - 只挂 `KOJO2_LANGUAGE_ID`：v1 ERB / `.kojo` 面各由 `kojo-symbols.ts` 的
 *   `registerForLanguageServices` 挂，两边不重叠；
 * - provider 内任何异常回 `[]`（Monaco 把 throw 吞成"大纲突然空了"——空数组至少是
 *   "这篇没有结构"，而不是一个没有原因的假死）；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚；宿主那侧的"全有或全无"收口
 *   才有机会把同批其余 provider 撤掉）。
 */
export function installKojo2DocumentSymbolProvider(
  monaco: typeof Monaco,
): Monaco.IDisposable {
  const provider: Monaco.languages.DocumentSymbolProvider = {
    displayName: 'kojo2',
    provideDocumentSymbols(model) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return [];
        const source = model.getValue();
        if (typeof source !== 'string') return [];
        return kojo2DocumentSymbolTree(monaco, kojo2DocumentSymbols(source));
      } catch {
        return [];
      }
    },
  };

  const registration = monaco.languages.registerDocumentSymbolProvider(
    KOJO2_LANGUAGE_ID,
    provider,
  );

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
