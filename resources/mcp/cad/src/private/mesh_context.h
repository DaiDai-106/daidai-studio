#ifndef DAI_CAD_MESH_CONTEXT_H
#define DAI_CAD_MESH_CONTEXT_H

#include <IMeshTools_Context.hxx>

namespace dai::cad
{
// Configure public OCCT extension points; no kernel source changes or status overrides.
[[nodiscard]] Handle( IMeshTools_Context ) meshingContext( bool refine_boundaries );
}  // namespace dai::cad
#endif  // DAI_CAD_MESH_CONTEXT_H
