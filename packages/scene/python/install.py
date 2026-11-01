"""在 Dai 数据根创建场景专用 Python 环境。可从预下载的 wheels 离线安装。"""

import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import venv


def _run(command, env):
    # 单独进程组便于安装中退出时连同 pip 的子进程一起终止。
    process = subprocess.Popen(command, env=env, start_new_session=os.name == 'posix')
    try:
        code = process.wait()
    except BaseException:
        if process.poll() is None:
            try:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait()
            except ProcessLookupError:
                process.wait()
        raise
    if code:
        raise subprocess.CalledProcessError(code, command)


def install(data_root, wheelhouse=None):
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError('场景环境当前要求 Python 3.12。')
    destination = Path(data_root).expanduser().resolve() / 'python' / 'scene'
    destination.parent.mkdir(parents=True, exist_ok=True)
    # 不覆盖或删除用户已有环境；版本更新应使用新的受控安装流程。
    destination.mkdir()
    executable = destination / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    env = os.environ.copy()
    env.pop('PYTHONPATH', None)
    env.pop('PYTHONHOME', None)
    try:
        # 发行版可能未提供 ensurepip；用宿主 pip 的 --python 明确安装到隔离环境。
        venv.EnvBuilder(with_pip=False).create(destination)
        command = [
            sys.executable,
            '-m',
            'pip',
            '--python',
            str(executable),
            'install',
            '--no-deps',
            '--only-binary=:all:',
        ]
        if wheelhouse:
            command.extend(['--no-index', '--find-links', str(Path(wheelhouse).resolve())])
        command.extend(['-r', str(Path(__file__).with_name('requirements.txt'))])
        _run(command, env)
        _run(
            [
                str(executable),
                '-c',
                'import vtkmodules.vtkCommonCore; '
                'from OCP.STEPCAFControl import STEPCAFControl_Reader; '
                'from OCP.BRepMesh import BRepMesh_IncrementalMesh',
            ],
            env,
        )
    except BaseException:
        shutil.rmtree(destination)
        raise
    return executable


def main():
    def terminate(signum, _frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', required=True, help='Dai 数据根（默认情况下为 ~/.dai）')
    parser.add_argument('--wheelhouse', help='可选：已下载依赖 wheel 的目录，用于离线安装')
    arguments = parser.parse_args()
    try:
        print(install(arguments.data_root, arguments.wheelhouse))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'场景 Python 环境安装失败：{error}', file=sys.stderr)
        print(
            '请确认已安装 Python 3.12、venv 和支持 --python 的 pip；已有环境不会被覆盖。',
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
