import argparse
import json
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--project-id', required=True)
parser.add_argument('--data-dir', required=True)
args, _ = parser.parse_known_args()
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'scene_import':
        (Path(args.data_dir) / 'import-started').write_text('started', encoding='utf-8')
        time.sleep(30)
