import type * as Monaco from './entry';
import {
  createDefinitionModelResolver,
  provideLocations,
  type DefinitionHandlers,
} from './kojo-definition';
import { registerForLanguageServices } from './register-dialects';

/**
 * 跳到实现（R3 残项 2026-10-16；W9 落点 span 批 2026-10-17 收口）——`Ctrl+F12` / Peek Implementation。
 *
 * ## 数据源（零第二份计算）
 *
 * **实现 = 这个名字的定义位**，而"名字 → 定义位"的判据早就有一份权威的：
 * `ui.editor.languageService` 槽里 `kind: 'definition'` 的供方（ERB 由解析器答、
 * `.kojo` 由表层 DSL 线答）。本模块此前绕过槽直读 `ErbIndex.byName`，等于在宿主里
 * 又算一遍同一件事——两份算法必然漂（一份认糖里的函数头、一份只认 `@` 行；
 * 一份带列、一份只带行）。现在**只问槽**：宿主一行取数都不做。
 *
 * "引擎系统函数没有实现"这个真话也照旧成立：供方给不出定义位就是给不出，
 * `provideLocations` 收到空数组 ⇒ 不应答 ⇒ Monaco 提示"未找到实现"。
 *
 * ## 交付通道（与转到定义**同一条腿**，不是"同构的另一条"）
 *
 * `provideLocations` 就是 `installDefinitionProvider` 内部那一次请求的整条腿
 * （分腿判据 `planDefinitionJump` + 链接构造 `toDefinitionLinks` + 落点夹取
 * `clampRevealPosition`），本模块把它转接给 ImplementationProvider：
 * - 全部目标有 live model ⇒ 返回真 `LocationLink[]`（`Ctrl+F12` 就地跳、Peek 有数据）；
 * - 有目标没开标签 ⇒ 发 `editor.revealLocation`（宿主既有导航通道，零新机制）；
 * - 没有定义 ⇒ 不应答。
 *
 * **不注册第二枚 editor opener**：`registerEditorOpener` 全进程只认最后一位注册者，
 * 重复注册既不会更准，还会把转到定义那枚顶掉；跨 model 的落地通道两者逐字相同，
 * 由 `installDefinitionProvider` 注册的那一枚统一接（装配层两个 provider 一起装，
 * 见 `EditorPane.tsx` 的 `definitionDisposer` / `implementationDisposer`）。
 *
 * 注册面与转到定义**拉平**：ERB 方言族（`.erb` / `.erh` / `.erd` 都挂在
 * `ERB_LANGUAGE_ID` 上）+ `.kojo`（`KOJO_LANGUAGE_ID`）——此前只注册给 ERB，
 * 于是 `Ctrl+F12` 在 `.kojo` 里**无人应答**，而同一个位置 F12 答得出来。
 */

/**
 * 与转到定义同一个 handlers 形状（`DefinitionHandlers`）：
 * `resolve` 问槽、`navigate` 发总线、`openModelFor` / `pathForUri` 查宿主的标签表。
 * 别名只是给装配层一个读得懂的名字——**不是**第二套判据。
 */
export type ImplementationHandlers = DefinitionHandlers;

/**
 * 为 ERB 方言族与 `.kojo` 注册 ImplementationProvider。
 * 多定义（重名函数）全给——Peek 列表就是那个选择器，取舍与转到定义逐字一致
 * （本来就是同一个函数）。
 */
export function installImplementationProvider(
  monaco: typeof Monaco,
  handlers: ImplementationHandlers,
  label = 'erb-implementation',
): Monaco.IDisposable {
  const findModel = createDefinitionModelResolver(handlers, label);
  const provider: Monaco.languages.ImplementationProvider = {
    provideImplementation(model, position) {
      return provideLocations(handlers, findModel, model, position, label);
    },
  };
  return registerForLanguageServices(monaco, (m, id) => m.languages.registerImplementationProvider(id, provider));
}
