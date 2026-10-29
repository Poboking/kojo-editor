/**
 * Kojo 2.0 的**查找引用**：**契约 → Monaco Location 的翻译层**（B3e，2026-10-29 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，判据一枚都不留
 *
 * 本文件曾经同时住着三类东西：**语言判据**（符号归属 / 表达式扫描 / 跨文件合并 / 500 条上限）、
 * **两枚 provider 安装器**与 Monaco 协议翻译。B3e 把判据整块搬走：唯一落点是
 * `@kojo/kojo-lang/references`，作答的是插件 `@kojo/plugin-kojo-lang` 在
 * `ui.editor.languageService` 槽里登记的 `kojo2-references` 贡献。这里若再留一份判据当
 * "兜底"，同一格就有两份答案——Monaco 对引用取并集，"多一条 / 少一条"从此只能靠注册顺序解释。
 *
 * ## 留下的三件事，每一件都是"插件看不到"的宿主事实
 *
 * 1. **model → 请求**：`path` / `languageId` / `version` 原样取自 model（宿主不改写、不猜）、
 *    全文、光标位点、当前项目，以及**项目文件快照**（`projectFiles`）——快照从宿主常驻的
 *    `kojo2ProjectIndex` 现取（哪些文件算项目、哪份文本最新，只有宿主知道），按文件数 /
 *    字节数设上限，超限时 `projectFilesComplete = false` 如实说"少给了"。快照**只在显式
 *    动作**（Shift+F12）里取，不挂击键路径。
 * 2. **响应 → Monaco `Location[]`**：契约的 `EditorSymbolLocation`（`filePath` + 行 + 列 +
 *    区间）→ `{ uri, range }`。本文件落点用 `model.uri`；跨文件落点走注入的
 *    `uriForPath`（缺省 `monaco.Uri.file`）。`includeDeclaration === false` 去掉声明位
 *    （契约里声明位的 `kind` 是 `definition`）。
 * 3. **注册**：经 `registerForLanguageServices(monaco, register, 'references')` 挂上
 *    （kojo2 由 descriptor 的 `slotServices` 点名）。当年那两枚"注册调用第一个参数直接写死
 *    `KOJO2_LANGUAGE_ID`"的自建安装器已随批删除（闸门正是按那条形状 grep 归零的）。
 *
 * ## 三态
 *
 * 无人应答（插件没装 / 弃权）⇒ `[]`；有人作答但 `locations` 为空（认这门语言、这处没有
 * 可证引用）⇒ `[]`（单答裁决已在 legs 收口，不会再问下一家）；有结果 ⇒ 逐条翻译。
 * `result.truncated === true` 时 `console.warn` 一条（Monaco 的 Peek 列表没有"截断"位；
 * 不静默少给，是这一层能做的如实表达）。
 *
 * ## 兼容再导出（不是判据）
 *
 * `kojo2ReferencesAt` 仍被 code lens 的计数腿引用；项目索引也仍消费逐文件事实
 * （`kojo2ReferenceSymbolsOf` / `kojo2ReferenceCandidatesOf`）。它们**本体都在包里**，
 * 本文件只做名字转发——没有第二份实现。
 */
import type * as Monaco from './entry';
import type { EditorSymbolLocation } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectReferences,
  editorRequestIdentityOf,
  projectFilesSnapshotOf,
  referencesRequestOf,
} from './kojo-language-service-legs';
import type { Kojo2ProjectIndex } from './kojo2-project-index';
import { registerForLanguageServices } from './register-dialects';

export {
  KOJO2_PROJECT_REF_LIMIT,
  KOJO2_REFERENCE_LIMIT,
  createKojo2ReferenceSnapshotIndex,
  kojo2ProjectReferencesAt,
  kojo2ReferenceCandidatesOf,
  kojo2ReferencesAt,
  kojo2ReferencesInProjectFiles,
  kojo2ReferenceSymbolsOf,
} from '@kojo/kojo-lang/references';
export type {
  Kojo2DocumentSymbolFacts,
  Kojo2ProjectDeclaration,
  Kojo2ProjectLookupOptions,
  Kojo2ProjectMergedSite,
  Kojo2ProjectReferenceSite,
  Kojo2ProjectReferencesResult,
  Kojo2ProjectSymbolRef,
  Kojo2ReferenceCandidate,
  Kojo2ReferenceOptions,
  Kojo2ReferencePosition,
  Kojo2ReferenceSite,
  Kojo2ReferenceSiteKind,
  Kojo2ReferenceSpan,
  Kojo2ReferenceSymbol,
  Kojo2ReferenceSymbolKind,
  Kojo2ReferencesResult,
} from '@kojo/kojo-lang/references';

/* ============================== 宿主事实（model → 请求） ============================== */

/** 取整篇源文；取不到（模型已 dispose / 桩 model）⇒ `null` */
function sourceOf(model: Monaco.editor.ITextModel): string | null {
  try {
    const text = model.getValue();
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** model 的 uri；没有 uri 的桩 model ⇒ `undefined`（`Location` 缺 uri 无处可落） */
function uriOf(model: Monaco.editor.ITextModel): Monaco.Uri | undefined {
  const uri = (model as unknown as { uri?: unknown }).uri;
  return uri !== null && typeof uri === 'object' ? (uri as Monaco.Uri) : undefined;
}

/** 取本文件路径：注入转换优先；缺省读 uri 的 fsPath / path（两者都取不到 ⇒ undefined） */
function pathOfModel(
  model: Monaco.editor.ITextModel,
  pathOf: ((model: Monaco.editor.ITextModel) => string | undefined) | undefined,
): string | undefined {
  if (pathOf !== undefined) {
    try {
      const path = pathOf(model);
      if (typeof path === 'string' && path.length > 0) return path;
    } catch {
      /* 宿主路径解析抛错 ⇒ 退回 uri（绝不让整条腿失败） */
    }
  }
  const uri = uriOf(model) as unknown as { fsPath?: unknown; path?: unknown } | undefined;
  if (uri === undefined) return undefined;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  return undefined;
}

/* ============================== 契约 → Monaco ============================== */

/** 契约落点 → `Monaco.IRange`（区间缺省 = 零宽在落点列；`line` 是唯一必给的行） */
function rangeOfLocation(location: EditorSymbolLocation): Monaco.IRange {
  const startColumn = location.span?.columnStart ?? location.column ?? 1;
  const endColumn = Math.max(location.span?.columnEnd ?? startColumn, startColumn);
  return {
    startLineNumber: location.line,
    startColumn,
    endLineNumber: location.line,
    endColumn,
  };
}

/** path → Uri（注入优先；缺省 monaco.Uri.file；失败 / 不可用 ⇒ undefined，由调用方兜底） */
function uriForProjectPath(
  monaco: typeof Monaco,
  path: string,
  uriForPath: ((path: string) => Monaco.Uri | undefined) | undefined,
): Monaco.Uri | undefined {
  if (uriForPath !== undefined) {
    try {
      return uriForPath(path);
    } catch {
      return undefined;
    }
  }
  const uriApi = (monaco as unknown as { Uri?: { file?: (path: string) => Monaco.Uri } }).Uri;
  try {
    return typeof uriApi?.file === 'function' ? uriApi.file(path) : undefined;
  } catch {
    return undefined;
  }
}

/* ============================== 安装 ============================== */

/** 安装器的注入面（全部可选：不传 = 没有跨文件快照，行为与旧同文件 provider 一致） */
export interface Kojo2ReferenceProviderOptions {
  /** 项目索引 getter（宿主接自己那份 `createKojo2ProjectIndex()`；缺席 = 请求里不带快照） */
  readonly getIndex?: () => Kojo2ProjectIndex | null | undefined;
  /** model → 本文件路径（缺省取 `model.uri.fsPath` / `uri.path`；取不到 = 快照不排除自身） */
  readonly pathOf?: (model: Monaco.editor.ITextModel) => string | undefined;
  /**
   * 跨文件 `path` → `Monaco.Uri`（缺省 `monaco.Uri.file`）。
   * 转换抛错 / 转换不出 ⇒ 这一条落 `model.uri`（"缺省 model.uri 兜底"）。
   */
  readonly uriForPath?: (path: string) => Monaco.Uri | undefined;
  /** 快照预算（additive；缺省见 legs 的 `KOJO2_PROJECT_FILES_MAX_*`） */
  readonly snapshotLimits?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
  };
}

/**
 * 为 `kojo2` 语言注册**唯一**的 ReferenceProvider（Shift+F12），返回**幂等** disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT：查找引用是只读语言面，不读切流开关）；
 * - 注册经共享收口 + 能力名 `references`（kojo2 由 descriptor 点名）；落到 ERB / kojo1 上的
 *   那一枚不会抢它们：插件对非 kojo2 请求弃权，宿主交回空列表；
 * - 索引 getter 抛错 / 回 `null` ⇒ 请求里没有快照（只是同文件结果，与旧行为一致）；
 * - 取文失败 / model 无 uri / 任何异常 ⇒ `[]`；注册失败原样外抛（半途已挂的先撤回）。
 */
export function installKojo2ProjectReferenceProvider(
  monaco: typeof Monaco,
  options: Kojo2ReferenceProviderOptions = {},
): Monaco.IDisposable {
  const provider: Monaco.languages.ReferenceProvider = {
    provideReferences(model, position, context) {
      try {
        const source = sourceOf(model);
        if (source === null) return [];
        const modelUri = uriOf(model);
        if (modelUri === undefined) return [];

        const identity = editorRequestIdentityOf(model);
        const path = pathOfModel(model, options.pathOf);
        const requestIdentity =
          path === undefined ? identity : { ...identity, path };

        let index: Kojo2ProjectIndex | null = null;
        if (options.getIndex !== undefined) {
          try {
            index = options.getIndex() ?? null;
          } catch {
            index = null;
          }
        }
        const snapshot = projectFilesSnapshotOf(
          index,
          path ?? '',
          options.snapshotLimits ?? {},
        );

        const kernel = requireKernel();
        // 单答裁决在 legs（`collectReferences` 第一家作答），这里只递请求、翻形状。
        const result = collectReferences(
          kernel.slots.query('ui.editor.languageService'),
          referencesRequestOf(
            requestIdentity,
            source,
            position.lineNumber,
            position.column,
            kernel.project.current(),
            snapshot,
          ),
        );
        if (result === undefined) return [];

        const includeDeclaration = context?.includeDeclaration !== false;
        const locations: Monaco.languages.Location[] = [];
        for (const location of result.locations) {
          if (!includeDeclaration && location.kind === 'definition') continue;
          const sameFile = path === undefined || location.filePath === path || location.filePath === '';
          const uri = sameFile
            ? modelUri
            : (uriForProjectPath(monaco, location.filePath, options.uriForPath) ?? modelUri);
          locations.push({ uri, range: rangeOfLocation(location) });
        }
        if (result.truncated === true) {
          console.warn(
            `[kojo2-references] 引用集合被截断（${locations.length} 条已显示）：项目快照或单次上限先到`,
          );
        }
        return locations;
      } catch {
        // Monaco 把 throw 吞成"引用面板突然空了"；空数组是它能读出的唯一形状。
        return [];
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerReferenceProvider(id, provider),
        // 带能力名：descriptor 的 `slotServices` 点了 `references` 的语言（kojo2）也挂这一枚。
        'references',
      ),
    );
  } catch (error) {
    for (const registration of registrations) {
      try {
        registration.dispose();
      } catch {
        /* 半途回滚：一枚撤不掉不许带走其余（错误原样外抛给宿主） */
      }
    }
    throw error;
  }

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          /* 幂等 + 逐枚隔离：一枚撤不掉不许带走其余 */
        }
      }
    },
  };
}
