#include "private/meshing.h"
#include <algorithm>
#include <cmath>
#include <Bnd_Box.hxx>
#include <BRep_Tool.hxx>
#include <BRepCheck_Edge.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_ShapeTool.hxx>
#include <BRepTools.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>

namespace dai::cad
{
namespace
{
// Recovery uses a finer local mesh even when the overall display is a preview.
constexpr double area_integration_error = 1e-6;

bool finite( const gp_Pnt &point )
{
  return std::isfinite( point.X() ) && std::isfinite( point.Y() ) && std::isfinite( point.Z() );
}
}  // namespace

MeshValidation validateRecoveredMesh( const TopoDS_Face &source, const PreparedFace &candidate,
                                      const QualityProfile &profile, const WorkContext &work )
{
  MeshValidation result;
  const auto reject = [ & ]( const char *error ) {
    result.error = error;
    return result;
  };
  work.check();
  TopLoc_Location location;
  const auto triangulation = BRep_Tool::Triangulation( candidate.shape, location );
  if ( triangulation.IsNull() || !triangulation->NbTriangles() ||
       ( candidate.status_flags & mesh_failure_flags ) != 0 ) {
    return reject( "recovery_meshing_failed" );
  }
  if ( static_cast<std::uint64_t>( triangulation->NbTriangles() ) > work.limits.max_triangles ) {
    fail( "LIMIT_EXCEEDED", "Recovery triangle budget exceeded." );
  }
  const auto transform = candidate.to_source * location.Transformation();
  const auto node      = [ & ]( int index ) {
    if ( index < 1 || index > triangulation->NbNodes() ) {
      fail( "MESH_FAILED", "Recovery returned an invalid triangle index." );
    }
    return triangulation->Node( index ).Transformed( transform );
  };
  Bnd_Box bounds;
  for ( int index = 1; index <= triangulation->NbNodes(); ++index ) {
    work.check();
    const auto point = node( index );
    if ( !finite( point ) ) {
      return reject( "recovery_non_finite_mesh" );
    }
    bounds.Add( point );
  }
  result.display_origin    = gp_Pnt( ( bounds.CornerMin().XYZ() + bounds.CornerMax().XYZ() ) / 2 );
  const auto display_point = [ & ]( const gp_Pnt &point ) {
    const auto local = point.XYZ() - result.display_origin.XYZ();
    return gp_Pnt( static_cast<float>( local.X() ), static_cast<float>( local.Y() ), static_cast<float>( local.Z() ) );
  };
  double area_sum = 0, compensation = 0, display_area = 0, display_compensation = 0;
  for ( int index = 1; index <= triangulation->NbTriangles(); ++index ) {
    work.check();
    int a, b, c;
    triangulation->Triangle( index ).Get( a, b, c );
    const auto first = node( a ), second = node( b ), third = node( c );
    if ( !finite( first ) || !finite( second ) || !finite( third ) ) {
      return reject( "recovery_non_finite_mesh" );
    }
    const double area = gp_Vec( first, second ).Crossed( gp_Vec( first, third ) ).Magnitude() / 2;
    if ( !std::isfinite( area ) || area <= 0 ) {
      return reject( "recovery_degenerate_triangle" );
    }
    const double adjusted = area - compensation;
    const double next     = area_sum + adjusted;
    compensation          = ( next - area_sum ) - adjusted;
    area_sum              = next;
    const auto da = display_point( first ), db = display_point( second ), dc = display_point( third );
    const double displayed = gp_Vec( da, db ).Crossed( gp_Vec( da, dc ) ).Magnitude() / 2;
    if ( !std::isfinite( displayed ) || displayed <= 0 ) {
      return reject( "recovery_display_precision" );
    }
    const double display_adjusted = displayed - display_compensation;
    const double display_next     = display_area + display_adjusted;
    display_compensation          = ( display_next - display_area ) - display_adjusted;
    display_area                  = display_next;
  }
  result.mesh_area_m2 = display_area;
  // Compare against the unmodified CAD face, never a healed candidate's own area.
  GProp_GProps properties;
  const double error = BRepGProp::SurfaceProperties( source, properties, area_integration_error, false );
  work.check();
  result.source_area_m2 = properties.Mass();
  if ( !std::isfinite( properties.Mass() ) || properties.Mass() <= 0 || !std::isfinite( error ) || error < 0 ||
       error > area_integration_error * 10 ) {
    return reject( "recovery_area_unresolved" );
  }
  if ( std::abs( area_sum - properties.Mass() ) > mesh_recovery_area_error * properties.Mass() ||
       std::abs( display_area - properties.Mass() ) > mesh_recovery_area_error * properties.Mass() ) {
    return reject( "recovery_area_mismatch" );
  }
  // OCCT checks every CAD edge has a polygon on this triangulation; the polygon
  // check then compares that representation with its unchanged 3D edge curve.
  const double scale = candidate.to_source.ScaleFactor();
  const double allowed_deflection =
      std::max( profile.linear_deflection_m, 2 * BRepMesh_ShapeTool::MaxFaceTolerance( source ) );
  if ( scale <= 0 || !BRepTools::Triangulation( candidate.shape, allowed_deflection / scale ) ) {
    return reject( "recovery_boundary_missing" );
  }
  for ( const auto type : { TopAbs_WIRE, TopAbs_VERTEX } ) {
    TopTools_IndexedMapOfShape original, recovered;
    TopExp::MapShapes( source, type, original );
    TopExp::MapShapes( candidate.shape, type, recovered );
    if ( original.Extent() != recovered.Extent() ) {
      return reject( "recovery_topology_changed" );
    }
  }
  TopTools_IndexedMapOfShape source_edges, candidate_edges;
  TopExp::MapShapes( source, TopAbs_EDGE, source_edges );
  TopExp::MapShapes( candidate.shape, TopAbs_EDGE, candidate_edges );
  if ( source_edges.Extent() != candidate_edges.Extent() ) {
    return reject( "recovery_topology_changed" );
  }
  for ( int index = 1; index <= candidate_edges.Extent(); ++index ) {
    work.check();
    const auto edge = TopoDS::Edge( candidate_edges( index ) );
    BRepCheck_Edge checker( edge );
    if ( checker.CheckPolygonOnTriangulation( edge ) != BRepCheck_NoError ) {
      return reject( "recovery_boundary_deviation" );
    }
  }
  return result;
}
}  // namespace dai::cad
