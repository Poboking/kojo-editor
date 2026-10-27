/**
 * 美学阶梯闸（1027 美学收口批 · 浮层厚度 / 按钮语义 / 页脚线 / 滚动渐隐 / 把手同色）。
 *
 * 为什么这些判断值得钉成测试而不是"看完就算"：本批改的全是**同一件事被写过多遍**的地方——
 * 抬升在四处各抄一种组合、页脚线只有教程有、滚动渐隐四处各写一份 mask、六条把手分了三家。
 * 抄多遍的东西不用谁反对就会重新散开：下一个人只看得见自己那一面，看不见另外三面。
 * 所以本闸钉的不是"值是多少"，而是两件结构性的事：**只许有一处真源** + **一族状态必须齐**。
 *
 * 口径：静态读源码（node 环境），与 `grain-noise-consumer.test.ts` / `styles-split.equivalence.test.ts`
 * 同族做法——注释一律先剥，提名字不算消费方。字号/间距/裸色另有 `css-font-size-scale`
 * 与 `css-token-single-source` 两道闸，本文件不重复它们。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

/** 只剥块注释（`url("…")` 里的 `//` 不是注释，不能顺手剥掉） */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

interface Block {
  selector: string;
  body: string;
}

/** 大括号深度扁平化：顶层规则与 at-rule 内的普通规则都收（够用口径，同 styles-split） */
function blocks(css: string): Block[] {
  const src = strip(css);
  const out: Block[] = [];
  const stack: { head: string; text: string }[] = [];
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
      stack.push({ head: buf.trim().replace(/\s+/g, ' '), text: '' });
      buf = '';
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame && !frame.head.startsWith('@')) out.push({ selector: frame.head, body: frame.text });
      buf = '';
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1]!.text += ch;
    else buf += ch;
  }
  return out;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const selectorsOf = (b: Block): string[] => b.selector.split(',').map((s) => norm(s)).filter(Boolean);
/** 同一选择器可能命中多条规则（主规则 + `@supports` 回落 + 实心档回落），全部收进来 */
const rulesFor = (list: Block[], selector: string): Block[] =>
  list.filter((b) => selectorsOf(b).includes(selector));
const declRe = (prop: string): RegExp => new RegExp(`(?:^|[;\\n])\\s*${prop}\\s*:\\s*([^;]+)`, 'm');
/** 级联口径：倒着找**第一条真声明了该属性的**规则（回落块不带 box-shadow 时不许把主规则的读数盖成空） */
function declOf(list: Block[], selector: string, prop: string): string | undefined {
  const re = declRe(prop);
  for (const b of rulesFor(list, selector).slice().reverse()) {
    const m = re.exec(b.body);
    if (m) return norm(m[1]!);
  }
  return undefined;
}
/** 整条规则块（取最后一条命中），供"这条规则存在吗 / 它的另一格是什么"用 */
function ruleFor(list: Block[], selector: string): Block | undefined {
  return rulesFor(list, selector).at(-1);
}
function decl(block: Block | undefined, prop: string): string | undefined {
  if (!block) return undefined;
  const m = declRe(prop).exec(block.body);
  return m ? norm(m[1]!) : undefined;
}

const LIGHT = blocks(read('styles.css'));
const HEAVY = blocks(read('styles-project.css'));
const MENU = blocks(read('context-menu.css'));
const KIT = blocks(read('ui-kit/ui-kit.css'));
const TOKEN_ROOT = ruleFor(blocks(read('tokens.css')), ':root');
const tokensSrc = strip(read('tokens.css'));

/** 浮层名册：吃某一档抬升的面。摘掉任何一条都要先说清"它凭什么不算浮层" */
const MODAL_TIER: readonly [string, Block[]][] = [
  ['.modal', HEAVY],
  ['.overlay-host', HEAVY],
  ['.welcome-card', HEAVY],
  ['.update-dialog', blocks(read('update-dialog.css'))],
  ['.update-notice-card', blocks(read('update-notice-card.css'))],
  ['.dev-note', blocks(read('dev-note.css'))],
  ['.launcher-panel', blocks(read('launcher/launcher.css'))],
];
const FLOAT_TIER: readonly [string, Block[]][] = [
  ['.picker', HEAVY],
  ['.floating-panel', HEAVY],
  ['.cm-chara-pop', HEAVY],
];
const LIGHT_TIER: readonly [string, Block[]][] = [
  ['.context-menu', MENU],
  ['.toast', HEAVY],
  ['.project-session-error', HEAVY],
];

describe('抬升三档：浮层的 box-shadow 只许吃 --elev-*', () => {
  it('名册非空（防"零块全绿"）', () => {
    expect(MODAL_TIER.length + FLOAT_TIER.length + LIGHT_TIER.length).toBeGreaterThanOrEqual(13);
  });

  for (const [sel, list] of [...MODAL_TIER, ...FLOAT_TIER, ...LIGHT_TIER]) {
    it(`${sel} 吃 --elev-*，且那一格里没有裸色`, () => {
      const shadow = declOf(list, sel, 'box-shadow');
      expect(shadow, `${sel} 找不到 box-shadow（规则被改形或整条删了）`).toBeDefined();
      expect(shadow!, `${sel} 的抬升没吃档位表：${shadow}`).toMatch(/var\(--elev-[123]\)/);
      expect(shadow!, `${sel} 的抬升里混进了裸色：${shadow}`).not.toMatch(/#[0-9a-fA-F]{3,8}|\brgba?\(/);
    });
  }

  it('三档按"离地高度"严格递增，且每档真把自己那层投影吃进去', () => {
    const token = (name: string): string => {
      const v = decl(TOKEN_ROOT, name);
      expect(v, `tokens.css 的 :root 里缺 ${name}`).toBeDefined();
      return v!;
    };
    const blurOf = (name: string): number =>
      Math.max(...[...token(name).matchAll(/(\d+)px/g)].map((m) => Number(m[1])));
    expect(blurOf('--shadow-2')).toBeGreaterThan(blurOf('--shadow-1'));
    expect(blurOf('--shadow-3')).toBeGreaterThan(blurOf('--shadow-2'));
    // 只钉"名字存在"等于没钉：谁都能把 --elev-2 定义成 `0 0 0 0` 糊过去
    expect(token('--elev-1')).toContain('var(--shadow-1)');
    expect(token('--elev-2')).toContain('var(--shadow-2)');
    expect(token('--elev-3')).toContain('var(--shadow-3)');
    for (const tier of ['--elev-1', '--elev-2', '--elev-3']) {
      expect(token(tier), `${tier} 少了顶缘高光——三档就只剩投影，浮层重新读不出同一族`).toContain('var(--edge-raise)');
    }
  });

  it('切边环单源：那枚裸黑 rgba 全仓只许活在 --elev-rim 一格', () => {
    const hits = ['styles.css', 'styles-project.css', 'context-menu.css', 'ui-kit/ui-kit.css', 'shell-notices.css'].filter(
      (f) => /0 0 0 1px rgba\(/.test(strip(read(f))),
    );
    expect(hits, `这些文件还在自造切边环：${hits.join(', ')}`).toEqual([]);
    expect(tokensSrc.match(/--elev-rim:\s*rgba\(0, 0, 0, 0\.28\)/), '--elev-rim 的真值被改了').not.toBeNull();
  });
});

describe('按钮基座档：语义齐、状态齐、只吃 token', () => {
  const files: readonly ['轻档' | '重档', Block[]][] = [
    ['轻档', LIGHT],
    ['重档', HEAVY],
  ];
  for (const [name, list] of files) {
    it(`${name}：button.danger 三态都在，字色走 AA 文字档`, () => {
      expect(declOf(list, 'button.danger', 'color'), `${name} 没有 button.danger`).toBe('var(--danger-text)');
      expect(declOf(list, 'button.danger:hover:not(:disabled)', 'color')).toBe('var(--danger-text)');
      expect(declOf(list, 'button.danger:hover:not(:disabled)', 'background')).toBe('var(--wash-error)');
      expect(declOf(list, 'button.danger:active:not(:disabled)', 'background'), `${name} 缺按下态`).toContain('--danger');
    });
    it(`${name}：危险档不与主行动抢位（静息只转字与描边）`, () => {
      expect(declOf(list, 'button.danger', 'background')).toBe('transparent');
      expect(declOf(list, 'button.danger', 'box-shadow')).toBe('none');
      // 主按钮的三态底色仍走显式档（filter brightness 会把白字对比度拉到线下，见 tokens §5.102）
      expect(declOf(list, 'button.primary', 'background')).toBe('var(--accent-strong)');
    });
  }

  it('分段控件两族都补齐 按下 / 焦点 / 禁用，且 hover 带 :not(:disabled)', () => {
    for (const [base, list] of [
      ['.theme-seg-btn', HEAVY],
      ['.kit-seg-btn', KIT],
    ] as const) {
      expect(declOf(list, `${base}:active:not(:disabled)`, 'background'), `${base} 缺按下态`).toBeDefined();
      expect(declOf(list, `${base}:focus-visible`, 'box-shadow'), `${base} 缺焦点环`).toContain('--shadow-focus');
      expect(declOf(list, `${base}:focus-visible`, 'outline'), `${base} 没撤掉硬 outline`).toBe('none');
      expect(declOf(list, `${base}.on:focus-visible`, 'box-shadow'), `${base} 选中档被聚焦时内描边被闪没`).toContain('inset');
      expect(declOf(list, `${base}:disabled`, 'opacity'), `${base} 缺禁用档`).toBeDefined();
      expect(ruleFor(list, `${base}:hover`), `${base} 的 hover 没被 :not(:disabled) 挡住`).toBeUndefined();
    }
  });
});

describe('弹窗页脚与标题阶梯', () => {
  for (const [name, list] of [
    ['轻档', LIGHT],
    ['重档', HEAVY],
  ] as const) {
    it(`${name}：.modal-actions / .wizard-actions 都在渐隐发丝线的消费名单里`, () => {
      const lib = ruleFor(list, '.u-hairline-fade');
      expect(lib, `${name} 找不到效果库那条渐隐线规则`).toBeDefined();
      for (const foot of ['.modal-actions', '.wizard-actions']) {
        expect(selectorsOf(lib!), `${name} 的页脚 ${foot} 没并进来`).toContain(foot);
        expect(declOf(list, foot, '--hair-edge'), `${foot} 没说自己是上边线`).toBe('1px 0 0 0');
        expect(declOf(list, foot, 'padding-top'), `${foot} 线与按钮之间没有呼吸`).toBe('var(--space-3)');
      }
    });
  }

  it('标题阶梯：模态 18 / 浮层 16 / 正文小标题 13（浮层标题不再吃 13px）', () => {
    expect(declOf(HEAVY, '.modal h2', 'font-size')).toBe('var(--fs-5)');
    expect(declOf(HEAVY, '.wizard.ov .ov-title', 'font-size')).toBe('var(--fs-4)');
    expect(declOf(HEAVY, '.wizard h3', 'font-size'), '正文小标题档不见了，阶梯失去下界').toBe('var(--fs-3)');
  });

  it('浮层关闭钮三态齐（改前只有 hover）', () => {
    const close = '.wizard.ov .ov-close';
    expect(declOf(HEAVY, `${close}:active:not(:disabled)`, 'background'), '缺按下').toBeDefined();
    expect(declOf(HEAVY, `${close}:focus-visible`, 'box-shadow'), '缺焦点环').toContain('--shadow-focus');
  });
});

describe('滚动族：几何走 token、渐隐有原语、一条不重抄', () => {
  it('两档轨道的内衬差是算出来的：thumb 实宽两档同为 6px', () => {
    const num = (name: string): number => Number(decl(TOKEN_ROOT, name)?.replace('px', ''));
    expect(num('--scroll-w') - 2 * num('--scroll-gap'), '常规档 thumb').toBe(6);
    expect(num('--scroll-w-slim') - 2 * num('--scroll-gap-slim'), '密档 thumb 与常规档不同宽 = 有人单点改了内衬').toBe(6);
  });

  it('::-webkit-scrollbar 的宽/高/内衬不再写裸 px', () => {
    const offenders: string[] = [];
    for (const [name, src] of [
      ['styles.css', read('styles.css')],
      ['styles-project.css', read('styles-project.css')],
      ['market.css', read('market.css')],
      ['search-panel.css', read('search-panel.css')],
    ] as const) {
      for (const b of blocks(src)) {
        if (!selectorsOf(b).some((s) => s.includes('-webkit-scrollbar'))) continue;
        for (const prop of ['width', 'height', 'border', 'border-width']) {
          const v = decl(b, prop);
          if (v && /\d+px/.test(v) && !v.includes('var(')) offenders.push(`${name} · ${b.selector} · ${prop}: ${v}`);
        }
      }
    }
    expect(offenders, `这些滚动条声明回到裸 px 了：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('两处"本批故意没收"的口子必须仍然在册（欠账不许静默变成现状）', () => {
    // ① 六条把手里唯独编辑器分隔条的热态仍是中性灰：它的**终值**被 B-5 的逐字对拍台账钉着
    //    （那批的承诺是"零视觉变化"），改色＝替别人改写判据。收它要先由该闸 owner 把口径从
    //    "终值对拍"迁到"落点在册"。看板 AE-SPLIT4。
    expect(declOf(HEAVY, '.editor-divider:active', 'background')).toBe('var(--wash-gray-strong)');
    // 台账标记在**注释**里（判据注释不算活声明，故这里读原文而不是 strip 后的正文）
    expect(read('styles-project.css')).toMatch(/AE-SPLIT4/);
    // ② 滚动渐隐仍是四处各抄一份 mask：收口成一条原语会撞 `ui-chrome-polish.test.ts` 三条
    //    "读元素自己那一格"的判据。看板 AE-SCROLLFADE。
    const copiers = [
      'styles.css',
      'styles-project.css',
      'search-panel.css',
      'file-tree.css',
      'outline-panel.css',
      'problem-panel.css',
      'market.css',
    ].filter((f) => /mask-image:\s*linear-gradient\(\s*to (bottom|right),\s*#000/.test(strip(read(f))));
    expect(copiers, '这两处口子一处被真收口、另一处判据没跟上，也要红给人看').toEqual([
      'styles-project.css',
      'search-panel.css',
    ]);
    expect(read('tokens.css')).toMatch(/AE-SCROLLFADE/);
  });

  it('五条把手同吃 --split-*（第六条故意留档），市场那条滚动条宽高成对', () => {
    /* 把手全仓实测**六条**（不是四条约：命令矩阵另有行分隔 `.cm-split` 与列把手
       `.cm-corner-resize`，它们的热态与壳层同色却各写各的）。同名规则在文件后段
       还有一份"观感对齐新面"的覆写（`.cm-corner-resize:hover::after` 出现两次）——
       `declOf` 走倒序级联，取的就是**后到那一条**，所以覆写没跟上会当场红，
       不许只改前面那份就宣布收口。 */
    const DOCK = blocks(read('ui/bottom-dock.css'));
    for (const sel of [
      '.resizer:hover',
      '.kp-splitter:hover::after',
      '.cm-split:hover::after',
      '.cm-corner-resize:hover::after',
    ]) {
      expect(declOf(HEAVY, sel, 'background'), `${sel} 的热态没落到 --split-hot`).toBe('var(--split-hot)');
    }
    expect(declOf(DOCK, '.bottombar .dock-cell-resizer:active', 'background'), '底栏把手的热态没跟上面').toBe('var(--split-hot)');
    expect(declOf(HEAVY, '.kp-splitter::after', 'background'), '教程把手的静息档没落到 --split-rest').toBe('var(--split-rest)');
    const mk = ruleFor(blocks(read('market.css')), '.mk-body::-webkit-scrollbar');
    expect(mk, '市场那份滚动条规则不见了').toBeDefined();
    expect(decl(mk!, 'height'), '只声明 width 会漏掉横向滚动条：同一个面板竖细横粗').toBe('var(--scroll-w-slim)');
  });
});

describe('徽标与文字档', () => {
  it('.kit-count 的语义色走 AA 文字档（井底 --bg-3 上不许吃实心色）', () => {
    expect(declOf(KIT, '.kit-count-danger', 'color')).toBe('var(--danger-text)');
    for (const tone of ['accent', 'warning', 'success'] as const) {
      expect(declOf(KIT, `.kit-count-${tone}`, 'color'), `缺 .kit-count-${tone}`).toBeDefined();
    }
  });
});

describe('小方件的圆角与三态（≤24 见方一律 --radius-sm，且 hover / 按下 / 焦点齐）', () => {
  /* 圆角尺度在 tokens.css 里按"件的大小"命名（sm=密集控件 / md=中件 / lg=浮层），
     但**没有任何一道闸检查过消费方取没取对档**——于是 22 见方的关闭钮里出现了一枚
     `--radius-md`(10px)：同一排里它圆得像被放错了尺寸。这一族判据就补这一格。 */
  const SMALL_SQUARES: readonly [string, Block[]][] = [
    ['.kit-icon-btn', KIT],
    ['.toast-close', HEAVY],
    ['.recent-remove', HEAVY],
    ['.update-notice-card-close', blocks(read('update-notice-card.css'))],
  ];
  /** 小关闭钮常被宿主类限定作用域（`.update-notice-card .x-close:hover`），同一态还可以再接
   *  一层伪类（`:hover:not(:disabled)`）——按"选择器以这枚类 + 目标态**开头**、尾部允许更多
   *  伪类"找，不要求整条选择器逐字相等。 */
  const stateOf = (list: Block[], cls: string, pseudo: string, prop: string): string | undefined => {
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)${esc(cls)}${esc(pseudo)}(?::[\\w-]+(?:\\([^)]*\\))?)*$`);
    for (const b of list.slice().reverse()) {
      if (selectorsOf(b).some((s) => re.test(s))) {
        const v = decl(b, prop);
        if (v) return v;
      }
    }
    return undefined;
  };
  for (const [sel, list] of SMALL_SQUARES) {
    it(`${sel} 取密集控件档并给满三态`, () => {
      expect(declOf(list, sel, 'border-radius'), `${sel} 的圆角没跟件大小`).toBe('var(--radius-sm)');
      expect(stateOf(list, sel, ':hover', 'background'), `${sel} 缺悬停`).toBeDefined();
      expect(stateOf(list, sel, ':active:not(:disabled)', 'background'), `${sel} 缺按下态（点下去颜色不动 = 骗手）`).toBeDefined();
      expect(stateOf(list, sel, ':focus-visible', 'box-shadow'), `${sel} 缺焦点环`).toContain('--shadow-focus');
    });
  }
});

describe('右键菜单：图标化与分组线（与 icons-system 的"字符图标绝迹"同口径）', () => {
  const menuTsx = read('ui/context-menu.tsx');
  it('子菜单箭头是图标族的 chevron，不是文本 ›（文本字形不吃 currentColor，悬停慢半拍）', () => {
    expect(menuTsx, '子菜单箭头又退回文本字形了').not.toMatch(/context-menu-arrow[\s\S]{0,80}[›‹▾▸◂]/);
    expect(menuTsx).toMatch(/context-menu-arrow[\s\S]{0,120}<Icon\s+name="chevron-right"/);
  });
  it('箭头跟着整行亮，分组小节头上方有渐隐线且第一条不画', () => {
    expect(declOf(MENU, '.context-menu button:hover .context-menu-arrow', 'color')).toBe('var(--fg)');
    const g = ruleFor(MENU, '.context-menu-group:not(:first-child)');
    expect(g, '分组头那条线没了').toBeDefined();
    expect(decl(g!, 'border-image'), '分组头的线又变成通栏硬线').toContain('transparent');
  });
});

