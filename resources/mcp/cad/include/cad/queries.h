#ifndef DAI_CAD_QUERIES_H
#define DAI_CAD_QUERIES_H

#include "cad/document.h"
#include "cad/geometry.h"
#include <set>
#include <variant>

namespace dai::cad
{
struct PageQuery {
  std::string cursor;
  std::size_t limit = 50;
};
struct StructureQuery {
  bool all = false;
  std::string parent_id;
  std::string name_contains;
  PageQuery page;
};
struct PropertiesQuery {
  std::vector<std::string> object_ids;
  std::set<std::string> fields;
};
struct FeatureQuery {
  std::string object_id;
  std::optional<TopologyRef> topology_ref;
  std::set<std::string> types;
  PageQuery page;
};
struct StructurePage {
  std::vector<CadObject> items;
  std::optional<std::string> next_cursor;
};
struct ObjectBounds {
  Vec3 min;
  Vec3 max;
};
struct TopologyCounts {
  int vertex_count = 0;
  int edge_count   = 0;
  int face_count   = 0;
  int shell_count  = 0;
  int solid_count  = 0;
};
struct SourceAppearance {
  std::optional<Rgba> object_color;
  std::size_t face_color_count = 0;
};
struct PropertyUnavailable {
  std::string reason;
};
template <typename T>
using PropertyValue = std::variant<T, PropertyUnavailable>;
// An absent field was not requested; an unavailable value retains its reason.
struct ObjectProperties {
  std::string object_id;
  std::optional<PropertyValue<ObjectBounds>> bounds;
  std::optional<PropertyValue<TopologyCounts>> topology;
  std::optional<PropertyValue<SourceAppearance>> appearance;
  std::optional<PropertyValue<GeometryValidity>> validity;
  std::optional<PropertyValue<GeometryMeasures>> measures;
};
struct PropertiesPage {
  std::vector<ObjectProperties> items;
};
struct GeometryFeature {
  std::string id;
  std::string object_id;
  std::string type;
  TopologyRef topology_ref;
  Vec3 origin{};
  std::optional<Vec3> direction;
  std::optional<double> radius;
};
struct FeaturePage {
  std::vector<GeometryFeature> items;
  std::optional<std::string> next_cursor;
  bool analysis_complete = true;
  std::vector<std::string> warnings;
};

[[nodiscard]] StructurePage getStructure( const CadDocument &document, const StructureQuery &query,
                                          const WorkContext &work );
[[nodiscard]] PropertiesPage getProperties( const CadDocument &document, const PropertiesQuery &query,
                                            const WorkContext &work );
[[nodiscard]] FeaturePage listGeometryFeatures( const CadDocument &document, const FeatureQuery &query,
                                                const WorkContext &work );
[[nodiscard]] Json toJson( const ObjectBounds &value );
[[nodiscard]] Json toJson( const TopologyCounts &value );
[[nodiscard]] Json toJson( const SourceAppearance &value );
[[nodiscard]] Json toJson( const ObjectProperties &value );
[[nodiscard]] Json toJson( const GeometryFeature &value );
[[nodiscard]] Json toJson( const StructurePage &value );
[[nodiscard]] Json toJson( const PropertiesPage &value );
[[nodiscard]] Json toJson( const FeaturePage &value );
}  // namespace dai::cad
#endif  // DAI_CAD_QUERIES_H
