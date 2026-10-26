#include "cad/step_reader.h"
#include "private/progress.h"
#include "private/units.h"
#include "private/document_internal.h"
#include <cmath>
#include <fstream>
#include <set>
#include <DESTEP_Parameters.hxx>
#include <Interface_CheckIterator.hxx>
#include <Quantity_ColorRGBA.hxx>
#include <STEPCAFControl_Controller.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPConstruct_ExternRefs.hxx>
#include <TCollection_AsciiString.hxx>
#include <TColStd_SequenceOfAsciiString.hxx>
#include <TDataStd_Name.hxx>
#include <TDF_LabelSequence.hxx>
#include <TDF_Tool.hxx>
#include <TopExp.hxx>
#include <Transfer_TransientProcess.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XSControl_WorkSession.hxx>
#include <gp_Quaternion.hxx>

namespace dai::cad
{
namespace
{
std::string labelKey( const TDF_Label &label )
{
  TCollection_AsciiString entry;
  TDF_Tool::Entry( label, entry );
  return entry.ToCString();
}
std::string labelName( const TDF_Label &label )
{
  Handle( TDataStd_Name ) name;
  if ( !label.FindAttribute( TDataStd_Name::GetID(), name ) ) {
    return {};
  }
  const auto &value = name->Get();
  if ( value.Length() > 1000 || value.LengthOfCString() > 4000 ) {
    fail( "LIMIT_EXCEEDED", "CAD object name exceeds the text limit." );
  }
  std::string result( value.LengthOfCString() + 1, '\0' );
  auto buffer = result.data();
  result.resize( value.ToUTF8CString( buffer ) );
  return result;
}
Transform toTransform( const TopLoc_Location &location )
{
  const auto &value = location.Transformation();
  if ( std::abs( value.ScaleFactor() - 1 ) > 1e-9 || value.IsNegative() ) {
    fail( "UNSUPPORTED_SOURCE", "STEP instance has a non-rigid placement." );
  }
  const auto translation = value.TranslationPart();
  auto rotation          = value.GetRotation();
  rotation.Normalize();
  Transform result{
      { translation.X(), translation.Y(), translation.Z() },
      { rotation.X(), rotation.Y(), rotation.Z(), rotation.W() },
      { 1, 1, 1 }
  };
  for ( const auto v : result.translation ) {
    if ( !std::isfinite( v ) ) {
      fail( "PARSE_FAILED", "Invalid CAD placement." );
    }
  }
  return result;
}
std::optional<Rgba> labelColor( const TDF_Label &label )
{
  Quantity_ColorRGBA color;
  if ( !XCAFDoc_ColorTool::GetColor( label, XCAFDoc_ColorSurf, color ) &&
       !XCAFDoc_ColorTool::GetColor( label, XCAFDoc_ColorGen, color ) ) {
    return {};
  }
  double r, g, b;
  color.GetRGB().Values( r, g, b, Quantity_TOC_sRGB );
  return Rgba{ r, g, b, color.Alpha() };
}

void buildStructure( CadDocument &document, const WorkContext &work )
{
  auto &storage     = document.storage();
  const auto shapes = XCAFDoc_DocumentTool::ShapeTool( storage.document->Main() );
  const auto colors = XCAFDoc_DocumentTool::ColorTool( storage.document->Main() );
  TDF_LabelSequence roots;
  shapes->GetFreeShapes( roots );
  struct Pending {
    TDF_Label label;
    std::string parent_id;
    std::string source_path;
    std::string exit_key;
    std::optional<Rgba> inherited_color;
  };
  std::vector<Pending> pending;
  std::set<std::string> ancestors;
  for ( int i = roots.Length(); i > 0; --i ) {
    pending.push_back( { roots.Value( i ), {}, {}, {}, {} } );
  }
  while ( !pending.empty() ) {
    work.check();
    auto current = std::move( pending.back() );
    pending.pop_back();
    if ( !current.exit_key.empty() ) {
      ancestors.erase( current.exit_key );
      continue;
    }
    if ( storage.objects.size() >= work.limits.max_objects || ancestors.size() >= 256 ) {
      fail( "LIMIT_EXCEEDED", "STEP object count or assembly depth exceeds the limit." );
    }
    TDF_Label definition = current.label;
    auto location        = XCAFDoc_ShapeTool::GetLocation( definition );
    std::set<std::string> references;
    const auto is_instance = XCAFDoc_ShapeTool::IsReference( definition );
    while ( XCAFDoc_ShapeTool::IsReference( definition ) ) {
      if ( !references.insert( labelKey( definition ) ).second ) {
        fail( "PARSE_FAILED", "Cyclic STEP reference." );
      }
      TDF_Label referred;
      if ( !XCAFDoc_ShapeTool::GetReferredShape( definition, referred ) ) {
        fail( "PARSE_FAILED", "Invalid STEP reference." );
      }
      definition = referred;
      location   = location * XCAFDoc_ShapeTool::GetLocation( definition );
    }
    const auto definition_key = labelKey( definition );
    if ( !ancestors.insert( definition_key ).second ) {
      fail( "PARSE_FAILED", "Cyclic STEP assembly." );
    }
    CadObject object;
    object.id         = newId();
    object.source_key = current.source_path + "/" + labelKey( current.label ) + "@" + definition_key;
    if ( object.source_key.size() > 4096 ) {
      fail( "LIMIT_EXCEEDED", "STEP instance path exceeds the limit." );
    }
    object.parent_id = current.parent_id;
    object.name      = labelName( current.label );
    if ( object.name.empty() ) {
      object.name = labelName( definition );
    }
    object.local_transform = toTransform( location );
    object.color           = labelColor( current.label );
    if ( is_instance && object.color ) {
      storage.instance_color_overrides.emplace( object.id, *object.color );
    }
    if ( !object.color ) {
      object.color = labelColor( definition );
    }
    if ( !object.color ) {
      object.color = current.inherited_color;
    }
    TDF_LabelSequence children;
    if ( XCAFDoc_ShapeTool::IsAssembly( definition ) ) {
      XCAFDoc_ShapeTool::GetComponents( definition, children );
      if ( children.IsEmpty() ) {
        fail( "PARSE_FAILED", "Empty STEP assembly." );
      }
    } else {
      object.geometry_id = definition_key;
      if ( !storage.geometries.contains( definition_key ) ) {
        auto original = XCAFDoc_ShapeTool::GetShape( definition );
        if ( original.IsNull() ) {
          fail( "PARSE_FAILED", "STEP object has no shape." );
        }
        TopTools_IndexedMapOfShape original_faces;
        TopExp::MapShapes( original, TopAbs_FACE, original_faces );
        CadGeometry geometry;
        geometry.id    = definition_key;
        geometry.shape = original.Located( TopLoc_Location() );
        TopExp::MapShapes( geometry.shape, TopAbs_FACE, geometry.faces );
        TopExp::MapShapes( geometry.shape, TopAbs_EDGE, geometry.edges );
        TopExp::MapShapes( geometry.shape, TopAbs_VERTEX, geometry.vertices );
        geometry.face_colors.resize( geometry.faces.Extent() );
        for ( int i = 1; i <= original_faces.Extent(); ++i ) {
          Quantity_ColorRGBA color;
          if ( colors->GetColor( original_faces( i ), XCAFDoc_ColorSurf, color ) ||
               colors->GetColor( original_faces( i ), XCAFDoc_ColorGen, color ) ) {
            double r, g, b;
            color.GetRGB().Values( r, g, b, Quantity_TOC_sRGB );
            geometry.face_colors[ i - 1 ] = Rgba{ r, g, b, color.Alpha() };
          }
        }
        storage.geometries.emplace( definition_key, std::move( geometry ) );
      }
    }
    const auto id        = object.id;
    const auto path      = object.source_key;
    const auto inherited = object.color;
    if ( object.parent_id.empty() ) {
      storage.roots.push_back( id );
    } else {
      storage.objects[ storage.object_indices.at( object.parent_id ) ].children.push_back( id );
    }
    storage.object_indices.emplace( id, storage.objects.size() );
    storage.objects.push_back( std::move( object ) );
    pending.push_back( { {}, {}, {}, definition_key, {} } );
    for ( int i = children.Length(); i > 0; --i ) {
      pending.push_back( { children.Value( i ), id, path, {}, inherited } );
    }
  }
  if ( storage.geometries.empty() ) {
    fail( "PARSE_FAILED", "STEP has no usable geometry." );
  }
}
}  // namespace

std::unique_ptr<CadDocument> readStep( const SourceVersion &source, const std::filesystem::path &snapshot,
                                       const WorkContext &work )
{
  work.report( "read_step" );
  STEPCAFControl_Controller::Init();
  STEPCAFControl_Reader reader;
  reader.SetColorMode( true );
  reader.SetNameMode( true );
  reader.SetShapeFixParameters( DESTEP_Parameters::GetDefaultShapeFixParameters() );
  std::ifstream input( snapshot, std::ios::binary );
  if ( reader.ReadStream( "source.step", input ) != IFSelect_RetDone ) {
    fail( "PARSE_FAILED", "Cannot parse STEP." );
  }
  if ( !reader.Reader().WS()->ModelCheckList().IsEmpty( true ) ) {
    fail( "PARSE_FAILED", "STEP contains syntax errors." );
  }
  STEPConstruct_ExternRefs references( reader.Reader().WS() );
  references.LoadExternRefs();
  if ( references.NbExternRefs() ) {
    fail( "UNSUPPORTED_SOURCE", "External STEP references are not supported." );
  }
  auto document = std::make_unique<CadDocument>( source );
  auto &storage = document->storage();
  TColStd_SequenceOfAsciiString lengths, angles, solid_angles;
  reader.ChangeReader().FileUnits( lengths, angles, solid_angles );
  for ( int i = 1; i <= lengths.Length(); ++i ) {
    storage.source.length_units.emplace_back( lengths.Value( i ).ToCString() );
  }
  validateUnits( reader.Reader().StepModel(), source.unit_override, work );
  storage.document = new TDocStd_Document( "BinXCAF" );
  XCAFDoc_DocumentTool::SetLengthUnit( storage.document, 1.0 );
  Handle( CadProgress ) progress = new CadProgress( work, "transfer_step" );
  const auto transferred         = reader.Transfer( storage.document, progress->Start() );
  work.check();
  if ( !transferred || !reader.Reader().WS()->MapReader()->CheckList( true ).IsEmpty( true ) ) {
    fail( "PARSE_FAILED", "STEP geometry transfer failed." );
  }
  work.report( "build_structure" );
  buildStructure( *document, work );
  return document;
}
}  // namespace dai::cad
