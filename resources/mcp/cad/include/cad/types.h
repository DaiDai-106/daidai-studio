#ifndef DAI_CAD_TYPES_H
#define DAI_CAD_TYPES_H

#include <array>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace dai::cad
{
using Json = nlohmann::json;
using Vec3 = std::array<double, 3>;
using Rgba = std::array<double, 4>;

// Right-handed Z-up coordinates; translations are metres and quaternions are x/y/z/w.
struct Transform {
  Vec3 translation{ 0, 0, 0 };
  std::array<double, 4> rotation{ 0, 0, 0, 1 };
  Vec3 scale{ 1, 1, 1 };
};
struct CadHandle {
  std::string server_instance_id;
  std::string id;
};
struct TopologyRef {
  std::string kind;
  std::string id;
};
struct CadError {
  std::string code;
  std::string message;
  std::optional<std::string> object_id;
  std::optional<TopologyRef> topology_ref;
};

// Domain failures unwind owned OCCT resources; only the protocol boundary catches them.
class CadFailure final : public std::runtime_error
{
 public:
  explicit CadFailure( CadError error );
  [[nodiscard]] const CadError &error() const noexcept;

 private:
  CadError error_;
};
[[noreturn]] void fail( std::string code, std::string message );

struct Limits {
  std::uint64_t max_file_bytes           = 512ULL * 1024 * 1024;
  std::size_t max_objects                = 100000;
  std::size_t max_page_bytes             = 256 * 1024;
  std::size_t max_output_bytes           = 1024 * 1024;
  std::uint64_t max_triangles            = 10000000;
  std::uint64_t max_resource_bytes       = 1024ULL * 1024 * 1024;
  std::uint64_t max_total_resource_bytes = 2ULL * 1024 * 1024 * 1024;
  std::size_t max_retained_jobs          = 128;
  std::uint64_t job_timeout_ms           = 300000;
  std::uint64_t query_timeout_ms         = 10000;
};
struct ServerContext {
  std::string server_instance_id;
  std::filesystem::path project_root;
  std::filesystem::path staging_root;
  // Successful outputs belong to the MCP service, beyond the native document.
  std::filesystem::path output_root;
  Limits limits;
};
struct SourceVersion {
  // Canonical absolute source path; hashes describe the private bytes actually parsed.
  std::string path;
  std::string source_hash;
  std::string import_fingerprint;
  std::optional<std::string> unit_override;
  std::vector<std::string> length_units;
};
struct ResourceRef {
  std::string uri;
  std::string media_type;
  std::uint64_t byte_length = 0;
  std::string sha256;
};
struct WorkContext {
  std::stop_token stop;
  std::chrono::steady_clock::time_point deadline;
  const Limits &limits;
  std::function<void( std::string, std::optional<double> )> on_progress;
  void check() const;
  void report( std::string phase, std::optional<double> fraction = {} ) const;
};
// Instance identity is document-local; repeated instances may share geometry_id.
struct CadObject {
  std::string id;
  std::string source_key;
  std::string name;
  std::string parent_id;
  std::string geometry_id;
  Transform local_transform;
  std::vector<std::string> children;
  std::optional<Rgba> color;
};
struct QualityProfile {
  double linear_deflection_m;
  double angular_deflection_rad;
};

[[nodiscard]] QualityProfile qualityProfile( const std::string &quality );
[[nodiscard]] Json capabilities( const ServerContext &context );
[[nodiscard]] Json toJson( const SourceVersion &value );
[[nodiscard]] Json toJson( const ResourceRef &value );
[[nodiscard]] Json toJson( const Transform &value );
[[nodiscard]] Json toJson( const CadHandle &value );
[[nodiscard]] Json toJson( const CadError &value );
[[nodiscard]] Json toJson( const CadObject &value );
[[nodiscard]] Json toJson( const Limits &value );
[[nodiscard]] std::string newId();
[[nodiscard]] std::string sha256( const std::string &bytes );
[[nodiscard]] std::string importFingerprint( const std::optional<std::string> &unit_override );
}  // namespace dai::cad
#endif  // DAI_CAD_TYPES_H
