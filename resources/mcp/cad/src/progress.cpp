#include "private/progress.h"

namespace dai::cad
{
CadProgress::CadProgress( const WorkContext &work, std::string phase ) : work_( work ), phase_( std::move( phase ) ) {}
Standard_Boolean CadProgress::UserBreak()
{
  return work_.stop.stop_requested() || std::chrono::steady_clock::now() >= work_.deadline;
}
void CadProgress::Show( const Message_ProgressScope &, Standard_Boolean )
{
  const auto position = GetPosition();
  if ( position - last_position_ >= 0.01 && work_.on_progress ) {
    work_.on_progress( phase_, position );
    last_position_ = position;
  }
}
}  // namespace dai::cad
