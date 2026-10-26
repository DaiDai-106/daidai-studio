#ifndef DAI_CAD_DISPLAY_H
#define DAI_CAD_DISPLAY_H

#include "cad/document.h"

namespace dai::cad
{
struct DisplaySummary {
  SourceVersion source;
  bool complete                  = false;
  std::size_t object_count       = 0;
  std::size_t geometry_count     = 0;
  std::uint64_t triangle_count   = 0;
  std::size_t warning_count      = 0;
  // Counts unique CAD faces, before repeated assembly instances.
  std::size_t omitted_face_count = 0;
};
struct DisplayResult {
  ResourceRef manifest;
  DisplaySummary summary;
};
[[nodiscard]] Json toJson( const DisplayResult &value );

struct FaceTriangleRange {
  TopologyRef face;
  std::uint32_t first_triangle;
  std::uint32_t triangle_count;
};
struct MeshPrimitive {
  std::optional<Rgba> source_color;
  std::vector<std::uint32_t> indices;
  std::vector<FaceTriangleRange> face_ranges;
};
struct MeshChunk {
  Vec3 origin{ 0, 0, 0 };
  std::vector<float> positions;
  std::vector<float> normals;
  std::vector<MeshPrimitive> primitives;
};
struct FaceMeshIssue {
  TopologyRef face;
  int status_flags;
  bool missing_mesh;
  std::string validation_error;
};
struct FaceMeshRecovery {
  TopologyRef face;
  std::string method;
  int original_status_flags;
  double source_area_m2;
  double mesh_area_m2;
  double tolerance_increase_m;
};
struct MeshRecoveryBudget {
  std::size_t remaining_faces = 128;
};
struct MeshData {
  std::string geometry_id;
  std::vector<MeshChunk> chunks;
  std::vector<FaceMeshIssue> face_issues;
  std::vector<FaceMeshRecovery> recoveries;
  bool complete    = true;
  int status_flags = 0;
};
// Geometry-local meshes; original CAD topology and instance placement are unchanged.
[[nodiscard]] MeshData meshGeometry( CadDocument &document, const std::string &geometry_id,
                                     const QualityProfile &profile, MeshRecoveryBudget &budget,
                                     const WorkContext &work );
[[nodiscard]] DisplayResult writeDisplay( CadDocument &document, const std::string &quality,
                                          const ServerContext &server, const std::filesystem::path &job_directory,
                                          const WorkContext &work );
}  // namespace dai::cad
#endif  // DAI_CAD_DISPLAY_H
