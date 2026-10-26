#ifndef DAI_CAD_FILES_H
#define DAI_CAD_FILES_H

#include "cad/types.h"

namespace dai::cad
{
[[nodiscard]] std::string fileHash( const std::filesystem::path &path, const WorkContext &work );
[[nodiscard]] std::filesystem::path utf8Path( const std::string &value );
[[nodiscard]] std::string utf8String( const std::filesystem::path &value );
[[nodiscard]] std::filesystem::path snapshotSource( const ServerContext &server, SourceVersion &source,
                                                    const std::filesystem::path &job_directory,
                                                    const WorkContext &work );
[[nodiscard]] ResourceRef describeResource( const ServerContext &server, const std::filesystem::path &path,
                                            const std::string &media_type, const WorkContext &work );
void writeJson( const std::filesystem::path &path, const Json &value, const WorkContext &work );
[[nodiscard]] Json readJson( const std::filesystem::path &path, std::uint64_t max_bytes );
}  // namespace dai::cad
#endif  // DAI_CAD_FILES_H
