cmake_minimum_required(VERSION 3.21)
project(dai_builtin_tools LANGUAGES CXX)
include(CTest)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}")
add_subdirectory(cad)
add_subdirectory(alignment)

get_property(runtime_directories GLOBAL PROPERTY DAI_BUILTIN_RUNTIME_DIRECTORIES)
if(WIN32)
  set(runtime_pre_exclude "^api-ms-" "^ext-ms-")
  set(runtime_post_exclude ".*[/\\][Ss][Yy][Ss][Tt][Ee][Mm]32[/\\].*")
  set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION .)
  include(InstallRequiredSystemLibraries)
elseif(APPLE)
  set(runtime_post_exclude "^/System/Library/" "^/usr/lib/")
else()
  # Ubuntu supplies OpenSSL, TBB, codecs and the C++ runtime through package dependencies.
  # Bundle private OCCT/TinyGLTF libraries; do not duplicate the system loader or libc.
  set(runtime_pre_include "^lib(TK|tinygltf)")
  set(runtime_pre_exclude ".*")
endif()
install(RUNTIME_DEPENDENCY_SET builtin_runtime
  PRE_INCLUDE_REGEXES ${runtime_pre_include}
  PRE_EXCLUDE_REGEXES ${runtime_pre_exclude}
  POST_EXCLUDE_REGEXES ${runtime_post_exclude}
  DIRECTORIES ${runtime_directories}
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION .
  FRAMEWORK DESTINATION lib)
install(FILES "${CMAKE_CURRENT_SOURCE_DIR}/../../LICENSE" DESTINATION .)
