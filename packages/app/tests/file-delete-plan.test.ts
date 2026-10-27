import { describe, expect, it } from 'vitest';
import {
  DELETE_LIST_LIMIT,
  TRASH_WHERE,
  buildDeletePlan,
  deleteBatchConfirmText,
  deleteBatchReceiptText,
  undoDeleteReceiptText,
  undoUnavailableText,
  type DeleteEntry,
} from '../src/ui/file-delete-plan';

/**
 * WS-13 2c 车 · **删除判据层**（零 IO，全部边界靠单证）。
 *
 * 这一层管三件会被点错的事：
 * ①父子同批（子不许再发一次删除动作，但必须点名"随谁走"）；
 * ②两种写法算同一条（多发一次 `removeFile` 会得到假失败）；
 * ③删不了的那些（读不出名字 / 只读范围）不许从确认框与回执里消失。
 * 外加文案纪律：**逐条点名**、目录说清刀多大、规模读不到就不猜数字、
 * 删除的去向说成回收站（旧版"此操作无法撤销"与事实相反）。
 *
 * **单条与整批是同一条腿**（收腿批）：`n = 1` 没有任何特判，旧 `file-tree-ops.deleteConfirmText`
 * 那组判据的实质（刀多大 + 刀落到哪）在下面 `只勾一枚时` 那一组里逐条活着。
 */

const DIR = 'C:/koa/001/包A';
const SUB = 'C:/koa/001/包A/子层';
const F1 = `${DIR}/a.ERB`;
const F2 = `${DIR}/b.ERB`;
const F3 = 'C:/koa/001/散落.ERB';
/** 不在任何被选目录里的文件（"文件与目录各计其数"要用它，F1 是被包A 包住的） */
const FAR = 'C:/koa/002/x.ERB';
const READONLY = '这一处在只读范围内，不能删除——要先在「只读」徽章那里批准写权限。';

const f = (path: string): DeleteEntry => ({ path, isDir: false });
const d = (path: string): DeleteEntry => ({ path, isDir: true });

describe('buildDeletePlan · 判决', () => {
  it('文件与目录各计其数，顺序随入参（作者眼里的"这几个东西"）', () => {
    const plan = buildDeletePlan([f(F3), d(DIR), f(FAR)]);
    expect(plan.fileCount).toBe(2);
    expect(plan.dirCount).toBe(1);
    expect(plan.targets.map((t) => t.name)).toEqual(['散落.ERB', '包A', 'x.ERB']);
  });

  it('同一目录的两种写法 ⇒ 一条删除动作都不许多发（归一去重）', () => {
    const plan = buildDeletePlan([f(F1), f(F1.replace('/001/', '\\001\\'))]);
    expect(plan.targets).toHaveLength(1);
    expect(plan.items).toHaveLength(1);
  });

  it('大小写两种写法也算同一条（Windows 判据）', () => {
    const plan = buildDeletePlan([f(F1), f(F1.toUpperCase())]);
    expect(plan.targets).toHaveLength(1);
  });

  it('父子同批 ⇒ 子折叠成 carried，且点名"随谁走"（不单独发删除）', () => {
    const plan = buildDeletePlan([d(DIR), f(F1), f(F2)]);
    expect(plan.targets.map((t) => t.path)).toEqual([DIR]);
    expect(plan.carried.map((c) => c.name)).toEqual(['a.ERB', 'b.ERB']);
    expect(plan.carried[0]!.carriedBy).toBe('包A');
  });

  it('孙随**最近的**被删祖先（点名一层层读得下去，删除动作仍只有一条）', () => {
    const plan = buildDeletePlan([d(DIR), d(SUB), f(`${SUB}/c.ERB`)]);
    expect(plan.targets.map((t) => t.path)).toEqual([DIR]);
    expect(plan.carried.find((c) => c.name === '子层')!.carriedBy).toBe('包A');
    expect(plan.carried.find((c) => c.name === 'c.ERB')!.carriedBy).toBe('子层');
  });

  it('目录不随自己走（父目录与子目录写法相等时不许把自己吞了）', () => {
    const plan = buildDeletePlan([d(DIR), d(`${DIR}/`)]);
    expect(plan.targets).toHaveLength(1);
    expect(plan.carried).toHaveLength(0);
  });

  it('读不出名字的条目进 rejected 并带人话原因（不许静默消失）', () => {
    const plan = buildDeletePlan([f(''), f(`${DIR}/.`), f(`${DIR}/..`), f(F1)]);
    expect(plan.rejected.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(plan.targets.map((t) => t.name)).toEqual(['a.ERB']);
    expect(plan.rejected[0]!.reason).toContain('读不出条目名称');
  });

  it('`blockedOf` 判下来的条目进 rejected：仍在点名列里，但一条 IO 都不会发', () => {
    const plan = buildDeletePlan([f(F1), f(F3)], { blockedOf: (p) => (p === F3 ? READONLY : null) });
    expect(plan.targets.map((t) => t.path)).toEqual([F1]);
    expect(plan.rejected[0]!.reason).toBe(READONLY);
  });

  it('目录连带规模已知 ⇒ 合计得出；有一份读不到 ⇒ 合计是 null（不拿半个数冒充总数）', () => {
    const B2 = 'C:/koa/002/包B';
    const known = buildDeletePlan([d(DIR), d(B2)], { sizeOf: () => ({ files: 3, dirs: 1 }) });
    expect(known.carriedFileTotal).toBe(6);
    const unknown = buildDeletePlan([d(DIR), d(B2)], { sizeOf: (p) => (p === DIR ? { files: 3, dirs: 1 } : undefined) });
    expect(unknown.carriedFileTotal).toBeNull();
  });

  it('被折叠的子目录不重复计入合计（父那一趟已经把它整棵算进去了）', () => {
    const plan = buildDeletePlan([d(DIR), d(SUB)], { sizeOf: () => ({ files: 3, dirs: 0 }) });
    expect(plan.dirCount).toBe(1);
    expect(plan.carriedFileTotal).toBe(3);
  });
});

describe('deleteBatchConfirmText · 逐条点名', () => {
  it('文件数 / 目录数各说清，且每一条名字都在', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([f(F3), f(FAR), d(DIR)], { sizeOf: () => ({ files: 2, dirs: 0 }) }));
    expect(text).toContain('确定删除这 3 项吗？（2 个文件、1 个文件夹）');
    expect(text).toContain('「散落.ERB」');
    expect(text).toContain('「x.ERB」');
    expect(text).toContain('「包A」');
  });

  it('目录那条说人话："这条会带走整个文件夹，里面有 N 个文件、M 个子文件夹"', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([d(DIR)], { sizeOf: () => ({ files: 12, dirs: 3 }) }));
    expect(text).toContain('这条会带走整个文件夹，里面有 12 个文件、3 个子文件夹');
  });

  it('规模读不出来 ⇒ 不猜数字，警示语保留', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([d(DIR)]));
    expect(text).toContain('里面的全部内容（含子文件夹）都会一起走');
    expect(text).not.toMatch(/里面有 \d+ 个文件/);
  });

  it('随目录一起走的那几条照旧点名（写明"随谁走、也随谁回来"）', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([d(DIR), f(F1)], { sizeOf: () => ({ files: 1, dirs: 0 }) }));
    expect(text).toContain('这些不单独删除，会随上面的文件夹一起走：a.ERB（在「包A」里，随它一起走、也随它一起回来）');
  });

  it('删不了的（只读那一档）在确认框里就说出名字与去处', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([f(F1), f(F3)], { blockedOf: (p) => (p === F3 ? READONLY : null) }));
    expect(text).toContain('这几条删不了，会原样留下：散落.ERB');
    expect(text).toContain('只读范围内');
  });

  it('一条都发不出去时不假装能确认：说清没有可删的条目 + 是哪几条被挡下', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([f(F3)], { blockedOf: () => READONLY }));
    expect(text).toContain('这一批里没有可以直接删除的条目');
    expect(text).toContain('散落.ERB');
    expect(text).toContain('一个字节都没动');
  });

  it('超出点名单上限 ⇒ 如实报"另有 K 项没列出、这一批会一起删除"（不静默截断）', () => {
    const many = Array.from({ length: DELETE_LIST_LIMIT + 5 }, (_, i) => f(`${DIR}/f${i}.ERB`));
    const text = deleteBatchConfirmText(buildDeletePlan(many));
    expect(text).toContain(`确定删除这 ${DELETE_LIST_LIMIT + 5} 项吗？`);
    expect(text).toContain(`…另有 5 项没有列出——这一批会一起删除。`);
    expect(text).toContain(`${DELETE_LIST_LIMIT}. 文件「f${DELETE_LIST_LIMIT - 1}.ERB」`);
    expect(text).not.toContain(`「f${DELETE_LIST_LIMIT}.ERB」`);
  });

  it('去向那句必须说回收站与应用数据目录，且"无法撤销"那句老话一个字都不许留', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([f(F1)]));
    expect(text).toContain('回收站');
    expect(text).toContain('应用数据目录');
    expect(text).toContain('30 天');
    expect(text).toContain('撤销这次删除');
    expect(text).not.toContain('无法撤销');
  });
});

/* ------------------------------ 只勾一枚：同一条腿、同一种形态 ------------------------------ */

/**
 * 旧版这里站着第二条腿（`file-tree-ops.deleteConfirmText` + `window.confirm`），按勾选集大小分档。
 * 收腿之后那一组判据**没有消失，是搬到这里来活**：下面三条逐条对应旧断言的实质——
 * ①刀多大（目录报 N、读不到 N 时警示语不许跟着退场）、②刀落到哪（回收站 + 「文件历史」）、
 * ③"无法撤销"那句与事实相反的老话不许回来。加上一条新的：**单条也走逐项点名**，
 * 于是"勾一枚"与"勾二十枚"是同一份文案的两个长度，不是两套 UI。
 */
describe('只勾一枚时 · 与整批共用同一条确认判据（旧单条腿的实质在这里活着）', () => {
  it('单条文件：点名到文件名 + 说清去回收站（不是永久删）+ 从「文件历史」找回；文件不背目录的量级警示', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([f(F3)]));
    expect(text).toContain('散落.ERB');
    expect(text).toContain('回收站');
    expect(text).toContain('文件历史');
    expect(text).not.toContain('文件夹'); // 文件不用背目录的量级警示（旧判据原样搬过来）
    expect(text).not.toContain('无法撤销');
  });

  it('单条目录 + 现算成功：刀多大要说出口（N 个文件、M 个子文件夹）', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([d(DIR)], { sizeOf: () => ({ files: 42, dirs: 3 }) }));
    expect(text).toContain('「包A」');
    expect(text).toContain('42');
    expect(text).toContain('回收站');
  });

  it('单条目录 + 现算失败：数字退场，但「全部内容」的警示语必须保留，也不许漏出 undefined', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([d(DIR)]));
    expect(text).not.toContain('undefined');
    expect(text).toContain('全部内容');
    expect(text).toContain('回收站');
  });

  it('一项也是"一项一项点名"：编号行存在，不是把名字塞进一句光秃秃的问句', () => {
    const text = deleteBatchConfirmText(buildDeletePlan([f(F3)]));
    expect(text.split('\n')[1]).toBe('1. 文件「散落.ERB」');
    // 与两条那一批同构：同一句抬头形态 + 同一份去路收尾
    const two = deleteBatchConfirmText(buildDeletePlan([f(F3), f(FAR)]));
    expect(text.split('\n')[0]).toMatch(/^确定删除这 \d+ 项吗？（\d+ 个文件）$/);
    expect(two.split('\n')[0]).toMatch(/^确定删除这 \d+ 项吗？（\d+ 个文件）$/);
    // 收尾句同构，只允许量词随条数走（勾一枚时说"这一项"，不许说"这一批"）
    expect(text.split('\n').at(-1)).toBe(two.split('\n').at(-1)!.replace('这一批', '这一项'));
    expect(text.split('\n').at(-1)).toContain('这一项会移进');
    expect(text.split('\n').at(-1)).not.toContain('这一批');
  });

  it('单条走的就是整批那份计划（没有"一条特判"的第二套结构）：targets/carried/rejected 同一形状', () => {
    const one = buildDeletePlan([f(F3)]);
    expect(one.targets).toHaveLength(1);
    expect(one.fileCount).toBe(1);
    expect(one.dirCount).toBe(0);
    expect(one.carriedFileTotal).toBe(0);
  });
});

describe('deleteBatchReceiptText · 东西去哪了、怎么拿回来', () => {
  it('成功那句带种类计数与逐条名字，并给出两条找回的路', () => {
    const text = deleteBatchReceiptText({
      done: [{ name: 'a.ERB', isDir: false }, { name: 'b.csv', isDir: false }, { name: '包A', isDir: true }],
      trashReadable: true,
    });
    expect(text).toContain('已删除 3 项（2 个文件、1 个文件夹）：「a.ERB」、「b.csv」、「包A」');
    expect(text).toContain('按「撤销这次删除」放回原位');
    expect(text).toContain('「文件历史」里逐条找回');
  });

  it('随目录走的那些另行交代（它们不单独占一份回收站条目）', () => {
    const text = deleteBatchReceiptText({ done: [{ name: '包A', isDir: true }], carriedCount: 4, trashReadable: true });
    expect(text).toContain('另有 4 项本来就在被删的文件夹里，随它一起走、也随它一起回来');
  });

  it('没对上回收站号的那些 ⇒ 明写"撤销不包括它们"，不许留假承诺', () => {
    const text = deleteBatchReceiptText({
      done: [{ name: 'a.ERB', isDir: false }, { name: 'b.csv', isDir: false }],
      untracked: ['b.csv'],
      trashReadable: true,
    });
    expect(text).toContain('其中 1 份没能在回收站里对上号（b.csv）——撤销不包括它们');
  });

  it('宿主没有"列回收站"这条腿 ⇒ 不许说"可以撤销"，改说去「文件历史」逐条看', () => {
    const text = deleteBatchReceiptText({ done: [{ name: 'a.ERB', isDir: false }], trashReadable: false });
    expect(text).toContain('这个环境没有读回收站的通道');
    expect(text).not.toContain('撤销这次删除');
  });

  it('没删成的逐条点名带原因（铁律 4：失败不许只留一个数字）', () => {
    const text = deleteBatchReceiptText({
      done: [{ name: 'a.ERB', isDir: false }],
      failed: [{ name: 'b.csv', reason: '正被另一个程序占用' }],
      trashReadable: true,
    });
    expect(text).toContain('没删成的 1 项：b.csv（正被另一个程序占用）');
  });

  it('一项都没删成 ⇒ 说的是事实，不是"已删除 0 项"', () => {
    const text = deleteBatchReceiptText({ done: [], failed: [{ name: 'a.ERB', reason: READONLY }], trashReadable: true });
    expect(text).toContain('没有删成任何条目');
    expect(text).not.toContain('已删除 0 项');
  });
});

describe('撤销那两句回执', () => {
  it('放回那句点名到每一项，并写明"回到原来的位置"', () => {
    const text = undoDeleteReceiptText({ restored: ['a.ERB', '包A'] });
    expect(text).toContain('已放回 2 项：「a.ERB」、「包A」（回到原来的位置）');
  });

  it('没放回的说清原因，并且明说它们还在回收站里（不是没了）', () => {
    const text = undoDeleteReceiptText({
      restored: ['a.ERB'],
      failed: [{ name: '包A', reason: '原位置已存在，不能恢复（回收站不覆盖）：C:/koa/001/包A' }],
    });
    expect(text).toContain('没放回的 1 项：包A（原位置已存在，不能恢复');
    expect(text).toContain('它们还在回收站里');
  });

  it('一项都没放回 ⇒ 一句"一项都没放回原位"，不写"已放回 0 项"', () => {
    expect(undoDeleteReceiptText({ restored: [] })).toContain('一项都没放回原位');
  });

  it('没有可撤销的批时给的是指引（撤销只记这一会话刚删的那一批）', () => {
    expect(undoUnavailableText()).toContain('没有可撤销的删除');
    expect(undoUnavailableText()).toContain('「文件历史」');
  });

  it('去向那句在确认与回执里是同一份文案（两处不许各说各话）', () => {
    expect(TRASH_WHERE).toContain('不在游戏目录里');
    expect(deleteBatchConfirmText(buildDeletePlan([f(F1)]))).toContain(TRASH_WHERE);
    expect(deleteBatchReceiptText({ done: [{ name: 'a.ERB', isDir: false }], trashReadable: true })).toContain(TRASH_WHERE);
  });
});
