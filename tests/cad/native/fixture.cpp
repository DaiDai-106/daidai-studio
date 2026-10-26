#include "fixture.h"
#include "cad/files.h"
#include <stdexcept>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <DESTEP_Parameters.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <TDataStd_Name.hxx>
#include <TDocStd_Document.hxx>
#include <TopExp_Explorer.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <Quantity_ColorRGBA.hxx>
#include "cad/types.h"

namespace dai::cad::test
{
void writeCompoundFixture( const std::filesystem::path &path )
{
  std::filesystem::create_directories( path.parent_path() );
  Handle( TDocStd_Document ) document = new TDocStd_Document( "BinXCAF" );
  XCAFDoc_DocumentTool::SetLengthUnit( document, 0.001 );
  const auto shapes = XCAFDoc_DocumentTool::ShapeTool( document->Main() );
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound( compound );
  builder.Add( compound, BRepPrimAPI_MakeBox( 100, 200, 300 ).Shape() );
  gp_Trsf location;
  location.SetTranslation( gp_Vec( 400, 50, 25 ) );
  builder.Add( compound, BRepPrimAPI_MakeCylinder( 20, 100 ).Shape().Moved( TopLoc_Location( location ) ) );
  const auto label = shapes->AddShape( compound, false );
  TDataStd_Name::Set( label, "compound mechanism" );
  const auto colors = XCAFDoc_DocumentTool::ColorTool( document->Main() );
  colors->SetColor( label, Quantity_ColorRGBA( 0.2F, 0.3F, 0.7F, 1.F ), XCAFDoc_ColorSurf );
  TopExp_Explorer faces( compound, TopAbs_FACE );
  colors->SetColor( shapes->AddSubShape( label, faces.Current() ), Quantity_ColorRGBA( 0.8F, 0.1F, 0.2F, 1.F ),
                    XCAFDoc_ColorSurf );
  STEPCAFControl_Writer writer;
  DESTEP_Parameters parameters;
  parameters.WriteAssembly = DESTEP_Parameters::WriteMode_Assembly_Off;
  if ( !writer.Transfer( document, parameters, STEPControl_AsIs ) ||
       writer.Write( utf8String( path ).c_str() ) != IFSelect_RetDone ) {
    throw std::runtime_error( "Cannot write compound fixture." );
  }
}
void writeFixture( const std::filesystem::path &path, bool external_references )
{
  std::filesystem::create_directories( path.parent_path() );
  Handle( TDocStd_Document ) document = new TDocStd_Document( "BinXCAF" );
  XCAFDoc_DocumentTool::SetLengthUnit( document, 0.001 );
  const auto shapes    = XCAFDoc_DocumentTool::ShapeTool( document->Main() );
  const auto colors    = XCAFDoc_DocumentTool::ColorTool( document->Main() );
  const auto box_shape = BRepPrimAPI_MakeBox( 800, 400, 250 ).Shape();
  const auto box       = shapes->AddShape( box_shape, false );
  TDataStd_Name::Set( box, "shared box" );
  colors->SetColor( box, Quantity_ColorRGBA( 0.8F, 0.1F, 0.1F, 1.F ), XCAFDoc_ColorSurf );
  TopExp_Explorer faces( box_shape, TopAbs_FACE );
  colors->SetColor( shapes->AddSubShape( box, faces.Current() ), Quantity_ColorRGBA( 0.1F, 0.8F, 0.1F, 1.F ),
                    XCAFDoc_ColorSurf );
  const auto root = shapes->NewShape();
  TDataStd_Name::Set( root, "assembly" );
  gp_Trsf identity;
  const auto first = shapes->AddComponent( root, box, TopLoc_Location( identity ) );
  TDataStd_Name::Set( first, "first box" );
  gp_Trsf translated;
  translated.SetTranslation( gp_Vec( 1100, 0, 0 ) );
  const auto second = shapes->AddComponent( root, box, TopLoc_Location( translated ) );
  TDataStd_Name::Set( second, "second box" );
  colors->SetColor( second, Quantity_ColorRGBA( 0.1F, 0.1F, 0.8F, 1.F ), XCAFDoc_ColorSurf );
  const auto cylinder = shapes->AddShape( BRepPrimAPI_MakeCylinder( 50, 100 ).Shape(), false );
  gp_Trsf raised;
  raised.SetTranslation( gp_Vec( 0, 0, 400 ) );
  const auto third = shapes->AddComponent( root, cylinder, TopLoc_Location( raised ) );
  TDataStd_Name::Set( third, "cylinder" );
  shapes->UpdateAssemblies();
  STEPCAFControl_Writer writer;
  if ( !writer.Transfer( document, DESTEP_Parameters{}, STEPControl_AsIs, external_references ? "part_" : nullptr ) ||
       writer.Write( utf8String( path ).c_str() ) != IFSelect_RetDone ) {
    throw std::runtime_error( "Cannot write STEP fixture." );
  }
}
}  // namespace dai::cad::test
