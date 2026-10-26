#ifndef DAI_CAD_SERIALIZATION_H
#define DAI_CAD_SERIALIZATION_H

#include "cad/geometry.h"
#include "cad/jobs.h"
#include "cad/queries.h"

namespace dai::cad
{
// JSON belongs at the worker boundary, not inside geometry algorithms.
[[nodiscard]] ImportRequest importRequest( const Json &input );
[[nodiscard]] DistanceObject distanceObject( const Json &input );
[[nodiscard]] PageQuery pageQuery( const Json &input );
[[nodiscard]] CadError currentError();
[[nodiscard]] Json success( Json data );
[[nodiscard]] Json failure( const CadError &error );
}  // namespace dai::cad
#endif  // DAI_CAD_SERIALIZATION_H
