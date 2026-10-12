/**
 * 许可条款文本守门（反馈 4）。
 *
 * 这批断言的价值不在"函数返回了字符串"，而在**守住法律文本不被后来的人顺手改**：
 * 许可证不是文案，谁哪天觉得"这句中文翻译有点别扭"就动一个字，作者据此发布就
 * 踩进了一个他以为已经规避掉的风险。所以 LTOL 用**逐字等值 + 长度**双钉，
 * 标准协议用**规范句式**钉关键条款。
 */

import { describe, expect, it } from 'vitest';
import {
  LICENSE_CHOICES,
  buildLicenseText,
  licenseProducesFile,
  type LicenseKind,
} from '../src/licenses';

const F = { author: '某作者', year: 2026, workName: '东方口上合集' };
const text = (kind: LicenseKind) => buildLicenseText(kind, F);

describe('选项表', () => {
  it('每一项都有中文标签与说明（说明是给不懂法律术语的作者看的）', () => {
    expect(LICENSE_CHOICES.length).toBeGreaterThanOrEqual(6);
    for (const c of LICENSE_CHOICES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.hint.length).toBeGreaterThan(0);
    }
  });

  it('缺省项是「不生成」——工具不替作者选定许可', () => {
    expect(LICENSE_CHOICES[0]!.kind).toBe('none');
    expect(licenseProducesFile('none')).toBe(false);
  });

  it('kind 唯一，不重复登记', () => {
    const kinds = LICENSE_CHOICES.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('标准协议（OSI/SPDX 规范文本）', () => {
  it('MIT：标题、版权声明、授予与免责的规范句式都在', () => {
    const t = text('mit');
    expect(t).toContain('MIT License');
    expect(t).toContain('Copyright (c) 2026 某作者');
    expect(t).toContain('Permission is hereby granted, free of charge');
    expect(t).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(t).toContain('WITHOUT WARRANTY OF ANY KIND');
  });

  it('BSD-2-Clause：两条再分发条件 + 免责', () => {
    const t = text('bsd-2-clause');
    expect(t).toContain('BSD 2-Clause License');
    expect(t).toContain('Redistributions of source code must retain');
    expect(t).toContain('Redistributions in binary form must reproduce');
    expect(t).toContain('THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"');
    // 只有两条条件——第三条"广告条款"是 BSD-3 才有的，别混进来
    expect(t).not.toContain('neither the name of');
  });

  it('ISC：短版免责句式（与 MIT 不同源，不能互相顶替）', () => {
    const t = text('isc');
    expect(t).toContain('ISC License');
    expect(t).toContain('THE AUTHOR DISCLAIMS ALL WARRANTIES');
  });

  it('三者互不相同（复制粘贴漏改会在这一条暴露）', () => {
    const all = ['mit', 'bsd-2-clause', 'isc'].map((k) => text(k as LicenseKind));
    expect(new Set(all).size).toBe(3);
  });
});

describe('CC BY-NC 4.0 —— 要点速览，不冒充法律文本', () => {
  it('给出官方链接与"以官方文本为准"的明示', () => {
    const t = text('cc-by-nc-4.0');
    expect(t).toContain('creativecommons.org/licenses/by-nc/4.0/');
    expect(t).toContain('具有法律效力的完整条款');
    expect(t).toMatch(/要点速览[^\n]*不是法律文本/);
  });
  it('三条核心约束齐：署名 / 非商业 / 改编同协议', () => {
    const t = text('cc-by-nc-4.0');
    expect(t).toContain('署名');
    expect(t).toContain('非商业性');
    expect(t).toContain('改编');
  });
});

describe('LTOL（era 社区时限开放许可）', () => {
  /**
   * 原文由项目负责人 2026-10-12 提供。**改这里之前先确认拿到的是新版权威原文**，
   * 而不是"觉得某句读着别扭"。
   */
  it('日文原文的关键条款逐字在位', () => {
    const t = text('ltol');
    expect(t).toContain('■ライセンス本文');
    expect(t).toContain('このライセンスは口上に含まれる台詞等を保護するために明記されています。');
    expect(t).toContain('ライセンス汚染の防止。');
    expect(t).toContain('このライセンスはライセンスが明記されてから一年を有効期限とします。');
    expect(t).toContain('半年でこのライセンスは失効し、フリーライセンスとなります。');
    expect(t).toContain('その後の派生物に対してはライセンスの主張が出来ません。');
  });

  it('中文译文随后，且保留原文的小节编号形态（3-a / 3-b）', () => {
    const t = text('ltol');
    const ja = t.indexOf('■ライセンス本文');
    const zh = t.indexOf('■ 许可证正文（中文译文）');
    expect(ja).toBeGreaterThan(-1);
    expect(zh).toBeGreaterThan(ja); // 日文在前：它是源头语言
    expect(t).toContain('3-a. 有效期');
    expect(t).toContain('3-b. 许可证失效');
  });

  it('长度守住（防"顺手精简一版"把条款削掉）', () => {
    expect(text('ltol').length).toBeGreaterThan(1200);
  });

  it('署名信息在头部，正文不被污染', () => {
    const t = text('ltol');
    expect(t).toContain('版权人：某作者');
    expect(t.indexOf('版权人')).toBeLessThan(t.indexOf('■ライセンス本文'));
  });
});

describe('buildLicenseText 边界', () => {
  it('none 被调用是配置错误 —— 抛错而不是返回空串', () => {
    expect(() => text('none')).toThrow(/不应生成 LICENSE 文件/);
  });

  it('占位模板不替作者下任何许可判断', () => {
    const t = text('template');
    expect(t).toContain('Copyright (c) 2026 某作者');
    expect(t).toContain('占位模板');
    // 不能出现任何具体协议的条款正文
    expect(t).not.toContain('Permission is hereby granted');
  });

  it('首尾空白会被修剪（作者名打空格很常见）', () => {
    const t = buildLicenseText('mit', { ...F, author: '  某作者  ' });
    expect(t).toContain('Copyright (c) 2026 某作者');
    expect(t).not.toContain('2026   某作者');
  });
});
