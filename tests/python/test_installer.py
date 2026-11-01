import importlib.util
from pathlib import Path
import tempfile
import unittest
import sys
import subprocess
import time
import os
import signal

script = Path(__file__).resolve().parents[2] / 'packages/scene/python/install.py'
spec = importlib.util.spec_from_file_location('scene_installer', script)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTest(unittest.TestCase):
    @unittest.skipUnless(sys.version_info[:2] == (3, 12), '场景安装器当前要求 Python 3.12')
    def test_existing_environment_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            existing = Path(directory) / 'python' / 'scene'
            existing.mkdir(parents=True)
            marker = existing / 'user-data'
            marker.write_text('preserve')
            with self.assertRaises(FileExistsError):
                installer.install(directory)
            self.assertEqual(marker.read_text(), 'preserve')

    @unittest.skipUnless(sys.version_info[:2] == (3, 12), '场景安装器当前要求 Python 3.12')
    def test_offline_failure_rolls_back_only_the_new_environment_and_can_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'data'
            wheelhouse = Path(directory) / 'empty-wheels'
            wheelhouse.mkdir()
            root.mkdir()
            marker = root / 'existing-user-data'
            marker.write_text('preserve')
            destination = root / 'python' / 'scene'
            for _ in range(2):
                with self.assertRaises(subprocess.CalledProcessError):
                    installer.install(root, wheelhouse)
                self.assertFalse(destination.exists())
                self.assertEqual(marker.read_text(), 'preserve')

    @unittest.skipUnless(
        sys.version_info[:2] == (3, 12) and os.name == 'posix', '需要 POSIX 和 Python 3.12'
    )
    def test_termination_stops_installer_child_and_rolls_back_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'data'
            child_pid = Path(directory) / 'child-pid'
            # 启动真正的系统子进程，替换耗时 pip 以稳定复现安装期间退出。
            wrapper = """import importlib.util,sys,subprocess
spec=importlib.util.spec_from_file_location('install',sys.argv[1]); mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
original=subprocess.Popen
pid_path=sys.argv[3]
def fake_pip(args,*a,**kw):
    if '-m' in args and 'pip' in args:
        args=[sys.executable,'-c','import os,sys,time;open(sys.argv[1],"w").write(str(os.getpid()));time.sleep(60)',pid_path]
    return original(args,*a,**kw)
mod.subprocess.Popen=fake_pip
sys.argv=[sys.argv[1],'--data-root',sys.argv[2]]
raise SystemExit(mod.main())
"""
            process = subprocess.Popen(
                [sys.executable, '-c', wrapper, str(script), str(root), str(child_pid)]
            )
            try:
                deadline = time.monotonic() + 10
                while (
                    not child_pid.exists()
                    and process.poll() is None
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.02)
                self.assertTrue(child_pid.exists(), '模拟安装子进程没有启动')
                pid = int(child_pid.read_text())
                process.terminate()
                process.wait(timeout=10)
                self.assertFalse((root / 'python' / 'scene').exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                if child_pid.exists():
                    try:
                        os.kill(int(child_pid.read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == '__main__':
    unittest.main()
