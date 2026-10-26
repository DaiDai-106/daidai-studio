#ifndef DAI_CAD_STEP_READER_H
#define DAI_CAD_STEP_READER_H

#include "cad/document.h"

namespace dai::cad
{
// Synchronous, geometry-thread-only. Source placements and all lengths become metres.
[[nodiscard]] std::unique_ptr<CadDocument> readStep( const SourceVersion &source, const std::filesystem::path &snapshot,
                                                     const WorkContext &work );
}  // namespace dai::cad
#endif  // DAI_CAD_STEP_READER_H
