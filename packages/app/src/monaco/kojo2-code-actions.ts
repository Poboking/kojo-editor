/**
 * Kojo 2.0 **一键迁移 code action 的宿主适配**（K2-CODE-ACTIONS → B3j 2026-10-30）。
 *
 * ## 分工（B3j 之后）
 *
 * | 层 | 住哪 | 干什么 |
 * |---|---|---|
 * | 判据 | `@kojo/kojo-lang/code-actions` | 诊断 + 光标行 + 源码 → 动作描述（标题 / 类别 / 编辑 / 认领的诊断），纯函数 |
 * | 供方 | `@kojo/plugin-kojo-lang` 的 `kojo2-codeActions` | 槽 `ui.editor.codeAction` 的 `provideActions`：非 2.0 弃权 |
 * | 宿主（本文件） | 这里 | **定位**（model / 光标 / marker）、把契约动作翻成 Monaco `CodeAction`、经宿主注入的 `applyEdits` 落地、切流开关 |
 *
 * 本文件**不认识**迁移规则：一条 `if (diag.code === …)` 都不留（搬到包里之前有 15 条）。
 * 它也不认识"哪些文件有动作"——那是槽里的贡献方按 `path` 自己弃权的事。
 *
 * ## 为什么仍是一枚自建 provider（而不是 `registerForLanguageServices`）
 *
 * codeAction **不是** `ui.editor.languageService` 的判别成员：诊断与快速修复各有专用槽
 * （契约头注写死了"再开一个判别成员就是同一能力两条路径"），所以 `SlotServiceKind`
 * 里没有它、共享收口挂不到 kojo2 上。这枚安装器于是就是**那枚槽在 kojo2 上的宿主适配腿**：
 * 它只查询槽、翻译形状、落地——判据一份都不留。
 *
 * ## 为什么留在切流开关里
 *
 * 每个动作都把 v1 写法改写进缓冲，属**迁移入口**（有副作用），与写回 / 解析器切换同档。
 * flag 关 ⇒ **零注册**（不装 provider、不装命令）。
 *
 * ## 落地纪律（undo 停点）
 *
 * 命令回调把动作的 `edits` 交给宿主注入的 `applyEdits`，宿主接到**既有** `applyTextEdits`
 * （前后各一颗 `pushUndoStop`）——机器改写自成一格、`Ctrl+Z` 只退机器那一步
 * （口径见 `packages/app/tests/code-action-undo-stack.test.ts`）。刻意不给 Monaco 的
 * `edit` 字段：那条路绕开宿主停点。
 */
import type * as Monaco from './entry';
import type {
  EditorCodeAction,
  EditorCodeActionContribution,
  EditorTextEdit,
  GameProject,
} from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import {
  QUICK_FIX_KIND,
  REFACTOR_KIND,
  actionDiagnostics,
  markersToDecorations,
  monacoActionKind,
} from './kojo-code-action';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';

/** 动作执行命令 id（宿主统一注册一次；参数 = 待落地动作的反查 key） */
export const KOJO2_CODE_ACTION_COMMAND = 'kojo2.codeAction.run';

/** 本 provider 会产出的 Monaco 类别（`providedCodeActionKinds` 的交集判据） */
export const KOJO2_PROVIDED_CODE_ACTION_KINDS: readonly string[] = [QUICK_FIX_KIND, REFACTOR_KIND];

/**
 * 宿主注入面（本层不认识 pane / EditorPane；取文、取路径、落地全在宿主）。
 *
 * `contributions` 是**请求时现取**的槽快照：插件可能比本安装器晚激活（bootstrap 是动态
 * import），缓存一次会在"插件晚到"的首个会话里静默少一条腿。
 */
export interface Kojo2CodeActionHost {
  /** 槽 `ui.editor.codeAction` 的当前贡献（宿主每次请求现取） */
  readonly contributions: () => readonly EditorCodeActionContribution[];
  /**
   * 落地端口：宿主接到**既有** `applyTextEdits`（前后各一颗 undo 停点）。
   * 返回是否真落了（糖视图 / 无归属实例 ⇒ false，本层不解释原因，由宿主自己说）。
   */
  readonly applyEdits: (
    model: Monaco.editor.ITextModel,
    edits: readonly EditorTextEdit[],
  ) => boolean;
  /** 当前项目（喂 `run` 型动作的上下文；缺省 `null`） */
  readonly project?: () => GameProject | null;
  /** 文件身份（请求里的 `path`；缺省 = `model.uri` 的 fsPath / path） */
  readonly filePath?: (model: Monaco.editor.ITextModel) => string | null;
}

/** 待落地动作表的上限（每次请求登记若干条；超了丢最老的，绝不无界增长） */
const PENDING_ACTION_LIMIT = 256;

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

const EMPTY: Monaco.languages.CodeActionList = { actions: [], dispose: () => undefined };

function uriTextOf(model: Monaco.editor.ITextModel): string {
  const uri = (model as unknown as { uri?: { toString?: () => string } }).uri;
  return uri !== undefined && typeof uri.toString === 'function' ? uri.toString() : '';
}

function filePathOfModel(model: Monaco.editor.ITextModel): string | null {
  const uri = (model as unknown as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri === undefined) return null;
  for (const value of [uri.fsPath, uri.path]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** 槽里的一家贡献抛错 ⇒ 只丢这一家（与共享收口同一条隔离纪律） */
function provideSafely(
  contribution: EditorCodeActionContribution,
  request: Parameters<EditorCodeActionContribution['provideActions']>[0],
): EditorCodeAction[] {
  try {
    return contribution.provideActions(request);
  } catch (error: unknown) {
    console.warn(`[kojo2-code-actions] '${contribution.id}' provideActions 抛错：${errorText(error)}`);
    return [];
  }
}

/**
 * 槽动作 → Monaco `CodeAction[]`。
 *
 * - `command` 而不是 `edit`：落地必须走宿主那条带 undo 停点的通道（见模块头「落地纪律」）；
 * - `diagnostics`：把动作认领的诊断翻成 marker（Monaco 据此排序 / 画"已修复区间"）；
 * - `isPreferred`：**本次请求里恰好只有一条 quickfix** 时置（沿用改前这枚 provider 的口径：
 *   多解不替作者选，与 v1 那条腿的 `pickPreferred` 同一产品意图）。
 */
function actionsOf(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  contributions: readonly EditorCodeActionContribution[],
  request: Parameters<EditorCodeActionContribution['provideActions']>[0],
  register: (action: EditorCodeAction) => string,
): Monaco.languages.CodeAction[] {
  const actions: Monaco.languages.CodeAction[] = [];
  const quickfixes: Monaco.languages.CodeAction[] = [];
  for (const contribution of contributions) {
    for (const action of provideSafely(contribution, request)) {
      const actionId = register(action);
      const kind = monacoActionKind(action.kind);
      const markers = actionDiagnostics(monaco, model, action);
      const translated: Monaco.languages.CodeAction = {
        title: action.title,
        kind,
        command: { id: KOJO2_CODE_ACTION_COMMAND, title: action.title, arguments: [actionId] },
        // 省略而不是给空数组：空数组在 Monaco 里同样算"无关联"，但 `undefined`
        // 才是"这条动作不是冲着某条诊断来的"的原意
        ...(markers !== undefined ? { diagnostics: markers } : {}),
      };
      actions.push(translated);
      if (kind === QUICK_FIX_KIND) quickfixes.push(translated);
    }
  }
  if (quickfixes.length === 1) quickfixes[0]!.isPreferred = true;
  return actions;
}

/**
 * 为 `kojo2` 语言注册**一枚** code action provider（+ 一条执行命令），返回**幂等** disposable。
 *
 * flag 关 ⇒ 空操作（**零注册**）；注册半途抛错 ⇒ 撤回已挂上的再外抛（宿主那一侧的
 * "全有或全无"回滚才有东西可撤）。provider 体内任何抛错都收成"这一轮没有动作"——
 * Monaco 会把 throw 吞成"💡 突然空了"，作者看不到任何原因。
 */
export function installKojo2CodeActionProvider(
  monaco: typeof Monaco,
  host: Kojo2CodeActionHost,
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const pending = new Map<
    string,
    { readonly uri: string; readonly path: string; readonly action: EditorCodeAction }
  >();
  const order: string[] = [];
  let seq = 0;

  const remember = (uri: string, path: string, action: EditorCodeAction): string => {
    const key = `${++seq}`;
    pending.set(key, { uri, path, action });
    order.push(key);
    while (order.length > PENDING_ACTION_LIMIT) {
      const oldest = order.shift();
      if (oldest !== undefined) pending.delete(oldest);
    }
    return key;
  };

  const provider: Monaco.languages.CodeActionProvider = {
    provideCodeActions(model, range, context) {
      try {
        const languageId = typeof model.getLanguageId === 'function' ? model.getLanguageId() : '';
        if (languageId !== KOJO2_LANGUAGE_ID) return EMPTY; // 只对 2.0 文件生效（v1 面零动作）
        const source = model.getValue();
        if (typeof source !== 'string') return EMPTY;
        // 零波浪线 ⇒ 一条都不问槽：本族动作全部按"面上画着的那条红线"应答（判据之前那次
        // 整篇 parse 也白付）。这一档**不减能力**：没有可修的红线时改前改后都是零条动作。
        const diagnostics = markersToDecorations(monaco, context.markers ?? []);
        if (diagnostics.length === 0) return EMPTY;
        const path = host.filePath?.(model) ?? filePathOfModel(model);
        if (path === null || path.length === 0) return EMPTY;
        const line = Number.isFinite(range.startLineNumber) ? range.startLineNumber : undefined;
        const actions = actionsOf(
          monaco,
          model,
          host.contributions(),
          {
            path,
            text: source,
            project: host.project?.() ?? null,
            ...(line !== undefined ? { line } : {}),
            lineCount: model.getLineCount(),
            diagnostics,
          },
          (action) => remember(uriTextOf(model), path, action),
        );
        if (actions.length === 0) return EMPTY;
        return { actions, dispose: () => undefined };
      } catch (error: unknown) {
        console.warn(`[kojo2-code-actions] 产出动作时抛错：${errorText(error)}`);
        return EMPTY;
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      monaco.editor.registerCommand(KOJO2_CODE_ACTION_COMMAND, (_accessor, key: unknown) => {
        if (typeof key !== 'string') return;
        const entry = pending.get(key);
        if (entry === undefined) return;
        const model = monaco.editor.getModel(monaco.Uri.parse(entry.uri));
        if (model === null || model.isDisposed()) return;
        try {
          if (entry.action.edits !== undefined && entry.action.edits.length > 0) {
            host.applyEdits(model, entry.action.edits);
            return;
          }
          // 没有 edits 的动作退回契约旧语义（`run` 发意图）：本供方今天不产这种，
          // 但槽是开放的——第三方贡献方给"导航型"动作时不该被这枚适配器吞掉。
          void entry.action.run({
            project: host.project?.() ?? null,
            activeFile: entry.path,
          });
        } catch (error: unknown) {
          console.warn(`[kojo2-code-actions] 落地动作时抛错：${errorText(error)}`);
        }
      }),
    );
    registrations.push(
      monaco.languages.registerCodeActionProvider(KOJO2_LANGUAGE_ID, provider, {
        providedCodeActionKinds: KOJO2_PROVIDED_CODE_ACTION_KINDS,
      }),
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
      pending.clear();
      order.length = 0;
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          /* 幂等 + 逐枚隔离 */
        }
      }
    },
  };
}
