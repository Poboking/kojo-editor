/**
 * eraTW 口上约定规则集（`GameAdapter.conventions`）——**全部 eraTW 领域知识集中于此**。
 *
 * 规则依据（`reverse-engineering/eratw4.980-口上机制深挖.md` 实测结论）：
 * 1. KX 占位符残留 —— 模板置换（K1→K{no}）事故化石，实测约 1.5k 处；
 * 2. 标配四件套 —— FLAGSETTING/COLOR/ENCOUNTER/EXTRASOURCE 各 ~190 家族；
 *    其中 **缺 FLAGSETTING 每次读档引擎会打印「基本标志未设定」警告**（硬后果）；
 * 3. FORM 三连符号 —— `===`/`***`/`+++`/`///`/`$$$` 在 PRINTFORM 串里会被引擎
 *    替换成角色名，用作分隔线会在无角色时崩/串味（StrForm.cs 语义）；
 * 4. MESSAGECHECK 位协议 —— 钩子应 RETURN bit0/bit1 掩码（0..3）。
 *
 * 原则：**宁可漏报不可误报**（RESEARCH.md §7）。语义拿不准的一律降级为 info。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionProjectUnitEntry,
  ConventionRule,
  ErbParam,
} from '@kojo/plugin-api';
import type { EratwCallProtocol } from './call-protocol';
import { parseKojoFamily } from './family-index';

/* ------------------------------ 工具 ------------------------------ */

const EOL_SPLIT = /\n/;

/** 取文件行数组；读取失败返回 null（调用方跳过，不伪造结果） */
async function readLines(ctx: ConventionCheckContext, path: string): Promise<string[] | null> {
  try {
    const text = await ctx.readFile(path);
    return text.split(EOL_SPLIT);
  } catch (err) {
    ctx.log.warn(`convention: failed to read ${path}: ${String(err)}`);
    return null;
  }
}

/** 是否注释行 / 空行 */
function isCommentOrBlank(trimmed: string): boolean {
  return trimmed.length === 0 || trimmed.startsWith(';');
}

/* --------------------- 规则 1：KX 占位符残留 --------------------- */

const KX_RULE = 'eratw.kx-placeholder';

/**
 * 一个**函数名**一个 issue（按归一化名去重）——实测 1,546 处占位符对应
 * 约 603 个去重函数名；逐处列举会淹没面板，逐名列举才是可操作清单。
 */
/** 一个 KX 命中点（`check` 与 `partition.combine` 共用的最小形态） */
interface KxRef {
  readonly name: string;
  readonly filePath: string;
  readonly startLine: number;
}

/** 一条命中组 ⇒ 一个 issue（两路共用这一份构造 ⇒ 产出逐字同形） */
function kxIssue(hit: KxRef, where: readonly string[]): ConventionIssue {
  const m = parseKojoFamily(hit.name);
  return {
    ruleId: KX_RULE,
    severity: 'warning',
    message:
      `「${hit.name}」为 KX 占位符残留（共 ${where.length} 处）：模板以 K1 编写后需全文替换为 K{角色号}，` +
      `漏改则该口上永远不会被引擎调用。`,
    filePath: hit.filePath,
    line: hit.startLine,
    characterNo: m?.characterNo ?? undefined,
    family: m?.family || undefined,
    key: `${KX_RULE}|${hit.name.toUpperCase()}`,
  };
}

/** `check` 的命中判据（`_KX` 子串前置过滤 + 占位符解析），两路共用 */
function isKxHit(name: string): boolean {
  return name.includes('_KX') && parseKojoFamily(name)?.isPlaceholder === true;
}

/** 分区 combine 用：单元 `[原名, 行号]` 按归一化名分组；插入序 = 首现 walk 序（= `byName` 组序） */
function groupKxHits(entries: readonly ConventionProjectUnitEntry[]): Map<string, KxRef[]> {
  const groups = new Map<string, KxRef[]>();
  for (const e of entries) {
    for (const [name, startLine] of e.unit as Array<readonly [string, number]>) {
      const norm = name.toUpperCase();
      const refs = groups.get(norm);
      const ref: KxRef = { name, filePath: e.file.path, startLine };
      if (refs) refs.push(ref);
      else groups.set(norm, [ref]);
    }
  }
  return groups;
}

/**
 * 分区复用（PERF-12b）：本规则的跨文件部分只是"同名去重后取首个命中"——
 * 前置过滤与占位符判定**纯看函数名**（`_KX` 子串 + `parseKojoFamily`），文件级可判。
 * 单元 = 该文件里过完前置过滤的候选 `[原名, 行号]`（合成盘几乎恒为空数组 ⇒ 每轮合并
 * 只走 O(文件数) 的空跳过，不再 O(函数数) 扫全库名）。
 * 分组的插入序 = 首现 walk 序（`erb-parser` 的 `byName` 由 `aggregateIndex` 按 walk
 * 序插入 ⇒ 与旧 `check` 遍历 `byName.values()` 的组序/组内序一致）。
 */
export const kxPlaceholderRule: ConventionRule = {
  id: KX_RULE,
  description: 'KX 占位符残留（模板置换 K1→K{角色号} 漏改，函数名永远匹配不到任何角色）',
  severity: 'warning',
  source: 'eratw4.980-口上机制深挖.md §1.2 / §11.3（模板置换发行约定）',
  partition: {
    fileUnit(_ctx, file): Array<readonly [string, number]> {
      const hits: Array<readonly [string, number]> = [];
      for (const fn of file.functions) {
        if (!isKxHit(fn.name)) continue;
        hits.push([fn.name, fn.startLine]);
      }
      return hits;
    },
    combine(_ctx, entries): ConventionIssue[] {
      const groups = groupKxHits(entries);
      const issues: ConventionIssue[] = [];
      for (const refs of groups.values()) {
        const hit = refs[0]!;
        const where = refs.map((r) => `${r.filePath}:${r.startLine}`);
        issues.push(kxIssue(hit, where));
      }
      return issues;
    },
    isUnit(v): boolean {
      return (
        Array.isArray(v) &&
        v.every((t) => Array.isArray(t) && t.length === 2 && typeof t[0] === 'string' && typeof t[1] === 'number')
      );
    },
  },
  check(ctx): ConventionIssue[] {
    const issues: ConventionIssue[] = [];
    for (const refs of ctx.index.byName.values()) {
      /**
       * **前置过滤 `includes('_KX')`**：`isPlaceholder` 为 true 只有 `family-index.ts` 里
       * 那一个分支，而它的入口条件就是 `/_KX(?:_|$)/.test(name)` ⇒ 名字不含 `_KX` 子串时
       * **必然**不是占位符。真实语料 99,101 个去重名里占位符只有 603 个，
       * 不加这道过滤就等于让这条规则替全场跑完整个解析链（实测它占校验段一半以上）。
       * 一遍收集，不再 `find` + `filter` 跑两遍。
       */
      const hits: KxRef[] = [];
      for (const r of refs) {
        if (!isKxHit(r.name)) continue;
        hits.push({ name: r.name, filePath: r.filePath, startLine: r.startLine });
      }
      const hit = hits[0];
      if (!hit) continue;
      const where = hits.map((r) => `${r.filePath}:${r.startLine}`);
      issues.push(kxIssue(hit, where));
    }
    return issues;
  },
};

/* --------------------- 规则 2：标配四件套完整性 --------------------- */

const COMPLETENESS_RULE = 'eratw.kojo-completeness';

/** 四件套：面名 → 缺失时的严重度与说明 */
const REQUIRED_FACES: ReadonlyArray<{ face: string; severity: 'warning' | 'info'; note: string }> = [
  {
    face: 'FLAGSETTING',
    severity: 'warning',
    note: '缺 FLAGSETTING：引擎每次读档都会打印「基本标志未设定」警告（门禁策略未表态）',
  },
  { face: 'COLOR', severity: 'info', note: '缺 COLOR：口上无法按角色配色（标配四件套之一）' },
  { face: 'ENCOUNTER', severity: 'info', note: '缺 ENCOUNTER：遭遇/初见场景无口上（标配四件套之一）' },
  { face: 'EXTRASOURCE', severity: 'info', note: '缺 EXTRASOURCE：指令追加文本不可扩展（标配四件套之一）' },
];

/** 完整性判定折叠后的三份事实（`check` 与 `partition.combine` 共用的中间形态） */
interface CompletenessFacts {
  readonly facesByNo: Map<number, Set<string>>;
  readonly declareNos: Set<number>;
  readonly anchorByNo: Map<number, { filePath: string; line: number }>;
}

/** 一条"家族可归属"的函数引用（两路共用） */
interface CompletenessRef {
  readonly no: number;
  readonly declare: boolean;
  readonly face: string;
  readonly filePath: string;
  readonly line: number;
}

/**
 * 折叠引用流 ⇒ 三份事实。**遍历序必须一致**（anchor = 首个带面的引用）：
 * `check` 走 `byName` 组序（组序 = 名字首现 walk 序、组内 walk 序）；
 * `combine` 走文件 walk 序 × 文件内函数序。"面"是名字派生属性 ⇒ 同组引用同面 ⇒
 * 两个口径下"某 no 的首个带面引用"取的是同一个 min(walk 位置)，结论一致（对拍用例钉死）。
 */
function foldCompleteness(refs: Iterable<CompletenessRef>): CompletenessFacts {
  const facesByNo = new Map<number, Set<string>>();
  const declareNos = new Set<number>();
  const anchorByNo = new Map<number, { filePath: string; line: number }>();
  for (const ref of refs) {
    if (ref.declare) declareNos.add(ref.no);
    if (ref.face) {
      let set = facesByNo.get(ref.no);
      if (!set) {
        set = new Set<string>();
        facesByNo.set(ref.no, set);
      }
      set.add(ref.face);
      if (!anchorByNo.has(ref.no)) anchorByNo.set(ref.no, { filePath: ref.filePath, line: ref.line });
    }
  }
  return { facesByNo, declareNos, anchorByNo };
}

/** 由三份事实产出问题（charaIndex 循环，两路共用的唯一一份） */
function completenessIssues(ctx: ConventionCheckContext, facts: CompletenessFacts): ConventionIssue[] {
  const issues: ConventionIssue[] = [];
  for (const chara of ctx.project.charaIndex.values()) {
    if (!chara.kojoDir) continue;
    const faces = facts.facesByNo.get(chara.no);
    // 该角色在口上域里一条可识别函数都没有 → 不是"完整性"问题（可能整目录是未接入的草稿）
    if (!faces || faces.size === 0) continue;

    const anchor = facts.anchorByNo.get(chara.no);
    const label = `#${chara.no} ${chara.name}`;

    if (!facts.declareNos.has(chara.no)) {
      issues.push({
        ruleId: COMPLETENESS_RULE,
        severity: 'warning',
        message: `${label} 缺少家族声明函数 M_KOJO_K${chara.no}：引擎存在判定会失败，整个口上不会被接通。`,
        filePath: anchor?.filePath,
        line: anchor?.line,
        characterNo: chara.no,
        key: `${COMPLETENESS_RULE}|declare|${chara.no}`,
      });
    }

    for (const req of REQUIRED_FACES) {
      if (faces.has(req.face)) continue;
      issues.push({
        ruleId: COMPLETENESS_RULE,
        severity: req.severity,
        message: `${label} ${req.note}`,
        filePath: anchor?.filePath,
        line: anchor?.line,
        characterNo: chara.no,
        key: `${COMPLETENESS_RULE}|${req.face}|${chara.no}`,
      });
    }
  }
  return issues;
}

/** 分区单元：该文件的可归属引用摘要 `[no, declare(1/0), face(''=无面), startLine]` */
type CompletenessUnit = Array<readonly [number, 0 | 1, string, number]>;

/**
 * 分区复用（PERF-12b）：本规则的 O(函数数) 部分 = 对每个名字跑 `parseKojoFamily`
 * （正则链，实测占校验段最大单项：2,000 棵盘 242–291ms/轮）；跨文件部分只是三份
 * 事实的并集 + charaIndex 循环（O(文件数 + 角色数)，微秒级 Map/Set 操作）。
 * 于是"改一棵"只重析那一棵的名字，其余文件的解析结果按 mtime 复用。
 */
export const kojoCompletenessRule: ConventionRule = {
  id: COMPLETENESS_RULE,
  description: '口上家族完整性：家族声明 + 标配四件套（FLAGSETTING/COLOR/ENCOUNTER/EXTRASOURCE）',
  severity: 'warning',
  source: 'eratw4.980-口上机制深挖.md §6（FLAGSETTING）与 §11.2（四件套数量）',
  partition: {
    fileUnit(_ctx, file): CompletenessUnit {
      const out: CompletenessUnit = [];
      for (const fn of file.functions) {
        const m = parseKojoFamily(fn.name);
        if (!m || m.characterNo === null) continue;
        const declare: 0 | 1 = m.kind === 'declare' ? 1 : 0;
        const face = m.face || '';
        if (declare === 0 && face === '') continue; // 对三份事实无贡献
        out.push([m.characterNo, declare, face, fn.startLine]);
      }
      return out;
    },
    combine(ctx, entries): ConventionIssue[] {
      const facts = foldCompleteness(
        (function* () {
          for (const e of entries) {
            for (const [no, declare, face, line] of e.unit as CompletenessUnit) {
              yield { no, declare: declare === 1, face, filePath: e.file.path, line };
            }
          }
        })(),
      );
      return completenessIssues(ctx, facts);
    },
    isUnit(v): boolean {
      return (
        Array.isArray(v) &&
        v.every(
          (t) =>
            Array.isArray(t) &&
            t.length === 4 &&
            typeof t[0] === 'number' &&
            (t[1] === 0 || t[1] === 1) &&
            typeof t[2] === 'string' &&
            typeof t[3] === 'number',
        )
      );
    },
  },
  check(ctx): ConventionIssue[] {
    const facts = foldCompleteness(
      (function* () {
        for (const refs of ctx.index.byName.values()) {
          for (const ref of refs) {
            const m = parseKojoFamily(ref.name);
            if (!m || m.characterNo === null) continue;
            yield { no: m.characterNo, declare: m.kind === 'declare', face: m.face, filePath: ref.filePath, line: ref.startLine };
          }
        }
      })(),
    );
    return completenessIssues(ctx, facts);
  },
};

/* --------------------- 规则 3：FORM 三连符号 --------------------- */

const FORM_RULE = 'eratw.form-triple-symbol';

/**
 * 引擎语义（源码实证 `LexicalAnalyzer.cs:1207-1219` + `CharStream.TripleSymbol():158`）：
 * FORM 串里**任意**连续 3 个 `* + = / $` 都会被词法切为 TripleSymbolSubWord 并替换为角色名
 * （`StrForm.cs:65-86`：`*`→NAME:TARGET、`+`→CALLNAME:MASTER、`=`→CALLNAME:PLAYER、
 * `/`→NAME:ASSI、`$`→CALLNAME:TARGET；受 `SystemIgnoreTripleSymbol` 开关约束）。
 *
 * 为何**排除 `+++`**：实测 43 个文件把 `+++` 作为 CALLNAME:MASTER 的**有意占位**写进正文
 * （"+++轻轻吻了…"），且 MASTER 恒存在、无崩溃风险——纳入只会制造噪声。
 * 其余四个是分隔线/AA 画事故的高发符号（实测 `///` 227 处集中在单个 AA 口上文件）。
 *
 * 报告粒度 = 每文件每符号一条（含出现次数与首次行号）：AA 事故是"整文件性质"，
 * 逐行列举只会淹没面板。
 */
const FORM_TRIPLE: ReadonlyArray<{ sym: string; note: string }> = [
  { sym: '===', note: 'CALLNAME:PLAYER' },
  { sym: '***', note: 'NAME:TARGET' },
  { sym: '///', note: 'NAME:ASSI' },
  { sym: '$$$', note: 'CALLNAME:TARGET' },
];
const PRINTFORM_HEAD = /^PRINTFORM/i;

export const formTripleSymbolRule: ConventionRule = {
  id: FORM_RULE,
  description: 'PRINTFORM 串出现三连符号（引擎会替换为角色名；用作分隔线/AA 画会串味或报错）',
  severity: 'warning',
  source: 'eratw4.980-词法与表达式.md §FORM 三连符号 + 引擎 LexicalAnalyzer.cs:1207 / StrForm.cs:65',
  // 只看该文件正文 ⇒ 可由引擎按文件复用结论（实测这条占校验段 55%，是最值得增量化的规则）
  scope: 'file',
  async checkFile(ctx, file): Promise<ConventionIssue[]> {
    const lines = await readLines(ctx, file.path);
    // 读失败**抛错**而不是返回空数组：空数组会被引擎当"这个文件判过了、没问题"存进桶，
    // 于是偶发的 IO 故障会被固化成"直到下次编辑都报不出问题"。抛错 ⇒ 引擎不留桶 ⇒ 下次重算。
    if (!lines) throw new Error(`读取失败：${file.path}`);
    const issues: ConventionIssue[] = [];
    /** sym → { count, firstLine } */
    const found = new Map<string, { count: number; firstLine: number }>();
    for (let i = 1; i <= lines.length; i++) {
      const trimmed = (lines[i - 1] ?? '').trim();
      if (isCommentOrBlank(trimmed) || !PRINTFORM_HEAD.test(trimmed)) continue;
      for (const { sym } of FORM_TRIPLE) {
        let idx = trimmed.indexOf(sym);
        while (idx >= 0) {
          const entry = found.get(sym);
          if (entry) entry.count++;
          else found.set(sym, { count: 1, firstLine: i });
          idx = trimmed.indexOf(sym, idx + sym.length);
        }
      }
    }
    for (const { sym, note } of FORM_TRIPLE) {
      const hit = found.get(sym);
      if (!hit) continue;
      issues.push({
        ruleId: FORM_RULE,
        severity: 'warning',
        message:
          `PRINTFORM 串出现 ${hit.count} 处「${sym}」：引擎会把它替换为 ${note}` +
          `（连续 3 个同符号即触发，「====」这类更长串也会命中），用作分隔线/AA 画会串味或报错。`,
        filePath: file.path,
        line: hit.firstLine,
        key: `${FORM_RULE}|${file.path}|${sym}`,
      });
    }
    return issues;
  },
};

/* --------------------- 规则 4：MESSAGECHECK 结构 --------------------- */

const MESSAGECHECK_RULE = 'eratw.messagecheck-structure';
const RETURN_LINE = /^\s*RETURN\s+(.+?)\s*$/i;

export const messageCheckStructureRule: ConventionRule = {
  id: MESSAGECHECK_RULE,
  description: 'MESSAGECHECK 钩子结构：应有 RETURN，且位掩码落在 0..3（bit0 跳情景 / bit1 跳口上）',
  severity: 'info',
  source: 'eratw4.980-口上机制深挖.md §1.3（MESSAGECHECK 位协议）',
  // 只看该文件的函数表 + 正文 ⇒ 逐文件可复用
  scope: 'file',
  async checkFile(ctx, file): Promise<ConventionIssue[]> {
    const targets = file.functions.filter((f) => parseKojoFamily(f.name)?.isMessageCheck);
    if (targets.length === 0) return []; // 没有 MESSAGECHECK 函数：判过了，结论就是"无问题"（可以留桶）
    const lines = await readLines(ctx, file.path);
    if (!lines) throw new Error(`读取失败：${file.path}`); // 同上：IO 故障不能编造成"干净"
    const issues: ConventionIssue[] = [];
    for (const fn of targets) {
      let sawReturn = false;
      for (let i = fn.startLine; i <= fn.endLine && i <= lines.length; i++) {
        const trimmed = (lines[i - 1] ?? '').trim();
        if (isCommentOrBlank(trimmed) || trimmed.startsWith('#')) continue;
        const m = RETURN_LINE.exec(trimmed);
        if (!m) continue;
        sawReturn = true;
        const expr = (m[1] ?? '').trim();
        if (!/^\d+$/.test(expr)) continue; // 表达式返回值交由运行时判定
        const mask = Number(expr);
        if (mask < 0 || mask > 3) {
          issues.push({
            ruleId: MESSAGECHECK_RULE,
            severity: 'warning',
            message: `MESSAGECHECK「${fn.name}」RETURN ${mask}：位掩码应为 0..3（bit0 跳情景 / bit1 跳口上），超出范围。`,
            filePath: file.path,
            line: i,
            key: `${MESSAGECHECK_RULE}|${fn.name}|${file.path}|${i}`,
          });
        }
      }
      if (!sawReturn) {
        issues.push({
          ruleId: MESSAGECHECK_RULE,
          severity: 'info',
          message: `MESSAGECHECK「${fn.name}」没有 RETURN 语句：被调用时返回值不可预期（默认视为 0 虽无害，但通常意味着漏写）。`,
          filePath: file.path,
          line: fn.startLine,
          key: `${MESSAGECHECK_RULE}|noreturn|${fn.name}|${file.path}`,
        });
      }
    }
    return issues;
  },
};

/* ------------- 规则 5：口上函数调用槽覆盖（签名槽 vs 路由转发） ------------- */

const CALL_SLOT_RULE = 'eratw.kojo-call-slot-coverage';

/**
 * 从函数形参表统计声明槽：`ARG`/`ARG:n` → 数值槽；`ARGS`/`ARGS:n` → 字符串槽。
 * **必须先判 ARGS**（前缀包含 ARG，否则字符串槽会被误计为数值槽）。
 * 非 ARG/ARGS 形参（如 `OVERRIDE_TARGET`）不参与——它们不属于"转发实参"模型。
 */
function declaredSlotCounts(params: readonly ErbParam[]): { int: number; str: number } {
  let int = 0;
  let str = 0;
  for (const p of params) {
    const name = p.name.toUpperCase();
    if (name === 'ARGS' || /^ARGS:\d+$/.test(name)) str++;
    else if (name === 'ARG' || /^ARG:\d+$/.test(name)) int++;
  }
  return { int, str };
}

/**
 * 分区单元的越界记录：`[原名, 归一化名, 定义行, characterNo|null, family, 声明数值槽, 声明字符串槽, 转发数值槽, 转发字符串槽]`。
 * 外部输入（协议）的**判定结果也进单元**——允许的前提是 `key()` 摘要了路由表内容：
 * 路由一变 key 变 ⇒ 全部单元作废重算（fail-closed），绝不出现"旧协议的单元 × 新协议"。
 */
type CallSlotUnit = Array<readonly [string, string, number, number | null, string, number, number, number, number]>;

/**
 * 口上函数调用槽覆盖校验：**签名声明槽** vs **路由转发实参槽**。
 *
 * 路由层（KOJO_MESSAGE.ERB）按**家族模板**转发实参——如 SPEVENT 家族
 * `TRYCALLFORM …_SPEVENT_K{…}_{ARG:1}(ARG:3,ARG:4)` 转发 2 个数值槽。
 * 若某口上函数声明的槽数多于该家族被转发的槽数，多出的槽在任何调用路径上都
 * 拿不到转发值，**永远是引擎默认 0 / 空串**（声明了却收不到，作者意图落空）。
 *
 * 覆盖判定按**存在性**：一个函数名可能被多条路由模板接纳（如
 * `_EVENT_K…_CHILD_RAISING_…` 既命中 `_CHILD_%ARGS:1%`，也命中通用
 * `_EVENT_K…_%ARGS:1%`）。只有当**任何**匹配模板都不转发该槽时才算"永远收默认值"
 * （`maxForwardedSlotsFor` 的逐类最大值语义）——**宁可漏报不可误报**。
 *
 * 依据：`call-protocol.ts` 路由表解析（家族 → 转发槽位语义）+
 * `erb-parser` 函数签名解析（`ErbFunction.params`）。
 *
 * 降级（与回放面板的协议降级同源，绝不猜测）：
 * - `getProtocol()` 返回 undefined（路由表缺失 / 读取失败）→ 不产出问题；
 * - 协议**不认识**该函数名（非路由可达家族）→ 跳过，不归本规则管。
 */
export function createCallSlotCoverageRule(getProtocol?: () => EratwCallProtocol | undefined): ConventionRule {
  /** 越界判定的唯一实现（`check` 全量路径与 `partition.fileUnit` 共用 ⇒ 两路产出构造性同形） */
  const offenderOf = (
    protocol: EratwCallProtocol,
    fn: { name: string; normalizedName: string; startLine: number; filePath: string; params: readonly ErbParam[] },
  ): CallSlotUnit[number] | null => {
    const m = parseKojoFamily(fn.name);
    // 协议模板统一形如 `M_KOJO%口上名%_家族_K…`，口上名段要求**非空**
    // （`.+`）。空口上名函数（如 `M_KOJO_EVENT_K1_x`）协议无法可靠归属
    // （会被更短的家族模板误配）——跳过，绝不据歧义匹配产出误报。
    if (!m || m.family === '') return null;
    const fwd = protocol.maxForwardedSlotsFor(fn.name);
    if (!fwd) return null; // 协议不认识 → 非路由可达家族
    const declared = declaredSlotCounts(fn.params);
    if (declared.int <= fwd.int && declared.str <= fwd.str) return null;
    return [fn.name, fn.normalizedName, fn.startLine, m.characterNo, m.family, declared.int, declared.str, fwd.int, fwd.str];
  };
  const issueOf = (o: CallSlotUnit[number], filePath: string): ConventionIssue => {
    const parts: string[] = [];
    if (o[5] > o[7]) parts.push(`数值槽 声明 ${o[5]} / 转发 ${o[7]}`);
    if (o[6] > o[8]) parts.push(`字符串槽 声明 ${o[6]} / 转发 ${o[8]}`);
    return {
      ruleId: CALL_SLOT_RULE,
      severity: 'warning',
      message:
        `「${o[0]}」的签名槽未被路由覆盖（${parts.join('，')}）：` +
        `多出的槽在调用时永远收到引擎默认值（数值 0 / 字符串空串），声明无效。`,
      filePath,
      line: o[2],
      characterNo: o[3] ?? undefined,
      family: o[4] || undefined,
      key: `${CALL_SLOT_RULE}|${o[1]}`,
    };
  };
  return {
    id: CALL_SLOT_RULE,
    description: '口上函数签名槽未被路由转发覆盖（多出的参数槽永远收引擎默认 0/空串）',
    severity: 'warning',
    source: 'KOJO_MESSAGE.ERB 路由表（call-protocol.ts）+ erb-parser 函数签名解析（ErbFunction.params）',
    partition: {
      key(): string {
        const protocol = getProtocol?.();
        return protocol ? `r${protocol.routeDigest ?? 'nodigest'}` : 'none';
      },
      fileUnit(_ctx, file): CallSlotUnit | undefined {
        const protocol = getProtocol?.();
        if (!protocol) return undefined; // 协议缺失 ⇒ 本轮无结论（降级不产问题，也不缓存）
        const out: CallSlotUnit = [];
        for (const fn of file.functions) {
          const o = offenderOf(protocol, fn);
          if (o) out.push(o);
        }
        return out;
      },
      combine(_ctx, entries): ConventionIssue[] {
        const issues: ConventionIssue[] = [];
        for (const e of entries) {
          for (const o of e.unit as CallSlotUnit) issues.push(issueOf(o, e.file.path));
        }
        return issues;
      },
      isUnit(v): boolean {
        return (
          Array.isArray(v) &&
          v.every(
            (t) =>
              Array.isArray(t) &&
              t.length === 9 &&
              typeof t[0] === 'string' &&
              typeof t[1] === 'string' &&
              typeof t[2] === 'number' &&
              (t[3] === null || typeof t[3] === 'number') &&
              typeof t[4] === 'string' &&
              typeof t[5] === 'number' &&
              typeof t[6] === 'number' &&
              typeof t[7] === 'number' &&
              typeof t[8] === 'number',
          )
        );
      },
    },
    check(ctx: ConventionCheckContext): ConventionIssue[] {
      const protocol = getProtocol?.();
      if (!protocol) return [];
      const issues: ConventionIssue[] = [];
      for (const file of ctx.index.files.values()) {
        for (const fn of file.functions) {
          const o = offenderOf(protocol, fn);
          if (o) issues.push(issueOf(o, fn.filePath));
        }
      }
      return issues;
    },
  };
}

/* ---------------------------- 汇总 ---------------------------- */

/**
 * 构造 eraTW 约定规则集（供 `GameAdapter.conventions` 使用）。
 * `getProtocol` 为可选的调用协议提供者（适配器在 loadProject 时解析路由表后注入）；
 * 缺省 → 覆盖规则降级（不产出问题）。
 */
export function createEratwConventions(getProtocol?: () => EratwCallProtocol | undefined): readonly ConventionRule[] {
  return [
    kxPlaceholderRule,
    kojoCompletenessRule,
    formTripleSymbolRule,
    messageCheckStructureRule,
    createCallSlotCoverageRule(getProtocol),
  ];
}
