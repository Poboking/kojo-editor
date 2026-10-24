/**
 * 语义色单源闸（视觉批十二 · BOARD `VIS-CONTRAST` 的防回潮腿）。
 *
 * 病不是"色不好看"，是**色住错了地方**：呈现层把 tone 的 hex 直接写进 TS 常量表、再内联到 DOM 的
 * `style={{ color: '#e06c75' }}` 上——那样一来 `tokens.css` 与 `themes/*.css` 的翻色根本管不到它。
 * 真壳实测的后果（2026-10-24 三档量测）：浅色档 `#d19a66` 压 `#eaeef2` **2.11:1**、`#888` 压同一面
 * **3.04:1**，而 `--warning` / `--fg-dim` 在浅色档早就分别是 5.08 与 5.24。三处各抄一张表
 * （宿主 `problem-store`、`ui-convention-report`、`ui-plugin-status`），主题就成了摆设。
 *
 * 判据（窄而硬，只拦"抄色值"这一件事）：
 *  ① 呈现层（`packages/app/src` 除 `monaco/`，与全部插件 `src`）的 TS/TSX 里，字符串字面量不许
 *     等于或包含这五枚 tone hex（`#e06c75` / `#d19a66` / `#4fc08d` / `#7f9cc0` / `#888` 系）——
 *     要点名角色，就写 `var(--danger)` / `var(--warning)` / `var(--success)` / `var(--info)` /
 *     `var(--fg-dim)` / `var(--danger-text)`；
 *  ② `var(--x, #hex)` 这种**兜底**形态放过：值仍以 token 为准，兜底只在 token 缺席时生效，
 *     翻主题照样跟得上（本仓既有的写法，不是本次要拦的形状）；
 *  ③ Monaco 侧（`packages/app/src/monaco/`）不在本闸范围：那边的主题表按 Monaco API 必须是裸 hex
 *     字符串，`var()` 它不解析——那是"另一套渲染面"的正当例外，不是抄色值；
 *  ④ CSS 文件不在本闸范围：洗色/描边用 `rgba(224,108,117,.1)` 这类带 alpha 的派生值是既定写法，
 *     它们的对比度判据（非文字 ≥3.0）由 `theme-contrast.test.ts` 按档逐条点名，不靠本闸重复管。
 *
 * 断言形态是"违规清单等于空数组"，不是"数量小于某个阈值"——新抄一枚就红，且点名到文件与字面量。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/** 本批清零的五枚 tone hex（`#888` 与 `#888888` 算同一枚） */
const TONE_HEX = ['#e06c75', '#d19a66', '#4fc08d', '#7f9cc0', '#888', '#888888'];

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'tests', 'monaco'].includes(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) tsFiles(abs, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(abs);
  }
  return out;
}

/** 扫描面：宿主 src（`monaco/` 由 tsFiles 的排除表挡掉）+ 全部插件 src */
function scanRoots(): string[] {
  const files: string[] = [];
  tsFiles(path.join(REPO, 'packages', 'app', 'src'), files);
  const plugins = path.join(REPO, 'packages', 'plugins');
  for (const ent of readdirSync(plugins, { withFileTypes: true })) {
    const src = path.join(plugins, ent.name, 'src');
    if (ent.isDirectory() && existsSync(src)) tsFiles(src, files);
  }
  return files;
}

describe('语义色单源 · 呈现层只准点名 token，不准抄 tone hex', () => {
  const files = scanRoots();

  it('扫描面非空（闸不许对空目录点头：宿主 + 插件的 src 文件都要真吃到）', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('problem-store.ts'))).toBe(true);
    expect(files.some((f) => /ui-plugin-status/.test(f))).toBe(true);
  });

  it('没有一枚 tone hex 被写成字面量（`var(--x, #hex)` 兜底形态除外）', () => {
    const violations: string[] = [];
    for (const abs of files) {
      const src = stripComments(readFileSync(abs, 'utf8'));
      const rel = path.relative(REPO, abs).replace(/\\/g, '/');
      for (const m of src.matchAll(/(['"])((?:[^'"\\]|\\.)*?)\1/g)) {
        const value = m[2]!.toLowerCase().trim();
        if (value.startsWith('var(')) continue; // 兜底形态：真源仍是 token
        const hit = TONE_HEX.find((hex) => value === hex || value.includes(hex));
        if (hit) violations.push(`${rel}：字符串 '${m[2]}' 抄了语义色 ${hit} ⇒ 改点名 var(--danger/--danger-text/--warning/--success/--info/--fg-dim)`);
      }
    }
    expect(violations).toEqual([]);
  });
});
