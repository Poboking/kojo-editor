/**
 * `# 方言 <名字>` 的 **CST 闸 + 文法↔出货 wasm 同步闸**（LAU §5.3 / spec §3.3 · L5 车道）。
 *
 * 为什么这一份必须存在：kojo2 的声明词位是**烧进 wasm** 的
 * （`grammar.v2.js` 逐词 `decl(word)` → `:70` 把词拼进 RegExp token）⇒ 改了 `grammar.v2.js`
 * 却没重跑 `tools/build-v2.mjs`，出货 wasm 与文法就**永久分叉**，而且没有任何一层会报错。
 * 本文件第 4 条判据把这条缝钉住：**现场从 `grammar.v2.js` 读出全部声明词，逐词用出货 wasm 解**，
 * 少一具跟不上的 wasm 就当场红。
 *
 * 覆盖面：
 * 1. `# 方言 erafl` → `dialect_decl` 节点、零 ERROR / 零 MISSING；
 * 2. 词后必须整词、锚点后必须有空白（`# 方言erafl` 这类仍然落 ERROR，语法不比规范松）；
 * 3. 追加新词位没有改动既有词位的形态与判据（逐词回归）；
 * 4. 文法 ↔ wasm 同步（上面那条）；
 * 5. 断言行能挂在 `source_file` 下，与 `scene_decl` / `view_decl` / `event_decl` 同区共存。
 *
 * 解析一律走出货 wasm（`tree-sitter-kojo2.wasm`），不另建 native 依赖。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Language, Parser, type Node } from 'web-tree-sitter';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const wasmPath = join(pkgRoot, 'tree-sitter-kojo2.wasm');
const grammarPath = join(pkgRoot, 'grammar.v2.js');

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  const language = await Language.load(wasmPath);
  parser = new Parser();
  parser.setLanguage(language);
}, 120_000);

/** 全文扫 ERROR / MISSING（行号 0 基，报错时人可直读）。 */
function faultsOf(root: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.type === 'ERROR' || n.isMissing) {
      out.push(`${n.isMissing ? `MISSING:${n.type}` : 'ERROR'}@行${n.startPosition.row + 1}[${n.text}]`);
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

function parse(source: string): Node {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`解析没产出树：${JSON.stringify(source)}`);
  return tree.rootNode;
}

/** 出货树里有没有这个节点类型（`dialect_decl` 只可能来自重生成的 wasm）。 */
function typesOf(root: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    out.push(n.type);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/* ============================== 1. 新词位的 CST 形状 ============================== */

describe('`# 方言` 在出货 wasm 里的形状', () => {
  it('`# 方言 erafl` → source_file 下恰一枚 dialect_decl，零故障', () => {
    const root = parse('# 方言 erafl\n');
    expect(faultsOf(root)).toEqual([]);
    const decls = root.children.filter((c) => c.type === 'dialect_decl');
    expect(decls).toHaveLength(1);
    expect(decls[0]!.text).toBe('# 方言 erafl');
    expect(decls[0]!.startPosition.row).toBe(0);
  });

  it('整行收在一个记号里（参数对文法不透明，语义层再拆）——与 `# 视` 同构', () => {
    const withValue = parse('# 方言 erafl\n').children.filter((c) => c.type === 'dialect_decl')[0]!;
    const bareOnly = parse('# 方言\n').children.filter((c) => c.type === 'dialect_decl')[0]!;
    expect(withValue.childCount, 'decl 是原子 token，不该有子节点').toBe(0);
    expect(bareOnly.childCount).toBe(0);
    expect(faultsOf(parse('# 方言\n'))).toEqual([]); // 缺参数是语义层的事，语法不比规范严
  });

  it('与其它声明行同区共存，各自成节点', () => {
    const root = parse('# 幕 神社清晨\n# 方言 erafl\n# 视 灵梦\n# 机 指令 310\n\n> 正文\n');
    expect(faultsOf(root)).toEqual([]);
    for (const type of ['scene_decl', 'dialect_decl', 'view_decl', 'event_decl', 'narration']) {
      expect(typesOf(root), `缺 ${type}`).toContain(type);
    }
  });
});

/* ============================== 2. 语法不比规范松 ============================== */

describe('`# 方言` 的锚点与整词纪律', () => {
  it('`#` 与词之间必须有空白：`#方言 erafl` 落 ERROR（`#DIM` 同理不认）', () => {
    expect(faultsOf(parse('#方言 erafl\n')).length).toBeGreaterThan(0);
  });

  it('词后直接粘字（`# 方言erafl`）：记号只吃到 `方言`，尾巴落 ERROR，绝不静默吞掉', () => {
    const root = parse('# 方言erafl\n');
    // `decl()` 的词后要求是"空白或行尾"⇒ `# 方言` 这一段仍然成记号，粘着的尾巴是故障
    expect(typesOf(root)).toContain('dialect_decl');
    expect(faultsOf(root).length).toBeGreaterThan(0);
  });

  it('未登记的 `#` 词仍然落 ERROR（加词没有顺手放宽未知词这条路）', () => {
    expect(faultsOf(parse('# 未知词 x\n')).length).toBeGreaterThan(0);
  });
});

/* ============================== 3+4. 逐词回归与文法↔wasm 同步 ============================== */

/**
 * 现场解析 `grammar.v2.js` 里所有 `decl('词')` 用法：
 * key = 规则名（`scene_decl` / `table_head`…），value = 该规则吃的词形。
 * **不抄第二份词表**——词形只从文法源读，读不到就判红（fail-closed）。
 */
function declRulesFromGrammar(): Map<string, string> {
  const source = readFileSync(grammarPath, 'utf8');
  const out = new Map<string, string>();
  for (const match of source.matchAll(/^\s{4}([a-z_]+):\s*\(\)\s*=>\s*decl\('(.+?)'\),$/gm)) {
    out.set(match[1]!, match[2]!);
  }
  return out;
}

describe('文法源 ↔ 出货 wasm 同步（改了 grammar.v2.js 忘重跑 build-v2.mjs 就红）', () => {
  const rules = declRulesFromGrammar();

  it(`从 grammar.v2.js 现场读出声明词规则（实收 ${rules.size} 枚，含方言；少于九枚=读法失效）`, () => {
    expect(rules.size).toBeGreaterThanOrEqual(9);
    expect([...rules.values()]).toContain('方言');
    expect([...rules.keys()]).toContain('dialect_decl');
  });

  it('每一枚词位逐词实测：出货 wasm 认得它（落成该规则名的节点）', () => {
    const offenders: string[] = [];
    for (const [rule, word] of rules) {
      const root = parse(`# ${word} 样例\n`);
      if (!typesOf(root).includes(rule)) {
        offenders.push(`\`# ${word} 样例\` 没解出 ${rule} ⇒ 文法里有、wasm 里没有，产物没跟上`);
      }
    }
    expect(offenders, '重跑 node tools/build-v2.mjs 让四件产物跟上 grammar.v2.js').toEqual([]);
  });

  it('单行声明逐词零故障（`*_decl` 那一族；块声明要体，故障判据在 v2-parse 的夹具里）', () => {
    const offenders: string[] = [];
    for (const [rule, word] of rules) {
      if (!rule.endsWith('_decl')) continue;
      const faults = faultsOf(parse(`# ${word} 样例\n`));
      if (faults.length > 0) offenders.push(`\`# ${word} 样例\`（${rule}）：${faults.join(' / ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('既有词位逐词回归：追加 `方言` 没改变任何一枚前面词形的判据', () => {
    for (const word of ['幕', '视', '机', '变量', '常量']) {
      expect(faultsOf(parse(`# ${word} 样例\n`)), `# ${word}`).toEqual([]);
    }
    // 词形前缀不许互相抢：`# 机关 x` 里 `机` 只吃到整词，粘着的尾巴必须报故障
    const prefixRoot = parse('# 机关 x\n');
    expect(typesOf(prefixRoot)).toContain('event_decl');
    expect(faultsOf(prefixRoot).length).toBeGreaterThan(0);
  });
});
