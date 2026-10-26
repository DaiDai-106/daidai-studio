#include "private/meshing.h"
#include "private/mesh_context.h"
#include "private/progress.h"
#include <algorithm>
#include <cmath>
#include <string_view>
#include <Bnd_Box.hxx>
#include <BRep_Tool.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepLib.hxx>
#include <BRepMesh_Context.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <IMeshData_Face.hxx>
#include <IMeshData_Wire.hxx>
#include <Poly_Triangulation.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>

namespace dai::cad
{
namespace
{
constexpr double working_extent            = 1000;
constexpr double local_relative_deflection = 1e-4;
constexpr int max_refined_edges            = 512;

bool missingMesh( const TopoDS_Face &face )
{
  TopLoc_Location location;
  const auto mesh = BRep_Tool::Triangulation( face, location );
  return mesh.IsNull() || mesh->NbTriangles() == 0;
}
bool usable( const PreparedFace &face )
{
  return !face.missing_mesh && ( face.status_flags & mesh_failure_flags ) == 0 && face.validation_error.empty();
}
struct MeshingRun {
  bool done        = false;
  int status_flags = 0;
  std::vector<int> face_status;
};

MeshingRun triangulate( const TopoDS_Shape &shape, const TopTools_IndexedMapOfShape &faces,
                        IMeshTools_Parameters parameters, const WorkContext &work, bool refine_boundaries = false )
{
  work.check();
  parameters.InParallel          = false;
  parameters.CleanModel          = false;
  Handle( CadProgress ) progress = new CadProgress( work, "triangulate" );
  const auto context             = meshingContext( refine_boundaries );
  BRepMesh_IncrementalMesh mesher;
  mesher.SetShape( shape );
  mesher.ChangeParameters() = parameters;
  mesher.Perform( context, progress->Start() );
  work.check();
  const auto &model = context->GetModel();
  MeshingRun result{ mesher.IsDone() && !model.IsNull(), mesher.GetStatusFlags(),
                     std::vector<int>( faces.Extent() + 1, 0 ) };
  if ( model.IsNull() ) {
    return result;
  }
  if ( model->FacesNb() != faces.Extent() ) {
    fail( "MESH_FAILED", "Meshing changed the CAD face count." );
  }
  for ( int index = 0; index < model->FacesNb(); ++index ) {
    work.check();
    const auto &face       = model->GetFace( index );
    const int source_index = faces.FindIndex( face->GetFace() );
    if ( source_index == 0 ) {
      fail( "MESH_FAILED", "Mesher diagnostic references an unknown CAD face." );
    }
    auto &status = result.face_status[ source_index ];
    status       = face->GetStatusMask();
    for ( int wire = 0; wire < face->WiresNb(); ++wire ) {
      status |= face->GetWire( wire )->GetStatusMask();
    }
  }
  return result;
}

struct Normalization {
  gp_Trsf from_source;
  double diagonal_m;
};
Normalization normalization( const TopoDS_Face &face )
{
  Bnd_Box bounds;
  BRepBndLib::AddOptimal( face, bounds, false, false );
  if ( bounds.IsVoid() || bounds.IsOpen() ) {
    fail( "UNSUPPORTED_SOURCE", "Cannot normalize an unbounded CAD face." );
  }
  double x, y, z, X, Y, Z;
  bounds.Get( x, y, z, X, Y, Z );
  const double diagonal = std::hypot( X - x, Y - y, Z - z );
  const double scale    = working_extent / diagonal;
  if ( !std::isfinite( scale ) || scale < 1e-9 || scale > 1e12 ) {
    fail( "UNSUPPORTED_SOURCE", "CAD face is outside the recovery computation scale." );
  }
  gp_Trsf transform;
  transform.SetScale( gp_Pnt(), scale );
  transform.SetTranslationPart(
      gp_Vec( -scale * ( x + ( X - x ) / 2 ), -scale * ( y + ( Y - y ) / 2 ), -scale * ( z + ( Z - z ) / 2 ) ) );
  return { transform, diagonal };
}

// SameParameter changes parameter curves and tolerance metadata, not 3D curves,
// surfaces or vertices. Enforce that contract and a physical tolerance budget.
bool repairParameters( const TopoDS_Face &face, double scale, double allowance_m, double &increase_m,
                       const WorkContext &work )
{
  TopTools_IndexedMapOfShape parts;
  TopExp::MapShapes( face, parts );
  struct State {
    double tolerance = 0;
    gp_Pnt point;
    Handle( Geom_Curve ) curve;
    double first = 0, last = 0;
    TopLoc_Location location;
  };
  TopLoc_Location surface_location;
  const auto surface = BRep_Tool::Surface( face, surface_location );
  std::vector<State> before( parts.Extent() + 1 );
  for ( int i = 1; i <= parts.Extent(); ++i ) {
    const auto &part = parts( i );
    if ( part.ShapeType() == TopAbs_VERTEX ) {
      before[ i ].tolerance = BRep_Tool::Tolerance( TopoDS::Vertex( part ) );
      before[ i ].point     = BRep_Tool::Pnt( TopoDS::Vertex( part ) );
    } else if ( part.ShapeType() == TopAbs_EDGE ) {
      before[ i ].tolerance = BRep_Tool::Tolerance( TopoDS::Edge( part ) );
      before[ i ].curve =
          BRep_Tool::Curve( TopoDS::Edge( part ), before[ i ].location, before[ i ].first, before[ i ].last );
    } else if ( part.ShapeType() == TopAbs_FACE ) {
      before[ i ].tolerance = BRep_Tool::Tolerance( TopoDS::Face( part ) );
    }
  }
  work.check();
  BRepLib::SameParameter( face, std::max( Precision::Confusion(), allowance_m * scale ), true );
  work.check();
  TopTools_IndexedMapOfShape after;
  TopExp::MapShapes( face, after );
  if ( after.Extent() != parts.Extent() ) {
    return false;
  }
  TopLoc_Location repaired_location;
  if ( BRep_Tool::Surface( face, repaired_location ) != surface || repaired_location != surface_location ) {
    return false;
  }
  for ( int i = 1; i <= parts.Extent(); ++i ) {
    const auto &part = parts( i );
    if ( !after.Contains( part ) ) {
      return false;
    }
    double tolerance = before[ i ].tolerance;
    if ( part.ShapeType() == TopAbs_VERTEX ) {
      tolerance = BRep_Tool::Tolerance( TopoDS::Vertex( part ) );
      if ( !BRep_Tool::Pnt( TopoDS::Vertex( part ) ).IsEqual( before[ i ].point, 0 ) ) {
        return false;
      }
    } else if ( part.ShapeType() == TopAbs_EDGE ) {
      tolerance = BRep_Tool::Tolerance( TopoDS::Edge( part ) );
      TopLoc_Location location;
      double first = 0, last = 0;
      const auto curve = BRep_Tool::Curve( TopoDS::Edge( part ), location, first, last );
      if ( curve != before[ i ].curve || location != before[ i ].location ||
           ( !curve.IsNull() && ( first != before[ i ].first || last != before[ i ].last ) ) ) {
        return false;
      }
    } else if ( part.ShapeType() == TopAbs_FACE ) {
      tolerance = BRep_Tool::Tolerance( TopoDS::Face( part ) );
    }
    const double increase = std::max( 0.0, ( tolerance - before[ i ].tolerance ) / scale );
    if ( !std::isfinite( tolerance ) || increase > allowance_m ) {
      return false;
    }
    increase_m = std::max( increase_m, increase );
  }
  BRepCheck_Analyzer analyzer( face, true, false, true );
  work.check();
  return analyzer.IsValid();
}

void recoverFace( const TopoDS_Face &source, PreparedFace &current, const TopologyRef &reference,
                  const QualityProfile &profile, std::vector<FaceMeshRecovery> &recoveries, const WorkContext &work )
{
  // Resolving an open or ambiguously oriented boundary can change the trimmed
  // region. That needs a separate topology repair policy, not a meshing retry.
  if ( ( current.status_flags & ( IMeshData_OpenWire | IMeshData_UnorientedWire ) ) != 0 ) {
    current.validation_error = "recovery_requires_boundary_repair";
    return;
  }
  const auto normalized = normalization( source );
  const double scale    = normalized.from_source.ScaleFactor();
  TopTools_IndexedMapOfShape edges;
  TopExp::MapShapes( source, TopAbs_EDGE, edges );
  for ( const auto method : { "normalized", "refined_boundary", "same_parameter" } ) {
    const bool repair            = std::string_view( method ) == "same_parameter";
    const bool refine_boundaries = std::string_view( method ) != "normalized";
    if ( refine_boundaries && edges.Extent() > max_refined_edges ) {
      current.validation_error = "recovery_budget_exhausted";
      return;
    }
    work.report( repair ? "repair_mesh_parameters" : "recover_mesh" );
    BRepBuilderAPI_Transform copy( source, normalized.from_source, true, false );
    if ( !copy.IsDone() ) {
      current.validation_error = "recovery_copy_failed";
      return;
    }
    PreparedFace candidate;
    candidate.shape     = TopoDS::Face( copy.Shape() );
    candidate.to_source = normalized.from_source.Inverted();
    double increase_m   = 0;
    if ( repair ) {
      const double allowance_m = std::min( profile.linear_deflection_m * 0.01, normalized.diagonal_m * 1e-5 );
      if ( !repairParameters( candidate.shape, scale, allowance_m, increase_m, work ) ) {
        current.validation_error = "recovery_parameter_repair_rejected";
        continue;
      }
    }
    IMeshTools_Parameters parameters;
    parameters.Deflection =
        std::max( Precision::Confusion(),
                  std::min( profile.linear_deflection_m, normalized.diagonal_m * local_relative_deflection ) * scale );
    parameters.Angle         = std::min( profile.angular_deflection_rad, 0.15 );
    parameters.MinSize       = 10 * Precision::Confusion();
    parameters.AdjustMinSize = true;
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes( candidate.shape, TopAbs_FACE, faces );
    const auto run         = triangulate( candidate.shape, faces, parameters, work, refine_boundaries );
    candidate.status_flags = run.status_flags;
    for ( const int status : run.face_status ) {
      candidate.status_flags |= status;
    }
    candidate.missing_mesh = missingMesh( candidate.shape );
    if ( !run.done || !usable( candidate ) ) {
      current.validation_error = "recovery_meshing_failed";
      continue;
    }
    const auto checked = validateRecoveredMesh( source, candidate, profile, work );
    if ( !checked.error.empty() ) {
      current.validation_error = checked.error;
      continue;
    }
    recoveries.push_back(
        { reference, method, current.status_flags, checked.source_area_m2, checked.mesh_area_m2, increase_m } );
    candidate.display_origin = checked.display_origin;
    current                  = std::move( candidate );
    return;
  }
}
}  // namespace

PreparedMesh prepareMesh( const CadGeometry &geometry, const QualityProfile &profile, MeshRecoveryBudget &budget,
                          const WorkContext &work )
{
  work.check();
  BRepBuilderAPI_Copy copy( geometry.shape, true, false );
  if ( !copy.IsDone() ) {
    fail( "MESH_FAILED", "Cannot create a CAD meshing copy." );
  }
  TopTools_IndexedMapOfShape copied_faces;
  TopExp::MapShapes( copy.Shape(), TopAbs_FACE, copied_faces );
  if ( copied_faces.Extent() != geometry.faces.Extent() ) {
    fail( "MESH_FAILED", "Meshing copy changed the source face count." );
  }
  IMeshTools_Parameters parameters;
  parameters.Deflection = profile.linear_deflection_m;
  parameters.Angle      = profile.angular_deflection_rad;
  const auto initial    = triangulate( copy.Shape(), copied_faces, parameters, work );
  PreparedMesh result;
  result.complete      = initial.done;
  int attributed_flags = 0;
  for ( int index = 1; index <= geometry.faces.Extent(); ++index ) {
    work.check();
    const auto source = TopoDS::Face( geometry.faces( index ) );
    PreparedFace face;
    face.shape             = TopoDS::Face( copy.ModifiedShape( source ) );
    const int copied_index = copied_faces.FindIndex( face.shape );
    if ( copied_index == 0 ) {
      fail( "MESH_FAILED", "Meshing copy lost a source face." );
    }
    face.status_flags = initial.face_status[ copied_index ];
    attributed_flags |= face.status_flags;
    face.missing_mesh = missingMesh( face.shape );
    if ( initial.done && !usable( face ) ) {
      if ( budget.remaining_faces == 0 ) {
        face.validation_error = "recovery_budget_exhausted";
      } else {
        --budget.remaining_faces;
        try {
          recoverFace( source, face, { "face", topologyId( geometry, "face", index ) }, profile, result.recoveries,
                       work );
        } catch ( const Standard_Failure & ) {
          work.check();
          face.validation_error = "recovery_kernel_error";
        } catch ( const CadFailure &error ) {
          work.check();
          if ( error.error().code != "UNSUPPORTED_SOURCE" ) {
            throw;
          }
          face.validation_error = "recovery_unsupported_scale";
        }
      }
    }
    result.complete = result.complete && usable( face );
    result.status_flags |= face.status_flags;
    result.faces.push_back( std::move( face ) );
  }
  // Preserve failures that OCCT could not attribute to an individual face.
  const int unattributed = initial.status_flags & ~attributed_flags;
  result.status_flags |= unattributed;
  result.displayable = initial.done && ( unattributed & mesh_failure_flags ) == 0;
  result.complete    = result.complete && ( unattributed & mesh_failure_flags ) == 0;
  return result;
}
}  // namespace dai::cad
