use js_sys::{Float32Array, Uint32Array};
use spark_lib::decoder::SplatEncoding;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

mod raycast;
use raycast::{raycast_ext_ellipsoids, raycast_packed_ellipsoids};

#[wasm_bindgen(start)]
pub fn wasm_start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn simd_enabled() -> bool {
    cfg!(target_feature = "simd128")
}

const RAYCAST_BUFFER_COUNT: usize = 65536;

thread_local! {
    static RAYCAST_BUFFERS: RefCell<(Vec<u32>, Vec<u32>, Vec<f32>)> = RefCell::new((vec![0; RAYCAST_BUFFER_COUNT * 4], vec![0; RAYCAST_BUFFER_COUNT * 4], vec![0.0; RAYCAST_BUFFER_COUNT]));
}

#[wasm_bindgen]
pub fn get_raycast_buffer() -> Uint32Array {
    RAYCAST_BUFFERS.with_borrow_mut(|(buffer, _, _)| unsafe { Uint32Array::view(&buffer) })
}

#[wasm_bindgen]
pub fn get_raycast_buffer2() -> Uint32Array {
    RAYCAST_BUFFERS.with_borrow_mut(|(_, buffer, _)| unsafe { Uint32Array::view(&buffer) })
}

#[wasm_bindgen]
pub fn raycast_packed_buffer(
    origin_x: f32,
    origin_y: f32,
    origin_z: f32,
    dir_x: f32,
    dir_y: f32,
    dir_z: f32,
    min_opacity: f32,
    near: f32,
    far: f32,
    count: u32,
    ln_scale_min: f32,
    ln_scale_max: f32,
) -> Float32Array {
    RAYCAST_BUFFERS.with_borrow_mut(|(buffer, _, distances)| {
        let encoding = SplatEncoding {
            ln_scale_min,
            ln_scale_max,
            ..Default::default()
        };

        distances.clear();
        let subbuffer = &buffer[0..(4 * count as usize)];
        raycast_packed_ellipsoids(
            subbuffer,
            distances,
            [origin_x, origin_y, origin_z],
            [dir_x, dir_y, dir_z],
            min_opacity,
            near,
            far,
            &encoding,
        );

        unsafe { Float32Array::view(&distances) }
    })
}

#[wasm_bindgen]
pub fn raycast_ext_buffers(
    origin_x: f32,
    origin_y: f32,
    origin_z: f32,
    dir_x: f32,
    dir_y: f32,
    dir_z: f32,
    min_opacity: f32,
    near: f32,
    far: f32,
    count: u32,
) -> Float32Array {
    RAYCAST_BUFFERS.with_borrow_mut(|(buffer, buffer2, distances)| {
        distances.clear();
        let subbuffer = &buffer[0..(4 * count as usize)];
        let subbuffer2 = &buffer2[0..(4 * count as usize)];
        raycast_ext_ellipsoids(
            subbuffer,
            subbuffer2,
            distances,
            [origin_x, origin_y, origin_z],
            [dir_x, dir_y, dir_z],
            min_opacity,
            near,
            far,
        );

        unsafe { Float32Array::view(&distances) }
    })
}
