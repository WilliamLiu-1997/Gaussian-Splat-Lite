use wasm_bindgen::prelude::*;

#[cfg(all(target_arch = "wasm32", not(feature = "cli")))]
mod allocation;
#[cfg(feature = "cli")]
mod cli;

#[cfg(not(feature = "cli"))]
mod bounds;
#[cfg(not(feature = "cli"))]
mod browser;
#[cfg(not(feature = "cli"))]
mod decoder;
#[cfg(not(feature = "cli"))]
mod morton;
#[cfg(not(feature = "cli"))]
mod rad;
#[cfg(not(feature = "cli"))]
mod rad_lod;
#[cfg(not(feature = "cli"))]
mod raycast;
#[cfg(not(feature = "cli"))]
mod sog;
#[cfg(not(feature = "cli"))]
mod sort;
#[cfg(not(feature = "cli"))]
mod splats;

#[wasm_bindgen(start)]
pub fn wasm_start() {
    console_error_panic_hook::set_once();
}
