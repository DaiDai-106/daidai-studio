cmake_minimum_required(VERSION 3.21)
project(dai_cad VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_EXTENSIONS OFF)
include(CTest)

find_package(OpenCASCADE 7.9.2 EXACT REQUIRED CONFIG COMPONENTS
  FoundationClasses ModelingData ModelingAlgorithms Visualization ApplicationFramework DataExchange)
find_package(nlohmann_json 3.11 REQUIRED CONFIG)
find_package(OpenSSL 3.0 REQUIRED COMPONENTS Crypto)
find_package(Threads REQUIRED)
find_package(TinyGLTF CONFIG REQUIRED)

add_library(cad_core STATIC
  src/types.cpp
  src/files.cpp
  src/document.cpp
  src/progress.cpp
  src/units.cpp
  src/step_reader.cpp
  src/queries.cpp
  src/geometry.cpp
  src/serialization.cpp
  src/jobs.cpp
  src/meshing.cpp
  src/mesh_validation.cpp
  src/mesh_context.cpp
  src/display.cpp
)
target_compile_features(cad_core PUBLIC cxx_std_20)
target_include_directories(cad_core PUBLIC include PRIVATE src)
target_include_directories(cad_core SYSTEM PRIVATE ${OpenCASCADE_INCLUDE_DIR})
target_link_libraries(cad_core PUBLIC nlohmann_json::nlohmann_json Threads::Threads
  PRIVATE OpenSSL::Crypto tinygltf::tinygltf TKDESTEP TKXCAF TKMesh TKTopAlgo TKPrim)
add_executable(dai-cad-worker src/main.cpp src/service.cpp)
target_compile_features(dai-cad-worker PRIVATE cxx_std_20)
target_link_libraries(dai-cad-worker PRIVATE cad_core)
target_include_directories(dai-cad-worker SYSTEM PRIVATE ${OpenCASCADE_INCLUDE_DIR})
foreach(target cad_core dai-cad-worker)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /utf-8 /permissive-)
    target_compile_definitions(${target} PRIVATE NOMINMAX)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endforeach()
if(APPLE)
  set_target_properties(dai-cad-worker PROPERTIES INSTALL_RPATH "@loader_path/lib")
elseif(UNIX)
  set_target_properties(dai-cad-worker PROPERTIES INSTALL_RPATH "$ORIGIN/lib")
  target_link_options(dai-cad-worker PRIVATE "LINKER:--disable-new-dtags")
endif()
set(DAI_CAD_RUNTIME_DIRECTORIES "" CACHE STRING "Additional installed runtime library directories")
if(WIN32)
  set(runtime_pre_exclude "^api-ms-" "^ext-ms-")
  set(runtime_post_exclude ".*[/\\][Ss][Yy][Ss][Tt][Ee][Mm]32[/\\].*")
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION .)
  include(InstallRequiredSystemLibraries)
elseif(APPLE)
  set(runtime_post_exclude "^/System/Library/" "^/usr/lib/")
else()
  # Ubuntu supplies OpenSSL, TBB, codecs and the C++ runtime through package dependencies.
  # Only OCCT is private to the application; do not duplicate the system loader or libc.
  set(runtime_pre_include "^libTK")
  set(runtime_pre_exclude ".*")
endif()
install(TARGETS dai-cad-worker RUNTIME_DEPENDENCY_SET cad_runtime RUNTIME DESTINATION .)
install(RUNTIME_DEPENDENCY_SET cad_runtime
  PRE_INCLUDE_REGEXES ${runtime_pre_include}
  PRE_EXCLUDE_REGEXES ${runtime_pre_exclude}
  POST_EXCLUDE_REGEXES ${runtime_post_exclude}
  DIRECTORIES "${OpenCASCADE_BINARY_DIR}" "${OpenCASCADE_LIBRARY_DIR}" ${DAI_CAD_RUNTIME_DIRECTORIES}
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION .
  FRAMEWORK DESTINATION lib)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../../../LICENSE" DESTINATION .)
if(BUILD_TESTING)
  add_subdirectory(
    "${CMAKE_CURRENT_SOURCE_DIR}/../../../tests/cad/native"
    "${CMAKE_CURRENT_BINARY_DIR}/tests")
endif()
