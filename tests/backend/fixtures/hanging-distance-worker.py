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
    if request.get('method') == 'scene_measure_distance':
        (Path(args.data_dir) / 'distance-started').write_text('started', encoding='utf-8')
        release = Path(args.data_dir) / 'distance-release'
        while not release.exists():
            time.sleep(0.02)
        print(json.dumps({'id': request['id'], 'ok': True, 'result': {
            'shapeDistanceM': 1, 'surfaceDistanceM': None, 'collision': 'unknown',
            'innerSolution': False, 'firstPoint': [0, 0, 0], 'secondPoint': [1, 0, 0],
            'unit': 'm', 'space': 'world-z-up', 'method': 'occt-brep',
        }}), flush=True)
