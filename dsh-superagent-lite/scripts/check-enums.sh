#!/usr/bin/env bash
# 机检：源码里用到的枚举字面量必须都在 model.ts 的联合类型里。
#
# 为什么需要它：Node 的类型剥离**不做类型检查**，所以
#   `kind: 'launch'` 而 EffectKind 里只有 'start-session'
# 这种错误在运行时和单测里都看不见（K03 真踩过：engine 入队 launch/relay/kaaDone/treeWrite，
# 而 EffectKind 写的是 start-session/kaa-done/…），只有 tsc 或人读才会发现。
# 这个脚本用 20 行换掉"装 tsc"的成本，K13 若要补 tsc 可以把它当临时判据。
#
# 用法：bash scripts/check-enums.sh   退出码 0 = 全在联合里；1 = 有漂移
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

python3 - <<'PY'
import glob
import re
import sys

model = open('src/core/model.ts', encoding='utf-8').read()

def union(name: str) -> set[str]:
    m = re.search(r'export type %s =([^;]+);' % name, model, re.S)
    if not m:
        print(f'[枚举一致] 找不到 union {name}')
        sys.exit(1)
    return set(re.findall(r"'([^']+)'", m.group(1)))

kinds, stages, reports = union('EffectKind'), union('Stage'), union('ReportKind')
for label, got in (('EffectKind', kinds), ('Stage', stages), ('ReportKind', reports)):
    if not got:
        print(f'[枚举一致] {label} 是空的')
        sys.exit(1)

# 只看"写入侧"：kind: 'x' / latestReport: 'x' / stage 赋值
# 只扫**写入侧**的字面量，避免把 Candidate.kind（'event'，不是 EffectKind）误判进来：
#   effect('launch', ...)             —— Engine 的入队助手
#   { kind: 'x', key: ... }           —— 直接构造 NewEffect
checks = [
    ('EffectKind', kinds, re.compile(r"\beffect\(\s*'([^']+)'")),
    ('EffectKind', kinds, re.compile(r"\{[^{}]*\bkind:\s*'([^']+)'[^{}]*\bkey:")),
    ('ReportKind', reports, re.compile(r"\blatestReport:\s*'([^']+)'")),
    ('Stage', stages, re.compile(r"\bstage:\s*'([^']+)'")),
]

bad, seen = [], {}
for path in sorted(glob.glob('src/**/*.ts', recursive=True)):
    if path.endswith('core/model.ts'):
        continue
    text = open(path, encoding='utf-8').read()
    for label, allowed, pat in checks:
        for m in pat.finditer(text):
            seen.setdefault(label, set()).add(m.group(1))
            if m.group(1) not in allowed:
                bad.append((label, m.group(1), path))

for label, allowed in (('EffectKind', kinds), ('ReportKind', reports), ('Stage', stages)):
    used = sorted(seen.get(label, set()))
    print(f'[枚举一致] {label}: 联合 {len(allowed)} 个 / 源码用到 {len(used)} 个 {used}')

if bad:
    for label, value, path in bad:
        print(f'  漂移: {label} 里没有 {value!r}（{path} 用到）')
    print('[枚举一致] 结论: 有漂移')
    sys.exit(1)

print('[枚举一致] 结论: 全部在联合里')
PY
