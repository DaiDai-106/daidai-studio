"""真实 worker 的测试入口：标记大文件哈希已经开始，不改变生产实现。"""
import hashlib
from pathlib import Path
import sys

python_dir = Path(__file__).resolve().parents[3] / 'packages' / 'scene' / 'python'
sys.path.insert(0, str(python_dir))
import distance
import worker

original = distance._digest

def observed_digest(path):
    if Path(path).name != 'large.step':
        return original(path)
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        first = source.read(1024 * 1024)
        digest.update(first)
        Path('distance-hash-started').write_text('started')
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

distance._digest = observed_digest
worker.main()
