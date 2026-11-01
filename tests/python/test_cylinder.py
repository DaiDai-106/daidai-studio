import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/scene/python'))
try:
    import vtkmodules.vtkCommonCore  # noqa: F401  # 预加载 OCCT 的动态库依赖
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    HAS_OCC = True
except ImportError:
    HAS_OCC = False


@unittest.skipUnless(HAS_OCC, '需要安装场景几何依赖')
class CylinderTest(unittest.TestCase):
    def test_repeated_instances_share_local_cylinder_but_keep_distinct_pose(self):
        from assembly_fixture import write_cylinder_assembly
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'cylinder-assembly.step'
            write_cylinder_assembly(source)
            result = import_step(str(source), str(root / 'data'))
            objects = {item['name']: item for item in result['objects']}
            first = objects['FirstCylinder']
            second = objects['SecondCylinder']
            self.assertNotEqual(first['id'], second['id'])
            self.assertEqual(first['cylinderCandidates'], second['cylinderCandidates'])
            self.assertAlmostEqual(first['cylinderCandidates'][0]['radius'], 0.005, places=6)
            self.assertAlmostEqual(abs(second['baseTransform']['rotation'][2]), 2**-0.5, places=6)
            self.assertAlmostEqual(abs(second['baseTransform']['rotation'][3]), 2**-0.5, places=6)

    def test_actual_step_cylinder_axis_radius_and_unknown_kinematics(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'cylinder.step'
            axis = gp_Ax2(gp_Pnt(3, 4, 5), gp_Dir(1, 0, 0))
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeCylinder(axis, 5, 20).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            result = import_step(str(source), str(root / 'data'))
            candidate = next(
                item['cylinderCandidates'][0]
                for item in result['objects']
                if item.get('cylinderCandidates')
            )
            self.assertEqual(candidate['unit'], 'm')
            self.assertEqual(candidate['space'], 'object-local')
            self.assertEqual(candidate['evidence'], 'analytic-cylinder')
            self.assertEqual(candidate['kinematics'], 'unknown')
            self.assertGreaterEqual(candidate['faceIndex'], 1)
            self.assertAlmostEqual(candidate['radius'], 0.005, places=7)
            direction = candidate['axisDirection']
            self.assertAlmostEqual(abs(direction[0]), 1.0, places=6)
            self.assertAlmostEqual(direction[1], 0, places=6)
            self.assertAlmostEqual(direction[2], 0, places=6)
            self.assertAlmostEqual(math.hypot(*direction), 1.0, places=6)
            origin = candidate['axisOrigin']
            self.assertAlmostEqual(origin[1], 0.004, places=6)
            self.assertAlmostEqual(origin[2], 0.005, places=6)

    def test_length_unit_is_applied_to_cylinder_radius(self):
        from geometry import import_step

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'metre-cylinder.step'
            writer = STEPControl_Writer()
            self.assertEqual(
                writer.Transfer(BRepPrimAPI_MakeCylinder(5, 20).Shape(), STEPControl_AsIs),
                IFSelect_RetDone,
            )
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            text = source.read_text()
            self.assertIn('SI_UNIT(.MILLI.,.METRE.)', text)
            source.write_text(text.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT($,.METRE.)'))
            result = import_step(str(source), str(root / 'data'))
            candidate = next(
                item['cylinderCandidates'][0]
                for item in result['objects']
                if item.get('cylinderCandidates')
            )
            self.assertAlmostEqual(candidate['radius'], 5.0, places=6)

    def test_candidate_limit_is_explicitly_reported(self):
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
        import geometry

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'tube.step'
            tube = BRepAlgoAPI_Cut(
                BRepPrimAPI_MakeCylinder(5, 20).Shape(), BRepPrimAPI_MakeCylinder(3, 20).Shape()
            ).Shape()
            writer = STEPControl_Writer()
            self.assertEqual(writer.Transfer(tube, STEPControl_AsIs), IFSelect_RetDone)
            self.assertEqual(writer.Write(str(source)), IFSelect_RetDone)
            previous_limit = geometry.MAX_CYLINDERS_PER_GEOMETRY
            try:
                geometry.MAX_CYLINDERS_PER_GEOMETRY = 1
                result = geometry.import_step(str(source), str(root / 'data'))
            finally:
                geometry.MAX_CYLINDERS_PER_GEOMETRY = previous_limit
            leaf = next(item for item in result['objects'] if item.get('cylinderCandidates'))
            self.assertEqual(len(leaf['cylinderCandidates']), 1)
            self.assertTrue(leaf['cylinderCandidatesTruncated'])
            self.assertTrue(any('截断' in warning for warning in result['warnings']))
