option(GSL_WEBP_DECODER "Build the WebP decoder for Rust" OFF)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WEBP_ENABLE_SIMD OFF CACHE BOOL "" FORCE)
foreach(option ANIM_UTILS CWEBP DWEBP GIF2WEBP IMG2WEBP VWEBP WEBPINFO
               LIBWEBPMUX WEBPMUX EXTRAS WEBP_JS FUZZTEST)
  set(WEBP_BUILD_${option} OFF CACHE BOOL "" FORCE)
endforeach()
set(WEBP_USE_THREAD OFF CACHE BOOL "" FORCE)

if(GSL_WEBP_DECODER)
  # Rust links WebAssembly objects, not Emscripten's LLVM bitcode.
  add_compile_options(-fno-lto)
  add_compile_definitions(
    malloc=gsl_webp_malloc calloc=gsl_webp_calloc free=gsl_webp_free
  )
endif()

include(FetchContent)
FetchContent_Declare(libwebp
  URL https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz
  URL_HASH SHA256=e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564
  BINARY_DIR "${CMAKE_CURRENT_BINARY_DIR}/libwebp"
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(libwebp)

if(GSL_WEBP_DECODER)
  add_library(sog_webp_decode STATIC decode.c)
  target_include_directories(sog_webp_decode PRIVATE ${libwebp_SOURCE_DIR}/src)
  set_target_properties(sog_webp_decode webpdecoder PROPERTIES
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
  add_dependencies(wasm sog_webp_decode webpdecoder)
  return()
endif()

add_executable(sog_webp encode.c)
target_link_libraries(sog_webp PRIVATE webp)
set_target_properties(sog_webp PROPERTIES OUTPUT_NAME webp SUFFIX .mjs)
target_link_options(sog_webp PRIVATE
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=node
  -sFILESYSTEM=0
  -sALLOW_MEMORY_GROWTH=1
  -sABORTING_MALLOC=0
  -sINITIAL_MEMORY=16777216
  -sMAXIMUM_MEMORY=2147483648
  -sSTACK_SIZE=1048576
  "-sEXPORTED_FUNCTIONS=['_webp_encode','_WebPFree','_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32']"
)

add_dependencies(wasm sog_webp)
