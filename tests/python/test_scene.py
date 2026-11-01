import hashlib
import itertools
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/scene/python'))

try:
    import vtkmodules.vtkCommonCore  # noqa: F401  # 预加载 OCCT 的动态库依赖
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    HAS_OCC = True
except ImportError:
    HAS_OCC = False


@unittest.skipUnless(HAS_OCC, '需要安装 packages/scene/python/requirements.txt 中的几何依赖')
class SceneImportTest(unittest.TestCase):
    def test_assembly_instances_and_color_survive_step_import(self):
        from assembly_fixture import write_assembly
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'assembly.step'
            write_assembly(source)
            result = import_step(str(source), str(root / 'data'))
            payload = Path(result['resource']['path']).read_bytes()
            json_len = struct.unpack_from('<I', payload, 12)[0]
            document = json.loads(payload[20 : 20 + json_len])
            objects = {item['name']: item for item in result['objects']}
            self.assertEqual(set(objects), {'Root', 'SubInstance', 'FirstBlock', 'SecondBlock'})
            self.assertEqual(objects['SubInstance']['parentId'], objects['Root']['id'])
            self.assertEqual(objects['FirstBlock']['parentId'], objects['SubInstance']['id'])
            self.assertEqual(objects['SecondBlock']['parentId'], objects['SubInstance']['id'])
            first = document['nodes'][objects['FirstBlock']['gltfNode']]
            second = document['nodes'][objects['SecondBlock']['gltfNode']]
            self.assertNotEqual(first['extras']['daiObjectId'], second['extras']['daiObjectId'])
            self.assertEqual(first['translation'], [0.0, 0.04, 0.0])
            self.assertEqual(second['translation'], [0.06, 0.0, 0.0])
            self.assertAlmostEqual(abs(second['rotation'][2]), 2**-0.5)
            self.assertAlmostEqual(abs(second['rotation'][3]), 2**-0.5)
            self.assertEqual(
                objects['FirstBlock']['baseTransform']['position'], first['translation']
            )
            self.assertEqual(
                objects['SecondBlock']['baseTransform']['rotation'], second['rotation']
            )
            self.assertNotIn('geometryBounds', objects['Root'])
            self.assertNotIn('geometryBounds', objects['SubInstance'])
            first_bounds = objects['FirstBlock']['geometryBounds']
            second_bounds = objects['SecondBlock']['geometryBounds']
            self.assertEqual(first_bounds, second_bounds)
            self.assertEqual(first_bounds['unit'], 'm')
            self.assertEqual(first_bounds['space'], 'object-local')
            for actual, expected in zip(first_bounds['min'], [0, 0, 0]):
                self.assertAlmostEqual(actual, expected, places=6)
            for actual, expected in zip(first_bounds['max'], [0.01, 0.02, 0.03]):
                self.assertAlmostEqual(actual, expected, places=6)
            for actual, expected in zip(first_bounds['size'], [0.01, 0.02, 0.03]):
                self.assertAlmostEqual(actual, expected, places=6)
            # 第二个实例绕 Z 轴旋转 90° 后再平移：局部边界本身不变，父坐标边界随之变化。
            x, y, z, w = objects['SecondBlock']['baseTransform']['rotation']
            tx, ty, tz = objects['SecondBlock']['baseTransform']['position']
            corners = []
            for px, py, pz in itertools.product(*zip(first_bounds['min'], first_bounds['max'])):
                cross = [y * pz - z * py, z * px - x * pz, x * py - y * px]
                second_cross = [
                    y * cross[2] - z * cross[1],
                    z * cross[0] - x * cross[2],
                    x * cross[1] - y * cross[0],
                ]
                corners.append(
                    [
                        px + 2 * (w * cross[0] + second_cross[0]) + tx,
                        py + 2 * (w * cross[1] + second_cross[1]) + ty,
                        pz + 2 * (w * cross[2] + second_cross[2]) + tz,
                    ]
                )
            for actual, expected in zip(
                [min(point[i] for point in corners) for i in range(3)], [0.04, 0, 0]
            ):
                self.assertAlmostEqual(actual, expected, places=6)
            for actual, expected in zip(
                [max(point[i] for point in corners) for i in range(3)], [0.06, 0.01, 0.03]
            ):
                self.assertAlmostEqual(actual, expected, places=6)
            mesh_a = document['meshes'][first['mesh']]['primitives'][0]
            mesh_b = document['meshes'][second['mesh']]['primitives'][0]
            self.assertEqual(mesh_a['attributes']['POSITION'], mesh_b['attributes']['POSITION'])
            rgba = document['materials'][mesh_a['material']]['pbrMetallicRoughness'][
                'baseColorFactor'
            ]
            for actual, expected in zip(rgba, [0.8, 0.1, 0.2, 1.0]):
                self.assertAlmostEqual(actual, expected, places=5)
            self.assertFalse(result['complete'])
            self.assertTrue(result['warnings'])

    def test_repeated_subassembly_keeps_distinct_object_paths(self):
        from assembly_fixture import write_assembly
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'repeated.step'
            write_assembly(source, repeat_subassembly=True)
            result = import_step(str(source), str(root / 'data'))
            objects = result['objects']
            self.assertEqual(len(objects), 7)
            repeated = [item for item in objects if item['name'] == 'FirstBlock']
            self.assertEqual(len(repeated), 2)
            self.assertEqual(len({item['id'] for item in repeated}), 2)
            self.assertEqual(len({item['sourceKey'] for item in repeated}), 2)
            self.assertEqual(len({item['parentId'] for item in repeated}), 2)
            self.assertEqual(repeated[0]['geometryBounds'], repeated[1]['geometryBounds'])

    def test_import_real_step_without_copying_source(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'outside' / 'box.step'
            source.parent.mkdir()
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            original = source.read_bytes()
            result = import_step(str(source), str(root / 'data'))
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(
                result['source'],
                {'path': str(source), 'sha256': hashlib.sha256(original).hexdigest()},
            )
            resource = Path(result['resource']['path'])
            self.assertEqual(resource.parent, root / 'data' / 'staging')
            payload = resource.read_bytes()
            self.assertEqual(result['resource']['sha256'], hashlib.sha256(payload).hexdigest())
            self.assertEqual(result['resource']['byteLength'], len(payload))
            magic, version, length = struct.unpack_from('<4sII', payload)
            self.assertEqual((magic, version, length), (b'glTF', 2, len(payload)))
            json_len, json_kind = struct.unpack_from('<I4s', payload, 12)
            self.assertEqual(json_kind, b'JSON')
            document = json.loads(payload[20 : 20 + json_len])
            primitives = document['meshes'][0]['primitives']
            positions = [
                document['accessors'][item['attributes']['POSITION']] for item in primitives
            ]
            self.assertGreaterEqual(sum(item['count'] for item in positions), 24)
            bounds = [max(item['max'][axis] for item in positions) for axis in range(3)]
            for actual, expected in zip(bounds, [0.01, 0.02, 0.03]):
                self.assertAlmostEqual(actual, expected, places=5)
            basis = document['nodes'][document['scenes'][0]['nodes'][0]]
            self.assertAlmostEqual(basis['rotation'][0], -(2**-0.5))
            self.assertAlmostEqual(basis['rotation'][3], 2**-0.5)
            self.assertFalse(result['complete'])
            self.assertTrue(result['warnings'])

    def test_invalid_input_does_not_produce_a_resource(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'bad.step'
            source.write_text('not a STEP file')
            with self.assertRaises(ValueError):
                import_step(str(source), str(Path(directory) / 'data'))
            self.assertFalse(list(Path(directory).rglob('*.glb')))

    @unittest.skipUnless(hasattr(os, 'symlink'), '需要支持符号链接')
    def test_symlink_in_storage_path_cannot_write_outside_data_root(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            data_root = root / 'data'
            outside = root / 'outside'
            data_root.mkdir()
            outside.mkdir()
            sentinel = outside / 'untouched.txt'
            sentinel.write_text('untouched')
            (data_root / 'projects').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, '符号链接|目录'):
                import_step(
                    str(source),
                    str(data_root / 'projects' / 'project' / 'scene'),
                    storage_root=str(data_root),
                )
            self.assertEqual(sorted(item.name for item in outside.iterdir()), ['untouched.txt'])
            self.assertEqual(sentinel.read_text(), 'untouched')

    @unittest.skipUnless(hasattr(os, 'symlink'), '需要支持符号链接')
    def test_symlink_staging_cannot_write_outside_data_root(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            data_root = root / 'data'
            scene = data_root / 'projects' / 'project' / 'scene'
            scene.mkdir(parents=True)
            outside = root / 'outside'
            outside.mkdir()
            (scene / 'staging').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, '符号链接|目录'):
                import_step(str(source), str(scene), storage_root=str(data_root))
            self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(hasattr(os, 'symlink'), '需要支持符号链接')
    def test_explicitly_configured_data_root_may_be_a_symlink(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            actual = root / 'actual-data'
            actual.mkdir()
            alias = root / 'data-alias'
            alias.symlink_to(actual, target_is_directory=True)
            scene = alias / 'projects' / 'project' / 'scene'
            result = import_step(str(source), str(scene), storage_root=str(alias))
            resource = Path(result['resource']['path'])
            self.assertTrue(resource.is_file())
            self.assertTrue(resource.is_relative_to(actual))
            # 生产后端会先把项目目录规范化为 realpath，再交给 worker。
            canonical_scene = actual / 'projects' / 'project' / 'scene'
            second = import_step(str(source), str(canonical_scene), storage_root=str(alias))
            self.assertTrue(Path(second['resource']['path']).is_file())

    @unittest.skipUnless(sys.platform.startswith('linux'), '需要 Linux 目录句柄')
    def test_staging_swap_after_open_does_not_redirect_output(self):
        import geometry

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            data_root = root / 'data'
            scene = data_root / 'projects' / 'project' / 'scene'
            scene.mkdir(parents=True)
            outside = root / 'outside'
            outside.mkdir()
            original = geometry._secure_staging

            def swap_after_open(data_dir, storage_root, expected_root=None):
                result = original(data_dir, storage_root, expected_root)
                staging = result[0]
                staging.rename(staging.with_name('detached-staging'))
                staging.symlink_to(outside, target_is_directory=True)
                return result

            with patch.object(geometry, '_secure_staging', side_effect=swap_after_open):
                with self.assertRaisesRegex(ValueError, '变化'):
                    geometry.import_step(str(source), str(scene), storage_root=str(data_root))
            self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(sys.platform.startswith('linux'), '需要 Linux 文件句柄')
    def test_partial_file_swapped_before_validation_is_rejected(self):
        import geometry

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            outside = root / 'outside.glb'
            outside.write_bytes(b'outside unchanged')
            original = geometry._create_partial

            def swap_after_create(directory, directory_fd):
                result = original(directory, directory_fd)
                result[1].unlink()
                result[1].symlink_to(outside)
                return result

            error = None
            with patch.object(geometry, '_create_partial', side_effect=swap_after_create):
                try:
                    geometry.import_step(str(source), str(root / 'data'))
                except ValueError as caught:
                    error = caught
            self.assertEqual(
                hashlib.sha256(outside.read_bytes()).digest(),
                hashlib.sha256(b'outside unchanged').digest(),
            )
            self.assertIsNotNone(error)

    def test_length_unit_declared_in_step_controls_reported_metres(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'metres.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            text = source.read_text()
            self.assertIn('SI_UNIT(.MILLI.,.METRE.)', text)
            source.write_text(text.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT($,.METRE.)'))
            result = import_step(str(source), str(root / 'data'))
            bounds = next(
                item['geometryBounds'] for item in result['objects'] if 'geometryBounds' in item
            )
            for actual, expected in zip(bounds['size'], [10, 20, 30]):
                self.assertAlmostEqual(actual, expected, places=5)

    def test_unresolved_length_unit_does_not_generate_resource(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'missing-unit.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            text = source.read_text()
            self.assertIn('SI_UNIT(.MILLI.,.METRE.)', text)
            source.write_text(text.replace('SI_UNIT(.MILLI.,.METRE.)', 'LENGTH_UNIT()'))
            with self.assertRaisesRegex(ValueError, '单位'):
                import_step(str(source), str(root / 'data'))
            self.assertFalse(list((root / 'data').rglob('*.glb')))

    def test_worker_imports_real_step_over_json_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'box.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            worker = Path(__file__).resolve().parents[2] / 'packages/scene/python/worker.py'
            requests = [
                {'id': 'one', 'method': 'scene_import', 'params': {'path': str(source)}},
                {
                    'id': 'two',
                    'method': 'scene_import',
                    'params': {'path': str(root / 'missing.step')},
                },
            ]
            process = subprocess.run(
                [
                    sys.executable,
                    '-u',
                    str(worker),
                    '--project-id',
                    'test',
                    '--data-dir',
                    str(root / 'data'),
                ],
                input=''.join(json.dumps(item) + '\n' for item in requests),
                capture_output=True,
                text=True,
                timeout=30,
                check=True,
            )
            replies = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual([reply['id'] for reply in replies], ['one', 'two'])
            self.assertTrue(replies[0]['ok'])
            self.assertTrue(Path(replies[0]['result']['resource']['path']).is_file())
            self.assertFalse(replies[1]['ok'])


if __name__ == '__main__':
    unittest.main()
