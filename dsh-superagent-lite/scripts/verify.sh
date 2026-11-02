#!/usr/bin/env bash
# scripts/verify.sh —— 一条命令跑完 T01–T15 与 K14 的端到端/崩溃用例，每项打一行固定形状。
#   输出：T01 | PASS | event=1 ticket=1 / T07 | FAIL | 原因
#   退出码：全 PASS = 0，任一 FAIL（含"测试根本没跑出结果"）= 1
# 判据来源：详设 §8；测试代码在 tests/integration/t01-t15.test.ts。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

OUT="$(mktemp -d "${TMPDIR:-/tmp}/verify-t01-t15.XXXXXX")"
LOG="$OUT/node-test.log"
trap 'rm -rf "$OUT"' EXIT

VERIFY_RESULTS="$OUT/results" node --test tests/ >"$LOG" 2>&1
node_exit=$?

fail=0
for n in $(seq -w 1 15); do
  id="T${n}"
  f="$OUT/results/$id.txt"
  if [ -f "$f" ]; then
    raw="$(cat "$f")"
    status="${raw%%|*}"
    detail="${raw#*|}"
  else
    status="FAIL"
    detail="无结果（测试未运行或进程崩溃；node --test exit=${node_exit}）"
  fi
  if [ "$status" != "PASS" ]; then fail=1; fi
  printf '%s | %s | %s\n' "$id" "$status" "$detail"
done

# K14 的端到端/崩溃用例（tests/integration/e2e.test.ts）：状态从 TAP 的 ✔/✖ 判，
# 读数从它自己打的 "[K14-n] ..." 行取——两边都不靠猜。
for n in 1 2 3 4 5; do
  id="K14-$n"
  if grep -q "^✔ ${id} " "$LOG"; then
    status="PASS"
    detail="$(grep -oE "^\[${id}\][^|]*" "$LOG" | head -1 | sed 's/^\[[^]]*\] *//')"
    [ -z "$detail" ] && detail="ok"
  elif grep -q "^✖ ${id} " "$LOG"; then
    status="FAIL"; detail="测试失败（见 node --test 输出）"
  else
    status="FAIL"; detail="无结果（测试未运行或进程崩溃）"
  fi
  if [ "$status" != "PASS" ]; then fail=1; fi
  printf '%s | %s | %s\n' "$id" "$status" "$detail"
done

# worker 凭据层：账户路由没接回来，每一单都会死在 401 上（页面只显示「退出码 1」）
if node scripts/check-worker-auth.ts --selftest >/tmp/verify-auth-self.log 2>&1 && node scripts/check-worker-auth.ts >/tmp/verify-auth.log 2>&1; then
  printf 'WORKER-AUTH | PASS | %s\n' "$(sed -n 's/^worker 凭据层 OK：//p' /tmp/verify-auth.log | head -1)"
else
  fail=1; printf 'WORKER-AUTH | FAIL | 见 node scripts/check-worker-auth.ts（含 --selftest）\n'
fi

# 控制台页面脚本（经典脚本可解析 / 入口挂在 window 上 / 按钮有绑定）——它坏了页面按钮就是死的
if node scripts/check-page.ts >/tmp/verify-page.log 2>&1; then
  printf 'PAGE | PASS | %s\n' "$(sed -n 's/^页面脚本 OK：//p' /tmp/verify-page.log | head -1)"
else
  fail=1; printf 'PAGE | FAIL | 见 node scripts/check-page.ts\n'
fi

# 页面渲染：光"能解析"不够，得真把数据画出来（白屏在浏览器里也没有报错）
if node scripts/check-page-render.ts >/tmp/verify-render.log 2>&1; then
  printf 'PAGE-RENDER | PASS | %s\n' "$(sed -n 's/^页面渲染 OK：//p' /tmp/verify-render.log | head -1)"
else
  fail=1; printf 'PAGE-RENDER | FAIL | 见 node scripts/check-page-render.ts\n'
fi

echo "exit code: $fail"
if [ "$fail" -ne 0 ]; then
  echo "--- node --test 尾部（诊断用）---" >&2
  tail -n 20 "$LOG" >&2
fi
exit "$fail"
