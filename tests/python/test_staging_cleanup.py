import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

try:
    import vtkmodules.vtkCommonCore  # noqa: F401  # 预加载 OCCT 的动态库依赖
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    HAS_OCC = True
except ImportError:
    HAS_OCC = False


@unittest.skipUnless(HAS_OCC and sys.platform.startswith('linux'), '需要 Linux 和场景几何依赖')
class StagingCleanupTest(unittest.TestCase):
    def test_restarted_worker_cleans_only_dead_workers_verified_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            source_before = source.read_bytes()
            data_root = root / 'data'
            scene = data_root / 'projects' / 'project' / 'scene'
            scene.mkdir(parents=True)
            resources = scene / 'resources'
            resources.mkdir()
            (resources / 'committed.glb').write_bytes(b'committed')
            marker = root / 'marker'
            python_dir = Path(__file__).resolve().parents[2] / 'packages/scene/python'
            code = """import sys,time;from pathlib import Path
sys.path.insert(0,sys.argv[1]);import geometry
original=geometry._create_partial
def paused(*args,**kwargs):
 result=original(*args,**kwargs);Path(sys.argv[4]).write_text(result[1].name);time.sleep(60);return result
geometry._create_partial=paused
geometry.import_step(sys.argv[2],sys.argv[3],storage_root=sys.argv[5])
"""
            process = subprocess.Popen(
                [
                    sys.executable,
                    '-c',
                    code,
                    str(python_dir),
                    str(source),
                    str(scene),
                    str(marker),
                    str(data_root),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                deadline = time.monotonic() + 10
                while (
                    not marker.exists() and process.poll() is None and time.monotonic() < deadline
                ):
                    time.sleep(0.02)
                self.assertTrue(marker.exists(), '临时文件生成步骤没有执行')
                partial = scene / 'staging' / marker.read_text()
                lease = Path(str(partial) + '.lease')
                self.assertTrue(partial.is_file())
                self.assertTrue(lease.is_file())
                process.terminate()
                process.wait(timeout=5)
                self.assertTrue(partial.exists(), '预期 SIGTERM 后留下未提交的暂存文件')
                unrelated = scene / 'staging' / 'user-file.glb'
                unrelated.write_bytes(b'user data')
                legacy = scene / 'staging' / 'tmp-old.glb'
                legacy.write_bytes(b'unknown origin')
                outside = root / 'outside'
                outside.write_bytes(b'outside')
                link = scene / 'staging' / f'.dai-partial-{process.pid}-fakefake.glb'
                link.symlink_to(outside)
                link_lease = Path(str(link) + '.lease')
                fake_info = outside.stat()
                link_lease.write_text(
                    json.dumps(
                        {
                            'pid': process.pid,
                            'name': link.name,
                            'dev': fake_info.st_dev,
                            'ino': fake_info.st_ino,
                        }
                    )
                )
                live = scene / 'staging' / f'.dai-partial-{os.getpid()}-livefile.glb'
                live.write_bytes(b'active')
                info = live.stat()
                live_lease = Path(str(live) + '.lease')
                live_lease.write_text(
                    json.dumps(
                        {
                            'pid': os.getpid(),
                            'name': live.name,
                            'dev': info.st_dev,
                            'ino': info.st_ino,
                        }
                    )
                )
                subprocess.run(
                    [
                        sys.executable,
                        '-u',
                        str(python_dir / 'worker.py'),
                        '--project-id',
                        'project',
                        '--data-dir',
                        str(scene),
                        '--storage-root',
                        str(data_root),
                    ],
                    input='',
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=10,
                )
                self.assertFalse(partial.exists())
                self.assertFalse(lease.exists())
                self.assertEqual(unrelated.read_bytes(), b'user data')
                self.assertEqual(legacy.read_bytes(), b'unknown origin')
                self.assertTrue(link.is_symlink())
                self.assertTrue(link_lease.exists())
                self.assertEqual(outside.read_bytes(), b'outside')
                self.assertEqual(live.read_bytes(), b'active')
                self.assertTrue(live_lease.exists())
                self.assertEqual((resources / 'committed.glb').read_bytes(), b'committed')
                self.assertEqual(source.read_bytes(), source_before)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
