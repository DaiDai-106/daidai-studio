#include "cad/geometry.h"
#include "private/document_internal.h"
#include "private/progress.h"
#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>
#include <BRepCheck.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopLoc_Location.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Quaternion.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

namespace dai::cad
{
namespace
{
std::string shapeType( TopAbs_ShapeEnum type )
{
  switch ( type ) {
    case TopAbs_COMPOUND: return "compound";
    case TopAbs_COMPSOLID: return "compsolid";
    case TopAbs_SOLID: return "solid";
    case TopAbs_SHELL: return "shell";
    case TopAbs_FACE: return "face";
    case TopAbs_WIRE: return "wire";
    case TopAbs_EDGE: return "edge";
    case TopAbs_VERTEX: return "vertex";
    default: return "shape";
  }
}
}  // namespace

GeometryValidity validateGeometry( const CadDocument &document, const std::string &object_id, const WorkContext &work )
{
  work.check();
  const auto &object     = document.object( object_id );
  const auto geometry_it = document.storage().geometries.find( object.geometry_id );
  if ( geometry_it == document.storage().geometries.end() ) {
    fail( "UNSUPPORTED_SOURCE", "The object has no own CAD geometry." );
  }
  const auto &geometry = geometry_it->second;
  // Exact curve-on-surface checking is supported by OCCT only for SameParameter edges.
  BRepCheck_Analyzer analyzer( geometry.shape, true, false, true );
  GeometryValidity result;
  result.valid = analyzer.IsValid();
  work.check();
  TopTools_IndexedMapOfShape shapes;
  TopExp::MapShapes( geometry.shape, shapes );
  for ( int i = 1; i <= shapes.Extent(); ++i ) {
    work.check();
    const auto &shape   = shapes( i );
    const auto &checked = analyzer.Result( shape );
    if ( checked.IsNull() ) {
      continue;
    }
    std::set<BRepCheck_Status> statuses;
    const auto collect = [ & ]( const BRepCheck_ListOfStatus &values ) {
      for ( const auto status : values ) {
        if ( status != BRepCheck_NoError ) {
          statuses.insert( status );
        }
      }
    };
    collect( checked->Status() );
    for ( checked->InitContextIterator(); checked->MoreShapeInContext(); checked->NextShapeInContext() ) {
      work.check();
      collect( checked->StatusOnShape() );
    }
    for ( const auto status : statuses ) {
      ++result.issue_count;
      if ( result.issues.size() >= 50 ) {
        result.truncated = true;
        continue;
      }
      GeometryIssue issue;
      issue.shape_type = shapeType( shape.ShapeType() );
      std::ostringstream code;
      BRepCheck::Print( status, code );
      issue.code          = code.str();
      const auto *indices = shape.ShapeType() == TopAbs_FACE     ? &geometry.faces
                            : shape.ShapeType() == TopAbs_EDGE   ? &geometry.edges
                            : shape.ShapeType() == TopAbs_VERTEX ? &geometry.vertices
                                                                 : nullptr;
      if ( indices ) {
        const auto index = indices->FindIndex( shape );
        if ( index > 0 ) {
          issue.topology_ref = TopologyRef{ issue.shape_type, topologyId( geometry, issue.shape_type, index ) };
        }
      }
      result.issues.push_back( std::move( issue ) );
    }
  }
  return result;
}

Json toJson( const GeometryValidity &value )
{
  Json issues = Json::array();
  for ( const auto &issue : value.issues ) {
    Json item{
        {"shapeType", issue.shape_type},
        {"code",      issue.code      }
    };
    if ( issue.topology_ref ) {
      item[ "topologyRef" ] = {
          {"kind", issue.topology_ref->kind},
          {"id",   issue.topology_ref->id  }
      };
    }
    issues.push_back( std::move( item ) );
  }
  return {
      {"valid",                value.valid                },
      {"method",               "occt_brep_check"          },
      {"curveOnSurfaceMethod", "exact_when_same_parameter"},
      {"issueCount",           value.issue_count          },
      {"truncated",            value.truncated            },
      {"issues",               std::move( issues )        }
  };
}

namespace
{
constexpr double relative_error = 1e-6;

MeasureResult measured( const GProp_GProps &properties, double error )
{
  const auto center = properties.CentreOfMass();
  if ( !std::isfinite( properties.Mass() ) || properties.Mass() <= 0 || !std::isfinite( error ) || error < 0 ||
       !std::isfinite( center.X() ) || !std::isfinite( center.Y() ) || !std::isfinite( center.Z() ) ) {
    return MeasureUnavailable{ "NO_FINITE_POSITIVE_MEASURE" };
  }
  return GeometricMeasure{
      properties.Mass(), { center.X(), center.Y(), center.Z() },
       error
  };
}

Json measureJson( const MeasureResult &result, const char *unit )
{
  if ( const auto *value = std::get_if<GeometricMeasure>( &result ) ) {
    return {
        {"status", "computed"                                            },
        {"value",
         { { "amount", value->amount },
            { "unit", unit },
            { "centroid", value->centroid },
            { "relativeErrorEstimate", value->relative_error_estimate } }}
    };
  }
  return {
      {"status", "unavailable"                                },
      {"reason", std::get<MeasureUnavailable>( result ).reason}
  };
}
}  // namespace

GeometryMeasures measureGeometry( const CadDocument &document, const std::string &object_id, const WorkContext &work )
{
  work.check();
  const auto &object     = document.object( object_id );
  const auto geometry_it = document.storage().geometries.find( object.geometry_id );
  if ( geometry_it == document.storage().geometries.end() ) {
    fail( "UNSUPPORTED_SOURCE", "The object has no own CAD geometry." );
  }
  const auto &geometry = geometry_it->second;
  GeometryMeasures result{ MeasureUnavailable{ "NO_SURFACE" }, MeasureUnavailable{ "NO_SOLIDS" } };
  if ( geometry.faces.IsEmpty() ) {
    return result;
  }
  if ( !validateGeometry( document, object_id, work ).valid ) {
    return { MeasureUnavailable{ "INVALID_GEOMETRY" }, MeasureUnavailable{ "INVALID_GEOMETRY" } };
  }
  work.report( "measure_geometry" );
  GProp_GProps surface;
  const auto surface_error = BRepGProp::SurfaceProperties( geometry.shape, surface, relative_error, true );
  work.check();
  result.surface = measured( surface, surface_error );

  TopTools_IndexedMapOfShape solids, solid_faces;
  TopExp::MapShapes( geometry.shape, TopAbs_SOLID, solids );
  if ( solids.IsEmpty() ) {
    return result;
  }
  for ( int i = 1; i <= solids.Extent(); ++i ) {
    TopExp::MapShapes( solids( i ), TopAbs_FACE, solid_faces );
  }
  if ( solid_faces.Extent() != geometry.faces.Extent() ) {
    result.volume = MeasureUnavailable{ "LOOSE_FACES_OUTSIDE_SOLIDS" };
    return result;
  }
  GProp_GProps volume;
  double weighted_error = 0;
  for ( int i = 1; i <= solids.Extent(); ++i ) {
    work.check();
    GProp_GProps part;
    const auto error = BRepGProp::VolumeProperties( solids( i ), part, relative_error, true, true );
    const auto value = measured( part, error );
    if ( const auto *unavailable = std::get_if<MeasureUnavailable>( &value ) ) {
      result.volume = *unavailable;
      return result;
    }
    volume.Add( part );
    weighted_error += error * part.Mass();
  }
  work.check();
  result.volume = measured( volume, weighted_error / volume.Mass() );
  return result;
}

Json toJson( const GeometryMeasures &value )
{
  return {
      {"status", "computed"                                },
      {"value",
       { { "method", "occt_brep_gprop" },
          { "space", "object" },
          { "semantics", "topological_sum" },
          { "requestedRelativeError", relative_error },
          { "surface", measureJson( value.surface, "m2" ) },
          { "volume", measureJson( value.volume, "m3" ) } }}
  };
}

namespace
{
TopoDS_Shape placedShape( const CadDocument &document, const DistanceObject &object )
{
  const auto &geometry_id = document.object( object.object_id ).geometry_id;
  const auto found        = document.storage().geometries.find( geometry_id );
  if ( found == document.storage().geometries.end() ) {
    fail( "UNSUPPORTED_SOURCE", "Distance requires objects with their own CAD geometry." );
  }
  const auto &t     = object.placement;
  const auto finite = []( double value ) { return std::isfinite( value ); };
  const auto &q     = t.rotation;
  const auto length = std::hypot( std::hypot( q[ 0 ], q[ 1 ] ), std::hypot( q[ 2 ], q[ 3 ] ) );
  if ( !std::all_of( t.translation.begin(), t.translation.end(), finite ) ||
       !std::all_of( q.begin(), q.end(), finite ) || !std::isfinite( length ) || std::abs( length - 1 ) > 1e-6 ||
       std::any_of( t.scale.begin(), t.scale.end(), []( double value ) { return value != 1; } ) ) {
    fail( "INVALID_ARGUMENT", "Distance placements must be finite, normalized rigid transforms." );
  }
  gp_Trsf transform;
  transform.SetRotation( gp_Quaternion( q[ 0 ], q[ 1 ], q[ 2 ], q[ 3 ] ) );
  transform.SetTranslationPart( gp_Vec( t.translation[ 0 ], t.translation[ 1 ], t.translation[ 2 ] ) );
  return found->second.shape.Moved( TopLoc_Location( transform ) );
}
Vec3 point( const gp_Pnt &value )
{
  if ( !std::isfinite( value.X() ) || !std::isfinite( value.Y() ) || !std::isfinite( value.Z() ) ) {
    fail( "PARSE_FAILED", "Distance calculation returned a non-finite point." );
  }
  return { value.X(), value.Y(), value.Z() };
}
}  // namespace

GeometryDistance measureDistance( const CadDocument &document, const DistanceQuery &query, const WorkContext &work )
{
  work.check();
  if ( query.first.object_id == query.second.object_id || query.max_solutions < 1 || query.max_solutions > 20 ) {
    fail( "INVALID_ARGUMENT", "Distance requires different objects and 1 to 20 reported solutions." );
  }
  const auto first  = placedShape( document, query.first );
  const auto second = placedShape( document, query.second );
  if ( !validateGeometry( document, query.first.object_id, work ).valid ||
       ( document.object( query.first.object_id ).geometry_id !=
             document.object( query.second.object_id ).geometry_id &&
         !validateGeometry( document, query.second.object_id, work ).valid ) ) {
    fail( "UNSUPPORTED_SOURCE", "Distance requires valid B-Rep geometry." );
  }
  Handle( CadProgress ) progress = new CadProgress( work, "measure_distance" );
  BRepExtrema_DistShapeShape tool;
  tool.SetMultiThread( false );
  tool.SetDeflection( Precision::Confusion() );
  tool.LoadS1( first );
  tool.LoadS2( second );
  const auto done = tool.Perform( progress->Start() );
  work.check();
  if ( !done || !tool.IsDone() || tool.NbSolution() < 1 || !std::isfinite( tool.Value() ) || tool.Value() < 0 ) {
    fail( "PARSE_FAILED", "OCCT did not return a finite minimum distance." );
  }
  GeometryDistance result;
  result.first_object_id  = query.first.object_id;
  result.second_object_id = query.second.object_id;
  result.distance_m       = tool.Value();
  result.deflection_m     = Precision::Confusion();
  result.inner_solution   = tool.InnerSolution();
  result.solution_count   = static_cast<std::size_t>( tool.NbSolution() );
  result.truncated        = result.solution_count > query.max_solutions;
  const auto count        = std::min( result.solution_count, query.max_solutions );
  for ( std::size_t i = 1; i <= count; ++i ) {
    work.check();
    result.solutions.push_back( { point( tool.PointOnShape1( static_cast<int>( i ) ) ),
                                  point( tool.PointOnShape2( static_cast<int>( i ) ) ) } );
  }
  return result;
}

Json toJson( const GeometryDistance &value )
{
  Json solutions = Json::array();
  for ( const auto &item : value.solutions ) {
    solutions.push_back( {
        {"first",  item.first },
        {"second", item.second}
    } );
  }
  return {
      {"firstObjectId",  value.first_object_id },
      {"secondObjectId", value.second_object_id},
      {"method",         "occt_brep_extrema"   },
      {"space",          "query"               },
      {"unit",           "m"                   },
      {"distance",       value.distance_m      },
      {"deflection",     value.deflection_m    },
      {"innerSolution",  value.inner_solution  },
      {"solutionCount",  value.solution_count  },
      {"truncated",      value.truncated       },
      {"solutions",      std::move( solutions )}
  };
}

namespace
{
void appendComponents( const TopoDS_Shape &shape, TopAbs_ShapeEnum kind, std::vector<TopoDS_Shape> &parts,
                       const TopTools_IndexedMapOfShape *excluded, const WorkContext &work )
{
  TopTools_IndexedMapOfShape found;
  TopExp::MapShapes( shape, kind, found );
  for ( int index = 1; index <= found.Extent(); ++index ) {
    work.check();
    if ( !excluded || !excluded->Contains( found( index ) ) ) {
      parts.push_back( found( index ) );
    }
  }
}
void checkCoverage( const TopoDS_Shape &original, const std::vector<TopoDS_Shape> &parts, const WorkContext &work )
{
  for ( const auto kind : { TopAbs_FACE, TopAbs_EDGE, TopAbs_VERTEX } ) {
    TopTools_IndexedMapOfShape source;
    TopTools_IndexedMapOfShape covered;
    TopExp::MapShapes( original, kind, source );
    for ( const auto &part : parts ) {
      work.check();
      TopExp::MapShapes( part, kind, covered );
    }
    if ( source.Extent() != covered.Extent() ) {
      fail( "UNSUPPORTED_SOURCE",
            "Object contains loose topology outside independent solids and shells; no split was applied." );
    }
    for ( int index = 1; index <= source.Extent(); ++index ) {
      work.check();
      if ( !covered.Contains( source( index ) ) ) {
        fail( "UNSUPPORTED_SOURCE", "Decomposition would omit source topology; no split was applied." );
      }
    }
  }
}
DecompositionResult response( const CadDocument &document, const CadObject &parent, bool changed )
{
  const auto count = std::min<std::size_t>( parent.children.size(), 50 );
  const std::vector<std::string> children( parent.children.begin(), parent.children.begin() + count );
  return { changed, parent.id, children, parent.children.size(), document.objects().size() };
}
}  // namespace

Json toJson( const DecompositionResult &result )
{
  return {
      {"changed",        result.changed         },
      {"parentObjectId", result.parent_object_id},
      {"childObjectIds", result.child_object_ids},
      {"childCount",     result.child_count     },
      {"objectCount",    result.object_count    }
  };
}

DecompositionResult decomposeObject( CadDocument &document, const std::string &object_id, const WorkContext &work )
{
  const auto parent = document.object( object_id );
  if ( !parent.children.empty() ) {
    return response( document, parent, false );
  }
  if ( parent.geometry_id.empty() ) {
    fail( "UNSUPPORTED_SOURCE", "Object has no decomposable geometry." );
  }
  auto &storage        = document.storage();
  const auto &original = storage.geometries.at( parent.geometry_id );
  std::vector<TopoDS_Shape> parts;
  appendComponents( original.shape, TopAbs_SOLID, parts, nullptr, work );
  TopTools_IndexedMapOfShape solid_shells;
  for ( const auto &solid : parts ) {
    work.check();
    TopExp::MapShapes( solid, TopAbs_SHELL, solid_shells );
  }
  appendComponents( original.shape, TopAbs_SHELL, parts, &solid_shells, work );
  if ( parts.size() < 2 ) {
    fail( "UNSUPPORTED_SOURCE",
          "Object has fewer than two independent solids or loose shells. Cutting or further modeling is required." );
  }
  if ( parts.size() > work.limits.max_objects - storage.objects.size() ) {
    fail( "LIMIT_EXCEEDED", "Decomposition exceeds the object limit." );
  }
  checkCoverage( original.shape, parts, work );

  std::vector<CadObject> children;
  std::vector<CadGeometry> geometries;
  children.reserve( parts.size() );
  geometries.reserve( parts.size() );
  for ( std::size_t index = 0; index < parts.size(); ++index ) {
    work.check();
    const auto suffix = "/decomposition-v1/" + std::to_string( index + 1 );
    CadObject child;
    child.id         = newId();
    child.source_key = parent.source_key + suffix;
    if ( child.source_key.size() > 4096 ) {
      fail( "LIMIT_EXCEEDED", "Derived source identity exceeds the limit." );
    }
    // Preserve UTF-8 boundaries; keep oversized original labels on the parent.
    const auto label  = parent.name.empty() || parent.name.size() > 900 ? "Component" : parent.name;
    child.name        = label + " / " + std::to_string( index + 1 );
    child.parent_id   = parent.id;
    child.geometry_id = parent.geometry_id + suffix;
    child.color       = parent.color;
    // Retain every subshape location inside its parent's object coordinates.
    // The parent keeps the assembly placement; children have identity placement.
    CadGeometry geometry;
    geometry.id    = child.geometry_id;
    geometry.shape = parts[ index ];
    TopExp::MapShapes( geometry.shape, TopAbs_FACE, geometry.faces );
    TopExp::MapShapes( geometry.shape, TopAbs_EDGE, geometry.edges );
    TopExp::MapShapes( geometry.shape, TopAbs_VERTEX, geometry.vertices );
    for ( int face = 1; face <= geometry.faces.Extent(); ++face ) {
      const auto original_index = original.faces.FindIndex( geometry.faces( face ) );
      if ( original_index < 1 ) {
        fail( "PARSE_FAILED", "Derived face has no source mapping." );
      }
      geometry.face_colors.push_back( original.face_colors.at( original_index - 1 ) );
    }
    children.push_back( std::move( child ) );
    geometries.push_back( std::move( geometry ) );
  }
  work.check();
  storage.objects.reserve( storage.objects.size() + children.size() );
  for ( auto &geometry : geometries ) {
    storage.geometries.try_emplace( geometry.id, std::move( geometry ) );
  }
  std::vector<std::string> child_ids;
  for ( auto &child : children ) {
    child_ids.push_back( child.id );
    if ( const auto color = storage.instance_color_overrides.find( parent.id );
         color != storage.instance_color_overrides.end() ) {
      storage.instance_color_overrides.emplace( child.id, color->second );
    }
    storage.object_indices.emplace( child.id, storage.objects.size() );
    storage.objects.push_back( std::move( child ) );
  }
  auto &updated = storage.objects.at( storage.object_indices.at( parent.id ) );
  updated.geometry_id.clear();
  updated.children = std::move( child_ids );
  return response( document, updated, true );
}
}  // namespace dai::cad
