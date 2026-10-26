#include "private/mesh_context.h"
#include "private/meshing.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <BRepMesh_Context.hxx>
#include <BRepMesh_CylinderRangeSplitter.hxx>
#include <BRepMesh_DefaultRangeSplitter.hxx>
#include <BRepMesh_DelaunayBaseMeshAlgo.hxx>
#include <BRepMesh_DelaunayNodeInsertionMeshAlgo.hxx>
#include <BRepMesh_EdgeDiscret.hxx>
#include <BRepMesh_FaceDiscret.hxx>
#include <BRepMesh_MeshAlgoFactory.hxx>
#include <IMeshData_Curve.hxx>
#include <IMeshData_PCurve.hxx>

namespace dai::cad
{
namespace
{
// Increase boundary sampling with the coverage budget; validate actual coverage
// separately. This sampling density alone is not an error guarantee.
constexpr unsigned boundary_samples = std::bit_ceil( static_cast<unsigned>( 2 / mesh_recovery_area_error ) + 1 );

class RefinedEdges final : public BRepMesh_EdgeDiscret
{
 protected:
  bool performInternal( const Handle( IMeshData_Model ) & model, const IMeshTools_Parameters &parameters,
                        const Message_ProgressRange &range ) override
  {
    if ( !BRepMesh_EdgeDiscret::performInternal( model, parameters, range ) ) {
      return false;
    }
    for ( int index = 0; index < model->EdgesNb(); ++index ) {
      if ( !range.More() ) {
        return false;
      }
      const auto &edge = model->GetEdge( index );
      if ( ( edge->GetStatusMask() & mesh_failure_flags ) != 0 ) {
        return false;
      }
      if ( edge->GetDegenerated() || edge->IsFree() ||
           edge->GetCurve()->ParametersNb() >= static_cast<int>( boundary_samples ) ) {
        continue;
      }
      const auto &pcurve = edge->GetPCurve( 0 );
      const auto tessellator =
          CreateEdgeTessellator( edge, pcurve->GetOrientation(), pcurve->GetFace(), parameters, boundary_samples );
      edge->GetCurve()->Clear( false );
      for ( int curve = 0; curve < edge->PCurvesNb(); ++curve ) {
        edge->GetPCurve( curve )->Clear( false );
      }
      Tessellate3d( edge, tessellator, true );
      Tessellate2d( edge, true );
    }
    return true;
  }
};

template <typename Base>
class TrimmedRangeSplitter final : public Base
{
 protected:
  void computeTolerance( double u_length, double v_length ) override
  {
    Base::computeTolerance( u_length, v_length );
    const auto cap = [ & ]( const std::pair<double, double> &range, double tolerance ) {
      const double span     = range.second - range.first;
      const double roundoff = 8 * std::numeric_limits<double>::epsilon() *
                              std::max( { 1.0, std::abs( range.first ), std::abs( range.second ) } );
      if ( !std::isfinite( span ) || span <= 4 * roundoff ) {
        this->myIsValid = false;
      }
      // Cap mesh-node merging by the trimmed UV range. CAD tolerances are unchanged.
      return std::max( roundoff, std::min( tolerance, span * 1e-7 ) );
    };
    this->myTolerance.first  = cap( this->myRangeU, this->myTolerance.first );
    this->myTolerance.second = cap( this->myRangeV, this->myTolerance.second );
  }
};

class RefinedMeshFactory final : public BRepMesh_MeshAlgoFactory
{
 public:
  Handle( IMeshTools_MeshAlgo )
      GetAlgo( GeomAbs_SurfaceType type, const IMeshTools_Parameters &parameters ) const override
  {
    if ( type == GeomAbs_Plane ) {
      return new BRepMesh_DelaunayNodeInsertionMeshAlgo<TrimmedRangeSplitter<BRepMesh_DefaultRangeSplitter>,
                                                        BRepMesh_DelaunayBaseMeshAlgo>;
    }
    if ( type == GeomAbs_Cylinder ) {
      return new BRepMesh_DelaunayNodeInsertionMeshAlgo<TrimmedRangeSplitter<BRepMesh_CylinderRangeSplitter>,
                                                        BRepMesh_DelaunayBaseMeshAlgo>;
    }
    return BRepMesh_MeshAlgoFactory::GetAlgo( type, parameters );
  }
};
}  // namespace

Handle( IMeshTools_Context ) meshingContext( bool refine_boundaries )
{
  Handle( IMeshTools_Context ) context = new BRepMesh_Context;
  if ( refine_boundaries ) {
    context->SetEdgeDiscret( new RefinedEdges );
    context->SetFaceDiscret( new BRepMesh_FaceDiscret( new RefinedMeshFactory ) );
  }
  return context;
}
}  // namespace dai::cad
