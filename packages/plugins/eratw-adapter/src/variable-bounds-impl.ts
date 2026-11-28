/**
 * 变量字面下标越界规则（P1-4）——只判**可证常量下标**，动态下标一律 fail-open。
 *
 * 真值与三条铁律：
 *
 * 1. **出厂值不是实读值**。`variables.yaml` 的 `size` 是引擎出厂尺寸；
 *    `CSV/VariableSize.csv` 可改（`ConstantData.cs:309-551`）。eraTW 实测：
 *    `CFLAG` 出厂 1000 → CSV 10000，语料 `CFLAG:<角色>:1000` 有 12,825 处；
 *    照出厂判就是一万多条假缺陷。规则**先读游戏 CSV，再判界**。
 * 2. **只判常量折叠的下标**。4.981 fork 把 1 维内置数组换成字典背板
 *    （`variables.yaml::array_semantics.sparse_1d_backplane`）：运行期动态下标越界
 *    不抛，执行前 Restructure 只对折成 SingleTerm 的实参调 CheckElement。
 *    故 `ITEMNAME:ARG` / `TEMP_STR:TEMP_ID` 一律不判——那不是漏，是引擎语义。
 * 3. **只对全局声明的用户数组判界**。函数内 `#DIM` 是调用栈局部，跨函数同名互不相干；
 *    拿 A 函数的尺寸去判 B 函数的同名下标就是造缺陷。
 *
 * 病灶自证：CB-002（ITEMNAME 4.981=1200 / 4.980=1000，混装包崩）、
 * CB-007（`#DIM CONST MAXPANTS=34` + `PANTS_TEMP:…:35`）、
 * CB-014（SPLIT 截断 + 动态 TEMP_ID，**必须不报**）。
 *
 * 文案取引擎官方键 `OoRVarArg`（`error-texts.yaml` zhs 原话），不另造说法。
 */
import type { ConventionCheckContext, ConventionIssue } from '@kojo/plugin-api';
import { erbCodeBodyOf, formatEngineErrorText, isErbCommentLine } from '@kojo/plugin-api';
import { ERB_VARIABLE_SIZES, type ErbVariableSizeEntry } from './data/variable-sizes';

export const VARIABLE_BOUNDS_RULE_ID = 'erb.variable-bounds';

/** CSV 尺寸覆盖：`CSV/VariableSize.csv`，只认整行 `NAME,size`，大小写敏感（引擎侧 nameDic 口径） */
function parseVariableSizeCsv(text: string): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*;.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z_][A-Za-z_0-9]*)\s*,\s*(\d+)\s*$/.exec(line);
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

/** 引擎实读尺寸 = 出厂兜底 + CSV 覆盖（只覆盖最后一维；多维尺寸口径不自造） */
function resolvedSizes(entry: ErbVariableSizeEntry, csv: ReadonlyMap<string, number>): readonly number[] {
  // CSV 名字表的出厂值随 MaxDataList 槽位（各名字不同）；快照没给逐条出厂值时
  // **不猜**，只在游戏 CSV 明确声明后才判——无 CSV ⇒ fail-open。
  const base = entry.sizes;
  const override = csv.get(entry.name);
  if (base.length === 0) return override === undefined ? [] : [override];
  if (base.length !== 1) return base;
  return override === undefined ? base : [override];
}

/**
 * 可见代码行（与 erb-parser `visibleCodeLines` 同判据：代码前缀尺、SKIP 块、注释
 * 全走 plugin-api 的单一定义；由 `variable-bounds.test.ts` 对拍两实现，防漂移）。
 */
export interface VisibleLine {
  readonly line: number;
  readonly code: string;
}
export function visibleLines(text: string): readonly VisibleLine[] {
  const out: VisibleLine[] = [];
  let inSkip = false;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    // 与 erb-parser::visibleCodeLines 共用 plugin-api 的代码前缀尺（`;!;` / `;#;` 后是真代码）
    const raw = lines[i]!.trim();
    const trimmed = erbCodeBodyOf(raw);
    if (inSkip) {
      if (trimmed === '[SKIPEND]') inSkip = false;
      continue;
    }
    if (trimmed === '[SKIPSTART]') {
      inSkip = true;
      continue;
    }
    if (!trimmed || isErbCommentLine(trimmed) || trimmed.startsWith('#') || trimmed.startsWith('$')) continue;
    // 整行 @FUNC 定义不判；注释尾巴与双引号字符串内容不判
    if (trimmed.startsWith('@')) continue;
    const code = trimmed.replace(/;.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (code) out.push({ line: i + 1, code });
  }
  return out;
}

/** 全局用户 `#DIM` 数组的尺寸（CONST 先收，声明第二参再解析） */
interface UserDim {
  readonly name: string;
  readonly dim: number;
  readonly sizes: readonly number[];
  readonly source: string;
}

function collectUserDims(
  ctx: ConventionCheckContext,
  texts: ReadonlyMap<string, string>,
): ReadonlyMap<string, UserDim> {
  const consts = new Map<string, number>();
  for (const text of texts.values()) {
    for (const m of text.matchAll(/^\s*#DIM\s+CONST\s+([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(\d+)\b/gim)) {
      const n = Number(m[2]);
      if (n > 0) consts.set(m[1]!.toUpperCase(), n);
    }
  }
  const out = new Map<string, UserDim>();
  for (const [filePath, text] of texts) {
    const file = ctx.index.files.get(filePath);
    const fns = file?.functions ?? [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!.replace(/\s*;.*$/, '').trim();
      if (!/^#DIM/i.test(ln)) continue;
      // 函数体内的 #DIM 是局部：跳过（跨函数同名不可共判）
      const line = i + 1;
      if (fns.some((fn) => line >= fn.startLine && line <= fn.endLine)) continue;
      const m = /^#DIM\s+(?:CHARADATA\s+|GLOBAL\s+|SAVEDATA\s+|STATIC\s+|DYNAMIC\s+|CONST\s+|REF\s+)*([A-Za-z_][A-Za-z_0-9]*)\s*,\s*([^,\s]+)/i.exec(ln);
      if (!m) continue;
      const name = m[1]!.toUpperCase();
      const token = m[2]!;
      const direct = /^\d+$/.test(token) ? Number(token) : consts.get(token.toUpperCase());
      if (direct === undefined || direct <= 0 || out.has(name)) continue;
      const isChara = /^#DIM\s+CHARADATA\b/i.test(ln);
      out.set(name, {
        name,
        dim: isChara ? 2 : 1,
        sizes: [direct],
        source: `${filePath}:${line}`,
      });
    }
  }
  return out;
}

function buildRegex(entries: readonly ErbVariableSizeEntry[], userDims: ReadonlyMap<string, UserDim>) {
  const globals: string[] = [];
  const charas: string[] = [];
  const user1: string[] = [];
  const user2: string[] = [];
  for (const e of entries) (e.dim === 1 ? globals : charas).push(e.name);
  for (const d of userDims.values()) (d.dim === 1 ? user1 : user2).push(d.name);
  const alt = (names: string[]) => (names.length ? names.join('|') : '(?!)');
  return {
    global: new RegExp(`(?<![:\\w])(${alt([...globals, ...user1])}):(\\d+)(?![:\\d])`, 'gi'),
    chara: new RegExp(`(?<![:\\w])(${alt([...charas, ...user2])}):(\\d+):(\\d+)(?![:\\d])`, 'gi'),
  };
}

function oor(key: 'OoRVarArg' | 'OoRCharaVar', name: string, argIndex: number, value: number, limit: number, source: string): string {
  return (
    formatEngineErrorText(key, [name, String(argIndex), String(value)]) +
    `——实读尺寸 ${limit}（${source}），静态可证的字面下标越界会在装载期/执行前抛 CodeEE。`
  );
}

export async function checkVariableBounds(ctx: ConventionCheckContext): Promise<ConventionIssue[]> {
    const root = ctx.project.rootDir;
    let csv = new Map<string, number>();
    try {
      const text = await ctx.readFile(`${root}/CSV/VariableSize.csv`.replace(/\\/g, '/'));
      csv = new Map(parseVariableSizeCsv(text));
    } catch {
      // 游戏没有这张表 ⇒ 全用出厂值（引擎同口径）。读不到不是错误，不产诊断。
    }

    const texts = new Map<string, string>();
    for (const filePath of ctx.index.files.keys()) {
      if (/\.(erb|erh)$/i.test(filePath)) {
        try {
          texts.set(filePath, await ctx.readFile(filePath));
        } catch {
          // 索引里有、此刻读不到 ⇒ 跳过该文件，不拿猜测补位
        }
      }
    }
    const userDims = collectUserDims(ctx, texts);
    const sizes = new Map<string, UserDim>();
    for (const e of ERB_VARIABLE_SIZES) {
      sizes.set(e.name, {
        name: e.name,
        dim: e.dim,
        sizes: resolvedSizes(e, csv),
        source: csv.has(e.name) ? 'CSV/VariableSize.csv' : '引擎出厂值',
      });
    }
    for (const [name, d] of userDims) sizes.set(name, d);
    const re = buildRegex(ERB_VARIABLE_SIZES, userDims);

    const issues: ConventionIssue[] = [];
    for (const [filePath, text] of texts) {
      for (const { line, code } of visibleLines(text)) {
        // 角色数组：第 1 参是角色号（运行期，不判），第 2 参才是槽
        for (const m of code.matchAll(re.chara)) {
          const d = sizes.get(m[1]!.toUpperCase());
          if (!d) continue;
          const n = Number(m[3]);
          if (d.sizes.length !== 1) continue;
          const limit = d.sizes[0]!;
          if (n < limit) continue;
          issues.push({
            ruleId: VARIABLE_BOUNDS_RULE_ID,
            severity: 'warning',
            message: oor('OoRCharaVar', m[1]!, 2, n, limit, d.source),
            filePath,
            line,
            key: `${VARIABLE_BOUNDS_RULE_ID}|${filePath}|${line}|${m[1]}|2|${n}`,
          });
        }
        for (const m of code.matchAll(re.global)) {
          const d = sizes.get(m[1]!.toUpperCase());
          if (!d) continue;
          const n = Number(m[2]);
          if (d.sizes.length !== 1) continue;
          const limit = d.sizes[0]!;
          if (n < limit) continue;
          issues.push({
            ruleId: VARIABLE_BOUNDS_RULE_ID,
            severity: 'warning',
            message: oor('OoRVarArg', m[1]!, 1, n, limit, d.source),
            filePath,
            line,
            key: `${VARIABLE_BOUNDS_RULE_ID}|${filePath}|${line}|${m[1]}|1|${n}`,
          });
        }
      }
    }
    return issues;
}
