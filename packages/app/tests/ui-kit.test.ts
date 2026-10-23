// @vitest-environment happy-dom
/**
 * ui-kit（批次十一 L14）件契约钉。
 *
 * 三族判据：
 * ① **结构与 a11y**：`renderToStaticMarkup` 钉 role/aria-*/tabindex/disabled（真壳验收
 *    前的静态口径，同 capability-matrix-view.test.ts 路子）；
 * ② **交互**：happy-dom 挂载后走原生事件（checkbox/radio/select 用「置值 + dispatch
 *    change」、按钮用 click、radiogroup 用 keydown），钉 onChange 直接给布尔/字符串
 *    不泄漏 event 的族规，与 KitCount 99+ / KitSegmented roving 键盘的边界；
 * ③ **CSS 纪律**：扫 ui-kit.css 本身——剥掉 `var(..., 兜底)` 后不许残留任何
 *    hex/rgba 字面量，圆角与字号不许裸 px（本 lane 的架构铁律，由测试钉死）。
 *
 * 注：任务书写的是 `ui-kit.test.tsx`，但 vitest include 只收 `*.test.ts`、且 app 的
 * tsconfig 也只 include `tests/**/*.ts`——为让 `pnpm test` 真的跑它（改 include 又违反
 * 「只新建文件」），落 `.ts` + `createElement`，件本体（.tsx）覆盖不变。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  KitCheck,
  KitCount,
  KitEmpty,
  KitField,
  KitGallery,
  KitIconButton,
  KitKbd,
  KitRadio,
  KitSegmented,
  KitSelect,
  KitSkeleton,
  kbdTokenLabel,
} from '../src/ui-kit/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (el: ReactElement): string => renderStatic(el);
function renderStatic(el: ReactElement): string {
  // 延迟引依赖：happy-dom 下 react-dom/server 与 client 共存无冲突
  const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
  return renderToStaticMarkup(el);
}

/* ============================= 挂载工具 ============================= */

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (el: ReactElement): void => {
  act(() => root.render(el));
};

/** 原生控件「置值 + change」（checkbox/radio/select 的标准测法，不依赖 click 语义实现差异） */
const fireChange = (el: HTMLInputElement | HTMLSelectElement, next: boolean | string): void => {
  if (el instanceof HTMLInputElement) el.checked = next as boolean;
  else el.value = next as string;
  act(() => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

/* ============================== KitField ============================== */

describe('KitField', () => {
  it('默认 div；标题/描述/控件槽三段齐、描述缺省时不渲染空壳', () => {
    const s = html(
      h(KitField, { title: '自动保存', control: h('span', { className: 'ctl-mock' }, 'ctl') }),
    );
    expect(s.startsWith('<div class="kit-field"'));
    expect(s).toContain('kit-field-title');
    expect(s).not.toContain('kit-field-desc');
    expect(s).toContain('kit-field-ctl');
    expect(s).toContain('ctl-mock');
  });

  it('as="label" 换成可点行（label 元素 + clickable 类）', () => {
    const s = html(h(KitField, { title: '行', as: 'label', description: '说明' }));
    expect(s.startsWith('<label class="kit-field kit-field-clickable"'));
    expect(s).toContain('说明');
  });

  it('nested / inactive 各落自己的类', () => {
    const s = html(h(KitField, { title: '行', nested: true, inactive: true }));
    expect(s).toContain('kit-field-nested');
    expect(s).toContain('kit-field-inactive');
  });
});

/* ============================== KitCheck ============================== */

describe('KitCheck', () => {
  it('无可见文字：span 包裹 + input 落 aria-label，勾盒 aria-hidden', () => {
    const s = html(h(KitCheck, { checked: true, onChange: () => undefined, label: '只读守卫' }));
    expect(s).toContain('type="checkbox"');
    expect(s).toContain('aria-label="只读守卫"');
    expect(s).toContain('aria-hidden="true"');
    expect(s).not.toContain('<label');
  });

  it('有可见文字：外层 label、文字即标签 ⇒ input 不再抢 aria-label', () => {
    const s = html(
      h(KitCheck, { checked: false, onChange: () => undefined, label: '打字即搜' }, '打字即搜'),
    );
    expect(s.startsWith('<label class="kit-check"'));
    expect(s).toContain('kit-check-text');
    expect(s).not.toContain('aria-label');
  });

  it('disabled 落原生属性', () => {
    expect(html(h(KitCheck, { checked: false, onChange: () => undefined, label: 'x', disabled: true }))).toContain(
      'disabled',
    );
  });

  it('交互：change 事件把布尔交给 onChange；disabled 不响应', () => {
    const on = vi.fn();
    mount(h(KitCheck, { checked: false, onChange: on, label: '开关' }));
    const input = host.querySelector('input')!;
    fireChange(input, true);
    expect(on).toHaveBeenCalledWith(true);

    const off = vi.fn();
    mount(h(KitCheck, { checked: false, onChange: off, label: '开关', disabled: true }));
    const dis = host.querySelector('input')!;
    expect(dis.disabled).toBe(true);
    dis.click();
    expect(off).not.toHaveBeenCalled();
  });
});

/* ============================== KitRadio ============================== */

describe('KitRadio', () => {
  it('type=radio + name/value 透传（一组互斥靠 DOM name）', () => {
    const s = html(
      h(KitRadio, { checked: true, onChange: () => undefined, label: '并行', name: 'stage', value: 'dual' }, '并行'),
    );
    expect(s).toContain('type="radio"');
    expect(s).toContain('name="stage"');
    expect(s).toContain('value="dual"');
    expect(s).toContain('checked');
  });

  it('交互：置选后 change 交出 true', () => {
    const on = vi.fn();
    mount(h(KitRadio, { checked: false, onChange: on, label: '关', name: 'stage', value: 'off' }));
    const input = host.querySelector('input')!;
    fireChange(input, true);
    expect(on).toHaveBeenCalledWith(true);
  });
});

/* ============================== KitSelect ============================== */

describe('KitSelect', () => {
  const opts = [
    { value: 'all', label: '全部来源' },
    { value: 'lint', label: '约定检查' },
    { value: 'none', label: '不可选', disabled: true },
  ];

  it('真 select + aria-label；当前值 checked、选项 disabled 透传', () => {
    const s = html(h(KitSelect, { value: 'lint', onChange: () => undefined, options: opts, ariaLabel: '按来源过滤', title: '来源' }));
    expect(s).toContain('<select');
    expect(s).toContain('aria-label="按来源过滤"');
    expect(s).toContain('<option value="lint" selected>约定检查</option>');
    expect(s).toContain('disabled');
    expect(s).toContain('kit-select-arrow');
  });

  it('交互：change 交出字符串值，不泄漏 event', () => {
    const on = vi.fn();
    mount(h(KitSelect, { value: 'all', onChange: on, options: opts, ariaLabel: '按来源过滤' }));
    const sel = host.querySelector('select')!;
    fireChange(sel, 'lint');
    expect(on).toHaveBeenCalledWith('lint');
  });
});

/* ============================= KitSegmented ============================= */

describe('KitSegmented', () => {
  const segs = [
    { value: 'dark', label: '深色' },
    { value: 'mint', label: '薄荷', disabled: true },
    { value: 'light', label: '浅色' },
  ];

  it('radiogroup 语义：role、aria-checked、roving tabIndex（选中档 0、其余 -1）', () => {
    const s = html(h(KitSegmented, { options: segs, value: 'dark', onChange: () => undefined, ariaLabel: '主题' }));
    expect(s).toContain('role="radiogroup"');
    expect(s).toContain('role="radio"');
    expect(s).toContain('aria-checked="true"');
    expect(s).toContain('tabindex="0"');
    expect(s).toContain('tabindex="-1"');
    expect(s).toContain('disabled');
  });

  it('未选时首个**可用**档进 Tab 序（薄荷禁用 ⇒ 深色可聚焦）', () => {
    mount(h(KitSegmented, { options: segs, value: null, onChange: () => undefined, ariaLabel: '主题' }));
    const btns = host.querySelectorAll('button');
    expect(btns[0]!.tabIndex).toBe(0);
    expect(btns[1]!.tabIndex).toBe(-1);
  });

  it('点档 = onChange(值)；箭头键跳过禁用档且换档即移焦', () => {
    const on = vi.fn();
    mount(h(KitSegmented, { options: segs, value: 'dark', onChange: on, ariaLabel: '主题' }));
    const btns = host.querySelectorAll('button');
    act(() => {
      btns[2]!.click();
    });
    expect(on).toHaveBeenCalledWith('light');

    on.mockClear();
    const group = host.querySelector('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(on).toHaveBeenCalledWith('light');
    expect(host.querySelector('button:focus')).toBe(btns[2]);
  });

  it('Home/End 直接落首/末可用档', () => {
    const on = vi.fn();
    mount(h(KitSegmented, { options: segs, value: 'dark', onChange: on, ariaLabel: '主题' }));
    const group = host.querySelector('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(on).toHaveBeenCalledWith('light');
    on.mockClear();
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(on).toHaveBeenCalledWith('dark');
  });
});

/* ============================ KitIconButton ============================ */

describe('KitIconButton', () => {
  it('label 必传 ⇒ aria-label 与 title 同源；图标档位落 data-size', () => {
    const s = html(
      h(KitIconButton, { label: '搜索', size: 22 }, h('svg', { width: 22, height: 22 })),
    );
    expect(s).toContain('aria-label="搜索"');
    expect(s).toContain('title="搜索"');
    expect(s).toContain('data-size="22"');
  });

  it('toggle 态：active 落 aria-pressed + on 类；hint 只改 tooltip 不改无障碍名', () => {
    const s = html(h(KitIconButton, { label: '只看命中', active: true, hint: '过滤未命中行' }, '★'));
    expect(s).toContain('aria-pressed="true"');
    expect(s).toContain('aria-label="只看命中"');
    expect(s).toContain('title="过滤未命中行"');
    expect(s).toContain('on');
  });

  it('禁用态：原生 disabled，click 不触发', () => {
    const on = vi.fn();
    mount(h(KitIconButton, { label: 'x', disabled: true, onClick: on }, 'x'));
    const btn = host.querySelector('button')!;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(on).not.toHaveBeenCalled();
  });

  it('可点态：click 透传事件', () => {
    const on = vi.fn();
    mount(h(KitIconButton, { label: 'x', onClick: on }, 'x'));
    act(() => {
      host.querySelector('button')!.click();
    });
    expect(on).toHaveBeenCalledTimes(1);
  });
});

/* =============================== KitKbd =============================== */

describe('kbdTokenLabel', () => {
  it('修饰键用词、方向键用符号、单字符大写、Plus 表字面 +', () => {
    expect(kbdTokenLabel('ctrl')).toBe('Ctrl');
    expect(kbdTokenLabel('META')).toBe('Win');
    expect(kbdTokenLabel('arrowup')).toBe('↑');
    expect(kbdTokenLabel('z')).toBe('Z');
    expect(kbdTokenLabel('F4')).toBe('F4');
    expect(kbdTokenLabel('plus')).toBe('+');
  });
});

describe('KitKbd', () => {
  it('组合串：逐键芯片 + 淡色 + 分隔，一枚 kbd', () => {
    const s = html(h(KitKbd, { combo: 'Shift+Alt+F' }));
    expect(s).toContain('<kbd');
    expect(s).toContain('kit-kbd-key');
    expect(s.match(/class="kit-kbd-key"/g)).toHaveLength(3);
    expect(s.match(/class="kit-kbd-sep"/g)).toHaveLength(2);
    expect(s).toContain('>Shift<');
    expect(s).toContain('>F<');
  });

  it('数组 = 和弦分步：两个 chord、步间没有 + 号；aria-label 读得通', () => {
    const s = html(h(KitKbd, { combo: ['Ctrl+K', 'Z'] }));
    expect(s.match(/class="kit-kbd-chord"/g)).toHaveLength(2);
    expect(s.match(/class="kit-kbd-sep"/g)).toHaveLength(1);
    expect(s).toContain('Ctrl+K 然后 Z');
  });
});

/* ============================== KitCount ============================== */

describe('KitCount', () => {
  it('99 及以下直出；100 走 99+ 溢出且 title/aria 回落真实值（读数不撒谎）', () => {
    expect(html(h(KitCount, { value: 7 }))).toContain('>7<');
    expect(html(h(KitCount, { value: 99 }))).toContain('>99<');
    const s = html(h(KitCount, { value: 100 }));
    expect(s).toContain('>99+<');
    expect(s).toContain('title="100"');
    expect(s).toContain('aria-label="100"');
  });

  it('max 可改（自定义阈值同样溢出）', () => {
    expect(html(h(KitCount, { value: 2048, max: 9 }))).toContain('>9+<');
    expect(html(h(KitCount, { value: 2048, max: 9 }))).toContain('title="2048"');
  });

  it('tone 只换语义类（着色动文字，井底不动）', () => {
    expect(html(h(KitCount, { value: 3, tone: 'danger' }))).toContain('kit-count-danger');
    expect(html(h(KitCount, { value: 3 }))).not.toContain('kit-count-');
  });
});

/* ============================== KitEmpty ============================== */

describe('KitEmpty', () => {
  it('stack 档：图标 aria-hidden、标题、引导、退路按钮可点', () => {
    const on = vi.fn();
    mount(
      h(KitEmpty, {
        title: '没有结果',
        hint: '换个关键词',
        icon: '◎',
        action: { label: '清除过滤', onClick: on },
      }),
    );
    expect(host.querySelector('.kit-empty-stack')).not.toBeNull();
    expect(host.querySelector('.kit-empty-icon')!.getAttribute('aria-hidden')).toBe('true');
    act(() => {
      host.querySelector('button.kit-empty-action')!.click();
    });
    expect(on).toHaveBeenCalledTimes(1);
  });

  it('inline 档 + announce（状态驱动空态要播报）', () => {
    const s = html(h(KitEmpty, { title: '没有结果', variant: 'inline', announce: true }));
    expect(s).toContain('kit-empty-inline');
    expect(s).toContain('role="status"');
    expect(s).not.toContain('kit-empty-action');
  });
});

/* ============================= KitSkeleton ============================= */

describe('KitSkeleton', () => {
  it('lines 渲染等行数占位条；label 落 role=status + aria-busy', () => {
    const s = html(h(KitSkeleton, { lines: 3, label: '加载中…' }));
    expect(s.match(/kit-skeleton-line/g)).toHaveLength(3);
    expect(s).toContain('role="status"');
    expect(s).toContain('aria-busy="true"');
    expect(s).toContain('aria-label="加载中…"');
  });

  it('单块形态：数字宽按 px 落 inline style', () => {
    const s = html(h(KitSkeleton, { width: 140, height: 22 }));
    expect(s).toContain('width:140px');
    expect(s).toContain('height:22px');
    expect(s).not.toContain('role="status"');
  });
});

/* ============================== KitGallery ============================== */

describe('KitGallery', () => {
  it('对照页把全部件并排渲染（每族至少一枚在场）', () => {
    const s = html(h(KitGallery));
    for (const cls of [
      'kit-gallery',
      'kit-field',
      'kit-check',
      'kit-radio',
      'kit-select',
      'kit-segmented',
      'kit-icon-btn',
      'kit-kbd',
      'kit-count',
      'kit-empty',
      'kit-skeleton',
    ]) {
      expect(s).toContain(cls);
    }
  });
});

/* ============================ CSS 纪律扫描 ============================ */

describe('ui-kit.css 只吃 token', () => {
  const raw = readFileSync(fileURLToPath(new URL('../src/ui-kit/ui-kit.css', import.meta.url)), 'utf8');
  // 剥掉 var(...)（含 `var(--x, 现值)` 的合法兜底形态——兜底真值是 README 登记过的豁免）
  const stripped = raw.replace(/var\([^()]*\)/g, 'VAR');

  it('var 之外零 hex/rgba/hsla 字面量', () => {
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stripped).not.toMatch(/\brgba?\(/);
    expect(stripped).not.toMatch(/\bhsla?\(/);
  });

  it('圆角不许裸 px（50%/0 几何豁免）', () => {
    expect(stripped).not.toMatch(/border-radius:[^;]*\d+px/);
  });

  it('字号不许裸 px（一律 --fs-*）', () => {
    expect(stripped).not.toMatch(/font-size:[^;]*\d+(?:\.\d+)?px/);
  });

  it('动效时长不许裸 ms/s（一律 --dur-*）', () => {
    expect(stripped).not.toMatch(/animation:[^;]*\d+(?:\.\d+)?m?s/);
    expect(stripped).not.toMatch(/transition:[^;]*\d+(?:\.\d+)?m?s/);
  });
});
