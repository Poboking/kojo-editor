/**
 * KW-12 · F2 改动清单的呈现面（`ui/rename-preview.ts`）判据。
 *
 * 钉三件事：
 * ① **行的形状**：逐文件「几处 / 可不可写 / 开没开标签 / 不可写的为什么」全部来自写计划本身，
 *    本模块**不判**可写性（可写性只有内核 io 那一把尺子，见 `editor-editability.ts` 头注）；
 * ② **两条通知的分工**：预览拍在按下回车**之前**（有不可写落点 ⇒ 常驻 error，
 *    因为按下去必然整次取消）、落地拍在送达**之后**（陈旧 / 写失败 ⇒ error；
 *    散文跳过是既定判据 ⇒ info，假警报会把人训练成忽略 toast）；
 * ③ **糖源腿的如实标注**：预览只列方言面时必须在正文里写出来，不许把半张表当全表报。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  renameLandedNotice,
  renamePlanFilesOf,
  renamePlanTotalsOf,
  renamePreviewNotice,
  reportRenameNotice,
  subscribeRenameNotices,
  resetRenameNoticeSinks,
  unwritableReasonOf,
  type RenameLandedInput,
} from '../src/ui/rename-preview';
import {
  erbOccurrences,
  mergeOccurrences,
  planReferenceWrites,
  readOnlyFilesReason,
} from '../src/ui/reference-utils';

const HERE = import.meta.dirname;
/** 呈现面源码（静态守卫读它，钉"不许长出第二把可写性尺子"） */
const LEDGER_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'ui', 'rename-preview.ts'),
  'utf8',
);

const OPEN = 'C:/p/ERB/a.ERB';
const CLOSED = 'C:/p/ERB/b.ERB';
const READONLY = 'D:/game/ERB/c.ERB';

/** 三方言面落点：已开标签 1 处 / 未打开 1 处 / 只读 2 处 */
const planOf = (writable: (path: string) => boolean) =>
  planReferenceWrites(
    mergeOccurrences([
      erbOccurrences([
        { filePath: OPEN, line: 1, column: 2, endColumn: 10, kind: 'definition' },
        { filePath: CLOSED, line: 5, column: 1, endColumn: 9, kind: 'call' },
        { filePath: READONLY, line: 8, column: 3, endColumn: 11, kind: 'call' },
        { filePath: READONLY, line: 9, column: 3, endColumn: 11, kind: 'mention' },
      ]),
    ]),
    writable,
  );

const allButReadOnly = (path: string): boolean => path !== READONLY;

describe('renamePlanFilesOf · 清单的行（判定单源，本模块只排行）', () => {
  it('可写性逐字取自写计划；三行齐、顺序 = 台账序 + 只读行殿后', () => {
    const files = renamePlanFilesOf(planOf(allButReadOnly), (p) => p === OPEN);
    expect(files.map((file) => file.path)).toEqual([OPEN, CLOSED, READONLY]);
    expect(files.map((file) => file.writable)).toEqual([true, true, false]);
    expect(files.map((file) => file.occurrences)).toEqual([1, 1, 2]);
    expect(files.map((file) => file.opened)).toEqual([true, false, false]);
    // 可写行不带 reason（带了就是替内核多嘴）
    expect(files[0]?.reason).toBeUndefined();
  });

  it('不可写行带"为什么"，且只在 isWritable 判过之后才问区域（`describeUnwritable` 不参与能不能写）', () => {
    const asked: string[] = [];
    const files = renamePlanFilesOf(planOf(allButReadOnly), () => false, (path) => {
      asked.push(path);
      return '游戏目录只读';
    });
    expect(asked, '可写的落点不该被问"为什么不能写"').toEqual([READONLY]);
    expect(files.find((file) => file.path === READONLY)?.reason).toBe('游戏目录只读');
  });

  it('合计由行求和（不另数一遍）：文件数 / 处数 / 不可写两处各自对齐', () => {
    const totals = renamePlanTotalsOf(renamePlanFilesOf(planOf(allButReadOnly), (p) => p === OPEN));
    expect(totals).toEqual({
      files: 3,
      occurrences: 4,
      unwritableFiles: 1,
      unwritableOccurrences: 2,
      openedFiles: 1,
    });
  });

  it('糖源落点并进同一张表（同一次全或无，两种语言一份清单）', () => {
    const sugar = 'D:/game/a.kojo1';
    const plan = planReferenceWrites(
      mergeOccurrences([
        erbOccurrences([{ filePath: OPEN, line: 1, column: 2, endColumn: 10, kind: 'definition' }]),
        [
          {
            filePath: sugar,
            line: 3,
            column: 6,
            endColumn: 14,
            language: 'kojo',
          },
        ],
      ]),
      (path) => path !== sugar,
    );
    const rows = renamePlanFilesOf(plan, () => false);
    expect(rows.map((row) => row.language)).toEqual(['erb', 'kojo']);
    expect(rows[1]?.path).toBe(sugar);
    expect(rows[1]?.writable).toBe(false);
  });
});

describe('unwritableReasonOf · 只解释不判定', () => {
  it('三档区域各说一句人话，零内部词', () => {
    expect(unwritableReasonOf('game-erb')).toContain('游戏目录');
    expect(unwritableReasonOf('workspace')).toContain('写允许域');
    expect(unwritableReasonOf('other')).toContain('写入目录');
    expect(unwritableReasonOf(undefined)).toBe(unwritableReasonOf('other'));
    for (const reason of ['game-erb', 'workspace', 'other'] as const) {
      expect(unwritableReasonOf(reason)).not.toMatch(/isWritable|writablePaths|planReferenceWrites/);
    }
  });
});

describe('renamePreviewNotice · 改之前看得见', () => {
  const files = renamePlanFilesOf(planOf(allButReadOnly), (p) => p === OPEN, (p) =>
    p === READONLY ? '落在游戏目录（口上区）' : '写权限未批准',
  );

  it('全可写 ⇒ info 一句摘要，明细逐文件点名（含"未打开 = 直接落盘"这一句）', () => {
    const notice = renamePreviewNotice({
      oldName: 'M_KOJO_A',
      files: files.filter((file) => file.writable),
    });
    expect(notice.kind).toBe('info');
    expect(notice.title).toContain('重命名预览');
    expect(notice.message).toContain('2 个文件 2 处');
    expect(notice.message).toContain('1 个在编辑器里改');
    expect(notice.message).toContain('1 个直接落盘');
    expect(notice.detail).toContain(`'${CLOSED}'（1 处）`);
  });

  it('有不可写落点 ⇒ 常驻 error + 逐条"为什么"，并说清按下去会整次取消', () => {
    const notice = renamePreviewNotice({ oldName: 'M_KOJO_A', files });
    expect(notice.kind).toBe('error');
    expect(notice.message).toContain('1 个（2 处）写不进去');
    expect(notice.message).toContain('整次取消');
    expect(notice.detail).toContain(`${READONLY}'（2 处）：落在游戏目录（口上区）`);
  });

  it('糖源腿未参与预览时如实标注（不把半张表当全表报）', () => {
    const notice = renamePreviewNotice({ oldName: 'M_KOJO_A', files, deferred: true });
    expect(notice.detail).toContain('.kojo1');
    expect(notice.detail).toContain('只列方言面');
  });

  it('空清单不编数字（`files` 为空时摘要仍是 0 个文件 0 处，不出现 undefined）', () => {
    const notice = renamePreviewNotice({ oldName: 'X', files: [] });
    expect(notice.message).toContain('0 个文件 0 处');
    expect(notice.message).not.toContain('undefined');
  });
});

describe('renameLandedNotice · 落地读数不许只进 console', () => {
  const files = renamePlanFilesOf(planOf(allButReadOnly), (p) => p === OPEN);
  const base: RenameLandedInput = {
    oldName: 'M_KOJO_A',
    newName: 'M_KOJO_B',
    files: files.filter((file) => file.writable),
    landedClosedFiles: 1,
    tabEdits: 1,
    stale: 0,
    proseSkipped: 0,
    failures: [],
    deferred: false,
  };

  it('干净落地 ⇒ info，摘要给"几个文件写盘 / 编辑器内几处（未保存）"', () => {
    const notice = renameLandedNotice(base);
    expect(notice.kind).toBe('info');
    expect(notice.message).toContain('1 个未打开文件已写盘');
    expect(notice.message).toContain('编辑器内 1 处（未保存）');
  });

  it('陈旧坐标跳过 / io 写失败 ⇒ 升级为常驻 error 并逐条点名', () => {
    const stale = renameLandedNotice({ ...base, stale: 3 });
    expect(stale.kind).toBe('error');
    expect(stale.message).toContain('3 处现文本对不上坐标跳过');
    const failed = renameLandedNotice({ ...base, failures: [`'${CLOSED}'：写允许域未批准`] });
    expect(failed.kind).toBe('error');
    expect(failed.message).toContain('1 个文件写入失败');
    expect(failed.detail).toContain(`'${CLOSED}'：写允许域未批准`);
  });

  it('只有散文跳过（既定判据）⇒ 说得出处数但不拉警报', () => {
    const notice = renameLandedNotice({ ...base, proseSkipped: 2 });
    expect(notice.kind).toBe('info');
    expect(notice.message).toContain('2 处是台词散文未改');
  });
});

describe('订阅表（形态照 format-notice-ledger.ts）', () => {
  it('同一枚 notify 订两次只上屏一次；退订两次才真撤', () => {
    resetRenameNoticeSinks();
    const notify = vi.fn();
    const off1 = subscribeRenameNotices(notify);
    const off2 = subscribeRenameNotices(notify);
    reportRenameNotice({ kind: 'info', message: '清单' });
    expect(notify).toHaveBeenCalledTimes(1);
    off1();
    reportRenameNotice({ kind: 'info', message: '清单' });
    expect(notify).toHaveBeenCalledTimes(2);
    off2();
    reportRenameNotice({ kind: 'info', message: '清单' });
    expect(notify).toHaveBeenCalledTimes(2);
    resetRenameNoticeSinks();
  });

  it('呈现面抛错不许打断改名（一条订阅炸了照样返回，不往上抛）', () => {
    resetRenameNoticeSinks();
    subscribeRenameNotices(() => {
      throw new Error('通知中心炸了');
    });
    expect(() => reportRenameNotice({ kind: 'info', message: '清单' })).not.toThrow();
    resetRenameNoticeSinks();
  });
});

describe('只读回执的逐条点名（文案真源仍在 reference-utils）', () => {
  it('旧前缀逐字保留；给了 detail 就把「哪个文件 · 几处」点名出来', () => {
    const plan = planOf(allButReadOnly);
    const reason = readOnlyFilesReason(plan.readOnlyFiles.length, '重命名', plan.readOnlyDetail);
    expect(reason).toContain('1 个文件只读未纳入');
    expect(reason).toContain(`'${READONLY}'（2 处）`);
    // 不带 detail = 与改前逐字同形（旧消费方零改动）
    expect(readOnlyFilesReason(1, '重命名')).toBe(
      '1 个文件只读未纳入，整次重命名取消（部分改名会造成同名分叉）；解锁对应目录后重试',
    );
  });

  it('清单有上限：几百枚只读文件不许把真正的原因挤出信息条', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      path: `D:/game/${i}.ERB`,
      occurrences: 1,
      language: 'erb' as const,
    }));
    const reason = readOnlyFilesReason(many.length, '重命名', many);
    expect(reason).toContain(`'D:/game/7.ERB'（1 处）`);
    expect(reason).not.toContain('D:/game/9.ERB');
    expect(reason).toContain('等 3 个文件');
  });
});

/** 静态守卫：呈现层不许自己再判一次可写性（判据单源 = 内核 io 经写计划交回） */
describe('分层守卫（可写性单源）', () => {
  /** 只取代码体（注释里点名那些尺子是**指路**，不是引用它们；守卫查的是代码） */
  const code = LEDGER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('本模块不引内核、不调 isWritable、不抄解锁集合', () => {
    expect(code).not.toMatch(/isWritable\s*\(/);
    expect(code).not.toMatch(/from '@kojo\/kernel'/);
    expect(code).not.toMatch(/unlockedPaths|directEditable|editabilityNow|fileWritableArea\s*\(/);
    expect(code, '清单行只分两桶：可写桶写死 true、只读桶写死 false（不现算）').toMatch(
      /writable: true[\s\S]*writable: false/,
    );
  });

  it('文案与订阅住本模块，装配层只留接线（不新造一套 UI 体系：只订通知中心）', () => {
    expect(LEDGER_SOURCE).toContain("from './NotificationCenter'");
    expect(LEDGER_SOURCE).toContain('subscribeRenameNotices');
    expect(LEDGER_SOURCE, '不许起第二套呈现体系').not.toMatch(/createPortal|document\.getElementById/);
  });
});
