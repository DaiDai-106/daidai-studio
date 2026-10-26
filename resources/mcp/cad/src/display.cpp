#include "cad/display.h"
#include "cad/serialization.h"
#include "cad/files.h"
#include "private/meshing.h"
#include "private/document_internal.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <limits>
#include <map>
#include <span>
#include <BRep_Tool.hxx>
#include <Poly.hxx>
#include <Poly_Triangulation.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <tiny_gltf.h>

namespace dai::cad
{
namespace
{
std::array<float, 3> displayVector( double x, double y, double z )
{
  const std::array<double, 3> converted{ x, z, -y };
  std::array<float, 3> result{};
  for ( std::size_t i = 0; i < 3; ++i ) {
    result[ i ] = static_cast<float>( converted[ i ] );
    if ( !std::isfinite( result[ i ] ) || std::abs( result[ i ] - converted[ i ] ) > 0.00001 ) {
      fail( "LIMIT_EXCEEDED", "Display coordinates exceed float32 precision budget." );
    }
  }
  return result;
}
std::size_t primitiveFor( MeshChunk &mesh, const std::optional<Rgba> &color,
                          std::map<std::optional<Rgba>, std::size_t> &indices )
{
  if ( const auto it = indices.find( color ); it != indices.end() ) {
    return it->second;
  }
  const auto index = mesh.primitives.size();
  indices.emplace( color, index );
  mesh.primitives.push_back( { color, {}, {} } );
  return index;
}
double linearColor( double value )
{
  return value <= 0.04045 ? value / 12.92 : std::pow( ( value + 0.055 ) / 1.055, 2.4 );
}
}  // namespace

MeshData meshGeometry( CadDocument &document, const std::string &geometry_id, const QualityProfile &profile,
                       MeshRecoveryBudget &budget, const WorkContext &work )
{
  const auto &geometry = document.storage().geometries.at( geometry_id );
  auto prepared        = prepareMesh( geometry, profile, budget, work );
  MeshData result;
  result.geometry_id  = geometry_id;
  result.status_flags = prepared.status_flags;
  result.complete     = prepared.complete;
  if ( prepared.displayable ) {
    result.recoveries = std::move( prepared.recoveries );
  }
  result.chunks.emplace_back();
  std::map<std::optional<Rgba>, std::size_t> primitive_indices;
  std::uint64_t triangles = 0, vertices = 0;
  for ( int face_index = 1; face_index <= geometry.faces.Extent(); ++face_index ) {
    work.check();
    const auto &prepared_face = prepared.faces.at( face_index - 1 );
    const auto &face          = prepared_face.shape;
    const TopologyRef reference{ "face", topologyId( geometry, "face", face_index ) };
    TopLoc_Location location;
    const auto triangulation = BRep_Tool::Triangulation( face, location );
    const bool missing_mesh  = triangulation.IsNull() || !triangulation->NbTriangles();
    if ( !prepared.displayable || missing_mesh || ( prepared_face.status_flags & mesh_failure_flags ) != 0 ||
         !prepared_face.validation_error.empty() ) {
      result.complete = false;
      result.face_issues.push_back(
          { reference, prepared_face.status_flags, missing_mesh,
            prepared.displayable ? prepared_face.validation_error : "geometry_mesh_incomplete" } );
      // Keep CAD topology intact; excluded faces produce neither vertices nor map ranges.
      continue;
    }
    triangles += triangulation->NbTriangles();
    if ( triangles > work.limits.max_triangles ) {
      fail( "LIMIT_EXCEEDED", "Triangle budget exceeded." );
    }
    vertices += triangulation->NbNodes();
    if ( vertices * 24ULL + triangles * 12ULL > work.limits.max_resource_bytes ) {
      fail( "LIMIT_EXCEEDED", "Mesh buffer budget exceeded." );
    }
    if ( !triangulation->HasNormals() ) {
      Poly::ComputeNormals( triangulation );
    }
    const bool recovered = std::any_of( result.recoveries.begin(), result.recoveries.end(),
                                        [ & ]( const auto &item ) { return item.face.id == reference.id; } );
    // Small recovered faces keep a local display origin. glTF stores that origin
    // on a child node; original CAD/object transforms and face IDs stay unchanged.
    if ( recovered ) {
      result.chunks.emplace_back();
      const auto &origin          = prepared_face.display_origin;
      result.chunks.back().origin = { origin.X(), origin.Y(), origin.Z() };
    }
    auto &chunk = recovered ? result.chunks.back() : result.chunks.front();
    const gp_XYZ origin( chunk.origin[ 0 ], chunk.origin[ 1 ], chunk.origin[ 2 ] );
    const auto vertex_offset = static_cast<std::uint32_t>( chunk.positions.size() / 3 );
    const auto reversed      = face.Orientation() == TopAbs_REVERSED;
    const auto transform     = prepared_face.to_source * location.Transformation();
    for ( int i = 1; i <= triangulation->NbNodes(); ++i ) {
      const gp_Pnt point( triangulation->Node( i ).Transformed( transform ).XYZ() - origin );
      auto normal = triangulation->Normal( i ).Transformed( transform );
      if ( reversed ) {
        normal.Reverse();
      }
      const auto position  = displayVector( point.X(), point.Y(), point.Z() );
      const auto direction = displayVector( normal.X(), normal.Y(), normal.Z() );
      chunk.positions.insert( chunk.positions.end(), position.begin(), position.end() );
      chunk.normals.insert( chunk.normals.end(), direction.begin(), direction.end() );
    }
    const auto &color = geometry.face_colors[ face_index - 1 ];
    if ( recovered ) {
      chunk.primitives.push_back( { color, {}, {} } );
    }
    auto &primitive           = chunk.primitives[ recovered ? 0 : primitiveFor( chunk, color, primitive_indices ) ];
    const auto first_triangle = static_cast<std::uint32_t>( primitive.indices.size() / 3 );
    for ( int i = 1; i <= triangulation->NbTriangles(); ++i ) {
      int a, b, c;
      triangulation->Triangle( i ).Get( a, b, c );
      if ( reversed ) {
        std::swap( b, c );
      }
      for ( const auto vertex : { a, b, c } ) {
        if ( vertex < 1 || vertex > triangulation->NbNodes() ) {
          fail( "MESH_FAILED", "Invalid triangle index." );
        }
        primitive.indices.push_back( vertex_offset + vertex - 1 );
      }
    }
    primitive.face_ranges.push_back(
        { reference, first_triangle, static_cast<std::uint32_t>( triangulation->NbTriangles() ) } );
  }
  return result;
}

namespace
{
template <class T>
int addAccessor( tinygltf::Model &model, const std::vector<T> &values, int type, int component_type, int target,
                 const WorkContext &work )
{
  static_assert( std::endian::native == std::endian::little );
  auto &buffer     = model.buffers.front().data;
  const auto bytes = std::as_bytes( std::span( values ) );
  if ( buffer.size() + bytes.size() > work.limits.max_resource_bytes ) {
    fail( "LIMIT_EXCEEDED", "GLB buffer budget exceeded." );
  }
  tinygltf::BufferView view;
  view.buffer      = 0;
  view.byteOffset  = buffer.size();
  view.byteLength  = bytes.size();
  view.target      = target;
  const auto *data = reinterpret_cast<const unsigned char *>( bytes.data() );
  buffer.insert( buffer.end(), data, data + bytes.size() );
  model.bufferViews.push_back( std::move( view ) );
  tinygltf::Accessor accessor;
  accessor.bufferView    = model.bufferViews.size() - 1;
  accessor.componentType = component_type;
  accessor.type          = type;
  accessor.count         = values.size() / ( type == TINYGLTF_TYPE_VEC3 ? 3 : 1 );
  if ( type == TINYGLTF_TYPE_VEC3 && !values.empty() ) {
    accessor.minValues.assign( 3, std::numeric_limits<double>::infinity() );
    accessor.maxValues.assign( 3, -std::numeric_limits<double>::infinity() );
    for ( std::size_t i = 0; i < values.size(); ++i ) {
      accessor.minValues[ i % 3 ] = std::min( accessor.minValues[ i % 3 ], static_cast<double>( values[ i ] ) );
      accessor.maxValues[ i % 3 ] = std::max( accessor.maxValues[ i % 3 ], static_cast<double>( values[ i ] ) );
    }
  }
  model.accessors.push_back( std::move( accessor ) );
  return model.accessors.size() - 1;
}
int addMaterial( tinygltf::Model &model, const Rgba &color, std::map<Rgba, int> &materials )
{
  if ( const auto it = materials.find( color ); it != materials.end() ) {
    return it->second;
  }
  tinygltf::Material material;
  material.pbrMetallicRoughness.baseColorFactor = { linearColor( color[ 0 ] ), linearColor( color[ 1 ] ),
                                                    linearColor( color[ 2 ] ), color[ 3 ] };
  material.pbrMetallicRoughness.metallicFactor  = 0;
  material.pbrMetallicRoughness.roughnessFactor = 0.65;
  material.doubleSided = true;  // Valid independent shells must remain visible from both sides.
  if ( color[ 3 ] < 1 ) {
    material.alphaMode = "BLEND";
  }
  const auto index = static_cast<int>( model.materials.size() );
  model.materials.push_back( std::move( material ) );
  materials.emplace( color, index );
  return index;
}
struct PrimitiveBuffers {
  int indices;
  std::optional<Rgba> source_color;
  std::vector<FaceTriangleRange> face_ranges;
};
struct GeometryBuffers {
  Vec3 origin;
  int positions;
  int normals;
  std::vector<PrimitiveBuffers> primitives;
};
}  // namespace

DisplayResult writeDisplay( CadDocument &document, const std::string &quality, const ServerContext &server,
                            const std::filesystem::path &job_directory, const WorkContext &work )
{
  work.report( "build_display" );
  // Completed outputs outlive documents and native restarts; budget the service-owned files.
  std::uint64_t retained_bytes = 0;
  for ( const auto &entry : std::filesystem::recursive_directory_iterator( server.output_root ) ) {
    work.check();
    if ( entry.is_regular_file() ) {
      retained_bytes += entry.file_size();
    }
    if ( retained_bytes >= work.limits.max_total_resource_bytes ) {
      fail( "LIMIT_EXCEEDED", "Retained CAD outputs exceed the total budget." );
    }
  }
  std::filesystem::create_directory( job_directory );
  tinygltf::Model model;
  model.asset.version   = "2.0";
  model.asset.generator = "Dai CAD";
  model.defaultScene    = 0;
  model.scenes.emplace_back();
  model.buffers.emplace_back();
  const auto &source = document.source();
  Json mapping{
      {"schemaVersion",     1                        },
      {"sourceHash",        source.source_hash       },
      {"importFingerprint", source.import_fingerprint},
      {"ranges",            Json::array()            },
      {"omittedFaces",      Json::array()            }
  };
  Json diagnostics = Json::array();
  std::map<std::string, std::vector<GeometryBuffers>> buffers;
  std::map<std::string, std::string> representatives;
  std::map<std::string, std::size_t> omitted_by_geometry;
  for ( const auto &object : document.objects() ) {
    if ( !object.geometry_id.empty() ) {
      representatives.try_emplace( object.geometry_id, object.id );
    }
  }
  std::uint64_t triangle_count = 0;
  bool complete                = true;
  MeshRecoveryBudget recovery_budget;
  std::size_t recovered_faces = 0;
  for ( const auto &[ geometry_id, representative_id ] : representatives ) {
    auto mesh = meshGeometry( document, geometry_id, qualityProfile( quality ), recovery_budget, work );
    complete  = complete && mesh.complete;
    recovered_faces += mesh.recoveries.size();
    omitted_by_geometry.emplace( geometry_id, mesh.face_issues.size() );
    for ( const auto &issue : mesh.face_issues ) {
      mapping[ "omittedFaces" ].push_back( {
          {"geometryId",  geometry_id                                             },
          {"topologyRef", { { "kind", issue.face.kind }, { "id", issue.face.id } }}
      } );
    }
    for ( const auto &recovery : mesh.recoveries ) {
      if ( !mapping.contains( "recoveries" ) ) {
        mapping[ "recoveries" ] = Json::array();
      }
      mapping[ "recoveries" ].push_back( {
          {"geometryId",          geometry_id                                                   },
          {"topologyRef",         { { "kind", recovery.face.kind }, { "id", recovery.face.id } }},
          {"method",              recovery.method                                               },
          {"originalStatusFlags", recovery.original_status_flags                                },
          {"sourceAreaM2",        recovery.source_area_m2                                       },
          {"meshAreaM2",          recovery.mesh_area_m2                                         },
          {"toleranceIncreaseM",  recovery.tolerance_increase_m                                 }
      } );
    }

    if ( !mesh.complete && diagnostics.size() < 100 ) {
      diagnostics.push_back( {
          {"objectId", representative_id                                     },
          {"stage",    "triangulate"                                         },
          {"status",   "mesher_status_" + std::to_string( mesh.status_flags )}
      } );
    }
    if ( !mesh.face_issues.empty() ) {
      complete = false;
      for ( const auto &issue : mesh.face_issues ) {
        if ( diagnostics.size() == 100 ) {
          break;
        }
        diagnostics.push_back( {
            {"objectId",    representative_id                                                                                  },
            {"topologyRef", { { "kind", issue.face.kind }, { "id", issue.face.id } }                                           },
            {"stage",       "triangulate"                                                                                      },
            {"status",      issue.missing_mesh ? "missing_face_mesh"
                                           : "face_mesher_status_" + std::to_string( issue.status_flags )}
        } );
        if ( !issue.validation_error.empty() && diagnostics.size() < 100 ) {
          diagnostics.push_back( {
              {"objectId",    representative_id                                       },
              {"topologyRef", { { "kind", issue.face.kind }, { "id", issue.face.id } }},
              {"stage",       "recover_mesh"                                          },
              {"status",      issue.validation_error                                  }
          } );
        }
      }
    }
    // An unavailable geometry retains its objects, but has no draw buffers.
    buffers.try_emplace( geometry_id );
    for ( auto &chunk : mesh.chunks ) {
      if ( chunk.positions.empty() ) {
        continue;
      }
      GeometryBuffers geometry_buffers;
      geometry_buffers.origin    = chunk.origin;
      geometry_buffers.positions = addAccessor( model, chunk.positions, TINYGLTF_TYPE_VEC3,
                                                TINYGLTF_COMPONENT_TYPE_FLOAT, TINYGLTF_TARGET_ARRAY_BUFFER, work );
      geometry_buffers.normals   = addAccessor( model, chunk.normals, TINYGLTF_TYPE_VEC3, TINYGLTF_COMPONENT_TYPE_FLOAT,
                                                TINYGLTF_TARGET_ARRAY_BUFFER, work );
      for ( auto &primitive : chunk.primitives ) {
        triangle_count += primitive.indices.size() / 3;
        if ( triangle_count > work.limits.max_triangles ) {
          fail( "LIMIT_EXCEEDED", "Total triangle budget exceeded." );
        }
        const auto index_accessor =
            addAccessor( model, primitive.indices, TINYGLTF_TYPE_SCALAR, TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT,
                         TINYGLTF_TARGET_ELEMENT_ARRAY_BUFFER, work );
        geometry_buffers.primitives.push_back(
            { index_accessor, primitive.source_color, std::move( primitive.face_ranges ) } );
      }
      buffers[ geometry_id ].push_back( std::move( geometry_buffers ) );
    }
  }
  std::map<Rgba, int> materials;
  std::map<std::string, std::vector<int>> mesh_variants;
  std::map<std::string, int> nodes;
  Json objects = Json::array();
  for ( const auto &object : document.objects() ) {
    work.check();
    const auto &transform = object.local_transform;
    tinygltf::Node node;
    node.name        = object.name;
    node.translation = { transform.translation[ 0 ], transform.translation[ 2 ], -transform.translation[ 1 ] };
    node.rotation    = { transform.rotation[ 0 ], transform.rotation[ 2 ], -transform.rotation[ 1 ],
                         transform.rotation[ 3 ] };
    node.scale       = { transform.scale[ 0 ], transform.scale[ 2 ], transform.scale[ 1 ] };
    node.extras      = tinygltf::Value( tinygltf::Value::Object{
             {"objectId",  tinygltf::Value( object.id )        },
             {"sourceKey", tinygltf::Value( object.source_key )}
    } );
    Json item{
        {"objectId",       object.id                                        },
        {"name",           object.name                                      },
        {"kind",           object.geometry_id.empty() ? "assembly" : "shape"},
        {"sourceKey",      object.source_key                                },
        {"nodeKey",        object.id                                        },
        {"localTransform", toJson( transform )                              }
    };
    if ( !object.parent_id.empty() ) {
      item[ "parentObjectId" ] = object.parent_id;
    }
    if ( object.color ) {
      item[ "appearance" ] = {
          { "objectColor", *object.color }
      };
    }
    if ( !object.geometry_id.empty() ) {
      item[ "geometryId" ] = object.geometry_id;
      item[ "display" ]    = {
          {"faceCount",        document.storage().geometries.at( object.geometry_id ).faces.Extent()},
          {"omittedFaceCount", omitted_by_geometry.at( object.geometry_id )                         }
      };
    }
    if ( !object.geometry_id.empty() && !buffers.at( object.geometry_id ).empty() ) {
      const auto base_color     = object.color.value_or( Rgba{ 0.72, 0.73, 0.75, 1 } );
      const auto explicit_color = document.storage().instance_color_overrides.contains( object.id );
      const auto key = object.geometry_id + Json( base_color ).dump() + ( explicit_color ? "override" : "base" );
      if ( !mesh_variants.contains( key ) ) {
        std::vector<int> variants;
        for ( const auto &geometry_buffers : buffers.at( object.geometry_id ) ) {
          const auto mesh_index = static_cast<int>( model.meshes.size() );
          tinygltf::Mesh mesh;
          for ( std::size_t i = 0; i < geometry_buffers.primitives.size(); ++i ) {
            const auto &primitive = geometry_buffers.primitives[ i ];
            tinygltf::Primitive draw;
            draw.mode       = TINYGLTF_MODE_TRIANGLES;
            draw.attributes = {
                {"POSITION", geometry_buffers.positions},
                {"NORMAL",   geometry_buffers.normals  }
            };
            draw.indices  = primitive.indices;
            draw.material = addMaterial(
                model, explicit_color ? base_color : primitive.source_color.value_or( base_color ), materials );
            mesh.primitives.push_back( std::move( draw ) );
            for ( const auto &range : primitive.face_ranges ) {
              mapping[ "ranges" ].push_back( {
                  {"geometryId",     object.geometry_id                                      },
                  {"meshIndex",      mesh_index                                              },
                  {"primitiveIndex", i                                                       },
                  {"firstTriangle",  range.first_triangle                                    },
                  {"triangleCount",  range.triangle_count                                    },
                  {"topologyRef",    { { "kind", range.face.kind }, { "id", range.face.id } }}
              } );
            }
          }
          model.meshes.push_back( std::move( mesh ) );
          variants.push_back( mesh_index );
        }
        mesh_variants.emplace( key, std::move( variants ) );
      }
      const auto &chunks   = buffers.at( object.geometry_id );
      const auto &variants = mesh_variants.at( key );
      for ( std::size_t index = 0; index < chunks.size(); ++index ) {
        tinygltf::Node draw;
        draw.mesh          = variants[ index ];
        const auto &origin = chunks[ index ].origin;
        draw.translation   = { origin[ 0 ], origin[ 2 ], -origin[ 1 ] };
        node.children.push_back( model.nodes.size() );
        model.nodes.push_back( std::move( draw ) );
      }
    }
    nodes.emplace( object.id, model.nodes.size() );
    model.nodes.push_back( std::move( node ) );
    objects.push_back( std::move( item ) );
  }
  if ( triangle_count == 0 ) {
    fail( "MESH_FAILED", "STEP has no displayable faces; all CAD geometry remains unchanged." );
  }
  for ( const auto &object : document.objects() ) {
    if ( object.parent_id.empty() ) {
      model.scenes.front().nodes.push_back( nodes.at( object.id ) );
    } else {
      model.nodes[ nodes.at( object.parent_id ) ].children.push_back( nodes.at( object.id ) );
    }
  }
  work.report( "write_display" );
  const auto glb_path = job_directory / "display.glb";
  std::ofstream output( glb_path, std::ios::binary | std::ios::trunc );
  tinygltf::TinyGLTF writer;
  if ( !writer.WriteGltfSceneToStream( &model, output, false, true ) ) {
    fail( "IO_ERROR", "Cannot write GLB display." );
  }
  output.close();
  if ( !output ) {
    fail( "IO_ERROR", "Cannot complete GLB display." );
  }
  const auto glb = describeResource( server, glb_path, "model/gltf-binary", work );
  for ( auto &object : objects ) {
    if ( object.contains( "display" ) &&
         object[ "display" ][ "omittedFaceCount" ] < object[ "display" ][ "faceCount" ] ) {
      object[ "geometryResourceUri" ] = glb.uri;
    }
  }
  const auto mapping_path = job_directory / "faces.json";
  writeJson( mapping_path, mapping, work );
  const auto face_map = describeResource( server, mapping_path, "application/json", work );
  Json warning_list   = Json::array();
  if ( recovered_faces ) {
    warning_list.push_back( "Recovered " + std::to_string( recovered_faces ) +
                            " display faces with validated local meshing. Original CAD geometry is unchanged; "
                            "display completeness does not certify B-Rep validity." );
  }
  if ( !complete ) {
    warning_list.push_back( "Partial display: " + std::to_string( mapping[ "omittedFaces" ].size() ) +
                            " CAD faces were excluded after meshing checks. Original CAD geometry is unchanged." );
  }
  Json manifest{
      {"schemaVersion",    1                                                                            },
      {"source",           toJson( source )                                                             },
      {"quality",          quality                                                                      },
      {"complete",         complete                                                                     },
      {"omittedFaceCount", mapping[ "omittedFaces" ].size()                                             },
      {"coordinateSystem",
       { { "unit", "m" }, { "upAxis", "Z" }, { "handedness", "right" }, { "gltfConversion", "x,z,-y" } }},
      {"resources",        { toJson( glb ), toJson( face_map ) }                                        },
      {"displayToScene",
       toJson( Transform{ { 0, 0, 0 }, { std::sqrt( 0.5 ), 0, 0, std::sqrt( 0.5 ) }, { 1, 1, 1 } } )    },
      {"roots",            document.roots()                                                             },
      {"objects",          std::move( objects )                                                         },
      {"diagnostics",      diagnostics                                                                  },
      {"warnings",         warning_list                                                                 }
  };
  const auto manifest_path = job_directory / "manifest.json";
  writeJson( manifest_path, manifest, work );
  const auto descriptor = describeResource( server, manifest_path, "application/json", work );
  const auto total_size = glb.byte_length + face_map.byte_length + descriptor.byte_length;
  if ( total_size > work.limits.max_total_resource_bytes - retained_bytes ) {
    fail( "LIMIT_EXCEEDED", "Display resources exceed the total budget." );
  }
  return {
      descriptor,
      { source, complete, document.objects().size(), buffers.size(), triangle_count, warning_list.size(),
        mapping[ "omittedFaces" ].size() }
  };
}
}  // namespace dai::cad
