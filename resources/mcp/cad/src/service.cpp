#include "cad/geometry.h"
#include "cad/service.h"
#include "cad/display.h"
#include "cad/files.h"
#include "cad/queries.h"
#include "cad/step_reader.h"
#include "cad/jobs.h"
#include "cad/serialization.h"
#include <condition_variable>
#include <iostream>
#include <map>
#include <mutex>
#include <thread>

namespace dai::cad
{

struct CadService::Impl {
  explicit Impl( ServerContext value )
      : context( std::move( value ) ), worker( [ this ]( std::stop_token stop ) { run( stop ); } )
  {
  }
  ~Impl()
  {
    {
      std::lock_guard lock( mutex );
      closing = true;
      current_stop.request_stop();
    }
    worker.request_stop();
    changed.notify_all();
    worker.join();
    cleanStaging();
  }
  ServerContext context;
  std::mutex mutex;
  std::condition_variable_any changed;
  bool closing = false;
  bool busy    = false;
  std::string current_request;
  std::stop_source current_stop;
  std::function<void()> pending;
  std::optional<ImportResult> document_record;
  std::map<std::string, CadJob> jobs;
  std::vector<std::filesystem::path> directories;
  // Only run() and work submitted to it access the owned CAD document.
  std::unique_ptr<CadDocument> document;
  std::jthread worker;

  void cleanStaging()
  {
    for ( const auto &path : directories ) {
      std::error_code error;
      std::filesystem::remove_all( path, error );
      if ( error ) {
        std::cerr << "Could not remove a CAD staging directory.\n";
      }
    }
    directories.clear();
  }
  void run( std::stop_token stop )
  {
    while ( true ) {
      std::function<void()> task;
      {
        std::unique_lock lock( mutex );
        changed.wait( lock, stop, [ this ] { return static_cast<bool>( pending ); } );
        if ( !pending ) {
          break;
        }
        task    = std::move( pending );
        pending = {};
      }
      task();
    }
    document.reset();
  }
  void checkAvailable() const
  {
    if ( closing ) {
      fail( "WORKER_EXITED", "CAD service is closing." );
    }
    if ( busy ) {
      fail( "BUSY", "CAD computation is already running." );
    }
  }
  void checkHandle( const Json &handle ) const
  {
    if ( handle.at( "serverInstanceId" ) != context.server_instance_id ) {
      fail( "STALE_HANDLE", "CAD handle belongs to an old server instance." );
    }
  }
  void checkDocument( const Json &handle ) const
  {
    checkHandle( handle );
    if ( !document_record || handle.at( "id" ) != document_record->document.id ) {
      fail( "NOT_FOUND", "CAD document is no longer open." );
    }
  }
  CadJob &findJob( const Json &handle )
  {
    checkHandle( handle );
    const auto it = jobs.find( handle.at( "id" ).get<std::string>() );
    if ( it == jobs.end() ) {
      fail( "NOT_FOUND", "CAD task is no longer available." );
    }
    return it->second;
  }
  Json startJob( JobKind kind, const Json &input )
  {
    std::lock_guard lock( mutex );
    checkAvailable();
    if ( kind == JobKind::IMPORT && document_record ) {
      fail( "BUSY", "Release the current CAD document before importing another source." );
    }
    if ( kind == JobKind::DISPLAY ) {
      checkDocument( input.at( "document" ) );
    }
    if ( jobs.size() >= context.limits.max_retained_jobs ) {
      fail( "LIMIT_EXCEEDED", "Reconnect before starting more CAD tasks." );
    }
    CadJob job;
    job.handle          = { context.server_instance_id, newId() };
    job.kind            = kind;
    const auto id       = job.handle.id;
    const auto response = Json{
        { "job", toJson( job.handle ) }
    };
    current_stop = job.cancel;
    jobs.emplace( id, std::move( job ) );
    busy    = true;
    pending = [ this, id, kind, input ] { executeJob( id, kind, input ); };
    changed.notify_one();
    return response;
  }
  void executeJob( const std::string &id, JobKind kind, const Json &input )
  {
    std::stop_token stop;
    {
      std::lock_guard lock( mutex );
      auto &job = jobs.at( id );
      if ( job.status == JobStatus::QUEUED ) {
        job.status = JobStatus::RUNNING;
      }
      stop = job.cancel.get_token();
    }
    const auto directory = ( kind == JobKind::IMPORT ? context.staging_root : context.output_root ) / id;
    if ( kind == JobKind::IMPORT ) {
      directories.push_back( directory );
    }
    WorkContext work{ stop,
                      std::chrono::steady_clock::now() + std::chrono::milliseconds( context.limits.job_timeout_ms ),
                      context.limits, [ this, id ]( std::string phase, std::optional<double> progress ) {
                        std::lock_guard lock( mutex );
                        auto &job    = jobs.at( id );
                        job.phase    = std::move( phase );
                        job.progress = progress;
                      } };
    try {
      work.check();
      JobResult result;
      std::unique_ptr<CadDocument> imported;
      std::optional<ImportResult> record;
      if ( kind == JobKind::IMPORT ) {
        const auto request = importRequest( input );
        SourceVersion source{ request.path, {}, importFingerprint( request.unit_override ), request.unit_override, {} };
        const auto snapshot = snapshotSource( context, source, directory, work );
        imported            = readStep( source, snapshot, work );
        std::filesystem::remove_all( directory );
        record = ImportResult{
            { context.server_instance_id, newId() },
            imported->source(),
            imported->objects().size(),
            imported->roots().size(),
            {}
        };
        if ( source.unit_override ) {
          record->warnings.push_back( "Source length units explicitly overridden." );
        }
        result = *record;
      } else {
        result = writeDisplay( *document, input.at( "quality" ), context, directory, work,
                               input.value( "features", std::string( "none" ) ) == "alignment" );
      }
      work.check();
      {
        std::lock_guard lock( mutex );
        auto &job = jobs.at( id );
        if ( job.cancel.stop_requested() ) {
          fail( "CANCELLED", "CAD operation cancelled before commit." );
        }
        if ( imported ) {
          document        = std::move( imported );
          document_record = std::move( record );
        }
        job.result = std::move( result );
        job.status = JobStatus::SUCCEEDED;
        busy       = false;
      }
    } catch ( ... ) {
      const auto error = currentError();
      std::error_code cleanup_error;
      std::filesystem::remove_all( directory, cleanup_error );
      std::lock_guard lock( mutex );
      auto &job  = jobs.at( id );
      job.status = error.code == "CANCELLED" ? JobStatus::CANCELLED : JobStatus::FAILED;
      if ( job.status == JobStatus::FAILED ) {
        job.error = error;
      }
      busy = false;
    }
  }
  void startQuery( const std::string &request_id, const std::string &tool, Json input, Reply reply )
  {
    std::lock_guard lock( mutex );
    checkAvailable();
    checkDocument( input.at( "document" ) );
    busy            = true;
    current_request = request_id;
    current_stop    = std::stop_source{};
    const auto stop = current_stop.get_token();
    pending         = [ this, stop, tool, input = std::move( input ), reply = std::move( reply ) ] {
      WorkContext work{ stop,
                        std::chrono::steady_clock::now() + std::chrono::milliseconds( context.limits.query_timeout_ms ),
                        context.limits,
                                {} };
      Json response;
      try {
        work.check();
        Json data;
        if ( tool == "cad_get_structure" ) {
          const auto mode = input.at( "mode" ).get<std::string>();
          if ( mode != "all" && mode != "children" ) {
            fail( "INVALID_ARGUMENT", "Unknown structure mode." );
          }
          data = toJson( getStructure( *document,
                                               { mode == "all", input.value( "parentObjectId", "" ),
                                         input.value( "nameContains", "" ), pageQuery( input ) },
                                               work ) );
        } else if ( tool == "cad_decompose_object" ) {
          data = toJson( decomposeObject( *document, input.at( "objectId" ), work ) );

          document_record->object_count = document->objects().size();
        } else if ( tool == "cad_get_properties" ) {
          data = toJson( getProperties( *document,
                                                { input.at( "objectIds" ).get<std::vector<std::string>>(),
                                          input.at( "fields" ).get<std::set<std::string>>() },
                                                work ) );
        } else if ( tool == "cad_measure_distance" ) {
          data =
              toJson( measureDistance( *document,
                                               { distanceObject( input.at( "first" ) ), distanceObject( input.at( "second" ) ),
                                         input.value( "limit", std::size_t{ 10 } ) },
                                               work ) );
        } else if ( tool == "cad_list_geometry_features" ) {
          FeatureQuery query{
              input.at( "objectId" ), {}, input.at( "types" ).get<std::set<std::string>>(), pageQuery( input ) };
          if ( input.contains( "topologyRef" ) ) {
            query.topology_ref = TopologyRef{ input[ "topologyRef" ].at( "kind" ), input[ "topologyRef" ].at( "id" ) };
          }
          data = toJson( listGeometryFeatures( *document, query, work ) );
        } else if ( tool == "cad_release_document" ) {
          document.reset();
          {
            std::lock_guard state_lock( mutex );
            document_record.reset();
          }
          cleanStaging();
          data = {
              { "released", true }
          };
        } else {
          fail( "INVALID_ARGUMENT", "Unknown CAD tool." );
        }
        work.check();
        response = success( std::move( data ) );
      } catch ( ... ) {
        response = failure( currentError() );
      }
      {
        std::lock_guard state_lock( mutex );
        busy = false;
        current_request.clear();
      }
      reply( std::move( response ) );
    };
    changed.notify_one();
  }
};

CadService::CadService( ServerContext context ) : impl_( std::make_unique<Impl>( std::move( context ) ) ) {}
CadService::~CadService() = default;
void CadService::call( std::string request_id, const std::string &tool, Json input, Reply reply )
{
  try {
    Json data;
    if ( tool == "cad_get_capabilities" ) {
      data = capabilities( impl_->context );
    } else if ( tool == "cad_import_step" || tool == "cad_build_display" ) {
      data = impl_->startJob( tool == "cad_import_step" ? JobKind::IMPORT : JobKind::DISPLAY, input );
    } else if ( tool == "cad_get_job" || tool == "cad_cancel_job" ) {
      std::lock_guard lock( impl_->mutex );
      auto &job = impl_->findJob( input.at( "job" ) );
      if ( tool == "cad_get_job" ) {
        data = toJson( job );
      } else {
        const auto requested = !terminal( job.status );
        if ( requested ) {
          job.cancel.request_stop();
          job.status = JobStatus::CANCELLING;
        }
        data = {
            {"job",             toJson( job.handle )    },
            {"cancelRequested", requested               },
            {"status",          statusName( job.status )}
        };
      }
    } else {
      impl_->startQuery( request_id, tool, std::move( input ), reply );
      return;
    }
    reply( success( std::move( data ) ) );
  } catch ( ... ) {
    reply( failure( currentError() ) );
  }
}
void CadService::cancelRequest( const std::string &request_id )
{
  std::lock_guard lock( impl_->mutex );
  if ( impl_->busy && impl_->current_request == request_id ) {
    impl_->current_stop.request_stop();
  }
}
}  // namespace dai::cad
