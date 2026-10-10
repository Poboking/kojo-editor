/**
 * eraTW 函数家族识别规则（FamilyIndexRule 实现）。
 *
 * 目标：把 99k 行级别的口上函数名解析为结构化 FamilyMatch——
 * 这是函数树导航（v0.2）、约定校验器与差分矩阵的共同地基。
 *
 * 算法数据驱动开发（tools/analyze-kojo-names.mjs 全量验证）：
 * 对 eraTW 4.980 汉化整合版 101,876 个函数实测覆盖率 97.88%；
 * 剩余 2.12% 为作者私货命名与通用辅助函数（导航树归入"其它"即可）。
 *
 * 命名事实（详见逆向文档《口上机制深挖》§1.2 / §9）：
 * ```
 * M_KOJO{家族}_FACESUB_K{no}{slot}
 *   M_KOJO_K1_2                     ← 家族声明（selector=2）
 *   M_KOJO_少女之梦_COLOR_K1        ← 家族=少女之梦，面=COLOR
 *   M_KOJO_MESSAGE_COM_K1_30        ← 初始家族，面=MESSAGE_COM，slot=_30
 *   KOJO{家族}_OPTION_K1 / _VERSION_K1 …（KOJO 前缀域）
 *   DIARY{家族}_K1_TEXT / _K1_2     ← 日记系
 *   RUN_INTO{家族}_EVENT_K1         ← 外出遭遇
 *   K1_BEFORETRAIN{家族}            ← 家族名后置（独此一例）
 * ```
 * 两大长尾（全量数据揭示）：
 * - `_MESSAGECHECK` **中缀**：`M_KOJO_XXX_MESSAGECHECK_{sub}_K{no}_{slot}` 是位协议否决钩子；
 * - `_KX_` **占位符残留**：模板置换（K1→K{no}）事故的化石，约 1.5k 处——校验器的直接目标。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';

/* ------------------------------- 面表 ------------------------------- */

/**
 * 普通「面」名表（最长优先匹配）。
 * 顺序即优先级：长面名先匹配，避免 `SUCCESS` 截胡 `SUCCESS_COM`。
 */
const PLAIN_FACES: readonly string[] = [
  'MESSAGE_CUSTOM_COM',
  'MESSAGE_CUSTOM_SCOM',
  'MESSAGE_MARKCNG',
  'MESSAGE_COUNTER',
  'MESSAGE_ENDING',
  'CUSTOM_TALENT_SET',
  'CUSTOM_BUTTON_CONDITION',
  'CUSTOM_EVENT',
  'CUSTOM_BUTTON',
  'EXTRASOURCE_COM',
  'EXTRASOURCE_SCOM',
  'EXTRASOURCE',
  'SF_CONTRACT_EVENT',
  'SF_CONTRACT',
  'DAILY_EVENT',
  'FLAGSETTING',
  'SUCCESS_COM',
  'SUCCESS_SCOM',
  'SUCCESS',
  'MESSAGE_COM',
  'MESSAGE_SCOM',
  'MESSAGE_PALAMCNG',
  'MESSAGE',
  'SPEVENT',
  'ENCOUNTER',
  'COMMAND',
  'IMAGE_EX',
  'IMAGE',
  'COM_NAME',
  'COM_ABLE',
  'CAN_COM',
  'COM_Counter不发',
  'COM',
  'COLOR',
  'CHECK',
  'EVENT',
].sort((a, b) => b.length - a.length);

/** 特殊结构面（带子号捕获）：capture 1 = 家族段（may 空），capture 2 = 子号 */
const SPECIAL_HEADS: ReadonlyArray<{ face: string; re: RegExp }> = [
  // 射精等 PALAM 变体：_MESSAGE_PALAMCNG_A / _A1..A6 / _B .. _F
  { face: 'MESSAGE_PALAMCNG', re: /^(.*?)_MESSAGE_PALAMCNG(?:_([A-F]\d?))?$/ },
  // 依頼：_IRAI 或 _IRAI_{依頼名}
  { face: 'IRAI', re: /^(.*?)_IRAI(?:_([^_]+))?$/ },
  // 口上游玩指南 OPTION 系
  { face: 'OPTION_EXIST', re: /^(.*?)_OPTION_EXIST$/ },
  { face: 'OPTION', re: /^(.*?)_OPTION$/ },
  // 剧本更新钩子（VERSION_UPDATE 必须排在 UPDATE / VERSION 之前，否则被截胡）
  { face: 'VERSION_UPDATE', re: /^(.*?)_VERSION_UPDATE$/ },
  { face: 'UPDATE', re: /^(.*?)_UPDATE$/ },
  { face: 'VERSION', re: /^(.*?)_VERSION$/ },
];

const PREFIXES: readonly string[] = ['M_KOJO', 'KOJO', 'DIARY', 'RUN_INTO'];

const MESSAGECHECK_MARKER = '_MESSAGECHECK';

/* ------------------------------- 主解析 ------------------------------- */

/**
 * 解析单个函数名。
 * @returns FamilyMatch；与口上命名无关的函数返回 null（绝不猜测）。
 */
export function parseKojoFamily(rawName: string): FamilyMatch | null {
  const name = rawName.replace(/[,;\s]+$/, ''); // 容忍尾部逗号/空白（真实语料存在）

  // 1) 家族声明：M_KOJO_K{n} / M_KOJO_K{n}_{selector}
  let m = /^M_KOJO_K(\d+)(?:_(\d+))?$/.exec(name);
  if (m) {
    return make({
      kind: 'declare',
      prefix: 'M_KOJO',
      family: '',
      no: Number(m[1]),
      selector: m[2] ? Number(m[2]) : 0,
    });
  }

  // 2) BEFORETRAIN：K{n}_BEFORETRAIN{family}（家族名后置的唯一形态）
  m = /^K(\d+)_BEFORETRAIN(.*)$/.exec(name);
  if (m) {
    return make({
      kind: 'beforetrain',
      prefix: '',
      family: (m[2] ?? '').replace(/^_/, ''),
      no: Number(m[1]),
    });
  }

  // 3) 前缀剥离；无前缀时尝试"裸家族"与 K{n}_ 私货形态
  let prefix = PREFIXES.find((p) => name.startsWith(p)) ?? '';
  let rest: string;
  if (prefix) {
    rest = name.slice(prefix.length);
  } else {
    // K{n}_ 前缀私货（如 K1_CONFEDERATION_1_1）
    const knPrefix = /^K(\d+)_(.+)$/.exec(name);
    if (knPrefix) {
      return make({ kind: 'kn', prefix: '', family: '', no: Number(knPrefix[1]), slot: (knPrefix[2] ?? '').replace(/^_/, '') });
    }
    // 裸家族前缀（如 別人変身版_MESSAGE_COM_K1_1）：要求含已知面 + _K{digits}
    // 锚点语义（BUG-3 显式化）：greedy (.*) = **取最后一个 _K{no} 为编号锚**——
    // 家族名段允许再含 _K 段（如 X_K3_MESSAGE_COM_K1_1 → no=1，家族 MESSAGE_COM），
    // 与"最靠近槽位的 K 编号才是家族编号"的引擎家族命名一致。
    // \d+ 之后必须是 `_` 或串尾（`(_.+)?` 保证），`A_K1B` 类不会被误切（regex 回溯后无锚可依 → null）。
    const anchor = /^(.*)_K(\d+)(_.+)?$/.exec(name);
    if (anchor && PLAIN_FACES.some((f) => (anchor[1] ?? '').includes(`_${f}`))) {
      prefix = '';
      rest = name;
    } else {
      return null;
    }
  }

  // 4) K 锚点：rest = head..._K{no}{tail}
  const tailMatch = /^(.*)_K(\d+)(_.+)?$/.exec(rest);
  if (!tailMatch) {
    // KX 占位符（K{n} 未替换的模板残留）：照常解析面，编号置 null
    if (/_KX(?:_|$)/.test(name)) {
      const kxTail = /^(.*)_KX(_.+)?$/.exec(rest);
      if (kxTail) {
        return decomposeHead(kxTail[1] ?? '', {
          kind: 'placeholder',
          prefix,
          no: null,
          selector: 0,
          slot: (kxTail[2] ?? '').replace(/^_/, ''),
          isPlaceholder: true,
        });
      }
    }
    return null; // 无编号锚点又非占位符：与口上命名无关
  }

  return decomposeHead(tailMatch[1] ?? '', {
    kind: 'ok',
    prefix,
    no: Number(tailMatch[2]),
    selector: 0,
    slot: (tailMatch[3] ?? '').replace(/^_/, ''),
    isPlaceholder: false,
  });
}

/* ------------------------------ 内部工具 ------------------------------ */

interface PartialMatch {
  kind: FamilyParseKind;
  prefix: string;
  no: number | null;
  selector: number;
  slot: string;
  isPlaceholder: boolean;
}

function make(
  p: Partial<PartialMatch> & {
    kind: FamilyParseKind;
    family: string;
    face?: string;
    sub?: string;
    isMessageCheck?: boolean;
  },
): FamilyMatch {
  return {
    kind: p.kind,
    prefix: p.prefix ?? '',
    family: p.family,
    characterNo: p.no ?? null,
    selector: p.selector ?? 0,
    face: p.face ?? '',
    sub: p.sub ?? '',
    isMessageCheck: p.isMessageCheck ?? false,
    slot: p.slot ?? '',
    isPlaceholder: p.isPlaceholder ?? false,
  };
}

/** head 分解：剥 MESSAGECHECK（中缀）→ 特殊结构 → 普通面 */
function decomposeHead(headIn: string, base: PartialMatch): FamilyMatch | null {
  let head = headIn;
  let isMessageCheck = false;
  let checkSub = '';

  const mcIdx = head.lastIndexOf(MESSAGECHECK_MARKER);
  if (mcIdx >= 0) {
    isMessageCheck = true;
    checkSub = head.slice(mcIdx + MESSAGECHECK_MARKER.length);
    if (checkSub.startsWith('_')) checkSub = checkSub.slice(1);
    head = head.slice(0, mcIdx);
  }

  // 特殊结构面
  for (const { face, re } of SPECIAL_HEADS) {
    const sm = re.exec(head);
    if (sm) {
      const sub = (sm[2] ?? '').replace(/^_/, '');
      return make({
        ...base,
        family: stripFamilyMarker(sm[1] ?? ''),
        face,
        sub: sub || checkSub,
        isMessageCheck,
      });
    }
  }

  // 普通面（endsWith 最长优先）
  for (const face of PLAIN_FACES) {
    if (head === `_${face}`) {
      return make({ ...base, family: '', face, sub: checkSub, isMessageCheck });
    }
    if (head.endsWith(`_${face}`)) {
      const famRaw = head.slice(0, head.length - face.length - 1);
      return make({ ...base, family: stripFamilyMarker(famRaw), face, sub: checkSub, isMessageCheck });
    }
  }

  // DIARY 特例：DIARY{家族}_K{n}_{tail}（无面名，前缀即域）
  if (base.prefix === 'DIARY') {
    return make({ ...base, family: stripFamilyMarker(head), face: 'DIARY', sub: checkSub, isMessageCheck });
  }

  // M_KOJO_K{n}_{功能} 剧本私有函数（如 M_KOJO_K1_HEART）
  if (base.prefix === 'M_KOJO' && head === '') {
    return make({ ...base, family: '', face: '', sub: checkSub, isMessageCheck });
  }

  return null;
}

/** 家族段形如 `_少女之梦`：剥前导下划线；空串 → ''（初始家族） */
function stripFamilyMarker(head: string): string {
  if (!head) return '';
  return head.startsWith('_') ? head.slice(1) : head;
}

/* ---------------------------- 规则对象 ---------------------------- */

/** 构造 eraTW 家族识别规则（供 GameAdapter.functionFamilyIndex 使用） */
export function createEratwFamilyIndex(): FamilyIndexRule {
  return {
    name: 'eratw-family-index',
    match(fnName: string): FamilyMatch | null {
      return parseKojoFamily(fnName);
    },
  };
}
