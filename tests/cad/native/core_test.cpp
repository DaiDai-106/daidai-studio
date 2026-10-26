#include "fixture.h"
#include "cad/display.h"
#include "cad/geometry.h"
#include "cad/files.h"
#include "cad/queries.h"
#include "cad/step_reader.h"
#include "private/document_internal.h"
#include <cmath>
#include <iostream>
#include <set>
#include <sstream>
#include <BRep_Builder.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Solid.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <Geom_BezierCurve.hxx>
#include <TColgp_Array1OfPnt.hxx>
#include <TopExp.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <BRepTools.hxx>
#include <Geom_Plane.hxx>
#include <gp_Pln.hxx>

namespace dai::cad::test
{
namespace
{
void require( bool condition, const char *message )
{
  if ( !condition ) {
    throw std::runtime_error( message );
  }
}
template <class F>
void expectFailure( const char *code, F function )
{
  try {
    function();
  } catch ( const CadFailure &error ) {
    require( error.error().code == code, "Unexpected CAD error code." );
    return;
  }
  throw std::runtime_error( "Expected a CAD failure." );
}
void verifyDecomposition( const WorkContext &work )
{
  const auto build = []( const TopoDS_Shape &shape ) {
    auto document = std::make_unique<CadDocument>( SourceVersion{} );
    CadGeometry geometry;
    geometry.id    = "geometry";
    geometry.shape = shape;
    TopExp::MapShapes( shape, TopAbs_FACE, geometry.faces );
    TopExp::MapShapes( shape, TopAbs_EDGE, geometry.edges );
    TopExp::MapShapes( shape, TopAbs_VERTEX, geometry.vertices );
    geometry.face_colors.resize( geometry.faces.Extent() );
    document->storage().geometries.emplace( geometry.id, std::move( geometry ) );
    CadObject object;
    object.id          = "parent";
    object.source_key  = "source";
    object.geometry_id = "geometry";
    document->storage().object_indices.emplace( object.id, 0 );
    document->storage().roots.push_back( object.id );
    document->storage().objects.push_back( object );
    return document;
  };
  BRep_Builder builder;
  TopoDS_Solid hollow;
  builder.MakeSolid( hollow );
  const auto outer = BRepPrimAPI_MakeBox( 10, 10, 10 ).Shape();
  const auto inner = BRepPrimAPI_MakeBox( gp_Pnt( 2, 2, 2 ), 4, 4, 4 ).Shape();
  builder.Add( hollow, TopExp_Explorer( outer, TopAbs_SHELL ).Current() );
  builder.Add( hollow, TopExp_Explorer( inner, TopAbs_SHELL ).Current().Reversed() );
  auto single = build( hollow );
  expectFailure( "UNSUPPORTED_SOURCE", [ & ] { (void)decomposeObject( *single, "parent", work ); } );
  require( single->objects().size() == 1, "A solid's internal shells must not be split." );

  TopoDS_Shell loose;
  builder.MakeShell( loose );
  const auto extra = BRepPrimAPI_MakeBox( gp_Pnt( 20, 0, 0 ), 1, 1, 1 ).Shape();
  builder.Add( loose, TopExp_Explorer( extra, TopAbs_FACE ).Current() );
  TopoDS_Compound compound;
  builder.MakeCompound( compound );
  builder.Add( compound, hollow );
  builder.Add( compound, loose );
  auto mixed        = build( compound );
  const auto result = decomposeObject( *mixed, "parent", work );
  require( result.changed && result.child_count == 2,
           "Only the solid and independent loose shell should become objects." );
  for ( const auto &object : mixed->objects() ) {
    (void)toJson( object ).dump();
  }
  require( mixed->objects().size() == 3, "Decomposition should retain its source parent." );
  std::size_t faces = 0;
  for ( const auto &id : mixed->object( "parent" ).children ) {
    const auto &geometry = mixed->storage().geometries.at( mixed->object( id ).geometry_id );
    faces += geometry.faces.Extent();
  }
  require( faces == 13, "All original solid and shell faces must survive decomposition." );
  require( !decomposeObject( *mixed, "parent", work ).changed, "Repeated assembly unpack must be idempotent." );

  builder.Add( compound, BRepBuilderAPI_MakeEdge( gp_Pnt( 100, 0, 0 ), gp_Pnt( 101, 0, 0 ) ).Shape() );
  auto incomplete = build( compound );
  expectFailure( "UNSUPPORTED_SOURCE", [ & ] { (void)decomposeObject( *incomplete, "parent", work ); } );
  require( incomplete->objects().size() == 1 && !incomplete->object( "parent" ).geometry_id.empty(),
           "Unsupported loose topology must leave the original object intact." );
}
void verifyPartialDisplay( const std::filesystem::path &directory, const WorkContext &work )
{
  BRepBuilderAPI_MakePolygon boundary;
  boundary.Add( gp_Pnt( 2, 0, 0 ) );
  boundary.Add( gp_Pnt( 3, 0, 0 ) );
  boundary.Add( gp_Pnt( 3, 1, 0 ) );
  boundary.Add( gp_Pnt( 2, 1, 0 ) );
  BRep_Builder builder;
  TopoDS_Face open_face;
  builder.MakeFace( open_face, new Geom_Plane( gp_Pln() ), 1e-7 );
  builder.Add( open_face, boundary.Wire() );
  CadDocument document(
      SourceVersion{ "partial.step", sha256( "partial" ), importFingerprint( {} ), {}, { "metre" } } );
  const auto add = [ & ]( const std::string &id, const TopoDS_Shape &shape ) {
    CadGeometry geometry;
    geometry.id    = id;
    geometry.shape = shape;
    TopExp::MapShapes( shape, TopAbs_FACE, geometry.faces );
    TopExp::MapShapes( shape, TopAbs_EDGE, geometry.edges );
    TopExp::MapShapes( shape, TopAbs_VERTEX, geometry.vertices );
    geometry.face_colors.resize( geometry.faces.Extent() );
    document.storage().geometries.emplace( id, std::move( geometry ) );
    CadObject object;
    object.id          = id;
    object.source_key  = id;
    object.name        = id;
    object.geometry_id = id;
    document.storage().object_indices.emplace( id, document.storage().objects.size() );
    document.storage().objects.push_back( object );
    document.storage().roots.push_back( id );
  };
  TopoDS_Compound mixed;
  builder.MakeCompound( mixed );
  builder.Add( mixed, BRepPrimAPI_MakeBox( 1, 1, 1 ).Shape() );
  builder.Add( mixed, open_face );
  add( "mixed", mixed );
  add( "unavailable", open_face );
  std::ostringstream before;
  BRepTools::Write( mixed, before );
  ServerContext server;
  server.output_root = directory / "partial-outputs";
  std::filesystem::create_directories( server.output_root );
  const auto result = writeDisplay( document, "preview", server, server.output_root / "partial", work );
  require( !result.summary.complete && result.summary.omitted_face_count == 2,
           "Partial display did not report excluded faces." );
  require( result.summary.triangle_count == 12, "Only the healthy box should have display triangles." );
  const auto manifest = readJson( server.output_root / "partial/manifest.json", 1024 * 1024 );
  const auto mapping  = readJson( server.output_root / "partial/faces.json", 1024 * 1024 );
  require( manifest[ "objects" ].size() == 2 && mapping[ "omittedFaces" ].size() == 2,
           "Unavailable objects or excluded face identities were discarded." );
  require( manifest[ "objects" ][ 0 ].contains( "geometryResourceUri" ) &&
               !manifest[ "objects" ][ 1 ].contains( "geometryResourceUri" ),
           "Unavailable geometry must not claim a GLB mesh." );
  require( manifest[ "objects" ][ 0 ][ "display" ][ "omittedFaceCount" ] == 1,
           "A failed face hid the healthy faces in the same object." );
  std::ostringstream after;
  BRepTools::Write( mixed, after );
  require( before.str() == after.str(), "Display filtering modified original CAD geometry." );
  document.storage().objects.erase( document.storage().objects.begin() );
  document.storage().object_indices = {
      { "unavailable", 0 }
  };
  document.storage().roots = { "unavailable" };
  expectFailure( "MESH_FAILED",
                 [ & ] { (void)writeDisplay( document, "preview", server, server.output_root / "empty", work ); } );
}
void run( const std::filesystem::path &directory )
{
  std::filesystem::create_directories( directory );
  const auto path = directory / "assembly.step";
  writeFixture( path );
  Limits limits;
  WorkContext work{ {}, std::chrono::steady_clock::now() + std::chrono::minutes( 1 ), limits, {} };
  verifyDecomposition( work );
  verifyPartialDisplay( directory, work );
  SourceVersion source{ utf8String( path ), fileHash( path, work ), importFingerprint( {} ), {}, {} };
  const auto document = readStep( source, path, work );
  require( document->objects().size() == 4, "Assembly instances were lost." );
  std::string first, second, cylinder;
  std::set<std::string> keys;
  for ( const auto &object : document->objects() ) {
    require( keys.insert( object.source_key ).second, "Instance source keys are not unique." );
    if ( object.name == "first box" ) {
      first = object.id;
    }
    if ( object.name == "second box" ) {
      second = object.id;
    }
    if ( object.name == "cylinder" ) {
      cylinder = object.id;
    }
  }
  require( !first.empty() && !second.empty() && !cylinder.empty(), "Source names were lost." );
  require( document->object( first ).geometry_id == document->object( second ).geometry_id,
           "Repeated instances duplicated geometry." );
  require( std::abs( document->object( second ).local_transform.translation[ 0 ] - 1.1 ) < 1e-8,
           "Instance translation was not converted to metres." );
  DistanceQuery distance_query{
      {first,  document->object( first ).local_transform },
      {second, document->object( second ).local_transform},
      1
  };
  const auto separated = measureDistance( *document, distance_query, work );
  require( std::abs( separated.distance_m - 0.3 ) < 1e-8 && separated.solutions.size() == 1,
           "Instance distance has incorrect placement or units." );
  require( std::abs( separated.solutions.front().first[ 0 ] - 0.8 ) < 1e-8 &&
               std::abs( separated.solutions.front().second[ 0 ] - 1.1 ) < 1e-8,
           "Closest points are not in the supplied common coordinates." );
  distance_query.second.placement.translation = { 1.3, 0, 0 };
  distance_query.second.placement.rotation    = { 0, 0, std::sqrt( 0.5 ), std::sqrt( 0.5 ) };
  require( std::abs( measureDistance( *document, distance_query, work ).distance_m - 0.1 ) < 1e-8,
           "Distance did not use the supplied rotation." );
  distance_query.second.placement.translation = { 0.1, 0, 0 };
  distance_query.second.placement.rotation    = { 0, 0, 0, 1 };
  require( measureDistance( *document, distance_query, work ).distance_m < 1e-7,
           "Intersecting solids did not report zero distance." );
  distance_query.second.placement.scale = { 2, 1, 1 };
  expectFailure( "INVALID_ARGUMENT", [ & ] { (void)measureDistance( *document, distance_query, work ); } );
  const auto properties = toJson( getProperties( *document,
                                                 {
                                                     { first, "missing" },
                                                     { "bounds", "topology", "appearance" }
  },
                                                 work ) );
  require( std::abs( properties[ "items" ][ 0 ][ "bounds" ][ "value" ][ "max" ][ 0 ].get<double>() - 0.8 ) < 1e-8,
           "CAD bounds have incorrect units." );
  require( properties[ "items" ][ 0 ][ "topology" ][ "value" ][ "solidCount" ] == 1, "Solid count is incorrect." );
  require( properties[ "items" ][ 0 ][ "appearance" ][ "value" ][ "hasFaceColors" ] == true,
           "Source face color was lost." );
  require( properties[ "items" ][ 1 ][ "bounds" ][ "reason" ] == "OBJECT_NOT_FOUND",
           "Missing object was reported as an exact value." );
  const auto typed_properties = getProperties( *document, { { first }, { "bounds" } }, work );
  require( typed_properties.items.front().bounds && !typed_properties.items.front().validity &&
               std::holds_alternative<ObjectBounds>( *typed_properties.items.front().bounds ),
           "Unrequested properties were confused with unavailable values." );
  expectFailure( "INVALID_ARGUMENT", [ & ] { (void)getProperties( *document, { { first }, { "unknown" } }, work ); } );
  expectFailure( "INVALID_ARGUMENT", [ & ] {
    (void)getProperties( *document,
                         {
                             { first, first },
                             { "bounds" }
    },
                         work );
  } );
  const auto valid = validateGeometry( *document, first, work );
  require( valid.valid && valid.issue_count == 0 && !valid.truncated, "Valid B-Rep failed validity analysis." );
  const auto property_validity = toJson( getProperties( *document,
                                                        {
                                                            { first, second },
                                                            { "validity" }
  },
                                                        work ) );
  require( property_validity[ "items" ][ 0 ][ "validity" ][ "value" ][ "valid" ] == true,
           "Validity property was not exposed." );
  require( property_validity[ "items" ][ 1 ][ "validity" ][ "value" ] ==
               property_validity[ "items" ][ 0 ][ "validity" ][ "value" ],
           "Repeated instances disagreed on geometry validity." );
  const auto measures = measureGeometry( *document, first, work );
  const auto *surface = std::get_if<GeometricMeasure>( &measures.surface );
  const auto *volume  = std::get_if<GeometricMeasure>( &measures.volume );
  require( surface && std::abs( surface->amount - 1.24 ) < 1e-9, "Surface area is not in square metres." );
  require( volume && std::abs( volume->amount - 0.08 ) < 1e-9, "Volume is not in cubic metres." );
  require( std::abs( volume->centroid[ 0 ] - 0.4 ) < 1e-9 && std::abs( volume->centroid[ 2 ] - 0.125 ) < 1e-9,
           "Volume centroid is not in object coordinates." );
  const auto measured_instances = toJson( getProperties( *document,
                                                         {
                                                             { first, second },
                                                             { "measures" }
  },
                                                         work ) );
  require( measured_instances[ "items" ][ 0 ][ "measures" ] == measured_instances[ "items" ][ 1 ][ "measures" ],
           "Instance placement changed object-local measures." );
  const auto invalid_document = readStep( source, path, work );
  std::string invalid_object;
  for ( const auto &object : invalid_document->objects() ) {
    if ( object.name == "first box" ) {
      invalid_object = object.id;
    }
  }
  auto &invalid_geometry =
      invalid_document->storage().geometries.at( invalid_document->object( invalid_object ).geometry_id );
  BRep_Builder builder;
  TopoDS_Compound compound;
  builder.MakeCompound( compound );
  for ( int i = 0; i < 100; ++i ) {
    TopoDS_Shell shell;
    builder.MakeShell( shell );
    builder.Add( compound, shell );
  }
  invalid_geometry.shape = compound;
  invalid_geometry.faces.Clear();
  invalid_geometry.edges.Clear();
  invalid_geometry.vertices.Clear();
  const auto invalid = validateGeometry( *invalid_document, invalid_object, work );
  require( !invalid.valid && invalid.issue_count >= 100 && invalid.truncated && invalid.issues.size() == 50,
           "Invalid shells were hidden or diagnostic limits were not enforced." );
  require( !invalid.issues.front().code.empty(), "Invalid geometry did not retain an OCCT status." );
  const auto empty = measureGeometry( *invalid_document, invalid_object, work );
  require( std::holds_alternative<MeasureUnavailable>( empty.surface ) &&
               std::holds_alternative<MeasureUnavailable>( empty.volume ),
           "Empty geometry produced a fictitious measure." );
  const auto &original_geometry = document->storage().geometries.at( document->object( first ).geometry_id );
  const auto face               = original_geometry.faces( 1 );
  invalid_geometry.shape        = face;
  TopExp::MapShapes( face, TopAbs_FACE, invalid_geometry.faces );
  const auto open = measureGeometry( *invalid_document, invalid_object, work );
  require( std::holds_alternative<GeometricMeasure>( open.surface ) &&
               std::get<MeasureUnavailable>( open.volume ).reason == "NO_SOLIDS",
           "An open face was treated as a finite solid volume." );
  builder.MakeCompound( compound );
  builder.Add( compound, original_geometry.shape );
  const auto &cylinder_geometry = document->storage().geometries.at( document->object( cylinder ).geometry_id );
  builder.Add( compound, cylinder_geometry.faces( 1 ) );
  invalid_geometry.shape = compound;
  invalid_geometry.faces.Clear();
  TopExp::MapShapes( compound, TopAbs_FACE, invalid_geometry.faces );
  const auto mixed = measureGeometry( *invalid_document, invalid_object, work );
  require( std::get<MeasureUnavailable>( mixed.volume ).reason == "LOOSE_FACES_OUTSIDE_SOLIDS",
           "Loose faces were silently omitted from a claimed whole-object volume." );
  TColgp_Array1OfPnt poles( 1, 3 );
  poles.SetValue( 1, gp_Pnt( 0, 0, 0 ) );
  poles.SetValue( 2, gp_Pnt( 0.05, 0, 0 ) );
  poles.SetValue( 3, gp_Pnt( 1, 0, 0 ) );
  Handle( Geom_BezierCurve ) curve = new Geom_BezierCurve( poles );
  invalid_geometry.shape           = BRepBuilderAPI_MakeEdge( curve ).Shape();
  invalid_geometry.faces.Clear();
  invalid_geometry.edges.Clear();
  invalid_geometry.vertices.Clear();
  TopExp::MapShapes( invalid_geometry.shape, TopAbs_EDGE, invalid_geometry.edges );
  TopExp::MapShapes( invalid_geometry.shape, TopAbs_VERTEX, invalid_geometry.vertices );
  const auto midpoint =
      listGeometryFeatures( *invalid_document, { invalid_object, {}, { "edge_midpoint" }, {} }, work );
  require( midpoint.items.size() == 1 && std::abs( midpoint.items.front().origin[ 0 ] - 0.5 ) < 1e-8,
           "Non-uniform edge midpoint used half the parameter instead of half the arc length." );
  auto page = getStructure( *document,
                            {
                                true, {},
                                 {},
                                 { {}, 1 }
  },
                            work );
  require( page.items.size() == 1 && page.next_cursor.has_value(), "Structure pagination failed." );
  expectFailure( "INVALID_ARGUMENT", [ & ] {
    (void)getStructure( *document,
                        {
                            true, {},
                             "changed filter", { *page.next_cursor, 1 }
    },
                        work );
  } );
  const auto planes = listGeometryFeatures( *document, { first, {}, { "plane_center" }, {} }, work );
  expectFailure( "INVALID_ARGUMENT",
                 [ & ] { (void)listGeometryFeatures( *document, { first, {}, { "unknown" }, {} }, work ); } );
  require( planes.items.size() == 6, "Box planes were not recovered." );
  const auto reference = planes.items.front().topology_ref;
  const auto selected  = listGeometryFeatures( *document, { first, reference, { "plane_center" }, {} }, work );
  require( selected.items.size() == 1, "Selected-face query escaped its topology scope." );
  const auto axes = listGeometryFeatures( *document,
                                          {
                                              cylinder, {},
                                               { "cylinder_axis", "circle_center" },
                                               {}
  },
                                          work );
  bool has_axis   = false;
  for ( const auto &feature : axes.items ) {
    if ( feature.type == "cylinder_axis" ) {
      has_axis = true;
      require( feature.radius && std::abs( *feature.radius - 0.05 ) < 1e-8,
               "Cylinder radius is not exact/metre-normalized." );
    }
  }
  require( has_axis, "Cylinder axis was not recovered." );
  const auto reopened = readStep( source, path, work );
  std::set<std::string> reopened_keys;
  for ( const auto &object : reopened->objects() ) {
    reopened_keys.insert( object.source_key );
  }
  require( keys == reopened_keys && reopened->objects().front().id != document->objects().front().id,
           "Persistent source keys and temporary IDs were mixed." );
  for ( const auto &[ unit, width ] : std::vector<std::pair<std::string, double>>{
            {"m",  800   },
            {"mm", 0.8   },
            {"cm", 8     },
            {"in", 20.32 },
            {"ft", 243.84}
  } ) {
    auto overridden_source               = source;
    overridden_source.unit_override      = unit;
    overridden_source.import_fingerprint = importFingerprint( unit );
    const auto overridden                = readStep( overridden_source, path, work );
    std::string id;
    for ( const auto &object : overridden->objects() ) {
      if ( object.name == "first box" ) {
        id = object.id;
      }
    }
    const auto value = toJson( getProperties( *overridden, { { id }, { "bounds" } }, work ) );
    require( std::abs( value[ "items" ][ 0 ][ "bounds" ][ "value" ][ "max" ][ 0 ].get<double>() - width ) < 1e-7,
             "Explicit source-unit override failed." );
  }
  const auto external = directory / "external.step";
  writeFixture( external, true );
  expectFailure( "UNSUPPORTED_SOURCE", [ & ] { (void)readStep( source, external, work ); } );
  std::stop_source stop;
  stop.request_stop();
  WorkContext cancelled{ stop.get_token(), work.deadline, limits, {} };
  expectFailure( "CANCELLED", [ & ] { (void)readStep( source, path, cancelled ); } );
}
}  // namespace
}  // namespace dai::cad::test

#ifdef _WIN32
int wmain( int argc, wchar_t **argv )
#else
int main( int argc, char **argv )
#endif
{
  try {
    if ( argc == 3 && std::filesystem::path( argv[ 1 ] ) == "--write-compound-fixture" ) {
      dai::cad::test::writeCompoundFixture( std::filesystem::path( argv[ 2 ] ) );
      return 0;
    }
    if ( argc == 3 && std::filesystem::path( argv[ 1 ] ) == "--write-fixture" ) {
      dai::cad::test::writeFixture( std::filesystem::path( argv[ 2 ] ) );
      return 0;
    }
    if ( argc != 2 ) {
      throw std::runtime_error( "Test output directory required." );
    }
    dai::cad::test::run( std::filesystem::path( argv[ 1 ] ) );
    std::cout << "CAD core tests passed.\n";
    return 0;
  } catch ( const std::exception &error ) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
