/**
 * 跨文件定义 · **宿主接线**的单源闸（源码级）。
 *
 * 为什么不行为测：`readDefinitionTargets` 要一个完整内核（槽查询 + `project.current()`）与
 * 真 pane 登记表，行为测等于在本文件里再造一个宿主；而这一批在宿主侧只做"请求字段 + 顺序"
 * 的接线，判据就该钉在接线上——形态照 `language-ux-matrix` / `ps10-boot-order` 的先例。
 *
 * 四条（每条都对着一种真实退化）：
 * 1. **契约 additive**：`EditorDefinitionRequest` 带 `projectFiles` / `projectFilesComplete`
 *    （少了这两格，供方永远只能答同文件）；
 * 2. **请求真塞快照**：definition 请求里出现 `projectFiles` + `projectFilesComplete`；
 * 3. **只给需要它的语言付这份钱**：快照取数前判 descriptor 的 `slotServices` 是否点名了
 *    `definition`——v1 方言由解析器原生应答、不读 `projectFiles`，而它们的 F12 远比 2.0
 *    频繁，每次把整项目文本过一遍槽是这条腿最贵的退化；
 * 4. **同文件优先**：先问一遍、本地为空**才**取快照重问（顺序即语义，写反 = 每次 F12
 *    都付项目扫描的钱）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 从 `marker` 起到下一个顶层 `function` 之前（LF 换行；本仓 `.gitattributes` 钉着） */
function bodyOf(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `找不到 ${marker}`).toBeGreaterThanOrEqual(0);
  const tail = src.slice(start + marker.length);
  const next = tail.search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next);
}

/** 从 `export interface <name>` 到下一个顶层声明之前 */
function interfaceBody(src: string, name: string): string {
  const start = src.indexOf(`export interface ${name}`);
  expect(start, `找不到 interface ${name}`).toBeGreaterThanOrEqual(0);
  const tail = src.slice(start + `export interface ${name}`.length);
  const next = tail.search(/\nexport (?:interface|type) /);
  return next < 0 ? tail : tail.slice(0, next);
}

describe('跨文件定义 · 契约与宿主接线', () => {
  it('契约 `EditorDefinitionRequest` 带 projectFiles / projectFilesComplete（additive 两格）', () => {
    const slots = read('packages/plugin-api/src/slots.ts');
    const request = interfaceBody(slots, 'EditorDefinitionRequest');
    expect(request).toMatch(/readonly projectFiles\?: readonly EditorProjectFile\[\];/);
    expect(request).toMatch(/readonly projectFilesComplete\?: boolean;/);
  });

  it('宿主把快照塞进 definition 请求，且复用引用 / 改名那条取数腿', () => {
    const host = read('packages/app/src/ui/editor-global-providers.ts');
    expect(host).toMatch(/import \{[\s\S]{0,160}projectFilesSnapshotOf[\s\S]{0,160}\} from '\.\.\/monaco\/kojo-language-service-legs';/);
    const leg = bodyOf(host, 'export function readDefinitionTargets(');
    expect(leg).toContain('projectFiles: snapshot.files');
    expect(leg).toContain('projectFilesComplete: snapshot.complete');
  });

  it('快照只在"definition 由槽供方应答"的语言上取（v1 方言的 F12 不付这份钱）', () => {
    const host = read('packages/app/src/ui/editor-global-providers.ts');
    const snapshot = bodyOf(host, 'function definitionProjectSnapshotOf(');
    expect(snapshot).toContain('descriptorForLanguageId(');
    expect(snapshot).toMatch(/slotServices\.includes\('definition'\)/);
    expect(snapshot).toContain('projectFilesSnapshotOf(');
  });

  it('同文件优先：先问一次，本地为空才取快照重问（顺序即语义）', () => {
    const host = read('packages/app/src/ui/editor-global-providers.ts');
    const leg = bodyOf(host, 'export function readDefinitionTargets(');
    const firstAsk = leg.indexOf('collectDefinitionLocations(contributions, request)');
    const guard = leg.indexOf('if (locations.length === 0)');
    const takeSnapshot = leg.indexOf('definitionProjectSnapshotOf(');
    const secondAsk = leg.indexOf('projectFiles: snapshot.files');
    expect(firstAsk).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(firstAsk);
    expect(takeSnapshot).toBeGreaterThan(guard);
    expect(secondAsk).toBeGreaterThan(takeSnapshot);
  });
});