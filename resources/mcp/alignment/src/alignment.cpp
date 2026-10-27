#include "alignment/alignment.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <vector>
#include <Eigen/Geometry>
#include <tiny_gltf.h>
#include <nlohmann/json.hpp>
#include <map>
#include <set>
#include <numbers>

namespace dai::alignment
{
namespace
{
using Matrix = Eigen::Affine3d;
[[noreturn]] void invalid()
{
  throw AlignmentError( "INVALID_RESOURCE", "Invalid or unsupported saved display geometry." );
}
Matrix transform( const Transform &value )
{
  const auto &t = value.translation;
  const auto &q = value.rotation;
  const auto &s = value.scale;
  Eigen::Quaterniond rotation( q[ 3 ], q[ 0 ], q[ 1 ], q[ 2 ] );
  if ( !std::isfinite( rotation.norm() ) || std::abs( rotation.norm() - 1 ) > 1e-6 ) {
    invalid();
  }
  Matrix result = Eigen::Translation3d( t[ 0 ], t[ 1 ], t[ 2 ] ) * rotation * Eigen::Scaling( s[ 0 ], s[ 1 ], s[ 2 ] );
  if ( !result.matrix().allFinite() ) {
    invalid();
  }
  return result;
}
Matrix nodeTransform( const tinygltf::Node &node )
{
  if ( !node.matrix.empty() ) {
    if ( node.matrix.size() != 16 ) {
      invalid();
    }
    Matrix result( Eigen::Map<const Eigen::Matrix4d>( node.matrix.data() ) );
    if ( !result.matrix().allFinite() ||
         !result.matrix().row( 3 ).isApprox( Eigen::RowVector4d( 0, 0, 0, 1 ), 1e-9 ) ) {
      invalid();
    }
    return result;
  }
  Transform value;
  const auto copy = []( const auto &from, auto &to ) {
    if ( from.empty() ) {
      return;
    }
    if ( from.size() != to.size() ) {
      invalid();
    }
    std::copy( from.begin(), from.end(), to.begin() );
  };
  copy( node.translation, value.translation );
  copy( node.rotation, value.rotation );
  copy( node.scale, value.scale );
  return transform( value );
}
// Decode accessors without alignment-dependent casts or reads beyond their buffer view.
const unsigned char *element( const tinygltf::Model &model, const tinygltf::Accessor &accessor, std::size_t index,
                              std::size_t bytes )
{
  if ( accessor.sparse.isSparse || accessor.bufferView < 0 || index >= accessor.count ||
       static_cast<std::size_t>( accessor.bufferView ) >= model.bufferViews.size() ) {
    invalid();
  }
  const auto &view = model.bufferViews[ accessor.bufferView ];
  if ( view.buffer < 0 || static_cast<std::size_t>( view.buffer ) >= model.buffers.size() ) {
    invalid();
  }
  const auto stride = accessor.ByteStride( view );
  if ( stride < 0 || static_cast<std::size_t>( stride ) < bytes ) {
    invalid();
  }
  const auto &data = model.buffers[ view.buffer ].data;
  const auto step  = static_cast<std::size_t>( stride );
  if ( view.byteOffset > data.size() || view.byteLength > data.size() - view.byteOffset ||
       accessor.byteOffset > view.byteLength || bytes > view.byteLength - accessor.byteOffset ||
       index > ( view.byteLength - accessor.byteOffset - bytes ) / step ) {
    invalid();
  }
  return data.data() + view.byteOffset + accessor.byteOffset + index * step;
}
std::size_t vertexIndex( const tinygltf::Model &model, int accessor_id, std::size_t index )
{
  if ( accessor_id < 0 ) {
    return index;
  }
  const auto &accessor = model.accessors.at( accessor_id );
  if ( accessor.type != TINYGLTF_TYPE_SCALAR || accessor.normalized ) {
    invalid();
  }
  if ( accessor.componentType == TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE ) {
    return *element( model, accessor, index, 1 );
  }
  if ( accessor.componentType == TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT ) {
    std::uint16_t value;
    std::memcpy( &value, element( model, accessor, index, sizeof( value ) ), sizeof( value ) );
    return value;
  }
  if ( accessor.componentType == TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT ) {
    std::uint32_t value;
    std::memcpy( &value, element( model, accessor, index, sizeof( value ) ), sizeof( value ) );
    return value;
  }
  invalid();
}
}  // namespace

std::vector<Eigen::Vector3d> modelPoints( const Request &request )
{
  const auto size = std::filesystem::file_size( request.glb_path );
  if ( size < 20 || size > 2ULL * 1024 * 1024 * 1024 ) {
    invalid();
  }
  std::vector<unsigned char> bytes( size );
  std::ifstream input( request.glb_path, std::ios::binary );
  if ( !input.read( reinterpret_cast<char *>( bytes.data() ), static_cast<std::streamsize>( size ) ) ) {
    invalid();
  }
  tinygltf::TinyGLTF loader;
  tinygltf::FsCallbacks fs;
  fs.FileExists     = []( const std::string &, void     *) { return false; };
  fs.ExpandFilePath = []( const std::string &path, void * ) { return path; };
  fs.ReadWholeFile  = []( std::vector<unsigned char> *, std::string *, const std::string &, void  *) { return false; };
  fs.WriteWholeFile = []( std::string *, const std::string &, const std::vector<unsigned char> &, void * ) {
    return false;
  };
  fs.GetFileSizeInBytes = []( std::size_t *, std::string *, const std::string &, void * ) { return false; };
  fs.user_data          = nullptr;
  if ( !loader.SetFsCallbacks( fs ) ) {
    invalid();
  }
  tinygltf::Model model;
  std::string error, warning;
  if ( !loader.LoadBinaryFromMemory( &model, &error, &warning, bytes.data(), static_cast<unsigned int>( size ) ) ||
       model.scenes.empty() || model.nodes.size() > 100000 || !model.images.empty() ) {
    invalid();
  }
  for ( const auto &buffer : model.buffers ) {
    if ( !buffer.uri.empty() ) {
      invalid();
    }
  }
  const Matrix placement = transform( request.display_to_scene );
  std::vector<Eigen::Vector3d> points;
  bool found_object = request.object_id.empty();
  std::vector<bool> active( model.nodes.size(), false );
  std::uint64_t visited_vertices = 0;
  const auto visit = [ & ]( auto &&self, int id, const Matrix &parent, int depth, bool selected ) -> void {
    if ( id < 0 || static_cast<std::size_t>( id ) >= model.nodes.size() || depth > 256 || active[ id ] ) {
      invalid();
    }
    active[ id ]       = true;
    const auto &node   = model.nodes[ id ];
    const Matrix world = parent * nodeTransform( node );
    if ( !request.object_id.empty() && node.extras.IsObject() && node.extras.Has( "objectId" ) &&
         node.extras.Get( "objectId" ).IsString() &&
         node.extras.Get( "objectId" ).Get<std::string>() == request.object_id ) {
      found_object = true;
      selected     = true;
    }
    if ( node.mesh >= 0 && selected ) {
      for ( const auto &primitive : model.meshes.at( node.mesh ).primitives ) {
        if ( primitive.mode != TINYGLTF_MODE_TRIANGLES || !primitive.attributes.contains( "POSITION" ) ) {
          invalid();
        }
        const auto &positions = model.accessors.at( primitive.attributes.at( "POSITION" ) );
        if ( positions.type != TINYGLTF_TYPE_VEC3 || positions.componentType != TINYGLTF_COMPONENT_TYPE_FLOAT ||
             positions.normalized ) {
          invalid();
        }
        const auto count = primitive.indices < 0 ? positions.count : model.accessors.at( primitive.indices ).count;
        visited_vertices += count;
        if ( count % 3 || visited_vertices > 300000000 ) {
          invalid();
        }
        for ( std::size_t i = 0; i < count; ++i ) {
          float xyz[ 3 ];
          std::memcpy( xyz, element( model, positions, vertexIndex( model, primitive.indices, i ), sizeof( xyz ) ),
                       sizeof( xyz ) );
          const Eigen::Vector3d point = world * Eigen::Vector3d( xyz[ 0 ], xyz[ 1 ], xyz[ 2 ] );
          if ( !point.allFinite() || point.cwiseAbs().maxCoeff() > 1e9 ) {
            invalid();
          }
          points.push_back( point );
        }
      }
    }
    for ( const auto child : node.children ) {
      self( self, child, world, depth + 1, selected );
    }
    active[ id ] = false;
  };
  const auto scene = model.defaultScene < 0 ? 0 : model.defaultScene;
  for ( const auto root : model.scenes.at( scene ).nodes ) {
    visit( visit, root, placement, 0, request.object_id.empty() );
  }
  if ( !found_object ) {
    throw AlignmentError( "OBJECT_NOT_FOUND", "The saved model has no such object." );
  }
  if ( points.empty() ) {
    throw AlignmentError( "NO_DISPLAY_VERTICES", "The selected object has no rendered triangle vertices." );
  }
  return points;
}
namespace
{
using Json = nlohmann::json;
Eigen::Vector3d vector( const Vec3 &value )
{
  Eigen::Vector3d result( value[ 0 ], value[ 1 ], value[ 2 ] );
  if ( !result.allFinite() || result.cwiseAbs().maxCoeff() > 1e9 ) {
    invalid();
  }
  return result;
}
Vec3 array( const Eigen::Vector3d &value )
{
  return { value.x(), value.y(), value.z() };
}
Matrix rigid( const Placement &value )
{
  Transform full;
  full.translation = value.translation;
  full.rotation    = value.rotation;
  return transform( full );
}
Placement placement( const Matrix &value )
{
  Eigen::Quaterniond q( value.linear() );
  q.normalize();
  if ( q.w() < 0 ) {
    q.coeffs() *= -1;
  }
  if ( !value.matrix().allFinite() || std::abs( value.linear().determinant() - 1 ) > 1e-8 ||
       !( value.linear().transpose() * value.linear() ).isApprox( Eigen::Matrix3d::Identity(), 1e-8 ) ||
       value.translation().cwiseAbs().maxCoeff() > 1e9 ) {
    invalid();
  }
  return {
      array( value.translation() ), { q.x(), q.y(), q.z(), q.w() }
  };
}
Bounds bounds( const std::vector<Eigen::Vector3d> &points, const Matrix &world )
{
  Eigen::Vector3d min = Eigen::Vector3d::Constant( std::numeric_limits<double>::infinity() );
  Eigen::Vector3d max = -min;
  for ( const auto &point : points ) {
    const Eigen::Vector3d p = world * point;
    if ( !p.allFinite() || p.cwiseAbs().maxCoeff() > 1e9 ) {
      invalid();
    }
    min = min.cwiseMin( p );
    max = max.cwiseMax( p );
  }
  return { array( min ), array( max ) };
}
Eigen::Matrix3d basis( const Frame &frame )
{
  auto up      = vector( frame.up );
  auto forward = vector( frame.forward );
  if ( up.norm() < 1e-12 || forward.norm() < 1e-12 ) {
    throw AlignmentError( "DEGENERATE_FRAME", "Frame directions must be nonzero." );
  }
  up.normalize();
  forward.normalize();
  if ( std::abs( up.dot( forward ) ) > 1e-4 ) {
    throw AlignmentError( "DEGENERATE_FRAME", "Up and forward must be perpendicular." );
  }
  forward = ( forward - up * up.dot( forward ) ).normalized();
  Eigen::Matrix3d result;
  result.col( 0 ) = forward;
  result.col( 1 ) = up.cross( forward );
  result.col( 2 ) = up;
  return result;
}
Frame resolvedFrame( const Frame &frame, const Eigen::Matrix3d &axes )
{
  return { frame.origin, array( axes.col( 2 ) ), array( axes.col( 0 ) ) };
}
Json readJson( const std::filesystem::path &path )
{
  if ( path.empty() || std::filesystem::file_size( path ) > 32 * 1024 * 1024 ) {
    invalid();
  }
  std::ifstream input( path );
  return Json::parse( input );
}
Transform jsonTransform( const Json &value )
{
  Transform result;
  result.translation = value.at( "translation" ).get<Vec3>();
  result.rotation    = value.at( "rotation" ).get<Quaternion>();
  result.scale       = value.at( "scale" ).get<Vec3>();
  return result;
}
// Feature coordinates are CAD Z-up object-local. Manifest localTransform is already CAD Z-up;
// displayToScene only converts GLB vertices and must NOT be applied to these features again.
class Features
{
 public:
  explicit Features( const Request &request )
      : manifest_( readJson( request.manifest_path ) ), path_( request.features_path )
  {
  }
  std::pair<Json, Matrix> get( const FeatureRef &ref )
  {
    if ( path_.empty() || !manifest_.contains( "features" ) ) {
      throw AlignmentError( "FEATURE_CACHE_MISSING",
                            "This import has no alignment feature cache; explicitly reimport to create one." );
    }
    const auto &objects = manifest_.at( "objects" );
    std::map<std::string, const Json *> entries;
    for ( const auto &item : objects ) {
      entries.emplace( item.at( "objectId" ).get<std::string>(), &item );
    }
    Matrix world        = Matrix::Identity();
    std::string current = ref.object_id;
    std::set<std::string> seen;
    while ( !current.empty() ) {
      const auto it = entries.find( current );
      if ( it == entries.end() || !seen.insert( current ).second || seen.size() > 256 ) {
        throw AlignmentError( "OBJECT_NOT_FOUND", "Feature object hierarchy is invalid." );
      }
      world   = transform( jsonTransform( it->second->at( "localTransform" ) ) ) * world;
      current = it->second->value( "parentObjectId", std::string() );
    }
    if ( std::filesystem::file_size( path_ ) > 32 * 1024 * 1024 ) {
      invalid();
    }
    std::ifstream input( path_ );
    std::string line;
    std::getline( input, line );
    const auto header = Json::parse( line );
    if ( header.at( "schemaVersion" ) != 1 ||
         header.at( "sourceHash" ) != manifest_.at( "source" ).at( "sourceHash" ) ||
         header.at( "importFingerprint" ) != manifest_.at( "source" ).at( "importFingerprint" ) ||
         header.at( "unit" ) != "m" || header.at( "space" ) != "object" ) {
      invalid();
    }
    while ( std::getline( input, line ) ) {
      if ( line.size() > 16384 ) {
        invalid();
      }
      auto item = Json::parse( line );
      if ( item.at( "objectId" ) == ref.object_id && item.at( "featureId" ) == ref.feature_id ) {
        return { std::move( item ), world };
      }
    }
    throw AlignmentError( "FEATURE_NOT_FOUND", "The requested feature is not in this saved import cache." );
  }

 private:
  Json manifest_;
  std::filesystem::path path_;
};
}  // namespace
AlignmentError::AlignmentError( std::string value, std::string message )
    : std::runtime_error( std::move( message ) ), code( std::move( value ) )
{
}
Result computeAlignment( const Request &request )
{
  const auto points = modelPoints( request );
  const auto before = rigid( request.placement );
  Matrix after      = before;
  Result result;
  if ( request.operation == Operation::MIN_CORNER ) {
    // Calculate from the unchanged geometry under the current rotation, without accumulating offsets.
    after.translation().setZero();
    after.translation() = -vector( bounds( points, after ).min );
  } else if ( request.operation == Operation::ROTATE ) {
    auto axis  = vector( request.axis );
    auto pivot = vector( request.pivot );
    if ( axis.norm() < 1e-12 || !std::isfinite( request.angle_degrees ) ||
         std::abs( request.angle_degrees ) > 360000 ) {
      throw AlignmentError( "INVALID_ARGUMENT", "Rotation requires a finite angle and nonzero axis." );
    }
    if ( request.model_space ) {
      axis  = before.linear() * axis;
      pivot = before * pivot;
    }
    const Eigen::AngleAxisd rotate( request.angle_degrees * std::numbers::pi / 180, axis.normalized() );
    after = Eigen::Translation3d( pivot ) * rotate * Eigen::Translation3d( -pivot ) * before;
  } else if ( request.operation == Operation::ALIGN_FRAME ) {
    std::optional<Features> features;
    const auto feature = [ & ]( const FeatureRef &ref ) {
      if ( !features ) {
        features.emplace( request );
      }
      result.used_references.push_back( ref );
      return features->get( ref );
    };
    const auto direction = [ & ]( const DirectionRef &ref ) -> Vec3 {
      Eigen::Vector3d value;
      if ( ref.kind == "model_axis" && ref.feature.object_id.empty() && ref.feature.feature_id.empty() ) {
        if ( ref.axis == "X" ) {
          value = Eigen::Vector3d::UnitX();
        } else if ( ref.axis == "Y" ) {
          value = Eigen::Vector3d::UnitY();
        } else if ( ref.axis == "Z" ) {
          value = Eigen::Vector3d::UnitZ();
        } else {
          throw AlignmentError( "INVALID_ARGUMENT", "Choose a model X/Y/Z axis." );
        }
      } else if ( ref.kind == "cad_feature" && ref.axis.empty() ) {
        const auto [ item, world ] = feature( ref.feature );
        if ( !item.contains( "direction" ) ) {
          throw AlignmentError( "INVALID_ARGUMENT", "Feature has no direction." );
        }
        value = world.linear() * vector( item.at( "direction" ).get<Vec3>() );
      } else {
        throw AlignmentError( "INVALID_ARGUMENT", "Invalid direction reference fields." );
      }
      if ( ref.reverse ) {
        value = -value;
      }
      return array( value );
    };
    Frame source;
    source.up      = direction( request.source_up );
    source.forward = direction( request.source_forward );
    if ( request.anchor == "reference" ) {
      if ( !request.source_origin ) {
        throw AlignmentError( "INVALID_ARGUMENT", "Reference alignment needs sourceOrigin." );
      }
      const auto &ref = *request.source_origin;
      if ( ref.kind == "model_point" && ref.position && ref.feature.object_id.empty() &&
           ref.feature.feature_id.empty() ) {
        source.origin = *ref.position;
      } else if ( ref.kind == "cad_feature" && !ref.position ) {
        const auto [ item, world ] = feature( ref.feature );
        source.origin              = array( world * vector( item.at( "origin" ).get<Vec3>() ) );
      } else {
        throw AlignmentError( "INVALID_ARGUMENT", "Invalid origin reference fields." );
      }
    } else if ( request.source_origin ) {
      throw AlignmentError( "INVALID_ARGUMENT", "Only reference anchors accept sourceOrigin." );
    }
    const auto source_basis = basis( source ), target_basis = basis( request.target );
    after          = Matrix::Identity();
    after.linear() = target_basis * source_basis.transpose();
    if ( request.anchor == "reference" ) {
      after.translation() = vector( request.target.origin ) - after.linear() * vector( source.origin );
    } else {
      if ( request.anchor != "min_corner" && request.anchor != "bottom_center" ) {
        throw AlignmentError( "INVALID_ARGUMENT", "Unknown alignment anchor." );
      }
      Matrix target_coordinates   = Matrix::Identity();
      target_coordinates.linear() = target_basis.transpose() * after.linear();
      const auto box              = bounds( points, target_coordinates );
      auto anchor                 = vector( box.min );
      if ( request.anchor == "bottom_center" ) {
        anchor.x() = ( box.min[ 0 ] + box.max[ 0 ] ) * 0.5;
        anchor.y() = ( box.min[ 1 ] + box.max[ 1 ] ) * 0.5;
      }
      after.translation() = vector( request.target.origin ) - target_basis * anchor;
    }
    result.source_frame = resolvedFrame( source, source_basis );
    result.target_frame = resolvedFrame( request.target, target_basis );
  }
  result.before = { request.placement, bounds( points, before ) };
  result.after  = { placement( after ), bounds( points, after ) };
  return result;
}
}  // namespace dai::alignment
