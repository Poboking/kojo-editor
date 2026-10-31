/**
 * ERB 的**选择范围**：**契约 → Monaco SelectionRange 的翻译层**
 * （LAU-4 第一步，2026-10-30；供方交给插件 `@kojo/plugin-erb-lang`）。
 *
 * ## 这一格里只剩"翻译"，层级判据一枚都不留
 *
 * 本文件曾同时住着**层级判据**（词 → 行 → 分支段 → ERB 标签块（可多级）→ 函数块 → 全文，
 * 以及死区不扩 / 越界显式空 / 行末光标取左侧词这些边界）、一枚 provider 安装器与形状翻译。
 * LAU-4 把判据整块搬进 `@kojo/erb-lang/selection-range`，作答的是插件
 * `@kojo/plugin-erb-lang` 在 `ui.editor.languageService` 槽里登记的 `erb-selectionRange` 贡献。
 *
 * 这里若再留一份层级当"兜底"，同一格就有两份答案：Monaco 只认一个 provider 的扩选链，
 * "按一下扩到哪一级"从此只能靠注册顺序解释。
 *
 * ## 留下的三件事
 *
 * 1. **model → 请求**：全文 + **全部位点**（Monaco 多光标一次就问多个）+ 身份三格 + 项目；
 *    位点原样递（1 基，与 `Position` 同列口径），宿主不排序、不夹取；
 * 2. **响应 → Monaco 0.57 的扁平数组**：契约给的是经典嵌套链 `{ range, parent? }`（最内层
 *    在前，`parent` 逐级向外），而 0.57 的 provider 入参形状是"**每位点一个
 *    `SelectionRange[]`**（内 → 外）"——摊平**只在这一层做**（换 Monaco 版本只动这里）。
 *    契约里的 `null`（该位点空链）摊成空数组：**不夹取、不猜**，也绝不缩短别的位点；
 * 3. **注册**：经 `registerForLanguageServices(monaco, register, undefined, { excludeNamed:
 *    'selectionRange' })` 挂上——DOUBLE-LEG-1032（2026-10-31）起点名了这一格的语言让位
 *    （ERB / kojo2 由共享槽腿那一枚应答），本腿只留 `.kojo1`。当年那枚直挂 `ERB_LANGUAGE_ID`
 *    的原生安装器已随批删除。
 *
 * ## 三态
 *
 * 无人应答（插件没装 / 弃权）⇒ **`undefined`**（不是 `[]`）——这一格 Monaco 会把所有
 * provider 的答案并起来（还恒有内建词语扩选兜底），所以空表本身不致命；但"没人应答"
 * 就不该由本层伪造一份空作答（那是把"没有这条能力"说成"这条能力说没有"）。
 * 作答但某位点 `null` ⇒ 该位点 `[]`，其余位点照常；provider 内异常 ⇒ `[]`。
 *
 * ## 开关
 *
 * 结构化扩选是**只读呈现面**（K2-SURFACE-DEFAULT）：不读切流开关，装配即注册。
 */
import type * as Monaco from './entry';
import type { EditorSelectionChain } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import { ERB_LANGUAGE_ID } from './erb-language';
import {
  collectSelectionRanges,
  editorRequestIdentityOf,
  modelTextOf,
  selectionRangeRequestOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

/* ============================== Monaco 翻译层 ============================== */

/** 契约链 → 0.57 provider 的扁平数组（内 → 外；运行时自己会按包含关系再排一遍） */
function flattenChain(chain: EditorSelectionChain): Monaco.languages.SelectionRange[] {
  const out: Monaco.languages.SelectionRange[] = [];
  let cursor: EditorSelectionChain | undefined = chain;
  while (cursor !== undefined) {
    out.push({
      range: {
        startLineNumber: cursor.range.startLine,
        startColumn: cursor.range.startColumn,
        endLineNumber: cursor.range.endLine,
        endColumn: cursor.range.endColumn,
      },
    });
    cursor = cursor.parent;
  }
  return out;
}

/* ============================== 安装 ============================== */

/** DOUBLE-LEG-1032 之后本腿只挂在 `.kojo1` 上；挂载面 ≠ 应答面：糖投影 model 的行号属
 *  派生物，宿主先按 model 语言弃权（老桩 model 没有 `getLanguageId` ⇒ 保持旧行为）。 */
function servesErb(model: Monaco.editor.ITextModel): boolean {
  try {
    const id = model.getLanguageId();
    return typeof id !== 'string' || id.length === 0 || id === ERB_LANGUAGE_ID;
  } catch {
    return true;
  }
}

/**
 * 为声明了通用语言服务的语言注册选择范围 provider，返回**幂等** disposable。
 *
 * - **无条件注册**（K2-SURFACE-DEFAULT：结构化扩选是只读呈现面，不读切流开关）；
 * - 注册经共享收口 + 能力名 `selectionRange`；
 * - provider 内任何异常回 `[]`；
 * - 注册失败原样外抛（共享收口已把半途挂上的逐枚撤回）。
 */
export function installErbSelectionRangeProvider(monaco: typeof Monaco): Monaco.IDisposable {
  const provider: Monaco.languages.SelectionRangeProvider = {
    provideSelectionRanges(model, positions) {
      try {
        if (!servesErb(model)) return undefined;
        const text = modelTextOf(model);
        if (text === null) return [];
        const wanted = Array.isArray(positions)
          ? positions.map((position) => ({ line: position.lineNumber, column: position.column }))
          : [];
        const kernel = requireKernel();
        const result = collectSelectionRanges(
          kernel.slots.query('ui.editor.languageService'),
          selectionRangeRequestOf(
            editorRequestIdentityOf(model),
            text,
            wanted,
            kernel.project.current(),
          ),
        );
        if (result === undefined) {
          // 无人应答：交 `undefined`（不伪造一份"没有扩选"的作答）。
          return undefined;
        }
        return result.selections.map((chain) => (chain === null ? [] : flattenChain(chain)));
      } catch {
        return [];
      }
    },
  };

  // 注册失败原样外抛：`registerForLanguageServices` 已把半途挂上的逐枚撤回（见 register-dialects.ts）。
  // DOUBLE-LEG-1032（2026-10-31）：挂载口径改为 `excludeNamed: 'selectionRange'`——
  // 点名了这一格的语言（ERB / kojo2）由共享槽腿那一枚应答（同一枚槽、同一条 collect、同一份
  // 三态），本宿主纯翻译腿不再叠第二枚；只留 `.kojo1` 那门不点名的旧桥语言。
  const registration = registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerSelectionRangeProvider(id, provider),
    undefined,
    { excludeNamed: 'selectionRange' },
  );

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛 */
      }
    },
  };
}
