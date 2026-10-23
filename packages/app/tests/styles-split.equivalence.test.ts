import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PS-18 styles.css 分档等价性闸（BOARD §W，2026-10-18；视觉批十一 L01 结构升级 2026-10-24）。
 *
 * 拆分形态：`styles.css` 只留欢迎页轻档（main.tsx 静态链，首屏）；全量样式表原样复制成
 * `styles-project.css` 重档，随 ProjectView 懒块动态链（App.tsx `loadProjectView`：
 * styles-project.css → market.css → ProjectView 串行 await）。目标 = 首屏少拉 ~158KB CSS，且
 * **项目态级联终态与拆分前（单文件 styles.css + main.tsx 静态 market.css）逐字等价**。
 *
 * L01 升级：两档文件原先各自携带一份逐字节相同的裸 `:root` token 副本（各 8815 字符），
 * 已收敛为单源 `tokens.css`（main.tsx 静态链最前）。对拍口径随之把 tokens.css 作为**共同
 * 前缀表**纳入级联序列——它等价于拆分前 `:root` 块在样式文件头部的原始位置，判据强度不降。
 *
 * 等价性的构造性证明（本闸就是把它钉成回归断言）：
 *  ① 轻档规则序列 ⊆ 重档规则序列且保序（重档 = 拆分前全量的字节副本，轻档行全部拷自它）；
 *  ② 重档到达晚于轻档（懒块必然在首屏之后）；
 *  ⇒ 终态级联里轻档的每条规则都被重档副本按原文顺序复现，任何「轻档在前、重档独有规则在后」
 *    的翻转对终值都由重档决定——[tokens, 轻, 重, market] ≡ [tokens, 重, market]。
 *
 * 五道闸（任何一道红 = 等价性破了，别想用「看起来没问题」糊弄过去）：
 *  A. 轻档**行序列**是重档行序列的子序列（维护纪律：轻档只许从重档拷行，不许手写新行——
 *     手写一行就会红，这是故意的：等价性证明的前提就是它）；
 *  B. 轻档**规则序列**（扁平化后的 selector+decls）是重档规则序列的子序列（①的本质口径，
 *     对注释/空行免疫，A 的兜底）；
 *  C. 级联终态对拍：`cascade([tokens, 轻, 重, market])` ≡ `cascade([tokens, 重, market])`
 *     ——用同一个扁平化器（见下）分别吃两张形态的**样式表序列**（每表独立解析，模拟浏览器按
 *     <link> 顺序级联，不做文本拼接——拼接会产生浏览器里不存在的边界 artifact），逐
 *     (media,selector) 比终态声明表。B 抓不到的「轻档 key 集合冒出重档没有的选择器」在这里必红；
 *  D. 加载链顺序：main.tsx 静态链 = tokens.css → styles.css → themes/*.css（tokens 必须最先，
 *     否则轻档首屏的 var() 取空值）；不含 market / styles-project；tokens.css 的 import 全仓
 *     只许 main.tsx 一处（App.tsx 懒链不得再导一份——token 在前屏已就位，重导 = 级联位次分叉）；
 *  E. 单源 :root：tokens.css 有且只有一条顶层裸 `:root` 声明块，styles.css 与 styles-project.css
 *     零条（副本回潮 = 幻影翻色/双源漂移复活，直接红）。注意 `[data-theme=…]` / `[data-glass=…]`
 *     这类**带后缀**的 :root 选择器不在禁列——它们是规则不是 token 定义点。
 *
 * 扁平化器是**够用而非完美**的 CSS 扫描器（注释剥离 + 字符串跳过 + 大括号深度 + 叶子块 =
 * 父为 at-rule 或顶层）。它不做特异性计算——对拍抓的是「同一形态两份输入的终态差异」，
 * 扫描器的系统偏差对两份输入对称生效，不产生假红假绿；@keyframes 的 0%/100% 块按
 * 「selector=百分比、media=@keyframes 头」入表，同样对称。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const tokensSrc = (): string => read('../src/tokens.css');
const lightSrc = (): string => read('../src/styles.css');
const heavySrc = (): string => read('../src/styles-project.css');
const marketSrc = (): string => read('../src/market.css');
const appTsx = (): string => read('../src/ui/App.tsx');
const mainTsx = (): string => read('../src/main.tsx');

/** 大括号深度扁平化（口径见文件头「扁平化器」段；两份输入共用同一实现，偏差对称） */
interface FlatRule {
  media: string;
  selector: string;
  decls: string;
}

function flatRules(css: string): FlatRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: FlatRule[] = [];
  const stack: Array<{ head: string; text: string }> = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      buf += ch;
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      stack.push({ head: buf.trim(), text: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top === undefined) continue; // 不平衡括号：不该发生；对称处理不单独红
      const parent = stack[stack.length - 1];
      if (parent === undefined || parent.head.startsWith('@')) {
        const media = stack.filter((s) => s.head.startsWith('@')).map((s) => s.head).join(' ');
        out.push({ media, selector: top.head, decls: top.text.trim() });
      }
      buf = '';
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += ch;
    buf += ch;
  }
  return out;
}

/** 样式表序列 → 终态声明表：key = media ⊃ selector，value = 逐属性后到者覆盖 */
function cascade(sheets: string[]): Map<string, Map<string, string>> {
  const declMaps = new Map<string, Map<string, string>>();
  for (const sheet of sheets) {
    for (const r of flatRules(sheet)) {
      const key = `${r.media} ⊃ ${r.selector}`;
      let m = declMaps.get(key);
      if (!m) {
        m = new Map();
        declMaps.set(key, m);
      }
      for (const d of r.decls.split(';')) {
        const idx = d.indexOf(':');
        if (idx <= 0) continue;
        const prop = d.slice(0, idx).trim().toLowerCase();
        if (prop !== '') m.set(prop, d.slice(idx + 1).trim());
      }
    }
  }
  return declMaps;
}

/** 子序列判定（双指针贪心）：small 的每个元素按序在 big 中出现 */
function isSubsequence(small: string[], big: string[]): { ok: boolean; firstMissing: string } {
  let j = 0;
  for (const item of small) {
    while (j < big.length && big[j] !== item) j++;
    if (j >= big.length) return { ok: false, firstMissing: item };
    j++;
  }
  return { ok: true, firstMissing: '' };
}

describe('PS-18 styles.css 分档等价性', () => {
  it('A 轻档行序列 ⊆ 重档行序列（轻档只许从重档拷行）', () => {
    const light = lightSrc();
    const heavy = heavySrc();
    const r = isSubsequence(light.split('\n'), heavy.split('\n'));
    expect(r.firstMissing === '' ? null : `重档里找不到轻档行：${JSON.stringify(r.firstMissing.slice(0, 120))}`).toBeNull();
    // 读数：首屏节省的字节（拆分前轻档位置上的是重档全量）
    console.log(
      `[styles-split] 轻档 ${light.length} B / 重档 ${heavy.length} B——首屏 CSS 少拉 ${(heavy.length - light.length)} B（${((1 - light.length / heavy.length) * 100).toFixed(1)}%）`,
    );
    // 防退化：轻档必须真的明显小于重档（拆回去 = 全量进首屏 = 白拆）
    expect(light.length).toBeLessThan(heavy.length);
  });

  it('B 轻档规则序列 ⊆ 重档规则序列（保序；对注释/空行免疫）', () => {
    const keyOf = (r: FlatRule) => `${r.media} ⊃ ${r.selector} { ${r.decls} }`;
    const r = isSubsequence(
      flatRules(lightSrc()).map(keyOf),
      flatRules(heavySrc()).map(keyOf),
    );
    expect(r.firstMissing === '' ? null : `重档里找不到轻档规则：${r.firstMissing.slice(0, 160)}`).toBeNull();
  });

  it('C 级联终态对拍：[tokens,轻,重,market] ≡ [tokens,重,market]', () => {
    const after = cascade([tokensSrc(), lightSrc(), heavySrc(), marketSrc()]);
    const before = cascade([tokensSrc(), heavySrc(), marketSrc()]);
    // 先给读数：两形态 key 数、差异 key（红的时候一眼看到差在哪）
    const keysAfter = [...after.keys()];
    const keysBefore = [...before.keys()];
    const onlyAfter = keysAfter.filter((k) => !before.has(k));
    const onlyBefore = keysBefore.filter((k) => !after.has(k));
    const diffVals = keysAfter.filter((k) => before.has(k) && `${[...after.get(k)!.entries()]}` !== `${[...before.get(k)!.entries()]}`);
    console.log(`[styles-split] 终态 key：拆分后 ${keysAfter.length} / 拆分前口径 ${keysBefore.length}；仅后有 ${onlyAfter.length}、仅前有 ${onlyBefore.length}、值不同 ${diffVals.length}`);
    expect(onlyAfter.map((k) => `轻档冒出重档没有的规则：${k}`)).toEqual([]);
    expect(onlyBefore.map((k) => `重档规则在两形态终态中消失：${k}`)).toEqual([]);
    expect(after).toEqual(before);
  });

  it('D 加载链：tokens 最先、轻档进首屏静态链；重档与 market 在懒链且顺序钉死', () => {
    const main = mainTsx();
    // main.tsx：token 单源排在一切样式之前（轻档首屏的 var() 靠它取色）；轻档静态链在；
    // 重档与 market 不在（这正是拆分的目的）
    expect(main).toMatch(/import\s+'\.\/tokens\.css'/);
    expect(main).toMatch(/import\s+'\.\/styles\.css'/);
    expect(main).not.toMatch(/import\s+'\.\/styles-project\.css'/);
    expect(main).not.toMatch(/import\s+'\.\/market\.css'/);
    // tokens → styles → themes 的静态顺序（后置才有主题翻转与轻档兜底的级联语义）
    const iTokens = main.indexOf("import './tokens.css'");
    const iStyles = main.indexOf("import './styles.css'");
    const iThemes = main.indexOf("import './themes/light.css'");
    expect(iTokens).toBeGreaterThanOrEqual(0);
    expect(iTokens, "tokens.css 必须排在 styles.css 之前").toBeLessThan(iStyles);
    expect(iStyles, "styles.css 必须排在 themes/*.css 之前").toBeLessThan(iThemes);
    // tokens.css 的 import 全仓只许 main.tsx 一处（App.tsx 懒链再导 = 级联位次分叉）
    expect(appTsx(), 'App.tsx 不许再 import tokens.css（静态链已就位）').not.toMatch(/tokens\.css/);
    // App.tsx：串行链 styles-project.css → market.css → ProjectView（market 压 .mk-* 必须在全量表之后）
    const app = appTsx();
    const chainRe =
      /import\('\.\.\/styles-project\.css'\)\s*\.then\(\(\)\s*=>\s*import\('\.\.\/market\.css'\)\)\s*\.then\(\(\)\s*=>\s*import\('\.\/ProjectView'\)\)/;
    expect(chainRe.test(app) ? null : 'loadProjectView 链形变（styles-project.css → market.css → ProjectView 的串行顺序破了）').toBeNull();
    // 重档的动态 import 只许出现在 loadProjectView 一处（第二处 = 顺序口径分叉）
    const heavyImports = app.match(/import\('\.\.\/styles-project\.css'\)/g) ?? [];
    expect(heavyImports.length).toBe(1);
  });

  it('E 单源 :root：tokens.css 恰有一条裸 :root，两档样式文件零条（副本回潮即红）', () => {
    const bare = (src: string) => flatRules(src).filter((r) => r.media === '' && r.selector === ':root');
    expect(bare(tokensSrc()), 'tokens.css 的顶层裸 :root 声明块必须恰有一条').toHaveLength(1);
    expect(bare(lightSrc()), 'styles.css 不许重新出现裸 :root（token 单源在 tokens.css）').toHaveLength(0);
    expect(bare(heavySrc()), 'styles-project.css 不许重新出现裸 :root（token 单源在 tokens.css）').toHaveLength(0);
    // 读数：token 定义数（自定义属性声明计数）
    const decls = bare(tokensSrc())[0]!.decls.split(';').filter((d) => d.trim().startsWith('--')).length;
    console.log(`[styles-split] tokens.css 单源裸 :root 一条，内含 ${decls} 个自定义属性；两档样式文件裸 :root 各 0 条`);
  });
});