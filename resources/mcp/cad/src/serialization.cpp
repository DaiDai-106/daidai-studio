#include "cad/serialization.h"
#include <Standard_Failure.hxx>
#include <utility>

namespace dai::cad
{
Json toJson( const SourceVersion &value )
{
  return {
      {"path",              value.path              },
      {"sourceHash",        value.source_hash       },
      {"importFingerprint", value.import_fingerprint},
      {"sourceLengthUnits", value.length_units      }
  };
}
Json toJson( const ImportResult &value )
{
  return {
      {"document",         toJson( value.document )},
      {"source",           toJson( value.source )  },
      {"outputLengthUnit", "m"                     },
      {"objectCount",      value.object_count      },
      {"rootObjectCount",  value.root_object_count },
      {"warnings",         value.warnings          }
  };
}
Json toJson( const ResourceRef &value )
{
  return {
      {"uri",        value.uri        },
      {"mediaType",  value.media_type },
      {"byteLength", value.byte_length},
      {"sha256",     value.sha256     }
  };
}
Json toJson( const DisplayResult &value )
{
  const auto &summary = value.summary;
  return {
      {"manifest", toJson( value.manifest )                   },
      {"summary",
       { { "source", toJson( summary.source ) },
          { "complete", summary.complete },
          { "objectCount", summary.object_count },
          { "geometryCount", summary.geometry_count },
          { "triangleCount", summary.triangle_count },
          { "warningCount", summary.warning_count },
          { "omittedFaceCount", summary.omitted_face_count } }}
  };
}
Json toJson( const Transform &v )
{
  return {
      {"translation", v.translation},
      {"rotation",    v.rotation   },
      {"scale",       v.scale      }
  };
}
Json toJson( const CadHandle &v )
{
  return {
      {"serverInstanceId", v.server_instance_id},
      {"id",               v.id                }
  };
}
Json toJson( const CadError &v )
{
  Json result{
      {"code",    v.code   },
      {"message", v.message}
  };
  if ( v.object_id ) {
    result[ "objectId" ] = *v.object_id;
  }
  if ( v.topology_ref ) {
    result[ "topologyRef" ] = {
        {"kind", v.topology_ref->kind},
        {"id",   v.topology_ref->id  }
    };
  }
  return result;
}
Json toJson( const CadObject &v )
{
  Json result{
      {"objectId",       v.id                                        },
      {"sourceKey",      v.source_key                                },
      {"name",           v.name                                      },
      {"kind",           v.geometry_id.empty() ? "assembly" : "shape"},
      {"localTransform", toJson( v.local_transform )                 },
      {"childCount",     v.children.size()                           }
  };
  if ( !v.parent_id.empty() ) {
    result[ "parentObjectId" ] = v.parent_id;
  }
  if ( !v.geometry_id.empty() ) {
    result[ "geometryId" ] = v.geometry_id;
  }
  return result;
}
Json toJson( const Limits &v )
{
  return {
      {"maxFileBytes",          v.max_file_bytes          },
      {"maxObjects",            v.max_objects             },
      {"maxQueryItems",         200                       },
      {"maxPageBytes",          v.max_page_bytes          },
      {"maxOutputBytes",        v.max_output_bytes        },
      {"maxTriangles",          v.max_triangles           },
      {"maxResourceBytes",      v.max_resource_bytes      },
      {"maxTotalResourceBytes", v.max_total_resource_bytes},
      {"maxRetainedJobs",       v.max_retained_jobs       },
      {"maxActiveDocuments",    1                         },
      {"maxActiveJobs",         1                         },
      {"jobTimeoutMs",          v.job_timeout_ms          },
      {"queryTimeoutMs",        v.query_timeout_ms        }
  };
}

namespace
{
template <typename T>
Json propertyJson( const PropertyValue<T> &value )
{
  if ( const auto *missing = std::get_if<PropertyUnavailable>( &value ) ) {
    return {
        {"status", "unavailable"  },
        {"reason", missing->reason}
    };
  }
  return {
      {"status", "exact"                       },
      {"value",  toJson( std::get<T>( value ) )}
  };
}
Json propertyJson( const PropertyValue<GeometryMeasures> &value )
{
  if ( const auto *missing = std::get_if<PropertyUnavailable>( &value ) ) {
    return {
        {"status", "unavailable"  },
        {"reason", missing->reason}
    };
  }
  return toJson( std::get<GeometryMeasures>( value ) );
}
template <typename T>
Json pageJson( const std::vector<T> &items )
{
  Json result = Json::array();
  for ( const auto &item : items ) {
    result.push_back( toJson( item ) );
  }
  return {
      { "items", std::move( result ) }
  };
}
}  // namespace

Json toJson( const ObjectBounds &value )
{
  return {
      {"min",   value.min},
      {"max",   value.max},
      {"unit",  "m"      },
      {"space", "object" }
  };
}
Json toJson( const TopologyCounts &value )
{
  return {
      {"vertexCount", value.vertex_count},
      {"edgeCount",   value.edge_count  },
      {"faceCount",   value.face_count  },
      {"shellCount",  value.shell_count },
      {"solidCount",  value.solid_count }
  };
}
Json toJson( const SourceAppearance &value )
{
  Json result{
      {"hasFaceColors",  value.face_color_count > 0},
      {"faceColorCount", value.face_color_count    }
  };
  if ( value.object_color ) {
    result[ "objectColor" ] = *value.object_color;
  }
  return result;
}
Json toJson( const ObjectProperties &value )
{
  Json result{
      { "objectId", value.object_id }
  };
  if ( value.bounds ) {
    result[ "bounds" ] = propertyJson( *value.bounds );
  }
  if ( value.topology ) {
    result[ "topology" ] = propertyJson( *value.topology );
  }
  if ( value.appearance ) {
    result[ "appearance" ] = propertyJson( *value.appearance );
  }
  if ( value.validity ) {
    result[ "validity" ] = propertyJson( *value.validity );
  }
  if ( value.measures ) {
    result[ "measures" ] = propertyJson( *value.measures );
  }
  return result;
}
Json toJson( const GeometryFeature &value )
{
  Json result{
      {"featureId",   value.id                                                                },
      {"objectId",    value.object_id                                                         },
      {"type",        value.type                                                              },
      {"provenance",  "cad"                                                                   },
      {"origin",      value.origin                                                            },
      {"topologyRef", { { "kind", value.topology_ref.kind }, { "id", value.topology_ref.id } }}
  };
  if ( value.direction ) {
    result[ "direction" ] = *value.direction;
  }
  if ( value.radius ) {
    result[ "radius" ] = *value.radius;
  }
  return result;
}
Json toJson( const StructurePage &value )
{
  auto result = pageJson( value.items );
  if ( value.next_cursor ) {
    result[ "nextCursor" ] = *value.next_cursor;
  }
  return result;
}
Json toJson( const PropertiesPage &value )
{
  return pageJson( value.items );
}
Json toJson( const FeaturePage &value )
{
  auto result = pageJson( value.items );
  if ( value.next_cursor ) {
    result[ "nextCursor" ] = *value.next_cursor;
  }
  result[ "analysisComplete" ] = value.analysis_complete;
  result[ "warnings" ]         = value.warnings;
  return result;
}
Json success( Json data )
{
  return {
      {"ok",   true             },
      {"data", std::move( data )}
  };
}
Json failure( const CadError &error )
{
  return {
      {"ok",    false          },
      {"error", toJson( error )}
  };
}
DistanceObject distanceObject( const Json &value )
{
  const auto &placement = value.at( "placement" );
  return {
      value.at( "objectId" ),
      { placement.at( "translation" ).get<Vec3>(), placement.at( "rotation" ).get<std::array<double, 4>>(),
                         placement.at( "scale" ).get<Vec3>() }
  };
}
CadError currentError()
{
  try {
    throw;
  } catch ( const CadFailure &error ) {
    return error.error();
  } catch ( const Json::exception & ) {
    return { "INVALID_ARGUMENT", "Invalid CAD request fields.", {}, {} };
  } catch ( const std::filesystem::filesystem_error & ) {
    return { "IO_ERROR", "CAD file operation failed.", {}, {} };
  } catch ( const Standard_Failure & ) {
    return { "PARSE_FAILED", "OCCT geometry operation failed.", {}, {} };
  } catch ( const std::bad_alloc & ) {
    return { "LIMIT_EXCEEDED", "CAD memory allocation failed.", {}, {} };
  } catch ( const std::exception & ) {
    return { "IO_ERROR", "CAD operation failed.", {}, {} };
  } catch ( ... ) {
    return { "IO_ERROR", "Unexpected CAD operation failure.", {}, {} };
  }
}

ImportRequest importRequest( const Json &input )
{
  ImportRequest result{ input.at( "path" ), {} };
  if ( input.contains( "options" ) && input.at( "options" ).contains( "sourceUnitOverride" ) ) {
    result.unit_override = input.at( "options" ).at( "sourceUnitOverride" );
  }
  return result;
}
PageQuery pageQuery( const Json &input )
{
  return { input.value( "cursor", "" ), input.value( "limit", 50U ) };
}
}  // namespace dai::cad
