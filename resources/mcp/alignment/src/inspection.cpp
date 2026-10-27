#include "alignment/inspection.h"
#include <algorithm>
#include <fstream>
#include <map>
#include <set>
#include <nlohmann/json.hpp>

namespace dai::alignment
{
using Json = nlohmann::json;

namespace
{
Json bounds( Request request, const std::string &object_id = {} )
{
  request.object_id = object_id;
  try {
    const auto result = computeAlignment( request );
    return {
        {"min", result.before.bounds.min},
        {"max", result.before.bounds.max}
    };
  } catch ( const AlignmentError &error ) {
    return {
        { "error", error.what() }
    };
  }
}
}  // namespace

Json inspectScene( const Request &request, const Json &arguments )
{
  std::ifstream manifest_stream( request.manifest_path );
  if ( !manifest_stream ) {
    throw AlignmentError( "INVALID_RESOURCE", "Cannot read saved manifest." );
  }
  const auto manifest = Json::parse( manifest_stream );
  const auto &all     = manifest.at( "objects" );
  const auto selected = arguments.value( "objectIds", std::vector<std::string>{} );
  const std::set<std::string> selected_ids( selected.begin(), selected.end() );
  for ( const auto &id : selected_ids ) {
    if ( std::none_of( all.begin(), all.end(), [ & ]( const auto &item ) { return item.at( "objectId" ) == id; } ) ) {
      throw AlignmentError( "OBJECT_NOT_FOUND", "The requested object is not in the saved scene." );
    }
  }

  std::map<std::string, Json> features;
  if ( !selected.empty() && !request.features_path.empty() ) {
    std::ifstream input( request.features_path );
    if ( !input ) {
      throw AlignmentError( "INVALID_RESOURCE", "Cannot read cached features." );
    }
    std::string line;
    while ( std::getline( input, line ) ) {
      if ( line.size() > 16384 ) {
        throw AlignmentError( "INVALID_RESOURCE", "Invalid cached feature." );
      }
      const auto item = Json::parse( line );
      const auto id   = item.value( "objectId", std::string() );
      if ( !selected_ids.contains( id ) ) {
        continue;
      }
      auto &items = features[ id ];
      if ( items.is_null() ) {
        items = Json::array();
      }
      if ( items.size() < 5 ) {
        items.push_back( item );
      }
    }
  }

  std::map<std::string, Json> feature_index;
  if ( manifest.contains( "features" ) ) {
    for ( const auto &item : manifest.at( "features" ).at( "objects" ) ) {
      feature_index.emplace( item.at( "objectId" ).get<std::string>(), item );
    }
  }
  const auto offset = arguments.value( "offset", std::size_t{ 0 } );
  const auto limit  = arguments.value( "limit", std::size_t{ 20 } );
  const bool lowest = arguments.value( "order", std::string() ) == "lowest";
  if ( lowest && !selected.empty() ) {
    throw AlignmentError( "INVALID_ARGUMENT", "Choose either selected objects or lowest order." );
  }
  const auto object_bounds = lowest ? computeObjectBounds( request ) : std::map<std::string, Bounds>{};
  std::vector<std::size_t> order;
  for ( std::size_t i = 0; i < all.size(); ++i ) {
    if ( !lowest || object_bounds.contains( all.at( i ).at( "objectId" ).get<std::string>() ) ) order.push_back( i );
  }
  if ( lowest ) {
    std::stable_sort( order.begin(), order.end(), [ & ]( std::size_t a, std::size_t b ) {
      return object_bounds.at( all.at( a ).at( "objectId" ).get<std::string>() ).min[ 2 ] <
             object_bounds.at( all.at( b ).at( "objectId" ).get<std::string>() ).min[ 2 ];
    } );
  }
  Json objects      = Json::array();
  for ( std::size_t i = 0; i < order.size(); ++i ) {
    const auto &item = all.at( order[ i ] );
    const auto id    = item.at( "objectId" ).get<std::string>();
    if ( selected.empty() ? ( i < offset || i - offset >= limit ) : !selected_ids.contains( id ) ) {
      continue;
    }
    Json object{
        {"objectId", id               },
        {"name",     item.at( "name" )},
        {"kind",     item.at( "kind" )}
    };
    if ( item.contains( "parentObjectId" ) ) {
      object[ "parentObjectId" ] = item.at( "parentObjectId" );
    }
    if ( lowest ) {
      const auto &box = object_bounds.at( id );
      object[ "bounds" ] = { { "min", box.min }, { "max", box.max } };
    }
    if ( !selected.empty() ) {
      object[ "localTransform" ]   = item.at( "localTransform" );
      object[ "bounds" ]           = bounds( request, id );
      object[ "features" ]         = features.contains( id ) ? features.at( id ) : Json::array();
      const auto it                = feature_index.find( id );
      object[ "featureCount" ]     = it == feature_index.end() ? 0 : it->second.at( "count" ).get<std::size_t>();
      object[ "featuresComplete" ] = it != feature_index.end() && it->second.at( "analysisComplete" ).get<bool>();
      if ( it != feature_index.end() ) {
        object[ "featureStartLine" ] = it->second.at( "startLine" );
      }
    }
    objects.push_back( std::move( object ) );
  }
  Json result{
      {"unit",             "m"                              },
      {"coordinateSystem", manifest.at( "coordinateSystem" )},
      {"bounds",           bounds( request )                },
      {"objectCount",      all.size()                       },
      {"objects",          std::move( objects )             },
      {"complete",         manifest.at( "complete" )        },
      {"warnings",         manifest.at( "warnings" )        },
      {"featureNote",
       "Features are object-local CAD references; bounds are world display-mesh bounds. The first five cached "
        "features per selected object are shown, not a ranked selection. Read the feature range from "
        "scene-context.files.features for more."            }
  };
  if ( selected.empty() && offset < order.size() && limit < order.size() - offset ) {
    result[ "nextOffset" ] = offset + limit;
  }
  return result;
}
}  // namespace dai::alignment
