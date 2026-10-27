/**
 * PERF-5 验收（服务层）：转译结果**共享缓存**的正确性 + 读数。
 *
 * 契约：转译是纯函数 ⇒ 键 = (源文本, filePath)（`fileName` 不参与产物，不入键）；
 * generation（adapterId / 项目 / 变量字典代际）由装配层"换实例"承担（见
 * `hotpath-memo.test.ts` 的插件级接线）。本文件钉四件事：
 *
 * 1. **同文本同路径 = 同一次真实转译**（第二次起命中，且返回同一结果对象）；
 * 2. **文本变 / 路径变 = 必重算**（缓存不会混淆两个文档 / 两个文件）；
 * 3. **`fileName` 不影响产物也不影响键**（与实现口径同源：只可能进诊断，且由
 *    `filePath` 推导——见 `service.ts` 的 `transpileUncached` 头注）；
 * 4. **容量上限与淘汰**（条数 / 字符数封顶；淘汰后结果仍逐字节正确）。
 *
 * "保存链 2→1"的端到端读数在 `ui-sugar-editor/tests/save-single-pass.test.ts`
 * （`planSave`（miss）+ `compileToFile`（hit）的调用形态来自 save-handler）。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const PATH = 'C:/proj/M_KOJO_K49_指令.kojo1';

/** 可通过转译的合法文档（与 `save-plan.test.ts` 同款） */
const VALID = '角色: 12\n时机 指令 310：\n    「呀。」\n';
/** 另一个合法文档（内容不同 ⇒ 不同缓存键） */
const VALID2 = '角色: 12\n时机 指令 311：\n    「呀。」\n';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

describe('同 (文本, filePath)：只做一次真实转译', () => {
  it('第二次起命中，且返回同一结果对象（三消费者共享的机制本体）', () => {
    const s = svc();
    const r1 = s.transpile(VALID, { filePath: PATH });
    const r2 = s.transpile(VALID, { filePath: PATH });
    const r3 = s.transpile(VALID, { filePath: PATH });
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(s.transpileCacheStats()).toMatchObject({ misses: 1, hits: 2 });
    // 产物逐字节仍是真转译产物（不是空壳替身）
    expect(r1.erb).toContain('@');
  });

  it('`planSave` 与 `compileToBytes` 同键共享（保存前置 + 内存编译 = 1 次真实转译）', () => {
    const s = svc();
    const plan = s.planSave({ source: VALID, sourcePath: PATH });
    expect(plan.blocked).toBe(false);
    const compiled = s.compileToBytes(VALID, { filePath: PATH });
    expect(s.transpileCacheStats()).toMatchObject({ misses: 1, hits: 1 });
    // 复用的是 planSave 那一份转译结果（同一对象）
    expect(compiled.transpile).toBe(plan.transpile);
  });
});

describe('失效正确性：文本变 / 路径变 / 代际换实例', () => {
  it('文本变 ⇒ 必重算（不相同结果、产物不同）', () => {
    const s = svc();
    const r1 = s.transpile(VALID, { filePath: PATH });
    const r2 = s.transpile(VALID2, { filePath: PATH });
    expect(r2).not.toBe(r1);
    expect(s.transpileCacheStats()).toMatchObject({ misses: 2, hits: 0 });
  });

  it('路径变 ⇒ 必重算（filePath 进诊断与命名检查，不可跨文件复用）', () => {
    const s = svc();
    s.transpile(VALID, { filePath: PATH });
    s.transpile(VALID, { filePath: 'C:/proj/other.kojo1' });
    expect(s.transpileCacheStats()).toMatchObject({ misses: 2, hits: 0 });
  });

  it('`fileName` 变化不影响键也不影响产物（入键面 = (文本, filePath)，与产物依赖面一致）', () => {
    const s = svc();
    const r1 = s.transpile(VALID, { filePath: PATH });
    const r2 = s.transpile(VALID, { filePath: PATH, fileName: '另一名字.kojo1' });
    expect(r2).toBe(r1);
    expect(s.transpileCacheStats()).toMatchObject({ misses: 1, hits: 1 });
  });

  it('两个服务实例互不共享缓存（= 装配层换代的失效机制：新代际 = 新实例 = 空缓存）', () => {
    const a = svc();
    const b = svc();
    a.transpile(VALID, { filePath: PATH });
    b.transpile(VALID, { filePath: PATH }); // 不得因 a 算过而命中
    expect(a.transpileCacheStats()).toMatchObject({ misses: 1, hits: 0 });
    expect(b.transpileCacheStats()).toMatchObject({ misses: 1, hits: 0 });
  });
});

describe('容量上限与淘汰：有界内存 + 结果仍正确', () => {
  it('条数与字符数封顶，淘汰数可见；淘汰后重算结果与全新实例逐字节一致', () => {
    const s = createSugarTranspileService({
      dictionary: stubDict,
      faceTable: stubFaceTable(),
      cache: { maxBuckets: 2, maxEntriesPerBucket: 2, maxSourceChars: VALID.length * 3 },
    });
    const texts = [VALID, VALID2, `${VALID}; a\n`, `${VALID}; b\n`, `${VALID}; c\n`];
    for (const t of texts) s.transpile(t, { filePath: PATH });
    const stats = s.transpileCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(2); // 单桶上限
    expect(stats.sourceChars).toBeLessThanOrEqual(VALID.length * 3);
    expect(stats.evictions).toBeGreaterThan(0);

    // 淘汰不代表错误：最先被淘汰的文本重算 ⇒ miss，且产物与全新实例逐字节一致
    const r = s.transpile(VALID, { filePath: PATH });
    const fresh = svc().transpile(VALID, { filePath: PATH });
    expect(r.erb).toBe(fresh.erb);
    expect(r.diagnostics).toEqual(fresh.diagnostics);
    expect(s.transpileCacheStats().misses).toBe(texts.length + 1);
  });

  it('桶数与字符数封顶（多文件 / 超限文本不进缓存也不挤掉别人）', () => {
    const s = createSugarTranspileService({
      dictionary: stubDict,
      faceTable: stubFaceTable(),
      cache: { maxBuckets: 1, maxEntriesPerBucket: 4, maxSourceChars: 10_000 },
    });
    for (let i = 0; i < 3; i++) s.transpile(VALID, { filePath: `C:/proj/f${i}.kojo1` });
    // 单桶上限 ⇒ 只有第 3 个文件在线；后面的写入挤掉前面的桶
    const stats = s.transpileCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(4);
    expect(stats.evictions).toBeGreaterThanOrEqual(1);
    // 超限文本（> maxSourceChars）不入缓存：每次都 miss，也不清空既有条目
    const huge = `; ${'x'.repeat(11_000)}\n${VALID}`;
    s.transpile(huge, { filePath: 'C:/proj/big.kojo1' });
    s.transpile(huge, { filePath: 'C:/proj/big.kojo1' });
    expect(s.transpileCacheStats().hits).toBe(0);
    expect(s.transpileCacheStats().entries).toBeGreaterThan(0);
  });
});
