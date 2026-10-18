/**
 * eraAkumaMaid 口上约定规则集（`GameAdapter.conventions`）——**全部 eraAkumaMaid 领域知识集中于此**。
 *
 * 规则依据（`/c/game/eraAkumaMaid` 实测，2026-10-18；ERB 均 UTF-8-BOM）：
 * 1. KX 占位符残留 —— 新角色模板包（`口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_X1`）
 *    以 `_KX1` 后缀编写，需把 X1 全文替换为角色号；漏改 ⇒ 路由表
 *    `TRYCALLFORM KOJO_..._K{NO:TARGET}` 永远拼不到该名，口上成死代码。
 *    EVENT_K 域实测 5 个去重函数名（集中在 `15 槞彁/遺産/EVENT_K15_DAILY_勧誘初期.ERB`）。
 * 2. FORM 三连符号 —— 引擎通用语义（本作是 Emuera 1824+v18 私家改造版，与 eraTW 同宗，
 *    StrForm.cs 的 TripleSymbol 替换不变）：`===`/`***`/`///`/`$$$` 在 PRINTFORM 串里
 *    被替换为角色名。AM 实测命中极少（`===` 0 / `***` 1 / `///` 4 行 / `$$$` 0；
 *    `+++` 1 处为 AA 画噪声，同 eratw 口径排除）。
 *
 * **未移植 eraTW 两条规则（取证结论——查不到硬后果就不硬搬）**：
 * - 缺核心族（eratw 的 kojo-completeness）：AM **无**「标配四件套」概念——
 *   FLAGSETTING/COLOR/ENCOUNTER/EXTRASOURCE 全 ERB 树零命中；无 eraTW 式
 *   `@M_KOJO_K{n}` 家族声明函数（AM 家族声明靠 CHARA CSV + 目录名）；引擎侧
 *   （SYSTEM/ 与 EVENT_K.ERB）无"缺族警告"文案；路由全部 TRYCALLFORM 静默跳过
 *   ⇒ 不存在"缺了每次读档打印警告"的硬后果族 ⇒ **不做该规则**。
 * - MESSAGECHECK 位协议：全 ERB 树（大小写不敏感）零命中 ⇒ AM 无此位协议 ⇒ **不做**。
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
import type { ErakumamaidCallProtocol } from './call-protocol';
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

const KX_RULE = 'eraakumamaid.kx-placeholder';

/**
 * 一个**函数名**一个 issue（按归一化名去重）——逐处列举会淹没面板，
 * 逐名列举才是可操作清单（AM 实测总量小，但化石常整段复制，一处漏改常带一串同名）。
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
      `「${hit.name}」为 KX 占位符残留（共 ${where.length} 处）：新角色模板以 _KX1 编写，` +
      `需把 X1 全文替换为角色号；漏改则路由表 TRYCALLFORM …_K{NO:TARGET} 永远拼不到该名，这段口上不会被引擎调用。`,
    filePath: hit.filePath,
    line: hit.startLine,
    characterNo: m?.characterNo ?? undefined,
    family: m?.family || undefined,
    key: `${KX_RULE}|${hit.name.toUpperCase()}`,
  };
}

/** `check` 的命中判据（`_KX` 子串前置过滤 + 占位符解析），两路共用。
 *  前置过滤**必须大小写不敏感**：Emuera 函数名大小写不敏感，真实语料存在小写
 *  `_kx1` 变体（分区对拍用例先撞上过这个坑）——`parseKojoFamily` 本身用 `/i`，
 *  过滤若敏感就会把同一家族的两种写法拆成两半。 */
function isKxHit(name: string): boolean {
  return name.toUpperCase().includes('_KX') && parseKojoFamily(name)?.isPlaceholder === true;
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
  description: 'KX 占位符残留（模板置换 X1→角色号 漏改，函数名永远匹配不到任何角色）',
  severity: 'warning',
  source: 'eraAkumaMaid 口上テンプレート/新キャラ追加用パッケージ/KOJOPackage_X1（模板化石）+ EVENT_K.ERB 路由表实测',
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
       * **前置过滤 `includes('_KX')`**（同 eratw 口径）：占位符分支的入口条件是
       * `_KX` 系后缀 ⇒ 名字不含 `_KX` 子串时**必然**不是占位符；不加这道过滤
       * 就等于让这条规则替全场跑完整个解析链。一遍收集，不再 `find` + `filter` 跑两遍。
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

/* --------------------- 规则 2：FORM 三连符号 --------------------- */

const FORM_RULE = 'eraakumamaid.form-triple-symbol';

/**
 * 引擎语义（与 eraTW 同宗：Emuera 1824+v18，`StrForm.cs` TripleSymbol 替换）：
 * FORM 串里**任意**连续 3 个 `* + = / $` 都会被词法切为 TripleSymbolSubWord 并替换为角色名
 * （`*`→NAME:TARGET、`+`→CALLNAME:MASTER、`=`→CALLNAME:PLAYER、
 * `/`→NAME:ASSI、`$`→CALLNAME:TARGET；受 `SystemIgnoreTripleSymbol` 开关约束）。
 *
 * 为何**排除 `+++`**（沿用 eratw 实测口径）：`+++` 常被作者当作 CALLNAME:MASTER 的
 * **有意占位**写进正文，且 MASTER 恒存在、无崩溃风险——纳入只会制造噪声。
 * AM 实测唯一 `+++` 命中在 AA 画式乱调句里（`EVENT_K15_LIBRARY.ERB`），排除正确。
 * 其余四个是分隔线/AA 画事故的高发符号（AM 实测 `///` 4 行、`***` 1 行，量少但性质同）。
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
  source: 'eraAkumaMaid ERB/EVENT_K 实测（Emuera 1824+v18，StrForm.cs TripleSymbol 语义，与 eraTW 同宗）',
  // 只看该文件正文 ⇒ 可由引擎按文件复用结论
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

/* ------------- 规则 3：口上函数调用槽覆盖（签名槽 vs 路由转发） ------------- */

const CALL_SLOT_RULE = 'eraakumamaid.kojo-call-slot-coverage';

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
 * 路由层（`ERB/EVENT_K/EVENT_K.ERB`）按**家族模板**转发实参——实测 18 行 TRYCALLFORM、
 * 14 个家族形态全部是 `KOJO_<家族>_K{NO:TARGET}`，**无括号形实参**；仅 5 行带逗号式实参
 * （PALAMCNG `, LOCALS`；COUNTER/MARKCNG/EVENT/GUEST `, ARGS`）。即 AM 绝大多数家族
 * 转发 0 槽 ⇒ 本规则在 AM 语料上自然少产出——**行为正确即可，不为凑数放宽判定**。
 *
 * 若某口上函数声明的槽数多于该家族被转发的槽数，多出的槽在任何调用路径上都
 * 拿不到转发值，**永远是引擎默认 0 / 空串**（声明了却收不到，作者意图落空）。
 *
 * 覆盖判定按**存在性**：一个函数名可能被多条路由模板接纳（如通用模板与更具体的
 * 模板同时命中）。只有当**任何**匹配模板都不转发该槽时才算"永远收默认值"
 * （`maxForwardedSlotsFor` 的逐类最大值语义）——**宁可漏报不可误报**。
 *
 * 依据：`call-protocol.ts` 路由表解析（家族 → 转发槽位语义）+
 * `erb-parser` 函数签名解析（`ErbFunction.params`）。
 *
 * 降级（与回放面板的协议降级同源，绝不猜测）：
 * - `getProtocol()` 返回 undefined（路由表缺失 / 读取失败）→ 不产出问题；
 * - 协议**不认识**该函数名（非路由可达家族）→ 跳过，不归本规则管。
 */
export function createCallSlotCoverageRule(getProtocol?: () => ErakumamaidCallProtocol | undefined): ConventionRule {
  /** 越界判定的唯一实现（`check` 全量路径与 `partition.fileUnit` 共用 ⇒ 两路产出构造性同形） */
  const offenderOf = (
    protocol: ErakumamaidCallProtocol,
    fn: { name: string; normalizedName: string; startLine: number; filePath: string; params: readonly ErbParam[] },
  ): CallSlotUnit[number] | null => {
    const m = parseKojoFamily(fn.name);
    // 归属维度在 eraAkumaMaid 是**面**（face）而非家族（family 恒为空，见
    // family-index 头注差异 1）——eratw 的 `family !== ''` 判据在这里会把**全部**
    // 主链路函数判成"无法归属"，规则永久零产出（照抄陷阱）。
    // 面与家族都空 ⇒ 协议无法可靠归属（会被更短的模板误配）——跳过，绝不据歧义匹配产出误报。
    if (!m || (m.family === '' && m.face === '')) return null;
    const fwd = protocol.maxForwardedSlotsFor(fn.name);
    if (!fwd) return null; // 协议不认识 → 非路由可达家族
    const declared = declaredSlotCounts(fn.params);
    if (declared.int <= fwd.int && declared.str <= fwd.str) return null;
    return [fn.name, fn.normalizedName, fn.startLine, m.characterNo, m.family || m.face, declared.int, declared.str, fwd.int, fwd.str];
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
    source: 'ERB/EVENT_K/EVENT_K.ERB 路由表（call-protocol.ts）+ erb-parser 函数签名解析（ErbFunction.params）',
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
 * 构造 eraAkumaMaid 约定规则集（供 `GameAdapter.conventions` 使用）。
 * `getProtocol` 为可选的调用协议提供者（适配器在 loadProject 时解析路由表后注入）；
 * 缺省 → 覆盖规则降级（不产出问题）。
 *
 * 与 eraTW 规则集的差异（取证结论）：
 * - 无「缺核心族」规则（AM 无标配四件套、无家族声明函数、无缺族警告）；
 * - 无「MESSAGECHECK 位协议」规则（AM 全 ERB 树零命中）；
 * - KX/FORM/调用槽覆盖三条照移植（id 前缀 `eraakumamaid.`）。
 */
export function createErakumamaidConventions(getProtocol: () => ErakumamaidCallProtocol | undefined): readonly ConventionRule[] {
  return [kxPlaceholderRule, formTripleSymbolRule, createCallSlotCoverageRule(getProtocol)];
}
