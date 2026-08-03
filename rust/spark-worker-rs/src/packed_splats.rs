use std::array;

use js_sys::{Object, Reflect, Uint32Array};
use spark_lib::{
    decoder::{SplatEncoding, SplatInit, SplatProps, SplatReceiver},
    splat_encode::{
        encode_packed_splat, encode_packed_splat_center, encode_packed_splat_opacity,
        encode_packed_splat_quat, encode_packed_splat_rgb, encode_packed_splat_scale,
        encode_sh1_array, encode_sh2_array, encode_sh3_array, get_splat_tex_size,
    },
};
use wasm_bindgen::JsValue;

pub struct PackedSplatsData {
    pub max_splats: usize,
    pub num_splats: usize,
    pub max_sh_degree: usize,
    pub packed: Uint32Array,
    pub sh1: Option<Uint32Array>,
    pub sh2: Option<Uint32Array>,
    pub sh3: Option<Uint32Array>,
    pub encoding: SplatEncoding,
    buffer: Vec<u32>,
    buffer_base: usize,
    buffer_count: usize,
    buffer_dirty: bool,
}

impl PackedSplatsData {
    pub fn new(encoding: SplatEncoding) -> Self {
        Self {
            max_splats: 0,
            num_splats: 0,
            max_sh_degree: 0,
            packed: Uint32Array::new_with_length(0),
            sh1: None,
            sh2: None,
            sh3: None,
            encoding,
            buffer: Vec::new(),
            buffer_base: 0,
            buffer_count: 0,
            buffer_dirty: false,
        }
    }

    pub fn into_splat_object(self) -> Object {
        let object = Object::new();
        Reflect::set(
            &object,
            &JsValue::from_str("maxSplats"),
            &JsValue::from(self.max_splats as u32),
        )
        .unwrap();
        Reflect::set(
            &object,
            &JsValue::from_str("numSplats"),
            &JsValue::from(self.num_splats as u32),
        )
        .unwrap();
        Reflect::set(
            &object,
            &JsValue::from_str("maxShDegree"),
            &JsValue::from(self.max_sh_degree as u32),
        )
        .unwrap();
        Reflect::set(&object, &JsValue::from_str("packed"), &self.packed).unwrap();
        if let Some(sh1) = self.sh1.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh1"), &JsValue::from(sh1)).unwrap();
        }
        if let Some(sh2) = self.sh2.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh2"), &JsValue::from(sh2)).unwrap();
        }
        if let Some(sh3) = self.sh3.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh3"), &JsValue::from(sh3)).unwrap();
        }
        Reflect::set(
            &object,
            &JsValue::from_str("splatEncoding"),
            &serde_wasm_bindgen::to_value(&self.encoding).unwrap(),
        )
        .unwrap();
        object
    }

    fn ensure_buffer(&mut self, count: usize) {
        self.buffer.resize(count * 4, 0);
    }

    fn flush_buffer(&mut self) {
        if self.buffer_dirty {
            let base = self.buffer_base;
            let count = self.buffer_count;
            let sub = self
                .packed
                .subarray((base * 4) as u32, ((base + count) * 4) as u32);
            sub.copy_from(&self.buffer[0..count * 4]);
            self.buffer_dirty = false;
        }
    }

    fn invalidate_buffer(&mut self) {
        self.flush_buffer();
        self.buffer_base = 0;
        self.buffer_count = 0;
        self.buffer_dirty = false;
    }

    fn prepare_buffer(&mut self, base: usize, count: usize) {
        if self.buffer_base != base || self.buffer_count != count {
            self.flush_buffer();
            self.ensure_buffer(count);
            let subarray = self
                .packed
                .subarray((base * 4) as u32, ((base + count) * 4) as u32);
            subarray.copy_to(&mut self.buffer[0..count * 4]);
            self.buffer_base = base;
            self.buffer_count = count;
            self.buffer_dirty = false;
        }
    }
}

impl SplatReceiver for PackedSplatsData {
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        let (_, _, _, max_splats) = get_splat_tex_size(init.num_splats);
        self.max_splats = max_splats;
        self.num_splats = init.num_splats;
        self.max_sh_degree = init.max_sh_degree;

        self.packed = Uint32Array::new_with_length((max_splats * 4) as u32);
        self.sh1 = if init.max_sh_degree < 1 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 2) as u32))
        };
        self.sh2 = if init.max_sh_degree < 2 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh3 = if init.max_sh_degree < 3 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };

        self.buffer_base = 0;
        self.buffer_count = 0;
        self.buffer_dirty = false;
        Ok(())
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        self.invalidate_buffer();
        let mut empty_buffer = Vec::new();
        std::mem::swap(&mut self.buffer, &mut empty_buffer);
        Ok(())
    }

    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps) {
        self.prepare_buffer(base, count);
        if !batch.center.is_empty()
            && !batch.opacity.is_empty()
            && !batch.rgb.is_empty()
            && !batch.scale.is_empty()
            && !batch.quat.is_empty()
        {
            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                encode_packed_splat(
                    &mut self.buffer[i4..i4 + 4],
                    array::from_fn(|d| batch.center[i3 + d]),
                    batch.opacity[i],
                    array::from_fn(|d| batch.rgb[i3 + d]),
                    array::from_fn(|d| batch.scale[i3 + d]),
                    array::from_fn(|d| batch.quat[i4 + d]),
                    &self.encoding,
                );
            }
        } else {
            if !batch.center.is_empty() {
                self.set_center(base, count, batch.center);
            }
            if !batch.opacity.is_empty() {
                self.set_opacity(base, count, batch.opacity);
            }
            if !batch.rgb.is_empty() {
                self.set_rgb(base, count, batch.rgb);
            }
            if !batch.scale.is_empty() {
                self.set_scale(base, count, batch.scale);
            }
            if !batch.quat.is_empty() {
                self.set_quat(base, count, batch.quat);
            }
        }
        self.buffer_dirty = true;
        self.set_sh(base, count, batch.sh1, batch.sh2, batch.sh3);
    }

    fn set_center(&mut self, base: usize, count: usize, center: &[f32]) {
        self.prepare_buffer(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_packed_splat_center(
                &mut self.buffer[i4..i4 + 4],
                array::from_fn(|d| center[i3 + d]),
            );
        }
        self.buffer_dirty = true;
    }

    fn set_opacity(&mut self, base: usize, count: usize, opacity: &[f32]) {
        self.prepare_buffer(base, count);
        for i in 0..count {
            let i4 = i * 4;
            encode_packed_splat_opacity(&mut self.buffer[i4..i4 + 4], opacity[i], &self.encoding);
        }
        self.buffer_dirty = true;
    }

    fn set_rgb(&mut self, base: usize, count: usize, rgb: &[f32]) {
        self.prepare_buffer(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_packed_splat_rgb(
                &mut self.buffer[i4..i4 + 4],
                array::from_fn(|d| rgb[i3 + d]),
                &self.encoding,
            );
        }
        self.buffer_dirty = true;
    }

    fn set_scale(&mut self, base: usize, count: usize, scale: &[f32]) {
        self.prepare_buffer(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_packed_splat_scale(
                &mut self.buffer[i4..i4 + 4],
                array::from_fn(|d| scale[i3 + d]),
                &self.encoding,
            );
        }
        self.buffer_dirty = true;
    }

    fn set_quat(&mut self, base: usize, count: usize, quat: &[f32]) {
        self.prepare_buffer(base, count);
        for i in 0..count {
            let i4 = i * 4;
            encode_packed_splat_quat(
                &mut self.buffer[i4..i4 + 4],
                array::from_fn(|d| quat[i4 + d]),
            );
        }
        self.buffer_dirty = true;
    }

    fn set_sh(&mut self, base: usize, count: usize, sh1: &[f32], sh2: &[f32], sh3: &[f32]) {
        if !sh1.is_empty() {
            self.set_sh1(base, count, sh1);
        }
        if !sh2.is_empty() {
            self.set_sh2(base, count, sh2);
        }
        if !sh3.is_empty() {
            self.set_sh3(base, count, sh3);
        }
    }

    fn set_sh1(&mut self, base: usize, count: usize, sh1: &[f32]) {
        self.invalidate_buffer();
        self.ensure_buffer(count);
        if let Some(packed_sh1) = self.sh1.as_ref() {
            let buffer = &mut self.buffer[0..count * 2];
            encode_sh1_array(buffer, sh1, count, self.encoding.sh1_max);
            packed_sh1
                .subarray((base * 2) as u32, ((base + count) * 2) as u32)
                .copy_from(buffer);
        }
    }

    fn set_sh2(&mut self, base: usize, count: usize, sh2: &[f32]) {
        self.invalidate_buffer();
        self.ensure_buffer(count);
        if let Some(packed_sh2) = self.sh2.as_ref() {
            encode_sh2_array(&mut self.buffer, sh2, count, self.encoding.sh2_max);
            packed_sh2
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(&self.buffer);
        }
    }

    fn set_sh3(&mut self, base: usize, count: usize, sh3: &[f32]) {
        self.invalidate_buffer();
        self.ensure_buffer(count);
        if let Some(packed_sh3) = self.sh3.as_ref() {
            encode_sh3_array(&mut self.buffer, sh3, count, self.encoding.sh3_max);
            packed_sh3
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(&self.buffer);
        }
    }
}
