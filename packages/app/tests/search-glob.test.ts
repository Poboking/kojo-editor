import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSION_TEXT,
  getGlobFilterText,
  parseExtensions,
  parseFileFilter,
  setGlobFilterText,
} from '../src/ui/search-query';

/**
 * glob 文件过滤单测（P2-15 体验差距批）。
 *
 * 钉三件事：
 * ① `parseFileFilter` 的混写解析——glob 与扩展名分成两类词、各自归一
 *    （`parseExtensions` 老函数签名与行为不许破坏，这里顺带盯一条回归）；
 * ② **Rust 翻译规则的 TS 镜像对拍**——`packages/app/src-tauri/src/lib.rs` 的
 *    `glob_to_regex` 与下面的 `globToRegex` 是同一张规则表的两个实现，
 *    两侧断言同一组期望值（规则表一处漂，两边同时红）；
 * ③ 行文语义：相对根路径上的匹配 / 不匹配矩阵（`**` 后接 `/` 的序列含 0 层、
 *    `*`/`?` 不跨目录、Windows 反斜杠归一、空 globs = 不过滤）。
 * （注释里 `**` 与 `/` 刻意分写：块注释中 `*` 紧跟 `/` 会提前终止注释）
 */

/* ------------------------------ ① parseFileFilter ------------------------------ */

describe('parseFileFilter · 两类词分开、各自归一', () => {
  it('glob 与扩展名混写：含通配符/分隔符的段进 globs，其余进 extensions', () => {
    const parts = parseFileFilter('erb, *.kojo, csv, src/**/*.erb');
    expect(parts.extensions).toEqual(['csv', 'erb']);
    expect(parts.globs).toEqual(['*.kojo', 'src/**/*.erb']);
  });

  it('分隔符与 parseExtensions 同款（半角/全角逗号、分号、空白）', () => {
    const parts = parseFileFilter('*.kojo，**/x/*.erb；a?b  csv');
    // 产出是**排序**的（同一份输入恒产出同一个请求）：`**/x/*.erb` 第 2 位是
    // `*`(42) < `*.kojo` 第 2 位 `.`(46) < `a?b` 第 2 位 `?`(63)
    expect(parts.globs).toEqual(['**/x/*.erb', '*.kojo', 'a?b']);
    expect(parts.extensions).toEqual(['csv']);
  });

  it('扩展名段：去前导点、转小写（与 parseExtensions 逐字同口径）', () => {
    const parts = parseFileFilter('.ERB, .Csv');
    expect(parts.extensions).toEqual(['csv', 'erb']);
  });

  it('glob 段：反斜杠归一成 `/`，大小写原样保留（路径模式不是后缀词表）', () => {
    const parts = parseFileFilter('SUB\\*.ERB');
    expect(parts.globs).toEqual(['SUB/*.ERB']);
  });

  it('去重 + 排序（同一份输入恒产出同一个请求，判据可钉）', () => {
    const a = parseFileFilter('*.kojo, *.kojo, erb, erb, **/x');
    expect(a.globs).toEqual(['**/x', '*.kojo']);
    expect(a.extensions).toEqual(['erb']);
  });

  it('空文本 = 两类都空（不限扩展名、不按形态过滤）', () => {
    expect(parseFileFilter('   ')).toEqual({ extensions: [], globs: [] });
    expect(parseFileFilter('')).toEqual({ extensions: [], globs: [] });
  });

  it('默认词表全文解析：全是扩展名、零 glob（parseExtensions 行为未被破坏）', () => {
    const parts = parseFileFilter(DEFAULT_EXTENSION_TEXT);
    expect(parts.globs).toEqual([]);
    expect(parts.extensions).toEqual(parseExtensions(DEFAULT_EXTENSION_TEXT));
  });

  it('纯 glob 文本不含扩展名段（glob 框的常见形态；产出按排序）', () => {
    expect(parseFileFilter('*.kojo, **/x/*.erb')).toEqual({
      extensions: [],
      globs: ['**/x/*.erb', '*.kojo'],
    });
  });
});

describe('glob 过滤框的当前文本（P2-11 接线前的接缝）', () => {
  it('写入后读得到（发请求时由 search-store 读它 → request.options.globs）', () => {
    setGlobFilterText('*.kojo, src/**/*.erb');
    expect(getGlobFilterText()).toBe('*.kojo, src/**/*.erb');
    expect(parseFileFilter(getGlobFilterText()).globs).toEqual(['*.kojo', 'src/**/*.erb']);
    setGlobFilterText('');
    expect(getGlobFilterText()).toBe('');
  });
});

/* ------------------------------ ② Rust 翻译规则的 TS 镜像 ------------------------------ */

/**
 * `lib.rs::glob_to_regex` 的 **TS 镜像**（同一张规则表，逐字对拍）：
 *   `*` → `[^/]*`、`?` → `[^/]`、其余字符 regex 转义、整串 `^…$`；
 *   分隔符先归一成 `/`；`**` 后接 `/` 的序列 → 可选前缀（含 0 层；具体正则见
 *   下方函数体——否则 `src/**`/`*.erb` 匹配不到直档子文件，理由见 Rust 侧注释），
 *   裸 `**` → `.*`。
 * 只钉经典元字符的转义（`#&-:~` 的转义集随 regex crate 版本可能微调，不钉）。
 */
function globToRegex(glob: string): string {
  const chars = [...glob.replace(/\\/g, '/')];
  let out = '^';
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === '*' && chars[i + 1] === '*') {
      if (chars[i + 2] === '/') {
        out += '(.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return `${out}$`;
}

describe('glob 翻译规则 · TS 镜像与 Rust 逐字对拍', () => {
  it('三档通配 + 转义 + 反斜杠归一（这张表 = Rust 侧那张表）', () => {
    expect(globToRegex('*.kojo')).toBe('^[^/]*\\.kojo$');
    expect(globToRegex('**/x/*.erb')).toBe('^(.*/)?x/[^/]*\\.erb$');
    expect(globToRegex('src/**/*.erb')).toBe('^src/(.*/)?[^/]*\\.erb$');
    expect(globToRegex('**')).toBe('^.*$');
    expect(globToRegex('a?b')).toBe('^a[^/]b$');
    expect(globToRegex('a.b')).toBe('^a\\.b$');
    expect(globToRegex('a+b(c)|d')).toBe('^a\\+b\\(c\\)\\|d$');
    expect(globToRegex('sub\\*.erb')).toBe('^sub/[^/]*\\.erb$');
  });

  it('翻译产出必然可编译（转义保证合法性；`*?`、`[`、`(` 也不炸）', () => {
    for (const g of ['*.kojo', '**/x/*.erb', 'a?b', 'a.b', 'a+b(c)', 'sub\\*.erb', '[', '(', '*?']) {
      expect(() => new RegExp(globToRegex(g)), g).not.toThrow();
    }
  });
});

/* ------------------------------ ③ 行文语义（相对根路径上的匹配矩阵） ------------------------------ */

const matches = (glob: string, relPath: string): boolean => new RegExp(globToRegex(glob)).test(relPath);

describe('glob 行文语义 · 相对根路径', () => {
  it('`*.kojo`：单层、不跨目录', () => {
    expect(matches('*.kojo', 'a.kojo')).toBe(true);
    expect(matches('*.kojo', 'sub/a.kojo')).toBe(false);
  });

  it('`**/*.erb`：任意层（含 0 层 ⇒ 根下直档也命中）', () => {
    expect(matches('**/*.erb', 'a.erb')).toBe(true);
    expect(matches('**/*.erb', 'x/a.erb')).toBe(true);
    expect(matches('**/*.erb', 'x/y/a.erb')).toBe(true);
    expect(matches('**/*.erb', 'a.kojo')).toBe(false);
  });

  it('`src/**/*.erb`：前缀目录 + 任意层（含直档子文件）', () => {
    expect(matches('src/**/*.erb', 'src/a.erb')).toBe(true);
    expect(matches('src/**/*.erb', 'src/x/a.erb')).toBe(true);
    expect(matches('src/**/*.erb', 'other/a.erb')).toBe(false);
  });

  it('`**/x/*.erb`：任意层前缀 + 目录名 x', () => {
    expect(matches('**/x/*.erb', 'x/a.erb')).toBe(true);
    expect(matches('**/x/*.erb', 'd/x/a.erb')).toBe(true);
    expect(matches('**/x/*.erb', 'ax/a.erb')).toBe(false); // `x` 前必须是目录分隔符
  });

  it('`?.erb`：一级单字符（`?` 不跨目录 ⇒ 只认根下直档）', () => {
    expect(matches('?.erb', 'a.erb')).toBe(true);
    expect(matches('?.erb', 'ab.erb')).toBe(false);
    expect(matches('?.erb', 'sub/a.erb')).toBe(false);
  });

  it('元字符是字面（作者的点不是任意字符）', () => {
    expect(matches('a.b', 'a.b')).toBe(true);
    expect(matches('a.b', 'axb')).toBe(false);
  });

  it('空 glob 串不过滤任何文件（空 = 今天行为，交给扩展名那一档）', () => {
    // parseFileFilter 对空文本给空数组；Rust 侧 glob_res 空 ⇒ 不进入 glob 分支
    expect(parseFileFilter('').globs).toEqual([]);
    expect(parseFileFilter(' , ; ').globs).toEqual([]);
  });
});
