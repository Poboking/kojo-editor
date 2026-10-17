import { describe, expect, it } from 'vitest';
import type { OpJournal, OpsMaintenance } from '@kojo/plugin-api';
import {
  opsMaintenanceDetail,
  opsMaintenanceText,
  opsMaintenanceTone,
  opsMaintenanceTotal,
  readOpsMaintenance,
} from '../src/maintenance';

/**
 * 铁律 4 的呈现面：ops 残留读数「未知」与「干净」必须一眼分得开——
 * 读不出绝不许冒充 0，整行也绝不许消失。这里钉死这组口径。
 */

const report = (over: Partial<OpsMaintenance> = {}): OpsMaintenance => ({
  openOrphanDocs: 1,
  rollbackFailedDocs: 2,
  unreadableDocs: 3,
  orphanSnapshotDirs: 4,
  cleanupFailures: 5,
  checkedAt: Date.UTC(2026, 9, 17, 0, 0, 0),
  ...over,
});

function journalWith(over: Partial<Record<keyof OpJournal, unknown>>): OpJournal {
  return over as unknown as OpJournal;
}

describe('ops maintenance · 读数口径', () => {
  it('total = 五项之和（checkedAt 不计）', () => {
    expect(opsMaintenanceTotal(report())).toBe(15);
    expect(opsMaintenanceTotal(report({ openOrphanDocs: 0, cleanupFailures: 0 }))).toBe(9);
  });

  it('detail 五项逐项 + 巡检时间都在', () => {
    const d = opsMaintenanceDetail(report());
    expect(d).toContain('open 残留 1');
    expect(d).toContain('回滚失败 2');
    expect(d).toContain('孤儿快照目录 4');
    expect(d).toContain('清理失败 5');
    expect(d).toContain('2026-10-17');
  });

  it('未知 ≠ 干净：null/known=false 一律 unknown 并写明原因，不写成 0', () => {
    for (const read of [
      null,
      { known: false, total: 0, detail: '内核未提供 maintenanceReport' },
    ]) {
      expect(opsMaintenanceTone(read)).toBe('unknown');
      const text = opsMaintenanceText(read);
      expect(text).toContain('未知');
      expect(text).not.toBe('ops journal maintenance: 0');
    }
    expect(opsMaintenanceText({ known: false, total: 0, detail: '巡检失败：x' })).toContain('巡检失败：x');
  });

  it('已知：total=0 是 clean、>0 是 residue（残留文案带"待人工处置"）', () => {
    expect(opsMaintenanceTone({ known: true, total: 0, detail: '' })).toBe('clean');
    expect(opsMaintenanceText({ known: true, total: 0, detail: '' })).toBe('ops journal maintenance: 0');
    expect(opsMaintenanceTone({ known: true, total: 3, detail: '' })).toBe('residue');
    expect(opsMaintenanceText({ known: true, total: 3, detail: '' })).toContain('3');
    expect(opsMaintenanceText({ known: true, total: 3, detail: '' })).toContain('待人工处置');
  });
});

describe('readOpsMaintenance · 一次巡检的三条降级路', () => {
  it('旧内核无 maintenanceReport ⇒ known=false，绝不假装 0', async () => {
    const read = await readOpsMaintenance(journalWith({ list: async () => [] }));
    expect(read.known).toBe(false);
    expect(read.detail).toContain('未提供 maintenanceReport');
  });

  it('list() 巡检抛错 ⇒ known=false 且原因可见', async () => {
    const read = await readOpsMaintenance(
      journalWith({
        list: async () => {
          throw new Error('ops dir unreadable');
        },
        maintenanceReport: () => report(),
      }),
    );
    expect(read.known).toBe(false);
    expect(read.detail).toContain('ops dir unreadable');
  });

  it('maintenanceReport() 抛错 ⇒ known=false；正常路径先巡检再读数', async () => {
    const failing = await readOpsMaintenance(
      journalWith({
        list: async () => [],
        maintenanceReport: () => {
          throw new Error('poisoned');
        },
      }),
    );
    expect(failing.known).toBe(false);
    expect(failing.detail).toContain('poisoned');

    let listed = 0;
    const ok = await readOpsMaintenance(
      journalWith({
        list: async () => {
          listed += 1;
          return [];
        },
        maintenanceReport: () => report({ openOrphanDocs: 0, rollbackFailedDocs: 0, unreadableDocs: 0, orphanSnapshotDirs: 0, cleanupFailures: 2 }),
      }),
    );
    expect(listed).toBe(1); // 残留计数只在巡检时刷新 ⇒ 必须亲自 list()
    expect(ok.known).toBe(true);
    expect(ok.total).toBe(2);
  });
});
