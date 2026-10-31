/**
 * `signatureHelp` 供方：包里的签名判据（`@kojo/erb-lang/signature`）→
 * 契约的 `EditorSignatureHelpResult`（LAU-1031-SIG，2026-10-31）。
 *
 * ## 这一格回答什么
 *
 * ERB 里敲 `@函数(` / `CALL F(` 时的参数浮层：**谁在被调、实参表、光标在第几参**的判据
 * 全在语言面库（与宿主旧桥共读同一份，不存在第二套括号模型）；本文件只做语言分派、
 * 两张宿主表的现取与契约形状搬运。
 *
 * ## 两张表从哪来（宿主事实，请求时现取）
 *
 * adapter 调用协议（槽语义）与 ERB 用户函数形参（解析器索引）都只有宿主持有，
 * 经 `@kojo/erb-lang/signature` 的**模块级登记表**（范式照 `@kojo/kojo-lang/adapter-source`）
 * 交出 getter，本供方每次请求问一次——表随项目开闭重建，缓存会把上一个项目的表带过来。
 * 零登记（项目没开 / 装配没跑到）⇒ 空表 ⇒ 作答空（"这里给不出签名"），**不猜**。
 *
 * ## 三态（与 kojo2 的 `provideSignatureHelp` 同一条纪律）
 *
 * - **非 ERB 请求 ⇒ `undefined`（弃权）**：让下一家供方接手，不是"这里没有签名"；
 * - **认这门语言但这一格给不出签名 ⇒ `{ signatures: [] }`**（作答空：注释行 / 字符串里 /
 *   括号外、两表皆不认识——宿主据此不弹浮层，也**不再问下一家**）；
 * - 有签名 ⇒ 一条（一张表只给一张最具体签名，`activeSignature` 恒 0）。
 *
 * ## 窗口（击键路径的账）
 *
 * `erbSignatureAt` 自带回看封顶（`SIGNATURE_LOOKBACK_LINES`）的窗口切分：整篇 `split`
 * 每键都要付一次，5 万行档不可接受（PS-4 ③ 旧桥用 `getValueInRange` 干的是同一件事）。
 *
 * ## 抛错面
 *
 * 判据是纯函数且对越界自行夹取，理论上不抛；真抛了也不冒到宿主——宿主会把 throw 吞成
 * "提示突然没了"，这里归成 `{ signatures: [] }`（"这一格没有可证明的签名"，有语义的答复）。
 */
import type { EditorLanguageServiceRequest, EditorSignatureHelpResult } from '@kojo/plugin-api';
import { erbSignatureAt, erbSignatureNow, type ErbSignatureTables } from '@kojo/erb-lang/signature';
import { isErbRequest } from './request';

/** 可选注入面（只为可单测）：缺省 = 请求时经登记表现取两张宿主表 */
export interface ErbSignatureInjection {
  readonly tables?: ErbSignatureTables;
}

/**
 * 交回 `{ kind: 'signatureHelp', signatures }`，或 `undefined`（弃权：不是这个 kind /
 * 不是 ERB）。空数组 = 认这门语言、这一格没有可证明的签名（宿主不弹浮层）。
 */
export function provideErbSignatureHelp(
  request: EditorLanguageServiceRequest,
  injection: ErbSignatureInjection = {},
): EditorSignatureHelpResult | undefined {
  if (request.kind !== 'signatureHelp') return undefined;
  if (!isErbRequest(request)) return undefined;
  try {
    const tables = injection.tables ?? erbSignatureNow();
    const hit = erbSignatureAt(request.text, request.line, request.column, tables);
    if (hit === null) return { kind: 'signatureHelp', signatures: [] };
    return {
      kind: 'signatureHelp',
      signatures: [
        {
          label: hit.signature.label,
          parameters: hit.signature.parameters,
          activeParameter: hit.signature.activeParameter,
        },
      ],
      activeSignature: 0,
    };
  } catch {
    return { kind: 'signatureHelp', signatures: [] };
  }
}
