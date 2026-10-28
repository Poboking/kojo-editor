/**
 * `signatureHelp` 供方：包里的签名判据（`@kojo/kojo-lang/signature`）→ 契约的 `EditorSignature`。
 *
 * ## B3d：这一格从"宿主原生 provider"换成了"插件供方"
 *
 * 判据全部住在 `@kojo/kojo-lang/signature`（`kojo2SignatureAt`，行为与搬进包之前的宿主逐字
 * 相同：调用位 / 声明头 / `@巡` 集合名、`activeParameter` 按顶层逗号数并夹到最后一格），
 * 本文件只做**翻译**：中性签名 → 契约条目。Monaco 侧的触发字符（`(` / `,`）、
 * `parameters[].label` 的定位口径与注册都归宿主（触发字符只服务注册，不是判据）。
 *
 * ## 三态（与 definition / inlay / completion 同一条纪律）
 *
 * - **非 kojo2 请求 ⇒ `undefined`（弃权）**：让下一家供方接手，不是"这里没有签名"；
 * - **认这门语言但这一格给不出签名 ⇒ `{ signatures: [] }`**（**不猜**：字符串 / 注释 /
 *   `@原生` / 台词正文、被调名不是同文件声明、声明头未闭合、`@巡` 集合不可解析——全部如实
 *   交回空数组，宿主据此不弹浮层）；
 * - 有签名 ⇒ 一条（同文件名字不重载，`activeSignature` 恒 0）。
 *
 * ## 文档（`documentation`）的去处：**跟着激活的那个形参走**
 *
 * 包里每个形参都带一行事实性说明（`必填` / `默认值：10` / `模板参数：…` / `@巡` 的来源槽）。
 * 契约的 `EditorSignature` 只有**一整条** `documentation`（纯文本）而没有逐参说明位，
 * 而编辑器（Monaco 0.57 的 parameter hints）**本来就只渲染激活那一个形参的说明**——
 * 于是这里把 `params[activeParameter].documentation` 原样提到签名级：屏上文案一个字符没变
 * （同一个 docs 段落、同一句话），只是从 `span.documentation` 挪成段落文本（那枚 span 没有任何
 * 样式规则）。未激活形参的说明在今天也没有任何呈现面，不存在"丢了"。
 *
 * ## adapter：请求时现取 + **只认 id 对得上的那一枚**
 *
 * `@巡 <集合>` 的绑定名讲的是**方言事实**（`foreachCollections`），由 `plugin.ts` 经
 * `@kojo/kojo-lang/adapter-source` 登记表现取并核过 `adapter.id === request.project?.adapterId`
 * 才递进来。对不上 ⇒ 按"没有 adapter"作答：`@巡` 一路 `null`（不给绑定名），其余签名
 * （`! 函(` / 声明头）不依赖 adapter，照给——少给的是那一部分，不拿 A 游戏的集合表解释 B 游戏。
 *
 * ## 抛错面
 *
 * 包内函数是纯函数且对越界自行夹取，理论上不抛；真抛了也不冒到宿主——宿主会把 throw 吞成
 * "提示突然没了"，这里归成 `{ signatures: [] }`（"这一格没有可证明的签名"，有语义的答复）。
 */
import type {
  EditorLanguageServiceRequest,
  EditorSignature,
  EditorSignatureHelpResult,
} from '@kojo/plugin-api';
// 只取**类型**：2.0 adapter 的形状住 core（与 plugin-api 的 v1 `GameAdapter` 不是一个类型），
// 运行时不 import `@kojo/kojo-core`（`completion.ts` / `inlay.ts` / `definition.ts` 同规）。
import type { GameAdapter } from '@kojo/kojo-core';
import { clampActiveParameter, kojo2SignatureAt } from '@kojo/kojo-lang/signature';
import { isKojo2Request } from './request';

/** 可选注入面（缺省 = 没有 adapter 事实 ⇒ `@巡` 一路不答，其余签名照给——不猜） */
export interface SignatureAdapterInjection {
  /** 当前项目的 2.0 adapter（`plugin.ts` 请求时现取并核过 id；对不上 ⇒ `null`） */
  readonly adapter?: GameAdapter | null;
}

/** 一条中性签名 → 契约条目（`parameters` 是形参原文；说明跟着激活位） */
function signatureOf(
  signature: NonNullable<ReturnType<typeof kojo2SignatureAt>>['signatures'][number],
): EditorSignature {
  const activeParameter = clampActiveParameter(signature.activeParameter, signature.params.length);
  const documentation = signature.params[activeParameter]?.documentation;
  return {
    label: signature.label,
    parameters: signature.params.map((param) => param.label),
    activeParameter,
    ...(documentation === undefined ? {} : { documentation }),
  };
}

/**
 * 交回 `{ kind: 'signatureHelp', signatures }`，或 `undefined`（弃权：不是 signatureHelp /
 * 不是 kojo2）。空数组 = 认这门语言、这一格没有签名（宿主不弹浮层）。
 */
export function provideSignatureHelp(
  request: EditorLanguageServiceRequest,
  injection: SignatureAdapterInjection = {},
): EditorSignatureHelpResult | undefined {
  if (request.kind !== 'signatureHelp') return undefined;
  if (!isKojo2Request(request)) return undefined;
  try {
    const help = kojo2SignatureAt(
      request.text,
      { line: request.line, column: request.column },
      { adapter: injection.adapter ?? null },
    );
    if (help === null) return { kind: 'signatureHelp', signatures: [] };
    return {
      kind: 'signatureHelp',
      signatures: help.signatures.map(signatureOf),
      activeSignature: help.activeSignature,
    };
  } catch {
    return { kind: 'signatureHelp', signatures: [] };
  }
}

// 形状与 legs 的 `signatureRequestOf` 对齐（供宿主接线时核对）：本供方读的字段恰是
// `text` / `line` / `column`（+ 弃权判定用的 `languageId` / `path`）与 `project.adapterId`，
// 其余格（`version` / `lineCount`）零消费、零依赖。
