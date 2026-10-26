#ifndef DAI_CAD_GEOMETRY_H
#define DAI_CAD_GEOMETRY_H

#include "cad/document.h"
#include <variant>

namespace dai::cad
{
struct GeometryIssue {
  std::string shape_type;
  std::string code;
  std::optional<TopologyRef> topology_ref;
};
struct GeometryValidity {
  bool valid              = false;
  std::size_t issue_count = 0;
  bool truncated          = false;
  std::vector<GeometryIssue> issues;
};

// Read-only OCCT validity analysis. It does not heal shapes or certify meshing/collision results.
[[nodiscard]] GeometryValidity validateGeometry( const CadDocument &document, const std::string &object_id,
                                                 const WorkContext &work );
[[nodiscard]] Json toJson( const GeometryValidity &value );

struct GeometricMeasure {
  double amount = 0;
  Vec3 centroid{};
  double relative_error_estimate = 0;
};
struct MeasureUnavailable {
  std::string reason;
};
using MeasureResult = std::variant<GeometricMeasure, MeasureUnavailable>;
struct GeometryMeasures {
  MeasureResult surface;
  MeasureResult volume;
};

// Integrates original B-Rep surfaces in object coordinates, without mesh estimates or density.
// A valid B-Rep is required. Volume also requires solids with no loose faces; sums are not Boolean unions.
[[nodiscard]] GeometryMeasures measureGeometry( const CadDocument &document, const std::string &object_id,
                                                const WorkContext &work );
[[nodiscard]] Json toJson( const GeometryMeasures &value );

struct DistanceObject {
  std::string object_id;
  Transform placement;
};
struct DistanceQuery {
  DistanceObject first;
  DistanceObject second;
  std::size_t max_solutions = 10;
};
struct DistanceSolution {
  Vec3 first;
  Vec3 second;
};
struct GeometryDistance {
  std::string first_object_id;
  std::string second_object_id;
  double distance_m          = 0;
  double deflection_m        = 0;
  bool inner_solution        = false;
  std::size_t solution_count = 0;
  bool truncated             = false;
  std::vector<DistanceSolution> solutions;
};

// Read-only B-Rep distance in the common coordinates of the supplied rigid placements.
// Zero distance does not distinguish contact from penetration or certify collision freedom.
[[nodiscard]] GeometryDistance measureDistance( const CadDocument &document, const DistanceQuery &query,
                                                const WorkContext &work );
[[nodiscard]] Json toJson( const GeometryDistance &value );

struct DecompositionResult {
  bool changed;
  std::string parent_object_id;
  std::vector<std::string> child_object_ids;
  std::size_t child_count;
  std::size_t object_count;
};
[[nodiscard]] Json toJson( const DecompositionResult &result );

// Unpack existing independent solids/loose shells without moving or cutting them.
// A solid's own shells are never separate components.
[[nodiscard]] DecompositionResult decomposeObject( CadDocument &document, const std::string &object_id,
                                                   const WorkContext &work );
}  // namespace dai::cad
#endif  // DAI_CAD_GEOMETRY_H
