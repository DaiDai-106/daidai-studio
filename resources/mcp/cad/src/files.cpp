#include "cad/files.h"
#include <fstream>
#include <algorithm>
#include <cctype>
#include <iomanip>
#include <memory>
#include <sstream>
#include <openssl/evp.h>

namespace dai::cad
{
namespace fs = std::filesystem;
std::filesystem::path utf8Path( const std::string &value )
{
  return std::filesystem::path( std::u8string( value.begin(), value.end() ) );
}
std::string utf8String( const std::filesystem::path &value )
{
  const auto bytes = value.generic_u8string();
  return { bytes.begin(), bytes.end() };
}

namespace
{
bool within( const fs::path &path, const fs::path &root )
{
  const auto relative = path.lexically_relative( root );
  return !relative.empty() && !relative.is_absolute() && *relative.begin() != "..";
}

std::string hashFile( const fs::path &path, const WorkContext &work, std::uint64_t byte_limit )
{
  std::ifstream input( path, std::ios::binary );
  if ( !input ) {
    fail( "IO_ERROR", "Cannot read CAD file." );
  }
  const auto digest = std::unique_ptr<EVP_MD_CTX, decltype( &EVP_MD_CTX_free )>( EVP_MD_CTX_new(), EVP_MD_CTX_free );
  if ( !digest || EVP_DigestInit_ex( digest.get(), EVP_sha256(), nullptr ) != 1 ) {
    fail( "IO_ERROR", "Cannot initialize SHA-256." );
  }
  std::array<char, 65536> bytes{};
  std::uint64_t total = 0;
  while ( input ) {
    work.check();
    input.read( bytes.data(), bytes.size() );
    const auto size = input.gcount();
    total += static_cast<std::uint64_t>( size );
    if ( total > byte_limit ) {
      fail( "LIMIT_EXCEEDED", "File exceeds hashing budget." );
    }
    if ( EVP_DigestUpdate( digest.get(), bytes.data(), size ) != 1 ) {
      fail( "IO_ERROR", "Cannot hash file." );
    }
  }
  if ( !input.eof() ) {
    fail( "IO_ERROR", "Cannot finish reading file." );
  }
  std::array<unsigned char, EVP_MAX_MD_SIZE> output{};
  unsigned int size = 0;
  if ( EVP_DigestFinal_ex( digest.get(), output.data(), &size ) != 1 ) {
    fail( "IO_ERROR", "Cannot finalize hash." );
  }
  std::ostringstream result;
  result << std::hex << std::setfill( '0' );
  for ( unsigned int i = 0; i < size; ++i ) {
    result << std::setw( 2 ) << static_cast<unsigned>( output[ i ] );
  }
  return result.str();
}

}  // namespace

std::string fileHash( const fs::path &path, const WorkContext &work )
{
  return hashFile( path, work, work.limits.max_file_bytes );
}

fs::path snapshotSource( const ServerContext &server, SourceVersion &source, const fs::path &job_directory,
                         const WorkContext &work )
{
  work.report( "verify_source" );
  const auto requested = utf8Path( source.path );
  if ( !requested.is_absolute() || source.path.find( '\0' ) != std::string::npos ) {
    fail( "INVALID_ARGUMENT", "STEP path must be absolute." );
  }
  if ( server.project_root.empty() ) {
    fail( "PATH_OUTSIDE_PROJECT", "No source directory is authorized." );
  }
  const auto path = fs::canonical( requested );
  if ( !within( path, server.project_root ) ) {
    fail( "PATH_OUTSIDE_PROJECT", "STEP is outside the allowed directory." );
  }
  auto partial = server.project_root;
  for ( const auto &part : requested.lexically_relative( server.project_root ) ) {
    if ( part == ".." ) {
      fail( "PATH_OUTSIDE_PROJECT", "STEP path cannot traverse a parent directory." );
    }
    partial /= part;
    if ( fs::is_symlink( fs::symlink_status( partial ) ) ) {
      fail( "PATH_OUTSIDE_PROJECT", "STEP path cannot contain symbolic links." );
    }
  }
  auto extension = path.extension().string();
  std::transform( extension.begin(), extension.end(), extension.begin(),
                  []( unsigned char c ) { return std::tolower( c ); } );
  if ( extension != ".step" && extension != ".stp" ) {
    fail( "INVALID_ARGUMENT", "Expected a STEP file." );
  }
  if ( !fs::is_regular_file( path ) ) {
    fail( "INVALID_ARGUMENT", "STEP must be a regular file." );
  }
  if ( fs::file_size( path ) > work.limits.max_file_bytes ) {
    fail( "LIMIT_EXCEEDED", "STEP file is too large." );
  }
  fs::create_directory( job_directory );
  const auto snapshot = job_directory / "source.step";
  std::ifstream input( path, std::ios::binary );
  std::ofstream output( snapshot, std::ios::binary | std::ios::trunc );
  if ( !input || !output ) {
    fail( "IO_ERROR", "Cannot create STEP snapshot." );
  }
  std::array<char, 65536> buffer{};
  std::uint64_t total = 0;
  while ( input ) {
    work.check();
    input.read( buffer.data(), buffer.size() );
    const auto size = input.gcount();
    total += static_cast<std::uint64_t>( size );
    if ( total > work.limits.max_file_bytes ) {
      fail( "LIMIT_EXCEEDED", "STEP grew beyond the file limit." );
    }
    output.write( buffer.data(), size );
  }
  output.close();
  if ( !input.eof() || !output ) {
    fail( "IO_ERROR", "Cannot finish STEP snapshot." );
  }
  source.source_hash = fileHash( snapshot, work );
  if ( fs::canonical( requested ) != path || fileHash( path, work ) != source.source_hash ) {
    fail( "SOURCE_CHANGED", "STEP changed; refresh and select the current version." );
  }
  source.path = utf8String( path );
  return snapshot;
}

ResourceRef describeResource( const ServerContext &server, const fs::path &path, const std::string &media_type,
                              const WorkContext &work )
{
  const auto canonical = fs::canonical( path );
  if ( !within( canonical, server.output_root ) ) {
    fail( "IO_ERROR", "Resource escaped staging root." );
  }
  const auto size = fs::file_size( canonical );
  if ( size > work.limits.max_resource_bytes ) {
    fail( "LIMIT_EXCEEDED", "CAD resource is too large." );
  }
  auto text = utf8String( canonical );
  if ( !text.starts_with( '/' ) ) {
    text.insert( text.begin(), '/' );
  }
  std::ostringstream uri;
  uri << ( text.starts_with( "//" ) ? "file:" : "file://" ) << std::uppercase << std::hex;
  for ( const unsigned char c : text ) {
    if ( std::isalnum( c ) || c == '/' || c == ':' || c == '-' || c == '_' || c == '.' || c == '~' ) {
      uri << c;
    } else {
      uri << '%' << std::setw( 2 ) << std::setfill( '0' ) << static_cast<unsigned>( c );
    }
  }
  return { uri.str(), media_type, size, hashFile( canonical, work, work.limits.max_resource_bytes ) };
}

void writeJson( const fs::path &path, const Json &value, const WorkContext &work )
{
  work.check();
  const auto bytes = value.dump();
  if ( bytes.size() > work.limits.max_resource_bytes ) {
    fail( "LIMIT_EXCEEDED", "CAD metadata is too large." );
  }
  std::ofstream output( path, std::ios::binary | std::ios::trunc );
  output.write( bytes.data(), bytes.size() );
  output.close();
  if ( !output ) {
    fail( "IO_ERROR", "Cannot publish CAD metadata." );
  }
}

Json readJson( const fs::path &path, std::uint64_t max_bytes )
{
  if ( !fs::is_regular_file( path ) || fs::file_size( path ) > max_bytes ) {
    fail( "INVALID_ARGUMENT", "Missing or oversized CAD configuration." );
  }
  std::ifstream input( path, std::ios::binary );
  return Json::parse( input );
}
}  // namespace dai::cad
