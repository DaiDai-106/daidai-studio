"""验证写入期间替换暂存目录项不会重定向到外部文件。"""

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/scene/python'))

try:
    import vtkmodules.vtkCommonCore  # noqa: F401
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    HAS_OCC = True
except ImportError:
    HAS_OCC = False


@unittest.skipUnless(HAS_OCC and sys.platform.startswith('linux'), '需要 Linux 和场景依赖')
class ExportSecurityTest(unittest.TestCase):
    def test_step_symlink_is_supported_and_fifo_is_rejected_without_blocking(self):
        import geometry
        from assembly_fixture import write_assembly

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.step'
            alias = root / 'alias.step'
            fifo = root / 'fifo.step'
            write_assembly(source)
            alias.symlink_to(source)
            os.mkfifo(fifo)
            result = geometry.import_step(str(alias), str(root / 'data'))
            self.assertEqual(result['source']['path'], str(alias))
            original_open = os.open
            checked = False

            def guarded_open(path, flags, *args, **kwargs):
                nonlocal checked
                if Path(path) == fifo:
                    checked = True
                    self.assertTrue(flags & os.O_NONBLOCK)
                return original_open(path, flags, *args, **kwargs)

            with patch.object(geometry.os, 'open', side_effect=guarded_open):
                with self.assertRaisesRegex(ValueError, '普通文件'):
                    geometry.import_step(str(fifo), str(root / 'data'))
            self.assertTrue(checked)

    def test_replacing_step_with_fifo_during_reader_call_does_not_block(self):
        import geometry
        import OCP.STEPCAFControl as step_control
        from assembly_fixture import write_assembly

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.step'
            write_assembly(source)
            original = step_control.STEPCAFControl_Reader
            swapped = False

            class SwapBeforeRead:
                def __init__(self):
                    self.reader = original()

                def __getattr__(self, name):
                    return getattr(self.reader, name)

                def ReadFile(self, path):
                    nonlocal swapped
                    self_path = str(path)
                    if not self_path.startswith('/proc/self/fd/'):
                        raise AssertionError('STEP reader 必须使用已固定的文件句柄')
                    source.unlink()
                    os.mkfifo(source)
                    swapped = True
                    return self.reader.ReadFile(path)

            with patch.object(step_control, 'STEPCAFControl_Reader', SwapBeforeRead):
                with self.assertRaisesRegex(ValueError, '普通文件'):
                    geometry.import_step(str(source), str(root / 'data'))
            self.assertTrue(swapped)
            self.assertFalse((root / 'data' / 'staging').exists())

    def test_distance_reader_also_pins_source_before_fifo_swap(self):
        import geometry
        import distance
        import OCP.STEPCAFControl as step_control
        from assembly_fixture import write_assembly

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.step'
            write_assembly(source)
            scene = geometry.import_step(str(source), str(root / 'data'))
            leaf = next(item for item in scene['objects'] if 'geometryBounds' in item)
            selection = {
                'source': scene['source'],
                'sourceKey': leaf['sourceKey'],
                'worldTransform': {'position': [0, 0, 0], 'rotation': [0, 0, 0, 1]},
            }
            original = step_control.STEPCAFControl_Reader
            swapped = False

            class SwapBeforeRead:
                def __init__(self):
                    self.reader = original()

                def __getattr__(self, name):
                    return getattr(self.reader, name)

                def ReadFile(self, path):
                    nonlocal swapped
                    if not str(path).startswith('/proc/self/fd/'):
                        raise AssertionError('距离 reader 必须使用已固定的文件句柄')
                    source.unlink()
                    os.mkfifo(source)
                    swapped = True
                    return self.reader.ReadFile(path)

            with patch.object(step_control, 'STEPCAFControl_Reader', SwapBeforeRead):
                with self.assertRaisesRegex(ValueError, '普通文件'):
                    distance.measure_distance(selection, selection)
            self.assertTrue(swapped)

    def test_root_ancestor_replaced_after_resolve_cannot_write_outside(self):
        import geometry
        from assembly_fixture import write_assembly

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / 'parent'
            data = parent / 'data'
            data.mkdir(parents=True)
            outside = root / 'outside'
            (outside / 'data').mkdir(parents=True)
            source = root / 'source.step'
            write_assembly(source)
            original = Path.resolve
            swapped = False

            def resolve(path, strict=False):
                nonlocal swapped
                result = original(path, strict=strict)
                if path == data and strict and not swapped:
                    swapped = True
                    parent.rename(root / 'parent-held')
                    parent.symlink_to(outside, target_is_directory=True)
                return result

            with patch.object(Path, 'resolve', resolve):
                with self.assertRaises((OSError, ValueError)):
                    geometry.import_step(str(source), str(data))
            self.assertTrue(swapped)
            self.assertFalse((outside / 'data' / 'staging').exists())

    def test_root_identity_rejects_retargeted_configured_symlink(self):
        import geometry

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second, alias = root / 'first', root / 'second', root / 'data'
            first.mkdir()
            second.mkdir()
            alias.symlink_to(first, target_is_directory=True)
            info = first.stat()
            identity = {'dev': str(info.st_dev), 'ino': str(info.st_ino)}
            alias.unlink()
            alias.symlink_to(second, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, '身份已变化'):
                geometry._secure_staging(
                    str(alias / 'projects' / 'p' / 'scene'), str(alias), identity
                )
            self.assertFalse((second / 'projects').exists())

    def test_unavailable_directory_handle_fails_without_path_fallback(self):
        import geometry

        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'data'
            with patch.object(geometry.os, 'supports_dir_fd', set()):
                with self.assertRaisesRegex(RuntimeError, '目录句柄'):
                    geometry._secure_staging(str(data), str(data))
            self.assertFalse(data.exists())

    def test_swapping_after_validation_and_before_write_or_commit(self):
        import geometry

        for kind in ('symlink', 'hardlink'):
            for stage in ('write', 'rename'):
                with (
                    self.subTest(kind=kind, stage=stage),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    root = Path(directory)
                    source = root / 'source.step'
                    writer = STEPControl_Writer()
                    writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs)
                    writer.Write(str(source))
                    victim = root / 'victim'
                    victim.write_bytes(b'outside remains unchanged')
                    original_write, original_rename = os.write, geometry._rename_partial
                    changed = False

                    def swap():
                        nonlocal changed
                        if changed:
                            return
                        partial = next((root / 'data' / 'staging').glob('.dai-partial-*.glb'))
                        partial.unlink()
                        if kind == 'symlink':
                            partial.symlink_to(victim)
                        else:
                            os.link(victim, partial)
                        changed = True

                    def write(fd, data):
                        if stage == 'write':
                            swap()
                        return original_write(fd, data)

                    def rename(src, dst, directory_fd):
                        if stage == 'rename':
                            swap()
                        return original_rename(src, dst, directory_fd)

                    with (
                        patch.object(geometry.os, 'write', side_effect=write),
                        patch.object(geometry, '_rename_partial', side_effect=rename),
                    ):
                        with self.assertRaisesRegex(ValueError, '暂存文件'):
                            geometry.import_step(str(source), str(root / 'data'))
                    self.assertTrue(changed)
                    self.assertEqual(victim.read_bytes(), b'outside remains unchanged')
                    self.assertEqual(list((root / 'data' / 'staging').glob('*.glb')), [])


if __name__ == '__main__':
    unittest.main()
