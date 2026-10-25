/**
 * eraFL 2.0 契约的"非功能性面"（Unit 编码/EOL · Layer · 诊断命名空间 · 安全 ·
 * source map · 一致性套件）—— 全是游戏/产品事实，只住本包。
 *
 * 依据：设计稿 §10.4（编码/EOL）、§10.5（LayerPolicy）、§10.6（诊断命名空间）、
 * §10.8（Capability）、§10.7（source map）、§10.9（conformance suite）。
 *
 * **本条所有数值都是 2026-10-24 `D:/Game/erafl` 真盘读数**（ERB 2,016 份全树逐字节
 * 扫描 + CSV 名表清点），不是从 eraTW 抄的——eraTW 是 UTF-16LE 为主，eraFL 是
 * UTF-8 BOM 为主，照抄必错（§2.3）。
 */
import type {
  Capability,
  ConformanceSuite,
  DiagnosticNamespacePolicy,
  EncodingPolicy,
  LayerPolicy,
  SourceMapPolicy,
} from '@kojo/kojo-core';

/**
 * Unit 编码/EOL：eraFL 全树 2,016 份 `.ERB` 实测 **1,940 份 UTF-8 BOM**
 * （其中 1,922 份 CRLF、0 份纯 LF）、**76 份无 BOM**（按 UTF-8 解）、
 * **0 份 UTF-16LE**（口上 XML 侧另有 9 份 UTF-16LE，但 XML 不是 2.0 Unit，
 * 归入口 E；本策略只管 2.0 源文件）。
 *
 * - 缺省 `utf-8-bom`：新文件按主流形态落盘（作者用别的编辑器补一行，
 *   整文件的 BOM/EOL 一字节不动——`preserveBom` + `normalizeOnSave: false`
 *   是契约写死的，类型层就堵死归一化）；
 * - `allowedEncodings` 含 `utf-8`：那 76 份无 BOM 文件是既成事实，
 *   读要能读（保存时才按缺省形态）；
 * - 指纹不匹配（换盘/换汉化）直接 error：继续读写旧槽会串值（§10.4）。
 */
export const ERAFL_ENCODING_POLICY: EncodingPolicy = Object.freeze({
  defaultEncoding: 'utf-8-bom',
  allowedEncodings: Object.freeze(['utf-8-bom', 'utf-8'] as const),
  eol: 'crlf',
  preserveBom: true,
  normalizeOnSave: false,
  fingerprintMismatch: 'error',
});

/**
 * LayerPolicy：eraFL 三类定义面**一律 unique**（同层同名 = error）。
 *
 * 与 eraTW 同值，但依据是 eraFL 自己的事实：口上按角色分发
 * （`KOJO_DEFINE_K{n}` 一个角色一号，`KOJO_XML_REGISTER` 一份 XML 登记一次），
 * 没有 eraSQN 那种共享事件钩子（shared-hook）语义；overlay（翻译/多版本
 * 覆盖层）在本作也没有语料。**不开口子**——宁可报错，也不让后装载者静默覆盖。
 */
export const ERAFL_LAYER_POLICY: LayerPolicy = Object.freeze({
  defaultMode: 'unique',
  rules: Object.freeze([
    Object.freeze({ target: 'function' as const, mode: 'unique' as const }),
    Object.freeze({ target: 'event-hook' as const, mode: 'unique' as const }),
    Object.freeze({ target: 'kojo-overlay' as const, mode: 'unique' as const }),
  ]),
});

/**
 * 诊断命名空间：adapter 只在自己的命名空间里 additive 增码，core 码闭集不受影响。
 *
 * `codes` **空数组**是有意的：本批交付的是最小 2.0 数据面（纯声明、零发射），
 * 不发出任何 adapter 专属码。v1 约定规则那套 `erafl.kojo-xml.unregistered` 形是
 * **宿主侧另一套码制**（见 `conventions.ts`），形态不是 `<命名空间>/<码>`，
 * 不进 2.0 命名空间——两套码制各自记账，不混。
 *
 * 声明的是"允许使用"的命名空间（本数据面实际触及的四面）：unit（装载自检）/
 * event（事件目录）/ symbol（域符号）/ text（编码与文本）。variant / overlay /
 * raw 等面等入口 D/E 有真发射面再逐条加，不预埋。
 */
export const ERAFL_DIAGNOSTIC_NAMESPACE: DiagnosticNamespacePolicy = Object.freeze({
  namespaces: Object.freeze(['unit', 'event', 'symbol', 'text'] as const),
  codes: Object.freeze([] as const),
});

/**
 * 安全边界：eraFL adapter 是**纯数据 adapter**，不执行代码、不联网；读工程目录是
 * 内核授权范围内的事（`kojo-xml/service.ts` 批量读 293 份口上 XML 就走这条路），
 * 写盘只能落在用户批准的路径（脚手架 `scaffold.ts` 本身纯函数不写盘，落盘由宿主
 * 向导在用户确认后执行）——§10.8 / 架构铁律 5。
 */
export const ERAFL_CAPABILITY: Capability = Object.freeze({
  executesCode: false,
  fileAccess: 'read-project',
  networkAccess: 'none',
  writablePaths: 'user-approved',
  integrity: 'none',
});

/**
 * source map：至少行级；eraFL 的包装/伴生函数（`@KOJO_XML_INIT_K{n}` 初始化壳、
 * define 注册壳）要能映射回源行。
 *
 * 事件头映射（`mapsEventHeader`）契约要求恒 true；模板/池/原生/随机槽四项
 * **false**：eraFL 的 2.0 发射面还没建（入口 D），现在没有能映射那些展开的
 * 产物——声称支持等于撒谎（fail-visible：这些面在入口 D 落地后逐项翻 true）。
 */
export const ERAFL_SOURCE_MAP: SourceMapPolicy = Object.freeze({
  granularity: 'line',
  mapsEventHeader: true,
  mapsTemplateExpansion: false,
  mapsPoolExpansion: false,
  mapsNativeLines: false,
  mapsRandomSlots: false,
});

/**
 * 一致性套件：golden / differential / smoke / encoding 四面各有产物要求。
 * `fixture` 是**符号引用**（SDK 层零 IO，不在这里读盘），实体夹具在
 * `tests/fixtures/kojo2-conformance/`（`.kojo2` + `.golden.erb` + `.erb` 基线），
 * 由 `tests/kojo2-conformance.test.ts` 挂进 `runAdapterConformance` 跑：
 * 支持子集 52 枚用例全绿，缺面逐枚红在诊断码上（红名单在同一文件的 §F）。
 *
 * 口径修正（2026-10-25 夹具批）：golden / differential 两面钉的是 **ERB 侧**产物——
 * 口上 XML 不编译成 2.0 视图（交接文档 §5 E-2 的决策：XML 走 provider，不走降糖），
 * 原来的"口上 XML 叙事 golden"这个名与引用会把人往一条不存在的路引。
 */
export const ERAFL_CONFORMANCE_SUITE: ConformanceSuite = Object.freeze({
  required: Object.freeze(['golden', 'differential', 'smoke', 'encoding'] as const),
  cases: Object.freeze([
    Object.freeze({
      kind: 'golden' as const,
      name: 'ERB 壳函数叙事 golden',
      fixture: 'kojo2/golden/erafl-erb-shell',
    }),
    Object.freeze({
      kind: 'differential' as const,
      name: '与手写 ERB 等价物逐行对拍',
      fixture: 'kojo2/differential/erafl-erb-shell',
    }),
    Object.freeze({
      kind: 'smoke' as const,
      name: '真实壳编译冒烟',
      fixture: 'kojo2/smoke/erafl-desktop-shell',
    }),
    Object.freeze({
      kind: 'encoding' as const,
      name: 'UTF-8 BOM + CRLF 逐字节保留',
      fixture: 'kojo2/encoding/utf8-bom-crlf',
    }),
  ]),
});
