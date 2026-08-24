use std::cell::RefCell;

use gaussian_splat_lib::decoder::{ChunkReceiver, MultiDecoder, SplatFileType};
use js_sys::{Float32Array, Float64Array, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;

use crate::{decoder::ChunkDecoder, splats::SplatsData};

mod decoder;
mod raycast;
mod sort;
mod splats;

use raycast::{raycast_splat_ellipsoids, RaycastTables};
use sort::{sort32_centers_internal, Sort32Buffers};

#[wasm_bindgen(start)]
pub fn wasm_start() {
    console_error_panic_hook::set_once();
}

thread_local! {
    static SORT32_BUFFERS: RefCell<Sort32Buffers> = RefCell::new(Sort32Buffers::default());
}

#[wasm_bindgen]
pub fn set_sort_center_state(
    update_range_indices: Uint32Array,
    update_centers: Float32Array,
    range_mesh_ids: Uint32Array,
    range_bases: Uint32Array,
    range_counts: Uint32Array,
    range_origins: Float64Array,
) {
    if range_mesh_ids.length() != range_bases.length()
        || range_bases.length() != range_counts.length()
    {
        wasm_bindgen::throw_str("Sort range mesh/base/count arrays must have equal lengths");
    }
    if range_origins.length() != range_bases.length().saturating_mul(3) {
        wasm_bindgen::throw_str("Sort range origins must contain three values per range");
    }
    let mut expected_update_values = 0_u64;
    for index in 0..update_range_indices.length() {
        let range_index = update_range_indices.get_index(index);
        if range_index >= range_counts.length() {
            wasm_bindgen::throw_str("Sort center update range index is out of bounds");
        }
        expected_update_values =
            expected_update_values.saturating_add(range_counts.get_index(range_index) as u64 * 3);
    }
    if expected_update_values != update_centers.length() as u64 {
        wasm_bindgen::throw_str("Sort center update data length does not match its ranges");
    }

    SORT32_BUFFERS.with_borrow_mut(|buffers| {
        buffers.mesh_generation = buffers.mesh_generation.wrapping_add(1);
        if buffers.mesh_generation == 0 {
            buffers.mesh_generations.fill(0);
            buffers.mesh_generation = 1;
        }
        let generation = buffers.mesh_generation;
        for index in 0..range_mesh_ids.length() {
            let mesh_id = range_mesh_ids.get_index(index) as usize;
            if buffers.mesh_generations.len() <= mesh_id {
                buffers.mesh_generations.resize(mesh_id + 1, 0);
            }
            buffers.mesh_generations[mesh_id] = generation;
        }
        for &mesh_id in &buffers.range_mesh_ids {
            if buffers.mesh_generations[mesh_id as usize] != generation {
                buffers.mesh_centers[mesh_id as usize] = Vec::new();
            }
        }

        let mut center_offset = 0_u32;
        for index in 0..update_range_indices.length() {
            let range_index = update_range_indices.get_index(index);
            let mesh_id = range_mesh_ids.get_index(range_index) as usize;
            let center_values = range_counts.get_index(range_index).saturating_mul(3);
            if buffers.mesh_centers.len() <= mesh_id {
                buffers.mesh_centers.resize_with(mesh_id + 1, Vec::new);
            }
            let target = &mut buffers.mesh_centers[mesh_id];
            target.resize(center_values as usize, f32::NAN);
            update_centers
                .subarray(center_offset, center_offset + center_values)
                .copy_to(target);
            center_offset += center_values;
        }

        buffers
            .range_mesh_ids
            .resize(range_mesh_ids.length() as usize, 0);
        range_mesh_ids.copy_to(&mut buffers.range_mesh_ids);
        buffers.range_bases.resize(range_bases.length() as usize, 0);
        range_bases.copy_to(&mut buffers.range_bases);
        buffers
            .range_counts
            .resize(range_counts.length() as usize, 0);
        range_counts.copy_to(&mut buffers.range_counts);
        buffers
            .range_origins
            .resize(range_origins.length() as usize, 0.0);
        range_origins.copy_to(&mut buffers.range_origins);
    });
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)] // Flat scalars keep the JS/WASM sort call allocation-free.
pub fn sort32_centers(
    num_splats: u32,
    camera_x: f64,
    camera_y: f64,
    camera_z: f64,
    direction_x: f32,
    direction_y: f32,
    direction_z: f32,
    radial: bool,
    ordering: Uint32Array,
) -> u32 {
    let max_splats = ordering.length() as usize;

    SORT32_BUFFERS.with_borrow_mut(|buffers| {
        let active_splats = match sort32_centers_internal(
            buffers,
            max_splats,
            num_splats as usize,
            [camera_x, camera_y, camera_z],
            [direction_x, direction_y, direction_z],
            radial,
        ) {
            Ok(active_splats) => active_splats,
            Err(err) => wasm_bindgen::throw_str(&err),
        };

        if active_splats > 0 {
            ordering
                .subarray(0, active_splats)
                .copy_from(&buffers.ordering[..active_splats as usize]);
        }
        active_splats
    })
}

fn parse_file_type(file_type: Option<String>) -> Result<Option<SplatFileType>, JsValue> {
    file_type
        .map(|file_type| {
            SplatFileType::from_enum_str(&file_type).map_err(|err| JsValue::from(err.to_string()))
        })
        .transpose()
}

#[wasm_bindgen]
pub fn decode_to_splats(
    file_type: Option<String>,
    path_name: Option<String>,
) -> Result<ChunkDecoder, JsValue> {
    let file_type = parse_file_type(file_type)?;

    let decoder = MultiDecoder::new(SplatsData::new(), file_type, path_name.as_deref());
    let on_finish = |receiver: Box<dyn ChunkReceiver>| {
        let decoder: Box<MultiDecoder<SplatsData>> = receiver.into_any().downcast().unwrap();
        let file_type = decoder.file_type.unwrap();
        let object = decoder.into_splats().into_splat_object();
        Reflect::set(
            &object,
            &JsValue::from_str("fileType"),
            &JsValue::from(file_type.to_enum_str()),
        )?;
        Ok(JsValue::from(object))
    };

    Ok(ChunkDecoder::new(Box::new(decoder), Box::new(on_finish)))
}

const RAYCAST_BUFFER_COUNT: usize = 65536;

struct RaycastBuffers {
    splats: Vec<u32>,
    splats2: Vec<u32>,
    distances: Vec<f32>,
    tables: RaycastTables,
}

impl Default for RaycastBuffers {
    fn default() -> Self {
        Self {
            splats: vec![0; RAYCAST_BUFFER_COUNT * 4],
            splats2: vec![0; RAYCAST_BUFFER_COUNT * 4],
            distances: vec![0.0; RAYCAST_BUFFER_COUNT],
            tables: RaycastTables::default(),
        }
    }
}

thread_local! {
    static RAYCAST_BUFFERS: RefCell<RaycastBuffers> = RefCell::new(RaycastBuffers::default());
}

#[wasm_bindgen]
pub fn get_raycast_buffer() -> Uint32Array {
    RAYCAST_BUFFERS.with_borrow_mut(|buffers| unsafe { Uint32Array::view(&buffers.splats) })
}

#[wasm_bindgen]
pub fn get_raycast_buffer2() -> Uint32Array {
    RAYCAST_BUFFERS.with_borrow_mut(|buffers| unsafe { Uint32Array::view(&buffers.splats2) })
}

#[wasm_bindgen]
pub fn raycast_splat_buffers(
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
    RAYCAST_BUFFERS.with_borrow_mut(|buffers| {
        let RaycastBuffers {
            splats,
            splats2,
            distances,
            tables,
        } = &mut *buffers;
        distances.clear();
        let subbuffer = &splats[0..(4 * count as usize)];
        let subbuffer2 = &splats2[0..(4 * count as usize)];
        raycast_splat_ellipsoids(
            subbuffer,
            subbuffer2,
            distances,
            [origin_x, origin_y, origin_z],
            [dir_x, dir_y, dir_z],
            min_opacity,
            tables,
            near,
            far,
        );

        unsafe { Float32Array::view(&distances) }
    })
}
