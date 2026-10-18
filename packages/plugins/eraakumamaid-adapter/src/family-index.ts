/**
 * eraAkumaMaid 函数家族识别规则（`FamilyIndexRule` 实现）—— **全部 eraAkumaMaid 领域知识只住本包**。
 *
 * 目标：把口上函数名解析为结构化 `FamilyMatch`，供函数树导航 / 约定校验 / 条件矩阵消费。
 *
 * ## 命名体系：后缀式 `{面}_K{n}[_{尾段}]`
 *
 * 与 eraTW 的**中缀式** `M_KOJO{家族}_{面}_K{n}{slot}` 完全不同，**规则不可复用**。
 * 全量实测（`ERB/EVENT_K` 558 文件 / 3,352 函数 / 3,174 去重名，2026-10-18）：
 *
 * ```
 * KOJO_MESSAGE_COM_K1              ← 面=MESSAGE_COM，角色 1（每角色 1 份，75 处）
 * KOJO_MESSAGE_PALAMCNG_K1, ARGS   ← 尾部 `, ARGS` 入参声明（不是函数名一部分）
 * KOJO_DAILY2_K1_ADDSELECT         ← 面=DAILY2，尾段 ADDSELECT（345 处，唯一主流尾段）
 * KOJO_MESSAGE_COM_KX1             ← 模板占位符残留（KX 未置换，见下）
 * K1_KOJO2                         ← **前缀式**：K{n}_ 开头（74 处，每角色一份恋慕/刻印分支）
 * EVENTTRAIN / EVENTEND           ← 无编号后缀（每角色重复定义，靠 SIF NO:TARGET 守卫）⇒ null
 * ```
 *
 * ## 三条与 eraTW 的关键差异（全部实测确认）
 *
 * 1. **无家族段、无前缀域**：`FamilyMatch.family` 恒为 `''`、`prefix` 恒为 `''`。
 *    本游戏的 `KOJO_` 是**面名的一部分**（`KOJO_MESSAGE_COM`），不是家族域前缀；
 *    全量 head 段统计中零例 `{家族}_KOJO_{面}` 形态。为对齐契约仍保留家族段
 *    分解逻辑（additive 兜底，魔改若出现可自动识别）。
 * 2. **无指令号尾槽**：eraTW 的 `M_KOJO{t}_MESSAGE_${com}_K{n}_{i}`（`{i}`=指令号）
 *    在本游戏**不存在**——指令由 `@KOJO_MESSAGE_COM_K1` 单函数内 `IF SELECTCOM == n`
 *    分派（`EVENT_K1.ERB:239` 起）。故 `instructionFaces` 为**空数组**（显式声明
 *    "本游戏无此概念"，消费方据此不细分）。
 * 3. **纯数字尾段 = 私货/语音包变体，不是引擎时机槽**：全量 17 处 `_K{n}_{数字}`
 *    实测 14 处来自 `15 槞彁/遺産/`（语音包变体）、3 处来自
 *    `27 維吹/EVENT_K27_UNIQUE_EVENT.ERB`（剧本私货）；主路由一律拼
 *    `{面}_K{NO:TARGET}`（到角色号为止）⇒ 这些变体**不可达**。本模块仍按 `ok`
 *    解析并保留 `slot` 数字（信息不丢），由消费方按 `slot` 非空自行判定变异形。
 *
 * ## 尾段（`slot`）处理口径——**宁可不标面，不可标错面**
 *
 * 实测尾段只有三种可判形态：`ADDSELECT`（345 处，"追加选择"选项）、纯数字（17 处，
 * 见上）、空（绝大多数）。其余为私货尾巴（`USESOUL` / `KOJOLIST` / `LIBRARY` /
 * `DAILY_TALK` 等，各 1–2 处）。规则：
 * - 尾段为空 / `ADDSELECT` / 纯数字 ⇒ 正常标面（高置信）；
 * - 尾段为其它陌生词 ⇒ **face 置空**（例如 `EVENT_K15_LIBRARY` 是库函数、
 *   不是"事件面"；`KOJO_WISH_K25_USESOUL` 的尾巴是私货）——拿不准不猜面，
 *   但 `characterNo` / `slot` 仍保留，导航归属不丢。
 *
 * ## KX 占位符
 *
 * 新角色模板包（`口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_X1`）以
 * `_KX1` 后缀编写，需把 `X1` 全文替换为角色号。漏改 ⇒ 路由 `TRYCALLFORM
 * {面}_K{NO:TARGET}` 永远拼不到该名。`_KX{n}` 解析为 `isPlaceholder=true`、
 * `characterNo=null`；传了 `filePath` 时按文件名 `EVENT_K{n}` 锚还原角色号
 * （`…/01 フェリシエル/EVENT_K1.ERB` → 1，见 `alignPlaceholderToPath`）。
 */

import type { FamilyIndexRule, FamilyMatch, FamilyParseKind } from '@kojo/plugin-api';
import { parseKojoDirName } from './chara-csv';

/* ------------------------------- 面表 ------------------------------- */

/**
 * 已知面 token 表（**已剥 `KOJO_` 前缀的规范名**；`KOJO_WISH_K1` 与 `WISH_K1`
 * 归同一面 `WISH`）。按实测出现次数分组，全部来自 `ERB/EVENT_K` 全量 head 段统计。
 *
 * 只收**语义可判的口上时机/支撑面**；剧本辅助函数（`EMOTION` / `TIPS` / `RAND` /
 * `CREATE_MOB` / `TAITACHARA` 等）不收 ⇒ `face=''` 归"其它"，**不猜**。
 */
const FACE_TOKENS: readonly string[] = [
  /* 调教主链路（与 face-templates.ts 收录的 10 个糖面一致） */
  'MESSAGE_COM', // 75
  'MESSAGE_BEFORE_COM', // 75
  'MESSAGE_PALAMCNG', // 75
  'MESSAGE_MARKCNG', // 75
  'MESSAGE_SHOOT', // 75
  'MESSAGE_SAMEN_AND_EXTACY', // 75
  'COUNTER', // 75
  'EVENT', // 75
  'DAILY', // 74
  /* 调教扩展面（部分角色实装） */
  'MESSAGE_AFTERSHOOTCHANGE', // 28
  'MESSAGE_BEFORE_TARGETSHOOT', // 26
  'MESSAGE_COMING', // 10（仅 9 个角色 + 模板）
  'MESSAGE_DAISYUKI', // 2
  'ENDCOM', // 64
  'PRE_EVENTTRAIN', // 20
  /* 日常域 */
  'KOJO_DAILY1'.slice(5), // 'DAILY1' 38（另 36 处写作 KOJO_DAILY1，剥前缀后同面）
  'DAILY2', // 37（另 38 处 KOJO_DAILY2 同面）
  'DAILY2_SLEEP', // 22
  'DAILYCOM', // 74
  'SLEEP', // 74
  'GREETING', // 74
  'COMM', // 37
  /* 系统 / 支撑面 */
  'EVENT_PROFILE', // 74 角色介绍
  'IS_SINGLE_ENDING', // 74 单结局判定
  'MENU_SINGLE_ENDING', // 55 单结局菜单
  'SINGLE_ENDING', // 56 单结局
  'SETFLAG_BEFORE_TRAIN', // 67 训练前开关
  'CNAME', // 74 称呼
  'CLOTHES', // 75 服装
  'MAIDFACE', // 57 表情
  'UPDATE', // 60 更新
  'TIMEEVENT', // 54 时间事件
  'SELFY_MAIL', // 51 自寄邮件
  'ADDCOND', // 43 条件追加
  'WISH', // 114 + 39 愿望
  'DATE', // 94 + 34 约会
  'MOVE', // 24 移动
  'AFFAIRS', // 2 情事
  'GUEST', // 74 来客
  'SHOP', // 65 商店
];

const FACE_SET: ReadonlySet<string> = new Set(FACE_TOKENS);

/** 面表按长度降序（家族段兜底分解用：长面名优先，避免 `SLEEP` 截胡 `DAILY2_SLEEP`） */
const FACES_BY_LENGTH_DESC: readonly string[] = [...FACE_TOKENS].sort((a, b) => b.length - a.length);

/**
 * 面（`FamilyMatch.face`）→ 中文标签（游戏知识，只住本包）。
 *
 * `''`（其它）与 `'kn'`（前缀式私货）由消费方通用兜底，不入本表。未收录的 face
 * 消费方原样显示 token——**不猜**。
 */
export const ERAAKUMA_MAID_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  /* 调教主链路 */
  MESSAGE_COM: '指令口上',
  MESSAGE_BEFORE_COM: '指令前',
  MESSAGE_PALAMCNG: '参数变动',
  MESSAGE_MARKCNG: '刻印变化',
  COUNTER: '计数器',
  EVENT: '事件',
  MESSAGE_SHOOT: '射精',
  MESSAGE_COMING: '绝顶',
  MESSAGE_SAMEN_AND_EXTACY: '射精与绝顶',
  DAILY: '日常',
  /* 调教扩展 */
  MESSAGE_AFTERSHOOTCHANGE: '射精后变化',
  MESSAGE_BEFORE_TARGETSHOOT: '对方射精前',
  MESSAGE_DAISYUKI: '大喜欢',
  ENDCOM: '指令结束',
  PRE_EVENTTRAIN: '训练前事件',
  /* 日常域 */
  DAILY1: '日常一',
  DAILY2: '日常二',
  DAILY2_SLEEP: '日常二就寝',
  DAILYCOM: '日常对话',
  SLEEP: '就寝',
  GREETING: '问候',
  COMM: '交流',
  /* 系统 / 支撑 */
  EVENT_PROFILE: '角色介绍',
  IS_SINGLE_ENDING: '单结局判定',
  MENU_SINGLE_ENDING: '单结局菜单',
  SINGLE_ENDING: '单结局',
  SETFLAG_BEFORE_TRAIN: '训练前开关',
  CNAME: '称呼',
  CLOTHES: '服装',
  MAIDFACE: '表情',
  UPDATE: '更新',
  TIMEEVENT: '时间事件',
  SELFY_MAIL: '自寄邮件',
  ADDCOND: '条件追加',
  WISH: '愿望',
  DATE: '约会',
  MOVE: '移动',
  AFFAIRS: '情事',
  GUEST: '来客',
  SHOP: '商店',
});

/* ------------------------------ 正则常量 ------------------------------ */

/**
 * 入参声明裁剪：Emuera 函数名**不含逗号 / 分号 / 空白**，真实语料存在
 * `@KOJO_MESSAGE_PALAMCNG_K1, ARGS` 形态（`,` 之后是入参声明，不是名字的一部分）。
 * ⇒ 从**首个分隔符**起整段裁掉（eratw 只裁尾部，因为其语料的 `, ARGS` 已被上游
 * 裁过；本模块对原始形态也成立，两端口径在合法函数名上等价）。
 */
const TRAILING_JUNK_RE = /[\s,;].*$/;

/** KX 占位符：`{head}_KX{n}[_{tail}]`（新角色模板包 `_KX1` 形态） */
const KX_ANCHOR_RE = /^(.*)_KX(\d+)(_.+)?$/i;

/** 后缀式主锚：greedy `(.*)` ⇒ **取最后一个 `_K{digits}` 为编号锚**；
 *  `\d+` 后必须是 `_` 或串尾（`(_.+)?` 保证），`A_K1B` 类不会被误切 */
const SUFFIX_ANCHOR_RE = /^(.*)_K(\d+)(_.+)?$/i;

/** 前缀式：`K{n}_{剩余}`（eratw 的 'kn' 语义；本游戏 74 处 `K{n}_KOJO2` 为主） */
const PREFIX_ANCHOR_RE = /^K(\d+)_(.+)$/i;

/** 可判尾段：纯数字（私货/语音包变体后缀，见头注） */
const NUMERIC_TAIL_RE = /^\d+$/;

/** ADDSELECT 尾段（"追加选择"，唯一主流可判尾段；大小写按语料原样，比较时忽略大小写） */
const ADDSELECT_TAIL = 'ADDSELECT';

/* ------------------------------- 主解析 ------------------------------- */

/**
 * 解析单个函数名（**纯函数**：只读入参与模块常量表）。
 * @param filePath 可选文件来源：占位符形态可据文件 basename 的 `EVENT_K{n}` 还原角色号。
 *   **不传 ⇒ 判定与不传逐字一致**（占位符 `characterNo=null`）。
 * @returns FamilyMatch；与口上命名无关的函数返回 null（绝不猜测）。
 *
 * 外部一律走这个入口 ⇒ 自动享有名称 memo；`createKojoFamilyMemo()` 用于测试与独立作用域。
 */
export function parseKojoFamily(rawName: string, filePath?: string): FamilyMatch | null {
  return sharedFamilyMemo.parse(rawName, filePath);
}

/** 无 memo 的原始解析（memo 内部调用；纯函数） */
function parseKojoFamilyRaw(rawName: string): FamilyMatch | null {
  const name = (rawName ?? '').replace(TRAILING_JUNK_RE, '');
  if (name.length === 0) return null;

  // 1) KX 占位符（优先于主锚：`_KX1` 里没有 `_K{digits}` 锚，但先判更防御——
  //    若将来出现 `_KX1_K2` 这类拼接，占位符语义优先）
  const kx = KX_ANCHOR_RE.exec(name);
  if (kx) {
    return decomposeHead(kx[1] ?? '', {
      kind: 'placeholder',
      no: null,
      slot: stripLeadUnderscore(kx[3]),
      placeholder: true,
    });
  }

  // 2) 后缀式主路径：{head}_K{n}[_{tail}]
  const suffix = SUFFIX_ANCHOR_RE.exec(name);
  if (suffix) {
    return decomposeHead(suffix[1] ?? '', {
      kind: 'ok',
      no: Number(suffix[2]),
      slot: stripLeadUnderscore(suffix[3]),
      placeholder: false,
    });
  }

  // 3) 前缀式 `K{n}_{剩余}`（eratw 'kn' 语义）
  const prefix = PREFIX_ANCHOR_RE.exec(name);
  if (prefix) {
    return make({
      kind: 'kn',
      no: Number(prefix[1]),
      slot: stripLeadUnderscore(prefix[2] ? `_${prefix[2]}` : ''),
    });
  }

  // 4) 与口上命名无关（`EVENTTRAIN` / `EVENTEND` / `LIBT_*` / 引擎助手…）
  return null;
}

/* ------------------------------ 内部工具 ------------------------------ */

interface PartialBase {
  kind: FamilyParseKind;
  no: number | null;
  slot: string;
  placeholder: boolean;
}

function stripLeadUnderscore(s: string | undefined): string {
  if (!s) return '';
  return s.startsWith('_') ? s.slice(1) : s;
}

/** 统一构造（**冻结**：memo 共享实例的前提——允许改写会把一次判定漏进别的调用方） */
function make(p: {
  kind: FamilyParseKind;
  prefix?: string;
  family?: string;
  no?: number | null;
  face?: string;
  sub?: string;
  slot?: string;
  selector?: number;
  placeholder?: boolean;
  isMessageCheck?: boolean;
}): FamilyMatch {
  return Object.freeze({
    kind: p.kind,
    prefix: p.prefix ?? '',
    family: p.family ?? '',
    characterNo: p.no ?? null,
    selector: p.selector ?? 0,
    face: p.face ?? '',
    sub: p.sub ?? '',
    isMessageCheck: p.isMessageCheck ?? false,
    slot: p.slot ?? '',
    isPlaceholder: p.placeholder ?? false,
  });
}

/**
 * head 段 → 面（`{家族}` 恒空，见头注差异 1）。
 *
 * 判据顺序：
 * 1. 剥 `KOJO_` 前缀得规范 token（`KOJO` 单独一段 ⇒ 空 token）；
 * 2. 尾段**可判**（空 / ADDSELECT / 纯数字）且 token 精确命中面表 ⇒ 标面；
 * 3. token 未命中但形如 `{家族}_{面}` ⇒ 拆家族段（additive 兜底，实测零例）；
 * 4. 其余（含尾段陌生的情况）⇒ `face=''`，**不猜**。
 */
function decomposeHead(headRaw: string, base: PartialBase): FamilyMatch {
  const head = stripLeadUnderscore(headRaw).toUpperCase();

  // 规范 token：剥 KOJO_ 前缀（`KOJO` 单段 = 中缀残余如 `KOJO_K11_DAILY_TALK`，token 空）
  let token = head;
  if (token === 'KOJO') token = '';
  else if (token.startsWith('KOJO_')) token = token.slice('KOJO_'.length);

  // 尾段可判性：空 / ADDSELECT / 纯数字 ⇒ 高置信；陌生尾巴 ⇒ 面不标（见头注）
  const tail = base.slot;
  const tailIsKnown =
    tail.length === 0 || tail.toUpperCase() === ADDSELECT_TAIL || NUMERIC_TAIL_RE.test(tail);

  let face = '';
  let family = '';

  if (token.length > 0 && tailIsKnown) {
    if (FACE_SET.has(token)) {
      face = token;
    } else {
      // 家族段兜底（实测零例；保留 additive 逻辑：`{家族}_{面}` 形态）
      for (const f of FACES_BY_LENGTH_DESC) {
        if (token.endsWith(`_${f}`)) {
          family = token.slice(0, token.length - f.length - 1);
          face = f;
          break;
        }
      }
    }
  }

  return make({
    kind: base.kind,
    family,
    face,
    no: base.no,
    slot: base.slot,
    placeholder: base.placeholder,
  });
}

/* ------------------------ 占位符 → 文件编号还原 ------------------------ */

/**
 * 从文件路径还原角色号。
 *
 * eraAkumaMaid 的真编号确定性地落在**文件名的 `EVENT_K{n}` 前缀**上
 * （`…/01 フェリシエル/EVENT_K1.ERB` → 1）；`EVENT_K.ERB`（根层共享路由）与
 * `EVENT_KX1.ERB`（模板包，`X` 非数字）不匹配。文件名取不到时回退父目录名
 * （`{no} {名前}` 形态）。取不到 → null（不改判定，绝不猜测）。
 */
function characterNoFromPath(filePath: string): number | null {
  const parts = filePath.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  const m = /^EVENT_K(\d+)/i.exec(base);
  if (m) return Number(m[1]);
  const parent = parts[parts.length - 2] ?? '';
  const no = parseKojoDirName(parent)?.no;
  return no ?? null;
}

/**
 * 占位符形态对齐文件编号（additive，仅当传了 filePath 且解析结果是占位符时生效）：
 * 返回 `characterNo = 编号` 的同构 FamilyMatch（其余字段逐字保留）。
 * 非占位符、无路径、或取不到编号 → 原样返回。
 */
function alignPlaceholderToPath(match: FamilyMatch | null, filePath: string | undefined): FamilyMatch | null {
  if (!match || !match.isPlaceholder || filePath === undefined) return match;
  const no = characterNoFromPath(filePath);
  if (no === null) return match;
  return make({
    kind: match.kind,
    prefix: match.prefix,
    family: match.family,
    face: match.face,
    sub: match.sub,
    isMessageCheck: match.isMessageCheck,
    slot: match.slot,
    selector: match.selector,
    no,
    placeholder: match.isPlaceholder,
  });
}

/* ---------------------------- 名称解析 memo ---------------------------- */

/**
 * 「函数名 → 解析结果」的 memo（照 eratw 同款；读数口径一致）。
 *
 * **为什么值得**：一次全量约定校验会让四条规则各自扫全库，平均每个名字被解析
 * 4 次、其中约 3/4 是重复劳动；memo 把重复解析变成 `Map.get`。
 *
 * **上限是兜底**：满了整表清空而不是 LRU——名字集是"全库一遍"的形态，逐条淘汰
 * 只会让下一遍重新解析。
 *
 * **共享实例为什么安全**：`parseKojoFamilyRaw` 是纯函数，`make()` 返回值一律
 * `Object.freeze` ⇒ 任何改写尝试在 ESM 严格模式下直接抛错。这条不变量是 memo
 * 的前提，不是优化。
 */
const FAMILY_MEMO_LIMIT = 200_000;

export interface KojoFamilyMemo {
  /**
   * 解析函数名 → 家族结构。`filePath` 可选：占位符形态据文件编号还原角色号。
   * **键包含 filePath**——同名不同文件各占一条，否则占位符对齐结果会跨文件串味。
   */
  parse(rawName: string, filePath?: string): FamilyMatch | null;
  /** 当前条目数（内存上限读数；测试用来验淘汰行为） */
  size(): number;
  /** 命中 / 未命中次数——"memo 到底有没有生效"的读数，不靠推断 */
  stats(): { hits: number; misses: number };
  clear(): void;
}

export function createKojoFamilyMemo(limit = FAMILY_MEMO_LIMIT): KojoFamilyMemo {
  const memo = new Map<string, FamilyMatch | null>();
  let hits = 0;
  let misses = 0;
  return {
    parse(rawName: string, filePath?: string): FamilyMatch | null {
      // 键含 filePath（NUL 分隔，函数名/路径均不含 NUL）：占位符对齐结果依赖文件来源，
      // 只按 rawName 作键会让同名不同文件互相覆盖、返回陈旧判定。
      const key = filePath === undefined ? rawName : `${rawName}\u0000${filePath}`;
      const hit = memo.get(key);
      // 命中 null **也算命中**：非口上命名函数同样占大量调用，重跑 regex 链就是本批要消掉的成本
      if (hit !== undefined) {
        hits++;
        return hit;
      }
      misses++;
      const result = alignPlaceholderToPath(parseKojoFamilyRaw(rawName), filePath);
      if (memo.size >= limit) memo.clear();
      memo.set(key, result);
      return result;
    },
    size: () => memo.size,
    stats: () => ({ hits, misses }),
    clear: () => memo.clear(),
  };
}

const sharedFamilyMemo = createKojoFamilyMemo();

/** 清掉共享 memo（切项目时调用）。纯函数缓存，清空不改变任何判定。 */
export function clearKojoFamilyMemo(): void {
  sharedFamilyMemo.clear();
}

/** 共享 memo 的读数（诊断用：条目数 + 命中/未命中） */
export function kojoFamilyMemoStats(): { entries: number; hits: number; misses: number } {
  const { hits, misses } = sharedFamilyMemo.stats();
  return { entries: sharedFamilyMemo.size(), hits, misses };
}

/* ---------------------------- 规则对象 ---------------------------- */

/**
 * 构造 eraAkumaMaid 家族识别规则（供 `GameAdapter.functionFamilyIndex` 使用）。
 *
 * `instructionFaces: []` 是**显式声明**而非遗漏：本游戏无 `{i}` 指令号尾槽
 * （见头注差异 2），消费方据此整面成列、不按指令细分。
 */
export function createErakumamaidFamilyIndex(): FamilyIndexRule {
  return {
    name: 'eraakumamaid-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return parseKojoFamily(fnName, filePath);
    },
    faceLabels: ERAAKUMA_MAID_FACE_LABELS,
    instructionFaces: [],
  };
}
