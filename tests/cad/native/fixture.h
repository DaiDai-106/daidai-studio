#ifndef DAI_CAD_TEST_FIXTURE_H
#define DAI_CAD_TEST_FIXTURE_H
#include <filesystem>
namespace dai::cad::test
{
void writeCompoundFixture( const std::filesystem::path &path );
void writeFixture( const std::filesystem::path &path, bool external_references = false );
}  // namespace dai::cad::test
#endif  // DAI_CAD_TEST_FIXTURE_H
