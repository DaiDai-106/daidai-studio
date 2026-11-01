import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--project-id', required=True)
parser.add_argument('--data-dir', required=True)
args, _ = parser.parse_known_args()
root = Path(args.data_dir)
(root / 'started').write_text('started', encoding='utf-8')
for line in sys.stdin:
    request = json.loads(line)
    source = Path(request['params']['path'])
    (root / 'request-started').write_text(source.name, encoding='utf-8')
    if source.name == 'hang.step':
        time.sleep(30)
    stage = root / 'staging'
    stage.mkdir(exist_ok=True)
    data = b'glTF fixture'
    output = stage / f"{request['id']}.glb"
    output.write_bytes(data)
    result = {
        'source': {'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()},
        'resource': {'path': str(output), 'format': 'glb', 'byteLength': len(data), 'sha256': hashlib.sha256(data).hexdigest()},
        'objects': [], 'warnings': [], 'complete': False,
    }
    print(json.dumps({'id': request['id'], 'ok': True, 'result': result}), flush=True)
