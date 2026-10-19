import { describe, expect, it } from 'vitest';
import { pathKey } from '@kojo/plugin-api';
import { workspaceChangeOf } from '../src/watch-scope';

/**
 * 工作区外部改动的归属判定（2026-10-13 看板 HK-6）。
 *
 * 判据只有一条形状：**"某个目录的内容变了" ≡ 改动条目的父目录要重列**。
 * 这条判错有两个方向的坏结果，都不轻：
 * - 判多了（一路向上全刷 / 游戏目录的改动也刷）⇒ 作者每存一次盘，面板重列一堆目录；
 * - 判少了（认不出父目录 / 大小写反斜杠不归一）⇒ 外面丢进来的文件永远不出现，
 *   而这正是本批要修的那个 bug 本身。
 *
 * 根是一个**列表**（2026-10-14 自选项目位置批）：默认根之外还可能有作者自选的落点根，
 * 只认单根的判定会让自选根里的 `.kojo` 改动既不重列包目录也不刷新项目列表。
 *
 * 零游戏知识：只认路径形状，不认 `.ERB` / `.kojo` / 口上目录。
 */

const ROOT = 'C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces';
const PROJ = `${ROOT}/w1-abc`;
const PKG = `${PROJ}/东方口上合集-灵梦 v1.0`;

describe('workspaceChangeOf', () => {
  it('包里的文件变了 → 只重列那个包目录', () => {
    const r = workspaceChangeOf(`${PKG}/事件.kojo`, [ROOT]);
    expect(r.projectListChanged).toBe(false);
    // 断言用 pathKey 而不是字符串等值：dirname() 会按 Windows 风格出反斜杠，
    // 而本文件的常量写成斜杠形态——**形态不是本函数的契约，指向同一个目录才是**。
    // （接线侧正是靠 pathKey 去对缓存键的，见 plugin.ts 的 file.changed 订阅。）
    expect(pathKey(r.dirToRefresh!)).toBe(pathKey(PKG));
  });

  it('再深一层的子目录 → 重列它的**直接**父目录，不是一路向上全刷', () => {
    const deep = `${PKG}/素材/立绘.png`;
    expect(pathKey(workspaceChangeOf(deep, [ROOT]).dirToRefresh!)).toBe(pathKey(`${PKG}/素材`));
    expect(workspaceChangeOf(deep, [ROOT]).projectListChanged).toBe(false);
  });

  it('项目清单自己变了 → 重列该项目的目录，项目列表不重拉（列表看的是根的直接子层）', () => {
    const r = workspaceChangeOf(`${PROJ}/workspace.json`, [ROOT]);
    expect(r.projectListChanged).toBe(false);
    expect(pathKey(r.dirToRefresh!)).toBe(pathKey(PROJ));
  });

  it('直接落在工作区根的一层 → 项目列表要重拉（项目被建/删/改名）', () => {
    const r = workspaceChangeOf(`${ROOT}/新作品`, [ROOT]);
    expect(pathKey(r.dirToRefresh!)).toBe(pathKey(ROOT));
    expect(r.projectListChanged).toBe(true);
  });

  it('游戏目录那半边的改动与面板无关（监视根同时含项目根）', () => {
    expect(workspaceChangeOf('C:/Game/eratw/ERB/口上・メッセージ関連/個人口上/001 灵梦/x.ERB', [ROOT])).toEqual({
      dirToRefresh: null,
      projectListChanged: false,
    });
  });

  it('前缀长得像但不是子目录 → 不算工作区内（不能拿字符串前缀当路径判据）', () => {
    expect(workspaceChangeOf(`${ROOT}-备份/w1/x.kojo`, [ROOT]).dirToRefresh).toBeNull();
  });

  it('无平台数据目录（浏览器开发壳，空根列表）→ 一律不响应', () => {
    expect(workspaceChangeOf(`${PKG}/事件.kojo`, [])).toEqual({
      dirToRefresh: null,
      projectListChanged: false,
    });
  });

  it('Windows 实况：反斜杠与大小写混用仍认得同一个根', () => {
    const winRoot = 'C:\\Users\\dev\\AppData\\Roaming\\dev.kojo.editor\\workspaces';
    const winPkg = PKG.replace(/\//g, '\\');
    const r = workspaceChangeOf(`${winPkg}\\事件.kojo`, [winRoot]);
    expect(r.projectListChanged).toBe(false);
    // 父目录按统一形态可比（大小写与分隔符折叠），接线侧才认得出"就是缓存里那个目录"
    expect(r.dirToRefresh).not.toBeNull();
    expect(pathKey(r.dirToRefresh!)).toBe(pathKey(winPkg));
    // 根的直接子层：反斜杠写法也要认得出"项目列表变了"
    expect(workspaceChangeOf(`${winRoot}\\w1-abc`, [winRoot]).projectListChanged).toBe(true);
  });

  /* ---- 多根（作者自选项目位置） ---- */

  const EXTRA = 'D:/作品';
  const EXTRA_PROJ = `${EXTRA}/p-ext`;
  const EXTRA_PKG = `${EXTRA_PROJ}/东方口上合集-灵梦 v1.0`;

  it('自选根里的包目录变了 → 重列那个根下的包目录（单根判定会判成工作区外而整块不响应）', () => {
    const r = workspaceChangeOf(`${EXTRA_PKG}/事件.kojo`, [ROOT, EXTRA]);
    expect(r.projectListChanged).toBe(false);
    expect(pathKey(r.dirToRefresh!)).toBe(pathKey(EXTRA_PKG));
  });

  it('自选根的直接子层变了 → 项目列表要重拉（父目录对着**命中的那个根**比，不是默认根）', () => {
    const r = workspaceChangeOf(`${EXTRA}/新作品`, [ROOT, EXTRA]);
    expect(pathKey(r.dirToRefresh!)).toBe(pathKey(EXTRA));
    expect(r.projectListChanged).toBe(true);
  });

  it('默认根仍然照常命中（多根不改变原有行为）', () => {
    expect(pathKey(workspaceChangeOf(`${PKG}/事件.kojo`, [ROOT, EXTRA]).dirToRefresh!)).toBe(pathKey(PKG));
  });

  it('两个根互为前缀 → 按**最深**那个根定位（否则刷新的目录指错一层）', () => {
    const NESTED = `${EXTRA}/子库`;
    const pkgUnderNested = `${NESTED}/p2/东方口上合集-灵梦 v2.0`;
    // 深层包里的文件：父目录是包目录（两条根都不等），关键是深根下的项目清单
    const inNested = workspaceChangeOf(`${pkgUnderNested}/事件.kojo`, [EXTRA, NESTED]);
    expect(pathKey(inNested.dirToRefresh!)).toBe(pathKey(pkgUnderNested));
    expect(inNested.projectListChanged).toBe(false);
    // 深根的直接子层：按浅根算的话 dirname 是 `D:\作品\子库` ≠ 浅根 ⇒ 漏判项目列表变化
    const atNestedRoot = workspaceChangeOf(`${NESTED}/新作品`, [EXTRA, NESTED]);
    expect(atNestedRoot.projectListChanged).toBe(true);
    // 深根目录自己变了：命中的是深根（相等即命中），其父目录不算任何根的直接子层
    expect(workspaceChangeOf(`${EXTRA}/子库`, [EXTRA, NESTED]).projectListChanged).toBe(false);
  });

  it('邻居目录（根名加后缀）在多根下仍不误判', () => {
    expect(workspaceChangeOf(`${EXTRA}-备份/p/x.kojo`, [ROOT, EXTRA]).dirToRefresh).toBeNull();
  });
});
