// `tools/corpus-fingerprint.mjs` 的类型面（照 `tools/perf-suite.d.mts` 的成例：实现 .mjs、
// 判据面 .d.mts，让 packages/**/tests 的 TS 能 import 而不必开 allowJs）。
export interface CorpusFingerprint {
  readonly v: string;
  readonly erb: number;
  readonly erh: number;
  readonly als: number;
  readonly kojo: number;
  readonly kojo2: number;
  readonly srcBytes: number;
  readonly digest: string;
  readonly savFiles: number;
  readonly savBytes: number;
  readonly savNames: readonly string[];
  readonly savDigest: string;
}
/** 登记行里的指纹 = 当前盘指纹的**字段子集**（逐字段严格相等；键名拼错会被 `resolvePinnedRow` 点名）。 */
export type FingerprintPin = Readonly<Record<string, string | number>>;
export interface PinnedRow<R = unknown> {
  readonly label: string;
  readonly fp: FingerprintPin;
  readonly expect: R;
}
export interface CandidateWithFingerprint {
  readonly dir: string;
  readonly erbCount: number;
  readonly savCount: number;
  readonly fp: CorpusFingerprint;
}
export interface PinnedResolution<R = unknown> {
  readonly ok: boolean;
  readonly row: PinnedRow<R> | null;
  readonly message: string;
}
export declare const FINGERPRINT_VERSION: string;
export declare function corpusFingerprint(dir: string): CorpusFingerprint;
export declare function discoverCorpusFingerprints(opts?: Record<string, unknown>): CandidateWithFingerprint[];
export declare function formatFingerprint(fp: CorpusFingerprint): string;
export declare function matchesFingerprint(fp: CorpusFingerprint, pin: FingerprintPin): boolean;
export declare function unknownPinFields(pin: FingerprintPin): string[];
export declare function resolvePinnedRow<R>(
  gateId: string,
  rows: readonly PinnedRow<R>[],
  fp: CorpusFingerprint,
  live?: unknown,
  candidates?: readonly CandidateWithFingerprint[],
): PinnedResolution<R>;
export declare function savCandidatesReadout(candidates: readonly CandidateWithFingerprint[]): string;
export declare function assertCorpusDir(dir: string): unknown;
