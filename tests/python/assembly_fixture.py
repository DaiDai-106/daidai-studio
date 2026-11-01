"""Generate an actual STEP assembly with nested repeated colored components."""

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec


def write_assembly(path, repeat_subassembly=False, rotate_parent=False):
    document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(document.Main())

    def name(label, value):
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(value))

    def placement(x, y, z, rotate=False):
        transform = gp_Trsf()
        if rotate:
            transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 3.141592653589793 / 2)
        transform.SetTranslationPart(gp_Vec(x, y, z))
        return TopLoc_Location(transform)

    part = shapes.AddShape(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), False)
    name(part, 'Block')
    colors.SetColor(part, Quantity_Color(0.8, 0.1, 0.2, Quantity_TOC_RGB), XCAFDoc_ColorSurf)
    sub = shapes.NewShape()
    name(sub, 'SubAssembly')
    name(shapes.AddComponent(sub, part, placement(0, 40, 0)), 'FirstBlock')
    name(shapes.AddComponent(sub, part, placement(60, 0, 0, rotate=True)), 'SecondBlock')
    root = shapes.NewShape()
    name(root, 'Root')
    name(shapes.AddComponent(root, sub, placement(0, 0, 80, rotate=rotate_parent)), 'SubInstance')
    if repeat_subassembly:
        name(shapes.AddComponent(root, sub, placement(0, 0, 160)), 'SubInstance2')
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    if not writer.Transfer(document) or writer.Write(str(path)) != IFSelect_RetDone:
        raise RuntimeError('Failed to generate assembly fixture')


def write_cylinder_assembly(path):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2

    document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    axis = gp_Ax2(gp_Pnt(3, 4, 5), gp_Dir(1, 0, 0))
    part = shapes.AddShape(BRepPrimAPI_MakeCylinder(axis, 5, 20).Shape(), False)
    TDataStd_Name.Set_s(part, TCollection_ExtendedString('Cylinder'))
    root = shapes.NewShape()
    TDataStd_Name.Set_s(root, TCollection_ExtendedString('Assembly'))
    first = gp_Trsf()
    first.SetTranslationPart(gp_Vec(0, 40, 0))
    label = shapes.AddComponent(root, part, TopLoc_Location(first))
    TDataStd_Name.Set_s(label, TCollection_ExtendedString('FirstCylinder'))
    second = gp_Trsf()
    second.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 3.141592653589793 / 2)
    second.SetTranslationPart(gp_Vec(60, 0, 0))
    label = shapes.AddComponent(root, part, TopLoc_Location(second))
    TDataStd_Name.Set_s(label, TCollection_ExtendedString('SecondCylinder'))
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    if not writer.Transfer(document) or writer.Write(str(path)) != IFSelect_RetDone:
        raise RuntimeError('Failed to generate cylinder fixture')


def write_cylinder_relations(path):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder

    document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    part = shapes.AddShape(BRepPrimAPI_MakeCylinder(5, 20).Shape(), False)
    TDataStd_Name.Set_s(part, TCollection_ExtendedString('Cylinder'))
    sub = shapes.NewShape()
    TDataStd_Name.Set_s(sub, TCollection_ExtendedString('Subassembly'))

    def instance(name, translation, rotation_axis=None, angle=0):
        transform = gp_Trsf()
        if rotation_axis:
            transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(*rotation_axis)), angle)
        transform.SetTranslationPart(gp_Vec(*translation))
        label = shapes.AddComponent(sub, part, TopLoc_Location(transform))
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))

    instance('AxisA', (0, 0, 0))
    instance('AxisB', (0, 0, 40))
    instance('Offset', (10, 0, 0))
    instance('Rotated', (0, 0, 0), (1, 0, 0), 3.141592653589793 / 2)
    instance('Opposite', (0, 0, 0), (1, 0, 0), 3.141592653589793)
    root = shapes.NewShape()
    TDataStd_Name.Set_s(root, TCollection_ExtendedString('Root'))
    transform = gp_Trsf()
    transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 1, 0)), 3.141592653589793 / 2)
    transform.SetTranslationPart(gp_Vec(10, 20, 30))
    label = shapes.AddComponent(root, sub, TopLoc_Location(transform))
    TDataStd_Name.Set_s(label, TCollection_ExtendedString('ParentRotated'))
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    if not writer.Transfer(document) or writer.Write(str(path)) != IFSelect_RetDone:
        raise RuntimeError('Failed to generate cylinder relation fixture')


def write_large_assembly(path, count=5000):
    """以单一盒体重复实例构造较大的真实 STEP 装配。"""
    document = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    part = shapes.AddShape(BRepPrimAPI_MakeBox(1, 1, 1).Shape(), False)
    assembly = shapes.NewShape()
    TDataStd_Name.Set_s(assembly, TCollection_ExtendedString('Root'))
    for index in range(count):
        transform = gp_Trsf()
        transform.SetTranslationPart(gp_Vec((index % 100) * 2, (index // 100) * 2, 0))
        label = shapes.AddComponent(assembly, part, TopLoc_Location(transform))
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(f'Part{index:05}'))
    shapes.UpdateAssemblies()
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    if not writer.Transfer(document) or writer.Write(str(path)) != IFSelect_RetDone:
        raise RuntimeError('Failed to generate large fixture')
