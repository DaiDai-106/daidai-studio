"""项目级场景 worker：标准输入输出仅用于逐行 JSON 协议。"""

import argparse
import json
import os
import sys

from geometry import cleanup_stale_partials, import_step
from distance import measure_distance


def serve(data_dir, storage_root=None, expected_root=None):
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 1024 * 1024:
                raise ValueError('请求超过大小限制。')
            request = json.loads(line)
            request_id = request.get('id')
            method = request.get('method')
            if not isinstance(request_id, str) or method not in (
                'scene_import',
                'scene_measure_distance',
            ):
                raise ValueError('场景请求无效。')
            params = request.get('params')
            if not isinstance(params, dict):
                raise ValueError('场景请求参数无效。')
            if method == 'scene_import' and not isinstance(params.get('path'), str):
                raise ValueError('请选择 STEP 文件。')
            # OCCT 直接向文件描述符输出诊断，不能混入 JSON 协议流。
            sys.stdout.flush()
            stdout_fd = os.dup(sys.stdout.fileno())
            try:
                os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
                if method == 'scene_import':
                    result = import_step(
                        params['path'],
                        data_dir,
                        storage_root=storage_root,
                        expected_root=expected_root,
                    )
                else:
                    result = measure_distance(params.get('first'), params.get('second'))
                sys.stdout.flush()
            finally:
                os.dup2(stdout_fd, sys.stdout.fileno())
                os.close(stdout_fd)
            response = {'id': request_id, 'ok': True, 'result': result}
        except Exception as error:
            response = {'id': request_id, 'ok': False, 'error': {'message': str(error)}}
        print(json.dumps(response, ensure_ascii=False, separators=(',', ':')), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project-id', required=True)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--storage-root')
    parser.add_argument('--root-dev')
    parser.add_argument('--root-ino')
    arguments = parser.parse_args()
    if (arguments.root_dev is None) != (arguments.root_ino is None):
        parser.error('数据根身份必须同时包含设备和 inode。')
    expected_root = (
        {'dev': arguments.root_dev, 'ino': arguments.root_ino}
        if arguments.root_dev is not None
        else None
    )
    cleanup_stale_partials(arguments.data_dir, arguments.storage_root, expected_root)
    serve(arguments.data_dir, arguments.storage_root, expected_root)


if __name__ == '__main__':
    main()
