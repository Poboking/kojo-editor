import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ERB_CONTINUATION_MARKERS,
  ERB_CONTINUATION_SEPARATOR,
  erbContinuationJoin,
  erbContinuationRoleOf,
} from '../src/erb';

/**
 * 行连接 `{` … `}` 契约自证（A2 批，2026-10-26）。
 *
 * 判据只有一份，住在 `plugin-api` 的理由：这条口径的**三方**都要用——`erb-parser` 的 `.erh`
 * 校验、`condition-extractor` 的多行条件拼接、`erb-syntax-tree` 的块形状；而插件之间不许
 * 互相 import（解耦审计 C 项）、语言包也不许依赖插件，`plugin-api` 是唯一共同下界。
 *
 * 历史账（本批消灭的）：判据曾有两份私有实现 + 一处从来没写——
 * `.erh` 侧用 `join('')` 拼（`LOCAL` 与 `1` 会粘成 `LOCAL1`，引擎看到的是 `LOCAL 1`），
 * `condition-extractor` 侧用 `join(' ')`（恰好对）；同一件事两处各写一遍，一处对一处错，
 * 就是 PITFALLS 211/216 那族。
 */

describe('行连接契约 · 形状', () => {
  it('三枚常量与引擎口径一致（`Config.ReplaceContinuationBR` 默认值去引号 = 一个半角空格）', () => {
    expect(ERB_CONTINUATION_MARKERS).toEqual({ open: '{', close: '}' });
    expect(ERB_CONTINUATION_SEPARATOR).toBe(' ');
    // 冻结：三处消费方共享同一实例，谁都不许就地改
    expect(Object.isFrozen(ERB_CONTINUATION_MARKERS)).toBe(true);
  });
});

describe('行连接契约 · 角色判据（整行严格等值，不剥代码前缀）', () => {
  it('整行只有 `{` / `}` 才认（前后允许水平空白含全角空格）', () => {
    expect(erbContinuationRoleOf('{')).toBe('open');
    expect(erbContinuationRoleOf('}')).toBe('close');
    expect(erbContinuationRoleOf('  {')).toBe('open');
    expect(erbContinuationRoleOf('\t}\t')).toBe('close');
    expect(erbContinuationRoleOf('\u3000{\u3000')).toBe('open');
    expect(erbContinuationRoleOf('{\r')).toBe('open');
  });

  it('带尾巴的不认（引擎判 `CharacterAfterContinuation`，不是行连接）', () => {
    expect(erbContinuationRoleOf('{ 1, 2 }')).toBeNull();
    expect(erbContinuationRoleOf('{}')).toBeNull();
    expect(erbContinuationRoleOf('} ENDIF')).toBeNull();
    expect(erbContinuationRoleOf('PRINTL ||::::::::::{')).toBeNull();
  });

  it('代码前缀不剥：`;!;{` 不是行连接（引擎拿**整行**比 `line.Trim() != "{"`）', () => {
    // 这条是设计结论而非疏漏：`;!;` 只是"忽略停用"标记，剥掉它再判会让 `;!;{` 被认成块头，
    // 而引擎会先 Trim 整行再比，直接抛 CharacterAfterContinuation。
    expect(erbContinuationRoleOf(';!;{')).toBeNull();
    expect(erbContinuationRoleOf(';#;{')).toBeNull();
  });

  it('注释行 / 空行不认', () => {
    expect(erbContinuationRoleOf('; {')).toBeNull();
    expect(erbContinuationRoleOf('')).toBeNull();
    expect(erbContinuationRoleOf('   ')).toBeNull();
  });
});

describe('行连接契约 · 拼接（引擎逐行 Append + ReplaceContinuationBR）', () => {
  it('行间补一个半角空格，不是直拼', () => {
    // 直拼会让 `LOCAL` 与 `1` 粘成 `LOCAL1`；引擎看到的是 `LOCAL 1`
    expect(erbContinuationJoin(['LOCAL', '1'])).toBe('LOCAL 1');
    expect(erbContinuationJoin(['IF A &&', '    && B'])).toBe('IF A &&     && B');
  });

  it('空行也占一格（引擎每行后都 append 分隔符）', () => {
    expect(erbContinuationJoin(['A', '', 'B'])).toBe('A  B');
  });

  it('单行 / 空表原样', () => {
    expect(erbContinuationJoin(['A'])).toBe('A');
    expect(erbContinuationJoin([])).toBe('');
  });
});

describe('行连接契约 · 收口（两处私有判据已改为委托）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '..', '..', '..');
  const consumers = [
    join(repo, 'packages', 'plugins', 'erb-parser', 'src', 'erh.ts'),
    join(repo, 'packages', 'plugins', 'condition-extractor', 'src', 'extract.ts'),
  ];

  it('两个消费方都从 @kojo/plugin-api 取判据，且代码区不再有裸花括号比较', () => {
    for (const file of consumers) {
      const source = readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code, `${file} 没用契约判据`).toContain('erbContinuationRoleOf');
      expect(code, `${file} 没用契约拼接`).toContain('erbContinuationJoin');
      expect(code, `${file} 又手写了整行等值判据`).not.toMatch(/===\s*'\{'/);
      expect(code, `${file} 又手写了整行等值判据`).not.toMatch(/===\s*'\}'/);
    }
  });
});
