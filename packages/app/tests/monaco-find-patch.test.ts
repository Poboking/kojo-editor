import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * FIND-STATE-PERSIST A（源取证半边）：monaco vendor 补丁**装上了没有**。
 *
 * 反向自证（口径）：删掉 `pnpm-workspace.yaml` 的 `patchedDependencies` 后重装，
 * 本文件前两枚断言必红 ⇒ "补丁没打上就静默退化"这条事故有闸拦着。
 * 行为半边在 `monaco-find-patch-behavior.test.ts`（要 happy-dom 的真浏览器全局）。
 *
 * **PITFALLS 116**：hoisted 布局（`--config.node-linker=hoisted`）会把包提升到仓库根、
 * 砍掉 `packages/app/node_modules/monaco-editor` 这枚符号链接 ⇒ 写死单一路径的 vendor
 * 取证测试会假红。本文件的解析器**先试 app 局部、再退仓库根**，两条都不在才红。
 */

const FIND_JS = 'editor/contrib/find/browser/findController.js';
const API_DTS = 'editor/editor.api.d.ts';

/** 仓库根：从 cwd 往上找 pnpm-workspace.yaml（vitest 起在根，但被单独调用时未必） */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(`${dir}/pnpm-workspace.yaml`) || existsSync(`${dir}\\pnpm-workspace.yaml`)) return dir;
    const parent = `${dir}/..`;
    if (dir === parent) break;
    dir = parent;
  }
  return process.cwd();
}

/** 已安装 monaco-editor 的 esm/vs 目录（app 局部优先，退回仓库根 = hoisted 布局） */
function monacoEsmVs(): string {
  for (const base of [`${repoRoot()}/packages/app/node_modules`, `${repoRoot()}/node_modules`]) {
    const dir = `${base}/monaco-editor/esm/vs`;
    if (existsSync(dir)) return dir;
  }
  throw new Error(`monaco-editor 产物不可达（app 局部与仓库根都找不到）：pnpm install 没跑？`);
}

const readVendor = (rel: string): string => readFileSync(`${monacoEsmVs()}/${rel}`, 'utf8');

describe('vendor 补丁已生效：安装产物里必须真的带着那三枚方法与那三个类型', () => {
  it('JS 侧：CommonFindController 上公开 set/getFindStateSilently + onDidChangeFindState，且不走 _start', () => {
    const src = readVendor(FIND_JS);
    expect(src).toContain('setFindStateSilently(state)');
    expect(src).toContain('getFindStateSilently()');
    expect(src).toContain('onDidChangeFindState(listener)');
    // 静默语义的源码级钉子：补丁体只准调 `_state.change`，一次都不许碰 `_start(`（那才是开框/夺焦的路）
    const patch = src.slice(src.indexOf('BEGIN kojo-editor vendor patch'), src.indexOf('END kojo-editor vendor patch'));
    expect(patch).toContain('this._state.change(');
    // 一次都不许调 `_start`（那才是开框/夺焦/吃 seed 的路）；注释里提它不算违规，只拦真调用
    expect(patch).not.toContain('this._start(');
    expect(patch).not.toContain('super._start(');
    expect(patch).toContain('}, false, false)'); // updateHistory=false ⇒ 不污染查找历史上拉
  });

  it('DTS 侧：editor.api.d.ts 公开 IFindController / IFindStateSnapshot，宿主无需 as any', () => {
    const dts = readVendor(API_DTS);
    expect(dts).toContain('export interface IFindController extends IEditorContribution');
    expect(dts).toContain('export interface IFindStateSnapshot');
    expect(dts).toMatch(/setFindStateSilently\(state: IFindStateSnapshot\): void/);
    expect(dts).toMatch(/getFindStateSilently\(\): IFindStateSnapshot/);
  });

  it('补丁链本体在仓里（patches/ + pnpm 11 认的 pnpm-workspace.yaml，且 lockfile 带 patch_hash）', () => {
    const root = repoRoot().replace(/\\/g, '/');
    expect(existsSync(`${root}/patches/monaco-editor@0.57.0.patch`)).toBe(true);
    const ws = readFileSync(`${root}/pnpm-workspace.yaml`, 'utf8');
    expect(ws).toContain('patchedDependencies');
    expect(ws).toContain('patches/monaco-editor@0.57.0.patch');
    // release.yml 用 --frozen-lockfile：lockfile 不记 patch_hash 就等于发版工作流打死
    const lock = readFileSync(`${root}/pnpm-lock.yaml`, 'utf8');
    expect(lock).toMatch(/patchedDependencies:\s*\n\s*monaco-editor@0\.57\.0:/);
    expect(lock).toContain('patch_hash=');
  });
});

describe('宿主接线的次序与口径（源码级钉子；行为钉子在同名 behavior 文件）', () => {
  it('find-state-sync 里一处 as any 都不许有——补丁的全部增量就是类型安全', () => {
    const raw = readFileSync(fileURLToPath(new URL('../src/monaco/find-state-sync.ts', import.meta.url)), 'utf8');
    // 只看代码：文件头那段说明里写着"没有一处 as any"，注释不算违规
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bas any\b/);
    expect(code).toContain('getContribution<Monaco.editor.IFindController>');
    // 未打补丁 ⇒ 三枚方法任一缺失就整拍跳过（不许假装成功）
    expect(code).toContain('return null');
  });

  it('读回点排在 ed.setModel 之后（否则 monaco 换 model 那拍会把放回的重置掉）', () => {
    const pane = readFileSync(fileURLToPath(new URL('../src/ui/EditorPane.tsx', import.meta.url)), 'utf8');
    const setModel = pane.indexOf('ed.setModel(entry.model);');
    const restore = pane.indexOf('writeFindState(ed, persistedFind)');
    expect(setModel).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(setModel);
    // 写存点只有一处（热点文件：接线面积最小化的钉子）
    expect(pane.match(/readFindState\(ed\)/g)?.length).toBe(1);
    expect(pane.match(/writeFindState\(ed, persistedFind\)/g)?.length).toBe(1);
    // 同会话切回走 viewStatesRef 命中分支，压根不进 applyPersistedView ⇒ 读回点必须在 if/else 之外
    expect(pane.indexOf('if (vs) ed.restoreViewState(vs);')).toBeLessThan(restore);
  });

  it('变更订阅挂在 use-monaco-instance 的视图状态订阅组里，并随卸载释放', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/ui/editor-pane/use-monaco-instance.ts', import.meta.url)),
      'utf8',
    );
    expect(src).toContain('subscribeFindState(ed, snapshotActiveView)');
    expect(src).toContain('viewFindSub?.dispose()');
  });
});
