cmake_minimum_required(VERSION 3.24)
project(DaiPlanning LANGUAGES CXX)

find_package(one_punch 2026.1.15 CONFIG REQUIRED)

add_executable(planning-worker main.cpp scene_snapshot.cpp)
target_compile_features(planning-worker PRIVATE cxx_std_20)
target_compile_options(planning-worker PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(planning-worker PRIVATE one_punch::one_punch)
set_target_properties(planning-worker PROPERTIES INSTALL_RPATH "$ORIGIN/lib")
install(TARGETS planning-worker RUNTIME DESTINATION ".")
