#ifndef DAI_CAD_SERVICE_H
#define DAI_CAD_SERVICE_H

#include "cad/types.h"
#include <memory>

namespace dai::cad
{
// Private worker endpoint. MCP framing and Schema validation belong to the TS SDK adapter.
class CadService final
{
 public:
  using Reply = std::function<void( Json )>;
  explicit CadService( ServerContext context );
  ~CadService();
  CadService( const CadService & )            = delete;
  CadService &operator=( const CadService & ) = delete;
  void call( std::string request_id, const std::string &tool, Json input, Reply reply );
  void cancelRequest( const std::string &request_id );

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace dai::cad
#endif  // DAI_CAD_SERVICE_H
