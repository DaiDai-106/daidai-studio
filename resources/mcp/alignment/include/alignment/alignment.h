#ifndef DAI_ALIGNMENT_H
#define DAI_ALIGNMENT_H

#include <array>
#include <filesystem>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace dai::alignment
{
using Vec3       = std::array<double, 3>;
using Quaternion = std::array<double, 4>;
struct Bounds {
  Vec3 min;
  Vec3 max;
};
// Metres, right-handed Z-up; quaternion components x/y/z/w. Never changes model scale.
struct Placement {
  Vec3 translation{ 0, 0, 0 };
  Quaternion rotation{ 0, 0, 0, 1 };
};
struct Transform : Placement {
  Vec3 scale{ 1, 1, 1 };
};
struct Frame {
  Vec3 origin{ 0, 0, 0 };
  Vec3 up{ 0, 0, 1 };
  Vec3 forward{ 1, 0, 0 };
};
struct FeatureRef {
  std::string object_id;
  std::string feature_id;
};
struct DirectionRef {
  std::string kind;
  std::string axis;
  FeatureRef feature;
  bool reverse = false;
};
struct PointRef {
  std::string kind;
  std::optional<Vec3> position;
  FeatureRef feature;
};
enum class Operation { BOUNDS, MIN_CORNER, ALIGN_FRAME, ROTATE, ALIGN_DIRECTION, GROUND };
struct Request {
  std::filesystem::path glb_path;
  std::filesystem::path manifest_path;
  std::filesystem::path features_path;
  Transform display_to_scene;
  Placement placement;
  Operation operation = Operation::BOUNDS;
  std::string object_id;
  DirectionRef source_up;
  DirectionRef source_forward;
  std::string anchor;
  std::optional<PointRef> source_origin;
  Frame target;
  Vec3 axis{ 0, 0, 1 };
  Vec3 pivot{ 0, 0, 0 };
  double angle_degrees = 0;
  bool model_space     = false;
  DirectionRef source_direction;
  Vec3 target_direction{ 0, 0, 1 };
  bool pivot_bounds_center = false;
  std::vector<FeatureRef> contacts;
  double ground_z = 0;
};
struct GroundContact {
  FeatureRef feature;
  double before_z;
  double after_z;
};
struct ResolvedDirection {
  Vec3 source;
  Vec3 target;
  Vec3 axis;
  double angle_degrees;
  Vec3 pivot;
};
struct Snapshot {
  Placement placement;
  Bounds bounds;
};
struct Result {
  Snapshot before;
  Snapshot after;
  std::optional<Frame> source_frame;
  std::optional<Frame> target_frame;
  std::vector<FeatureRef> used_references;
  std::optional<ResolvedDirection> resolved_direction;
  std::vector<GroundContact> ground_contacts;
};
class AlignmentError final : public std::runtime_error
{
 public:
  AlignmentError( std::string code, std::string message );
  const std::string code;
};
// Reads an immutable display bundle. Computes absolute proposals; never writes project files.
[[nodiscard]] Result computeAlignment( const Request &request );
[[nodiscard]] std::map<std::string, Bounds> computeObjectBounds( const Request &request );
}  // namespace dai::alignment
#endif
