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
export const kxPlaceholderRule: ConventionRule = {
  id: KX_RULE,
  description: 'KX 占位符残留（模板置换 K1→K{角色号} 漏改，函数名永远匹配不到任何角色）',
  severity: 'warning',
  source: 'eratw4.980-口上机制深挖.md §1.2 / §11.3（模板置换发行约定）',
  check(ctx): ConventionIssue[] {
    const issues: ConventionIssue[] = [];
    for (const refs of ctx.index.byName.values()) {
      const hit = refs.find((r) => parseKojoFamily(r.name)?.isPlaceholder);
      if (!hit) continue;
      const m = parseKojoFamily(hit.name);
      const where = refs
        .filter((r) => parseKojoFamily(r.name)?.isPlaceholder)
        .map((r) => `${r.filePath}:${r.startLine}`);
      issues.push({
        ruleId: KX_RULE,
        severity: 'warning',
        message:
          `「${hit.name}」为 KX 占位符残留（共 ${where.length} 处）：模板以 K1 编写后需全文替换为 K{角色号}，` +
          `漏改则该口上永远不会被引擎调用。`,
        filePath: hit.filePath,
        line: hit.startLine,
        characterNo: m?.characterNo ?? undefined,
        family: m?.family || undefined,
        key: `${KX_RULE}|${hit.normalizedName}`,
      });
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

export const kojoCompletenessRule: ConventionRule = {
  id: COMPLETENESS_RULE,
  description: '口上家族完整性：家族声明 + 标配四件套（FLAGSETTING/COLOR/ENCOUNTER/EXTRASOURCE）',
  severity: 'warning',
  source: 'eratw4.980-口上机制深挖.md §6（FLAGSETTING）与 §11.2（四件套数量）',
  check(ctx): ConventionIssue[] {
    // 索引中每个角色号出现过哪些面 / 是否有家族声明 / 首个可跳转位置
    const facesByNo = new Map<number, Set<string>>();
    const declareNos = new Set<number>();
    const anchorByNo = new Map<number, { filePath: string; line: number }>();

    for (const refs of ctx.index.byName.values()) {
      for (const ref of refs) {
        const m = parseKojoFamily(ref.name);
        if (!m || m.characterNo === null) continue;
        const no = m.characterNo;
        if (m.kind === 'declare') declareNos.add(no);
        if (m.face) {
          let set = facesByNo.get(no);
          if (!set) {
            set = new Set<string>();
            facesByNo.set(no, set);
          }
          set.add(m.face);
        }
        if (m.face && !anchorByNo.has(no)) anchorByNo.set(no, { filePath: ref.filePath, line: ref.startLine });
      }
    }

    const issues: ConventionIssue[] = [];
    for (const chara of ctx.project.charaIndex.values()) {
      if (!chara.kojoDir) continue;
      const faces = facesByNo.get(chara.no);
      // 该角色在口上域里一条可识别函数都没有 → 不是"完整性"问题（可能整目录是未接入的草稿）
      if (!faces || faces.size === 0) continue;

      const anchor = anchorByNo.get(chara.no);
      const label = `#${chara.no} ${chara.name}`;

      if (!declareNos.has(chara.no)) {
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
  return {
    id: CALL_SLOT_RULE,
    description: '口上函数签名槽未被路由转发覆盖（多出的参数槽永远收引擎默认 0/空串）',
    severity: 'warning',
    source: 'KOJO_MESSAGE.ERB 路由表（call-protocol.ts）+ erb-parser 函数签名解析（ErbFunction.params）',
    check(ctx: ConventionCheckContext): ConventionIssue[] {
      const protocol = getProtocol?.();
      if (!protocol) return [];
      const issues: ConventionIssue[] = [];
      for (const file of ctx.index.files.values()) {
        for (const fn of file.functions) {
          const m = parseKojoFamily(fn.name);
          // 协议模板统一形如 `M_KOJO%口上名%_家族_K…`，口上名段要求**非空**
          // （`.+`）。空口上名函数（如 `M_KOJO_EVENT_K1_x`）协议无法可靠归属
          // （会被更短的家族模板误配）——跳过，绝不据歧义匹配产出误报。
          if (!m || m.family === '') continue;
          const fwd = protocol.maxForwardedSlotsFor(fn.name);
          if (!fwd) continue; // 协议不认识 → 非路由可达家族
          const declared = declaredSlotCounts(fn.params);
          if (declared.int <= fwd.int && declared.str <= fwd.str) continue;

          const parts: string[] = [];
          if (declared.int > fwd.int) parts.push(`数值槽 声明 ${declared.int} / 转发 ${fwd.int}`);
          if (declared.str > fwd.str) parts.push(`字符串槽 声明 ${declared.str} / 转发 ${fwd.str}`);
          issues.push({
            ruleId: CALL_SLOT_RULE,
            severity: 'warning',
            message:
              `「${fn.name}」的签名槽未被路由覆盖（${parts.join('，')}）：` +
              `多出的槽在调用时永远收到引擎默认值（数值 0 / 字符串空串），声明无效。`,
            filePath: fn.filePath,
            line: fn.startLine,
            characterNo: m.characterNo ?? undefined,
            family: m.family || undefined,
            key: `${CALL_SLOT_RULE}|${fn.normalizedName}`,
          });
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
