/**
 * Kojo 2.0 **行上注解**：**请求构造 + 契约 → Monaco 的翻译层**（B3g，2026-10-30 判据交给插件）。
 *
 * ## 这一格里只剩三件事，判据一枚不留
 *
 * 本文件曾经同时住着三类东西：**语言判据**（三档注解的识别 / 词形 / 列口径 / `@函` 的调用点
 * 计数 / 大文件闸）、**Monaco 注册**与请求翻译。B3g 把判据整块搬进 `@kojo/kojo-lang/codelens`：
 * 作答的是插件 `@kojo/plugin-kojo-lang` 在 `ui.editor.languageService` 槽里登记的
 * `kojo2-codeLens` 贡献，注册走 `registerForLanguageServices(monaco, …, 'codeLens')`
 * （kojo2 由 descriptor 的 `slotServices` 点名）。这里若再留一份判据当"兜底"，同一格就有
 * 两份答案——而 code lens 的供给面按第一应答裁决，"多一条 / 少一条"从此只能靠注册顺序解释。
 *
 * 留下的三件，每一件都是"插件看不到"的宿主事实：
 *
 * 1. **model → 请求**：全文、`path` / `languageId` / `version`、当前项目。三格身份取自
 *    `editorRequestIdentityOf`（与补全 / 悬停 / 引用同一条腿，缺省就不出现）；
 * 2. **契约 → Monaco**：`EditorCodeLens[]` → `monaco.languages.CodeLens[]`，落地用的是
 *    **v1 那枚既有翻译器**（`kojo-code-lens.ts` 的 `toMonacoCodeLenses`）：越界行一律丢弃、
 *    零宽区间钉在行首、命令 id 就是已注册的 `kojo.codeLens.execute`（点击复用
 *    `editor.revealLocation`，不新造第二套跳转）。抄一份新的会立刻漂成两套落点口径。
 * 3. **注册**：经共享收口 + 能力名 `'codeLens'`。原来那枚把语言 id 直接写在注册调用里的
 *    原生安装已随批删除（闸门正是按那条形状 grep 归零的）。
 *
 * ## 三态（与 hover / references / documentHighlight 同一条纪律）
 *
 * - **无人应答**（插件没装 / 对非 kojo2 弃权）⇒ provider 交回 **`undefined`**：Monaco 的
 *   `ProviderResult` 允许空响，空响 = 这一家没说话、别的 provider 还能答（交 `{ lenses: [] }`
 *   是"我说这里没有注解"，会把别家顶掉）；
 * - **有人答空** ⇒ `{ lenses: [] }`（认这门语言、整篇没有可证明的注解）；
 * - **异常**（取文抛错 / 模型已释放 / 请求构造或翻译抛错）⇒ `{ lenses: [] }`：Monaco 会把
 *   provider 的 throw 吞成"注解突然没了"，空列表才是它能读出的唯一形状。
 *
 * ## 为什么不取项目快照（B3g 明说的一格缺口，理由在此）
 *
 * 契约这一格（`EditorCodeLensRequest.projectFiles`）与插件那侧（`@kojo/kojo-lang/codelens`
 * 的 `projectFiles`）都已经装得下项目快照，路也铺好了（{@link codeLensRequestOf} 走
 * `projectFilesSnapshotOf`——**与引用 / 改名同一条腿、同一组上限**，安装器的 `getIndex`
 * 一给就生效）。**装配点今天不给它**，理由是这一格的代价模型与引用面根本不同：
 *
 * - 引用（Shift+F12）/ 改名（F2）是**显式动作**，一次一份快照是天经地义；
 * - 行上注解是**每次停笔都重算整篇**（契约 `EditorCodeLensRequest` 头注取证：
 *   `codelensController.js` 的 `onDidChangeModelContent → scheduler.schedule()`）；
 * - 一份快照 = 全项目文本（最多 400 份 / 8 MiB）**再建一张临时索引**（每份文件一次
 *   `lex + parse`）。把它挂在停笔路径上，就是"每敲一会儿付一次项目级扫描"。
 *
 * 于是默认这一格是**缺席**：供方按同文件计数（与 B3g 之前逐字相同，标题也仍是「本文件 N 处」）。
 * 要开项目级计数，得先出读数（快照 + 临时索引的单次成本 × 停笔频率），那是一件独立的事，
 * 不该夹在"判据搬包"这一批里顺手开。
 *
 * ## 大文件闸仍判在这里（与 v1 注解同一条线）
 *
 * `LARGE_FILE_LINES` 之上**不问供方**：省掉的是一次整篇词法 + 每个 `@函` 一次引用查询。
 * 判在**问之前**（`lineCount` 一行就有），与 v1 `codeLensAffordable` 同一条线、同一个理由。
 * 供方自己还有一道"只产前 N 条"的渲染预算（判据口径在包里，见 `@kojo/kojo-lang/codelens`），
 * 两档不重叠：这里决定"这一篇办不办"，那里决定"办的话画几条"。
 */
import type * as Monaco from './entry';
import { requireKernel } from '../ui/editor-pane-registry';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import {
  codeLensRequestOf,
  collectCodeLensResult,
  editorRequestIdentityOf,
  modelTextOf,
  projectFilesSnapshotOf,
} from './kojo-language-service-legs';
import type { Kojo2ProjectIndex } from './kojo2-project-index';
import { registerForLanguageServices } from './register-dialects';
import { toMonacoCodeLenses } from './kojo-code-lens';

/* ============================== 宿主事实（model → 请求） ============================== */

/** 文件身份：注入位优先，其次 `model.uri.fsPath` / `uri.path`（桩 model 没有 uri ⇒ `undefined`） */
function filePathOfModel(
  model: Monaco.editor.ITextModel,
  getFilePath: Kojo2CodeLensProviderOptions['getFilePath'],
): string | undefined {
  if (getFilePath !== undefined) {
    try {
      const path = getFilePath(model);
      if (typeof path === 'string' && path.length > 0) return path;
    } catch {
      /* 身份取不到：退回 model.uri（下面） */
    }
  }
  const uri = (model as unknown as { uri?: { fsPath?: unknown; path?: unknown } }).uri;
  if (uri !== null && typeof uri === 'object') {
    if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
    if (typeof uri.path === 'string' && uri.path.length > 0) return uri.path;
  }
  return undefined;
}

/* ============================== 安装 ============================== */

/** provider 的注入面（生产走缺省：文件身份取 `model.uri`） */
export interface Kojo2CodeLensProviderOptions {
  /** 「这份 model 背后是哪个文件」的注入位；回 `null` / 抛错 ⇒ 退回 `model.uri` */
  readonly getFilePath?: (model: Monaco.editor.ITextModel) => string | null;
  /**
   * 项目索引 getter（**缺省不给**：见模块头「为什么不取项目快照」）。给了就把快照经
   * `projectFilesSnapshotOf`（引用 / 改名同一条腿、同一组上限）塞进请求，供方改做项目级计数。
   * 装配点今天是**不传**的。
   */
  readonly getIndex?: () => Kojo2ProjectIndex | null | undefined;
  /** 快照预算（additive；缺省见 legs 的 `KOJO2_PROJECT_FILES_MAX_*`） */
  readonly snapshotLimits?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
  };
}

/** `provideCodeLenses` 的空结果（Monaco 只读；每轮新建一个，不共享可变对象） */
function emptyList(): { lenses: Monaco.languages.CodeLens[]; dispose: () => void } {
  return { lenses: [], dispose: () => undefined };
}

/**
 * 为行上注解注册 provider（经共享收口挂到 descriptor 点名的语言，返回**幂等** disposable）。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT）：行上注解是只读呈现面，阶段 `v1-only` 下照样可见；
 * - 不读切流开关（语言面不跟着写回 / 迁移开关走，`language-parity` 闸按形状取证）；
 * - 注册失败原样外抛：共享收口已把半途挂上的逐枚撤回，调用方那侧还有"全有或全无"的收口。
 */
export function installKojo2CodeLensProvider(
  monaco: typeof Monaco,
  options: Kojo2CodeLensProviderOptions = {},
): Monaco.IDisposable {
  const provider: Monaco.languages.CodeLensProvider = {
    provideCodeLenses(model) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return emptyList();
        const text = modelTextOf(model);
        if (text === null) return emptyList();
        // 大文件档：判在**问供方之前**（省一次整篇词法 + 每个 `@函` 一次引用查询）。
        if (typeof model.getLineCount === 'function' && model.getLineCount() >= LARGE_FILE_LINES) {
          return emptyList();
        }

        const identity = editorRequestIdentityOf(model);
        const path = filePathOfModel(model, options.getFilePath);
        const requestIdentity = path === undefined ? identity : { ...identity, path };

        let index: Kojo2ProjectIndex | null = null;
        if (options.getIndex !== undefined) {
          try {
            index = options.getIndex() ?? null;
          } catch {
            index = null;
          }
        }
        // 索引缺席 ⇒ 请求里没有 `projectFiles`（同文件计数，与 B3g 之前逐字相同）。
        const snapshot = projectFilesSnapshotOf(index, path ?? '', options.snapshotLimits ?? {});

        const kernel = requireKernel();
        // 单答裁决在 legs（`collectCodeLensResult` 第一家作答），这里只递请求、翻形状。
        const result = collectCodeLensResult(
          kernel.slots.query('ui.editor.languageService'),
          codeLensRequestOf(requestIdentity, text, kernel.project.current(), snapshot),
        );
        // 无人应答 ⇒ `undefined`（别交空列表去顶掉别家）。
        if (result === undefined) return undefined;
        return { lenses: toMonacoCodeLenses(model, result.lenses), dispose: () => undefined };
      } catch {
        // 注解是只读呈现面：出错就"这一篇没有注解"，绝不把编辑器的输入链带崩
        return emptyList();
      }
    },
  };

  const registration = registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerCodeLensProvider(id, provider),
    // 带能力名：descriptor 的 `slotServices` 点了 `codeLens` 的语言（kojo2）也挂这一枚。
    'codeLens',
  );

  // 幂等：共享收口交回的是"逐门撤一次"的句柄，重复 dispose 会重复撤（旧安装器也是幂等的）。
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
