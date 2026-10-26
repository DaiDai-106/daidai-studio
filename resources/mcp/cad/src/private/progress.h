#ifndef DAI_CAD_PROGRESS_H
#define DAI_CAD_PROGRESS_H

#include "cad/types.h"
#include <Message_ProgressIndicator.hxx>

namespace dai::cad
{
class CadProgress final : public Message_ProgressIndicator
{
 public:
  CadProgress( const WorkContext &work, std::string phase );

 protected:
  Standard_Boolean UserBreak() override;
  void Show( const Message_ProgressScope &, Standard_Boolean ) override;

 private:
  const WorkContext &work_;
  std::string phase_;
  double last_position_ = -1;
};
}  // namespace dai::cad
#endif  // DAI_CAD_PROGRESS_H
