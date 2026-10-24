/**
 * 每个 CSS 切片都必须真被 import（批次十一 L07/L14 的教训固化）。
 *
 * 触发实例：L14 交付 `ui-kit/ui-kit.css`，文件头注释写着"由 main.tsx 在 styles.css 族之后
 * 加载"，但 `main.tsx` 里那行 import 根本没写——于是全站 kit 基座在真壳里是裸样式，
 * 而"文件存在 + 组件被引用 + tsc 绿 + 测试绿"四项全过，没有任何一道闸会红。
 *
 * 判据口径（关键）：**只认 import 语句**。早先一版检查器按"文件名是否出现在任何 ts/tsx 里"
 * 判接线，结果 `ui-kit.css` 因为被 `ui-kit-css.test.ts` 的注释提到而假绿。注释、字符串、
 * 文档里提到文件名一律不算接线。
 *
 * 本文件待在默认 node 环境（读源码文件），不在注释里写任何 vitest 环境指令字面量（见 PITFALLS 183）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
};

const all = walk(SRC);
const cssFiles = all.filter((p) => p.endsWith('.css'));
const tsFiles = all.filter((p) => /\.(ts|tsx)$/.test(p));
/** 静态 `import './x.css'` 与动态 `import('./x.css')` 都算；注释里提文件名不算 */
const importRe = (base: string): RegExp =>
  new RegExp(`import\\s*\\(?\\s*['"][^'"]*${base.replace(/\./g, '\\.')}['"]`);

describe('每个 CSS 切片都被真 import', () => {
  it('扫到了样式文件（防"零文件假绿"）', () => {
    expect(cssFiles.length).toBeGreaterThanOrEqual(20);
    expect(tsFiles.length).toBeGreaterThan(50);
  });

  const sources = tsFiles.map((p) => readFileSync(p, 'utf8'));
  const unreached = cssFiles.filter((p) => !sources.some((s) => importRe(path.basename(p)).test(s)));

  it(`无未接线切片（当前未接线数：${unreached.length}）`, () => {
    expect(unreached.map((p) => path.relative(SRC, p).replace(/\\/g, '/'))).toEqual([]);
  });
});
