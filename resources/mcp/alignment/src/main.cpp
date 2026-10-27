#include "alignment/alignment.h"
#include "alignment/inspection.h"
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
    if ( operation == "scene_inspect" ) {
      std::cout << Json( {
                             { "ok", true },
                             { "data", inspectScene( request, args ) }
      } )
                       .dump()
                << '\n';
      return 0;
    } else if ( operation == "scene_get_features" ) {
      std::cout << Json( { { "ok", true }, { "data", inspectFeatures( request, args ) } } ).dump() << '\n';
      return 0;
    } else if ( operation == "scene_find_features" ) {
      std::cout << Json( { { "ok", true }, { "data", findFeatures( request, args ) } } ).dump() << '\n';
      return 0;
    } else if ( operation == "alignment_get_bounds" ) {
      request.object_id = args.value( "objectId", std::string() );
    } else if ( operation == "alignment_align_min_corner" ) {
      request.operation = Operation::MIN_CORNER;
    } else if ( operation == "alignment_rotate" ) {
      request.operation     = Operation::ROTATE;
      request.axis          = args.at( "axis" ).get<Vec3>();
      request.pivot         = args.at( "pivot" ).get<Vec3>();
      request.angle_degrees = args.at( "angleDegrees" );
      request.model_space   = args.at( "space" ) == "model";
    } else if ( operation == "alignment_align_direction" ) {
      request.operation        = Operation::ALIGN_DIRECTION;
      request.source_direction = direction( args.at( "sourceDirection" ) );
      request.target_direction = args.at( "targetDirection" ).get<Vec3>();
      const auto &pivot        = args.at( "pivot" );
      const auto kind          = pivot.at( "kind" ).get<std::string>();
      if ( kind == "bounds_center" && !pivot.contains( "position" ) ) {
        request.pivot_bounds_center = true;
      } else if ( kind == "world_point" && pivot.contains( "position" ) ) {
        request.pivot = pivot.at( "position" ).get<Vec3>();
      } else {
        throw AlignmentError( "INVALID_ARGUMENT", "Choose bounds_center or a world_point with position." );
      }
    } else if ( operation == "alignment_ground" ) {
      request.operation = Operation::GROUND;
      request.ground_z = args.at( "groundZ" ).get<double>();
      for ( const auto &contact : args.at( "contacts" ) ) request.contacts.push_back( feature( contact ) );
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
    if ( result.resolved_direction ) {
      const auto &value           = *result.resolved_direction;
      data[ "resolvedDirection" ] = {
          {"source",       value.source       },
          {"target",       value.target       },
          {"axis",         value.axis         },
          {"angleDegrees", value.angle_degrees},
          {"pivot",        value.pivot        }
      };
      data[ "usedReferences" ] = Json::array();
      for ( const auto &ref : result.used_references ) {
        data[ "usedReferences" ].push_back( {
            {"objectId",  ref.object_id },
            {"featureId", ref.feature_id}
        } );
      }
    }
    if ( !result.ground_contacts.empty() ) {
      data[ "groundContacts" ] = Json::array();
      for ( const auto &contact : result.ground_contacts ) {
        data[ "groundContacts" ].push_back( { { "objectId", contact.feature.object_id },
                                              { "featureId", contact.feature.feature_id },
                                              { "beforeZ", contact.before_z }, { "afterZ", contact.after_z } } );
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
