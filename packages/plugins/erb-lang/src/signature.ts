/**
 * `signatureHelp` 供方（LAU-DUALLEG 车 5，2026-10-31）：ERB 的签名帮助从宿主旧桥腿手里接过来。
 *
 * ## 判据住哪儿：`@kojo/kojo-vocab/signature`，不在本文件
 *
 * 调用位 / 实参位 / 分隔符 / 跨行回看 / 两张查表面的组装一律是包叶里那**一把尺子**——
 * 它与 `.kojo1`（封存层与糖投影面）本来就是同一套 Emuera 括号语法，宿主那条腿今天还在用
 * 它。在插件里另写一份就是"列表里看到的"与"浮层里看到的"分家漂移的第一天，所以本文件只做
 * 三件搬运：认请求、备事实、把 `ResolvedSignature` 翻成契约的 `EditorSignature`。
 * 与 `./formatting.ts`（判据在 `@kojo/kojo-vocab/formatter`）同一形态。
 *
 * ## 为什么住 `@kojo/plugin-erb-lang` 而不是常驻的 `@kojo/plugin-erb-parser`
 *
 * `erb-parser` 是 `bootstrap.ts` 的两个**常驻**插件之一，判据落它会往开机静态图加钱
 * （第七波收官时余量只剩几十 B）。本插件是**懒装载**的语言面供方，判据照样一份、开机图
 * 一分不涨——这与 `erb-formatting` 同一条理由。
 *
 * ## 两张表都是**请求时现取**（缓存会把上一个项目的带过来）
 *
 * ① `callProtocol`：`game.adapter` 槽按 `request.project.adapterId` 精确匹配
 *    （`plugin-api` 的 `activeGameAdapter`，与宿主 `editorTables` 同一条判据）；
 * ② ERB 用户函数形参：`erb.parser` 服务的 `currentIndex()`，按**归一化名**（大写）取第一条
 *    定义、再按定义行在同一份文件里找回那个函数体拿 `params` 原文。
 * 两路都软取：读不到 ⇒ 那一路零产出，绝不让整条签名腿抛进击键路径。
 *
 * ## 三态（`undefined`＝弃权 / 空数组＝作答，与 kojo2 那家 `kojo2-signatureHelp` 同一口径）
 *
 * - 非 `signatureHelp` / 非 ERB 请求 ⇒ `undefined`（**弃权**，让下一家接手）；
 * - 认这门语言但这一格给不出签名 ⇒ `{ signatures: [] }`（**不猜**：注释行、字符串字面量里、
 *   光标不在未闭合括号内、协议与形参表都不认识这个被调名——如实交回空表，宿主据此不弹浮层）；
 * - 有签名 ⇒ 一条（一张表只给一张最具体签名，`activeSignature` 恒 0）。
 *
 * 为什么这里交空表而不是像旧桥腿那样交 `undefined`：槽腿的裁决是"第一家作答就算数"，
 * 交空表说的是"这篇我认、这一格没话说"，与"插件没装载"（无人应答）分得开——铁律 4。
 * 判据内部抛错按"这一格没话说"收（同 kojo2 那家）：本 kind 没有格式化那样的降级台账位，
 * 把抛错伪装成弃权反而会让 Monaco 去问一家根本不存在 Provider。
 */
import type {
  EditorLanguageServiceRequest,
  EditorSignature,
  EditorSignatureHelpResult,
  ErbFunctionRef,
  ErbIndex,
  GameAdapter,
  KojoCallProtocol,
} from '@kojo/plugin-api';
import {
  type ErbFunctionParam,
  resolveSignatureInText,
} from '@kojo/kojo-vocab/signature';
import { isErbRequest } from './request';

/** 供方从宿主侧现取的两张表（都由调用方给闭包，本函数不读盘、不碰项目生命周期） */
export interface ErbSignatureDeps {
  /** 当前项目 adapter 的调用协议表（槽语义）；缺席 / 对不上 ⇒ `undefined` = 这一路零产出 */
  readonly callProtocol?: () => KojoCallProtocol | undefined;
  /** 当前这轮的 ERB 解析器索引；缺席 / 在途 ⇒ `null` = 用户函数形参那一路零产出 */
  readonly index?: () => ErbIndex | null;
}

/**
 * 按被调者名取 ERB 用户函数形参（第二查表面）。
 *
 * 名字解析口径与索引侧一致：**归一化＝大写**（Emuera 函数名大小写不敏感），取聚合顺序
 * 第一条定义，再在该文件里按 `startLine` 找回函数体——`ErbFunctionRef` 只带位置不带形参，
 * 形参原文在 `ErbFunction.params` 上。查不到 ⇒ `null`（**不猜**：既不造 `ARG:n` 兜底名，
 * 也不按实参个数猜形参个数）。
 */
export function erbParamsOf(index: ErbIndex | null, callee: string): readonly ErbFunctionParam[] | null {
  if (index === null) return null;
  const ref: ErbFunctionRef | undefined = index.byName.firstOf(callee.toUpperCase());
  if (ref === undefined) return null;
  const fn = index.files.get(ref.filePath)?.functions.find((f) => f.startLine === ref.startLine);
  return fn ? fn.params : null;
}

/** `ResolvedSignature` → 契约条目（`label` 与 `parameters` 逐字一致，宿主按参数标签定位高亮） */
function toEditorSignature(hit: ReturnType<typeof resolveSignatureInText>): EditorSignature | null {
  if (hit === null) return null;
  return {
    label: hit.signature.label,
    parameters: hit.signature.parameters,
    activeParameter: hit.signature.activeParameter,
  };
}

/**
 * 交回 `{ kind: 'signatureHelp', signatures }`，或 `undefined`（弃权：不是 signatureHelp /
 * 不是 ERB）。空数组 = 认这门语言、这一格没有可证明的签名（宿主不弹浮层）。
 */
export function provideErbSignatureHelp(
  request: EditorLanguageServiceRequest,
  deps: ErbSignatureDeps = {},
): EditorSignatureHelpResult | undefined {
  if (request.kind !== 'signatureHelp') return undefined;
  if (!isErbRequest(request)) return undefined;
  try {
    const protocol = deps.callProtocol?.();
    const hit = resolveSignatureInText(
      request.text,
      request.line,
      request.column,
      protocol,
      deps.index === undefined ? undefined : (callee) => erbParamsOf(deps.index?.() ?? null, callee),
    );
    const signature = toEditorSignature(hit);
    return { kind: 'signatureHelp', signatures: signature === null ? [] : [signature] };
  } catch {
    return { kind: 'signatureHelp', signatures: [] };
  }
}

/** adapter 的调用协议表（`game.adapter` 槽贡献上的 `kojoCallProtocol`；缺席 ⇒ `undefined`） */
export function callProtocolOf(adapter: GameAdapter | null | undefined): KojoCallProtocol | undefined {
  return adapter?.kojoCallProtocol;
}
