#!/usr/bin/env python3
"""交付机检：十一条判据，任一不过即 exit 1。可复跑，无外部依赖。

用法：cd /Users/song/1github/ssa1101 && python3 check-delivery.py

判据：
  [1] 41 条 S 全部落在 R 的覆盖矩阵里
  [2] 需求台账与覆盖矩阵的 R 集合相等
  [3] 所有 path:行 锚点在磁盘上真实存在且行号不越界
  [4] T1-T10 / S1-S9 缺口在详设里逐条有处置
  [5] 四份交付物非空
  [6] 自建行数这一个量在三份文档里一致（防"估算-细化"两步走时各信一份）
  [7] 磁盘上的目录与详设声明的树一致：§1.2 文档树（顶层 + notes）+ §1.1 代码树的目录层
  [8] 每份交付文档的 ## 大纲与详设 §1.2.1 声明的逐项相等（防"文档内部结构自由生长"）
  [9] DELIVERY.md 里转录的那段机检读数 == 本次实跑输出（防"抄下来的读数比代码旧"）
  [10] TASKS.md §4 的树读数是存储里重算的，不是手抄的
  [11] 23 条 R 每条都有 K 认领；verify_cmd 引用的文件都在详设声明树里
"""
import contextlib
import glob
import io
import json
import os
import re
import sys

ROOTS = [
    '/tmp/sap-src',
    '/Users/song',
    '/Users/song/1github/fat3',
    '/Users/song/1github/ssa1101',
    '/Users/song/Documents/deepseek-harness/default-workspace',
    '/Users/song/Documents/deepseek-harness/default-workspace/turbo-preset',
]
DOCS = [
    'notes/phase0-analysis.md', 'docs/REQUIREMENTS.md', 'docs/ARCHITECTURE.md',
    'docs/DETAILED-DESIGN.md', 'docs/TASKS.md', 'notes/S-requirements.md',
    'notes/capabilities.md', 'notes/EXCEEDS.md',
]
ANCHOR = re.compile(r'([\w./@~-]+\.(?:md|ts|tsx|yml|json|css|js|py|toml|sh)):(\d+)(?:-(\d+))?')


def lines(path: str) -> int:
    with open(path, encoding='utf-8', errors='replace') as fh:
        return sum(1 for _ in fh)


def check_coverage() -> bool:
    rows = [l for l in open('notes/S-requirements.md', encoding='utf-8') if re.match(r'^\| S\d\d \|', l)]
    s_ids = set(re.findall(r'S(\d\d)', ''.join(rows)))
    doc = open('docs/REQUIREMENTS.md', encoding='utf-8').read()
    i, j = doc.find('## 2 覆盖矩阵'), doc.find('## 3 覆盖自检')
    covered = set(re.findall(r'\bS(\d\d)\b', doc[i:j]))
    missing = sorted(s_ids - covered)
    print(f'[1] S 覆盖      : 条目 {len(s_ids)} / 覆盖 {len(covered)} / 未覆盖 {missing}')
    return len(s_ids) == 41 and not missing


def check_ledger() -> bool:
    doc = open('docs/REQUIREMENTS.md', encoding='utf-8').read()
    i, j = doc.find('## 2 覆盖矩阵'), doc.find('## 3 覆盖自检')
    ledger = set(re.findall(r'^\| (R\d\d) \|', doc[:i], re.M))
    matrix = {'R' + x for x in re.findall(r'\bR(\d\d)\b', doc[i:j])}
    print(f'[2] 台账/矩阵   : {len(ledger)} / {len(matrix)} / 差集 {sorted(ledger ^ matrix)}')
    return ledger == matrix and len(ledger) == 23


def check_anchors() -> bool:
    total = bad = 0
    for doc in DOCS:
        text = open(doc, encoding='utf-8').read()
        seen = set()
        for m in ANCHOR.finditer(text):
            path, a, b = m.group(1), int(m.group(2)), m.group(3)
            key = (path, a, b)
            if key in seen:
                continue
            seen.add(key)
            total += 1
            resolved = None
            for root in ROOTS:
                cand = os.path.join(root, path.lstrip('~').lstrip('/'))
                if os.path.exists(cand):
                    resolved = cand
                    break
            end = int(b) if b else a
            if resolved is None or end > lines(resolved):
                bad += 1
                print(f'    失效锚点 {doc} {key}')
    print(f'[3] 锚点        : 共 {total} 条 / 失效 {bad}')
    return bad == 0


def check_gaps() -> bool:
    text = open('docs/DETAILED-DESIGN.md', encoding='utf-8').read()
    miss_t = [f'T{n}' for n in range(1, 11) if f'T{n}' not in text]
    miss_s = [f'S{n}' for n in range(1, 10) if f'S{n}' not in text]
    print(f'[4] 缺口闭合    : T1-T10 缺 {miss_t or "无"} / S1-S9 缺 {miss_s or "无"}')
    return not miss_t and not miss_s


def check_files() -> bool:
    need = ['docs/REQUIREMENTS.md', 'docs/ARCHITECTURE.md',
            'docs/DETAILED-DESIGN.md', 'docs/TASKS.md']
    sizes = [(f, os.path.getsize(f)) for f in need]
    print(f'[5] 四份交付物  : {sizes}')
    return all(size > 1000 for _, size in sizes)


def _module_sum() -> int:
    r"""详设 §1.3 模块表：形如 `| \`src/core/model.ts\` | 80 | ...`
    注意 §1.1 的目录树里也有行号注释，但那些行不以 `| ` 开头，不会误计入。"""
    total = 0
    for line in open('docs/DETAILED-DESIGN.md', encoding='utf-8'):
        m = re.match(r'^\| `src/[\w/.-]+` \| (\d+) \|', line)
        if m:
            total += int(m.group(1))
    return total


def _task_rows() -> dict:
    """TASKS.md 任务总表：`| K01 | 任务 | 产出 | 行数 | 依赖 | 验收 | R |`
    行数在第 4 列（0 基 split 后 index 4）；K13 是测试预算，单独核对，不进 src 合计。"""
    rows = {}
    for line in open('docs/TASKS.md', encoding='utf-8'):
        if not re.match(r'^\| K\d\d \|', line):
            continue
        cells = [c.strip() for c in line.split('|')]
        rows[cells[1]] = {'lines': int(cells[4]), 'deps': cells[5]}
    return rows


def check_same_quantity() -> bool:
    """同一个量（src 自建行数）在 ARCHITECTURE / DETAILED-DESIGN / TASKS 三处必须相等。
    这是上一轮的教训：粗估与细化两步走时，两份文档会各写一个数，读的人各信一份。"""
    arch = open('docs/ARCHITECTURE.md', encoding='utf-8').read()
    decl = open('docs/DETAILED-DESIGN.md', encoding='utf-8').read()
    arch_nums = {int(x.replace(',', '')) for x in re.findall(r'([\d,]+) 行 src', arch)}
    decl_nums = {int(x.replace(',', '')) for x in re.findall(r'合计（src）[^\n]*\*\*?([\d,]+)', decl)}
    module_sum = _module_sum()
    tasks = _task_rows()
    src_sum = sum(v['lines'] for k, v in tasks.items() if k != 'K13')
    test_sum = tasks.get('K13', {}).get('lines', -1)
    # 磁盘实测：文档里写的是"实测值"，那就必须真去数一遍——
    # 只比"三处文档互相一致"证明不了数对不对（K13 修 T09 时 store.ts +3 行，
    # 三处文档仍互相一致，判据 6 却是绿的）。
    disk = 0
    for f in glob.glob('dsh-superagent-lite/src/**/*.ts', recursive=True):
        with open(f, encoding='utf-8', errors='replace') as fh:
            disk += sum(1 for _ in fh)
    vals = {'ARCHITECTURE 声明': arch_nums, '详设声明': decl_nums,
            '详设模块表合计': module_sum, 'TASKS 合计': src_sum, '磁盘实测': disk}
    agree = (len(arch_nums) == 1 and len(decl_nums) == 1
             and arch_nums == decl_nums == {module_sum} == {src_sum} == {disk})
    dep_bad = []
    for k, v in tasks.items():
        for d in re.findall(r'K\d\d', v['deps']):
            if d not in tasks and d != k:
                dep_bad.append(f'{k}->{d}')
    ok = agree and len(tasks) == 14 and test_sum == 500 and not dep_bad
    print(f'[6] 同量一致    : {vals} / 任务 {len(tasks)} 个 / 测试 {test_sum} 行 / 悬空依赖 {dep_bad or "无"}')
    return ok


def _declared_tree() -> tuple:
    """解析 DETAILED-DESIGN §1.2 的文档树代码块，返回 (顶层条目集合, {目录: 子项集合})。
    顶层 = 缩进 0 的 `├── x` / `└── x`；以 `/` 结尾的是目录，其子项缩进更深。
    只对**声明了子项**的目录做子项比对（docs/、notes/）；像 dsh-superagent-lite/ 那样只写一行
    的容器目录不在此比对，它的内部由 §1.1 + 判据 ⑦ 的代码树部分负责。
    找不到 §1.2 或缺代码块时抛错——判据读不到声明就必须红，不能静默通过。"""
    lines = open('docs/DETAILED-DESIGN.md', encoding='utf-8').read().splitlines()
    sec = None
    for i, line in enumerate(lines):
        if line.startswith('### 1.2 '):
            sec = i
            break
    if sec is None:
        raise RuntimeError('详设里找不到 ### 1.2 文档目录')
    body, fence = [], False
    for line in lines[sec:]:
        if line.startswith('### ') and body:
            break
        if line.strip().startswith('```'):
            fence = not fence
            continue
        if fence:
            body.append(line)
    if not body:
        raise RuntimeError('§1.2 里没有代码块')
    top, children, cur = set(), {}, None
    for line in body:
        m = re.match(r'^([│\s]*)[├└]── (\S+)', line)
        if not m:
            continue
        depth, name = len(m.group(1)) // 4, m.group(2)
        if depth == 0:
            if name.endswith('/'):
                cur = name.rstrip('/')
                children.setdefault(cur, set())
            else:
                cur = None
            top.add(name.rstrip('/'))
        elif cur is not None:
            children[cur].add(name.rstrip('/'))
    return top, children


def check_dirs() -> bool:
    """详设声明的树 == 磁盘现状。三部分：
    ① §1.2 顶层条目（文件与目录都算，不比对内容与大小）；
    ② §1.2 里声明了子项的目录（docs/、notes/）：子文件集合必须相等；
    ③ §1.1 代码树的目录层（只比目录，文件由 K01-K14 建）。
    隐藏文件（.DS_Store 等）一律不计入。"""
    top_d, children_d = _declared_tree()
    actual_top = {e for e in os.listdir('.') if not e.startswith('.')}
    problems, detail = [], []
    if top_d != actual_top:
        problems.append(f'顶层 多出 {sorted(actual_top - top_d)} / 缺失 {sorted(top_d - actual_top)}')
    for d, kids in sorted(children_d.items()):
        if not kids:
            continue
        got = ({e for e in os.listdir(d) if not e.startswith('.')}
               if os.path.isdir(d) else set())
        if kids != got:
            problems.append(f'{d}/ 多出 {sorted(got - kids)} / 缺失 {sorted(kids - got)}')
        detail.append(f'{d}/ 声明 {len(kids)} / 实际 {len(got)}')

    code_d = _declared_code_dirs()
    actual_code = {'dsh-superagent-lite'}
    for dirpath, dirnames, _ in os.walk('dsh-superagent-lite'):
        dirnames[:] = [x for x in dirnames if not x.startswith('.')]
        for x in dirnames:
            actual_code.add(os.path.join(dirpath, x))
    if code_d != actual_code:
        problems.append(f'代码树 多出 {sorted(actual_code - code_d)} / 缺失 {sorted(code_d - actual_code)}')
    detail.append(f'代码树目录 声明 {len(code_d)} / 实际 {len(actual_code)}')

    print(f'[7] 目录一致    : 顶层 {len(top_d)}/{len(actual_top)} / ' + ' / '.join(detail))
    if problems:
        for pr in problems:
            print(f'                  {pr}')
    else:
        print('                  多出 无 / 缺失 无')
    return not problems


def _declared_code_dirs() -> set:
    """解析 §1.1 代码树，返回相对 `dsh-superagent-lite/` 的目录路径集合。
    只收以 `/` 结尾的条目——文件（.ts/.json/.yml）由 K01-K14 建，不在判据范围内。
    层级用缩进算：`├── ` 前缀里每 4 个字符（`│   ` 或 4 空格）算一层。"""
    text = open('docs/DETAILED-DESIGN.md', encoding='utf-8').read().splitlines()
    start = None
    for i, line in enumerate(text):
        if line.startswith('### 1.1'):
            start = i
            break
    if start is None:
        raise RuntimeError('详设里找不到 ### 1.1 落地代码目录树')
    body, fence, seen = [], False, False
    for line in text[start:]:
        if line.startswith('### ') and body:
            break
        if line.strip().startswith('```'):
            fence = not fence
            continue
        if fence:
            body.append(line)
    if not body:
        raise RuntimeError('§1.1 里没有代码块')
    root = body[0].strip().rstrip('/')
    dirs = {root}
    stack = {0: root}
    for line in body[1:]:
        m = re.match(r'^([│ ]*)[├└]── (\S+)', line)
        if not m:
            continue
        depth = len(m.group(1)) // 4 + 1
        name = m.group(2)
        if not name.endswith('/'):
            continue
        parent = stack.get(depth - 1)
        if parent is None:
            raise RuntimeError(f'§1.1 缩进层级断了：{line!r}')
        path = f'{parent}/{name}'.rstrip('/')
        dirs.add(path)
        stack[depth] = path
    return dirs


def _declared_outlines() -> dict:
    """解析详设 §1.2.1 表格：第 1 列是反引号包住的文档名，第 4 列是反引号包住的
    `1 xxx · 2 yyy` 大纲。notes/*.md 那行不设大纲，跳过。"""
    text = open('docs/DETAILED-DESIGN.md', encoding='utf-8').read().splitlines()
    start = None
    for i, line in enumerate(text):
        if line.startswith('### 1.2.1'):
            start = i
            break
    if start is None:
        raise RuntimeError('详设里找不到 ### 1.2.1 每份文档的设计')
    out = {}
    for line in text[start + 1:]:
        if line.startswith('### ') or line.startswith('## '):
            break
        if not line.startswith('| `'):
            continue
        cells = [c.strip() for c in line.split('|')]
        doc = cells[1].strip('`')
        outline = cells[4]
        if not outline.startswith('`') or '*' in doc:
            continue                      # notes 行不设大纲
        items = [x.strip() for x in outline.strip('`').split(' · ') if x.strip()]
        out[doc] = items
    return out


def check_outlines() -> bool:
    """每份交付文档的二级标题顺序与 §1.2.1 声明的大纲完全一致。
    要加/删/改节，先改 §1.2.1；只改文档不改设计 → 这里红。"""
    declared = _declared_outlines()
    if not declared:
        raise RuntimeError('没有解析出任何文档大纲声明')
    bad, ok_n = [], 0
    for doc, want in declared.items():
        if not os.path.exists(doc):
            bad.append(f'{doc}: 文件不存在')
            continue
        got = [line[3:].strip() for line in open(doc, encoding='utf-8').read().splitlines()
               if line.startswith('## ')]
        if got == want:
            ok_n += 1
            continue
        add = [x for x in got if x not in want]
        miss = [x for x in want if x not in got]
        bad.append(f'{doc}: 多出 {add or "无"} / 缺失 {miss or "无"}' if (add or miss)
                   else f'{doc}: 节名相同但顺序不同 声明{want} 实际{got}')
    print(f'[8] 大纲一致    : 声明 {len(declared)} 份 / 一致 {ok_n} 份 / 问题 {bad or "无"}')
    return not bad


def _blocks(text: str) -> list:
    """把输出按"以 [N] 开头的行 + 其后续缩进行"切成块，去掉行尾空白。
    这样 [7] 那种两行的输出（主行 + 多出/缺失行）被当成一个整体比较。"""
    out, cur = [], None
    for line in text.splitlines():
        if line.startswith('['):
            if cur is not None:
                out.append(cur)
            cur = [line.rstrip()]
        elif cur is not None and line.startswith(' '):
            cur.append(line.rstrip())
        else:
            if cur is not None:
                out.append(cur)
                cur = None
    if cur is not None:
        out.append(cur)
    return ['\n'.join(b) for b in out]


def check_transcript(actual: list) -> bool:
    """DELIVERY.md §2 里贴的那段读数必须是本次运行的真实输出。
    这是第三次"读数比代码旧"的教训落地：人工抄数必漂，只能拿实跑对。"""
    lines = open('docs/DELIVERY.md', encoding='utf-8').read().splitlines()
    sec = None
    for i, line in enumerate(lines):
        if line.startswith('## 2 '):
            sec = i
            break
    if sec is None:
        raise RuntimeError('DELIVERY.md 里找不到 ## 2 机检读数')
    body, fence = [], False
    for line in lines[sec:]:
        if line.startswith('## ') and body:
            break
        if line.strip().startswith('```'):
            fence = not fence
            continue
        if fence:
            body.append(line)
    if not body:
        raise RuntimeError('DELIVERY.md §2 里没有代码块')
    # 自指保护：[9] 描述的是"其余判据的输出"，它本身不进比对（否则要写进自己又要等于自己）
    declared = [b for b in _blocks('\n'.join(body)) if not b.startswith('[9]')]
    actual = [b for b in actual if not b.startswith('[9]')]
    diff = []
    for i in range(max(len(declared), len(actual))):
        d = declared[i] if i < len(declared) else '(缺)'
        a = actual[i] if i < len(actual) else '(缺)'
        if d != a:
            diff.append((d, a))
    print(f'[9] 读数一致    : 文档转录 {len(declared)} 行块 / 实跑 {len(actual)} 行块 / 不一致 {len(diff)} 处')
    for d, a in diff:
        print(f'                  文档: {d.splitlines()[0][:80]}')
        print(f'                  实跑: {a.splitlines()[0][:80]}')
    return not diff


TREE_ROOT_TITLE = '落地实现 dsh-superagent-lite'


def _tree_from_store():
    """从 ~/.dsh/storages/goal_tree.json 找本交付那棵树。返回 (nodes, 错误信息)。"""
    path = os.path.expanduser('~/.dsh/storages/goal_tree.json')
    if not os.path.exists(path):
        return None, 'goal-tree 存储不存在'
    data = json.load(open(path, encoding='utf-8'))
    for session in data.get('tables', {}).get('sessions', {}).values():
        nodes = session.get('nodes') or []
        if any(str(n.get('title', '')).startswith(TREE_ROOT_TITLE) for n in nodes):
            return nodes, ''
    return None, '存储里没有标题以"落地实现"开头的节点'


def _depth_dist(nodes: list) -> dict:
    by_id = {n['id']: n for n in nodes}
    dist = {}
    for n in nodes:
        depth, cur = 1, n
        while by_id.get(cur.get('parentId')):
            cur = by_id[cur['parentId']]
            depth += 1
        dist[depth] = dist.get(depth, 0) + 1
    return dict(sorted(dist.items()))


def _tree_numbers(nodes):
    """(节点数, 深度分布, n1 直接子节点数, 末位节点 id)"""
    mx = max(nodes, key=lambda n: int(str(n['id']).lstrip('n')))['id']
    return len(nodes), _depth_dist(nodes), sum(1 for n in nodes if n.get('parentId') == 'n1'), mx


def _declared_tree_numbers(doc: str):
    """从 TASKS §4 抽出被机检的四个数。抽不到返回 None。"""
    m1 = re.search(r'节点 \*\*(\d+)\*\*', doc)
    m2 = re.search(r'树深分布 `\{([^}]+)\}`', doc)
    m3 = re.search(r'\*\*n1 直接子节点（(\d+) 个）\*\*', doc)
    m4 = re.search(r'n29–n(\d+)', doc)
    if not (m1 and m2 and m3 and m4):
        return None
    dist = {}
    for q in m2.group(1).split(','):
        k, v = q.split(':')
        dist[int(k)] = int(v)
    return int(m1.group(1)), dict(sorted(dist.items())), int(m3.group(1)), 'n' + m4.group(1)


def check_tree_readings() -> bool:
    """[10] 树读数必须是存储里算出来的。人手抄这个数已经错过三次
    （n28→n33、n33→n34、n34→n35 全是加完节点忘改），所以这里重算，文档只当被告。
    被核的四个数：节点数、深度分布、n1 直接子节点数、n29–nNN 末位。"""
    nodes, err = _tree_from_store()
    doc = open('docs/TASKS.md', encoding='utf-8').read()
    declared = _declared_tree_numbers(doc)
    if nodes is None or declared is None:
        print(f'[10] 树读数一致  : 无法核（{err or "TASKS §4 缺读数"}）')
        return False
    real = _tree_numbers(nodes)
    ok = declared == real
    print(f'[10] 树读数一致  : 声明 {declared[0]} 节点 {declared[1]} / n1 子 {declared[2]} / 末位 {declared[3]}')
    print(f'                  实算 {real[0]} 节点 {real[1]} / n1 子 {real[2]} / 末位 {real[3]}')
    return ok


def sync_tree_readings() -> list:
    """把 TASKS §4 的四个树读数按存储重算后改写。返回改动说明（空 = 无改动）。"""
    nodes, err = _tree_from_store()
    if nodes is None:
        return [f'跳过树读数同步（{err}）']
    count, dist, kids, mx = _tree_numbers(nodes)
    path = 'docs/TASKS.md'
    src = open(path, encoding='utf-8').read()
    out = src
    out = re.sub(r'节点 \*\*\d+\*\*、树深分布 `\{[^}]+\}`',
                 f'节点 **{count}**、树深分布 `{{{", ".join(f"{k}:{v}" for k, v in dist.items())}}}`', out)
    out = re.sub(r'\*\*n1 直接子节点（\d+ 个）\*\*', f'**n1 直接子节点（{kids} 个）**', out)
    out = re.sub(r'n29–n\d+', f'n29–{mx}', out)
    if out == src:
        return []
    open(path, 'w', encoding='utf-8').write(out)
    return [f'节点 {count} / 深度 {dist} / n1 子节点 {kids} / 末位 {mx}']


def check_r_to_k() -> bool:
    """[11] 上一轮审计出的两条洞，各补一条判据：
    (a) 每条 R 至少被一个 K 任务的「对应 R」列认领，且该列不许写「等」；
    (b) REQUIREMENTS 里每个 `test -f <path>` 的路径必须在详设 §1.3 模块表或约定产物里
        ——否则开发做完它照样红，"能判红"退化成"永远红"。"""
    tasks = open('docs/TASKS.md', encoding='utf-8').read()
    claimed, vague = set(), []
    for line in tasks.splitlines():
        m = re.match(r'^\| (K\d\d) \|', line)
        if not m:
            continue
        cell = line.rstrip().split('|')[-2]
        if '等' in cell:
            vague.append(m.group(1))
        claimed.update('R' + x for x in re.findall(r'R(\d\d)', cell))

    reqs = open('docs/REQUIREMENTS.md', encoding='utf-8').read()
    ledger = set(re.findall(r'^\| (R\d\d) \|', reqs, re.M))
    unclaimed = sorted(ledger - claimed)

    design = open('docs/DETAILED-DESIGN.md', encoding='utf-8').read()
    known = {'dsh-superagent-lite/' + x for x in re.findall(r'^\| `(src/[^`]+)` \|', design, re.M)}
    known |= {'dsh-superagent-lite/SETUP.md', 'dsh-superagent-lite/tests/budget.test.ts',
              'dsh-superagent-lite/presets/router.patch.yml',
              'dsh-superagent-lite/presets/worker.patch.yml'}
    refs = set(re.findall(r'test -f ([\w./\-]+)', reqs))
    unknown = sorted(r for r in refs if r not in known)

    print(f'[11] R→K 覆盖   : 无主 {unclaimed or "无"} / 模糊「等」{vague or "无"}')
    print(f'                  verify_cmd 路径 {len(refs)} 条 / 不在声明树 {unknown or "无"}')
    return not unclaimed and not vague and not unknown


def _run_prereq_checks():
    """跑判据 1-8 与 10（不含 9：9 比对的正是这段输出）。"""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        results = [check_coverage(), check_ledger(), check_anchors(), check_gaps(),
                   check_files(), check_same_quantity(), check_dirs(), check_outlines(),
                   check_tree_readings(), check_r_to_k()]
    text = buf.getvalue()
    return results, text, [b for b in _blocks(text) if not b.startswith('[9]')]


def refresh_transcript() -> int:
    """把判据 1-8 的实跑输出写回 docs/DELIVERY.md §2。只在 1-8 全绿时写，
    否则会把红着的读数原样抄进文档。用法：python3 check-delivery.py --refresh"""
    for note in sync_tree_readings():
        print('同步 TASKS §4:', note)
    results, text, blocks = _run_prereq_checks()
    if not all(results):
        print(text, end='')
        print('\n拒绝重刷：判据 1-8、10、11 有未通过项，先修好再刷。')
        return 1
    total = len(blocks) + 1
    body = blocks + ['', f'结论: 全部通过 （{total}/{total}）', '退出码=0']
    path = 'docs/DELIVERY.md'
    src = open(path, encoding='utf-8').read()
    sec = src.index('## 2 机检读数')
    st = src.index('```', sec)
    en = src.index('```', st + 3)
    open(path, 'w', encoding='utf-8').write(src[:st + 3] + '\n' + '\n'.join(body) + '\n' + src[en:])
    print(f'已重刷 docs/DELIVERY.md §2（{len(blocks)} 条读数块 + 结论行）')
    return 0


def main() -> int:
    if '--refresh' in sys.argv:
        return refresh_transcript()
    results, text, _ = _run_prereq_checks()
    print(text, end='')
    results.append(check_transcript(_blocks(text)))
    ok = all(results)
    print('\n结论:', '全部通过' if ok else '有未通过项',
          f'（{sum(results)}/{len(results)}）')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
