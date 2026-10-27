#ifndef DAI_ALIGNMENT_INSPECTION_H
#define DAI_ALIGNMENT_INSPECTION_H

#include "alignment/alignment.h"
#include <nlohmann/json_fwd.hpp>

namespace dai::alignment
{
// Reads the saved manifest and cached features; does not alter the model or placement.
[[nodiscard]] nlohmann::json inspectScene( const Request &request, const nlohmann::json &arguments );
// Resolves cached object-local features through their instance hierarchy and current placement.
[[nodiscard]] nlohmann::json inspectFeatures( const Request &request, const nlohmann::json &arguments );
// Lists geometric features across objects, without inferring their semantic purpose.
[[nodiscard]] nlohmann::json findFeatures( const Request &request, const nlohmann::json &arguments );
}  // namespace dai::alignment
#endif
