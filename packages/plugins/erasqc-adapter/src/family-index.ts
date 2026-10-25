/**
 * eraSQC 函数家族识别规则（`FamilyIndexRule` 实现）—— **全部 eraSQC 领域知识只住本包**。
 *
 * ## 命名体系：`{面}_{角色号}_{口上模式}`（模式在尾）
 *
 * 全量实测（`ERB/EVENT_K` 111 份 / 1,366 个函数定义，2026-10-25；`C:/game/eraSQC`）：
 *
 * ```
 * KOJO_MESSAGE_COM_1_1                 ← 指令口上（87 处；角色 1、口上模式 1）
 * KOJO_MESSAGE_BEFORE_COM_7_3          ← 指令前（87 处）
 * KOJO_MESSAGE_PALAMCNG_12_2           ← 参数变动（87 处）
 * KOJO_MESSAGE_SAMEN_AND_EXTACY_48_2L  ← 射精与绝顶（87 处；模式可以是 `2L`）
 * KOJO_MESSAGE_MARKCNG_44_331          ← 刻印变化（87 处）
 * KOJO_MESSAGE_SHOOT_17_1              ← 射精（21 处，部分角色实装）
 * SELF_KOJO_K4_1, ARGS                 ← 独白（91 处；K{n} 形态）
 * GUEST_KOJO_K8_1, ARGS, ARG           ← 客人口上（81 处）
 * COUNTER_KOJO_9_1, ARGS               ← 计数器（91 处；无 K）
 * SINGLE_ENDING_K24_2                  ← 单结局（90 处）
 * IS_SINGLE_ENDING_K31_1               ← 单结局判定（19 处）
 * DAILY_LIFE_MESSAGE_25_2              ← 日常对话（19 处）
 * DAILY_LIFE_DAYEV_25_2                ← 日常事件（少量）
 * K39_KOJO2_1                          ← 恋慕/初见分支（每角色一份；K{n}_ 前缀式）
 * EVENTTRAIN_K48_2L / EVENTEND_K48_2L  ← 调教起止（同文件多角色重复定义，带 K 尾的私货形）
 * KOJO_AEGI_97_33_0                    ← 场景辅助口上（角色 97 / 尾段 33_0）
 * KOJO_EVENT_EXSTART_16_1              ← 探索事件口上（角色 16）
 * K39_KOJO_MAGIC_PRACTICE              ← 角色私有函数（K{n}_ 前缀）
 * ```
 *
 * ## 三条解析口径（全部由真盘倒推，宁可不标也不标错）
 *
 * 1. **尾号是 `CFLAG:209` 口上模式，不是指令号**：路由一律
 *    `TRYCALLFORM KOJO_MESSAGE_COM_{NO:TARGET}_{CFLAG:209}`（`EVENT_K.ERB:30`），
 *    指令号在函数体里用 `IF SELECTCOM == n` 分派 ⇒ `instructionFaces` 为空数组，
 *    条件矩阵不按「每指令一列」切分。
 * 2. **主模式的两种形态并存**：`KOJO_MESSAGE_*_{no}_{mode}`（无 K）与
 *    `SELF_KOJO_K{no}_{mode}` / `GUEST_KOJO_K{no}_{mode}`（有 K）——按面分别处理，
 *    不能拿一条 `K{n}` 正则通吃。
 * 3. **路由函数的无编号形返回 null**：`KOJO_MESSAGE_COM` / `SELF_KOJO` /
 *    `DAILY_LIFE_MESSAGE`（`EVENT_K.ERB` 里的路由本体）不归属任何角色，绝不猜。
 *
 * ## 面 token
 *
 * `MESSAGE_COM` / `SELF_KOJO` / `KOJO2` … 全部是**语义面**；未收录的面仍然返回
 * `FamilyMatch`（角色号可导航），标签消费方原样显示 token（fail-visible）。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';

/** 面 → 中文标签（游戏知识，只住本包）。未收录的面消费方原样显示 token。 */
export const ERASQC_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  MESSAGE_COM: '指令口上',
  MESSAGE_BEFORE_COM: '指令前',
  MESSAGE_AFTER_COM: '指令后',
  MESSAGE_PALAMCNG: '参数变动',
  MESSAGE_MARKCNG: '刻印变化',
  MESSAGE_SHOOT: '射精',
  MESSAGE_SAMEN_AND_EXTACY: '射精与绝顶',
  MESSAGE_GAG: '口枷',
  MESSAGE_BEFORE_GAG: '口枷前',
  SELF_KOJO: '独白',
  GUEST_KOJO: '客人口上',
  COUNTER_KOJO: '计数器',
  SINGLE_ENDING: '单结局',
  IS_SINGLE_ENDING: '单结局判定',
  DAILY_LIFE_MESSAGE: '日常对话',
  DAILY_LIFE_DAYEV: '日常事件',
  KOJO2: '恋慕分支',
  EVENTTRAIN: '调教开始',
  EVENTEND: '调教结束',
  KN: '角色私有函数',
});

/** 入参 / 注释裁剪：函数名不含逗号/空白/括号，实盘有 `@SELF_KOJO_K4_1, ARGS` 形态。 */
const TRAILING_JUNK_RE = /[\s,(;].*$/;

/** `{面}_K{n}[_{尾段}]` / `{面}_{n}[_{尾段}]` 的公共拼接 */
function tail(n: number, slot: string | undefined): string {
  return slot ?? '';
}

function make(
  face: string,
  no: number | null,
  slot: string,
  extra: { kind?: FamilyParseKind; prefix?: string; sub?: string } = {},
): FamilyMatch {
  return Object.freeze({
    kind: extra.kind ?? ('ok' as FamilyParseKind),
    prefix: extra.prefix ?? '',
    family: '',
    characterNo: no,
    selector: 0,
    face,
    sub: extra.sub ?? '',
    isMessageCheck: false,
    slot,
    isPlaceholder: false,
  });
}

/* ------------------------------ 主族表 ------------------------------ */

interface FamilyPattern {
  readonly face: string;
  readonly re: RegExp;
  /** 编号 / 尾段在捕获组里的位置（1 基；正则无尾段时 undefined） */
  readonly noGroup: number;
  readonly slotGroup?: number;
  readonly prefix?: string;
  readonly kind?: FamilyParseKind;
}

const FAMILIES: readonly FamilyPattern[] = [
  // 前缀式恋慕分支：K{n}_KOJO2[_{模式}]
  { face: 'KOJO2', re: /^K(\d+)_KOJO2(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  // 带 K 的四族
  { face: 'SELF_KOJO', re: /^SELF_KOJO_K(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  { face: 'GUEST_KOJO', re: /^GUEST_KOJO_K(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  { face: 'IS_SINGLE_ENDING', re: /^IS_SINGLE_ENDING_K(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  { face: 'SINGLE_ENDING', re: /^SINGLE_ENDING_K(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  // 无 K 的三族
  { face: 'COUNTER_KOJO', re: /^COUNTER_KOJO_(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  { face: 'DAILY_LIFE_MESSAGE', re: /^DAILY_LIFE_MESSAGE_(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  { face: 'DAILY_LIFE_DAYEV', re: /^DAILY_LIFE_DAYEV_(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  // 指令/参数等主链路：KOJO_MESSAGE_{面}_{n}_{模式}
  {
    face: 'MESSAGE_$1',
    re: /^KOJO_MESSAGE_(COM|BEFORE_COM|AFTER_COM|PALAMCNG|MARKCNG|SHOOT|SAMEN_AND_EXTACY|GAG|BEFORE_GAG)_(\d+)(?:_(.+))?$/i,
    noGroup: 2,
    slotGroup: 3,
    prefix: 'KOJO',
  },
  // 带 K 的调教起止（`EVENTTRAIN_K48_2L`）
  { face: 'EVENTTRAIN', re: /^EVENTTRAIN_K(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
  { face: 'EVENTEND', re: /^EVENTEND_K(\d+)(?:_(.+))?$/i, noGroup: 1, slotGroup: 2 },
];

/**
 * 通用 `KOJO_{面}_{角色号}[_{尾段}]` 兜底（AEGI / RAND / EVENT_EXSTART / KAIRAKU …）。
 *
 * 惰性 head + 末尾数字锚：`KOJO_MESSAGE_COM_1_1` 会先被上面的专表吃掉；
 * 这里只接「head 是单词/下划线组合、随后是角色号」的形态。
 */
const GENERIC_KOJO_RE = /^KOJO_([A-Z][A-Z0-9_]*?)_(\d+)(?:_(.+))?$/i;

/** 角色私有函数：`K{n}_{名}`（`K39_KOJO_MAGIC_PRACTICE`；已排除 `_KOJO2` 主族） */
const PRIVATE_K_RE = /^K(\d+)_(.+)$/i;

/** 解析单个函数名（**纯函数**：只读入参与模块常量表）。 */
export function parseKojoFamily(rawName: string, _filePath?: string): FamilyMatch | null {
  const name = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (name.length === 0) return null;

  for (const fam of FAMILIES) {
    const m = fam.re.exec(name);
    if (m === null) continue;
    const no = Number.parseInt(m[fam.noGroup] ?? '', 10);
    if (!Number.isFinite(no)) continue;
    const face = fam.face.replace('$1', (m[1] ?? '').toUpperCase());
    const slot = fam.slotGroup === undefined ? '' : tail(no, m[fam.slotGroup]);
    return make(face, no, slot, { prefix: fam.prefix, kind: fam.kind });
  }

  const generic = GENERIC_KOJO_RE.exec(name);
  if (generic !== null) {
    const no = Number.parseInt(generic[2] ?? '', 10);
    if (Number.isFinite(no)) {
      return make((generic[1] ?? '').toUpperCase(), no, tail(no, generic[3]), { prefix: 'KOJO' });
    }
  }

  const priv = PRIVATE_K_RE.exec(name);
  if (priv !== null) {
    const no = Number.parseInt(priv[1] ?? '', 10);
    if (Number.isFinite(no)) {
      return make('KN', no, priv[2] ?? '', { kind: 'kn' });
    }
  }

  // 路由本体 / 无编号辅助函数：不归属任何角色，绝不猜
  return null;
}

/**
 * 构造 eraSQC 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用）。
 *
 * `instructionFaces` 为空：尾号是 `CFLAG:209` 口上模式，指令号在函数体内分派。
 */
export function createErasqcFamilyIndex(): FamilyIndexRule {
  return {
    name: 'erasqc-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return parseKojoFamily(fnName, filePath);
    },
    faceLabels: ERASQC_FACE_LABELS,
    instructionFaces: [],
  };
}
