use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=GSL_WEBP_LIB_DIR");
    if env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32")
        || env::var_os("CARGO_FEATURE_CLI").is_some()
    {
        return;
    }
    let directory = env::var("GSL_WEBP_LIB_DIR")
        .expect("libwebp must be built first; run npm run build:wasm from the repository root");
    println!("cargo:rustc-link-search=native={directory}");
    for library in ["sog_webp_decode", "webpdecoder"] {
        println!("cargo:rerun-if-changed={directory}/lib{library}.a");
        println!("cargo:rustc-link-lib=static={library}");
    }
}
