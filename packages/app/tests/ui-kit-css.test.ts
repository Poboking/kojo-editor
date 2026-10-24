/**
 * ui-kit.css 的 token 纪律扫描（批次十一 L14 的架构铁律）。
 *
 * 单独成文件而不是塞进 ui-kit.test.ts：那份在文件头声明了 happy-dom 环境，而 happy-dom 下
 * `import.meta.url` 是 http URL，fileURLToPath 直接「The URL must be of scheme file」
 * 把整份测试打成收集失败。读仓库源码文件的判据必须待在默认 node 环境里（同 PITFALLS 172）。
 *
 * 坑中坑：vitest 会扫**文件头注释**里的 environment 指令字面量——所以本注释里不许把那条指令
 * 连前缀符号一起写出来，否则这份 node 测试会被自己的注释切到 happy-dom（实测踩过）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(fileURLToPath(new URL('../src/ui-kit/ui-kit.css', import.meta.url)), 'utf8');
// 两遍剥离：① `var(...)`（含 `var(--x, 现值)` 的合法兜底形态）折成 VAR；
// ② 通道位由 token 供色的 `rgb()/rgba()`（如 rgb(var(--accent-rgb) / 0.55) → rgb(VAR / 0.55)）
// 折成 TOKENCOLOR——色相来自 token、只有 alpha 是显式数值，属合法形态。
// 真硬编码的 rgb(12, 34, 56) 里没有 VAR，第二遍不折，照样被下面那条判据打死。
const stripped = raw
  .replace(/var\([^()]*\)/g, 'VAR')
  .replace(/rgba?\([^()]*VAR[^()]*\)/g, 'TOKENCOLOR');

describe('ui-kit.css 只吃 token', () => {
  it('文件确实被读到（防"空字符串全绿"）', () => {
    expect(raw.length).toBeGreaterThan(2000);
    expect(stripped).toContain('.kit-');
  });

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
