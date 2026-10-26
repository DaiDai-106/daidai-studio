#ifndef DAI_CAD_MESHING_H
#define DAI_CAD_MESHING_H

#include "cad/display.h"
#include "private/document_internal.h"
#include <TopoDS_Face.hxx>
#include <gp_Trsf.hxx>
#include <gp_Pnt.hxx>
#include <IMeshData_Status.hxx>

namespace dai::cad
{
inline constexpr double mesh_recovery_area_error = 0.01;
inline constexpr int mesh_failure_flags = IMeshData_OpenWire | IMeshData_SelfIntersectingWire | IMeshData_Failure |
                                          IMeshData_UnorientedWire | IMeshData_TooFewPoints | IMeshData_UserBreak;
struct PreparedFace {
  TopoDS_Face shape;
  gp_Trsf to_source;
  gp_Pnt display_origin;
  int status_flags  = 0;
  bool missing_mesh = true;
  std::string validation_error;
};
struct PreparedMesh {
  std::vector<PreparedFace> faces;
  std::vector<FaceMeshRecovery> recoveries;
  bool complete    = false;
  // False when a whole-shape failure cannot be safely attributed to faces.
  bool displayable = false;
  int status_flags = 0;
};
struct MeshValidation {
  std::string error;
  double source_area_m2 = 0;
  double mesh_area_m2   = 0;
  gp_Pnt display_origin;
};

// All triangulation and parameter repairs operate on owned, geometry-deep copies.
[[nodiscard]] PreparedMesh prepareMesh( const CadGeometry &geometry, const QualityProfile &profile,
                                        MeshRecoveryBudget &budget, const WorkContext &work );
[[nodiscard]] MeshValidation validateRecoveredMesh( const TopoDS_Face &source, const PreparedFace &candidate,
                                                    const QualityProfile &profile, const WorkContext &work );
}  // namespace dai::cad
#endif  // DAI_CAD_MESHING_H
