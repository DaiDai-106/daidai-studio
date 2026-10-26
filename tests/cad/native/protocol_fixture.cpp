#include <iostream>
#include <nlohmann/json.hpp>

// A deliberately invalid worker response exercises the process-boundary failure path.
int main()
{
  using Json = nlohmann::json;
  std::string line;
  while ( std::getline( std::cin, line ) ) {
    const auto request = Json::parse( line );
    if ( !request.contains( "requestId" ) ) {
      continue;
    }
    std::cout << Json{ { "requestId", request.at( "requestId" ) },
                       { "result", { { "ok", true }, { "data", { { "unexpected", true } } } } } }.dump()
              << '\n' << std::flush;
  }
}
