/**
 * eraFL 2.0 契约的"非功能性面"（Unit 编码/EOL · Layer · 诊断命名空间 · 安全 ·
 * source map · 一致性套件）—— 全是游戏/产品事实，只住本包。
 *
 * 依据：契约 §10.4（编码/EOL）、§10.5（LayerPolicy）、§10.6（诊断命名空间）、
 * §10.8（Capability）、§10.7（source map）、§10.9（conformance suite）。
 *
 * 真盘读数（2026-10-24，D:/Game/erafl，逐条本人复测；eraTW 的同名字段是
 * **utf-16le-bom / mixed**，照抄必错且错得安静——UTF-16 解码器读 UTF-8 文件
 * 得到乱码，整份文件会被判成"不可读"）：
 *
 * - **编码**：`od -An -tx1` 取头 3 字节 —— ERB 注册壳
 *   （`ERB/口上/1000_汎用キャラテスト/KOJO_DEFINE_K1000.ERB`）、口上 XML
 *   （同目录 `KOJO_K1000_COM.xml`）、CSV（`CSV/Abl.csv`）三处抽样均为
 *   `ef bb bf` = UTF-8 BOM；400 份 XML 全树扫 `ff fe` 前缀 = 9 份 UTF-16LE+BOM
 *   （与 v1 `kojo-xml/encoding.ts` 头注记录的"9 份"复测一致）。
 *   ⇒ 缺省 `utf-8-bom`；允许读 `utf-8-bom` / `utf-8` / `utf-16le-bom`。
 * - **EOL**：`tr -dc '\r' | wc -c` 与 `tr -dc '\n' | wc -c` 逐份比对——注册壳
 *   73/73、口上 XML 132/132，另跨 SYSTEM / SHOP / QUEST / TRAIN 四目录抽 8 份
 *   全部 CR 数 == LF 数（纯 CRLF，无 LF-only 混合）。
 *   （坑：`grep -c $'\r'` 在 Git Bash 下对所有文件都数出 0，是 shell 怪癖，
 *   判据以字节计数为准。）
 * - CSV 侧佐证：v1 `variable-schema.ts` 头注的全树读数"`.csv` 全部
 *   UTF-8 BOM + CRLF"与本次抽样一致。
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
 * Unit 编码/EOL：eraFL 缺省 **UTF-8 BOM + CRLF**；9 份 UTF-16LE XML 仍要能读；
 * 保存时一字节不归一化（每个 Unit 独立保留）。指纹不匹配（换盘/换汉化）直接
 * error：继续读写旧槽会串值。
 */
export const ERAFL_ENCODING_POLICY: EncodingPolicy = Object.freeze({
  defaultEncoding: 'utf-8-bom',
  allowedEncodings: Object.freeze(['utf-8-bom', 'utf-8', 'utf-16le-bom'] as const),
  eol: 'crlf',
  preserveBom: true,
  normalizeOnSave: false,
  fingerprintMismatch: 'error',
});

/**
 * LayerPolicy：三类定义面**一律 unique**（同层同名 = error）。
 * eraFL 没有共享事件钩子（shared-hook）语义——口上注册壳与 XML 是一对一的
 * （`KOJO_DEFINE_K{n}` → `CALL KOJO_XML_REGISTER`，见 §2.1）；overlay
 * （翻译/多版本覆盖层）不开口子：宁可报错，也不让后装载者静默覆盖。
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
 * 诊断命名空间：adapter 只在自己声明的命名空间里 additive 增码，core 码闭集不受影响。
 *
 * 口径（宁缺毋滥，不预埋空头码）：
 * - `event/unknown` / `event/argument`：core 的 `checkEvent` / `checkEventArgs`
 *   对本 adapter 事件表的查询码——eraFL 真盘只有 4 个引擎事件（见 event-catalog.ts），
 *   作者写另外 5 个（EVENTTRAIN 等被 `@FL_*` / `@QST_*` 流程函数取代的）时**必然**
 *   走到这两条，是实际会发出的码；
 * - `symbol` / `text` 两个命名空间先声明（域符号补全 = 入口 C、XML 2.0 化 = 入口 E
 *   都会往里落码），但 codes 此刻为空——v1 的 `erafl.kojo-xml.unregistered` 等
 *   约定码是 v1 linter 的点号形 scheme（见 `conventions.ts`），逐条映射到 2.0
 *   命名空间形是入口 E 的活，现在不预埋。
 */
export const ERAFL_DIAGNOSTIC_NAMESPACE: DiagnosticNamespacePolicy = Object.freeze({
  namespaces: Object.freeze(['event', 'symbol', 'text'] as const),
  codes: Object.freeze(['event/unknown', 'event/argument'] as const),
});

/**
 * 安全边界：eraFL adapter 是**纯数据 adapter**，不执行代码、不联网；读工程目录是
 * 内核授权范围内的事，写盘只能落在用户批准的 `writablePaths`（§10.8 / 架构铁律 5）。
 * 与 eraTW 同口径（同为数据型 adapter）。
 */
export const ERAFL_CAPABILITY: Capability = Object.freeze({
  executesCode: false,
  fileAccess: 'read-project',
  networkAccess: 'none',
  writablePaths: 'user-approved',
  integrity: 'none',
});

/**
 * source map：至少行级（契约硬要求 `mapsEventHeader === true`——注册壳是包装函数，
 * 产物要能映射回壳的事件头）。eraFL 2.0 面**没有**模板展开 / 池展开 / `@原生` /
 * `@随机` 槽这些构造（口上演出现在 XML 属性里，见 presentation.ts 头注）⇒ 四项
 * 一律 false：声明了却没有映射对象才是撒谎。
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
 * 一致性套件：golden / differential / smoke / encoding 四面各有产物声明。
 * `fixture` 是**符号引用**（SDK 层零 IO，不在这里读盘）；eraFL 的具体 fixture
 * 由后续批搭（真盘壳函数取料），现在只把验收面立住。
 */
export const ERAFL_CONFORMANCE_SUITE: ConformanceSuite = Object.freeze({
  required: Object.freeze(['golden', 'differential', 'smoke', 'encoding'] as const),
  cases: Object.freeze([
    Object.freeze({
      kind: 'golden' as const,
      name: 'eraFL 注册壳编译 golden',
      fixture: 'kojo2/golden/kojo-define-shell',
    }),
    Object.freeze({
      kind: 'differential' as const,
      name: 'eraFL 注册壳与手写产物逐行对拍',
      fixture: 'kojo2/differential/kojo-define-shell',
    }),
    Object.freeze({
      kind: 'smoke' as const,
      name: 'eraFL 注册壳编译冒烟',
      fixture: 'kojo2/smoke/kojo-define-shell',
    }),
    Object.freeze({
      kind: 'encoding' as const,
      name: 'UTF-8 BOM + CRLF 逐字节保留',
      fixture: 'kojo2/encoding/utf8-bom-crlf',
    }),
  ]),
});
