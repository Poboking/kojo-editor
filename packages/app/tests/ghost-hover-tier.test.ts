/**
 * AE-GHOST：`button.ghost` 的悬停只接一层低调洗色，且不许压掉组件自写的悬停档。
 *
 * 为什么这值得一条判据：这一档的全部价值都在**特异性位次**。过去基类 `button:hover` 那枚
 * `--btn-bg-hover` 是实心灰，落在 ghost 的透明底上读作"突然贴了块胶布"；而随手写成
 * `button.ghost:hover:not(:disabled)`（0,3,1）又会把 `.toolbar-btn:hover:not(:disabled)`（0,3,0）
 * 与 `.panel-search.ksp .ksp-clear:hover` / `.panel-problems.prob .prob-copy:hover`（0,4,0）
 * 自写的标定（透明描边 / 强洗色）一并盖掉——重档还比 problem-panel.css 晚到。
 * 所以落点必须是 `:where(button.ghost)`（零权重）：整条只剩两枚伪类（0,2,0），
 * 赢基类 `button:hover`（0,1,1），输给上面三处组件档。
 *
 * 口径同 `aesthetic-ladder.test.ts`：静态读 CSS 源码（默认 node 环境），注释先剥掉——
 * 注释里提到选择器名不算消费方。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 取一条顶层规则的声明体：选择器按**行首**精确匹配（同 `ui-chrome-polish.test.ts` 的口径） */
function ruleBody(css: string, selector: string): string {
  const src = strip(css);
  const at = src.indexOf(`\n${selector} {`);
  expect(at, `找不到规则 ${selector}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  const close = src.indexOf('\n}', open);
  expect(close, `规则 ${selector} 没有闭合`).toBeGreaterThan(open);
  return squash(src.slice(open + 1, close));
}

/**
 * 只数「类级」权重（class / 伪类）：本判据里三处自写档都是纯类选择器，元素位不参与分胜负，
 * 这一位就够用。两条函数伪类按 CSS 规范处理——`:where(…)` 整段为 (0,0,0) 抹掉；
 * `:not(…)` 自身不计权、只保留参数。出现别的函数伪类就当场红，不许"大概算对"。
 */
function classWeight(selector: string): number {
  const s = selector.replace(/:where\(([^()]*)\)/g, '').replace(/:not\(([^()]*)\)/g, '$1');
  expect(s, `${selector} 里还有本判据不认识的函数伪类`).not.toContain('(');
  return (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/:[a-z-]+/g) ?? []).length;
}

const GHOST_HOVER = ':where(button.ghost):hover:not(:disabled)';

describe('AE-GHOST · ghost 悬停：低特异洗色，且让位组件自写档', () => {
  for (const file of ['styles.css', 'styles-project.css'] as const) {
    it(`${file}：ghost 悬停走 :where() 零权重形态，底色吃 --wash-gray（不碰实心 --btn-bg-hover）`, () => {
      const body = ruleBody(read(file), GHOST_HOVER);
      expect(body).toContain('background: var(--wash-gray)');
      expect(body, '幽灵钮的悬停又吃回实心灰了').not.toContain('--btn-bg-hover');
      // 旧的高特异写法不许回潮（它才是压掉三处组件标定的那条）
      expect(strip(read(file)), '又出现 `button.ghost:hover` 的高特异写法').not.toMatch(/button\.ghost:hover/);
    });
  }

  it('--wash-gray 是既有 token（本批不新造档），且是中性洗色', () => {
    expect(read('tokens.css')).toMatch(/--wash-gray:\s*rgba\(128, 128, 128, 0\.15\);/);
  });

  it('特异性位次：ghost (0,2,0) 赢基类 button:hover (0,1,1)，输给三处组件自写档', () => {
    const ghost = classWeight(GHOST_HOVER);
    expect(ghost).toBe(2);
    expect(classWeight('button:hover')).toBe(1);
    expect(ghost, 'ghost 悬停压过了 .toolbar-btn 的透明描边档').toBeLessThan(classWeight('.toolbar-btn:hover:not(:disabled)'));
    expect(ghost, 'ghost 悬停压过了检索清空钮的透明描边档').toBeLessThan(classWeight('.panel-search.ksp .ksp-clear:hover'));
    expect(ghost, 'ghost 悬停压过了问题面板复制钮的强洗色档').toBeLessThan(
      classWeight('.panel-problems.prob .prob-copy:hover'),
    );
  });

  it('三处组件自写档仍在，且标定值没被替改', () => {
    const toolbar = ruleBody(read('styles-project.css'), '.toolbar-btn:hover:not(:disabled)');
    expect(toolbar).toContain('border-color: transparent');
    expect(toolbar).toContain('background: var(--hover)');

    const clear = ruleBody(read('search-panel.css'), '.panel-search.ksp .ksp-clear:hover');
    expect(clear).toContain('border-color: transparent');
    expect(clear).toContain('background: var(--hover)');

    const copy = ruleBody(read('problem-panel.css'), '.panel-problems.prob .prob-copy:hover');
    expect(copy).toContain('border-color: transparent');
    expect(copy).toContain('background: var(--hover-strong)');
  });
});
