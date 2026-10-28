/**
 * Kojo 2.0 的签名帮助：**契约 → Monaco 的翻译层**（B3d，2026-10-28 供方交给插件）。
 *
 * ## 这一格里只剩"翻译"，判据一枚都不留
 *
 * 本文件曾经同时住着三类东西：**语言判据**（调用位 / 声明头 / `@巡` 集合名 / 顶层逗号数 /
 * 夹取口径 / 跨行回看的 64 行窗口）、**供方编排**与 **Monaco 协议翻译 + 注册**。B3d 把判据
 * 整块搬走：唯一落点是 `@kojo/kojo-lang/signature`（`kojo2SignatureAt`），作答的是插件
 * `@kojo/plugin-kojo-lang` 在 `ui.editor.languageService` 槽里登记的 `kojo2-signatureHelp` 贡献。
 * 这里若再留一份判据当"兜底"，同一格就有两份答案（Monaco 的多 provider 合并顺序不可控，
 * "提示有时对有时不对"从此只能靠注册顺序解释）。
 *
 * ## 留下的三件事，每一件都是"插件看不到"的宿主事实
 *
 * 1. **model → 请求**：`path` / `languageId` / `version` 原样取自 model（宿主不改写、不猜）、
 *    全文、光标位点，以及当前项目（项目事实只在内核里）。构造一律走 legs 的
 *    `signatureRequestOf` / `editorRequestIdentityOf` / `modelTextOf`——与补全 / 悬停 / 格式化
 *    同源，手抄一份就有一条腿会漏 `version`（供方的过期复核随之失效）。
 * 2. **响应 → Monaco 协议**：契约的 `EditorSignature`（`label` + `parameters: string[]` +
 *    `activeParameter` + 一整条纯文本 `documentation`）→ Monaco 的 `SignatureInformation`。
 *    形参标签**原样**交给 Monaco：它拿标签在整条签名串上做定位高亮，本层不重排、不改写。
 * 3. **触发字符**：`(` / `,`（自定并说明，见下）。这是**注册期**的语言知识，随 provider 一起
 *    挂上；B3d 把它留在这里而不是搬进包叶再让宿主 import——那会为一个常量多拖一枚模块进
 *    开机图，而触发字符只服务注册、不参与任何应答判据。
 *
 * ## 三态（与补全 / 悬停同一套）
 *
 * - 槽里无人应答（插件没装 / 弃权）⇒ `undefined`：Monaco 会继续问下一家（例如 v1 那条
 *   additive 签名面），**不**用空结果把它顶掉；
 * - 有人作答但列表为空（认这门语言、这一格没有签名）⇒ `undefined`：不弹浮层，也不再问下一家
 *   （单答裁决已在 legs 收口）；
 * - 有签名 ⇒ 一条 `SignatureHelp`。
 *
 * ## 注册：共享收口 + 能力名
 *
 * 经 `registerForLanguageServices(monaco, register, 'signatureHelp')` 挂上：它覆盖每一门
 * `languageServices: true` 的语言，**并上** descriptor 的 `slotServices` 点了这一枚能力名的
 * 语言（kojo2 由 `monaco/languages.ts` 点名）。当年那枚"注册调用第一个参数直接写死
 * `KOJO2_LANGUAGE_ID`"的自建注册已删除（闸门正是按那条形状 grep 归零的）。
 *
 * 落到 ERB / kojo1 上的这一枚不会抢它们的话语权：插件对非 kojo2 请求**弃权**，本层交回
 * `undefined`；而它们自己的签名 provider（`kojo-signature.ts`）是**后注册**的，Monaco 的
 * provider 顺序是"同分同档时后注册在前"，所以真被问到第一家的是那枚——两门语言零改动。
 *
 * ## 失败面
 *
 * 取文失败（模型已释放）/ 内核未就绪（`requireKernel` 抛）/ 编排抛 ⇒ `undefined`
 * （不弹提示）。Monaco 把 provider 的 throw 吞成"这个功能突然没了"，作者读不出任何原因；
 * 单枚贡献自己抛错由 legs 的 `provideOf` 隔离（warn 带贡献 id）。
 */
import type * as Monaco from './entry';
import type { EditorSignature } from '@kojo/plugin-api';
import { requireKernel } from '../ui/editor-pane-registry';
import {
  collectSignatureHelp,
  editorRequestIdentityOf,
  modelTextOf,
  signatureRequestOf,
} from './kojo-language-service-legs';
import { registerForLanguageServices } from './register-dialects';

/* ============================== 触发字符 ============================== */

/**
 * 签名帮助触发字符（自定并说明）：
 * - `(` —— 刚进调用括号，作者正要填第一个形参；
 * - `,` —— 换到下一个形参（**仅半角**：2.0 的实参分隔符是半角逗号，全角 `，` 不是分隔符）。
 *
 * 不列 `)`：右括号意味着这次调用写完了，提示该收而不是该留。
 *
 * 这一格**只服务注册**（"哪些字符算触发"是编辑器协议的一部分），不是应答判据——
 * 判据在 `@kojo/kojo-lang/signature`，所以它留在这里、不进包叶。
 */
export const KOJO2_SIGNATURE_TRIGGER_CHARS: readonly string[] = Object.freeze(['(', ',']);

/** 安装器的注入面（additive；真机上不传，测试用它把"合并去重"单测起来）。 */
export interface Kojo2SignatureProviderOptions {
  /**
   * 既有触发字符清单（additive）：与 {@link KOJO2_SIGNATURE_TRIGGER_CHARS} **合并去重**后
   * 再挂给 provider。同语言多枚 provider 时 Monaco 自己也会并集触发字符，这一格只是把
   * "合并去重"做成可单测的纯函数，不依赖 Monaco 的内部顺序。
   */
  readonly extraTriggerCharacters?: readonly string[];
}

/** 合并触发字符清单并去重（保持先出现者顺序；空串 / 非字符串丢弃）。 */
export function mergeTriggerCharacters(
  base: readonly string[],
  extra: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const ch of [...base, ...(extra ?? [])]) {
    if (typeof ch !== 'string' || ch.length === 0 || seen.has(ch)) continue;
    seen.add(ch);
    merged.push(ch);
  }
  return merged;
}

/* ============================== 契约 → Monaco ============================== */

/** `activeSignature` 夹进签名表的合法下标（空表恒 0；编辑器越过只渲染成"无高亮"）。 */
function clampActiveSignature(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), count - 1);
}

/**
 * 契约签名 → Monaco `SignatureHelp`。
 *
 * - `parameters` 只带 `label`：形参的**说明**在契约里是签名级的一枚纯文本（供方已把
 *   "激活那个形参"的说明提到这一层——Monaco 本来也只渲染激活位的说明，屏上文案逐字不变），
 *   所以这里落成 `SignatureInformation.documentation`；
 * - 顶层 `activeParameter` 取当前激活签名的那一格（Monaco 的协议字段在顶层）；
 * - 空表 ⇒ `undefined`（不返回空 help 把提示占住）。
 */
export function toMonacoSignatureHelp(
  signatures: readonly EditorSignature[],
  activeSignature = 0,
): Monaco.languages.SignatureHelp | undefined {
  if (signatures.length === 0) return undefined;
  const active = clampActiveSignature(activeSignature, signatures.length);
  const converted: Monaco.languages.SignatureInformation[] = signatures.map((signature) => ({
    label: signature.label,
    parameters: signature.parameters.map((label) => ({ label })),
    activeParameter: signature.activeParameter,
    ...(signature.documentation === undefined ? {} : { documentation: signature.documentation }),
  }));
  return {
    signatures: converted,
    activeSignature: active,
    activeParameter: converted[active]?.activeParameter ?? 0,
  };
}

/* ============================== 安装 ============================== */

/**
 * 注册**签名帮助** provider（槽腿，能力名 `signatureHelp`），返回**幂等** disposable。
 *
 * 无条件注册（K2-SURFACE-DEFAULT：签名帮助是只读语言面，不读切流开关）；不传注入面
 * （adapter 由插件经 `@kojo/kojo-lang/adapter-source` 现取并核 id——`@巡` 的集合事实只在
 * 那一侧）。注册半途抛错 ⇒ 先撤回已挂上的再外抛。
 */
export function installKojo2SignatureHelpProvider(
  monaco: typeof Monaco,
  options: Kojo2SignatureProviderOptions = {},
): Monaco.IDisposable {
  const provider: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: mergeTriggerCharacters(
      KOJO2_SIGNATURE_TRIGGER_CHARS,
      options.extraTriggerCharacters,
    ),
    provideSignatureHelp(model, position) {
      try {
        const text = modelTextOf(model);
        if (text === null) return undefined;
        const kernel = requireKernel();
        // 单答裁决在 legs（`collectSignatureHelp` 第一家作答），这里只递请求、翻形状。
        const signatures = collectSignatureHelp(
          kernel.slots.query('ui.editor.languageService'),
          signatureRequestOf(
            editorRequestIdentityOf(model),
            text,
            position.lineNumber,
            position.column,
            kernel.project.current(),
          ),
        );
        if (signatures === undefined) return undefined;
        const help = toMonacoSignatureHelp(signatures);
        return help === undefined ? undefined : { value: help, dispose: () => undefined };
      } catch {
        // 抛错的另一面是"提示突然没了"；`undefined` 是 Monaco 读得懂的"这次不应答"。
        return undefined;
      }
    },
  };

  const registrations: Monaco.IDisposable[] = [];
  try {
    registrations.push(
      registerForLanguageServices(
        monaco,
        (m, id) => m.languages.registerSignatureHelpProvider(id, provider),
        // 带能力名：descriptor 的 `slotServices` 点了 `signatureHelp` 的语言（kojo2）也挂这一枚。
        'signatureHelp',
      ),
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
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          /* 幂等：撤不掉也不外抛 */
        }
      }
    },
  };
}
