"""用真实 STEP 和 XCAF 数据验证 GLB 的颜色、法线、实例和尺寸限制。"""

import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/scene/python'))

import vtkmodules.vtkCommonCore  # noqa: F401
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Pnt, gp_Trsf, gp_Vec

from geometry import import_step
from gltf import create_glb


def decode(payload):
    length = struct.unpack_from('<I', payload, 12)[0]
    gltf = json.loads(payload[20 : 20 + length])
    return gltf, payload[20 + length + 8 :]


class GltfGeometryTest(unittest.TestCase):
    def test_step_colors_inherit_and_override_per_instance_and_face(self):
        with tempfile.TemporaryDirectory() as directory:
            document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
            shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
            colors = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
            part = shapes.AddShape(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), False)
            shape = shapes.GetShape_s(part)
            faces = TopExp_Explorer(shape, TopAbs_FACE)
            face_label = shapes.AddSubShape(part, faces.Current())
            colors.SetColor(
                face_label, Quantity_Color(1, 0, 0, Quantity_TOC_RGB), XCAFDoc_ColorSurf
            )
            assembly = shapes.NewShape()
            TDataStd_Name.Set_s(assembly, TCollection_ExtendedString('Assembly'))
            colors.SetColor(assembly, Quantity_Color(0, 0, 1, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
            first = shapes.AddComponent(assembly, part, TopLoc_Location())
            TDataStd_Name.Set_s(first, TCollection_ExtendedString('Override'))
            colors.SetColor(first, Quantity_Color(0, 1, 0, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
            transform = gp_Trsf()
            transform.SetTranslationPart(gp_Vec(40, 0, 0))
            second = shapes.AddComponent(assembly, part, TopLoc_Location(transform))
            TDataStd_Name.Set_s(second, TCollection_ExtendedString('Inherited'))
            shapes.UpdateAssemblies()
            source = Path(directory) / 'colors.step'
            writer = STEPCAFControl_Writer()
            writer.SetColorMode(True)
            writer.SetNameMode(True)
            self.assertTrue(writer.Transfer(document))
            writer.Write(str(source))
            result = import_step(str(source), str(Path(directory) / 'data'))
            gltf, _ = decode(Path(result['resource']['path']).read_bytes())
            records = {record['name']: record for record in result['objects']}

            def mesh_colors(name):
                node = gltf['nodes'][records[name]['gltfNode']]
                return {
                    tuple(
                        round(value, 5)
                        for value in gltf['materials'][primitive['material']][
                            'pbrMetallicRoughness'
                        ]['baseColorFactor']
                    )
                    for primitive in gltf['meshes'][node['mesh']]['primitives']
                }

            self.assertEqual(mesh_colors('Override'), {(0, 1, 0, 1)})
            # STEP 写入器没有保留根装配颜色；源中保留的面颜色仍可读。
            self.assertEqual(mesh_colors('Inherited'), {(1, 0, 0, 1), (0.8, 0.8, 0.8, 1)})
            BRepMesh_IncrementalMesh(shape, 0.1, False, 0.5, True)
            in_memory = [
                {
                    'id': 'root',
                    'name': 'Assembly',
                    'parentId': None,
                    '_label': assembly,
                    '_definition': assembly,
                },
                {
                    'id': 'first',
                    'name': 'Override',
                    'parentId': 'root',
                    '_label': first,
                    '_definition': part,
                    '_geometryKey': 'part',
                },
                {
                    'id': 'second',
                    'name': 'Inherited',
                    'parentId': 'root',
                    '_label': second,
                    '_definition': part,
                    '_geometryKey': 'part',
                },
            ]
            direct, _ = decode(create_glb(document, shapes, in_memory, {'part': part}, 1024 * 1024))

            def direct_colors(index):
                mesh = direct['meshes'][direct['nodes'][in_memory[index]['gltfNode']]['mesh']]
                return {
                    tuple(
                        round(v, 5)
                        for v in direct['materials'][p['material']]['pbrMetallicRoughness'][
                            'baseColorFactor'
                        ]
                    )
                    for p in mesh['primitives']
                }

            self.assertEqual(direct_colors(1), {(0, 1, 0, 1)})
            self.assertEqual(direct_colors(2), {(1, 0, 0, 1), (0, 0, 1, 1)})

    def test_box_triangle_winding_and_normals_point_outward(self):
        with tempfile.TemporaryDirectory() as directory:
            from assembly_fixture import write_assembly

            source = Path(directory) / 'assembly.step'
            write_assembly(source)
            result = import_step(str(source), str(Path(directory) / 'data'))
            gltf, binary = decode(Path(result['resource']['path']).read_bytes())
            primitive = gltf['meshes'][0]['primitives'][0]

            def read_accessor(index, code, width):
                accessor = gltf['accessors'][index]
                view = gltf['bufferViews'][accessor['bufferView']]
                return [
                    struct.unpack_from(
                        '<' + code * width, binary, view.get('byteOffset', 0) + offset * width * 4
                    )
                    for offset in range(accessor['count'])
                ]

            positions = read_accessor(primitive['attributes']['POSITION'], 'f', 3)
            normals = read_accessor(primitive['attributes']['NORMAL'], 'f', 3)
            indices = [item[0] for item in read_accessor(primitive['indices'], 'I', 1)]
            center = (0.005, 0.01, 0.015)
            for point, normal in zip(positions, normals):
                self.assertGreater(sum((point[i] - center[i]) * normal[i] for i in range(3)), 0)
            for offset in range(0, len(indices), 3):
                a, b, c = (positions[indices[offset + i]] for i in range(3))
                u = [b[i] - a[i] for i in range(3)]
                v = [c[i] - a[i] for i in range(3)]
                cross = (
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                )
                self.assertGreater(sum(cross[i] * normals[indices[offset]][i] for i in range(3)), 0)

    def test_negative_and_positive_scale_are_preserved_but_not_rigid(self):
        document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
        shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
        shape = BRepPrimAPI_MakeBox(10, 20, 30).Shape()
        BRepMesh_IncrementalMesh(shape, 0.1, False, 0.5, True)
        part = shapes.AddShape(shape, False)
        root = shapes.NewShape()
        records = [
            {'id': 'root', 'name': 'Root', 'parentId': None, '_label': root, '_definition': root}
        ]
        for index, scale in enumerate((-1, 2)):
            transformation = gp_Trsf()
            transformation.SetScale(gp_Pnt(0, 0, 0), scale)
            label = shapes.AddComponent(root, part, TopLoc_Location(transformation))
            records.append(
                {
                    'id': str(index),
                    'name': str(index),
                    'parentId': 'root',
                    '_label': label,
                    '_definition': part,
                    '_geometryKey': 'part',
                }
            )
        gltf, _ = decode(create_glb(document, shapes, records, {'part': part}, 1024 * 1024))
        for record, scale in zip(records[1:], (-1, 2)):
            self.assertEqual(gltf['nodes'][record['gltfNode']]['scale'], [scale] * 3)
            self.assertFalse(record['rigidTransform'])

    def test_resource_size_limit_fails_before_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            from assembly_fixture import write_assembly

            source = Path(directory) / 'assembly.step'
            write_assembly(source)
            with patch('geometry.MAX_RESOURCE_BYTES', 128):
                with self.assertRaisesRegex(ValueError, '大小限制'):
                    import_step(str(source), str(Path(directory) / 'data'))
            self.assertFalse((Path(directory) / 'data' / 'staging').exists())
