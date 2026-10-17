/**
 * 版本显示联动 + 发版「三处同步」闸门（VB-1）。
 *
 * 缺陷本体：欢迎页那格曾写死 `v0.1` —— 真源早就存在（`src/bootstrap.ts` 从 app 包清单
 * 取 `version`，设置页与市场插件都吃它），抄本必然落后，所以这一格改成渲染真源之后
 * 用本闸钉死"以后别再抄"。
 *
 * **口径（写给下一个人，别以为是两处各判一次）**：
 * 1. 「三处同步」= root `package.json` / `packages/app/package.json` /
 *    `packages/app/src-tauri/tauri.conf.json` 三份清单的 `version` 字段**逐字相等**。
 *    本测试**不持有任何版本常量**——期望值只能是"另两处"，否则本文件自己就长成第四真相源。
 * 2. 设置页那格（`ui/SettingsPanel.tsx` ← `ui/ShellLayout.tsx` 的 `getVersion()`）走的是
 *    **运行时**壳版本（非 Tauri 环境读不到 ⇒ null），本闸**不重复判它**：构建期串（欢迎页
 *    胶囊 / 市场插件 `appVersion`）与运行时壳版本的一致性由第 1 条的三处同步闸兜住
 *    ——`tauri.conf.json` 正是 Rust 壳那个版本号的来源。
 * 3. 「显示串联动」在**源码文本**层判（本池 environment 是 node，无 DOM）：
 *    欢迎页胶囊的渲染串 = 字面量 `v` + `APP_VERSION`，而 `APP_VERSION` 的 import 说明符
 *    从源码目录解析后必须**正好落在那份 app 包清单文件**上 ⇒ 渲染串逐字等于 `v` + 现值。
 *    形态照同目录 `code-font.test.ts`（读源码逐字镜像核对）与 `kojo-lexicon-single-source.test.ts`
 *    （单一真源守卫）。
 *
 * 抬版本的正确动作：三份清单一起改（历史两笔：`9b2009d`、`e4d4621`），欢迎页与设置页零改动。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const urlOf = (rel: string) => new URL(rel, import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(urlOf(rel)), 'utf8');

/** 三份发版必改清单（相对本测试文件所在目录 `packages/app/tests` 的真实路径——解析口径写死在这里，值不写死） */
const SITES = [
  { label: 'root package.json', rel: '../../../package.json' },
  { label: 'packages/app/package.json', rel: '../package.json' },
  { label: 'packages/app/src-tauri/tauri.conf.json', rel: '../src-tauri/tauri.conf.json' },
] as const;

const APP_MANIFEST_REL = '../package.json';
const WELCOME_REL = '../src/ui/WelcomeView.tsx';
const WELCOME_ABS = fileURLToPath(urlOf(WELCOME_REL));

/** 读一处清单的 `version`；字段缺失/空串当场红（否则"两处都 undefined"会假绿） */
function versionAt(label: string, rel: string): string {
  const raw = JSON.parse(read(rel)) as { version?: unknown };
  expect(
    typeof raw.version === 'string' && raw.version.length > 0,
    `${label} 读不到非空的 version 字段（解析路径 ${rel}）——三处同步的其中一环已经断了`,
  ).toBe(true);
  return raw.version as string;
}

/**
 * 抹掉注释（保留行数与列位：字符串原样留着，写死在字符串里的版本号仍算死值）。
 * 只用于第 3 条的"红条件 = 代码文本"，注释里提历史值（"此前写死过 v0.1"这类说明）不该让闸红。
 * 已知粗口径：正则字面量里的引号可能被误判成串起始（同一状态机打法，与
 * `kojo-lexicon-single-source.test.ts` 的注释同认——只会漏判不会多判成代码文本）。
 */
function stripComments(src: string): string {
  type State = 'code' | 'line' | 'block' | 'string';
  let out = '';
  let state: State = 'code';
  let quote = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = 'string';
        quote = c;
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') state = 'code';
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // 字符串态：内容原样保留（死值正是以字符串形态出现的），转义跳两字符
    if (c === '\\') {
      out += c + (d ?? '');
      i += 2;
      continue;
    }
    if (c === quote || (c === '\n' && quote !== '`')) {
      // 闭合（或行内串跨行 = 语法错，别把后文整片吞成字符串）
      state = 'code';
      quote = '';
    }
    out += c;
    i += 1;
  }
  return out;
}

describe('发版纪律 · 版本号三处同步', () => {
  it('三份清单的 version 逐字相等（本测试不持有可能漂移的期望值）', () => {
    const got = SITES.map((s) => ({ ...s, version: versionAt(s.label, s.rel) }));
    const drift: string[] = [];
    for (let i = 0; i < got.length; i += 1) {
      for (let j = i + 1; j < got.length; j += 1) {
        const a = got[i] as (typeof got)[number];
        const b = got[j] as (typeof got)[number];
        if (a.version !== b.version) {
          drift.push(`「${a.label}」= ${JSON.stringify(a.version)} ≠「${b.label}」= ${JSON.stringify(b.version)}`);
        }
      }
    }
    expect(
      drift,
      [
        '版本号三处同步漂了（抬版本必须三份清单一起改，见 9b2009d「chore(release): v0.4.0-beta.1——版本号三处同步」',
        `与 e4d4621「版本 0.0.1——（tauri.conf / root / app 三处同步）」）：\n  ${drift.join('\n  ')}`,
        '⇒ 谁是权威没有答案：三份互为期望值。改齐那一份没跟上的清单，而不是把某个值抄进本测试。',
      ].join('\n'),
    ).toEqual([]);
  });
});

describe('欢迎页版本胶囊 · 联动真源', () => {
  it('胶囊渲染串 = `v` + app 包清单现值，且 APP_VERSION 的取值路径逐字落在那份清单上', () => {
    const src = read(WELCOME_REL);
    const manifestVersion = versionAt('packages/app/package.json', APP_MANIFEST_REL);

    // 取值路径：从源码文件所在目录解析 import 说明符，必须正好等于 app 包清单的真实路径
    const spec = /import\s*\{\s*version\s+as\s+APP_VERSION\s*\}\s*from\s*['"]([^'"]+)['"]/.exec(src)?.[1];
    expect(
      spec,
      'WelcomeView.tsx 没有从 app 包清单 import `{ version as APP_VERSION }`（照 src/bootstrap.ts 的取法）',
    ).toBeTypeOf('string');
    const resolved = path.resolve(path.dirname(WELCOME_ABS), spec as string);
    expect(resolved, 'APP_VERSION 的 import 说明符没有落在那份 app 包清单上（第二真相源）').toBe(
      path.resolve(fileURLToPath(urlOf(APP_MANIFEST_REL))),
    );

    // 渲染串：胶囊里只允许 `v` + 占位符，没有别的字面量 ⇒ 渲染出来的串逐字 = `v` + 现值
    const chip = /<span className="ver">\s*([^<]*?)\s*<\/span>/.exec(src)?.[1];
    expect(chip, '欢迎页版本胶囊的内容不再是 `v{APP_VERSION}`（照原样写，别加字面量）').toBe('v{APP_VERSION}');
    expect(chip?.replace('{APP_VERSION}', manifestVersion)).toBe(`v${manifestVersion}`);
  });

  it('禁死值回归：代码文本里不许再出现写死的版本字面量（`v` 紧跟数字）', () => {
    const code = stripComments(read(WELCOME_REL));
    const DEAD = /\bv\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?/g;
    const hits: string[] = [];
    code.split('\n').forEach((line, idx) => {
      for (const m of line.matchAll(DEAD)) hits.push(`第 ${idx + 1} 行第 ${m.index + 1} 列「${m[0]}」`);
    });
    expect(
      hits,
      [
        `WelcomeView.tsx 出现写死的版本号字面量：${hits.join('、')}`,
        "⇒ 改回从 app 包清单取：`import { version as APP_VERSION } from '../../package.json';` 后渲染 `v{APP_VERSION}`。",
        '   要抬版本请同步改三份清单（root / packages/app / src-tauri/tauri.conf.json），本文件零改动。',
      ].join('\n'),
    ).toEqual([]);
  });
});
