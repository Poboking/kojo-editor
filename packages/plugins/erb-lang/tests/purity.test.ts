/**
 * `@kojo/plugin-erb-lang` 的**纯插件守卫**（LAU-4 第一步的 DoD 判据）。
 *
 * 这个包与 `@kojo/erb-lang` 的分工是"判据 / 供方"，但两者的**硬边界完全相同**：
 * 零 Monaco、零 React、零 IO、零游戏名词。理由不是洁癖，是这一条链的**可替换性**：
 *
 * - 插件一旦 `import 'monaco-editor'`，它就只能在宿主进程里跑，"第三方作者写的语言包
 *   也能装进编辑器"那条路直接断掉；
 * - 插件一旦读盘 / 读 `project`，它就得跟着 adapter 演进改，而它本来只认识语言。
 *
 * 判据只看**依赖**（不看正文）：这些文件的注释里必然出现 Monaco / 契约名，那是解释，
 * 不是耦合。而 `import type` 在运行时被擦除、单测永远绿 —— 所以 specifier 扫描必须
 * 连 `type` 一起匹配。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(name)) out.push(abs);
    }
  };
  walk(SRC);
  return out.sort();
}

const SPEC_RE = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const BARE_RE = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function specifiersOf(src: string): string[] {
  return [
    ...[...src.matchAll(SPEC_RE)].map((m) => m[1] as string),
    ...[...src.matchAll(BARE_RE)].map((m) => m[1] as string),
  ];
}

/** 允许的外部依赖（白名单，不写黑名单：新增一个包必须先想清楚它属不属于这一层） */
const ALLOWED_PACKAGES = new Set([
  '@kojo/plugin-api',
  // 判据全在语言面库：两枚叶子 + 语言 id 清单（请人认的 id 不依赖宿主）
  '@kojo/erb-lang',
  '@kojo/erb-lang/constants',
  '@kojo/erb-lang/highlight',
  '@kojo/erb-lang/selection-range',
  // LAU-1031-SIG（2026-10-31）：签名判据叶出宿主进语言面库，本插件只做槽供方翻译层。
  '@kojo/erb-lang/signature',
  // ERB-PARITY G2：排版判据的唯一真源是词表库那把与 `.kojo` 共用的尺子（叶子 import，不是桶；
  // 常驻解析器插件引它会进开机静态图——本插件懒装载，判据照样一份、开机图一分不涨）
  '@kojo/kojo-vocab/formatter',
]);

describe('@kojo/plugin-erb-lang 是纯插件（零 Monaco / 零 React / 零 IO / 零游戏知识）', () => {
  const files = sources();

  it('扫到的文件数与预期一致（防止走空匹配）', () => {
    // request / highlight / selection-range / formatting / signature / plugin / index
    // （LAU-1031-SIG 2026-10-31：signatureHelp 供方进包，6 ⇒ 7）
    expect(files).toHaveLength(7);
  });

  it('外部依赖只在白名单里（其余一律是本包内相对路径）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) continue;
        if (ALLOWED_PACKAGES.has(spec)) continue;
        offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零 monaco / 零 react / 零 DOM / 零 node IO', () => {
    const banned = /^(monaco-editor|react|react-dom|@tauri-apps\/.*|node:.*|fs|path|os|crypto)$/;
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (banned.test(spec)) offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('零游戏名词（同 audit:decoupling 的 A 项口径）', () => {
    const gameWords = /eratw|erafl|eraakumamaid|eratoho|キャラ|CFLAG|TFLAG/i;
    const offenders = files.filter((file) => gameWords.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });

  it('不碰宿主与内核（插件只能依赖 plugin-api + 语言面库）', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
        if (spec === '@kojo/kernel' || spec.includes('packages/app')) {
          offenders.push(`${path.basename(file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
