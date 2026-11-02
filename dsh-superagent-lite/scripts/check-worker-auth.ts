/**
 * scripts/check-worker-auth.ts —— 机检 worker 的凭据层（`presets/credentials.patch.yml`）。
 *
 * 为什么需要它：headless 模板把整条账户授权链路都关掉了（credentials / authorization /
 * deepseek-account 三个插件 `disabled: true`），只留「启动环境里 export DEEPSEEK_API_KEY」。
 * 本机那把 refs.DEEPSEEK_API_KEY 已失效（401），于是每一单 worker 都失败在 401 上，
 * 页面上只看到「退出码 1」——这批失败有一次就够了。这条检查把"补丁必须把账户路由接回来"
 * 变成可判红的判据，不再靠记得。
 *
 *   node scripts/check-worker-auth.ts              # 判真文件
 *   node scripts/check-worker-auth.ts --file <p>   # 判指定文件（自检用）
 *   node scripts/check-worker-auth.ts --selftest   # 好/坏两份夹具都跑一遍，坏的必须判红
 *
 * 判据（每一条对应一处真实失败）：
 *   ① credentials 打开     —— 关着就读不到 ~/.dsh/.credentials.yaml
 *   ② deepseek-account 打开 —— 关着就没有 deepseekAccount 服务，账户 token 取不到
 *   ③ authorization 打开    —— 关着账户路由进不去
 *   ④ 插入 llm-deepseek-account —— 不插入就根本没有 "deepseek-account" 这个 provider 路由
 *   ⑤ agent-default-model 指向 deepseek-account —— 否则默认模型仍走 API key 那条路
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 把 YAML 拍平成「id → 该条目文本块」，够用即可：只认顶层 `- id:` 分隔。 */
export function blocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (cur !== null) out.set(cur, buf.join('\n'));
    buf = [];
  };
  for (const line of text.split('\n')) {
    const m = /^- id:\s*(\S+)\s*$/.exec(line);
    if (m !== null) {
      flush();
      cur = m[1];
      buf = [];
      continue;
    }
    if (cur !== null) buf.push(line);
  }
  flush();
  return out;
}

/** 判一份补丁文本，返回问题列表（空数组 = 通过）。 */
export function judge(text: string): string[] {
  const b = blocks(text);
  const problems: string[] = [];
  for (const [id, why] of [
    ['credentials', '关着就读不到 ~/.dsh/.credentials.yaml'],
    ['deepseek-account', '关着就没有 deepseekAccount 服务，账户 token 取不到'],
    ['authorization', '关着账户路由进不去'],
  ] as const) {
    if (!b.has(id)) problems.push(`缺少 ${id} 条目：${why}`);
    else if (!/^\s*disabled:\s*false\s*$/m.test(b.get(id) as string)) {
      problems.push(`${id} 没有显式 disabled: false（${why}）`);
    }
  }
  if (!b.has('llm-deepseek-account')) {
    problems.push('缺少 llm-deepseek-account 插入：不插入就没有 deepseek-account 这个 provider 路由');
  }
  const model = b.get('agent-default-model') ?? '';
  if (!/provider:\s*['"]?deepseek-account['"]?/.test(model)) {
    problems.push('agent-default-model 没指向 deepseek-account：默认模型仍会走失效的 API key 那条路');
  }
  return problems;
}

const args = process.argv.slice(2);
const fileArg = args.indexOf('--file');

if (args.includes('--selftest')) {
  const good = [
    '- id: credentials',
    '  disabled: false',
    '- id: deepseek-account',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '- id: llm-deepseek-account',
    "  name: '@deepseek-ai/dsh-llm-deepseek-account'",
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-account',
  ].join('\n');
  const cases: [string, string, boolean][] = [
    ['好夹具', good, true],
    ['删掉 deepseek-account', good.replace('- id: deepseek-account\n  disabled: false\n', ''), false],
    ['credentials 改回 disabled: true', good.replace('- id: credentials\n  disabled: false', '- id: credentials\n  disabled: true'), false],
    ['删掉 llm-deepseek-account', good.replace("- id: llm-deepseek-account\n  name: '@deepseek-ai/dsh-llm-deepseek-account'\n", ''), false],
    ['默认模型改回 API key 路由', good.replace('provider: deepseek-account', 'provider: deepseek-official'), false],
  ];
  let bad = 0;
  for (const [name, text, wantPass] of cases) {
    const p = judge(text);
    const passed = p.length === 0;
    if (passed !== wantPass) {
      bad += 1;
      console.error(`自检失败：${name} 期望 ${wantPass ? '通过' : '判红'}，实际 ${passed ? '通过' : '判红'}`);
    } else {
      console.log(`自检 OK：${name} → ${passed ? '通过' : '判红'}`);
    }
  }
  process.exit(bad === 0 ? 0 : 1);
}

const file = fileArg >= 0 ? (args[fileArg + 1] as string) : join(here, '..', 'presets', 'credentials.patch.yml');
const problems = judge(readFileSync(file, 'utf8'));
if (problems.length > 0) {
  console.error(`worker 凭据层 ${file} 不成立：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  'worker 凭据层 OK：credentials / deepseek-account / authorization 均打开，' +
    'llm-deepseek-account 已插入，默认模型走 deepseek-account 路由',
);
