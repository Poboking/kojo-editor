import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 视觉批十一 L15 · 三档对比度门禁（dark / light / mint-dark）。
 *
 * 纯 node 源码判据：不起壳、无 DOM、不依赖浏览器——直接解析
 *  - `src/tokens.css` 的基础裸 `:root`（= dark 档的全部 token 真值），
 *  - `src/themes/light.css` / `src/themes/mint-dark.css` 里 `:root[data-theme='…']` 块的同名覆盖，
 * 按档求 token 终值（吃 `var()` 链、`var(--x, 兜底)`、hex、`rgb()/rgba()` 逗号与斜杠 alpha 形式），
 * 再对**显式列全的组合名单**逐档点名算 WCAG 对比度：
 *  - 相对亮度 L = 0.2126R+0.7152G+0.0722B（sRGB 线性化照 WCAG 分段函数）；
 *  - 比值 = (L1+0.05)/(L2+0.05)；正文类 ≥4.5、大字/图形/UI 部件类 ≥3.0；
 *  - alpha 色**先与该档实际底色叠合**再比（别拿纯黑 0 当底）。
 *
 * 为什么 light 才是主靶：深色档靠惯性可读，翻色档才容易灰压灰——light/mint 的头部注释
 * 各写了一堆"实算 ≥4.5"，但那全是**散文**，没有一道闸钉着。本文件把它钉成判据：
 * 任何一枚 token 值被改动而跌破阈值，这里必红（PITFALLS 181 的教训：全称判据漏一项=没验，
 * 所以名单必须显式列全，而不是"顺手扫一遍"）。
 *
 * 名单里 `--text`/`--text-dim` 在 dark 档是**幻影 token**（从未在任何 :root 定义，
 * 组件靠 `var(--text, #d7dce4)` 兜底渲染——settings-search.css:21/51、styles-project.css:7462/7502）。
 * 本闸把该兜底值作为 dark 档的"实际渲染值"注入（见 DARK_PHANTOM_TEXT），light/mint 档
 * 主题源已真定义（`var(--fg)`），走正常解析。
 *
 * `--text on --accent`（反白按钮）一档的口径说明：反白按钮压在 accent 填充上的前景**实为
 * `--on-accent`**（dark/light 白字、mint 墨绿字），`--fg` 从不落在 `--accent` 底上；且深色档
 * 正文级实心按钮走 `--accent-strong`（tokens.css §5.102 的标定：白字压 `--accent` 只有 3.32:1，
 * 故正文档另有 `--on-accent on --accent-strong` ≥4.5 一条）。因此本条按 UI 部件档 ≥3.0 判
 * `--on-accent on --accent`，正文级由 `--accent-strong` 那条兜住——两条都在名单里，一条不缺。
 * 组长判：这个口径认。它不是放宽（放宽是"少判一条"，这里是"按实际落在屏上的那对颜色判"），
 * 且 3.32:1 是标定值而非估的；后来者若把 `--fg` 真落到 accent 底上，本条会当场红，正是要的效果。
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const tokensSrc = read('../src/tokens.css');
const lightSrc = read('../src/themes/light.css');
const mintSrc = read('../src/themes/mint-dark.css');

/* ------------------------------ ① token 表解析 ------------------------------ */

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 大括号深度扫描：收集选择器恰为 `want` 的声明块里的全部自定义属性（后到覆盖先到）。
 * 先剥注释；值里的空白压平（多行 `--shadow-*` 与单行写法等价）。
 */
function collectRootDecls(src: string, want: string): Map<string, string> {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  const stack: Array<{ head: string; body: string }> = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ head: norm(buf), body: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top && top.head === want) {
        for (const d of top.body.split(';')) {
          const idx = d.indexOf(':');
          if (idx <= 0) continue;
          const prop = norm(d.slice(0, idx));
          if (prop.startsWith('--')) out.set(prop, norm(d.slice(idx + 1)));
        }
      }
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.body += ch;
    buf += ch;
  }
  return out;
}

/** 按档合成终值表：基础 `:root` 打底，`[data-theme=…]` 同名覆盖压上（与浏览器级联同构） */
function buildLayer(themeSelector: string | null): Map<string, string> {
  const map = new Map(collectRootDecls(tokensSrc, ':root'));
  if (themeSelector) {
    for (const src of [lightSrc, mintSrc]) {
      for (const [k, v] of collectRootDecls(src, themeSelector)) map.set(k, v);
    }
  }
  return map;
}

const LAYERS: ReadonlyArray<{ id: string; map: Map<string, string> }> = [
  (() => {
    const dark = buildLayer(null);
    // 幻影 token 的 dark 档实际渲染值 = 消费侧 `var(--x, 兜底)` 的兜底（逐字抄自消费文件，见头注）
    if (!dark.has('--text')) dark.set('--text', '#d7dce4');
    if (!dark.has('--text-dim')) dark.set('--text-dim', '#9aa4b2');
    return { id: 'dark', map: dark };
  })(),
  { id: 'light', map: buildLayer(":root[data-theme='light']") },
  { id: 'mint-dark', map: buildLayer(":root[data-theme='mint-dark']") },
];

/* ------------------------------ ② var() 展开与颜色求值 ------------------------------ */

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

/**
 * 把串里所有 `var(--x)` / `var(--x, 兜底)` 迭代展开成字面串（token 值自身可再含 var，
 * 形成链；32 轮上限同时兜环——环 = 解析不出，进失败消息，不静默）。
 */
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
    if (repl === '') return null; // 既无定义又无兜底
    v = v.slice(0, m.index) + repl + v.slice(close + 1);
  }
  return null;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number; // 0..1
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, n));

/** 单个颜色分量：`128` / `50%` 都吃 */
function parseComponent(raw: string): number | null {
  const t = raw.trim();
  if (t.endsWith('%')) {
    const p = Number.parseFloat(t.slice(0, -1));
    return Number.isFinite(p) ? clamp255((p / 100) * 255) : null;
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? clamp255(n) : null;
}

/** hex（3/4/6/8 位）与 rgb()/rgba()（逗号式与 `r g b / a` 斜杠式）⇒ RGBA；其余返回 null */
function parseColor(s: string): RGBA | null {
  const v = s.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(v);
  if (hex) {
    const h = hex[1]!;
    const byteAt = (i: number, w: number): number => {
      const part = h.slice(i, i + w);
      return w === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
    };
    if (h.length === 3 || h.length === 4) {
      return { r: byteAt(0, 1), g: byteAt(1, 1), b: byteAt(2, 1), a: h.length === 4 ? byteAt(3, 1) / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      return { r: byteAt(0, 2), g: byteAt(2, 2), b: byteAt(4, 2), a: h.length === 8 ? byteAt(6, 2) / 255 : 1 };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (fn) {
    const inner = fn[1]!.replace(/,/g, ' ');
    const slash = inner.indexOf('/');
    const mainRaw = slash < 0 ? inner : inner.slice(0, slash);
    const alphaRaw = slash < 0 ? null : inner.slice(slash + 1).trim();
    const parts = mainRaw.trim().split(/\s+/).filter((x) => x !== '');
    if (parts.length < 3) return null;
    const r = parseComponent(parts[0]!);
    const g = parseComponent(parts[1]!);
    const b = parseComponent(parts[2]!);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (alphaRaw !== null) {
      a = alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    } else if (parts.length >= 4) {
      a = parts[3]!.endsWith('%') ? Number.parseFloat(parts[3]!) / 100 : Number.parseFloat(parts[3]!);
    }
    if (!Number.isFinite(a)) return null;
    return { r, g, b, a: Math.max(0, Math.min(1, a)) };
  }
  return null;
}

/** token ⇒ RGBA 终值；取不到色（非颜色值 / 幻影未兜底 / 环）一律 null 交给门禁红，不猜 */
function colorOf(map: Map<string, string>, token: string): RGBA | null {
  const raw = map.get(token);
  if (raw === undefined) return null;
  const expanded = expandVars(raw, map);
  if (expanded === null) return null;
  return parseColor(expanded);
}

/** fg 以自身 alpha 叠在 bg 上（sRGB 简单预乘，够 CSS 实色用） */
function overC(fg: RGBA, bg: RGBA): RGBA {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** 底色终值：alpha 底（如 `--active` 的 accent wash）**先叠在该档真实底上**，绝不拿 0 当底 */
function resolveBg(map: Map<string, string>, token: string, overToken: string): RGBA | string | null {
  const c = colorOf(map, token);
  if (!c) return null;
  if (c.a >= 1) return c;
  const base = colorOf(map, overToken);
  if (!base) return `背景垫色 ${overToken} 解析不出颜色`;
  return overC(c, base);
}

/* ------------------------------ ③ WCAG ------------------------------ */

const lin = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const lum = (c: RGBA): number => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const ratio = (a: RGBA, b: RGBA): number => {
  const l1 = lum(a);
  const l2 = lum(b);
  return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
};

/* ------------------------------ ④ 组合名单（显式列全 = 判据本体） ------------------------------ */

interface Combo {
  fg: string;
  bg: string;
  /** alpha 背景要先叠的垫色 token（缺省 --surface） */
  over?: string;
  need: number;
  kind: '正文' | '大字/UI';
  note?: string;
}

const COMBOS: readonly Combo[] = [
  // —— 正文级（≥4.5）：文字 token × 表面档 ——
  { fg: '--text', bg: '--bg', need: 4.5, kind: '正文' },
  { fg: '--text', bg: '--surface', need: 4.5, kind: '正文' },
  { fg: '--text-dim', bg: '--bg', need: 4.5, kind: '正文' },
  { fg: '--text-dim', bg: '--surface', need: 4.5, kind: '正文' },
  { fg: '--accent', bg: '--bg', need: 4.5, kind: '正文', note: 'accent 作文字（链接/code/开关档）' },
  { fg: '--accent', bg: '--surface', need: 4.5, kind: '正文' },
  { fg: '--danger', bg: '--surface', need: 4.5, kind: '正文' },
  { fg: '--success', bg: '--surface', need: 4.5, kind: '正文' },
  { fg: '--warning', bg: '--surface', need: 4.5, kind: '正文' },
  { fg: '--on-accent', bg: '--accent-strong', need: 4.5, kind: '正文', note: '实心主按钮正文级（反白档文字 × 填充底）' },
  { fg: '--text', bg: '--surface-sunken', need: 4.5, kind: '正文', note: '输入井/内嵌区文字' },
  { fg: '--text-dim', bg: '--surface-sunken', need: 4.5, kind: '正文' },
  { fg: '--accent-text', bg: '--bg', need: 4.5, kind: '正文', note: 'accent 的文字专档' },
  { fg: '--text', bg: '--active', over: '--surface', need: 4.5, kind: '正文', note: '选中行 alpha wash 底（先叠该档实际底色）' },
  /* —— 视觉批十二补档：真壳三档量测点名的两族，原先**根本不在名单里** ——
   * ① 组件实际吃的是 `--fg` / `--fg-dim`（不是幻影 `--text*`），而计数徽标 `.kp-count` /
   *    ui-kit `.kit-count` 的底是 `--bg-3`（= `--surface-overlay`）：dark 旧值 `#8b949e`
   *    压它就是 **4.27**，破正文级 4.5——名单缺这一行，所以全池一直绿而屏上一直不合格。
   * ② 语义四档要逐个落在它们真实的底上：插件状态行 / 巡检读数 / 错误详情体都压在
   *    overlay 面上（面板与芯片），旧名单只判了 `--surface`。`--info` 是本批新立的第四枚
   *    语义色（三处插件各抄一份 `#7f9cc0` 的历史到此为止），三档逐一求值。 */
  { fg: '--fg', bg: '--surface-overlay', need: 4.5, kind: '正文', note: '面板/芯片底上的正文（批十二补）' },
  { fg: '--fg-dim', bg: '--surface', need: 4.5, kind: '正文', note: '次要文字真源（非幻影 --text-dim）' },
  { fg: '--fg-dim', bg: '--surface-overlay', need: 4.5, kind: '正文', note: '计数徽标那枚芯片底——4.27 破线的就是这一对' },
  { fg: '--fg-dim', bg: '--surface-sunken', need: 4.5, kind: '正文' },
  { fg: '--danger-text', bg: '--surface', need: 4.5, kind: '正文', note: '错误文字的专档（批十二新立，理由见 tokens.css 注释）' },
  { fg: '--danger-text', bg: '--surface-overlay', need: 4.5, kind: '正文', note: '错误行/未知态压在面板面——`--danger` 在这面只有 4.11' },
  { fg: '--danger-text', bg: '--surface-sunken', need: 4.5, kind: '正文' },
  { fg: '--warning', bg: '--surface-overlay', need: 4.5, kind: '正文', note: '残留/未激活态压在面板面（批十二补）' },
  { fg: '--success', bg: '--surface-overlay', need: 4.5, kind: '正文', note: '运行中态压在面板面（批十二补）' },
  { fg: '--info', bg: '--surface', need: 4.5, kind: '正文', note: '批十二新立的第四枚语义色' },
  { fg: '--info', bg: '--surface-overlay', need: 4.5, kind: '正文' },
  { fg: '--info', bg: '--surface-sunken', need: 4.5, kind: '正文' },
  // —— 大字/图形/UI 部件级（≥3.0）——
  { fg: '--on-accent', bg: '--accent', need: 3.0, kind: '大字/UI', note: '反白按钮：名单条目的实际前景是 --on-accent（见头注口径说明）' },
  { fg: '--focus-ring', bg: '--bg', need: 3.0, kind: '大字/UI', note: '焦点环为非文字 UI 部件' },
];

/* ------------------------------ ⑤ 逐档逐条点名求值 ------------------------------ */

interface Measured {
  layer: string;
  combo: Combo;
  got: number | null;
  problem: string | null;
}

function measureLayer(layerId: string, map: Map<string, string>): Measured[] {
  return COMBOS.map((combo) => {
    const fgRaw = colorOf(map, combo.fg);
    if (!fgRaw) return { layer: layerId, combo, got: null, problem: `前景 ${combo.fg} 在该档解析不出颜色` };
    const bgRes = resolveBg(map, combo.bg, combo.over ?? '--surface');
    if (bgRes === null) return { layer: layerId, combo, got: null, problem: `背景 ${combo.bg} 在该档解析不出颜色` };
    if (typeof bgRes === 'string') return { layer: layerId, combo, got: null, problem: bgRes };
    const fg = overC(fgRaw, bgRes); // 前景若也带 alpha，同样先叠在实测底上
    return { layer: layerId, combo, got: ratio(fg, bgRes), problem: null };
  });
}

const ALL = LAYERS.flatMap((l) => measureLayer(l.id, l.map));

const fails = ALL.filter((m) => m.problem !== null || (m.got !== null && m.got < m.combo.need));

describe('L15 三档对比度门禁（tokens.css + themes/*.css 源码判据）', () => {
  it('反假绿地板①：token 解析结果不许为空（基础 :root 与每档终值表都要真吃到）', () => {
    const base = collectRootDecls(tokensSrc, ':root');
    expect(base.size, 'tokens.css 基础 :root 解析出 0 条自定义属性——解析器或文件断了').toBeGreaterThan(0);
    for (const l of LAYERS) {
      expect(l.map.size, `档 ${l.id} 的 token 终值表为空`).toBeGreaterThan(0);
      // 抽查：三档都必须能解析出色值的核心表面/文字 token
      for (const t of ['--bg', '--fg', '--accent', '--surface']) {
        expect(colorOf(l.map, t), `档 ${l.id} 的 ${t} 解析不出颜色`).not.toBeNull();
      }
    }
  });

  it('反假绿地板②：组合名单必须显式列全（≥12 条），且逐档点名不缺项', () => {
    expect(COMBOS.length).toBeGreaterThanOrEqual(12);
    expect(ALL.length).toBe(COMBOS.length * LAYERS.length);
    expect(LAYERS.map((l) => l.id)).toEqual(['dark', 'light', 'mint-dark']);
  });

  it('全部 档×组合 达标：正文 ≥4.5 / 大字·UI ≥3.0，0 条不达标', () => {
    // 读数（供回执与肉眼复核）：每档逐条打实测比值
    for (const l of LAYERS) {
      const rows = ALL.filter((m) => m.layer === l.id);
      console.log(
        `\n[${l.id}] 名单 ${rows.length} 条：\n` +
          rows
            .map(
              (m) =>
                `  ${m.combo.fg} on ${m.combo.bg}${m.combo.over ? ` (叠 ${m.combo.over})` : ''} [${m.combo.kind}≥${m.combo.need}]` +
                ` → ${m.got === null ? `解析失败：${m.problem}` : m.got.toFixed(2)}`,
            )
            .join('\n'),
      );
    }
    const report = fails.map(
      (m) =>
        `${m.layer}: ${m.combo.fg} on ${m.combo.bg}${m.combo.over ? ` (叠 ${m.combo.over})` : ''}` +
        `（${m.combo.kind}类，阈值 ≥${m.combo.need}${m.combo.note ? `，${m.combo.note}` : ''}）` +
        `实测 ${m.got === null ? m.problem : m.got.toFixed(2)}`,
    );
    expect(
      report.join('\n'),
      `对比度不达标 ${report.length} 条（档/组合/实测/阈值逐行列在下方）：\n${report.join('\n')}`,
    ).toBe('');
  });
});
