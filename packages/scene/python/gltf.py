"""将已网格化的 XCAF 装配直接编码为 GLB，不让几何库按路径写文件。"""

import json
import math
import struct
import sys
from array import array


def create_glb(document, shapes, records, geometries, size_limit):
    from OCP.BRep import BRep_Tool
    from OCP.Quantity import Quantity_ColorRGBA
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    from OCP.XCAFDoc import (
        XCAFDoc_ColorGen,
        XCAFDoc_ColorSurf,
        XCAFDoc_ColorTool,
        XCAFDoc_DocumentTool,
        XCAFDoc_ShapeTool,
    )

    colors = XCAFDoc_DocumentTool.ColorTool_s(document.Main())
    binary = bytearray()
    gltf = {
        'asset': {'version': '2.0', 'generator': 'Dai'},
        'scene': 0,
        'scenes': [{'nodes': []}],
        'nodes': [],
        'meshes': [],
        'materials': [],
        'buffers': [],
        'bufferViews': [],
        'accessors': [],
    }
    materials = {}
    meshes = {}
    pending_bytes = 0

    def color(label=None, shape=None):
        value = Quantity_ColorRGBA()
        for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
            found = (
                colors.GetColor(shape, kind, value)
                if shape is not None
                else XCAFDoc_ColorTool.GetColor_s(label, kind, value)
            )
            if found:
                rgb = value.GetRGB()
                return tuple(
                    float(component)
                    for component in (rgb.Red(), rgb.Green(), rgb.Blue(), value.Alpha())
                )
        return None

    def material(rgba):
        rgba = rgba or (0.8, 0.8, 0.8, 1.0)
        if rgba not in materials:
            item = {
                'pbrMetallicRoughness': {
                    'baseColorFactor': list(rgba),
                    'metallicFactor': 0,
                    'roughnessFactor': 0.8,
                }
            }
            if rgba[3] < 1:
                item['alphaMode'] = 'BLEND'
            materials[rgba] = len(gltf['materials'])
            gltf['materials'].append(item)
        return materials[rgba]

    def accessor(payload, count, component_type, kind, target, bounds=None):
        while len(binary) % 4:
            binary.append(0)
        offset = len(binary)
        byte_length = memoryview(payload).nbytes
        if offset + byte_length > size_limit:
            raise ValueError('生成的场景资源超过大小限制。')
        binary.extend(payload)
        view = len(gltf['bufferViews'])
        gltf['bufferViews'].append(
            {'buffer': 0, 'byteOffset': offset, 'byteLength': byte_length, 'target': target}
        )
        entry = {'bufferView': view, 'componentType': component_type, 'count': count, 'type': kind}
        if bounds:
            entry['min'], entry['max'] = bounds
        result = len(gltf['accessors'])
        gltf['accessors'].append(entry)
        return result

    def make_mesh(geometry_key, override, fallback):
        nonlocal pending_bytes
        cache_key = (geometry_key, override, fallback)
        if cache_key in meshes:
            return meshes[cache_key]
        label = geometries[geometry_key]
        shape = XCAFDoc_ShapeTool.GetShape_s(label).Located(TopLoc_Location())
        inherited = color(label=label) or fallback
        # 同材质的面合并为一个 primitive，实例共享 mesh 和 buffer。
        groups = {}
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        while explorer.More():
            face = TopoDS.Face_s(explorer.Current())
            location = TopLoc_Location()
            triangulation = BRep_Tool.Triangulation_s(face, location)
            if triangulation is None or triangulation.NbTriangles() == 0:
                raise ValueError('STEP 有无法生成网格的曲面。')
            rgba = override or color(shape=face) or inherited
            group = groups.setdefault(
                rgba,
                {
                    'positions': array('f'),
                    'normals': array('f'),
                    'indices': array('I'),
                    'min': [math.inf] * 3,
                    'max': [-math.inf] * 3,
                },
            )
            positions, normals, indices = group['positions'], group['normals'], group['indices']
            base = len(positions) // 3
            pending_bytes += triangulation.NbNodes() * 24 + triangulation.NbTriangles() * 12
            if len(binary) + pending_bytes > size_limit:
                raise ValueError('生成的场景资源超过大小限制。')
            transform = location.Transformation()
            for index in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(index).Transformed(transform)
                xyz = [point.X() * 0.001, point.Y() * 0.001, point.Z() * 0.001]
                if not all(math.isfinite(value) for value in xyz):
                    raise ValueError('STEP 网格包含无效坐标。')
                positions.extend(xyz)
                normals.extend((0, 0, 0))
                for axis in range(3):
                    group['min'][axis] = min(group['min'][axis], xyz[axis])
                    group['max'][axis] = max(group['max'][axis], xyz[axis])
            for index in range(1, triangulation.NbTriangles() + 1):
                a, b, c = (base + value - 1 for value in triangulation.Triangle(index).Get())
                if face.Orientation() == TopAbs_REVERSED:
                    b, c = c, b
                indices.extend((a, b, c))
                u = [positions[3 * b + i] - positions[3 * a + i] for i in range(3)]
                v = [positions[3 * c + i] - positions[3 * a + i] for i in range(3)]
                normal = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ]
                for vertex in (a, b, c):
                    for axis in range(3):
                        normals[3 * vertex + axis] += normal[axis]
            explorer.Next()
        primitives = []
        for rgba in list(groups):
            group = groups.pop(rgba)
            positions, normals, indices = group['positions'], group['normals'], group['indices']
            if not positions or not indices:
                continue
            for offset in range(0, len(normals), 3):
                length = math.sqrt(sum(normals[offset + axis] ** 2 for axis in range(3)))
                for axis in range(3):
                    normals[offset + axis] = (
                        normals[offset + axis] / length if length else (1 if axis == 2 else 0)
                    )
            if sys.byteorder != 'little':
                positions.byteswap()
                normals.byteswap()
                indices.byteswap()
            pending_bytes -= len(positions) * 4 + len(normals) * 4 + len(indices) * 4
            primitives.append(
                {
                    'attributes': {
                        'POSITION': accessor(
                            positions,
                            len(positions) // 3,
                            5126,
                            'VEC3',
                            34962,
                            (group['min'], group['max']),
                        ),
                        'NORMAL': accessor(normals, len(normals) // 3, 5126, 'VEC3', 34962),
                    },
                    'indices': accessor(indices, len(indices), 5125, 'SCALAR', 34963),
                    'material': material(rgba),
                }
            )
        if not primitives:
            raise ValueError('STEP 对象没有可显示的网格。')
        result = len(gltf['meshes'])
        gltf['meshes'].append({'primitives': primitives})
        meshes[cache_key] = result
        return result

    by_id = {}
    inherited_colors = {}
    root_nodes = []
    for record in records:
        transform = XCAFDoc_ShapeTool.GetLocation_s(record['_label']).Transformation()
        translation = transform.TranslationPart()
        quaternion = transform.GetRotation()
        position = [translation.X() * 0.001, translation.Y() * 0.001, translation.Z() * 0.001]
        rotation = [quaternion.X(), quaternion.Y(), quaternion.Z(), quaternion.W()]
        scale = transform.ScaleFactor()
        if not all(math.isfinite(value) for value in position + rotation + [scale]):
            raise ValueError('STEP 实例变换包含无效值。')
        node = {
            'name': record['name'],
            'translation': position,
            'rotation': rotation,
            'extras': {'daiObjectId': record['id']},
        }
        if scale != 1:
            node['scale'] = [scale, scale, scale]
        record['rigidTransform'] = scale == 1
        record['baseTransform'] = {'position': position, 'rotation': rotation}
        inherited = inherited_colors.get(record['parentId'])
        instance_color = (
            color(label=record['_label'])
            if XCAFDoc_ShapeTool.IsReference_s(record['_label'])
            else None
        )
        definition_color = color(label=record['_definition'])
        inherited_colors[record['id']] = instance_color or definition_color or inherited
        geometry_key = record.get('_geometryKey')
        if geometry_key:
            node['mesh'] = make_mesh(geometry_key, instance_color, inherited)
        index = len(gltf['nodes'])
        record['gltfNode'] = index
        gltf['nodes'].append(node)
        by_id[record['id']] = index
        if record['parentId'] is None:
            root_nodes.append(index)
        else:
            gltf['nodes'][by_id[record['parentId']]].setdefault('children', []).append(index)
    # OCCT 坐标为 Z-up；通过根节点旋转转换为 glTF 的 Y-up。
    basis = len(gltf['nodes'])
    gltf['nodes'].append(
        {
            'name': 'Dai coordinate system',
            'rotation': [-math.sqrt(0.5), 0, 0, math.sqrt(0.5)],
            'children': root_nodes,
        }
    )
    gltf['scenes'][0]['nodes'] = [basis]
    while len(binary) % 4:
        binary.append(0)
    gltf['buffers'].append({'byteLength': len(binary)})
    metadata = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    metadata += b' ' * (-len(metadata) % 4)
    length = 20 + len(metadata) + 8 + len(binary)
    if length > size_limit:
        raise ValueError('生成的场景资源超过大小限制。')
    return (
        struct.pack('<4sII', b'glTF', 2, length)
        + struct.pack('<I4s', len(metadata), b'JSON')
        + metadata
        + struct.pack('<I4s', len(binary), b'BIN\0')
        + binary
    )
