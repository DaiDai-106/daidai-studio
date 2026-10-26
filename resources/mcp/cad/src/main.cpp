#include "cad/service.h"
#include "cad/files.h"
#include <array>
#include <iostream>
#include <mutex>
#include <Message.hxx>
#include <Message_Messenger.hxx>
#include <Message_PrinterOStream.hxx>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace dai::cad
{
namespace
{
ServerContext readContext( const std::filesystem::path &config_path )
{
  const auto config = readJson( config_path, 32768 );
  ServerContext context;
  context.server_instance_id = newId();
  if ( config.contains( "projectRoot" ) ) {
    context.project_root = std::filesystem::canonical( utf8Path( config.at( "projectRoot" ) ) );
  }
  context.staging_root = std::filesystem::canonical( utf8Path( config.at( "stagingRoot" ) ) );
  context.output_root  = std::filesystem::canonical( utf8Path( config.at( "outputRoot" ) ) );
  if ( ( !context.project_root.empty() && !std::filesystem::is_directory( context.project_root ) ) ||
       !std::filesystem::is_directory( context.staging_root ) || context.project_root == context.staging_root ) {
    fail( "INVALID_ARGUMENT", "Invalid CAD project or staging root." );
  }
  if ( config.contains( "limits" ) ) {
    const auto &limits = config.at( "limits" );
    auto &value        = context.limits;
    const auto lower   = [ & ]( const char *key, auto &field ) {
      if ( limits.contains( key ) ) {
        const auto candidate = limits.at( key ).get<std::uint64_t>();
        if ( candidate == 0 || candidate > field ) {
          fail( "INVALID_ARGUMENT", "CAD limits can only narrow defaults." );
        }
        field = candidate;
      }
    };
    lower( "maxFileBytes", value.max_file_bytes );
    lower( "maxObjects", value.max_objects );
    lower( "maxTriangles", value.max_triangles );
    lower( "maxResourceBytes", value.max_resource_bytes );
    lower( "maxTotalResourceBytes", value.max_total_resource_bytes );
    lower( "maxRetainedJobs", value.max_retained_jobs );
    lower( "jobTimeoutMs", value.job_timeout_ms );
    lower( "queryTimeoutMs", value.query_timeout_ms );
  }
  return context;
}
int run( const std::vector<std::filesystem::path> &arguments )
{
  if ( arguments.size() != 3 || arguments[ 1 ] != "--config" ) {
    std::cerr << "Usage: dai-cad-worker --config <config.json>\n";
    return 1;
  }
#ifdef _WIN32
  _setmode( _fileno( stdin ), _O_BINARY );
  _setmode( _fileno( stdout ), _O_BINARY );
#endif
  Message::DefaultMessenger()->ChangePrinters().Clear();
  Handle( Message_PrinterOStream ) printer = new Message_PrinterOStream( "cerr", false, Message_Warning );
  printer->SetToColorize( false );
  Message::DefaultMessenger()->AddPrinter( printer );
  const auto context = readContext( arguments[ 2 ] );
  std::mutex output_mutex;
  CadService service( context );
  // Private IPC, not a second MCP/JSON-RPC implementation. One bounded JSON frame per line.
  std::array<char, 65536> buffer{};
  while ( std::cin.getline( buffer.data(), buffer.size() ) ) {
    if ( !*buffer.data() ) {
      continue;
    }
    const auto request = Json::parse( buffer.data() );
    if ( request.contains( "cancelRequestId" ) ) {
      service.cancelRequest( request.at( "cancelRequestId" ) );
      continue;
    }
    const auto id = request.at( "requestId" ).get<std::string>();
    service.call( id, request.at( "tool" ), request.at( "input" ), [ &, id ]( Json result ) {
      if ( result.dump().size() > context.limits.max_output_bytes ) {
        result = {
            {"ok",    false                                                                                     },
            {"error", { { "code", "LIMIT_EXCEEDED" }, { "message", "CAD response exceeds the output budget." } }}
        };
      }
      const auto line =
          Json{
              {"requestId", id                 },
              {"result",    std::move( result )}
      }
              .dump();
      std::lock_guard lock( output_mutex );
      std::cout << line << '\n' << std::flush;
    } );
  }
  if ( !std::cin.eof() ) {
    std::cerr << "Invalid or oversized CAD worker input.\n";
    return 1;
  }
  return 0;
}
}  // namespace
}  // namespace dai::cad

#ifdef _WIN32
int wmain( int argc, wchar_t **argv )
#else
int main( int argc, char **argv )
#endif
{
  try {
    std::vector<std::filesystem::path> arguments;
    for ( int i = 0; i < argc; ++i ) {
      arguments.emplace_back( argv[ i ] );
    }
    return dai::cad::run( arguments );
  } catch ( const std::exception & ) {
    std::cerr << "CAD worker startup or IPC failed.\n";
    return 1;
  }
}
