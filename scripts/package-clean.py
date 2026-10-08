"""同步项目文件到 _pkg4 并打包为 zip（排除隐私与环境文件）。

排除项：
  .git / node_modules / uploads / .workbuddy / _pkg* / frames
  .env 及 .env.* （保留 .env.example）
  *.zip / *.mp4 / *.png 等大体积二进制产物
  各类调试临时目录
设计约束：本脚本不做任何删除操作（安全策略不允许批量删），
每次运行写入全新的暂存目录与新的 zip 文件名，历史产物自然保留。
"""
import os, re, zipfile, datetime

ROOT = r"C:/Users/10231/WorkBuddy/2026-10-06-16-56-56"
SRC = os.path.join(ROOT, "ComputeShield")
STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
STAGE = os.path.join(ROOT, "_stage-" + STAMP, "ComputeShield")
ZIP = os.path.join(ROOT, "Aegis-ComputeShield-%s-clean.zip" % STAMP)

EXCLUDE_DIRS = {
    ".git", "node_modules", "uploads", ".workbuddy", "frames",
    "_pkg", "_pkg2", "_pkg3", "_pkg4", "cache", ".cache",
}
# 说明：.docx 是交付物（项目计划书）保留；.log / 上传件属运行期产物与用户数据，不入库。
EXCLUDE_FILE_EXT = {".zip", ".mp4", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".log", ".pdf"}

def keep(rel):
    parts = rel.split(os.sep)
    for p in parts[:-1]:
        if p in EXCLUDE_DIRS:
            return False
    name = parts[-1]
    ext = os.path.splitext(name)[1].lower()
    if ext in EXCLUDE_FILE_EXT:
        return False
    # .env / .env.* 一律排除，.env.example 保留
    if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        return False
    if name in {".DS_Store", "Thumbs.db"}:
        return False
    return True

# 1. 同步（不删任何东西：每次用全新目录）
os.makedirs(STAGE, exist_ok=True)

copied = 0
for dirpath, dirnames, filenames in os.walk(SRC):
    rel_dir = os.path.relpath(dirpath, SRC)
    if rel_dir != ".":
        parts = rel_dir.split(os.sep)
        if any(p in EXCLUDE_DIRS for p in parts):
            dirnames[:] = []
            continue
    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
    os.makedirs(os.path.join(STAGE, rel_dir if rel_dir != "." else ""), exist_ok=True)
    for fn in filenames:
        rel = os.path.join(rel_dir, fn) if rel_dir != "." else fn
        if not keep(rel):
            continue
        open(os.path.join(STAGE, rel), "wb").write(open(os.path.join(dirpath, fn), "rb").read())
        copied += 1
print("同步文件数:", copied)

# 2. 隐私扫描（在同步后的目录上跑）
KEY = re.compile(r"0x[a-fA-F0-9]{64}")
ENV_SECRET = re.compile(r"(PRIVATE_KEY|MNEMONIC|SEED|API_KEY|SECRET|TOKEN)\s*[:=]\s*\S+", re.I)

hits_key, hits_env = [], []
for dirpath, _, filenames in os.walk(STAGE):
    for fn in filenames:
        p = os.path.join(dirpath, fn)
        rel = os.path.relpath(p, STAGE)
        if rel.endswith((".json",)) and "artifacts" in rel:
            continue  # 合约字节码不做文本扫描
        try:
            t = open(p, "r", encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        if KEY.search(t):
            hits_key.append(rel)
        for m in ENV_SECRET.finditer(t):
            v = m.group(0)
            if "process.env" in v or "${" in v or "your" in v.lower() or v.rstrip().endswith(("=", ":", "")):
                continue
            hits_env.append((rel, v[:80]))
            break

print("\n=== 隐私扫描 ===")
print("私钥形状 (0x+64hex) 命中:", len(hits_key))
for h in hits_key:
    print("  -", h)
print("明文凭据命中:", len(hits_env))
for f, v in hits_env:
    print("  -", f, "|", v)

# 3. 打包（文件名带时间戳，无需覆盖旧包）
n = 0
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dirpath, _, filenames in os.walk(STAGE):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            z.write(p, os.path.relpath(p, os.path.dirname(STAGE)))
            n += 1
print("\n压缩包:", ZIP)
print("条目数:", n)
print("大小: %.1f KB" % (os.path.getsize(ZIP) / 1024))

# 4. 回读校验
with zipfile.ZipFile(ZIP) as z:
    names = z.namelist()
print("顶层目录:", sorted({nm.split("/")[0] for nm in names}))
print(".env 存在:", any(nm.endswith("/.env") for nm in names))
print(".env.example 存在:", any(nm.endswith(".env.example") for nm in names))
print("node_modules 存在:", any("node_modules" in nm for nm in names))
print("md2docx.js 存在:", any(nm.endswith("md2docx.js") for nm in names))

# 5. 本机路径泄露扫描（C:/Users/<名字>、/home/<名字> 之类）
LOCAL = re.compile(r"[A-Za-z]:[/\\]Users[/\\][A-Za-z0-9_.\-]+|/home/[A-Za-z0-9_.\-]+")
leak = {}
with zipfile.ZipFile(ZIP) as z:
    for nm in names:
        if not nm.endswith((".md", ".js", ".json", ".txt", ".html", ".css", ".example",
                            ".gitignore", ".bat", ".sol", ".yml", ".yaml")):
            continue
        s = z.read(nm).decode("utf-8", "ignore")
        m = LOCAL.findall(s)
        if m:
            leak[nm] = sorted(set(m))[:4]
print("\n本机路径泄露文件数:", len(leak))
for k, v in leak.items():
    print("  -", k, "|", v)
