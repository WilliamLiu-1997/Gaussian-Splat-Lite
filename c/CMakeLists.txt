cmake_minimum_required(VERSION 3.24)
project(gsl_wasm C)

set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG -flto -msimd128")
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/modules")
add_custom_target(wasm)

add_subdirectory(webp)
