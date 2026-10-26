#include "cad/types.h"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <memory>
#include <sstream>
#include <openssl/evp.h>
#include <openssl/rand.h>

namespace dai::cad
{
namespace
{
constexpr auto importer_version = "dai-cad-3";
}
CadFailure::CadFailure( CadError error ) : std::runtime_error( error.message ), error_( std::move( error ) ) {}
const CadError &CadFailure::error() const noexcept
{
  return error_;
}
void fail( std::string code, std::string message )
{
  throw CadFailure( { std::move( code ), std::move( message ), {}, {} } );
}

void WorkContext::check() const
{
  if ( stop.stop_requested() ) {
    fail( "CANCELLED", "CAD operation cancelled." );
  }
  if ( std::chrono::steady_clock::now() >= deadline ) {
    fail( "TIMEOUT", "CAD operation timed out." );
  }
}
void WorkContext::report( std::string phase, std::optional<double> fraction ) const
{
  check();
  if ( on_progress ) {
    on_progress( std::move( phase ), fraction );
  }
}
QualityProfile qualityProfile( const std::string &quality )
{
  if ( quality == "preview" ) {
    return { 0.001, 0.5 };
  }
  if ( quality == "standard" ) {
    return { 0.0003, 0.3 };
  }
  if ( quality == "fine" ) {
    return { 0.0001, 0.15 };
  }
  fail( "INVALID_ARGUMENT", "Unknown display quality." );
}
Json capabilities( const ServerContext &context )
{
  Json profiles = Json::object();
  for ( const auto *name : { "preview", "standard", "fine" } ) {
    const auto profile = qualityProfile( name );
    profiles[ name ]   = {
        {"linearDeflectionM",    profile.linear_deflection_m   },
        {"angularDeflectionRad", profile.angular_deflection_rad}
    };
  }
  return {
      {"contractVersion",       2                                             },
      {"artifactSchemaVersion", 1                                             },
      {"serverInstanceId",      context.server_instance_id                    },
      {"parser",                { { "name", "OCCT" }, { "version", "7.9.2" } }},
      {"importerVersion",       importer_version                              },
      {"supportedFormats",      { "step", "stp" }                             },
      {"limits",                toJson( context.limits )                      },
      {"features",
       { { "hierarchy", true },
          { "instances", true },
          { "sourceColors", true },
          { "exactFeatures", { "plane_center", "circle_center", "cylinder_axis", "edge_midpoint", "vertex" } },
          { "faceMapping", true },
          { "cancellationGranularity", "cooperative; process termination fallback" },
          { "qualityProfiles", profiles } }                                   }
  };
}
namespace
{
std::string hexString( const unsigned char *bytes, std::size_t size )
{
  std::ostringstream output;
  output << std::hex << std::setfill( '0' );
  for ( std::size_t i = 0; i < size; ++i ) {
    output << std::setw( 2 ) << static_cast<unsigned>( bytes[ i ] );
  }
  return output.str();
}
}  // namespace
std::string newId()
{
  std::array<unsigned char, 16> bytes{};
  if ( RAND_bytes( bytes.data(), bytes.size() ) != 1 ) {
    fail( "IO_ERROR", "Cannot generate a CAD handle." );
  }
  return hexString( bytes.data(), bytes.size() );
}
std::string sha256( const std::string &bytes )
{
  std::array<unsigned char, EVP_MAX_MD_SIZE> output{};
  unsigned int size = 0;
  if ( EVP_Digest( bytes.data(), bytes.size(), output.data(), &size, EVP_sha256(), nullptr ) != 1 ) {
    fail( "IO_ERROR", "Cannot hash CAD data." );
  }
  return hexString( output.data(), size );
}
std::string importFingerprint( const std::optional<std::string> &unit_override )
{
  return sha256( Json{
      {"occt",         "7.9.2"                           },
      {"importer",     importer_version                  },
      {"unitOverride", unit_override.value_or( "source" )}
  }
                     .dump() );
}
}  // namespace dai::cad
