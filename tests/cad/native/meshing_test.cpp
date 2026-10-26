#include "private/meshing.h"
#include <cmath>
#include <iostream>
#include <sstream>
#include <Bnd_Box.hxx>
#include <BRep_Tool.hxx>
#include <BRep_Builder.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepGProp.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepTools.hxx>
#include <GProp_GProps.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <gp_Circ.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Pln.hxx>

namespace dai::cad::test
{
namespace
{
void require( bool condition, const char *message )
{
  if ( !condition ) {
    throw std::runtime_error( message );
  }
}
CadGeometry geometry( const TopoDS_Shape &shape )
{
  CadGeometry result;
  result.id    = "arbitrary-source-definition";
  result.shape = shape;
  TopExp::MapShapes( shape, TopAbs_FACE, result.faces );
  TopExp::MapShapes( shape, TopAbs_EDGE, result.edges );
  TopExp::MapShapes( shape, TopAbs_VERTEX, result.vertices );
  return result;
}
std::string serialized( const TopoDS_Shape &shape )
{
  std::ostringstream result;
  BRepTools::Write( shape, result );
  return result.str();
}
double meshArea( const PreparedFace &face )
{
  TopLoc_Location location;
  const auto triangles = BRep_Tool::Triangulation( face.shape, location );
  require( !triangles.IsNull() && triangles->NbTriangles() > 0, "Face has no triangles." );
  const auto transform = face.to_source * location.Transformation();
  double area          = 0;
  for ( int i = 1; i <= triangles->NbTriangles(); ++i ) {
    int a, b, c;
    triangles->Triangle( i ).Get( a, b, c );
    const auto first  = triangles->Node( a ).Transformed( transform );
    const auto second = triangles->Node( b ).Transformed( transform );
    const auto third  = triangles->Node( c ).Transformed( transform );
    area += gp_Vec( first, second ).Crossed( gp_Vec( first, third ) ).Magnitude() / 2;
  }
  return area;
}
void checkPlacement( const TopoDS_Shape &source, const PreparedMesh &mesh )
{
  Bnd_Box expected, actual;
  BRepBndLib::AddOptimal( source, expected, false, false );
  for ( const auto &face : mesh.faces ) {
    TopLoc_Location location;
    const auto triangles = BRep_Tool::Triangulation( face.shape, location );
    require( !triangles.IsNull(), "Cannot check placement of a missing mesh." );
    const auto transform = face.to_source * location.Transformation();
    for ( int i = 1; i <= triangles->NbNodes(); ++i ) {
      actual.Add( triangles->Node( i ).Transformed( transform ) );
    }
  }
  const double tolerance = 1e-8 + std::sqrt( expected.SquareExtent() ) * 1e-6;
  require( expected.CornerMin().Distance( actual.CornerMin() ) <= tolerance &&
               expected.CornerMax().Distance( actual.CornerMax() ) <= tolerance,
           "Display mesh did not return to its original CAD coordinates." );
}
void checkDisplayBuffers( CadGeometry source, double source_area, const WorkContext &work )
{
  CadDocument document( {} );
  source.face_colors.resize( source.faces.Extent() );
  const auto id = source.id;
  document.storage().geometries.emplace( id, std::move( source ) );
  MeshRecoveryBudget budget;
  const auto display = meshGeometry( document, id, qualityProfile( "preview" ), budget, work );
  require( display.complete && !display.recoveries.empty(), "Display fixture did not recover." );
  Bnd_Box bounds;
  double area = 0;
  for ( const auto &chunk : display.chunks ) {
    const auto point = [ & ]( std::size_t index ) {
      // Display buffers are Y-up; restore the unchanged CAD object's Z-up basis.
      const auto offset = index * 3;
      return gp_Pnt( chunk.positions.at( offset ), -chunk.positions.at( offset + 2 ),
                     chunk.positions.at( offset + 1 ) );
    };
    for ( std::size_t index = 0; index < chunk.positions.size() / 3; ++index ) {
      bounds.Add( point( index ).Translated( gp_Vec( chunk.origin[ 0 ], chunk.origin[ 1 ], chunk.origin[ 2 ] ) ) );
    }
    for ( const auto &primitive : chunk.primitives ) {
      for ( std::size_t index = 0; index < primitive.indices.size(); index += 3 ) {
        const auto a = point( primitive.indices[ index ] ), b = point( primitive.indices[ index + 1 ] ),
                   c          = point( primitive.indices[ index + 2 ] );
        const double triangle = gp_Vec( a, b ).Crossed( gp_Vec( a, c ) ).Magnitude() / 2;
        require( triangle > 0, "Float32 display conversion collapsed a recovered triangle." );
        area += triangle;
      }
    }
  }
  require( std::abs( area / source_area - 1 ) < 0.01, "Float32 display lost recovered face coverage." );
  Bnd_Box expected;
  BRepBndLib::AddOptimal( document.storage().geometries.at( id ).shape, expected, false, false );
  require( expected.CornerMin().Distance( bounds.CornerMin() ) < 1e-8 &&
               expected.CornerMax().Distance( bounds.CornerMax() ) < 1e-8,
           "Localized display origin changed CAD placement." );
}
PreparedFace candidate( const TopoDS_Face &face )
{
  BRepBuilderAPI_Copy copy( face, true, false );
  BRepMesh_IncrementalMesh mesh( copy.Shape(), 1e-4, false, 0.15, false );
  PreparedFace result;
  result.shape        = TopoDS::Face( copy.Shape() );
  result.status_flags = mesh.GetStatusFlags();
  result.missing_mesh = false;
  return result;
}
TopoDS_Face annulus( double radius, double inner_radius )
{
  const gp_Ax2 axis( gp_Pnt(), gp_Dir( 0, 0, 1 ) );
  const auto outside = BRepBuilderAPI_MakeWire( BRepBuilderAPI_MakeEdge( gp_Circ( axis, radius ) ) ).Wire();
  const auto inside  = BRepBuilderAPI_MakeWire( BRepBuilderAPI_MakeEdge( gp_Circ( axis, inner_radius ) ) ).Wire();
  BRepBuilderAPI_MakeFace face( outside, true );
  face.Add( TopoDS::Wire( inside.Reversed() ) );
  return face.Face();
}

void run()
{
  Limits limits;
  WorkContext work{ {}, std::chrono::steady_clock::now() + std::chrono::minutes( 2 ), limits, {} };
  std::size_t recovered = 0;
  for ( const double size : { 1e-6, 1e-3, 1.0, 1000.0 } ) {
    for ( const auto &origin : { gp_Pnt(), gp_Pnt( 12345, -6789, 42 ) } ) {
      const gp_Pln plane( origin, gp_Dir( 0.2, 0.3, 1 ) );
      const auto source = geometry( BRepBuilderAPI_MakeFace( plane, 0, size, 0, size * 2 ).Face() );
      const auto before = serialized( source.shape );
      MeshRecoveryBudget budget;
      const auto mesh = prepareMesh( source, qualityProfile( "preview" ), budget, work );
      require( mesh.complete && mesh.faces.size() == 1, "Scaled or translated plane did not mesh completely." );
      require( std::abs( meshArea( mesh.faces.front() ) / ( 2 * size * size ) - 1 ) < 0.01,
               "Meshing changed scale or placement." );
      require( serialized( source.shape ) == before, "Meshing changed original CAD data or triangulation." );
      checkPlacement( source.shape, mesh );
      recovered += mesh.recoveries.size();
    }
  }
  for ( const double radius : { 1e-3, 1.0 } ) {
    const auto source = geometry( annulus( radius, radius * 0.9 ) );
    MeshRecoveryBudget budget;
    const auto mesh = prepareMesh( source, qualityProfile( "fine" ), budget, work );
    require( mesh.complete && mesh.faces.size() == 1, "A face with a hole failed meshing." );
    const double area = std::acos( -1 ) * radius * radius * ( 1 - 0.9 * 0.9 );
    require( std::abs( meshArea( mesh.faces.front() ) / area - 1 ) < 0.01, "A hole was filled or distorted." );
    recovered += mesh.recoveries.size();
  }
  for ( const double radius : { 0.0035, 0.01 } ) {
    for ( const auto &origin : { gp_Pnt(), gp_Pnt( 1, -2, 3 ) } ) {
      const auto source = geometry(
          BRepBuilderAPI_MakeFace( gp_Cylinder( gp_Ax3( origin, gp_Dir( 0, 0, 1 ) ), radius ), 0, 1e-6, 0, 0.02 )
              .Face() );
      const auto before = serialized( source.shape );
      MeshRecoveryBudget available;
      const auto narrow = prepareMesh( source, qualityProfile( "preview" ), available, work );
      require( narrow.complete, "A narrow cylindrical parametric range collapsed." );
      const double area = radius * 1e-6 * 0.02;
      require( std::abs( meshArea( narrow.faces.front() ) / area - 1 ) < 0.01,
               "Narrow cylindrical face coverage changed." );
      require( serialized( source.shape ) == before, "Narrow-face recovery changed source CAD." );
      checkPlacement( source.shape, narrow );
      checkDisplayBuffers( source, area, work );
      recovered += narrow.recoveries.size();
    }
  }
  require( recovered > 0, "Synthetic cases did not exercise generic mesh recovery." );
  const auto solid  = geometry( BRepPrimAPI_MakeBox( 0.8, 0.4, 0.25 ).Shape() );
  const auto before = serialized( solid.shape );
  MeshRecoveryBudget budget;
  const auto mesh = prepareMesh( solid, qualityProfile( "fine" ), budget, work );
  require( mesh.complete && mesh.faces.size() == 6, "Solid lost a shared-edge face." );
  require( serialized( solid.shape ) == before, "Shared source geometry was modified." );
  require( mesh.recoveries.empty(), "Healthy CAD unnecessarily entered recovery." );

  const auto plane     = BRepBuilderAPI_MakeFace( gp_Pln(), 0, 1, 0, 1 ).Face();
  const auto different = BRepBuilderAPI_MakeFace( gp_Pln(), 0, 10, 0, 1 ).Face();
  require( validateRecoveredMesh( plane, candidate( different ), qualityProfile( "preview" ), work ).error ==
               "recovery_area_mismatch",
           "A wrong-area mesh was accepted because native meshing succeeded." );
  auto invalid         = candidate( plane );
  invalid.status_flags = IMeshData_OpenWire;
  require( !validateRecoveredMesh( plane, invalid, qualityProfile( "preview" ), work ).error.empty(),
           "Native boundary errors were ignored for an existing triangulation." );
  invalid = candidate( plane );
  TopLoc_Location location;
  const auto triangles = BRep_Tool::Triangulation( invalid.shape, location );
  triangles->SetTriangle( 1, Poly_Triangle( 1, 1, 1 ) );
  require( validateRecoveredMesh( plane, invalid, qualityProfile( "preview" ), work ).error ==
               "recovery_degenerate_triangle",
           "A degenerate triangle was silently discarded or accepted." );
  invalid                           = candidate( plane );
  Handle( Poly_Triangulation ) thin = new Poly_Triangulation( 3, 1, false );
  thin->SetNode( 1, gp_Pnt( 0, 0, 0 ) );
  thin->SetNode( 2, gp_Pnt( 1, 1, 0 ) );
  thin->SetNode( 3, gp_Pnt( 1, 1 + 1e-8, 0 ) );
  thin->SetTriangle( 1, Poly_Triangle( 1, 2, 3 ) );
  BRep_Builder().UpdateFace( invalid.shape, thin, true );
  require(
      validateRecoveredMesh( plane, invalid, qualityProfile( "preview" ), work ).error == "recovery_display_precision",
      "Float32 collapse passed double-only mesh validation." );
  const auto hole = annulus( 1, 0.001 );
  const auto disk = BRepBuilderAPI_MakeFace(
                        BRepBuilderAPI_MakeWire( BRepBuilderAPI_MakeEdge( gp_Circ( gp_Ax2(), 1 ) ) ).Wire(), true )
                        .Face();
  require( !validateRecoveredMesh( hole, candidate( disk ), qualityProfile( "preview" ), work ).error.empty(),
           "Small missing hole passed area-only validation." );

  BRepBuilderAPI_MakePolygon polygon;
  polygon.Add( gp_Pnt( 0, 0, 0 ) );
  polygon.Add( gp_Pnt( 1, 1, 0 ) );
  polygon.Add( gp_Pnt( 0, 1, 0 ) );
  polygon.Add( gp_Pnt( 1, 0, 0 ) );
  polygon.Close();
  const auto crossed = geometry( BRepBuilderAPI_MakeFace( polygon.Wire(), true ).Face() );
  MeshRecoveryBudget exhausted{ 0 };
  const auto refused = prepareMesh( crossed, qualityProfile( "preview" ), exhausted, work );
  require( !refused.complete && refused.recoveries.empty(), "Invalid CAD passed an exhausted recovery budget." );
  require( refused.faces.front().validation_error == "recovery_budget_exhausted", "Recovery budget was hidden." );
  std::stop_source stop;
  WorkContext cancelled{ stop.get_token(), work.deadline, limits, [ & ]( const auto &phase, auto ) {
                          if ( phase == "recover_mesh" ) {
                            stop.request_stop();
                          }
                        } };
  bool did_cancel = false;
  try {
    MeshRecoveryBudget available;
    (void)prepareMesh( crossed, qualityProfile( "preview" ), available, cancelled );
  } catch ( const CadFailure &error ) {
    did_cancel = error.error().code == "CANCELLED";
  }
  require( did_cancel, "Cancellation was swallowed by a recovery attempt." );
  std::cout << "Meshing scale/placement/hole/immutability/rejection/budget/cancellation checks passed; recovered "
            << recovered << " synthetic faces.\n";
}
}  // namespace
}  // namespace dai::cad::test

int main()
{
  try {
    dai::cad::test::run();
    return 0;
  } catch ( const std::exception &error ) {
    std::cerr << error.what() << '\n';
    return 1;
  } catch ( const Standard_Failure &error ) {
    std::cerr << error.GetMessageString() << '\n';
    return 1;
  }
}
