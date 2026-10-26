#ifndef DAI_CAD_UNITS_H
#define DAI_CAD_UNITS_H

#include "cad/types.h"
#include <StepData_StepModel.hxx>

namespace dai::cad
{
// Edit only the private in-memory STEP model when an explicit override is supplied.
void validateUnits( const Handle( StepData_StepModel ) & model, const std::optional<std::string> &unit_override,
                    const WorkContext &work );
}  // namespace dai::cad
#endif  // DAI_CAD_UNITS_H
