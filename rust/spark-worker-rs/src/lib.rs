use std::cell::RefCell;

use js_sys::{Reflect, Uint32Array};
use spark_lib::decoder::{ChunkReceiver, MultiDecoder, SplatEncoding, SplatFileType};
use wasm_bindgen::prelude::*;

use crate::{decoder::ChunkDecoder, ext_splats::ExtSplatsData, packed_splats::PackedSplatsData};

mod decoder;
mod ext_splats;
mod packed_splats;
mod sort;

use sort::{sort32_internal, Sort32Buffers};

#[wasm_bindgen(start)]
pub fn wasm_start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn simd_enabled() -> bool {
    cfg!(target_feature = "simd128")
}

thread_local! {
    static SORT32_BUFFERS: RefCell<Sort32Buffers> = RefCell::new(Sort32Buffers::default());
}

#[wasm_bindgen]
pub fn sort32_splats(num_splats: u32, readback: Uint32Array, ordering: Uint32Array) -> u32 {
    let max_splats = readback.length() as usize;

    SORT32_BUFFERS.with_borrow_mut(|buffers| {
        buffers.ensure_size(max_splats);
        let sub_readback = readback.subarray(0, num_splats);
        sub_readback.copy_to(&mut buffers.readback[..num_splats as usize]);

        let active_splats = match sort32_internal(buffers, max_splats, num_splats as usize) {
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
pub fn decode_to_packedsplats(
    file_type: Option<String>,
    path_name: Option<String>,
    encoding: JsValue,
) -> Result<ChunkDecoder, JsValue> {
    let encoding = if encoding.is_falsy() {
        SplatEncoding::default()
    } else {
        serde_wasm_bindgen::from_value(encoding)?
    };
    let file_type = parse_file_type(file_type)?;

    let decoder = MultiDecoder::new(
        PackedSplatsData::new(encoding),
        file_type,
        path_name.as_deref(),
    );
    let on_finish = |receiver: Box<dyn ChunkReceiver>| {
        let decoder: Box<MultiDecoder<PackedSplatsData>> = receiver.into_any().downcast().unwrap();
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

#[wasm_bindgen]
pub fn decode_to_extsplats(
    file_type: Option<String>,
    path_name: Option<String>,
) -> Result<ChunkDecoder, JsValue> {
    let file_type = parse_file_type(file_type)?;

    let decoder = MultiDecoder::new(ExtSplatsData::new(), file_type, path_name.as_deref());
    let on_finish = |receiver: Box<dyn ChunkReceiver>| {
        let decoder: Box<MultiDecoder<ExtSplatsData>> = receiver.into_any().downcast().unwrap();
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
