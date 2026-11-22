cmake_minimum_required(VERSION 3.24)
project(DaiCadImport LANGUAGES CXX)

find_package(OpenCASCADE 7.9.3 EXACT REQUIRED CONFIG)

include(FetchContent)
if(NOT JSON_ARCHIVE)
    set(JSON_ARCHIVE "https://codeload.github.com/nlohmann/json/tar.gz/refs/tags/v3.12.0")
endif()
set(JSON_Install OFF)
FetchContent_Declare(nlohmann_json
    URL "${JSON_ARCHIVE}"
    URL_HASH SHA256=4b92eb0c06d10683f7447ce9406cb97cd4b453be18d7279320f7b2f025c10187
)
FetchContent_MakeAvailable(nlohmann_json)

add_executable(cad-import cad_import.cpp)
target_compile_features(cad-import PRIVATE cxx_std_17)
target_include_directories(cad-import SYSTEM PRIVATE "${OpenCASCADE_INCLUDE_DIR}")
target_link_libraries(cad-import PRIVATE
    TKDESTEP TKDESTL TKXCAF TKMesh TKXSBase TKTopAlgo TKBRep TKLCAF TKMath TKernel
    nlohmann_json::nlohmann_json
)
if(MSVC)
    target_compile_options(cad-import PRIVATE /utf-8 /W4)
else()
    target_compile_options(cad-import PRIVATE -Wall -Wextra -Wpedantic)
endif()

install(TARGETS cad-import RUNTIME DESTINATION ".")
install(FILES README.md "${nlohmann_json_SOURCE_DIR}/LICENSE.MIT" DESTINATION "licenses")
if(NOT OCCT_SOURCE_DIR)
    return()
endif()

if(WIN32)
    set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION ".")
    include(InstallRequiredSystemLibraries)
    if(MSVC AND NOT CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS)
        message(FATAL_ERROR "Visual C++ Redistributable libraries were not found.")
    endif()
endif()
if(APPLE)
    set_target_properties(cad-import PROPERTIES INSTALL_RPATH "@loader_path/../Frameworks;@loader_path/lib")
elseif(UNIX)
    set_target_properties(cad-import PROPERTIES INSTALL_RPATH "$ORIGIN/lib")
endif()
install(IMPORTED_RUNTIME_ARTIFACTS ${OpenCASCADE_LIBRARIES}
    RUNTIME DESTINATION "."
    LIBRARY DESTINATION "lib"
)
install(FILES
    "${OCCT_SOURCE_DIR}/LICENSE_LGPL_21.txt"
    "${OCCT_SOURCE_DIR}/OCCT_LGPL_EXCEPTION.txt"
    DESTINATION "licenses"
)
