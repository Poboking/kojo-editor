/**
 * 签名帮助（B5，形参槽语义）——**宿主旧桥**：只服务没把这条腿交给插件的语言（今天 = kojo1 封存层）。
 *
 * **判据已出宿主**（LAU-1031-SIG，2026-10-31）：调用位点解析（哪一个是被调的函数、实参表、
 * 当前第几参、来源文本怎么读）与中性组装整块搬进语言面库 `@kojo/erb-lang/signature`；
 * 本文件只剩三件事——① re-export（旧消费方 `completion-core` / `editor-global-providers` /
 * 单测的 import 点一字不改），② Monaco 协议翻译（`toMonacoSignatureHelp` / 触发字符注册），
 * ③ 旧桥安装器。宿主 UI 不再持有第二份括号模型。
 *
 * **ERB 已让位**：`ERB_DESCRIPTOR.slotServices` 点名了 `signatureHelp`，ERB 的签名由
 * `ui.editor.languageService` 槽的 `erb-signatureHelp` 供方作答（判据同上、两张宿主表经
 * `@kojo/erb-lang/signature` 的取表缝现取）；本安装器按
 * `undefined, { excludeNamed: 'signatureHelp' }` 跳过点名了这一格的语言——**第三参必须是
 * `undefined`**（再传 kind 等于把点名语言重新挂上，"一个 kind 恰一枚 provider"立刻破，
 * 本系列已被这事咬过两次）。挂载口径与 `kojo-hover.ts`（hover）、`erb-highlight.ts`
 * （documentHighlight）等既有用法同形，判据只看 descriptor 声明、不写语言 id。
 *
 * **唯一真源仍是两张宿主表**（`editorTables` 的 `callProtocol` + 解析器索引的形参表，见
 * `ui/editor-global-providers.ts` 的 `erbSignatureTables`）：运行时现取（表随项目开闭重建，
 * 缓存会把上一个项目的表带过来）；表缺席、协议不认识这个函数、或解析抛错 ⇒ **不应答**
 * （不猜）。槽的 `label` 原文照抄进提示，宿主不解释它是什么场景参数。
 *
 * 不应答一律返回 `undefined`（**不返回空 help**）：Monaco 会继续问下一家 provider，
 * 空 `signatures` 数组反而会把这条能力占住又显示不出东西。
 */
import type * as Monaco from './entry';
import type { KojoCallProtocol } from '@kojo/plugin-api';
import { registerForLanguageServices } from './register-dialects';
import { errorText } from '@kojo/plugin-api';
// LAU-4 补全腿第三批：槽标签格式化的**唯一实现**已上提契约层（插件侧拼括号调用骨架要同一份）
import { slotParameterLabel } from '@kojo/plugin-api';
// 判据叶（LAU-1031-SIG）：旧桥与槽供方共读这一份，宿主不持有第二套括号模型。
import type { ResolvedSignature } from '@kojo/erb-lang/signature';

/* ============================== 判据 re-export（住址搬家、消费方零改动） ============================== */

export {
  SIGNATURE_LOOKBACK_LINES,
  describeCallSignature,
  describeErbSignature,
  findCallSite,
  findCallSiteAt,
  resolveSignature,
  resolveSignatureInText,
  splitArguments,
} from '@kojo/erb-lang/signature';
export type {
  CallArgumentSpan,
  CallSignature,
  CallSite,
  ErbFunctionParam,
  ErbFunctionParamsResolver,
  ResolvedSignature,
} from '@kojo/erb-lang/signature';

/**
 * 槽 → 参数标签（re-export，实现住契约层）。
 *
 * 2026-10-31（LAU-4 补全腿第三批）：实现上提 `@kojo/plugin-api` 的 `slotParameterLabel`——
 * 同一个格式化要同时服务签名浮层与插件侧的括号调用骨架，两份实现必然漂移。本处只 re-export，
 * 既有 import 点（`completion-core` / 测试）一字不改。
 */
export { slotParameterLabel };

/* ============================== Monaco 协议翻译（宿主的事，不是判据） ============================== */

/** 宿主注入：这个位置该答什么签名（宿主在此做糖视图判据 + **运行时**现取 adapter 表） */
export interface SignatureHandlers {
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): ResolvedSignature | null;
}

/**
 * 签名帮助要的那张表（`editorTables` 的 additive 字段）：`callProtocol` 缺席 =
 * 项目没开 / adapter 不提供调用协议 ⇒ 整条能力零产出（**不猜**）。
 */
export interface SignatureTables {
  readonly callProtocol?: KojoCallProtocol;
}

/**
 * 触发字符（自定并说明；与槽腿那份 `KOJO2_SIGNATURE_TRIGGER_CHARS` 同值，各自为注册服务）：
 * - `(` —— 进入调用括号，作者正要开始填第一个槽；
 * - `,` —— 换到下一槽（**仅半角**：Emuera 只认半角逗号；全角 `，` 不是分隔符，不触发）。
 * 不列 `)`：右括号意味着这次调用写完了，提示该收而不是该留（Monaco 会把触发字符同时当
 * 重触发字符，无需再声明一遍）。
 */
export const SIGNATURE_TRIGGER_CHARACTERS: readonly string[] = ['(', ','];

/** 中性签名 → Monaco `SignatureHelp`（`activeSignature` 恒 0：一张表只给一张最具体签名） */
export function toMonacoSignatureHelp(hit: ResolvedSignature): Monaco.languages.SignatureHelp {
  const parameters: Monaco.languages.ParameterInformation[] = hit.signature.parameters.map((label) => ({ label }));
  return {
    signatures: [{ label: hit.signature.label, parameters }],
    activeSignature: 0,
    activeParameter: hit.signature.activeParameter,
  };
}

/**
 * 旧桥签名 provider：为**没点名 `signatureHelp`** 的旧桥语言（今天 = kojo1 封存层）注册。
 *
 * `undefined, { excludeNamed: 'signatureHelp' }` 的口径（LAU-1031-SIG 与四件同批的第④件）：
 * descriptor 点名了这格的语言（今天 = ERB 与 kojo2）由**槽腿**那一枚 provider 应答，旧桥
 * 让位；第三参给 `undefined` 而不是 kind——点名语言已经由槽腿挂上，这里再挂就是双挂。
 * kojo1 是待删除物：不点名、继续由本腿应答，不为它做兼容层，也不给它点名。
 */
export function installSignatureHelp(monaco: typeof Monaco, handlers: SignatureHandlers): Monaco.IDisposable {
  const provider: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: SIGNATURE_TRIGGER_CHARACTERS,
    provideSignatureHelp(model, position) {
      let hit: ResolvedSignature | null;
      try {
        hit = handlers.resolve(model, position);
      } catch (e: unknown) {
        console.warn(`[kojo-signature] resolve 抛错：${errorText(e)}`);
        return undefined;
      }
      if (!hit) return undefined;
      return { value: toMonacoSignatureHelp(hit), dispose: () => undefined };
    },
  };
  return registerForLanguageServices(monaco, (m, id) => m.languages.registerSignatureHelpProvider(id, provider), undefined, {
    excludeNamed: 'signatureHelp',
  });
}
