import { describe, expect, it } from 'vitest';
import {
  CONFLICT_CHOICES,
  buildFileOpsPlan,
  conflictNames,
  conflictQuestion,
  decideFileOps,
  keepBothName,
  opsResultSentence,
  splitBaseExt,
  type FileOpEntry,
  type FileOpsPlan,
  type FileOpsPlanInput,
} from '../src/ui/file-ops-plan';

/**
 * WS-13 2a 车 · 文件操作**计划层**判据（纯函数，零 IO）。
 *
 * 这一层的价值全在边界上：目录拖进自己里面、同名目标是个目录、源与目标分属两个根、
 * 源就是要粘进它的父目录——每一条都是一个会被点错的动作，故逐条单证。
 * 变异自检（把判据摘掉一条对应断言必红）逐条写在组注释里。
 */

const W = 'C:/work';
const PKG = `${W}/kojo/001 灵梦/包A`;

const f = (path: string): FileOpEntry => ({ path, isDir: false });
const d = (path: string): FileOpEntry => ({ path, isDir: true });

function plan(input: FileOpsPlanInput): FileOpsPlan {
  return buildFileOpsPlan(input);
}

/* ------------------------------ 基本形态 ------------------------------ */

describe('计划层 · 可执行与命名', () => {
  it('无撞名的复制：逐条 ready，落点 = 目标目录 + 原名，模式照传入', () => {
    const p = plan({
      sources: [f(`${PKG}/a.ERB`), f(`${PKG}/b.ERB`)],
      targetDir: `${PKG}/sub`,
      targetEntries: [],
      mode: 'copy',
    });
    expect(p.mode).toBe('copy');
    expect(p.items.map((i) => i.status)).toEqual(['ready', 'ready']);
    expect(p.items[0]?.to).toBe(`${PKG}/sub/a.ERB`);
    expect(p.items[0]?.actions).toEqual([]);
  });

  it('剪切 = move 模式；落点与复制同一算法', () => {
    const p = plan({ sources: [f(`${PKG}/a.ERB`)], targetDir: `${PKG}/sub`, targetEntries: [], mode: 'move' });
    expect(p.mode).toBe('move');
    expect(p.items[0]?.to).toBe(`${PKG}/sub/a.ERB`);
  });

  it('源集合里同一份东西写两次（大小写 / 分隔符不同）只处理一次', () => {
    const p = plan({
      sources: [f(`${PKG}/a.ERB`), f(`${PKG.replace(/\//g, '\\')}\\A.erb`)],
      targetDir: `${PKG}/sub`,
      targetEntries: [],
      mode: 'copy',
    });
    expect(p.items).toHaveLength(1);
  });

  it('读不出条目名的源 ⇒ rejected 并点名（不是一条空名字的操作）', () => {
    const p = plan({ sources: [f('')], targetDir: PKG, targetEntries: [], mode: 'copy' });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('读不出条目名称');
  });

  it('splitBaseExt：最后一个点开扩展名；开头的点与无扩展名都算名字', () => {
    expect(splitBaseExt('M_KOJO_K1.ERB', false)).toEqual({ base: 'M_KOJO_K1', ext: '.ERB' });
    expect(splitBaseExt('a.b.ERB', false)).toEqual({ base: 'a.b', ext: '.ERB' });
    expect(splitBaseExt('noext', false)).toEqual({ base: 'noext', ext: '' });
    expect(splitBaseExt('.gitignore', false)).toEqual({ base: '.gitignore', ext: '' });
    expect(splitBaseExt('sub.2', true)).toEqual({ base: 'sub.2', ext: '' });
  });

  it('keepBothName：从「名字 2.扩展名」起找空位，一路排到被占满为止', () => {
    expect(keepBothName('a.ERB', false, new Set(['a.erb']))).toBe('a 2.ERB');
    expect(keepBothName('a.ERB', false, new Set(['a.erb', 'a 2.erb']))).toBe('a 3.ERB');
    expect(keepBothName('a.ERB', false, new Set(['a 2.ERB']))).toBe('a 2.ERB'); // 2 没被占就拿 2
    // 入参 taken 是**归一键**（计划层给的是 `pkey` 之后的名字集合），故这里写小写
    expect(keepBothName('a.ERB', false, new Set(['a 2.erb']))).toBe('a 3.ERB');
    expect(keepBothName('sub', true, new Set(['sub']))).toBe('sub 2');
    expect(keepBothName('a.ERB', false, new Set())).toBe('a 2.ERB');
  });

  it('同一目录一次粘两份同名文件：自动改名不撞自己（第二份拿到 3）', () => {
    const p = plan({
      sources: [f(`${W}/x/a.ERB`), f(`${W}/y/a.ERB`)],
      targetDir: `${W}/t`,
      targetEntries: [f(`${W}/t/a.ERB`)],
      mode: 'copy',
    });
    expect(p.items.map((i) => i.renameTo)).toEqual([`${W}/t/a 2.ERB`, `${W}/t/a 3.ERB`]);
  });
});

/* ------------------------------ 非法源（变异自检的主战场） ------------------------------ */

describe('计划层 · 非法源逐条判掉', () => {
  it('① 目标目录就是源自己 ⇒ rejected（把文件夹放进自己里面）', () => {
    const p = plan({ sources: [d(PKG)], targetDir: PKG, targetEntries: [], mode: 'move' });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('不能粘贴进它自己里面');
  });

  it('①b 目标落在源的子树里 ⇒ rejected；摘掉这条判据本用例即红', () => {
    const p = plan({ sources: [d(PKG)], targetDir: `${PKG}/sub/deep`, targetEntries: [], mode: 'copy' });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('它自己的子目录');
  });

  it('①c 文件源没有子树，不会误吞进 ①b（同一目录的另一格照常 ready）', () => {
    const p = plan({ sources: [f(`${PKG}/a.ERB`)], targetDir: `${PKG}/sub`, targetEntries: [], mode: 'copy' });
    expect(p.items[0]?.status).toBe('ready');
  });

  it('② 源就在目标目录里（粘贴进它的父目录本身）⇒ rejected，并指向「创建副本」', () => {
    const p = plan({
      sources: [f(`${PKG}/a.ERB`)],
      targetDir: PKG,
      targetEntries: [f(`${PKG}/a.ERB`)],
      mode: 'move',
    });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('本来就在这一格里');
  });

  it('②b 同一情形在「创建副本」意图下是合法冲突（副本的本义就是同层）', () => {
    const p = plan({
      sources: [f(`${PKG}/a.ERB`)],
      targetDir: PKG,
      targetEntries: [f(`${PKG}/a.ERB`)],
      mode: 'copy',
      intent: 'duplicate',
    });
    expect(p.items[0]?.status).toBe('conflict');
    expect(p.items[0]?.renameTo).toBe(`${PKG}/a 2.ERB`);
    expect(p.mode).toBe('copy'); // 副本恒为复制，绝不把源搬走
  });

  it('②c「创建副本」反过来要求源就在这一格里：不在就判掉并说清怎么选', () => {
    const p = plan({
      sources: [f(`${W}/elsewhere/a.ERB`)],
      targetDir: PKG,
      targetEntries: [],
      mode: 'copy',
      intent: 'duplicate',
    });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('不在这一格');
  });

  it('③ 跨根：源与目标不同根 ⇒ rejected；同根照常放行', () => {
    const roots = [W, 'C:/author'];
    const p = plan({
      sources: [f('C:/author/旧作.ERB')],
      targetDir: `${W}/kojo`,
      targetEntries: [],
      mode: 'copy',
      roots,
    });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('同一个文件夹根');
    const same = plan({ sources: [f(`${W}/a.ERB`)], targetDir: `${W}/kojo`, targetEntries: [], mode: 'copy', roots });
    expect(same.items[0]?.status).toBe('ready');
  });

  it('③b 嵌套根取最长前缀：附加根在项目根之下时算同一个根', () => {
    const p = plan({
      sources: [f(`${W}/extra/a.ERB`)],
      targetDir: `${W}/kojo`,
      targetEntries: [],
      mode: 'copy',
      roots: [W, `${W}/extra`],
    });
    expect(p.items[0]?.status).toBe('ready');
  });

  it('③c 落点不在任何根里 ⇒ 逐条 rejected 说清楚（不给"写了再说"的机会）', () => {
    const p = plan({
      sources: [f(`${W}/a.ERB`)],
      targetDir: 'D:/somewhere/else',
      targetEntries: [],
      mode: 'copy',
      roots: [W],
    });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('落点不在项目或工作区');
  });

  it('③d 没给根清单 ⇒ 不做跨根判定（旧消费方零改动）', () => {
    const p = plan({ sources: [f('D:/x/a.ERB')], targetDir: `${W}/kojo`, targetEntries: [], mode: 'copy' });
    expect(p.items[0]?.status).toBe('ready');
  });

  it('④ 同名目标是目录、源是文件 ⇒ rejected（不是冲突，没有"覆盖"可言）', () => {
    const p = plan({
      sources: [f(`${W}/a.ERB`)],
      targetDir: `${W}/t`,
      targetEntries: [d(`${W}/t/a.ERB`)],
      mode: 'copy',
    });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('是一个文件夹');
  });

  it('④b 反过来（同名目标是文件、源是目录）同样 rejected', () => {
    const p = plan({
      sources: [d(`${W}/sub`)],
      targetDir: `${W}/t`,
      targetEntries: [f(`${W}/t/sub`)],
      mode: 'copy',
    });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('是一个文件');
  });

  it('没有落点目录 ⇒ 逐条 rejected，一条都不落', () => {
    const p = plan({ sources: [f(`${W}/a.ERB`)], targetDir: '', targetEntries: [], mode: 'copy' });
    expect(p.items[0]?.status).toBe('rejected');
    expect(p.items[0]?.reason).toContain('没有明确的落点目录');
  });
});

/* ------------------------------ 撞名与四种应对 ------------------------------ */

describe('计划层 · 撞名的四种应对', () => {
  const withConflict = (mode: 'copy' | 'move', isDir: boolean): FileOpsPlan =>
    plan({
      sources: [isDir ? d(`${W}/s/sub`) : f(`${W}/s/a.ERB`)],
      targetDir: `${W}/t`,
      targetEntries: isDir ? [d(`${W}/t/sub`)] : [f(`${W}/t/a.ERB`)],
      mode,
    });

  it('文件撞名 ⇒ conflict，可选：跳过 / 覆盖 / 保留两者，且带自动改名落点', () => {
    const p = withConflict('copy', false);
    expect(p.items[0]?.status).toBe('conflict');
    expect(p.items[0]?.actions).toEqual(['skip', 'overwrite', 'keepBoth']);
    expect(p.items[0]?.renameTo).toBe(`${W}/t/a 2.ERB`);
  });

  it('目录撞名 ⇒ conflict，但**不给覆盖**（整目录覆盖是另一把大刀）', () => {
    const p = withConflict('copy', true);
    expect(p.items[0]?.actions).toEqual(['skip', 'keepBoth']);
  });

  it('目录撞名的占用判定按归一键：写法不同（大小写 / 分隔符）照样算冲突', () => {
    const p = plan({
      sources: [f(`${W}/s/A.ERB`)],
      targetDir: `${W}/t`,
      targetEntries: [f(`${W}\\t\\a.erb`)],
      mode: 'copy',
    });
    expect(p.items[0]?.status).toBe('conflict');
  });

  it('决定=跳过：冲突项进 skipped 并点名，ready 项照落', () => {
    const p = plan({
      sources: [f(`${W}/s/a.ERB`), f(`${W}/s/b.ERB`)],
      targetDir: `${W}/t`,
      targetEntries: [f(`${W}/t/a.ERB`)],
      mode: 'copy',
    });
    const r = decideFileOps(p, 'skip');
    expect(r.abort).toBe(false);
    expect(r.runs.map((x) => x.to)).toEqual([`${W}/t/b.ERB`]);
    expect(r.skipped).toEqual(['a.ERB']);
  });

  it('决定=覆盖：文件冲突项落原名并标 overwrite', () => {
    const r = decideFileOps(withConflict('copy', false), 'overwrite');
    expect(r.runs).toEqual([{ from: `${W}/s/a.ERB`, to: `${W}/t/a.ERB`, isDir: false, mode: 'copy', overwrite: true }]);
  });

  it('决定=覆盖 + 目录冲突 ⇒ 进 refused 并说清原因，**不静默降级**成跳过或改名', () => {
    const r = decideFileOps(withConflict('copy', true), 'overwrite');
    expect(r.runs).toHaveLength(0);
    expect(r.skipped).toHaveLength(0);
    expect(r.refused[0]?.reason).toContain('文件夹不做整目录覆盖');
  });

  it('决定=保留两者：落点换成自动改名那一份，overwrite 关', () => {
    const r = decideFileOps(withConflict('move', false), 'keepBoth');
    expect(r.runs).toEqual([
      { from: `${W}/s/a.ERB`, to: `${W}/t/a 2.ERB`, isDir: false, mode: 'move', overwrite: false },
    ]);
  });

  it('决定=全部取消 ⇒ abort，一条都不落', () => {
    const r = decideFileOps(withConflict('copy', false), 'cancel');
    expect(r).toEqual({ abort: true, runs: [], skipped: [], refused: [] });
  });

  it('非法源在任何决定下都进 refused（铁律 4：不许因为选了"跳过"就让它不出现在回执里）', () => {
    const p = plan({ sources: [d(PKG)], targetDir: `${PKG}/sub`, targetEntries: [], mode: 'copy' });
    for (const decision of ['skip', 'overwrite', 'keepBoth'] as const) {
      const r = decideFileOps(p, decision);
      expect(r.runs).toHaveLength(0);
      expect(r.refused).toHaveLength(1);
    }
  });

  it('自动改名也没位置 ⇒ 摘掉 keepBoth 选项并给出原因，决定=保留两者时进 refused', () => {
    const taken: FileOpEntry[] = [f(`${W}/t/a.ERB`)];
    for (let n = 2; n <= 99; n++) taken.push(f(`${W}/t/a ${n}.ERB`));
    const p = plan({ sources: [f(`${W}/s/a.ERB`)], targetDir: `${W}/t`, targetEntries: taken, mode: 'copy' });
    expect(p.items[0]?.actions).toEqual(['skip', 'overwrite']);
    expect(p.items[0]?.renameTo).toBeUndefined();
    expect(p.items[0]?.reason).toContain('全被占着');
    const r = decideFileOps(p, 'keepBoth');
    expect(r.refused[0]?.name).toBe('a.ERB');
  });

  it('目标目录现状取不到（空清单）⇒ 一律先判 ready，竞态由落地的独占创建兜住', () => {
    const p = plan({ sources: [f(`${W}/s/a.ERB`)], targetDir: `${W}/t`, targetEntries: [], mode: 'copy' });
    expect(p.items[0]?.status).toBe('ready');
    expect(decideFileOps(p, 'keepBoth').runs).toHaveLength(1);
  });
});

/* ------------------------------ 上屏文案 ------------------------------ */

describe('计划层 · 问句与回执（人话，无内部术语）', () => {
  it('冲突问句点名撞名的条目，并预告文件夹不给覆盖', () => {
    const p = plan({
      sources: [f(`${W}/s/a.ERB`), d(`${W}/s/sub`)],
      targetDir: `${W}/t`,
      targetEntries: [f(`${W}/t/a.ERB`), d(`${W}/t/sub`)],
      mode: 'copy',
    });
    const q = conflictQuestion(p);
    expect(conflictNames(p)).toEqual(['a.ERB', 'sub']);
    expect(q).toContain('「t」里已经有同名的东西');
    expect(q).toContain('a.ERB、sub');
    expect(q).toContain('文件夹不做整目录覆盖');
    expect(q).not.toContain('writablePaths');
  });

  it('剪切与复制的动词分家（读到的就是刚做的那件事）', () => {
    const p = plan({ sources: [f(`${W}/s/a.ERB`)], targetDir: `${W}/t`, targetEntries: [f(`${W}/t/a.ERB`)], mode: 'move' });
    expect(conflictQuestion(p)).toContain('移过来');
  });

  it('回执：成功 N / 跳过 M / 失败 K，失败逐条点名带原因', () => {
    const s = opsResultSentence({
      mode: 'copy',
      targetDir: `${W}/t`,
      done: 2,
      skipped: ['b.ERB'],
      failed: [{ name: 'c.ERB', reason: '目标已存在' }],
    });
    expect(s).toBe('已把 2 项复制到「t」，跳过 1 项（b.ERB），没成的 1 项：c.ERB（目标已存在）');
  });

  it('回执：零成功零失败时说那一句"没有落下任何东西"的形态，不写"成功 0 项"就完事', () => {
    const s = opsResultSentence({ mode: 'move', targetDir: `${W}/t`, done: 0, skipped: [], failed: [] });
    expect(s).toContain('已把 0 项移到「t」');
  });

  it('回执：副本意图说"做出 N 份副本"', () => {
    const s = opsResultSentence({ mode: 'copy', intent: 'duplicate', targetDir: `${W}/t`, done: 1, skipped: [], failed: [] });
    expect(s).toContain('已在「t」里做出 1 份副本');
  });

  it('冲突问句的四个选项在册，且顺序 = 保留两者 / 覆盖 / 跳过 / 全部取消', () => {
    expect(CONFLICT_CHOICES.map((c) => c.action)).toEqual(['keepBoth', 'overwrite', 'skip', 'cancel']);
  });

  it('撞名超过三项：问句收成「前三个 等 N 项」，不铺满一屏', () => {
    const p = plan({
      sources: [1, 2, 3, 4, 5].map((n) => f(`${W}/s/${n}.ERB`)),
      targetDir: `${W}/t`,
      targetEntries: [1, 2, 3, 4, 5].map((n) => f(`${W}/t/${n}.ERB`)),
      mode: 'copy',
    });
    expect(conflictQuestion(p)).toContain('等 5 项');
  });
});
