cmake_minimum_required(VERSION 3.24)
project(DaiSceneBuild LANGUAGES CXX)

include(ExternalProject)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(OCCT_ARCHIVE "https://codeload.github.com/Open-Cascade-SAS/OCCT/tar.gz/refs/tags/V7_9_3"
    CACHE STRING "OCCT 7.9.3 source archive URL or local path")
get_filename_component(scene_dir "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(occt_source "${scene_dir}/build/src/occt")
set(occt_install "${scene_dir}/build/occt")

set(occt_platform_args)
set(common_args "-DCMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}"
    "-DCMAKE_CXX_COMPILER=${CMAKE_CXX_COMPILER}")
if(APPLE)
    if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0")
    endif()
    list(APPEND common_args
        "-DCMAKE_OSX_DEPLOYMENT_TARGET=${CMAKE_OSX_DEPLOYMENT_TARGET}"
        "-DCMAKE_OSX_ARCHITECTURES=${CMAKE_OSX_ARCHITECTURES}")
    list(APPEND occt_platform_args -DBUILD_SOVERSION_NUMBERS=3 "-DCMAKE_INSTALL_NAME_DIR=@rpath"
        "-DCMAKE_INSTALL_RPATH=@loader_path")
elseif(UNIX)
    list(APPEND occt_platform_args "-DCMAKE_INSTALL_RPATH=$ORIGIN")
endif()

ExternalProject_Add(occt
    URL "${OCCT_ARCHIVE}"
    URL_HASH SHA256=5ecf094ec6b12d5413dfb851d8c3590c354058aee556e32e408bdfbf8c357d57
    PREFIX "${scene_dir}/build/occt-prefix"
    SOURCE_DIR "${occt_source}"
    BUILD_COMMAND "${CMAKE_COMMAND}" --build <BINARY_DIR> --config $<CONFIG> --parallel 4
    CMAKE_ARGS
        "-DINSTALL_DIR=${occt_install}"
        -DINSTALL_DIR_CMAKE=lib/cmake/opencascade
        -DBUILD_LIBRARY_TYPE=Shared
        -DBUILD_MODULE_FoundationClasses=OFF
        -DBUILD_MODULE_ModelingData=OFF
        -DBUILD_MODULE_ModelingAlgorithms=OFF
        -DBUILD_MODULE_Visualization=OFF
        -DBUILD_MODULE_ApplicationFramework=OFF
        -DBUILD_MODULE_DataExchange=OFF
        -DBUILD_MODULE_DETools=OFF
        -DBUILD_MODULE_Draw=OFF
        "-DBUILD_ADDITIONAL_TOOLKITS=TKDESTEP TKDESTL TKMesh"
        -DBUILD_RESOURCES=OFF
        -DUSE_VTK=OFF
        -DUSE_TCL=OFF
        -DUSE_TK=OFF
        -DUSE_OPENGL=OFF
        -DUSE_XLIB=OFF
        -DUSE_FREETYPE=OFF
        ${common_args}
        ${occt_platform_args}
)

ExternalProject_Add(cad_import
    DEPENDS occt
    SOURCE_DIR "${scene_dir}"
    INSTALL_COMMAND "${CMAKE_COMMAND}" -E rm -rf "${scene_dir}/runtime"
        COMMAND "${CMAKE_COMMAND}" --install <BINARY_DIR> --config $<CONFIG>
    CMAKE_ARGS
        "-DCMAKE_INSTALL_PREFIX=${scene_dir}/runtime"
        "-DOpenCASCADE_DIR=${occt_install}/lib/cmake/opencascade"
        "-DOCCT_SOURCE_DIR=${occt_source}"
        "-DJSON_ARCHIVE=${JSON_ARCHIVE}"
        ${common_args}
    BUILD_ALWAYS ON
)
