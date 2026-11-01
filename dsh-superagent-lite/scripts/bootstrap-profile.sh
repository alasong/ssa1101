#!/usr/bin/env bash
# K01：从零建一个**非 Electron 管理**的 superagent profile，并以 **bundle 补丁层**形式挂上本插件。
# 为什么必须非 Electron：desktop profile 被 Electron 独占，dump-config 直接报错，
# 所有「生效配置」类判据在那上面跑不了（ARCHITECTURE.md §0 的实测约束）。
#
# 为什么是 bundle 而不是手写 insert：包自带的 cordis.patch.yml 由 dsh 当层叠加，
# 升级/卸载跟着包走；手写 insert 会和 bundle 各挂一次。
#
# 幂等：重复跑会重建 profile（--from-default-profile），再重新装一次包与 bundles。
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/superagent"

# 1) 从 headless 模板生成（非 Electron、无 node_modules，最轻）
dsh --profile superagent --from-default-profile headless --dump-config >/dev/null

# 2) 以 bundle 形式装进 profile（本地 link，不走网络）
dsh plugin --profile superagent add "link:$REPO/dsh-superagent-lite" >/dev/null

# 3) 把包名写进 profile 的 bundles —— 不写这步，包只是普通依赖，不会被当层加载
python3 - "$PROFILE/package.json" <<'PYBOOT'
import json, sys
path = sys.argv[1]
data = json.load(open(path, encoding='utf-8'))
bundles = data.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if 'dsh-superagent-lite' not in bundles:
    bundles.append('dsh-superagent-lite')
open(path, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
PYBOOT

# 4) 用户补丁层留空：bundle 已自带 insert，这里再写一条会挂两次
cat > "$PROFILE/cordis.patch.yml" <<'YAMPATCH'
# superagent profile 的用户补丁层（留空）。
# 插件以 bundle 形式由 dsh-superagent-lite 包自带的 cordis.patch.yml 提供。
[]
YAMPATCH

echo "profile : $PROFILE"
echo "bundles : $(python3 -c "import json,sys;print(','.join(json.load(open(sys.argv[1]))['dsh']['profile']['bundles']))" "$PROFILE/package.json")"
echo "count   : $(dsh --profile superagent --dump-config | grep -c 'superagent-lite')"
echo
echo "验证挂载（不消耗模型额度；无 key 时只会报 MISSING_CREDENTIAL）："
echo "  dsh --profile superagent --json ok 2>&1 | grep -c '\\[superagent-lite\\] mounted'   # 期望 1"
