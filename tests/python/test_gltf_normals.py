"""通过真实 STEP 验证生成的 glTF 曲面法线。"""

import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/scene/python'))
try:
    import vtkmodules.vtkCommonCore  # noqa: F401
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder  # noqa: F401

    HAS_OCC = True
except ImportError:
    HAS_OCC = False


@unittest.skipUnless(HAS_OCC, '需要安装场景几何依赖')
class GltfNormalTest(unittest.TestCase):
    def test_cylinder_side_normals_are_unit_and_point_outward(self):
        from assembly_fixture import write_cylinder_assembly
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'cylinder.step'
            write_cylinder_assembly(source)
            result = import_step(str(source), str(root / 'data'))
            raw = Path(result['resource']['path']).read_bytes()
            metadata_length = struct.unpack_from('<I', raw, 12)[0]
            document = json.loads(raw[20 : 20 + metadata_length])
            binary = raw[28 + metadata_length :]
            item = next(obj for obj in result['objects'] if obj['name'] == 'FirstCylinder')
            node = document['nodes'][item['gltfNode']]
            primitive = document['meshes'][node['mesh']]['primitives'][0]

            def vectors(index):
                accessor = document['accessors'][index]
                self.assertEqual((accessor['type'], accessor['componentType']), ('VEC3', 5126))
                view = document['bufferViews'][accessor['bufferView']]
                start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
                stride = view.get('byteStride', 12)
                return [
                    struct.unpack_from('<3f', binary, start + stride * i)
                    for i in range(accessor['count'])
                ]

            positions = vectors(primitive['attributes']['POSITION'])
            normals = vectors(primitive['attributes']['NORMAL'])
            self.assertEqual(len(positions), len(normals))
            side_count = 0
            for (x, y, z), normal in zip(positions, normals):
                length = math.sqrt(sum(value * value for value in normal))
                self.assertAlmostEqual(length, 1.0, places=5)
                # 局部圆柱轴沿 X，轴点为 (3, 4, 5) mm，半径 5 mm。
                radial_y, radial_z = y - 0.004, z - 0.005
                radius = math.hypot(radial_y, radial_z)
                if abs(radius - 0.005) < 1e-6 and abs(normal[0]) < 0.1:
                    side_count += 1
                    outward = (radial_y * normal[1] + radial_z * normal[2]) / radius
                    self.assertGreater(outward, 0.98, (x, y, z, normal, outward))
            self.assertGreater(side_count, 20)


if __name__ == '__main__':
    unittest.main()
