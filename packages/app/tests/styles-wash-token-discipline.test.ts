/**
 * `styles.css` / `styles-project.css` 的 wash·叠色 token 纪律 + 逐字等值对拍（体感批 B-2/B-4/B-5/B-6，2026-10-26）。
 *
 * 形态照 `shell-notices-token-discipline.test.ts` 的先例（那份是 R6 债一的钉子），判据本体是
 * **改前那串字面量**：每条被收编的声明都记下改动前的原文（可能自带 `var()`，未展开的形态），
 * 用同一张 token 表把「改后声明」与「改前声明」**两侧都展开**后逐字符比对——
 * 只比"看起来差不多"没用：wash / 遮罩 / 滑块影这几族是浅色档"白上抹白"翻过车的地方。
 *
 * 本批四条路各自的钉子面：
 *  ① **B-5 真裸色**：`styles.css` 的真裸色 13 → **0**，`styles-project.css` 30 → **4**
 *     （3 枚 `mask-image: #000` 是遮罩 alpha 通道、不是色，给它语义 token 是假收编；
 *      1 枚 `.cm-cell.off.fill-sel::before` 的 `#fff` 被 `condition-matrix-fill-marker.test.ts:34`
 *      钉成字面量断言，那份测试不归本车道 ⇒ 刻意留着，见文件内注记）。
 *     语义 token 的口径：**只给色、不给几何**（inset / 偏移 / spread 留在消费方），
 *     否则下一个人想改内衬宽度得先来改 token。
 *  ② **B-4 假 token 档转正**：`--panel-bg` / `--hover-bg` / `--text` / `--text-dim` 原**只在
 *     `themes/light.css` 与 `themes/mint-dark.css` 里定义**，dark 一档从未有定义点，全靠消费侧
 *     `var(--x, 字面兜底)` 渲染（`theme-contrast.test.ts` 只能用 `DARK_PHANTOM_TEXT` 把兜底当"实际
 *     渲染值"注入）。现在 dark 真值落进 tokens.css（**逐字取现兜底**），消费侧的兜底字面量随之删掉；
 *     本闸把"真值 == 当年那串兜底"与"兜底形态不再出现"两头都钉住，缺一头就是假转正。
 *  ③ **B-2 z-index 秩序**：`--z-toast` / `--z-local` 的收编格必须真吃 token，且 `--z-menu: 1300`、
 *     `--z-card: 1180` 按 tokens.css:183 那句承诺登记在册（消费方在别人的切片里，本闸只钉定义点）。
 *  ④ **B-6 效果库不许用 layout 属性做动画**：`.u-sheen::before` 的行程由 `left` 换成 `transform`，
 *     几何**逐字等价**——本闸不抄注释里的算式，而是把带子宽度与两个位移百分数**从文件里解析出来现算**：
 *     `ownWidth × translateX ≡ 改前 left`，两端都相等才算过。
 *
 * 另附两条防"逃判据"的读数闸：`--space-6` 必须真被大量消费（立档不消费 = 白立），
 * 以及**这两份文件自己的真裸色账本只许降不许涨**。
 *
 * 本文件待在默认 node 环境（读源码文件）；头注释里不写任何 vitest 环境指令字面量（PITFALLS 183）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const tokensRaw = read('../src/tokens.css');
const lightRaw = read('../src/themes/light.css');
const mintRaw = read('../src/themes/mint-dark.css');
const FILES = [
  ['styles.css', read('../src/styles.css')],
  ['styles-project.css', read('../src/styles-project.css')],
] as const;
/* 1027 玻璃档批的射程（下面 `玻璃 blur 半径` 那一节用）：遮罩收口切片 + F1 命令面板切片 */
const noticesRaw = read('../src/shell-notices.css');
const paletteRaw = read('../src/ui/palette.css');

/* ------------------------------ ① 微型 CSS / token 解析（照 shell-notices 先例） ------------------------------ */

const stripComments = (s: string): string => s.replace(/[/][*][\s\S]*?[*][/]/g, '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 把 `var(…)` 的**整段内容**（含兜底）抹成空格：兜底字面量不算"真裸色"、也不算"没归档的刻度字面量"
 * （口径同组长的尺子；槽位兜底是 `css-token-single-source.test.ts` 的欠账账本管的，不归本文件）。
 */
const maskVarFallback = (s: string): string => {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('var(', i)) {
      out += 'var(';
      i += 4;
      let d = 1;
      while (i < s.length && d > 0) {
        const c = s[i];
        if (c === '(') d++;
        else if (c === ')') {
          d--;
          if (d === 0) {
            out += c;
            i++;
            break;
          }
          out += ' ';
          i++;
          continue;
        }
        out += ' ';
        i++;
      }
      continue;
    }
    out += s[i++];
  }
  return out;
};

interface Rule {
  media: string;
  selector: string;
  body: string;
}

function parseRules(src: string): Rule[] {
  const text = stripComments(src);
  const rules: Rule[] = [];
  const stack: { head: string; body: string }[] = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ head: squash(buf), body: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && !top.head.startsWith('@')) {
        const media = stack
          .filter((f) => f.head.startsWith('@'))
          .map((f) => f.head)
          .join(' ');
        rules.push({ media, selector: top.head, body: top.body });
      }
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
    buf += ch;
  }
  return rules;
}

/** 某选择器（组选择器按逗号拆开）在某 prop 上的**后到者**声明值 */
function declOf(rules: readonly Rule[], selector: string, prop: string): string | undefined {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i]!;
    if (r.media !== '') continue; // 只看顶层（同 shell-notices 口径：宽松前缀匹配会把回落格当本体）
    if (!r.selector.split(',').map(squash).includes(selector)) continue;
    for (const part of r.body.split(';')) {
      const idx = part.indexOf(':');
      if (idx <= 0) continue;
      if (squash(part.slice(0, idx)).toLowerCase() !== prop) continue;
      return squash(part.slice(idx + 1));
    }
  }
  return undefined;
}

function rootDecls(rules: readonly Rule[], selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (r.selector !== selector || r.media !== '') continue;
    for (const d of r.body.split(';')) {
      const idx = d.indexOf(':');
      if (idx <= 0) continue;
      const prop = squash(d.slice(0, idx));
      if (prop.startsWith('--')) out.set(prop, squash(d.slice(idx + 1)));
    }
  }
  return out;
}

function findCloseParen(s: string, open: number): number {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')') {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

/** 把串里的 `var(--x)` / `var(--x, 兜底)` 迭代展开成字面串（32 轮上限顺带兜环 → null，不静默） */
function expandVars(value: string, map: Map<string, string>): string | null {
  let v = value;
  for (let iter = 0; iter < 32; iter++) {
    const m = /var\(/i.exec(v);
    if (!m || m.index === undefined) return v;
    const open = v.indexOf('(', m.index);
    const close = findCloseParen(v, open);
    if (close < 0) return null;
    const inner = v.slice(open + 1, close);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        comma = i;
        break;
      }
    }
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    const tokenVal = map.get(name);
    const repl = tokenVal !== undefined ? tokenVal : fallback;
    if (repl === '') return null;
    v = v.slice(0, m.index) + repl + v.slice(close + 1);
  }
  return null;
}

/** dark 档的 token 表 = tokens.css 的裸 `:root`（styles*.css 的裸类基座规则读的就是这一档） */
const DARK = new Map(rootDecls(parseRules(tokensRaw), ':root'));
const LIGHT = (() => {
  const map = new Map(DARK);
  for (const [k, v] of rootDecls(parseRules(lightRaw), ":root[data-theme='light']")) map.set(k, v);
  return map;
})();
const MINT = (() => {
  const map = new Map(DARK);
  for (const [k, v] of rootDecls(parseRules(mintRaw), ":root[data-theme='mint-dark']")) map.set(k, v);
  return map;
})();

/* ------------------------------ ② dark 档对拍名单（判据本体） ------------------------------ */

interface Slot {
  selector: string;
  prop: string;
  /** **改前**的声明原文（逐字抄自这两份文件，未展开形态照原样保留） */
  before: string;
  /** 这一格必须改吃的 token 名：字面量回潮 = 定义点外又开一张嘴 */
  token: string;
  /** 只有重档（项目态）才有这一格 ⇒ 别拿"轻档找不到"当假红 */
  projectOnly?: boolean;
}

const SLOTS: readonly Slot[] = [
  // —— 语义色 wash（`.notice.warn` / `.notice.error` / `.crash-recovery` 在两份文件里同格同值）——
  { selector: '.notice.warn', prop: 'background', before: 'rgba(209, 154, 102, 0.1)', token: '--wash-warn' },
  { selector: '.notice.warn', prop: 'border-color', before: 'rgba(209, 154, 102, 0.4)', token: '--wash-warn-edge' },
  { selector: '.notice.error', prop: 'background', before: 'rgba(224, 108, 117, 0.1)', token: '--wash-error' },
  { selector: '.notice.error', prop: 'border-color', before: 'rgba(224, 108, 117, 0.5)', token: '--wash-error-edge' },
  { selector: '.crash-recovery', prop: 'background', before: 'rgba(209, 154, 102, 0.1)', token: '--wash-warn' },
  { selector: '.crash-recovery', prop: 'border-color', before: 'rgba(209, 154, 102, 0.4)', token: '--wash-warn-edge' },
  // —— 巡检报告的失败面（重档）——
  { selector: '.conv-failed', prop: 'border', before: '1px solid rgba(224, 108, 117, 0.5)', token: '--wash-error-edge', projectOnly: true },
  { selector: '.conv-failed', prop: 'background', before: 'rgba(224, 108, 117, 0.1)', token: '--wash-error', projectOnly: true },
  { selector: '.sb-writable.ok', prop: 'background', before: 'rgba(79, 192, 141, 0.1)', token: '--wash-success', projectOnly: true },
  { selector: '.sb-writable.ok', prop: 'border-color', before: 'rgba(79, 192, 141, 0.3)', token: '--wash-success-edge', projectOnly: true },
  // —— 效果库 `.u-*` 与实心件 ——
  {
    selector: '.u-sheen::before',
    prop: 'background',
    before: 'linear-gradient(100deg, transparent, rgba(255, 255, 255, 0.18), transparent)',
    token: '--sheen-band',
  },
  {
    selector: '.u-ripple::after',
    prop: 'background',
    before: 'radial-gradient(closest-side, rgba(255, 255, 255, 0.3) 0%, rgba(255, 255, 255, 0) 66%)',
    token: '--ripple-core',
  },
  { selector: '.switch-thumb', prop: 'box-shadow', before: '0 1px 2px rgba(0, 0, 0, 0.45)', token: '--drop-dark' },
  {
    selector: '.u-focus-glow:active:not(:disabled):focus-visible',
    prop: 'box-shadow',
    before: 'var(--shadow-focus), inset 0 1px 2px rgba(0, 0, 0, 0.28)',
    token: '--inset-dark',
  },
  {
    selector: '.context-menu button.danger:active:not(:disabled)',
    prop: 'box-shadow',
    before: 'inset 2px 0 0 var(--danger), inset 0 1px 0 rgba(0, 0, 0, 0.28)',
    token: '--inset-dark',
    projectOnly: true,
  },
  { selector: '.cm-table tbody tr.cm-even > td', prop: 'background', before: 'rgba(255, 255, 255, 0.012)', token: '--zebra-stripe', projectOnly: true },
  { selector: '.cm-cell.on', prop: 'box-shadow', before: 'inset 0 1px 0 rgba(255, 255, 255, 0.12)', token: '--edge-on-fill', projectOnly: true },
  { selector: '.editor-group-close:hover', prop: 'background', before: 'rgba(128, 128, 128, 0.15)', token: '--wash-gray', projectOnly: true },
  { selector: '.editor-divider:active', prop: 'background', before: 'rgba(128, 128, 128, 0.35)', token: '--wash-gray-strong', projectOnly: true },
  { selector: '.wizard-actions .primary', prop: 'color', before: '#fff', token: '--on-fill', projectOnly: true },
  { selector: 'button.primary .hint', prop: 'color', before: '#fff', token: '--on-fill', projectOnly: true },
  { selector: 'button.primary .hint', prop: 'border-color', before: 'rgba(255, 255, 255, 0.32)', token: '--hint-edge', projectOnly: true },
  { selector: 'button.primary .hint', prop: 'background', before: 'rgba(0, 0, 0, 0.22)', token: '--hint-well', projectOnly: true },
  {
    selector: '.welcome::before',
    prop: 'background',
    before:
      'radial-gradient(36% 40% at 30% 32%, rgb(var(--accent-rgb) / 0.18), transparent 62%), radial-gradient(32% 38% at 72% 68%, rgba(124, 92, 255, 0.15), transparent 64%)',
    token: '--violet-wash',
  },
  {
    selector: '.u-gradient-ring',
    prop: 'background',
    before:
      'linear-gradient(var(--surface-overlay), var(--surface-overlay)) padding-box, linear-gradient(135deg, var(--accent), #7c5cff 48%, var(--accent-text)) border-box',
    token: '--violet',
  },
  // —— B-4：假 token 档转正后消费侧不再带兜底（before 写**当年带兜底**的原文，展开即兜底值）——
  { selector: '.editor-crumb', prop: 'color', before: 'var(--text-dim, #9aa4b2)', token: '--text-dim', projectOnly: true },
  { selector: '.editor-crumb', prop: 'background', before: 'var(--panel-bg, #232834)', token: '--panel-bg', projectOnly: true },
  { selector: '.editor-crumb-item:hover', prop: 'background', before: 'var(--hover-bg, #2f3646)', token: '--hover-bg', projectOnly: true },
  { selector: '.editor-crumb-item:hover', prop: 'color', before: 'var(--text, #d7dce4)', token: '--text', projectOnly: true },
  { selector: '.editor-crumb-caret:hover', prop: 'background', before: 'var(--hover-bg, #2f3646)', token: '--hover-bg', projectOnly: true },
  {
    selector: '.oh-detail > td',
    prop: 'background',
    before: 'color-mix(in srgb, var(--panel-bg, #232834) 40%, transparent)',
    token: '--panel-bg',
    projectOnly: true,
  },
  // —— B-5：`.inj-rescan` 的三枚老命名幻影兜底（--bg-1 / --bg-hover / --r-1）转正 ——
  { selector: '.inj-rescan', prop: 'border', before: '1px solid var(--border, #d8dde3)', token: '--border', projectOnly: true },
  { selector: '.inj-rescan', prop: 'border-radius', before: 'var(--r-1, 4px)', token: '--radius-sm', projectOnly: true },
  { selector: '.inj-rescan', prop: 'background', before: 'var(--bg-1, transparent)', token: '', projectOnly: true },
  { selector: '.inj-rescan:hover:not(:disabled)', prop: 'background', before: 'var(--bg-hover, rgba(127, 127, 127, 0.12))', token: '--wash-neutral', projectOnly: true },
];

/* ------------------------------ ③ 判据 ------------------------------ */

describe('B-5 · wash / 叠色收编：dark 档展开后与改前逐字相等', () => {
  const bad: string[] = [];
  const missing: string[] = [];
  for (const [name, raw] of FILES) {
    const rules = parseRules(raw);
    for (const s of SLOTS) {
      if (s.projectOnly && name === 'styles.css') continue;
      const got = declOf(rules, s.selector, s.prop);
      if (got === undefined) {
        missing.push(`${name}: ${s.selector} { ${s.prop} }`);
        continue;
      }
      if (s.token !== '' && !got.includes(`var(${s.token})`)) {
        bad.push(`${name}: ${s.selector} { ${s.prop}: ${got} } —— 没吃 ${s.token}（字面量回潮 = 定义点外第二张嘴）`);
        continue;
      }
      const after = expandVars(got, DARK);
      const before = expandVars(s.before, DARK);
      if (after === null || before === null) {
        bad.push(`${name}: ${s.selector} { ${s.prop} } —— var() 展开失败（环 / 无定义且无兜底）`);
        continue;
      }
      if (squash(after) !== squash(before)) {
        bad.push(`${name}: ${s.selector} { ${s.prop} }\n      改前 ${squash(before)}\n      现值 ${squash(after)}`);
      }
    }
  }

  it('名单够格（35 条 = 这两份文件里被收编的每一格，其中 12 条两档同值；覆盖不全的"绿"不算数）', () => {
    expect(SLOTS.length).toBe(35);
    expect(SLOTS.filter((s) => !s.projectOnly).length).toBe(12);
  });

  it('每格都还在（没有靠删规则换绿）', () => {
    expect(missing, `规则消失了：\n${missing.join('\n')}`).toEqual([]);
  });

  it('dark 档展开后与改前逐字相等：0 格漂移', () => {
    expect(bad, `终值漂移 ${bad.length} 格：\n${bad.join('\n')}`).toEqual([]);
  });

  it('light / mint 两档同源跟随：本批新立的 wash 族在主题侧没被另写一份定义（翻色仍走选择器覆盖）', () => {
    // ⚠ 范围只限**本批新立的 wash / 效果族**：`--panel-bg` / `--text` 那四枚走的是另一条路——
    // 它们在主题侧**就该**是同名 token 覆写（B-4 转正的机制），不是"第二张嘴"。
    // wash 族今天的收口形态是"主题侧按选择器覆盖整条声明"；两种形态并存 = 同一格两套口径。
    const WASH_TOKENS = SLOTS.map((s) => s.token)
      .filter((t) => /^(--wash-|--sheen-|--ripple-|--zebra-|--edge-on-fill|--inset-dark|--drop-dark|--hint-|--on-fill|--violet)/.test(t));
    expect(new Set(WASH_TOKENS).size).toBeGreaterThanOrEqual(14);
    for (const [label, src, sel] of [
      ['light', lightRaw, ":root[data-theme='light']"],
      ['mint-dark', mintRaw, ":root[data-theme='mint-dark']"],
    ] as const) {
      const own = rootDecls(parseRules(src), sel);
      const clash = WASH_TOKENS.filter((t) => own.has(t));
      expect(clash, `${label}.css 里重定义了 ${clash.join(',')} —— 与同文件的选择器覆盖并存就是双口径`).toEqual([]);
    }
    // 基座真值不被主题污染：dark 档就是那串改前字面量
    expect(DARK.get('--wash-warn')).toBe('rgba(209, 154, 102, 0.1)');
    expect(DARK.get('--sheen-band')).toBe('rgba(255, 255, 255, 0.18)');
    expect(DARK.get('--violet')).toBe('#7c5cff');
    expect(DARK.get('--violet-wash')).toBe('rgba(124, 92, 255, 0.15)');
    // light / mint 各自把同名 token 指到自己的面上（这才叫真 token 档）
    expect(LIGHT.get('--panel-bg')).toBe('var(--bg-2)');
    expect(MINT.get('--panel-bg')).toBe('var(--bg-2)');
  });

  it('这两份文件的真裸色账本只许降不许涨（B-5 改前 43 → 交付 4）', () => {
    const HEX = /#[0-9a-fA-F]{3,8}/;
    /** `rgb(1…)` / `rgba(0…` = 裸分量；`rgb(var(--accent-rgb) / .2)` 是"token 分量 + alpha"，合规范式 */
    const COLOR_FN = /rgba?\(\s*[\d.]/;
    const where: string[] = [];
    for (const [name, raw] of FILES) {
      for (const r of parseRules(raw)) {
        for (const part of r.body.split(';')) {
          const idx = part.indexOf(':');
          if (idx <= 0) continue;
          const val = maskVarFallback(part.slice(idx + 1));
          if (!HEX.test(val) && !COLOR_FN.test(val)) continue;
          where.push(`${name}  ${r.selector}  { ${squash(part).slice(0, 46)} }`);
        }
      }
    }
    expect(where.length, `真裸色涨到 ${where.length} 枚：\n${where.join('\n')}`).toBeLessThanOrEqual(4);
    console.log(`[wash-ledger] styles.css + styles-project.css 真裸色（剥兜底）= ${where.length}（B-5 改前 43）：\n  ${where.join('\n  ')}`);
  });
});

describe('B-4 · dark 不再是假 token 档', () => {
  const TRUTH: readonly [string, string][] = [
    ['--panel-bg', '#232834'],
    ['--hover-bg', '#2f3646'],
    ['--text', '#d7dce4'],
    ['--text-dim', '#9aa4b2'],
  ];

  it('四枚 token 在 tokens.css 有 dark 真值，且**逐字等于**当年消费侧的兜底串', () => {
    for (const [name, before] of TRUTH) {
      const v = DARK.get(name);
      expect(v, `${name} 在 dark 档仍没有定义点（= 假 token 档没转正）`).toBeDefined();
      expect(v!, `${name} 的真值与改前兜底分叉`).toBe(before);
    }
  });

  it('两档主题仍各自同名覆盖（light/mint 走 var(--bg-2)/var(--fg) 一族，特异性和后置都压过基座）', () => {
    for (const [label, map] of [['light', LIGHT], ['mint-dark', MINT]] as const) {
      expect(map.get('--panel-bg'), `${label} 的 --panel-bg 没跟表面档`).toBe('var(--bg-2)');
      expect(map.get('--hover-bg'), `${label} 的 --hover-bg 没跟表面档`).toBe('var(--bg-3)');
      expect(map.get('--text'), `${label} 的 --text 没跟 --fg`).toBe('var(--fg)');
      expect(map.get('--text-dim'), `${label} 的 --text-dim 没跟 --fg-dim`).toBe('var(--fg-dim)');
    }
  });

  it('消费侧的兜底字面量已删净：这两份文件里不许再出现 var(--panel-bg,…) 一类带回落的形态', () => {
    for (const [name, raw] of FILES) {
      for (const [t] of TRUTH) {
        const re = new RegExp(`var\\(${t},`, 'g');
        expect(raw.match(re) ?? [], `${name} 里 ${t} 还带着字面兜底（定义点已就位，兜底即死码）`).toHaveLength(0);
      }
    }
  });
});

describe('B-2 · z-index 秩序收编（我自己的两份文件）', () => {
  it('tokens.css 的四档承诺全部落地：toast / card / menu / local 逐字在册', () => {
    expect(DARK.get('--z-toast')).toBe('1200');
    expect(DARK.get('--z-card')).toBe('1180');
    expect(DARK.get('--z-menu')).toBe('1300'); // tokens.css:183 那句"另开 ≥1300 并登记"，本批兑现
    expect(DARK.get('--z-local')).toBe('30');
  });

  it('`.project-session-error` 与 `.cm-chara-pop` 不再写裸数，终值逐字不变', () => {
    const rules = parseRules(read('../src/styles-project.css'));
    expect(declOf(rules, '.project-session-error', 'z-index')).toBe('var(--z-toast)');
    expect(declOf(rules, '.cm-chara-pop', 'z-index')).toBe('var(--z-local)');
  });

  it('跨车道的两枚裸值已由组长改吃新档（context-menu → --z-menu / 提醒卡 → --z-card），档位真值仍钉死', () => {
    // 本条在车道树上时钉的是"两枚裸值还在册、等组长落地时归档"。组长落地时改成了
    // token 消费 ⇒ 按本条自己写明的约定换形状：**不是放宽**，两侧都钉——
    // CSS 侧必须吃对应档位 token（退回裸值红），档位表侧真值必须仍是 1300 / 1180（挪号红）。
    expect(read('../src/context-menu.css')).toMatch(/z-index:\s*var\(--z-menu\)/);
    expect(read('../src/update-notice-card.css')).toMatch(/z-index:\s*var\(--z-card\)/);
    const ladder = read('../src/tokens.css');
    expect(ladder).toMatch(/--z-menu:\s*1300;/);
    expect(ladder).toMatch(/--z-card:\s*1180;/);
    // 反向红线：这两份文件里不许再出现那两枚裸值（绕过档位表的第二张口径）
    expect(read('../src/context-menu.css')).not.toMatch(/z-index:\s*1300\s*;/);
    expect(read('../src/update-notice-card.css')).not.toMatch(/z-index:\s*1180\s*;/);
  });
});

describe('B-6 · 效果库不许用 layout 属性做动画', () => {
  /** 从文件里解析出「带子宽度」与两端位移，现算它是否等于改前的 `left: -60% → 120%` */
  const BEFORE_LEFT = { start: -60, end: 120 } as const;

  for (const [name, raw] of FILES) {
    it(`${name}：.u-sheen 的行程改吃 transform，且几何与改前逐字等价`, () => {
      const rules = parseRules(raw);
      const body = declOf(rules, '.u-sheen::before', 'transition');
      expect(body, '.u-sheen::before 的 transition 不见了').toBeDefined();
      expect(body!, '还在动 layout 属性（left/width/top/height 每帧重排）').not.toMatch(/\bleft\b/);
      expect(body!).toContain('transform var(--dur-3)');
      const width = Number(declOf(rules, '.u-sheen::before', 'width')!.match(/[\d.]+/)?.[0]);
      const start = Number(declOf(rules, '.u-sheen::before', 'transform')!.match(/translateX\(-?[\d.]+%\)/)![0].match(/-?[\d.]+/)?.[0]);
      const end = Number(declOf(rules, '.u-sheen:hover::before', 'transform')!.match(/translateX\(-?[\d.]+%\)/)![0].match(/-?[\d.]+/)?.[0]);
      expect(Number.isFinite(width) && width > 0, 'width 解析失败').toBe(true);
      // 位移按**自身宽**计 ⇒ 折回容器宽 = own% × width%
      expect((start * width) / 100, '起点与改前 left:-60% 不等价').toBe(BEFORE_LEFT.start);
      expect((end * width) / 100, '终点与改前 left:120% 不等价').toBe(BEFORE_LEFT.end);
      // skew 必须与 translate 同一条 transform（transform 是整体替换，分开写会互相覆盖）
      expect(declOf(rules, '.u-sheen::before', 'transform')).toContain('skewX(-20deg)');
    });
  }

  it('最后一条 layout 属性动画债已清：.cm-cov-fill 改走 transform（P2-12）', () => {
    const rules = parseRules(read('../src/styles-project.css'));
    const transition = declOf(rules, '.cm-cov-fill', 'transition')!;
    // 改前这里钉的是 `width var(--dur-2)`（当时记的是"改它要动插件源码 ⇒ 本批不做"）。
    // 2026-10-27 性能批连插件侧行内一起改了：系数经 `--cm-cov` 递、样式表只动合成属性。
    expect(transition, '还在动 layout 属性（width 每帧重排）').not.toMatch(/\bwidth\b/);
    expect(transition).toContain('transform var(--dur-2)');
    expect(declOf(rules, '.cm-cov-fill', 'transform')).toContain('scaleX(var(--cm-cov');
    // 缩放基准必须在：没有 width:100% 时 scaleX 的参照系是内容宽，几何会跟改前不一致
    expect(declOf(rules, '.cm-cov-fill', 'width')).toBe('100%');
  });
});

describe('B-1 · 间距刻度落地（--space-6 立档必须真被消费）', () => {
  it('`--space-6: 6px` 在册且值逐字不动', () => {
    expect(DARK.get('--space-6')).toBe('6px');
  });

  it('两份文件对 `var(--space-6)` 的消费数：轻档 ≥6、重档 ≥90（立档不消费 = 白立）', () => {
    const lightUses = (read('../src/styles.css').match(/var[(]--space-6/g) ?? []).length;
    const heavyUses = (read('../src/styles-project.css').match(/var[(]--space-6/g) ?? []).length;
    console.log(`[space-6] 消费数 轻档 ${lightUses} / 重档 ${heavyUses}（原 6px 字面量：轻 6 / 重 107）`);
    expect(lightUses).toBeGreaterThanOrEqual(6);
    expect(heavyUses).toBeGreaterThanOrEqual(90);
  });

  it('3px / 5px 归 --space-1、7px 归 --space-2：这两份文件的 spacing 声明里不再留下 3/5/7px 字面量', () => {
    const SP =
      /^\s*(padding|padding-top|padding-right|padding-bottom|padding-left|gap|row-gap|column-gap|margin|margin-top|margin-right|margin-bottom|margin-left)\s*:/;
    const ODD = /[\s:;(](?:3px|5px|7px)(?![\w-])/;
    for (const [name, raw] of FILES) {
      const left = raw
        .split('\n')
        // 槽位兜底（`var(--head-pad-y, 5px)` 那类）不在本判据射程：那是 `css-token-single-source.test.ts`
        // 的欠账账本管的，剥掉 var() 内容后再看**代码位**上有没有裸刻度字面量
        .filter((l) => SP.test(l) && ODD.test(maskVarFallback(l)));
      expect(left, `${name} 还有未归档的 3/5/7px：\n${left.join('\n')}`).toEqual([]);
    }
  });

  it('`.tree-filter`（真机 13.3333px 那一枚）改吃刻度与界面字族', () => {
    const rules = parseRules(read('../src/styles-project.css'));
    expect(declOf(rules, '.tree-filter', 'font-size')).toBe('var(--fs-1)');
    expect(declOf(rules, '.tree-filter', 'font-family')).toBe('inherit');
  });
});

/* ------------------------------ 1027 玻璃档批 · blur 半径按用途归档 ------------------------------ */

/**
 * 形态照上面 ② 的先例（**改前那串字面量**当期望值，两侧都展开再比），对象换成几何：
 * `--scrim-* / --rim-*` 那两族当年收的是"色"，这一轮收的是遮罩的**虚化半径**——它有 12 行写成裸 px
 * （六条规则 × `-webkit-` 双写：`shell-notices.css` ⑤ 的五条 + `ui/palette.css` 的 `.pk-mask`），
 * 于是 light / mint 号称能翻浓度，实际只翻得动 tint / alpha / saturate，半径永远追不上 ⇒ 三档不一致。
 *
 * 立档口径（名字跟途走、不跟序号走）：`--glass-blur-scrim`（破坏性确认面）/ `--glass-blur-scrim-query`
 * （只读查询面）/ `--glass-blur-picker`（命令面板遮罩）/ `--glass-blur-palette`（F1 的 `.pk-mask`，
 * 同一条遮罩路上再收 1px）。dark 档缺省写成主路那条 `calc(var(--glass-blur) × n)` 的**原文**，
 * 所以下面每一格展开后与改前逐字相等 = 零终值漂移；mint 的命令面板**不给** picker 档（它那里
 * `.picker-backdrop` 只供 background，见 `shell-notices.css` ⑤ 的 mint 注记）。
 *
 * ⚠ `before` 连 `saturate(…)` 一起抄：饱和不带 px、不是"翻不动浓度"那一件事，仍留在消费侧；
 * 对拍把它比上，才不会被后来人借本批偷偷改设计。
 */
interface BlurSlot {
  /** 取哪一档的 token 表（dark = tokens.css 的裸 `:root`） */
  tier: 'dark' | 'light' | 'mint-dark';
  file: 'shell-notices.css' | 'palette.css';
  selector: string;
  /** 改前的声明原文（逐字抄自这两份文件） */
  before: string;
  /** 这一格必须改吃的档位 token */
  token: string;
}

const TIER_MAP = { dark: DARK, light: LIGHT, 'mint-dark': MINT } as const;
const BLUR_FILES: Record<BlurSlot['file'], string> = { 'shell-notices.css': noticesRaw, 'palette.css': paletteRaw };

const BLUR_SLOTS: readonly BlurSlot[] = [
  // —— light ⑤：确认面 9px / 查询面 8px / 命令面板 8px ——
  { tier: 'light', file: 'shell-notices.css', selector: ":root[data-theme='light'] .overlay-backdrop", before: 'blur(9px) saturate(0.82)', token: '--glass-blur-scrim' },
  { tier: 'light', file: 'shell-notices.css', selector: ":root[data-theme='light'] .modal-mask", before: 'blur(9px) saturate(0.82)', token: '--glass-blur-scrim' },
  { tier: 'light', file: 'shell-notices.css', selector: ":root[data-theme='light'] .overlay-backdrop:has(.ov-query)", before: 'blur(8px) saturate(0.85)', token: '--glass-blur-scrim-query' },
  { tier: 'light', file: 'shell-notices.css', selector: ":root[data-theme='light'] .picker-backdrop", before: 'blur(8px) saturate(0.85)', token: '--glass-blur-picker' },
  // —— mint ⑤：确认面 11px / 查询面 9px（墨绿底与代码面同色相，半径比 light 深一档仍不糊成灰泥）——
  { tier: 'mint-dark', file: 'shell-notices.css', selector: ":root[data-theme='mint-dark'] .overlay-backdrop", before: 'blur(11px) saturate(0.92)', token: '--glass-blur-scrim' },
  { tier: 'mint-dark', file: 'shell-notices.css', selector: ":root[data-theme='mint-dark'] .modal-mask", before: 'blur(11px) saturate(0.92)', token: '--glass-blur-scrim' },
  { tier: 'mint-dark', file: 'shell-notices.css', selector: ":root[data-theme='mint-dark'] .overlay-backdrop:has(.ov-query)", before: 'blur(9px) saturate(0.95)', token: '--glass-blur-scrim-query' },
  // —— palette：F1 的 `.pk-mask` 是全主题通路 ⇒ 三档各测一遍（三档都填 7px，谁抄成别的数就红）——
  { tier: 'dark', file: 'palette.css', selector: 'html:root .picker-backdrop.pk-mask', before: 'blur(7px) saturate(1.05)', token: '--glass-blur-palette' },
  { tier: 'light', file: 'palette.css', selector: 'html:root .picker-backdrop.pk-mask', before: 'blur(7px) saturate(1.05)', token: '--glass-blur-palette' },
  { tier: 'mint-dark', file: 'palette.css', selector: 'html:root .picker-backdrop.pk-mask', before: 'blur(7px) saturate(1.05)', token: '--glass-blur-palette' },
];

/** 展开串里抠出 `blur( … )` 的半径参数（允许一层嵌套：`calc(16px * 0.8)`） */
const radiusOf = (decl: string): string | null => {
  const m = /blur\(((?:[^()]|\([^()]*\))*)\)/.exec(squash(decl));
  return m ? squash(m[1]!) : null;
};

describe('1027 玻璃档批 · 遮罩虚化半径按用途归档', () => {
  const LADDER = ['--glass-blur-scrim', '--glass-blur-scrim-query', '--glass-blur-picker', '--glass-blur-palette'] as const;

  it('名单够格（10 格 = 被收编的每一条遮罩 / 键盘面规则 × 它所在的档，覆盖不全的"绿"不算数）', () => {
    expect(BLUR_SLOTS.length).toBe(10);
    expect(BLUR_SLOTS.filter((s) => s.file === 'shell-notices.css').length).toBe(7);
    expect(LADDER.length).toBe(4);
  });

  it('每格都还在，且两侧展开后与改前逐字相等：0 格漂移（`-webkit-` 双写一起换，漏一条就是老 WebKit 还在吃裸值）', () => {
    const missing: string[] = [];
    const bad: string[] = [];
    for (const s of BLUR_SLOTS) {
      const rules = parseRules(BLUR_FILES[s.file]);
      for (const prop of ['backdrop-filter', '-webkit-backdrop-filter'] as const) {
        const got = declOf(rules, s.selector, prop);
        if (got === undefined) {
          missing.push(`${s.tier}: ${s.file} ${s.selector} { ${prop} }`);
          continue;
        }
        if (!got.includes(`var(${s.token})`)) {
          bad.push(`${s.tier}: ${s.selector} { ${prop}: ${got} } —— 没吃 ${s.token}（字面量回潮 = 定义点外第二张嘴）`);
          continue;
        }
        const after = expandVars(got, TIER_MAP[s.tier]);
        if (after === null) {
          bad.push(`${s.tier}: ${s.selector} { ${prop} } —— var() 展开失败（环 / 无定义且无兜底）`);
          continue;
        }
        if (squash(after) !== squash(s.before)) {
          bad.push(`${s.tier}: ${s.selector} { ${prop} }\n      改前 ${squash(s.before)}\n      现值 ${squash(after)}`);
        }
      }
    }
    expect(missing, `规则消失了（不许靠删规则换绿）：\n${missing.join('\n')}`).toEqual([]);
    expect(bad, `终值漂移 ${bad.length} 格：\n${bad.join('\n')}`).toEqual([]);
  });

  it('dark 档零漂移：三枚遮罩档的缺省展开后 = 主路懒档（styles-project.css）真正在用的那个半径', () => {
    const project = parseRules(read('../src/styles-project.css'));
    const MAIN: readonly [string, string][] = [
      ['--glass-blur-scrim', '.overlay-backdrop'],
      ['--glass-blur-scrim-query', '.overlay-backdrop:has(.ov-query)'],
      ['--glass-blur-picker', '.picker-backdrop'],
    ];
    for (const [token, selector] of MAIN) {
      const expanded = expandVars(`blur(${DARK.get(token)})`, DARK);
      expect(expanded, `${token} 在 dark 档展开失败`).not.toBeNull();
      const got = expandVars(declOf(project, selector, 'backdrop-filter') ?? '', DARK);
      if (got === null || got === '') {
        // 查询面那条懒档住在 `@supports` 里，declOf 只看顶层（口径同 ①）⇒ 直接钉 calc 原文
        expect(DARK.get(token), `${token} 的 dark 缺省不是主路的 calc 原文`).toBe('calc(var(--glass-blur) * 0.5)');
        continue;
      }
      expect(radiusOf(expanded!), `${token} 解析不出半径`).not.toBeNull();
      expect(radiusOf(expanded!), `${token} 与主路 ${selector} 的 dark 半径分叉`).toBe(radiusOf(got));
    }
  });

  it('档位表就位：tokens.css 四枚定义点、light 补四格 / mint 补三格，主题侧只翻值不写规则', () => {
    for (const t of LADDER) expect(tokensRaw, `${t} 没有 dark 定义点`).toMatch(new RegExp(`${t}:`));
    const lightOwn = rootDecls(parseRules(lightRaw), ":root[data-theme='light']");
    const mintOwn = rootDecls(parseRules(mintRaw), ":root[data-theme='mint-dark']");
    for (const t of LADDER) expect(lightOwn.has(t), `light.css 少 ${t} 这一格`).toBe(true);
    for (const t of ['--glass-blur-scrim', '--glass-blur-scrim-query', '--glass-blur-palette'] as const) {
      expect(mintOwn.has(t), `mint-dark.css 少 ${t} 这一格`).toBe(true);
    }
    for (const [label, raw] of [['light.css', lightRaw], ['mint-dark.css', mintRaw]] as const) {
      const decls = parseRules(raw)
        .flatMap((r) => r.body.split(';').map(squash))
        .filter((d) => /(?:-webkit-)?backdrop-filter\s*:/.test(d));
      expect(decls, `${label} 又开始自带遮罩规则（消费点只有 ⑤ 与 palette）：\n${decls.join('\n')}`).toEqual([]);
    }
  });

  it('反查：这两份切片的 blur( 后面只出现 --glass-blur* 档（本批 12 行裸 px → 0）', () => {
    const bare: string[] = [];
    for (const [name, raw] of Object.entries(BLUR_FILES)) {
      for (const m of stripComments(raw).matchAll(/(?:^|[;{\s])(?:-webkit-)?backdrop-filter[ \t]*:[ \t]*([^;{}]*)/g)) {
        const value = squash(m[1]!);
        if (!/blur\(/.test(value) || value === 'none') continue;
        if (!/blur\(\s*var\(--glass-blur/.test(value)) bare.push(`${name}: backdrop-filter: ${value}`);
      }
    }
    const tierUses = (noticesRaw.match(/blur\(var\(--glass-blur/g) ?? []).length + (paletteRaw.match(/blur\(var\(--glass-blur/g) ?? []).length;
    console.log(`[glass-blur] 两切片吃档位的声明格数 = ${tierUses}（本批收编 12 行裸 px），裸值 = ${bare.length}`);
    expect(bare, `这些格还在自己抄半径：\n${bare.join('\n')}`).toEqual([]);
    expect(tierUses, '档位消费数少于 12 = 有人删了规则而不是搬 token').toBeGreaterThanOrEqual(12);
  });
});
