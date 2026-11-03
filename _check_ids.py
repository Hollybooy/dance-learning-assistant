"""临时自检：检查 JS 引用的元素 ID 是否都存在于 HTML。"""

import re

js = ""
for path in ("js/app.js", "js/replay.js", "js/live.js"):
    js += open(path, encoding="utf-8").read()

ids = set(re.findall(r"\$\('([a-zA-Z0-9-]+)'\)", js))
html = open("index.html", encoding="utf-8").read()
missing = [i for i in sorted(ids) if f'id="{i}"' not in html]
print("missing ids:", missing)

# 同时列出所有 innerHTML 赋值目标，便于定位报错点
for path in ("js/app.js", "js/replay.js"):
    for num, line in enumerate(open(path, encoding="utf-8"), 1):
        if ".innerHTML" in line:
            print(f"{path}:{num}: {line.strip()}")
