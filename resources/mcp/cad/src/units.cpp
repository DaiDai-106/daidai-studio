#include "private/units.h"
#include <StepBasic_ConversionBasedUnitAndLengthUnit.hxx>
#include <StepBasic_DimensionalExponents.hxx>
#include <StepBasic_HArray1OfNamedUnit.hxx>
#include <StepBasic_LengthUnit.hxx>
#include <StepBasic_MeasureValueMember.hxx>
#include <StepBasic_MeasureWithUnit.hxx>
#include <StepBasic_SiUnitAndLengthUnit.hxx>
#include <StepBasic_Unit.hxx>
#include <StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx.hxx>
#include <StepGeom_GeometricRepresentationContextAndGlobalUnitAssignedContext.hxx>
#include <StepRepr_GlobalUnitAssignedContext.hxx>
#include <TCollection_HAsciiString.hxx>

namespace dai::cad
{
namespace
{
Handle( StepBasic_NamedUnit ) makeLengthUnit( const std::string &name )
{
  Handle( StepBasic_SiUnitAndLengthUnit ) metre = new StepBasic_SiUnitAndLengthUnit;
  metre->Init( name == "mm" || name == "cm", name == "cm" ? StepBasic_spCenti : StepBasic_spMilli, StepBasic_sunMetre );
  if ( name == "m" || name == "mm" || name == "cm" ) {
    return metre;
  }
  if ( name != "in" && name != "ft" ) {
    fail( "INVALID_ARGUMENT", "Unknown source unit override." );
  }
  Handle( StepBasic_MeasureValueMember ) value = new StepBasic_MeasureValueMember;
  value->SetName( "LENGTH_MEASURE" );
  value->SetReal( name == "in" ? 0.0254 : 0.3048 );
  StepBasic_Unit unit;
  unit.SetValue( metre );
  Handle( StepBasic_MeasureWithUnit ) factor = new StepBasic_MeasureWithUnit;
  factor->Init( value, unit );
  Handle( StepBasic_DimensionalExponents ) dimensions = new StepBasic_DimensionalExponents;
  dimensions->Init( 1, 0, 0, 0, 0, 0, 0 );
  Handle( StepBasic_ConversionBasedUnitAndLengthUnit ) converted = new StepBasic_ConversionBasedUnitAndLengthUnit;
  converted->Init( dimensions, new TCollection_HAsciiString( name.c_str() ), factor );
  return converted;
}

bool isLength( const Handle( StepBasic_NamedUnit ) & unit )
{
  return !unit.IsNull() && ( unit->IsKind( STANDARD_TYPE( StepBasic_SiUnitAndLengthUnit ) ) ||
                             unit->IsKind( STANDARD_TYPE( StepBasic_ConversionBasedUnitAndLengthUnit ) ) ||
                             unit->IsKind( STANDARD_TYPE( StepBasic_LengthUnit ) ) );
}
}  // namespace

void validateUnits( const Handle( StepData_StepModel ) & model, const std::optional<std::string> &unit_override,
                    const WorkContext &work )
{
  int context_count = 0;
  for ( int index = 1; index <= model->NbEntities(); ++index ) {
    work.check();
    const auto entity = model->Value( index );
    auto context      = Handle( StepRepr_GlobalUnitAssignedContext )::DownCast( entity );
    if ( const auto combined =
             Handle( StepGeom_GeometricRepresentationContextAndGlobalUnitAssignedContext )::DownCast( entity );
         !combined.IsNull() ) {
      context = combined->GlobalUnitAssignedContext();
    }
    if ( const auto combined =
             Handle( StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx )::DownCast( entity );
         !combined.IsNull() ) {
      context = combined->GlobalUnitAssignedContext();
    }
    if ( context.IsNull() ) {
      continue;
    }
    ++context_count;
    std::vector<Handle( StepBasic_NamedUnit )> units;
    int length_count = 0;
    for ( int i = 1; i <= context->NbUnits(); ++i ) {
      const auto unit = context->UnitsValue( i );
      if ( isLength( unit ) ) {
        ++length_count;
        if ( unit_override ) {
          continue;
        }
        if ( unit->DynamicType() == STANDARD_TYPE( StepBasic_LengthUnit ) ) {
          fail( "UNIT_UNRESOLVED", "STEP length unit has no conversion; supply an explicit override." );
        }
      }
      units.push_back( unit );
    }
    if ( unit_override ) {
      units.push_back( makeLengthUnit( *unit_override ) );
      Handle( StepBasic_HArray1OfNamedUnit ) replacements = new StepBasic_HArray1OfNamedUnit( 1, units.size() );
      for ( std::size_t i = 0; i < units.size(); ++i ) {
        replacements->SetValue( i + 1, units[ i ] );
      }
      context->SetUnits( replacements );
    } else if ( length_count != 1 ) {
      fail( "UNIT_UNRESOLVED", "STEP has missing or conflicting length units; supply an explicit override." );
    }
  }
  if ( context_count == 0 ) {
    fail( "UNIT_UNRESOLVED", "STEP has no supported unit context." );
  }
}
}  // namespace dai::cad
