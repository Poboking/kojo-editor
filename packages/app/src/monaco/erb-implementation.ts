import type * as Monaco from './entry';
import {
  createDefinitionModelResolver,
  provideLocations,
  type DefinitionHandlers,
  type DefinitionLocation,
} from './kojo-definition';
import { registerForLanguageServices } from './register-dialects';

/**
 * 跳到实现（R3 残项 2026-10-16；W9 落点 span 批 2026-10-17 收口；ERB-PARITY G3 2026-10-31 进槽）。
 *
 * ## 数据源（零第二份判据）
 *
 * **ERB 的实现 = 这个名字的定义位**，而"名字 → 定义位"的判据只有一份：
 * `ui.editor.languageService` 槽里 `kind: 'implementation'` 的供方（ERB 由解析器插件
 * `@kojo/plugin-erb-parser` 的 `provideErbDefinition` 答，返回序与 `definition` 逐字相同：
 * 标签 > `#DIM` 声明 > 函数索引）。
 *
 * G3 之前本模块高级复用 `kind: 'definition'` 那条腿：宿主里"Ctrl+F12 用哪条请求"和
 * "F12 用哪条请求"是同一个字面量 ⇒ **"这门语言没有实现面"无处表达**（kojo2 就是这种：
 * 能力矩阵里明写不做、F12 已覆盖）。现在两条腿各自发自己的 `kind`：宿主这一侧**只有**
 * 请求装配与落点编排，没有一行"实现该怎么算"。
 *
 * ## 交付通道（与转到定义共享**落地**，不是共享**取数**）
 *
 * `provideLocations` 是 `installDefinitionProvider` 内部那一次请求的落地腿（分腿判据
 * `planDefinitionJump` + 链接构造 `toDefinitionLinks` + 落点夹取 `clampRevealPosition`）——
 * 两条 provider 共用它是**落点口径只有一份**（这套判据与语言无关），取数（`resolve`）则由
 * 装配点分别给：`readImplementationTargets` 发 `kind: 'implementation'`。
 * - 全**部目标有 live model ⇒ 返回真 `LocationLink[]`（`Ctrl+F12` 就地跳、Peek 有数据）；
 * - 有目标没开标签 ⇒ 发 `editor.revealLocation`（宿主既有导航通道，零新机制）；
 * - 没有实现 ⇒ 不应答（Monaco 提示"未找到实现"）。
 *
 * **不注册第二枚 editor opener**：`registerEditorOpener` 全进程只认最后一位注册者，
 * 重复注册既不会更准，还会把转到定义那枚顶掉；跨 model 的落地通道两者逐字相同，
 * 由 `installDefinitionProvider` 注册的那一枚统一接（装配层两个 provider 一起装，
 * 见 `EditorPane.tsx` 的 `definitionDisposer` / `implementationDisposer`）。
 *
 * 注册面由**描述符**决定（`registerForLanguageServices(…, 'implementation')`）：ERB 方言族
 * （`.erb` / `.erh` / `.erd` 都挂在 `ERB_LANGUAGE_ID` 上）声明了全腿所以照挂；点名
 * `slotServices: ['implementation']` 的语言将来也会自动挂上；kojo2 不点名 ⇒ 不挂
 * （它的 `Ctrl+F12` 与改动前一样没有 provider，这是矩阵里记下的决定，不是遗漏）。
 */

/**
 * 装配点必须交的**两枚取数口**（不是"两套判据"）：
 * - `resolveImplementation`：位置 → 实现目标（宿主在此查 `kind: 'implementation'` 那条槽腿）；
 * - 其余字段与 `DefinitionHandlers` 同源（落地、开着的 model 反查、Peek 建 model）。
 *
 * 为什么 `resolve` 与 `resolveImplementation` 必须分开写：合并成一个字段就等于允许装配点
 * "顺手把定义那条腿接给实现"——G3 之前正是这样，于是"哪条腿在答"取决于宿主而不可见。
 * `resolve` 仍继承自 `DefinitionHandlers`（`provideLocations` 只认它），本模块在调用前把
 * `resolveImplementation` **换进** `resolve` 那一格，取数路径只有一条。
 */
export interface ImplementationHandlers extends DefinitionHandlers {
  /** 位置 → 实现目标（查 `kind: 'implementation'` 的供方；返回空数组 = 此处没有实现） */
  resolveImplementation(model: Monaco.editor.ITextModel, position: Monaco.Position): DefinitionLocation[];
}

/**
 * 为声明了 `implementation` 腿的语言注册 ImplementationProvider（今天 = ERB 方言族）。
 * 多定义（重名函数）全给——Peek 列表就是那个选择器，取舍与转到定义逐字一致
 * （落地判据本来就是同一组函数）。
 */
export function installImplementationProvider(
  monaco: typeof Monaco,
  handlers: ImplementationHandlers,
  label = 'erb-implementation',
): Monaco.IDisposable {
  const findModel = createDefinitionModelResolver(handlers, label);
  // 取数口换成本语言服务腿的那一枚；落地腿（plan / links / clamp）与 definition 共用。
  const landingHandlers: DefinitionHandlers = {
    ...handlers,
    resolve: (model, position) => handlers.resolveImplementation(model, position),
  };
  const provider: Monaco.languages.ImplementationProvider = {
    provideImplementation(model, position) {
      return provideLocations(landingHandlers, findModel, model, position, label);
    },
  };
  return registerForLanguageServices(monaco, (m, id) => m.languages.registerImplementationProvider(id, provider), 'implementation');
}