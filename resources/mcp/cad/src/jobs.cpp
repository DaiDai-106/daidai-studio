#include "cad/jobs.h"

namespace dai::cad
{
bool terminal( JobStatus status )
{
  return status == JobStatus::SUCCEEDED || status == JobStatus::FAILED || status == JobStatus::CANCELLED;
}
const char *statusName( JobStatus status )
{
  switch ( status ) {
    case JobStatus::QUEUED: return "queued";
    case JobStatus::RUNNING: return "running";
    case JobStatus::CANCELLING: return "cancelling";
    case JobStatus::SUCCEEDED: return "succeeded";
    case JobStatus::FAILED: return "failed";
    case JobStatus::CANCELLED: return "cancelled";
  }
  std::terminate();
}
Json toJson( const CadJob &value )
{
  Json data{
      {"job",    toJson( value.handle )                              },
      {"kind",   value.kind == JobKind::IMPORT ? "import" : "display"},
      {"status", statusName( value.status )                          }
  };
  if ( !terminal( value.status ) ) {
    if ( !value.phase.empty() ) {
      data[ "phase" ] = value.phase;
    }
    if ( value.progress ) {
      data[ "progress" ] = {
          {"completed", *value.progress},
          {"total",     1              },
          {"unit",      "fraction"     }
      };
    }
  } else if ( value.status == JobStatus::SUCCEEDED ) {
    std::visit(
        [ & ]( const auto &result ) {
          using T = std::decay_t<decltype( result )>;
          if constexpr ( !std::is_same_v<T, std::monostate> ) {
            data[ "result" ] = toJson( result );
          }
        },
        value.result );
  } else if ( value.status == JobStatus::FAILED ) {
    data[ "error" ] = toJson( *value.error );
  }
  return data;
}
}  // namespace dai::cad
