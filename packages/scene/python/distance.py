"""从已授权 STEP 原文件恢复 BRep 并计算形体距离，不修改场景。"""

import math
import os
from pathlib import Path
import re

from geometry import _digest, _digest_fd, _open_source, _source_fd_path


def _numbers(value, count, label):
    if (
        not isinstance(value, list)
        or len(value) != count
        or any(
            isinstance(item, bool) or not isinstance(item, (float, int)) or not math.isfinite(item)
            for item in value
        )
    ):
        raise ValueError(f'{label}无效。')
    return value


def measure_distance(first, second):
    try:
        import vtkmodules.vtkCommonCore  # noqa: F401
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.STEPCAFControl import STEPCAFControl_Reader
        from OCP.STEPConstruct import STEPConstruct_ExternRefs
        from OCP.TColStd import TColStd_SequenceOfAsciiString
        from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
        from OCP.TDF import TDF_Label, TDF_LabelSequence, TDF_Tool
        from OCP.TDocStd import TDocStd_Document
        from OCP.TopLoc import TopLoc_Location
        from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
        from OCP.gp import gp_Quaternion, gp_Trsf, gp_Vec
    except ImportError as error:
        raise RuntimeError('缺少 Python 场景几何依赖。') from error

    def entry(label):
        text = TCollection_AsciiString()
        TDF_Tool.Entry_s(label, text)
        return text.ToCString()

    documents = {}
    checked_sources = {}

    def shape_from(selection):
        if not isinstance(selection, dict) or not isinstance(selection.get('source'), dict):
            raise ValueError('距离查询来源无效。')
        source = selection['source']
        path_value, expected = source.get('path'), source.get('sha256')
        if (
            not isinstance(path_value, str)
            or not isinstance(expected, str)
            or not re.fullmatch(r'[0-9a-f]{64}', expected)
        ):
            raise ValueError('距离查询来源哈希无效。')
        path = Path(path_value)
        if not path.is_absolute() or path.suffix.lower() not in ('.step', '.stp'):
            raise ValueError('距离查询来源不是 STEP 绝对路径。')
        source_fd = _open_source(path)
        try:
            if _digest_fd(source_fd) != expected:
                raise ValueError('STEP 源文件已变化，请重新导入后测量。')
            checked_sources[str(path)] = expected
            document_key = (str(path), expected)
            if document_key not in documents:
                reader = STEPCAFControl_Reader()
                reader.SetColorMode(True)
                reader.SetNameMode(True)
                if reader.ReadFile(_source_fd_path(source_fd)) != IFSelect_RetDone:
                    raise ValueError('STEP 解析失败。')
                lengths = TColStd_SequenceOfAsciiString()
                reader.Reader().FileUnits(
                    lengths, TColStd_SequenceOfAsciiString(), TColStd_SequenceOfAsciiString()
                )
                if lengths.Length() == 0 or any(
                    not lengths.Value(i).ToCString().strip() for i in range(1, lengths.Length() + 1)
                ):
                    raise ValueError('STEP 长度单位缺失或无法解析。')
                references = STEPConstruct_ExternRefs(reader.Reader().WS())
                references.LoadExternRefs()
                if references.NbExternRefs():
                    raise ValueError('暂不支持包含外部引用的 STEP 文件。')
                document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
                if not reader.Transfer(document):
                    raise ValueError('STEP 几何转换失败。')
                documents[document_key] = document
        finally:
            os.close(source_fd)
        document = documents[document_key]
        shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
        labels = TDF_LabelSequence()
        shapes.GetFreeShapes(labels)
        source_key = selection.get('sourceKey')
        if (
            not isinstance(source_key, str)
            or not source_key.startswith('/')
            or len(source_key) > 4096
        ):
            raise ValueError('场景对象来源路径无效。')
        parts = source_key[1:].split('/')
        if len(parts) > 256:
            raise ValueError('场景对象来源路径过深。')
        for index, part in enumerate(parts):
            if part.count('@') != 1:
                raise ValueError('场景对象来源路径无效。')
            label_key, definition_key = part.split('@')
            matches = [
                labels.Value(i)
                for i in range(1, labels.Length() + 1)
                if entry(labels.Value(i)) == label_key
            ]
            if len(matches) != 1:
                raise ValueError('STEP 中找不到原始对象，请重新导入。')
            definition = matches[0]
            seen = set()
            while XCAFDoc_ShapeTool.IsReference_s(definition):
                definition_entry = entry(definition)
                if definition_entry in seen:
                    raise ValueError('STEP 包含循环引用。')
                seen.add(definition_entry)
                target = TDF_Label()
                if not XCAFDoc_ShapeTool.GetReferredShape_s(definition, target):
                    raise ValueError('STEP 装配引用无效。')
                definition = target
            if entry(definition) != definition_key:
                raise ValueError('STEP 对象与原始几何不一致。')
            is_assembly = XCAFDoc_ShapeTool.IsAssembly_s(definition)
            if index + 1 < len(parts):
                if not is_assembly:
                    raise ValueError('STEP 对象层级无效。')
                labels = TDF_LabelSequence()
                XCAFDoc_ShapeTool.GetComponents_s(definition, labels)
            else:
                if is_assembly:
                    raise ValueError('当前只能测量几何叶对象。')
                shape = XCAFDoc_ShapeTool.GetShape_s(definition)
                if shape.IsNull():
                    raise ValueError('STEP 叶对象没有几何。')
                shape = shape.Located(TopLoc_Location())
        transform = selection.get('worldTransform')
        if not isinstance(transform, dict):
            raise ValueError('对象世界位姿无效。')
        position = _numbers(transform.get('position'), 3, '对象位置')
        rotation = _numbers(transform.get('rotation'), 4, '对象旋转')
        norm = math.hypot(*rotation)
        if not math.isfinite(norm) or abs(norm - 1) > 1e-6:
            raise ValueError('对象旋转必须是单位四元数。')
        placement = gp_Trsf()
        placement.SetRotation(gp_Quaternion(*rotation))
        placement.SetTranslationPart(gp_Vec(*(value * 1000 for value in position)))
        return shape.Moved(TopLoc_Location(placement))

    a = shape_from(first)
    b = shape_from(second)
    measurement = BRepExtrema_DistShapeShape(a, b)
    if not measurement.IsDone() or measurement.NbSolution() < 1:
        raise ValueError('CAD 形体距离计算失败。')
    distance = measurement.Value() * 0.001
    if not math.isfinite(distance) or distance < 0:
        raise ValueError('CAD 形体距离结果无效。')
    inner = measurement.InnerSolution()

    def point(value):
        coordinates = [value.X() * 0.001, value.Y() * 0.001, value.Z() * 0.001]
        if not all(math.isfinite(item) for item in coordinates):
            raise ValueError('CAD 距离结果坐标无效。')
        return coordinates

    first_point = None if inner else point(measurement.PointOnShape1(1))
    second_point = None if inner else point(measurement.PointOnShape2(1))
    for source_path, expected in checked_sources.items():
        path = Path(source_path)
        if not path.is_file() or _digest(path) != expected:
            raise ValueError('STEP 源文件在测量期间已变化或不可读取。')
    return {
        'shapeDistanceM': distance,
        'surfaceDistanceM': None,
        'collision': 'unknown',
        'innerSolution': inner,
        'firstPoint': first_point,
        'secondPoint': second_point,
        'unit': 'm',
        'space': 'world-z-up',
        'method': 'occt-brep',
    }
