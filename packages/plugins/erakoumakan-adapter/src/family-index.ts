/**
 * era紅魔館 函数家族识别规则（`FamilyIndexRule` 实现）—— **全部 era紅魔館 领域知识只住本包**。
 *
 * ## 命名体系：`{前缀}_K{n}` 族 + NTR / WC / SexHara 三类并列命名
 *
 * 全量实测（`ERB/口上` 403 份 / 4,450 个函数定义，2026-10-25；`D:/Game/eraKoumakan`）：
 *
 * ```
 * KOJO_K4                              ← 口上入口（每个角色一份，返回 1）
 * KOJO_EVENT_K4_0                      ← 事件（尾段 = 事件号）
 * KOJO_MESSAGE_K4_SeeYou_900_0         ← 见送り等杂项面（尾段 = 场景名 + 编号）
 * KOJO_MESSAGE_COM_K4_300              ← 指令口上（尾段 = SELECTCOM 指令号）
 * KOJO_MESSAGE_COM_K4_300_10_01        ← 同一指令的子分支（尾段保留全段）
 * KOJO_MESSAGE_SCOM_K4_350             ← 射精/特殊指令口上（尾段 = TFLAG:50）
 * KOJO_MESSAGE_COUNTER_K4_10_1         ← 计数器口上（尾段 = TCVAR:20 + 变体）
 * KOJO_MESSAGE_PALAMCNG_A_K4_0         ← 参数变动（A–E 五个子面；尾段 = 位号）
 * KOJO_MESSAGE_MARKCNG_K4              ← 刻印变化（无尾段）
 * KOJO_MESSAGE_ENDING_K4               ← 结局（无尾段）
 * KOJO_WC_COUNTER10_K4                 ← 厕所计数器（面后夹着计数器分类段）
 * WC_DescriptiveStyle_K4               ← 厕所描写风格
 * SexHara休息中_Easy_K4_0              ← 休息中被骚扰（难度段 Easy…Phantasm）
 * CALLNAME_K4                          ← 称呼函数
 *
 * NTR_ 前缀版：NTR_KOJO_K4_1 / NTR_KOJO_PRE_KW5_8_0_0 /
 *               NTR_KOJO_MESSAGE_COM_K4_350_1 / NTR_MESSAGE_COM_K1_350_0_3
 * ```
 *
 * ## 四条解析口径（都由真盘倒推，宁可不标也不标错）
 *
 * 1. **`K` 之后是编号；`U` / `W` 不是编号**：
 *    - `_K{数字}` → 角色号；
 *    - `_KU_…` → **泛用口上**（`U_汎用` 目录），`characterNo = null`；
 *    - `_KW{数字}_…` → 同角色号的「见せつけ」变体（NTR 在场），`characterNo` 仍是该号；
 *    - `_KW_…` / `_K_…`（K 后直接下划线）→ 模板/无编号形，`characterNo = null`。
 *    全盘 40 个解析不出的函数全部落在这条兜底之外（`MSG_*` 辅助函数 / 催眠系统
 *    的 `催眠_KOJO_*` 函数），**不猜归属**。
 * 2. **`family` 只分 NTR / 非 NTR**：非 NTR 一律 `''`（初始家族），NTR 前缀进
 *    `'NTR'` 家族。函数树据此把两类口上分开；`face` 再细分语义面。
 * 3. **PALAMCNG 的 A–E 进 `sub`**：五个子面在树里合并为「参数变动」一列，
 *    具体变体保留在 `sub`（信息不丢）。
 * 4. **尾段原样进 `slot`**：`KOJO_MESSAGE_COM_K4_300_10_01` 的 `300_10_01`
 *    整段保留。条件矩阵按 `slot === String(no)` / 前缀 `no_` 找指令口上，
 *    所以**不允许**在这里把子分支裁成只剩指令号（会丢掉「这条属于 300」的证据）。
 *
 * ## 面 token 与指令承载面
 *
 * `instructionFaces = ['MESSAGE_COM', 'MESSAGE_SCOM']`：这两面的 `slot` 首位
 * 数字是引擎指令号（`SELECTCOM` / `TFLAG:50`），条件矩阵据此按指令拆列；
 * `MESSAGE_COUNTER` 的首位是计数器号（`TCVAR:20`），不是指令号，**不列**。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';

/** 面 → 中文标签（游戏知识，只住本包）。未收录的面消费方原样显示 token。 */
export const ERAKOUMAKAN_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  KOJO: '口上入口',
  EVENT: '事件',
  MESSAGE: '杂项场景',
  MESSAGE_COM: '指令口上',
  MESSAGE_SCOM: '射精指令',
  MESSAGE_COUNTER: '计数器',
  MESSAGE_PALAMCNG: '参数变动',
  MESSAGE_MARKCNG: '刻印变化',
  MESSAGE_ENDING: '结局',
  KOJO_PRE: 'NTR 前口上',
  WC_COUNTER: '厕所计数器',
  WC_DESCRIPTIVE_STYLE: '厕所描写风格',
  SEXHARA_EASY: '休息受扰（Easy）',
  SEXHARA_NORMAL: '休息受扰（Normal）',
  SEXHARA_HARD: '休息受扰（Hard）',
  SEXHARA_LUNATIC: '休息受扰（Lunatic）',
  SEXHARA_EXTRA: '休息受扰（Extra）',
  SEXHARA_PHANTASM: '休息受扰（Phantasm）',
  CALLNAME: '称呼',
});

/**
 * 入参 / 注释裁剪：Emuera 函数名不含逗号、空白、括号，实盘存在
 * `@KOJO_K4(ARG)` / `@KOJO_MESSAGE_MARKCNG_K4(奴隷)` 与 `, ARGS` 形态
 * ⇒ 从首个分隔符起整段裁掉。
 */
const TRAILING_JUNK_RE = /[\s,(;].*$/;

/** `SexHara休息中_{难度}_K{n}_{尾段}`（大小写不敏感；难度 token 统一成大写面名） */
const SEXHARA_RE = /^SEXHARA(?:休息中)?_([A-Z]+)_K(W)?(?:(\d+)|U)(?:_(.+))?$/i;

/** `CALLNAME_K{n}` */
const CALLNAME_RE = /^CALLNAME_K(\d+)$/i;

/** `WC_DescriptiveStyle_K{n}` */
const WC_STYLE_RE = /^WC_DESCRIPTIVESTYLE_K(\d+)$/i;

/**
 * `KOJO_WC_COUNTER{分类段}_K{n}`：分类段可空（`…COUNTER10_K4`）、可含下划线
 * （`…COUNTER25_1_VirginReservation_GET_K4`）、也可叫 `caretaker`。
 * `(.*?)` 惰性 + 末尾 `_K` 锚保证取**最后一个** `_K{数字}`。
 */
const WC_COUNTER_RE = /^KOJO_WC_COUNTER(.*?)_K(W)?(?:(\d+)|U)$/i;

/**
 * 通用锚：`{head}_K(W)?(数字|U|_尾段)?(_尾段)?`。
 *
 * - head 允许 `KOJO_MESSAGE_PALAMCNG_A` 这类多段名（惰性 + `_K` 锚）；
 * - `K` 后三种形态：数字 / `U` / 直接下划线（无编号模板）；
 * - `W` 是「见せつけ」变体标记，`KW5` 的角色号仍是 5。
 */
const GENERIC_RE = /^([A-Z][A-Z0-9_]*(?:_[A-Z0-9]+)*?)_K(W)?(?:(\d+)|U|_(.+))?(?:_(.+))?$/i;

/** 参数变动子面字母（真盘只出现 A/B/C；D/E 由引擎保留，收全五个） */
const PALAMCNG_RE = /^KOJO_MESSAGE_PALAMCNG_([A-E])$/i;

function make(p: {
  family: string;
  prefix: string;
  face: string;
  no: number | null;
  sub?: string;
  slot?: string;
  placeholder?: boolean;
}): FamilyMatch {
  return Object.freeze({
    kind: 'ok' as FamilyParseKind,
    prefix: p.prefix,
    family: p.family,
    characterNo: p.no,
    selector: 0,
    face: p.face,
    sub: p.sub ?? '',
    isMessageCheck: false,
    slot: p.slot ?? '',
    isPlaceholder: p.placeholder ?? false,
  });
}

/** `KOJO_…` / `MESSAGE_…` / `EVENT` 三类走 KOJO 前缀域；WC / SexHara / CALLNAME 不是。 */
function prefixOf(head: string): string {
  const h = head.toUpperCase();
  if (h === 'KOJO' || h.startsWith('KOJO_')) return 'KOJO';
  if (h === 'EVENT' || h.startsWith('MESSAGE')) return 'KOJO';
  return '';
}

/**
 * head 段 → 面 token。
 *
 * `KOJO_MESSAGE_COM` → `MESSAGE_COM`（剥 `KOJO_`）；`KOJO_MESSAGE` 单独一段时是
 * 杂项面（见送り），不能剥成空串；`KOJO_EVENT` → `EVENT`；`KOJO` 单独 → `KOJO`。
 * NTR 前缀在调用前已剥掉，故 `MESSAGE_COM` / `KOJO_PRE` 原样成面。
 */
function faceOf(head: string): { face: string; sub: string } {
  const h = head.toUpperCase();
  const palam = PALAMCNG_RE.exec(h);
  if (palam) return { face: 'MESSAGE_PALAMCNG', sub: palam[1]!.toUpperCase() };
  if (h === 'KOJO') return { face: 'KOJO', sub: '' };
  if (h === 'KOJO_EVENT') return { face: 'EVENT', sub: '' };
  if (h === 'KOJO_MESSAGE') return { face: 'MESSAGE', sub: '' };
  // NTR 的「前口上」面：`KOJO_PRE` 整段是面名，不能按 `KOJO_` 前缀剥成 `PRE`
  if (h === 'KOJO_PRE') return { face: 'KOJO_PRE', sub: '' };
  if (h.startsWith('KOJO_')) return { face: h.slice('KOJO_'.length), sub: '' };
  return { face: h, sub: '' };
}

/**
 * 解析单个函数名（**纯函数**：只读入参与模块常量表）。
 *
 * @param filePath 可选文件来源；本作没有 KX 占位符体系，参数不参与判定
 *   （保留签名以对齐 `FamilyIndexRule.match` 的 additive 第二参）。
 * @returns 与口上命名无关的函数返回 null（`MSG_*` / `催眠_KOJO_*` / 引擎助手…），绝不猜测。
 */
export function parseKojoFamily(rawName: string, _filePath?: string): FamilyMatch | null {
  const trimmed = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (trimmed.length === 0) return null;

  // 只在**判定**时用大写；`slot` / `sub` 保留源码原样大小写（`SeeYou` /
  // `VirginReservation` 这类尾段是给作者看的，不该被折叠成大写）。
  const family = /^NTR_/i.test(trimmed) ? 'NTR' : '';
  const name = family === 'NTR' ? trimmed.slice('NTR_'.length) : trimmed;
  if (name.length === 0) return null;

  // 1) SexHara：难度段进面 token（Easy/Normal/Hard/Lunatic/Extra/Phantasm）
  const sex = SEXHARA_RE.exec(name);
  if (sex) {
    return make({
      family,
      prefix: family === 'NTR' ? 'NTR' : '',
      face: `SEXHARA_${sex[1]!.toUpperCase()}`,
      no: sex[3] === undefined ? null : Number.parseInt(sex[3], 10),
      slot: sex[4] ?? '',
    });
  }

  // 2) 称呼（不是口上正文，但按角色可导航）
  const call = CALLNAME_RE.exec(name);
  if (call) {
    return make({
      family,
      prefix: family === 'NTR' ? 'NTR' : '',
      face: 'CALLNAME',
      no: Number.parseInt(call[1]!, 10),
    });
  }

  // 3) 厕所描写风格
  const style = WC_STYLE_RE.exec(name);
  if (style) {
    return make({
      family,
      prefix: family === 'NTR' ? 'NTR' : '',
      face: 'WC_DESCRIPTIVE_STYLE',
      no: Number.parseInt(style[1]!, 10),
    });
  }

  // 4) 厕所计数器（分类段原样进 sub）
  const wc = WC_COUNTER_RE.exec(name);
  if (wc) {
    return make({
      family,
      prefix: family === 'NTR' ? 'NTR' : '',
      face: 'WC_COUNTER',
      no: wc[3] === undefined ? null : Number.parseInt(wc[3], 10),
      sub: (wc[1] ?? '').replace(/^_/, ''),
    });
  }

  // 5) 通用 KOJO / NTR 族
  const m = GENERIC_RE.exec(name);
  if (!m) return null;
  const head = m[1]!;
  const no = m[3] === undefined ? null : Number.parseInt(m[3], 10);
  // `_K_8_2_2` 形态：数字在 group4；`_K1_350_0_3` 形态：尾段在 group5
  const slot = m[5] ?? m[4] ?? '';
  const { face, sub } = faceOf(head);
  return make({
    family,
    // NTR 前缀本身就是领域标记（树顶层分家族用）；不能让 head 的 KOJO/MESSAGE
    // 把前缀域改回 KOJO，否则两类口上会混进同一前缀。
    prefix: family === 'NTR' ? 'NTR' : prefixOf(head),
    face,
    no,
    sub,
    slot,
  });
}

/**
 * 构造 era紅魔館 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用）。
 *
 * `instructionFaces` 只收 `MESSAGE_COM` / `MESSAGE_SCOM`（见文件头末节）。
 */
export function createKoumakanFamilyIndex(): FamilyIndexRule {
  return {
    name: 'erakoumakan-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return parseKojoFamily(fnName, filePath);
    },
    faceLabels: ERAKOUMAKAN_FACE_LABELS,
    instructionFaces: ['MESSAGE_COM', 'MESSAGE_SCOM'],
  };
}
