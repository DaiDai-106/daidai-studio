#ifndef DAI_CAD_JOBS_H
#define DAI_CAD_JOBS_H

#include "cad/display.h"
#include <variant>

namespace dai::cad
{
enum class JobKind { IMPORT, DISPLAY };
enum class JobStatus { QUEUED, RUNNING, CANCELLING, SUCCEEDED, FAILED, CANCELLED };

struct ImportRequest {
  std::string path;
  std::optional<std::string> unit_override;
};
struct ImportResult {
  CadHandle document;
  SourceVersion source;
  std::size_t object_count      = 0;
  std::size_t root_object_count = 0;
  std::vector<std::string> warnings;
};
using JobResult = std::variant<std::monostate, ImportResult, DisplayResult>;

// The service mutex protects records; only the geometry thread owns CadDocument.
struct CadJob {
  CadHandle handle;
  JobKind kind     = JobKind::IMPORT;
  JobStatus status = JobStatus::QUEUED;
  std::stop_source cancel;
  std::string phase;
  std::optional<double> progress;
  JobResult result;
  std::optional<CadError> error;
};
[[nodiscard]] bool terminal( JobStatus status );
[[nodiscard]] const char *statusName( JobStatus status );
[[nodiscard]] Json toJson( const ImportResult &value );
[[nodiscard]] Json toJson( const CadJob &value );
}  // namespace dai::cad
#endif  // DAI_CAD_JOBS_H
