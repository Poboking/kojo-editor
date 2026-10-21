/**
 * eraTW 2.0 契约的"非功能性面"（Unit / Layer / 诊断命名空间 / 安全 / source map /
 * 一致性套件）—— 全是游戏/产品事实，只住本包。
 *
 * 依据：设计稿 §10.4（编码/EOL）、§10.5（LayerPolicy）、§10.6（诊断命名空间）、
 * §10.8（Capability）、§10.7（source map）、§10.9（conformance suite）。
 */
import type {
  Capability,
  ConformanceSuite,
  DiagnosticNamespacePolicy,
  EncodingPolicy,
  LayerPolicy,
  SourceMapPolicy,
} from '../../../../kojo-core/src/adapter.js';

/**
 * Unit 编码/EOL：eraTW 4.980 漢化包以 **UTF-16LE + BOM** 为主，纯 UTF-8 / UTF-8 BOM
 * 的老包仍要能读；EOL 允许 CRLF / LF / 混合，保存时**一字节不归一化**。
 * 指纹不匹配（换盘/换汉化）直接 error：继续读写旧槽会串值。
 */
export const ERATW_ENCODING_POLICY: EncodingPolicy = Object.freeze({
  defaultEncoding: 'utf-16le-bom',
  allowedEncodings: Object.freeze(['utf-16le-bom', 'utf-8-bom', 'utf-8'] as const),
  eol: 'mixed',
  preserveBom: true,
  normalizeOnSave: false,
  fingerprintMismatch: 'error',
});

/**
 * LayerPolicy：eraTW 三类定义面**一律 unique**（同层同名 = error）。
 * eraTW 没有 eraSQN 那种共享事件钩子（shared-hook）语义；overlay（翻译/多版本
 * 覆盖层）留给后续批次按层声明，现在不开口子——宁可报错，也不让后装载者静默覆盖。
 */
export const ERATW_LAYER_POLICY: LayerPolicy = Object.freeze({
  defaultMode: 'unique',
  rules: Object.freeze([
    Object.freeze({ target: 'function' as const, mode: 'unique' as const }),
    Object.freeze({ target: 'event-hook' as const, mode: 'unique' as const }),
    Object.freeze({ target: 'kojo-overlay' as const, mode: 'unique' as const }),
  ]),
});

/**
 * 诊断命名空间：adapter 只在自己的命名空间里 additive 增码，core 码闭集不受影响。
 * 声明的是"本 adapter 实际会发出的码"，不是全集镜像。
 */
export const ERATW_DIAGNOSTIC_NAMESPACE: DiagnosticNamespacePolicy = Object.freeze({
  namespaces: Object.freeze(['unit', 'event', 'symbol', 'text', 'variant', 'overlay', 'raw'] as const),
  codes: Object.freeze([
    'unit/fingerprint-mismatch',
    'unit/encoding-mixed',
    'event/unknown',
    'event/argument',
    'symbol/unknown-attribute',
    'symbol/unknown-speaker',
    'text/encoding-fail',
    'variant/unsupported',
    'overlay/conflict',
    'raw/unrepresentable',
  ] as const),
});

/**
 * 安全边界：eraTW adapter 是**纯数据 adapter**，不执行代码、不联网；读工程目录是
 * 内核授权范围内的事，写盘只能落在用户批准的 `writablePaths`（§10.8 / 架构铁律 5）。
 */
export const ERATW_CAPABILITY: Capability = Object.freeze({
  executesCode: false,
  fileAccess: 'read-project',
  networkAccess: 'none',
  writablePaths: 'user-approved',
  integrity: 'none',
});

/**
 * source map：至少行级；eraTW 的包装/伴生函数（事件头、颜色函数）与模板/池展开、
 * `@原生` 逐行、`@随机` 隐藏槽都要能映射回源行（§10.7）。列级留给后续批次。
 */
export const ERATW_SOURCE_MAP: SourceMapPolicy = Object.freeze({
  granularity: 'line',
  mapsEventHeader: true,
  mapsTemplateExpansion: true,
  mapsPoolExpansion: true,
  mapsNativeLines: true,
  mapsRandomSlots: true,
});

/**
 * 一致性套件：golden / differential / smoke / encoding 四面各有产物。
 * `fixture` 是**符号引用**（SDK 层零 IO，不在这里读盘）；具体 fixture 由后续批搭。
 */
export const ERATW_CONFORMANCE_SUITE: ConformanceSuite = Object.freeze({
  required: Object.freeze(['golden', 'differential', 'smoke', 'encoding'] as const),
  cases: Object.freeze([
    Object.freeze({
      kind: 'golden' as const,
      name: '指令口上 叙事 golden',
      fixture: 'kojo2/golden/message-com',
    }),
    Object.freeze({
      kind: 'differential' as const,
      name: '与既有 ERB 产物逐行对拍',
      fixture: 'kojo2/differential/message-com',
    }),
    Object.freeze({
      kind: 'smoke' as const,
      name: '真实壳编译冒烟',
      fixture: 'kojo2/smoke/desktop-shell',
    }),
    Object.freeze({
      kind: 'encoding' as const,
      name: 'UTF-16LE + CRLF 逐字节保留',
      fixture: 'kojo2/encoding/utf16le-crlf',
    }),
  ]),
});
