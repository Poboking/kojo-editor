/**
 * EditorPane 数据流回归守卫（源码形态判据，2026-10 审阅批）——钉死三条**数据丢失/错位**
 * 修复的落地形状，防止日后重构时静默回退：
 *
 * 1. 文件切换 effect 的依赖数组**不含 `onStatusInfo`**（宿主内联 prop 每次渲染换身份，
 *    effect 又经 `pushSelStatus(true)` 强制上抛新对象 ⇒ 引用相等永远失败 ⇒ 自持渲染死循环）；
 *    effect 体只许走 `onStatusInfoRef`。
 * 2. 外部改动冲突 toast 的 action **不闭包本次读到的文本**（`run: applyReload` 已禁用）：
 *    点击时必须置一次性强制意图（`forceReloadPathsRef`）并经恒稳 ref 重跑 `reloadFromDisk`
 *    现读盘——否则第二次外部写入后旧 toast 应用过期 T1 并把基线钉成"干净"，下一次保存覆盖 T2。
 * 3. `publishCursor` / `snapshotActiveView` 带**model==当前路径条目**竞态闸：异步 acquire
 *    期间 `filePathRef` 先于 model 换装更新，不加闸会把 A 的位点存进 B 的键 / 广播 {B, A 行}。
 *
 * 形态判据而非行为判据的原因：这三条都活在 2600 行组件的闭包里，无挂载设施就跑不起来；
 * 行为面已有纯函数单测（external-change / breadcrumb-path / cursor-broadcast）覆盖判据本体。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.resolve(import.meta.dirname, '..', 'src', 'ui', 'EditorPane.tsx'),
  'utf8',
);

/** 截 `const NAME = ...` 到下一个顶层 `const` 声明之间的函数体（粗略但足够钉形状） */
function sliceFn(name: string): string {
  const start = SOURCE.indexOf(`const ${name} =`);
  expect(start, `找不到 ${name}`).toBeGreaterThanOrEqual(0);
  const rest = SOURCE.slice(start + `const ${name} =`.length);
  const end = rest.search(/\n  const [A-Za-z_]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

describe('EditorPane 渲染循环闸（#1）', () => {
  const depsLine = SOURCE.split('\n').find((l) => l.trimStart().startsWith('}, [kernel, filePath, applyReveal'));
  it('文件切换 effect 依赖数组不含 onStatusInfo（只走 ref）', () => {
    expect(depsLine, '找不到文件切换 effect 的依赖行').toBeTruthy();
    expect(depsLine).not.toContain('onStatusInfo');
  });
  it('该 effect 体内不直接引用 onStatusInfo（一切上抛经 onStatusInfoRef / pushSelStatus）', () => {
    const depsIdx = SOURCE.indexOf('}, [kernel, filePath, applyReveal');
    expect(depsIdx).toBeGreaterThan(0);
    const bodyStart = SOURCE.lastIndexOf('useEffect(() => {', depsIdx);
    const body = SOURCE.slice(bodyStart, depsIdx);
    expect(body).toContain('editorModelPool.acquire('); // sanity：切到的确是文件切换 effect 本体
    expect(body).not.toMatch(/onStatusInfo/);
  });
});

describe('外部改动冲突 toast 现读盘（#2）', () => {
  it('action 不再闭包 applyReload（旧文本 T1 覆盖 T2 的通道已焊死）', () => {
    expect(SOURCE).not.toMatch(/run:\s*applyReload/);
  });
  it('action 置 forceReloadPathsRef 一次性意图并经 reloadFromDiskRef 重跑', () => {
    const notifyBlock = SOURCE.slice(SOURCE.indexOf('const conflictPending'), SOURCE.indexOf('const conflictPending') + 1200);
    expect(notifyBlock).toContain('forceReloadPathsRef.current.add(path)');
    expect(notifyBlock).toContain('reloadFromDiskRef.current?.(path)');
  });
  it('reloadFromDisk 入口消费强制意图；forced 时走 applyReload（用本次现读的 text）', () => {
    expect(SOURCE).toContain('forceReloadPathsRef.current.delete(path)');
    expect(SOURCE).toMatch(/decision === 'reload' \|\| forced/);
  });
  it('同一文件未决冲突期间通知去重（不叠第二条 toast）', () => {
    expect(SOURCE).toMatch(/externalConflictRef\.current\.has\(path\)[\s\S]{0,80}if \(!conflictPending\)/);
  });
});

describe('异步 acquire 期间的视图/光标串档闸（#3）', () => {
  for (const name of ['publishCursor', 'snapshotActiveView']) {
    it(`${name} 校验屏幕 model 归属当前路径条目`, () => {
      const body = sliceFn(name);
      expect(body).toContain('entriesRef.current.get');
      expect(body).toMatch(/!==\s*entry\.model/);
    });
  }
  it('publishCursor 放行糖 model（derivedView 广播不能被闸误杀）', () => {
    expect(sliceFn('publishCursor')).toContain('sugarModelRef.current');
  });
});

describe('大文件面包屑清空（#4）', () => {
  it('crumbRefresh 对超阈值文件清空链而非维持旧链（旧链点击 = 把别的文件的行 reveal 进当前文件）', () => {
    // 入口按**签名无关**的定位（PS-5 起它是 `(forceParse = false) =>`：参数会变，这条闸不该跟着漂）
    const start = SOURCE.search(/crumbRefreshRef\.current = \(/);
    expect(start, '找不到 crumbRefresh 入口').toBeGreaterThanOrEqual(0);
    const block = SOURCE.slice(start, start + 3000);
    expect(block).toMatch(/cursor\.lineCount >= LARGE_FILE_LINES[\s\S]{0,160}crumbLastRef\.current = null[\s\S]{0,60}apply\(\[\]\)/);
  });
});
