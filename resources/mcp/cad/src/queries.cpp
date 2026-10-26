#include "cad/queries.h"
#include "cad/geometry.h"
#include "private/document_internal.h"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <utility>
#include <BRep_Tool.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <GCPnts_AbscissaPoint.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>

namespace dai::cad
{
std::string topologyId( const CadGeometry &geometry, const std::string &kind, int index )
{
  return geometry.id + "/" + kind + "/" + std::to_string( index );
}
namespace
{
std::size_t parseOffset( const std::string &text )
{
  std::size_t value = 0;
  const auto result = std::from_chars( text.data(), text.data() + text.size(), value );
  if ( result.ec != std::errc{} || result.ptr != text.data() + text.size() || std::to_string( value ) != text ) {
    fail( "INVALID_ARGUMENT", "Invalid CAD page cursor." );
  }
  return value;
}
std::string queryKey( const CadDocument &document, const Json &query )
{
  if ( document.objects().empty() ) {
    fail( "NOT_FOUND", "CAD document has no objects." );
  }
  return sha256( document.objects().front().id + query.dump() );
}
std::size_t pageOffset( const PageQuery &page, const std::string &key )
{
  if ( page.limit == 0 || page.limit > 200 ) {
    fail( "INVALID_ARGUMENT", "Invalid CAD page size." );
  }
  if ( page.cursor.empty() ) {
    return 0;
  }
  const auto prefix = key + ":";
  if ( !page.cursor.starts_with( prefix ) ) {
    fail( "INVALID_ARGUMENT", "Cursor belongs to another CAD query." );
  }
  return parseOffset( page.cursor.substr( prefix.size() ) );
}
template <typename T>
bool appendItem( std::vector<T> &items, T value, std::size_t &bytes, const WorkContext &work )
{
  const auto size = toJson( value ).dump().size() + 1;
  if ( bytes + size > work.limits.max_page_bytes ) {
    if ( items.empty() ) {
      fail( "LIMIT_EXCEEDED", "CAD query item exceeds the page budget." );
    }
    return false;
  }
  items.push_back( std::move( value ) );
  bytes += size;
  return true;
}
Vec3 point( const gp_Pnt &value )
{
  if ( !std::isfinite( value.X() ) || !std::isfinite( value.Y() ) || !std::isfinite( value.Z() ) ) {
    fail( "PARSE_FAILED", "CAD feature contains non-finite coordinates." );
  }
  return { value.X(), value.Y(), value.Z() };
}
Vec3 direction( const gp_Dir &value )
{
  return { value.X(), value.Y(), value.Z() };
}
int shapeCount( const TopoDS_Shape &shape, TopAbs_ShapeEnum type )
{
  TopTools_IndexedMapOfShape map;
  TopExp::MapShapes( shape, type, map );
  return map.Extent();
}
}  // namespace

StructurePage getStructure( const CadDocument &document, const StructureQuery &query, const WorkContext &work )
{
  if ( query.all && !query.parent_id.empty() ) {
    fail( "INVALID_ARGUMENT", "all mode does not accept parentObjectId." );
  }
  if ( !query.parent_id.empty() ) {
    (void)document.object( query.parent_id );
  }
  const auto key    = queryKey( document, {
                                           {"kind",   "structure"        },
                                           {"all",    query.all          },
                                           {"parent", query.parent_id    },
                                           {"name",   query.name_contains}
  } );
  const auto offset = pageOffset( query.page, key );
  if ( offset > document.objects().size() ) {
    fail( "INVALID_ARGUMENT", "Cursor is outside the object table." );
  }
  StructurePage result;
  std::size_t bytes = 0;
  for ( auto i = offset; i < document.objects().size(); ++i ) {
    work.check();
    const auto &object = document.objects()[ i ];
    if ( ( !query.all && object.parent_id != query.parent_id ) ||
         object.name.find( query.name_contains ) == std::string::npos ) {
      continue;
    }
    if ( result.items.size() >= query.page.limit || !appendItem( result.items, object, bytes, work ) ) {
      result.next_cursor = key + ":" + std::to_string( i );
      break;
    }
  }
  return result;
}

PropertiesPage getProperties( const CadDocument &document, const PropertiesQuery &query, const WorkContext &work )
{
  const std::set<std::string> supported{ "bounds", "topology", "appearance", "validity", "measures" };
  if ( query.object_ids.empty() || query.object_ids.size() > 50 ||
       std::set<std::string>( query.object_ids.begin(), query.object_ids.end() ).size() != query.object_ids.size() ||
       query.fields.empty() || !std::all_of( query.fields.begin(), query.fields.end(), [ & ]( const auto &field ) {
         return supported.contains( field );
       } ) ) {
    fail( "INVALID_ARGUMENT", "Request 1 to 50 objects and supported CAD property fields." );
  }
  std::map<std::string, GeometryValidity> validity;
  std::map<std::string, GeometryMeasures> measures;
  PropertiesPage result;
  std::size_t bytes = 0;
  for ( const auto &id : query.object_ids ) {
    work.check();
    ObjectProperties item;
    item.object_id         = id;
    const auto object_it   = document.storage().object_indices.find( id );
    const auto geometry_it = object_it == document.storage().object_indices.end()
                                 ? document.storage().geometries.end()
                                 : document.storage().geometries.find( document.object( id ).geometry_id );
    if ( geometry_it == document.storage().geometries.end() ) {
      const PropertyUnavailable missing{ object_it == document.storage().object_indices.end() ? "OBJECT_NOT_FOUND"
                                                                                              : "NO_OWN_GEOMETRY" };
      if ( query.fields.contains( "bounds" ) ) {
        item.bounds = missing;
      }
      if ( query.fields.contains( "topology" ) ) {
        item.topology = missing;
      }
      if ( query.fields.contains( "appearance" ) ) {
        item.appearance = missing;
      }
      if ( query.fields.contains( "validity" ) ) {
        item.validity = missing;
      }
      if ( query.fields.contains( "measures" ) ) {
        item.measures = missing;
      }
    } else {
      const auto &object   = document.object( id );
      const auto &geometry = geometry_it->second;
      if ( query.fields.contains( "bounds" ) ) {
        Bnd_Box bounds;
        BRepBndLib::AddOptimal( geometry.shape, bounds, false, false );
        if ( bounds.IsVoid() || bounds.IsOpen() ) {
          item.bounds = PropertyUnavailable{ "UNBOUNDED_GEOMETRY" };
        } else {
          double x1, y1, z1, x2, y2, z2;
          bounds.Get( x1, y1, z1, x2, y2, z2 );
          item.bounds = ObjectBounds{
              {x1, y1, z1},
              {x2, y2, z2}
          };
        }
      }
      if ( query.fields.contains( "topology" ) ) {
        item.topology =
            TopologyCounts{ geometry.vertices.Extent(), geometry.edges.Extent(), geometry.faces.Extent(),
                            shapeCount( geometry.shape, TopAbs_SHELL ), shapeCount( geometry.shape, TopAbs_SOLID ) };
      }
      if ( query.fields.contains( "appearance" ) ) {
        const auto count =
            static_cast<std::size_t>( std::count_if( geometry.face_colors.begin(), geometry.face_colors.end(),
                                                     []( const auto &color ) { return color.has_value(); } ) );
        if ( object.color || count ) {
          item.appearance = SourceAppearance{ object.color, count };
        } else {
          item.appearance = PropertyUnavailable{ "NO_SOURCE_COLOR" };
        }
      }
      if ( query.fields.contains( "validity" ) ) {
        auto found = validity.find( geometry.id );
        if ( found == validity.end() ) {
          work.report( "check_geometry" );
          found = validity.emplace( geometry.id, validateGeometry( document, object.id, work ) ).first;
        }
        item.validity = found->second;
      }
      if ( query.fields.contains( "measures" ) ) {
        auto found = measures.find( geometry.id );
        if ( found == measures.end() ) {
          found = measures.emplace( geometry.id, measureGeometry( document, object.id, work ) ).first;
        }
        item.measures = found->second;
      }
    }
    if ( !appendItem( result.items, std::move( item ), bytes, work ) ) {
      fail( "LIMIT_EXCEEDED", "Request fewer objects or property fields." );
    }
  }
  return result;
}

namespace
{
int topologyIndex( const CadGeometry &geometry, const TopologyRef &reference, int count )
{
  const auto prefix = geometry.id + "/" + reference.kind + "/";
  if ( !reference.id.starts_with( prefix ) ) {
    fail( "NOT_FOUND", "Topology does not belong to this object." );
  }
  const auto index = parseOffset( reference.id.substr( prefix.size() ) );
  if ( index == 0 || index > static_cast<std::size_t>( count ) ) {
    fail( "NOT_FOUND", "CAD topology was not found." );
  }
  return static_cast<int>( index );
}
struct Candidate {
  std::string kind;
  int index;
  std::string type;
};
std::optional<GeometryFeature> evaluateFeature( const CadObject &object, const CadGeometry &geometry,
                                                const Candidate &candidate, const WorkContext &work )
{
  GeometryFeature result;
  result.id           = topologyId( geometry, candidate.kind, candidate.index ) + "/" + candidate.type;
  result.object_id    = object.id;
  result.type         = candidate.type;
  result.topology_ref = { candidate.kind, topologyId( geometry, candidate.kind, candidate.index ) };
  if ( candidate.kind == "face" ) {
    const auto face = TopoDS::Face( geometry.faces( candidate.index ) );
    BRepAdaptor_Surface surface( face );
    if ( candidate.type == "plane_center" && surface.GetType() == GeomAbs_Plane ) {
      GProp_GProps properties;
      BRepGProp::SurfaceProperties( face, properties );
      if ( properties.Mass() <= 0 ) {
        return {};
      }
      result.origin = point( properties.CentreOfMass() );
      auto normal   = surface.Plane().Axis().Direction();
      if ( face.Orientation() == TopAbs_REVERSED ) {
        normal.Reverse();
      }
      result.direction = direction( normal );
    } else if ( candidate.type == "cylinder_axis" && surface.GetType() == GeomAbs_Cylinder ) {
      const auto cylinder = surface.Cylinder();
      result.origin       = point( cylinder.Axis().Location() );
      result.direction    = direction( cylinder.Axis().Direction() );
      result.radius       = cylinder.Radius();
    } else {
      return {};
    }
  } else if ( candidate.kind == "edge" ) {
    const auto edge = TopoDS::Edge( geometry.edges( candidate.index ) );
    if ( BRep_Tool::Degenerated( edge ) ) {
      return {};
    }
    BRepAdaptor_Curve curve( edge );
    if ( candidate.type == "circle_center" && curve.GetType() == GeomAbs_Circle ) {
      const auto circle = curve.Circle();
      result.origin     = point( circle.Location() );
      result.direction  = direction( circle.Axis().Direction() );
      result.radius     = circle.Radius();
    } else if ( candidate.type == "edge_midpoint" ) {
      const auto first = curve.FirstParameter();
      const auto last  = curve.LastParameter();
      if ( !std::isfinite( first ) || !std::isfinite( last ) ) {
        return {};
      }
      // Non-uniform curves do not reach half their length at the parameter midpoint.
      const auto length = GCPnts_AbscissaPoint::Length( curve, first, last, Precision::Confusion() );
      work.check();
      if ( !std::isfinite( length ) || length <= 0 ) {
        return {};
      }
      const auto tolerance = std::min( Precision::Confusion(), length * 1e-8 );
      if ( tolerance <= 0 ) {
        fail( "UNSUPPORTED_SOURCE", "Curve length is below the supported numerical range." );
      }
      GCPnts_AbscissaPoint midpoint( curve, length * 0.5, first, first + ( last - first ) * 0.5, tolerance );
      work.check();
      if ( !midpoint.IsDone() || !std::isfinite( midpoint.Parameter() ) || midpoint.Parameter() < first ||
           midpoint.Parameter() > last ) {
        fail( "PARSE_FAILED", "Cannot locate the edge's half-length point." );
      }
      result.origin = point( curve.Value( midpoint.Parameter() ) );
    } else {
      return {};
    }
  } else {
    result.origin = point( BRep_Tool::Pnt( TopoDS::Vertex( geometry.vertices( candidate.index ) ) ) );
  }
  return result;
}
}  // namespace

FeaturePage listGeometryFeatures( const CadDocument &document, const FeatureQuery &query, const WorkContext &work )
{
  const std::set<std::string> supported{ "plane_center", "circle_center", "cylinder_axis", "edge_midpoint", "vertex" };
  if ( query.types.empty() || !std::all_of( query.types.begin(), query.types.end(),
                                            [ & ]( const auto &type ) { return supported.contains( type ); } ) ) {
    fail( "INVALID_ARGUMENT", "Request supported CAD feature types." );
  }
  const auto &object = document.object( query.object_id );
  FeaturePage result;
  if ( object.geometry_id.empty() ) {
    result.analysis_complete = false;
    result.warnings.push_back( "Assembly has no own geometry." );
    return result;
  }
  const auto &geometry   = document.storage().geometries.at( object.geometry_id );
  TopoDS_Shape selection = geometry.shape;
  if ( query.topology_ref ) {
    const auto &ref = *query.topology_ref;
    if ( ref.kind == "face" ) {
      selection = geometry.faces( topologyIndex( geometry, ref, geometry.faces.Extent() ) );
    } else if ( ref.kind == "edge" ) {
      selection = geometry.edges( topologyIndex( geometry, ref, geometry.edges.Extent() ) );
    } else if ( ref.kind == "vertex" ) {
      selection = geometry.vertices( topologyIndex( geometry, ref, geometry.vertices.Extent() ) );
    } else {
      fail( "INVALID_ARGUMENT", "Unknown topology kind." );
    }
  }
  Json filter{
      {"kind",   "features" },
      {"object", object.id  },
      {"types",  query.types}
  };
  if ( query.topology_ref ) {
    filter[ "topology" ] = {
        {"kind", query.topology_ref->kind},
        {"id",   query.topology_ref->id  }
    };
  }
  const auto key    = queryKey( document, filter );
  const auto offset = pageOffset( query.page, key );
  std::vector<Candidate> candidates;
  const auto append = [ & ]( TopAbs_ShapeEnum shape_type, const char *kind, const TopTools_IndexedMapOfShape &full_map,
                             const std::vector<std::string> &types ) {
    TopTools_IndexedMapOfShape selected;
    TopExp::MapShapes( selection, shape_type, selected );
    for ( int i = 1; i <= selected.Extent(); ++i ) {
      work.check();
      const auto index = full_map.FindIndex( selected( i ) );
      for ( const auto &type : types ) {
        if ( query.types.contains( type ) ) {
          candidates.push_back( { kind, index, type } );
        }
      }
      if ( candidates.size() > 200000 ) {
        fail( "LIMIT_EXCEEDED", "Narrow the topology selection for this feature query." );
      }
    }
  };
  append( TopAbs_FACE, "face", geometry.faces, { "plane_center", "cylinder_axis" } );
  append( TopAbs_EDGE, "edge", geometry.edges, { "circle_center", "edge_midpoint" } );
  append( TopAbs_VERTEX, "vertex", geometry.vertices, { "vertex" } );
  if ( offset > candidates.size() ) {
    fail( "INVALID_ARGUMENT", "Cursor is outside this feature query." );
  }
  std::size_t bytes = 0;
  for ( auto i = offset; i < candidates.size(); ++i ) {
    work.check();
    const auto feature = evaluateFeature( object, geometry, candidates[ i ], work );
    if ( !feature ) {
      continue;
    }
    if ( result.items.size() >= query.page.limit || !appendItem( result.items, *feature, bytes, work ) ) {
      result.next_cursor = key + ":" + std::to_string( i );
      break;
    }
  }
  return result;
}
}  // namespace dai::cad
