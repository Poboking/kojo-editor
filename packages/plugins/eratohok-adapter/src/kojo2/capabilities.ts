/**
 * eratohoK 2.0 契约的非功能性面（编码 / 层 / 诊断命名空间 / 安全 / source map /
 * 一致性套件）—— 全是游戏 / 产品事实，只住本包。
 *
 * **本条数值 = 2026-10-26 `D:/Game/eratohok` 真盘读数**（全树 2,628 份
 * `.ERB`+`.ERH` 源文件逐字节扫描）：UTF-8 BOM 2,628/2,628（100%）；
 * EOL：CRLF 2,587 / 非 CRLF 39（39 份单行无换行，旧口径记作 "LF"）/ 混合 2；
 * UTF-16LE 0。缺省 EOL 取 CRLF——与盘面主流一致，照抄 eraSQC 的 LF 会整文件改行尾。
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
 * Unit 编码 / EOL：
 * - 缺省 `utf-8-bom`（100% 主流形态）；
 * - `allowedEncodings` 含 `utf-8`：无 BOM 文件是既成事实，读要能读；
 * - `eol: 'crlf'`：全树 CRLF 2,587 份为绝对主流；
 * - `preserveBom` + `normalizeOnSave: false`：保存时一字节不动既有 BOM / EOL；
 * - 指纹不匹配（换盘 / 换汉化）直接 error。
 */
export const ERATOHOK_ENCODING_POLICY: EncodingPolicy = Object.freeze({
  defaultEncoding: 'utf-8-bom',
  allowedEncodings: Object.freeze(['utf-8-bom', 'utf-8'] as const),
  eol: 'crlf',
  preserveBom: true,
  normalizeOnSave: false,
  fingerprintMismatch: 'error',
});

/**
 * LayerPolicy：**事件钩子共享**是本作的核心事实。
 *
 * `EVENTTRAIN` / `EVENTEND` 各有两处定义（主路由 + `ERB/口上/_KOJO_SYSTEM.ERB`
 * 的作者共享钩子，按角色号 `TRYCALLFORM` 路由），不是覆盖错误 ⇒
 * `event-hook: 'shared-hook'`。函数与 `@覆`（kojo-overlay）仍 `unique`：
 * 本作没有 overlay 机制。
 */
export const ERATOHOK_LAYER_POLICY: LayerPolicy = Object.freeze({
  defaultMode: 'unique',
  rules: Object.freeze([
    Object.freeze({ target: 'function' as const, mode: 'unique' as const }),
    Object.freeze({ target: 'event-hook' as const, mode: 'shared-hook' as const }),
    Object.freeze({ target: 'kojo-overlay' as const, mode: 'unique' as const }),
  ]),
});

/**
 * 诊断命名空间：adapter 只在自己的命名空间里 additive 增码。
 * 本批是最小 2.0 数据面（纯声明、零发射），不发任何专属码。
 */
export const ERATOHOK_DIAGNOSTIC_NAMESPACE: DiagnosticNamespacePolicy = Object.freeze({
  namespaces: Object.freeze(['unit', 'event', 'symbol', 'text'] as const),
  codes: Object.freeze([] as const),
});

/**
 * 安全边界：纯数据 adapter，不执行代码、不联网；读工程目录在内核授权范围内，
 * 写盘只能落在用户批准的路径（架构铁律 5）。
 */
export const ERATOHOK_CAPABILITY: Capability = Object.freeze({
  executesCode: false,
  fileAccess: 'read-project',
  networkAccess: 'none',
  writablePaths: 'user-approved',
  integrity: 'none',
});

/**
 * source map：行级；事件头映射恒 true。模板 / 池 / 原生 / 随机槽四项 **false**：
 * 本批不建 backend，没有能映射那些展开的产物——声称支持等于撒谎。等发射面
 * 落地后逐项翻 true。
 */
export const ERATOHOK_SOURCE_MAP: SourceMapPolicy = Object.freeze({
  granularity: 'line',
  mapsEventHeader: true,
  mapsTemplateExpansion: false,
  mapsPoolExpansion: false,
  mapsNativeLines: false,
  mapsRandomSlots: false,
});

/**
 * 一致性套件：四个验收面（golden / differential / smoke / encoding）契约强制齐备。
 * `fixture` 是**符号引用**（SDK 层零 IO）；实体夹具随 backend 批落地，
 * 本批只钉契约与事实，**不声称产物已存在**。
 */
export const ERATOHOK_CONFORMANCE_SUITE: ConformanceSuite = Object.freeze({
  required: Object.freeze(['golden', 'differential', 'smoke', 'encoding'] as const),
  cases: Object.freeze([
    Object.freeze({
      kind: 'golden' as const,
      name: 'ERB 口上壳叙事 golden',
      fixture: 'kojo2/golden/eratohok-erb-shell',
    }),
    Object.freeze({
      kind: 'differential' as const,
      name: '与手写 ERB 等价物逐行对拍',
      fixture: 'kojo2/differential/eratohok-erb-shell',
    }),
    Object.freeze({
      kind: 'smoke' as const,
      name: '真实工程编译冒烟',
      fixture: 'kojo2/smoke/eratohok-project',
    }),
    Object.freeze({
      kind: 'encoding' as const,
      name: 'UTF-8 BOM + CRLF 逐字节保留',
      fixture: 'kojo2/encoding/eratohok-utf8-bom-crlf',
    }),
  ]),
});
