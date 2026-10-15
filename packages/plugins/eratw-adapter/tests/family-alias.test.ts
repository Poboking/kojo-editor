/**
 * D2 批：家族头中文别名表（`FAMILY_ALIASES`）的 adapter 实现自证。
 *
 * 覆盖契约 `VariableSchema.familyAlias` / `familyAliasReverse` 两方法：
 * - 正向：表层中文别名 → 引擎族头（`现在` → `NOWEX`…）；
 * - 反向：引擎族头 → 表层中文别名（`NOWEX` → `现在`…）；大小写不敏感；
 * - 负自证：**未登记**的名字 / 族头一律 `undefined`（不猜）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { FAMILY_ALIASES, loadEratwVariableSchema } from '../src/variable-schema';

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeIo(files: Record<string, string>): FileIO {
  return {
    listDir: async () => [
      { name: 'CFLAG.csv', path: '/game/CSV/CFLAG.csv', isDirectory: false },
    ],
    readText: async (path: string) => ({ text: files[path] ?? '', path }),
  } as unknown as FileIO;
}

async function schema() {
  return loadEratwVariableSchema({
    io: fakeIo({ '/game/CSV/CFLAG.csv': '2,好感度\n' }),
    csvDir: '/game/CSV',
    log: silentLog,
  });
}

describe('家族头中文别名（D2）× adapter', () => {
  it('正向：四条登记别名 → 引擎族头', async () => {
    const s = await schema();
    expect(s.familyAlias!('现在')).toBe('NOWEX');
    expect(s.familyAlias!('时标')).toBe('TFLAG');
    expect(s.familyAlias!('标记')).toBe('FLAG');
    expect(s.familyAlias!('随机')).toBe('RAND');
  });

  it('反向：四族头 → 中文别名（大小写不敏感）', async () => {
    const s = await schema();
    expect(s.familyAliasReverse!('NOWEX')).toBe('现在');
    expect(s.familyAliasReverse!('TFLAG')).toBe('时标');
    expect(s.familyAliasReverse!('FLAG')).toBe('标记');
    expect(s.familyAliasReverse!('RAND')).toBe('随机');
    // 引擎标识符大小写不敏感 ⇒ 小写族头同样命中
    expect(s.familyAliasReverse!('nowex')).toBe('现在');
    expect(s.familyAliasReverse!('rand')).toBe('随机');
  });

  it('负自证：未登记的名字 / 族头 → undefined（不猜）', async () => {
    const s = await schema();
    expect(s.familyAlias!('CFLAG')).toBeUndefined();
    expect(s.familyAlias!('現在')).toBeUndefined(); // 繁体写法不在表
    expect(s.familyAliasReverse!('CFLAG')).toBeUndefined();
    expect(s.familyAliasReverse!('TALENT')).toBeUndefined();
  });

  it('表本身：四条映射且与 FAMILY_LABELS（显示名轴）不混用', () => {
    // 策展常量形态自证（`FAMILY_LABELS` 是显示名轴，`FAMILY_ALIASES` 是输入别名轴）
    expect(FAMILY_ALIASES).toEqual({ 现在: 'NOWEX', 时标: 'TFLAG', 标记: 'FLAG', 随机: 'RAND' });
  });
});
