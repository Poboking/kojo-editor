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
 * @returns FamilyMatch；与口上命名无关的函数返回 null（绝不猜测）。
 *
 * 外部一律走这个入口 ⇒ 自动享有 §5.73 的名称 memo；`createKojoFamilyMemo()` 用于测试与独立作用域。
 */
export function parseKojoFamily(rawName: string): FamilyMatch | null {
  return sharedFamilyMemo.parse(rawName);
}

function parseKojoFamilyRaw(rawName: string): FamilyMatch | null {
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
  parse(rawName: string): FamilyMatch | null;
  /** 当前条目数（内存上限的读数；测试用来验淘汰行为） */
  size(): number;
  /** 命中 / 未命中次数——"memo 到底有没有在生效"的读数，不靠推断 */
  stats(): { hits: number; misses: number };
  clear(): void;
}

export function createKojoFamilyMemo(limit = FAMILY_MEMO_LIMIT): KojoFamilyMemo {
  const memo = new Map<string, FamilyMatch | null>();
  let hits = 0;
  let misses = 0;
  return {
    parse(rawName: string): FamilyMatch | null {
      const hit = memo.get(rawName);
      // 命中 null **也算命中**：非口生命名的函数（引擎助手、AA 工具等）同样占大量调用，
      // 每次重跑那条 regex 链就是本批要消掉的成本
      if (hit !== undefined) {
        hits++;
        return hit;
      }
      misses++;
      const result = parseKojoFamilyRaw(rawName);
      if (memo.size >= limit) memo.clear();
      memo.set(rawName, result);
      return result;
    },
    size: () => memo.size,
    stats: () => ({ hits, misses }),
    clear: () => memo.clear(),
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
    match(fnName: string): FamilyMatch | null {
      return parseKojoFamily(fnName);
    },
    faceLabels: ERATW_FACE_LABELS,
  };
}
