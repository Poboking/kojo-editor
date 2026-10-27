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
import { parseKojoDirName } from './chara-csv';

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

/**
 * `PLAIN_FACES` 的下划线形态**只算一次**（原先每名字现拼 38 个模板串），并按**末位字符**分桶：
 * `endsWith` 只有末位相同才可能命中 ⇒ 38 次比较变 1 次取桶；桶内顺序 = 全局顺序，"最长优先"不变。
 */
type FaceEntry = { readonly face: string; readonly suffixed: string };
const PLAIN_FACE_SUFFIXES: readonly FaceEntry[] = PLAIN_FACES.map((face) => ({ face, suffixed: `_${face}` }));
const PLAIN_FACE_BUCKETS: ReadonlyMap<string, readonly FaceEntry[]> = (() => {
  const byLast = new Map<string, FaceEntry[]>();
  for (const entry of PLAIN_FACE_SUFFIXES) {
    const last = entry.suffixed.charAt(entry.suffixed.length - 1);
    const list = byLast.get(last);
    if (list) list.push(entry);
    else byLast.set(last, [entry]);
  }
  return byLast;
})();

/** 特殊结构面门禁：7 条正则都要求名字里出现这些字面量之一（不命中就整段跳过） */
const SPECIAL_HEAD_GUARD = /_(?:MESSAGE_PALAMCNG|IRAI|OPTION|VERSION|UPDATE)/;

/** 「裸家族」判据要的同一批标记（`includes('_MESSAGE_COM')` 等） */
const PLAIN_FACE_MARKERS: readonly string[] = PLAIN_FACE_SUFFIXES.map((f) => f.suffixed);

/** 尾部容忍字符的**末位**探测（命中才值得跑整条替换，见 `parseKojoFamilyRaw`） */
const TRAILING_JUNK = /[,;\s]$/;

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

/**
 * 面（`FamilyMatch.face`）→ 中文标签（游戏知识，只住本包）。
 *
 * 键 = 上面 `PLAIN_FACES` / `SPECIAL_HEADS` 产生的 face token；中文口径取自
 * `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` 附录 C（37 调用面的「触发场景」列）与
 * `face-templates.ts` 的分野关键字。`''`（其它）与 `'declare'`（家族声明）是通用
 * 语义、由消费方兜底，故不入本表。未收录的面消费方原样显示 token——**不猜**
 * （规范 §5.3 精神）。
 */
export const ERATW_FACE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  /* 系统时机 */
  ENCOUNTER: '初见',
  SPEVENT: '特殊事件',
  CUSTOM_EVENT: '自定义事件',
  EVENT: '事件',
  DAILY_EVENT: '每日事件',
  FLAGSETTING: '开关初始化',
  CHECK: '查询钩子',
  COLOR: '配色',
  /* 指令口上 / 成否 */
  MESSAGE: '通用口上',
  MESSAGE_COM: '指令口上',
  MESSAGE_SCOM: '副指令口上',
  MESSAGE_CUSTOM_COM: '自定指令口上',
  MESSAGE_CUSTOM_SCOM: '自定副指令口上',
  SUCCESS: '成否',
  SUCCESS_COM: '指令成否',
  SUCCESS_SCOM: '副指令成否',
  /* 计数器 / 参数变动 / 刻印 */
  MESSAGE_COUNTER: '计数器',
  MESSAGE_PALAMCNG: '参数变动',
  MESSAGE_MARKCNG: '刻印变化',
  /* 追加源 */
  EXTRASOURCE: '追加源',
  EXTRASOURCE_COM: '追加源（指令）',
  EXTRASOURCE_SCOM: '追加源（副指令）',
  /* 自定指令五钩子 */
  COM: '自定指令',
  COM_NAME: '自定指令名',
  COM_ABLE: '自定指令可用',
  CAN_COM: '自定指令可执行',
  COM_Counter不发: '自定指令计数器',
  /* 商店按钮 */
  CUSTOM_BUTTON: '商店按钮',
  CUSTOM_BUTTON_CONDITION: '商店按钮条件',
  /* 结局 / 日记 / 训练前 */
  MESSAGE_ENDING: '结局',
  DIARY: '日记',
  BEFORETRAIN: '训练前',
  /* 炮友契约 */
  SF_CONTRACT: '炮友契约',
  SF_CONTRACT_EVENT: '炮友契约事件',
  /* 自定义素质 */
  CUSTOM_TALENT_SET: '自定义素质',
  /* 委托 / 指南 / 版本 / 更新 */
  IRAI: '委托',
  OPTION: '游玩指南',
  OPTION_EXIST: '游玩指南存在',
  VERSION: '口上版本',
  VERSION_UPDATE: '口上版本更新',
  UPDATE: '更新钩子',
  /* 图像 */
  IMAGE: '图像口上',
  IMAGE_EX: '图像口上（扩展）',
  /* 其它面 token */
  COMMAND: '指令',
});

const PREFIXES: readonly string[] = ['M_KOJO', 'KOJO', 'DIARY', 'RUN_INTO'];

const MESSAGECHECK_MARKER = '_MESSAGECHECK';

/* ------------------------------- 主解析 ------------------------------- */

/**
 * 解析单个函数名（**纯函数**：只读入参与模块常量表）。
 * @param filePath 可选文件来源：占位符形态可据文件 basename 的编号还原角色号
 *   （`…/阿燐/M_KOJO_K36_コマンド.ERB` → 36）。**不传 ⇒ 判定与旧版逐字一致**。
 * @returns FamilyMatch；与口上命名无关的函数返回 null（绝不猜测）。
 *
 * 外部一律走这个入口 ⇒ 自动享有 §5.73 的名称 memo；`createKojoFamilyMemo()` 用于测试与独立作用域。
 */
export function parseKojoFamily(rawName: string, filePath?: string): FamilyMatch | null {
  return sharedFamilyMemo.parse(rawName, filePath);
}

function parseKojoFamilyRaw(rawName: string): FamilyMatch | null {
  // 容忍尾部逗号/空白（真实语料存在）。先做一次**只测末位**的探测：`[,;\s]$` 只能落在
  // 末位 ⇒ 不命中时是 O(1)，不必对 99k 个名字逐个跑一遍 `[,;\s]+$` 的回溯扫描。
  const name = TRAILING_JUNK.test(rawName) ? rawName.replace(/[,;\s]+$/, '') : rawName;

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
    // \d+ 之后必须是 `_` 或串尾（`(_.+)?` 保证），`A_K1B` 类不会被误切（回溯后无锚可依 → null）。
    const anchor = splitAtLastKAnchor(name);
    if (anchor && PLAIN_FACE_MARKERS.some((m) => anchor.head.includes(m))) {
      prefix = '';
      rest = name;
    } else {
      return null;
    }
  }

  // 4) K 锚点：rest = head..._K{no}{tail}
  const tailMatch = splitAtLastKAnchor(rest);
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

  return decomposeHead(tailMatch.head, {
    kind: 'ok',
    prefix,
    no: tailMatch.no,
    selector: 0,
    slot: tailMatch.tail === '' ? '' : tailMatch.tail.slice(1),
    isPlaceholder: false,
  });
}

/** 内部工具 */

/**
 * 取「最后一个 `_K{digits}` 锚点」，等价于 `/^(.*)_K(\d+)(_.+)?$/` 的贪婪语义：`(.*)` 尽可能长
 * ⇒ 锚点尽可能靠右；`(_.+)?` 要求分隔符后**至少还有一个字符**。手写是因为那条正则对每个名字都要
 * 从头回溯（99k 名字两处调用，self 76.8ms），从右往左只走"`_K` 个数 + 1"步。
 */
function splitAtLastKAnchor(s: string): { head: string; no: number; tail: string } | null {
  let limit = s.length;
  for (;;) {
    const k = s.lastIndexOf('_K', limit - 1);
    if (k < 0) return null;
    let j = k + 2;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
    }
    if (j > k + 2) {
      const head = s.slice(0, k);
      const no = Number(s.slice(k + 2, j));
      if (j === s.length) return { head, no, tail: '' };
      // `_.+` 形态：分隔符后面必须还有东西（`A_K1_` 不算槽位）
      if (s.charCodeAt(j) === 95 && j + 1 < s.length) return { head, no, tail: s.slice(j) };
    }
    limit = k;
  }
}

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
  // 冻结是 memo 的前提（见下方 createKojoFamilyMemo）：缓存的是**共享实例**，
  // 允许改写就会把一次判定漏进别的调用方。实测冻结 +4ms/99k、内存零增量。
  return Object.freeze({
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
  });
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

  // 特殊结构面（先过一道门禁：绝大多数名字一个特殊面 token 都没有，7 条正则就整段跳过）
  if (SPECIAL_HEAD_GUARD.test(head)) {
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
  }

  // 普通面（endsWith 最长优先；按末位分桶 + 后缀串预置，见 `PLAIN_FACE_BUCKETS`）
  const bucket = head === '' ? undefined : PLAIN_FACE_BUCKETS.get(head.charAt(head.length - 1));
  if (bucket) {
    for (const { face, suffixed } of bucket) {
      if (!head.endsWith(suffixed)) continue;
      if (head.length === suffixed.length) {
        return make({ ...base, family: '', face, sub: checkSub, isMessageCheck });
      }
      const famRaw = head.slice(0, head.length - suffixed.length);
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

/* ------------------------ 占位符 → 文件编号还原 ------------------------ */

/**
 * 从文件路径还原角色号：eraTW 变体（如 `eratw原生官方版4.842`）里大量个人口上把编号写成
 * 占位符，真编号**确定性地落在文件名的 `^M_KOJO_K{no}`** 上（如
 * `…/個人口上/阿燐/M_KOJO_K36_コマンド.ERB` → 36，与 4.980 的编号口径一致）。
 *
 * 例外：`159 先代` 目录的文件名形如 `M_KOJO_K1[]_*.ERB`——`1` 是 dummy（函数体实际用
 * `K159`），`[` 紧跟数字即判为占位（真形态后继字符实测只有 `_`/`.`/空格/`刻`）；此时
 * 回退解析父目录名（`159 先代` → 159）。取不到 → null（不改判定，绝不猜测）。
 */
function characterNoFromPath(filePath: string): number | null {
  const parts = filePath.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  const m = /^M_KOJO_K(\d+)(?!\[)/.exec(base);
  if (m) return Number(m[1]);
  if (/^M_KOJO_K\d+\[/.test(base)) {
    const no = parseKojoDirName(parts[parts.length - 2] ?? '')?.no;
    if (no !== undefined) return no;
  }
  return null;
}

/**
 * 占位符形态对齐文件编号（additive，仅当传了 filePath 且解析结果是占位符时生效）：
 * 返回 `characterNo = 编号` 的同构 FamilyMatch（`isPlaceholder` 等其余字段逐字保留）。
 * 非占位符、无路径、或取不到编号 → 原样返回（行为与改动前逐字一致）。
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
    isPlaceholder: match.isPlaceholder,
  });
}

/* ---------------------------- 名称解析 memo ---------------------------- */

/**
 * 「函数名 → 解析结果」的 memo（2026-10-12 §5.73）。
 *
 * **为什么值得**（真实语料 2,285 ERB / 99,101 个去重名，读数由 `kojoFamilyMemoStats()` 量得）：
 * 一次全量校验产生 **397,622 次**名称解析请求（命中 298,521 / 未命中 99,101）——四条规则各自扫一遍
 * 全库（`kx-placeholder` 与 `kojo-completeness` 扫 `byName` 的每个 ref，`messagecheck-structure`
 * 与 `kojo-call-slot-coverage` 扫每个函数），平均**每个名字被解析 4 次**，其中 **75% 是重复劳动**。
 * 实测解析一遍 265 ms、四遍约 1,060 ms；memo 把那 298,521 次重复变成 `Map.get`
 * （同样一遍遍历实测 8 ms）。
 *
 * （这里翻过一次车：按"`find` + 命中后再一次 + `filter`"推算 `kx` 是 3×/名字，得出 594,621 次——
 * **推错了**，`find` 在无命中时短路，而绝大多数名字无命中。**调用次数要量，不要从代码路径推**。）
 *
 * **内存实测**：99,101 条目 ≈ 15.6 MB（用同形状对象在 Map 里存 99,101 条量得，gc 后）；
 * `Object.freeze` 不加内存，CPU +4 ms/99k。所以配了 `clearKojoFamilyMemo()`，由 adapter 挂在
 * `project.closed` 上清表（内核 `open()` 会先 `close()` 旧项目 ⇒ 覆盖切项目路径）⇒ 不随之累积。
 * 上限是兜底：**满了整表清空而不是 LRU**——名字集是"全库一遍"的形态，逐条淘汰只会让下一遍
 * 重新解析，白留半成品。
 *
 * **共享实例为什么安全**：`parseKojoFamilyRaw` 是纯函数，`make()` 的返回值一律
 * `Object.freeze` ⇒ 任何改写尝试在 ESM 严格模式下直接抛错。这条不变量是 memo 的**前提**，
 * 不是优化——一旦被缓存的结果能被调用方改，memo 就会把 A 文件的判定漏进 B 文件。
 */
const FAMILY_MEMO_LIMIT = 200_000;

export interface KojoFamilyMemo {
  /**
   * 解析函数名 → 家族结构。`filePath` 可选：占位符形态据文件编号还原角色号
   * （见 `alignPlaceholderToPath`）。**占位符的判定按「名字 + 文件」缓存**——同名不同文件
   * 各占一条，否则对齐结果会跨文件串味；与文件无关的判定按名字缓存（见实现处的两张表）。
   */
  parse(rawName: string, filePath?: string): FamilyMatch | null;
  /** 当前条目数（内存上限的读数；测试用来验淘汰行为） */
  size(): number;
  /** 命中 / 未命中次数——"memo 到底有没有在生效"的读数，不靠推断 */
  stats(): { hits: number; misses: number };
  clear(): void;
}

export function createKojoFamilyMemo(limit = FAMILY_MEMO_LIMIT): KojoFamilyMemo {
  /**
   * **两张表**：按名字的（与 filePath 无关，占 99% 调用）与按「名字 + 文件」的（只放占位符）。
   * 旧实现每次拼 `${rawName}\u0000${filePath}` 再查表（99k 名字 × 80 余字符，`parse` self 107ms）；
   * 而只有占位符依赖文件来源（`alignPlaceholderToPath` 对非占位符原样返回）⇒ 按名字缓存即可。
   */
  const nameMemo = new Map<string, FamilyMatch | null>();
  /** 占位符专用（量极小：真语料里 KX 残留是少数）；键仍需带文件，否则同名不同文件串味 */
  const pathMemo = new Map<string, FamilyMatch | null>();
  let hits = 0;
  let misses = 0;
  const put = (table: Map<string, FamilyMatch | null>, key: string, value: FamilyMatch | null): void => {
    if (table.size >= limit) table.clear();
    table.set(key, value);
  };
  return {
    parse(rawName: string, filePath?: string): FamilyMatch | null {
      // 命中 null **也算命中**：非口生命名的函数（引擎助手、AA 工具等）同样占大量调用，
      // 每次重跑那条 regex 链就是本批要消掉的成本
      const byName = nameMemo.get(rawName);
      if (byName !== undefined) {
        hits++;
        return byName;
      }
      if (filePath !== undefined) {
        const byPath = pathMemo.get(`${rawName}\u0000${filePath}`);
        if (byPath !== undefined) {
          hits++;
          return byPath;
        }
      }
      misses++;
      const result = alignPlaceholderToPath(parseKojoFamilyRaw(rawName), filePath);
      // 占位符的对齐结果依赖文件来源（**含"没给文件"这一种**）⇒ 一律进「名字 + 文件」那张表；
      // 非占位符与路径无关 ⇒ 按名字缓存，热路径上只剩一次短键 `Map.get`
      if (result !== null && result.isPlaceholder) put(pathMemo, `${rawName}\u0000${filePath ?? ''}`, result);
      else put(nameMemo, rawName, result);
      return result;
    },
    size: () => nameMemo.size + pathMemo.size,
    stats: () => ({ hits, misses }),
    clear: () => {
      nameMemo.clear();
      pathMemo.clear();
    },
  };
}

const sharedFamilyMemo = createKojoFamilyMemo();

/**
 * 清掉共享 memo（切项目时调用）。
 * 纯函数缓存，清空不改变任何判定，只是下一遍重新解析——留着的意义小于它的内存占用。
 */
export function clearKojoFamilyMemo(): void {
  sharedFamilyMemo.clear();
}

/** 共享 memo 的读数（诊断用：条目数 + 命中/未命中） */
export function kojoFamilyMemoStats(): { entries: number; hits: number; misses: number } {
  const { hits, misses } = sharedFamilyMemo.stats();
  return { entries: sharedFamilyMemo.size(), hits, misses };
}

/* ---------------------------- 规则对象 ---------------------------- */

/** 构造 eraTW 家族识别规则（供 GameAdapter.functionFamilyIndex 使用） */
export function createEratwFamilyIndex(): FamilyIndexRule {
  return {
    name: 'eratw-family-index',
    match(fnName: string, filePath?: string): FamilyMatch | null {
      return parseKojoFamily(fnName, filePath);
    },
    faceLabels: ERATW_FACE_LABELS,
    instructionFaces: [
      'MESSAGE_COM',
      'MESSAGE_SCOM',
      'MESSAGE_CUSTOM_COM',
      'MESSAGE_CUSTOM_SCOM',
      'SUCCESS_COM',
      'SUCCESS_SCOM',
      'EXTRASOURCE_COM',
      'EXTRASOURCE_SCOM',
    ],
  };
}
