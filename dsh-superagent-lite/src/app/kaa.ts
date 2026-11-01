/**
 * app/kaa.ts —— 唯一跨进程出口（P7，预算 80 行）。
 * 只读三样：退出码、stdout 的 JSON、事件是否落盘。**不 grep 人类可读文本**——文本随版本变。
 * 30 秒超时按瞬时失败处理（进 effects 退避），不阻塞 pass。
 */
export interface Declarations {
  [k: string]: unknown;
}
export interface EvidenceMeta {
  [k: string]: unknown;
}

export interface KaaResult {
  ok: boolean;
  /** 退出码；被信号杀死或超时时为 null。 */
  code: number | null;
  /** stdout 解析出的 JSON；不是合法 JSON 时 undefined（绝不从人话里猜）。 */
  json?: unknown;
  timedOut: boolean;
  /** 只在"没能拿到可判定的结果"时给，例如超时、非 JSON、spawn 失败。 */
  error?: string;
}

export interface RunnerResult {
  code: number | null;
  stdout: string;
  stderr?: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** 可注入的 runner：真实现走 spawn，测试注入桩（不启动真进程）。 */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunnerResult>;

export interface KaaOptions {
  /** fat3 仓库根（CLI 的 cwd）。 */
  cwd?: string;
  /** 被驱动仓库根，写进 KAA_TARGET_ROOT。 */
  targetRoot?: string;
  timeoutMs?: number;
  run?: Runner;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const KAA_CLI = ['python3', 'skills/kaa/kaa.py'];

/** 只认整段 stdout 是 JSON；解析失败就是失败，不去"找里面的 JSON"。 */
export function parseJson(stdout: string): unknown | undefined {
  const t = stdout.trim();
  if (t === '') return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 调一次 `kaa done`。幂等键是 `(slug, node)`：重复调用由 kaa 状态机拒绝重复跃迁，
 * 本层不做去重（去重归 effects 的 `(kind,key)`）。
 */
export async function kaaDone(
  slug: string,
  node: string,
  decl: Declarations,
  evidence: EvidenceMeta,
  opts: KaaOptions = {},
): Promise<KaaResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const argv = [
    ...KAA_CLI,
    'done',
    slug,
    node,
    '--declarations',
    JSON.stringify(decl),
    '--evidence-meta',
    JSON.stringify(evidence),
  ];
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...process.env, KAA_TARGET_ROOT: opts.targetRoot ?? process.cwd() } as Record<string, string>;
  const run = opts.run ?? spawnRunner;

  let r: RunnerResult;
  try {
    r = await run(argv, { cwd, env, timeoutMs });
  } catch (e) {
    return { ok: false, code: null, timedOut: false, error: `spawn 失败：${String(e)}` };
  }
  if (r.timedOut) return { ok: false, code: r.code, timedOut: true, error: `超时 ${timeoutMs}ms` };

  const json = parseJson(r.stdout);
  if (r.code === 0) return { ok: true, code: 0, json, timedOut: false };
  return { ok: false, code: r.code, json, timedOut: false, error: json === undefined ? 'stdout 不是合法 JSON' : undefined };
}

/** 真实现：spawn + 硬超时 kill。超时算瞬时失败，调用方据此进退避。 */
export const spawnRunner: Runner = async (argv, o) => {
  const { spawn } = await import('node:child_process');
  return new Promise<RunnerResult>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut });
    });
  });
};
