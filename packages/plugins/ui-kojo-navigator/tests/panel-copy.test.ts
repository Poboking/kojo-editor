/**
 * 函数树面板文案守卫（ZH-2 ②：原始错误串直出收口）。
 *
 * 钉的是**口径**而不是字符串运气：
 * - 第一眼必须是作者读得懂的中文短句；
 * - 原始错误串（`ensureIndex` / `buildNavigatorTree` 抛的 message）一条不丢——它逐字进悬停 `title`；
 * - 反例（旧写法 `` `函数索引加载失败：${loadError}` ``）一旦被改回去，`${loadError}` 的插值
 *   形态会在源码里重现，本文件静态扫到即红。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { navLoadErrorCopy } from '../src/panel-copy';

const SRC = path.resolve(import.meta.dirname, '..', 'src', 'navigator-panel.ts');
const srcText = (): string => readFileSync(SRC, 'utf8');

/** 形似内部错误串的样本（路径 + 英文栈式片段——正是绝不该当第一眼甩出去的东西） */
const RAW = 'ENOENT: no such file or directory, open C:\\proj\\ERB\\口上\\M_KOJO_K12.ERB';

describe('函数树失败态文案', () => {
  it('可见文本是中文短句，不含原始错误串', () => {
    const copy = navLoadErrorCopy(RAW);
    expect(copy.text).toBe('函数树加载失败：口上函数索引构建出错（悬停查看原始错误）');
    expect(copy.text).not.toContain(RAW);
    expect(copy.text).not.toContain('ENOENT');
    expect(/[\u4e00-\u9fa5]/.test(copy.text)).toBe(true);
  });

  it('技术信息零丢失：原始错误串逐字进悬停 title', () => {
    expect(navLoadErrorCopy(RAW).title).toBe(RAW);
    expect(navLoadErrorCopy('').title).toBe('');
  });

  it('源码里不再把 loadError 插进可见文本（旧写法回归即红）', () => {
    const s = srcText();
    expect(/\$\{loadError\}/.test(s), 'loadError 只能作为 title 取值，不许拼进上屏字符串').toBe(false);
    expect(s).toContain('navLoadErrorCopy(loadError)');
  });

  it('搜索结果归属列用中文「未归属」，不留破折号记号', () => {
    const s = srcText();
    expect(s).toContain(": '未归属'}");
    expect(/charaNo !== null \? `K\$\{h\.charaNo\}` : '—'/.test(s)).toBe(false);
  });
});
