/**
 * Kojo 2.0 的**符号改名**：**契约 → Monaco WorkspaceEdit 的翻译层**（B3e，2026-10-29 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，判据一枚都不留
 *
 * 本文件曾经同时住着**判据**（引用扫描 / 三道全或无闸 / prepare 位置门 / 跨文件 plan 与两个
 * 上限）、**一枚 provider 安装器**与 Monaco 协议翻译。B3e 把判据整块搬进
 * `@kojo/kojo-lang/rename`，作答的是插件 `@kojo/plugin-kojo-lang` 在
 * `ui.editor.languageService` 槽里登记的 `kojo2-rename` 贡献。这里若再留一份判据当"兜底"，
 * 同一格就有两份答案（Monaco 的多 provider 合并顺序不可控）。
 *
 * ## 留下的四件事，每一件都是"插件看不到"的宿主事实
 *
 * 1. **modelRefusal**：已释放 / `getOptions().readOnly` 的 model 不是作者源文（预览 / 生成面），
 *    一律不改——它先于任何请求；
 * 2. **model → 请求**：`path` / `languageId` / `version` 原样取自 model、全文、光标位点、
 *    新名、当前项目，以及**项目文件快照**（从宿主 `kojo2ProjectIndex` 现取；只在 F2 这条
 *    显式动作里取）。快照超限 / 缺文件 ⇒ `projectFilesComplete = false`，供方按全或无拒绝；
 * 3. **契约 → Monaco `WorkspaceEdit`**：`EditorRenameEdit` 的 `resourcePath` 决定落点 URI
 *    （缺省 / 等于请求文件 ⇒ `model.uri`；其余走注入的 `uriForPath`，缺省 `monaco.Uri.file`）；
 *    `rejectReason` 原样交给 `rename-rejection` 的回执（Monaco 见理由即丢弃编辑并就近提示）；
 * 4. **注册**：经 `registerForLanguageServices(monaco, register, 'rename')` 挂上
 *    （kojo2 由 descriptor 的 `slotServices` 点名）。当年那枚"注册调用第一个参数直接写死
 *    `KOJO2_LANGUAGE_ID`"的自建安装器已随批删除。
 *
 * ## 为什么不再有 `resolveRenameLocation`
 *
 * 契约的 `rename` 成员只有"光标 + 新名"这一种请求形状（prepare 语义没有判别成员），而
 * "能不能改"的判据已整块搬进包里。宿主若在这里调一次 `kojo2PrepareRename`，就是又持有一枚
 * 判定权；若不调、只把光标位置原样递给 Monaco，Monaco 会用编辑器通用词段作输入框初值，
 * 真按 F2 输入新名后由供方的 `rejectReason` 说明"为什么不能改"（与旧行为相比只少了
 * **输入框之前**那一步拒绝提示，原因文案逐字相同）。本批选择后者：**不留第二枚判据**。
 *
 * ## 失败面
 *
 * 取文失败 / 内核未就绪 / 编排抛 ⇒ `reject(...)`（Monaco 把 throw 吞成"功能突然没了"，
 * 作者读不出原因）；单枚贡献自己抛错由 legs 的 `provideOf` 隔离（warn 带贡献 id）；
 * 注册半途抛错 ⇒ 先撤回已挂上的再外抛；dispose 幂等且逐枚隔离。
 */
import type * as Monaco from './entry';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectRename,
  editorRequestIdentityOf,
  modelTextOf,
  projectFilesSnapshotOf,
  renameRequestOf,
} from './kojo-language-service-legs';
import type { Kojo2ProjectIndex } from './kojo2-project-index';
import { registerForLanguageServices } from './register-dialects';
import { reject } from './rename-rejection';

/** 兼容再导出（本体在 `@kojo/kojo-lang/rename`；这里只转发名字，没有第二份实现） */
export {
  KOJO2_RENAME_PLAN_MAX_EDITS,
  KOJO2_RENAME_PLAN_MAX_FILES,
  kojo2PrepareRename,
  kojo2ProjectFileResolvers,
  kojo2RenameAt,
  kojo2RenamePlan,
  kojo2RenamePlanXFile,
  kojo2RenamedSource,
  validateKojo2RenameName,
  validateName,
} from '@kojo/kojo-lang/rename';
export type {
  Kojo2NameVerdict,
  Kojo2PrepareResult,
  Kojo2RenameEdit,
  Kojo2RenamePathEdits,
  Kojo2RenamePlan,
  Kojo2RenamePosition,
  Kojo2RenameRange,
  Kojo2RenameResolvers,
  Kojo2RenameResult,
  Kojo2RenameSymbol,
  Kojo2RenameableKind,
} from '@kojo/kojo-lang/rename';

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

/** model 的 uri；没有 uri 的桩 model ⇒ `undefined` */
function uriOf(model: Monaco.editor.ITextModel): Monaco.Uri | undefined {
  const uri = (model as unknown as { uri?: unknown }).uri;
  return uri !== null && typeof uri === 'object' ? (uri as Monaco.Uri) : undefined;
}

/** 请求文件路径：宿主注入优先，退回 model 的 file URI；取不到 ⇒ `null` */
function renamePathOf(
  model: Monaco.editor.ITextModel,
  options: Kojo2RenameInstallOptions,
): string | null {
  try {
    const provided = options.pathOf?.(model);
    if (typeof provided === 'string' && provided.length > 0) return provided;
  } catch {
    /* 宿主路径解析抛错 ⇒ 退回 uri（绝不让改名整体失败） */
  }
  const uri = uriOf(model);
  const fsPath = uri?.fsPath;
  return typeof fsPath === 'string' && fsPath.length > 0 ? fsPath : null;
}

/** 模型上的静态闸：只读 / 已释放的 model 不是作者源文（预览 / 生成面）——一律不改。 */
function modelRefusal(model: Monaco.editor.ITextModel): string | null {
  try {
    if (typeof model.isDisposed === 'function' && model.isDisposed()) {
      return '模型已释放，改名取消';
    }
    // Monaco 0.57 的 `ITextModel` 没有 `isReadOnly`：只读事实住在 `getOptions().readOnly`。
    const getOptions = (
      model as unknown as { getOptions?: () => { readonly readOnly?: boolean } | undefined }
    ).getOptions;
    if (typeof getOptions === 'function') {
      const options = getOptions.call(model);
      if (options?.readOnly === true) {
        return '这是只读模型（预览 / 生成面）：生成行不能改名，请回到源文件';
      }
    }
  } catch {
    return '读不到模型状态，改名取消';
  }
  return null;
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

/* ============================== 契约 → Monaco ============================== */

function toMonacoRange(edit: {
  readonly line: number;
  readonly startColumn: number;
  readonly endColumn: number;
}): Monaco.IRange {
  return {
    startLineNumber: edit.line,
    startColumn: edit.startColumn,
    endLineNumber: edit.line,
    endColumn: edit.endColumn,
  };
}

/* ============================== 安装 ============================== */

/** 安装器的注入面（全部可选：不传 = 没有跨文件快照，行为与旧同文件改名一致） */
export interface Kojo2RenameInstallOptions {
  /** 项目索引 getter（宿主接自己那份 `createKojo2ProjectIndex()`；缺席 = 请求里不带快照） */
  readonly getIndex?: () => Kojo2ProjectIndex | null | undefined;
  /** model → 磁盘路径（请求身份 + 落点判等）；缺省读 `uri.fsPath` */
  readonly pathOf?: (model: Monaco.editor.ITextModel) => string | null | undefined;
  /** 跨文件 `path` → URI（落点映射）；缺省 `monaco.Uri.file` */
  readonly uriForPath?: (path: string) => Monaco.Uri | undefined;
  /** 快照预算（additive；缺省见 legs 的 `KOJO2_PROJECT_FILES_MAX_*`） */
  readonly snapshotLimits?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
  };
}

/**
 * 为 `kojo2` 语言注册**唯一**的 RenameProvider（F2），返回**幂等** disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT：改名是语言服务，不读切流开关）；
 * - 注册经共享收口 + 能力名 `rename`（kojo2 由 descriptor 点名）；ERB / kojo1 各由自己的
 *   安装器负责，插件对非 kojo2 请求弃权；
 * - 只读 / 已释放 model ⇒ `rejectReason`（Monaco 见理由即丢弃输入框并就近提示）；
 * - 契约 `rejectReason` 原样透传；`edits` 为空且无理由 ⇒ 一条"没有可落地的编辑"；
 * - provider 体内任何抛错都退成拒绝理由，绝不把 throw 甩进 Monaco。
 */
export function installKojo2RenameProvider(
  monaco: typeof Monaco,
  options: Kojo2RenameInstallOptions = {},
): Monaco.IDisposable {
  const provider: Monaco.languages.RenameProvider = {
    provideRenameEdits(model, position, newName) {
      const refusal = modelRefusal(model);
      if (refusal !== null) return reject(refusal);
      const source = sourceOf(model);
      if (source === null) return reject('取不到这份文件的内容，改名取消');
      try {
        const path = renamePathOf(model, options);
        const identity = editorRequestIdentityOf(model);
        const requestIdentity =
          path === null ? identity : { ...identity, path };

        let index: Kojo2ProjectIndex | null = null;
        if (options.getIndex !== undefined) {
          try {
            index = options.getIndex() ?? null;
          } catch {
            index = null;
          }
        }
        const snapshot = projectFilesSnapshotOf(index, path ?? '', options.snapshotLimits ?? {});

        const kernel = requireKernel();
        // 单答裁决在 legs（`collectRename` 第一家作答），这里只递请求、翻形状。
        const result = collectRename(
          kernel.slots.query('ui.editor.languageService'),
          renameRequestOf(
            requestIdentity,
            source,
            position.lineNumber,
            position.column,
            newName,
            kernel.project.current(),
            snapshot,
          ),
        );
        if (result === undefined) {
          return reject('没有语言服务应答这次改名（插件未安装或弃权），改名取消');
        }
        if (result.rejectReason !== undefined) return reject(result.rejectReason);
        if (result.edits.length === 0) {
          return reject('没有可落地的编辑（引用集为空），改名取消');
        }

        const modelUri = uriOf(model);
        if (modelUri === undefined) {
          return reject('这份文件没有 URI，无法构造 WorkspaceEdit');
        }
        const uriForPath: (path: string) => Monaco.Uri | undefined = (path) =>
          options.uriForPath !== undefined ? options.uriForPath(path) : monaco.Uri.file(path);
        return {
          edits: result.edits.map((edit) => {
            const resourcePath = edit.resourcePath;
            // 请求文件自己（或缺省落点）用 model 的 URI（保留编辑器侧的 scheme / 大小写口径），
            // 其余路径交给宿主注入的映射（缺省按磁盘路径造 file URI）。
            const sameFile =
              resourcePath === undefined ||
              resourcePath.length === 0 ||
              (path !== null && resourcePath === path);
            const resource = sameFile
              ? modelUri
              : (uriForProjectPath(monaco, resourcePath, options.uriForPath) ??
                uriForPath(resourcePath) ??
                modelUri);
            return {
              resource,
              versionId: undefined,
              textEdit: { range: toMonacoRange(edit), text: edit.newText },
            };
          }),
        };
      } catch {
        return reject('重命名失败：取文或编排抛错，改名取消');
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerRenameProvider(id, provider),
        // 带能力名：descriptor 的 `slotServices` 点了 `rename` 的语言（kojo2）也挂这一枚。
        'rename',
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
          /* 幂等 + 逐枚隔离：撤不掉也不外抛 */
        }
      }
    },
  };
}
