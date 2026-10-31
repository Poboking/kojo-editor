import type * as Monaco from './entry';
import type { ResolvedSignature } from '@kojo/kojo-vocab/signature';
import { registerForLanguageServices } from './register-dialects';
import { errorText } from '@kojo/plugin-api';

/**
 * 签名帮助（B5，形参槽语义）——`Ctrl+Shift+Space` / 打字触发的参数提示。
 *
 * ## 本层只剩「Monaco 翻译 + 注册」，判据一枚都不在（LAU-DUALLEG 车 5，2026-10-31）
 *
 * 判据（调用位 / 实参位 / 分隔符 / 跨行回看 / 两张查表面的组装）整块上提包叶
 * `@kojo/kojo-vocab/signature`——与 `./formatter` 同一形态：**一把尺子，两处消费**。
 * 本文件因此不再导出任何判据，只保留 Monaco 的形状翻译与注册面；需要判据的调用方
 * （`ui/editor-global-providers.ts` 的窗口取文腿、`monaco/completion-core.ts`）
 * 一律直接引那枚包叶。
 *
 * ## 这一枚腿今天只答 kojo1（封存层与糖投影面）
 *
 * ERB 的 `signatureHelp` 已交给插件供方 `@kojo/plugin-erb-lang` 的 `erb-signatureHelp`
 * （判据仍是同一枚包叶），ERB descriptor 的 `slotServices` 点名了 `signatureHelp`，
 * 于是本层的旧桥腿按 `excludeNamed` 让开 ERB ——**这一格此前是双挂**：宿主腿与共享槽腿
 * 挂在同一枚 model 上，同一次请求问两趟，"谁在答"由注册顺序判。让位的前提是槽里先有
 * 认 ERB 的供方（否则让位＝静默没有），所以供方与本改同批落地。
 *
 * 挂载口径与 `kojo-hover.ts` / `kojo-format.ts` 同款：**第三参一律 `undefined`**——给了
 * 能力名就等于把点名了这格的语言再挂回来，前功尽弃。触发字符仍是语言事实：`(` / `,`
 * 两路相同，ERB 不需要另一套，故不另开 descriptor 字段。
 *
 * ## 唯一真源是调用方现取的那两张表
 *
 * ① adapter 的调用协议表（`game.adapter` → `kojoCallProtocol.slotsFor(name)`），
 * ② 协议不认识时的 ERB 用户函数形参（解析器索引）。宿主**运行时现取**（同 `kojo-hover` /
 * `editorTables` 的纪律：表与索引随项目开闭重建，缓存会把上一个项目的带过来）；两表都
 * 缺席 / 都不认识 / 求值抛错 ⇒ **不应答**（不猜）。槽的 `label` 原文照抄进提示。
 */

/**
 * 触发字符（自定并说明）：
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

/** 宿主注入：这个位置该答什么签名（宿主在此做糖视图判据 + **运行时**现取 adapter 表） */
export interface SignatureHandlers {
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): ResolvedSignature | null;
}

/**
 * 为**未把签名腿交给插件**的语言（今天 = kojo1）注册签名帮助 provider。
 *
 * 不应答一律返回 `undefined`（**不返回空 help**）：Monaco 会继续问下一家 provider，
 * 空 `signatures` 数组反而会把这条能力占住又显示不出东西。
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
  return registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerSignatureHelpProvider(id, provider),
    // 第三参必须 `undefined`：给了能力名就会把点名了这一格的语言（ERB）再挂回来，
    // 与 `excludeNamed` 相互抵消 ⇒ 同一门语言上两枚 SignatureHelpProvider。
    undefined,
    { excludeNamed: 'signatureHelp' },
  );
}
