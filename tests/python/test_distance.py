import hashlib
import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/scene/python'))
try:
    import vtkmodules.vtkCommonCore  # noqa: F401  # 预加载 OCCT 的动态库依赖
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

    HAS_OCC = True
except ImportError:
    HAS_OCC = False


@unittest.skipUnless(HAS_OCC, '需要安装场景几何依赖')
class DistanceTest(unittest.TestCase):
    def test_real_step_instances_parent_rotation_and_edited_pose(self):
        from assembly_fixture import write_assembly
        from geometry import import_step
        from distance import measure_distance

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'assembly.step'
            other_source = root / 'other.step'
            write_assembly(source, rotate_parent=True)
            write_assembly(other_source, rotate_parent=True)
            original = source.read_bytes()
            result = import_step(str(source), str(root / 'data'))
            objects = {item['name']: item for item in result['objects']}
            first = objects['FirstBlock']
            second = objects['SecondBlock']
            q = math.sqrt(0.5)

            def ref(path, object, position, rotation):
                return {
                    'source': {
                        'path': str(path),
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    },
                    'sourceKey': object['sourceKey'],
                    'worldTransform': {'position': position, 'rotation': rotation},
                }

            a = ref(source, first, [-0.04, 0, 0.08], [0, 0, q, q])
            b = ref(source, second, [0, 0.06, 0.08], [0, 0, 1, 0])
            distance = measure_distance(a, b)
            self.assertAlmostEqual(distance['shapeDistanceM'], math.hypot(0.03, 0.03), places=7)
            self.assertEqual(distance['collision'], 'unknown')
            self.assertIsNone(distance['surfaceDistanceM'])
            self.assertEqual(distance['unit'], 'm')
            self.assertEqual(distance['space'], 'world-z-up')
            self.assertFalse(distance['innerSolution'])
            self.assertEqual(len(distance['firstPoint']), 3)
            edited = ref(source, second, [-0.04, 0.03, 0.08], [0, 0, 1, 0])
            self.assertAlmostEqual(measure_distance(a, edited)['shapeDistanceM'], 0, places=7)
            distinct = ref(other_source, first, [0.05, 0, 0], [0, 0, 0, 1])
            origin = ref(source, first, [0, 0, 0], [0, 0, 0, 1])
            self.assertAlmostEqual(
                measure_distance(origin, distinct)['shapeDistanceM'], 0.04, places=7
            )
            self.assertEqual(source.read_bytes(), original)

    def test_inside_touch_and_source_changes_are_not_misreported(self):
        from geometry import import_step
        from distance import measure_distance

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def make_box(name, size):
                path = root / name
                writer = STEPControl_Writer()
                self.assertEqual(
                    writer.Transfer(BRepPrimAPI_MakeBox(*size).Shape(), STEPControl_AsIs),
                    IFSelect_RetDone,
                )
                self.assertEqual(writer.Write(str(path)), IFSelect_RetDone)
                item = import_step(str(path), str(root / (name + '-data')))
                return path, item['objects'][0]['sourceKey']

            big, big_key = make_box('big.step', (10, 20, 30))
            small, small_key = make_box('small.step', (2, 2, 2))

            def ref(path, key, position):
                return {
                    'source': {
                        'path': str(path),
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                    },
                    'sourceKey': key,
                    'worldTransform': {'position': position, 'rotation': [0, 0, 0, 1]},
                }

            a, b = ref(big, big_key, [0, 0, 0]), ref(small, small_key, [0.002, 0.002, 0.002])
            inside = measure_distance(a, b)
            self.assertAlmostEqual(inside['shapeDistanceM'], 0, places=8)
            self.assertTrue(inside['innerSolution'])
            self.assertIsNone(inside['firstPoint'])
            self.assertIsNone(inside['secondPoint'])
            self.assertEqual(inside['collision'], 'unknown')
            crossing = ref(small, small_key, [0.009, 0, 0])
            self.assertAlmostEqual(measure_distance(a, crossing)['shapeDistanceM'], 0, places=8)
            touch = ref(small, small_key, [0.01, 0, 0])
            self.assertAlmostEqual(measure_distance(a, touch)['shapeDistanceM'], 0, places=8)
            small.write_bytes(small.read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, '变化|哈希'):
                measure_distance(a, b)
            small.unlink()
            with self.assertRaisesRegex(ValueError, '不存在|读取'):
                measure_distance(a, b)
