#include "alignment/alignment.h"
#include <iostream>
#include <nlohmann/json.hpp>

namespace
{
using namespace dai::alignment;
using Json = nlohmann::json;
std::filesystem::path path( const Json &value )
{
  const auto text = value.get<std::string>();
  return std::filesystem::path( std::u8string( text.begin(), text.end() ) );
}
Placement placement( const Json &value )
{
  return { value.at( "translation" ).get<Vec3>(), value.at( "rotation" ).get<Quaternion>() };
}
Frame frame( const Json &value )
{
  return { value.at( "origin" ).get<Vec3>(), value.at( "up" ).get<Vec3>(), value.at( "forward" ).get<Vec3>() };
}
FeatureRef feature( const Json &value )
{
  return { value.value( "objectId", std::string() ), value.value( "featureId", std::string() ) };
}
DirectionRef direction( const Json &value )
{
  return { value.at( "kind" ), value.value( "axis", std::string() ), feature( value ),
           value.value( "reverse", false ) };
}
Json json( const Placement &value )
{
  return {
      {"translation", value.translation},
      {"rotation",    value.rotation   }
  };
}
Json json( const Bounds &value )
{
  return {
      {"min", value.min},
      {"max", value.max}
  };
}
Json json( const Snapshot &value )
{
  return {
      {"placement", json( value.placement )},
      {"bounds",    json( value.bounds )   }
  };
}
Json json( const Frame &value )
{
  return {
      {"origin",  value.origin },
      {"up",      value.up     },
      {"forward", value.forward}
  };
}
}  // namespace
int main()
{
  try {
    std::string line;
    if ( !std::getline( std::cin, line ) || line.size() > 16384 ) {
      throw AlignmentError( "INVALID_ARGUMENT", "Invalid native request." );
    }
    const auto input = Json::parse( line );
    Request request;
    request.glb_path      = path( input.at( "glbPath" ) );
    request.manifest_path = path( input.at( "manifestPath" ) );
    if ( input.contains( "featuresPath" ) ) {
      request.features_path = path( input.at( "featuresPath" ) );
    }
    const auto &display                  = input.at( "displayToScene" );
    request.display_to_scene.translation = display.at( "translation" ).get<Vec3>();
    request.display_to_scene.rotation    = display.at( "rotation" ).get<Quaternion>();
    request.display_to_scene.scale       = display.at( "scale" ).get<Vec3>();
    request.placement                    = placement( input.at( "placement" ) );
    const auto &args                     = input.at( "arguments" );
    const auto operation                 = input.at( "operation" ).get<std::string>();
    if ( operation == "alignment_get_bounds" ) {
      request.object_id = args.value( "objectId", std::string() );
    } else if ( operation == "alignment_align_min_corner" ) {
      request.operation = Operation::MIN_CORNER;
    } else if ( operation == "alignment_rotate" ) {
      request.operation     = Operation::ROTATE;
      request.axis          = args.at( "axis" ).get<Vec3>();
      request.pivot         = args.at( "pivot" ).get<Vec3>();
      request.angle_degrees = args.at( "angleDegrees" );
      request.model_space   = args.at( "space" ) == "model";
    } else if ( operation == "alignment_align_frame" ) {
      request.operation      = Operation::ALIGN_FRAME;
      request.source_up      = direction( args.at( "sourceUp" ) );
      request.source_forward = direction( args.at( "sourceForward" ) );
      request.anchor         = args.at( "anchor" );
      request.target         = frame( args.at( "target" ) );
      if ( args.contains( "sourceOrigin" ) ) {
        const auto &origin = args.at( "sourceOrigin" );
        PointRef point{ origin.at( "kind" ), {}, feature( origin ) };
        if ( origin.contains( "position" ) ) {
          point.position = origin.at( "position" ).get<Vec3>();
        }
        request.source_origin = point;
      }
    } else {
      throw AlignmentError( "INVALID_ARGUMENT", "Unknown alignment operation." );
    }
    const auto result = computeAlignment( request );
    Json data{
        {"before", json( result.before )},
        {"after",  json( result.after ) }
    };
    if ( result.source_frame ) {
      data[ "resolvedSourceFrame" ] = json( *result.source_frame );
      data[ "resolvedTargetFrame" ] = json( *result.target_frame );
      data[ "usedReferences" ]      = Json::array();
      for ( const auto &ref : result.used_references ) {
        data[ "usedReferences" ].push_back( {
            {"objectId",  ref.object_id },
            {"featureId", ref.feature_id}
        } );
      }
    }
    std::cout << Json( {
                           {"ok",   true},
                           {"data", data}
    } )
                     .dump()
              << '\n';
  } catch ( const AlignmentError &error ) {
    std::cout << Json( {
                           {"ok",    false                                                  },
                           {"error", { { "code", error.code }, { "message", error.what() } }}
    } )
                     .dump()
              << '\n';
  } catch ( const std::exception & ) {
    std::cout << Json( {
                           {"ok",    false                                               },
                           {"error",
                            { { "code", "INVALID_RESOURCE" },
                               { "message", "Invalid or unsupported alignment input." } }}
    } )
                     .dump()
              << '\n';
  }
}
