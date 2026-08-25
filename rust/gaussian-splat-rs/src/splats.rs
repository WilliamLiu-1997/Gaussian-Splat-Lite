use std::array;

use gaussian_splat_lib::{
    decoder::{SplatInit, SplatProps, SplatReceiver},
    splat_encode::{
        encode_splat, encode_splat_center, encode_splat_ln_scale, encode_splat_opacity,
        encode_splat_quat, encode_splat_rgb, encode_splat_scale, encode_splat_sh_rgb,
        encode_splat_with_ln_scale, get_splat_tex_size,
    },
};
use js_sys::{Object, Reflect, Uint32Array};
use wasm_bindgen::JsValue;

pub struct SplatsData {
    pub max_splats: usize,
    pub num_splats: usize,
    pub max_sh_degree: usize,
    pub splat_arrays: [Uint32Array; 2],
    pub sh1: Option<Uint32Array>,
    pub sh2: Option<Uint32Array>,
    pub sh3a: Option<Uint32Array>,
    pub sh3b: Option<Uint32Array>,
    buffer_a: Vec<u32>,
    buffer_b: Vec<u32>,
    buffer_base: usize,
    buffer_count: usize,
    buffer_dirty: bool,
}

impl SplatsData {
    pub fn new() -> Self {
        Self {
            max_splats: 0,
            num_splats: 0,
            max_sh_degree: 0,
            splat_arrays: [
                Uint32Array::new_with_length(0),
                Uint32Array::new_with_length(0),
            ],
            sh1: None,
            sh2: None,
            sh3a: None,
            sh3b: None,
            buffer_a: Vec::new(),
            buffer_b: Vec::new(),
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
        Reflect::set(
            &object,
            &JsValue::from_str("splat0"),
            &JsValue::from(self.splat_arrays[0].clone()),
        )
        .unwrap();
        Reflect::set(
            &object,
            &JsValue::from_str("splat1"),
            &JsValue::from(self.splat_arrays[1].clone()),
        )
        .unwrap();
        if let Some(sh1) = self.sh1.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh1"), &JsValue::from(sh1)).unwrap();
        }
        if let Some(sh2) = self.sh2.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh2"), &JsValue::from(sh2)).unwrap();
        }
        if let Some(sh3a) = self.sh3a.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh3a"), &JsValue::from(sh3a)).unwrap();
        }
        if let Some(sh3b) = self.sh3b.as_ref() {
            Reflect::set(&object, &JsValue::from_str("sh3b"), &JsValue::from(sh3b)).unwrap();
        }
        object
    }

    fn ensure_buffers(&mut self, count: usize) {
        self.buffer_a.resize(count * 4, 0);
        self.buffer_b.resize(count * 4, 0);
    }

    fn ensure_buffer_a(&mut self, count: usize) {
        self.buffer_a.resize(count * 4, 0);
    }

    fn flush_buffers(&mut self) {
        if self.buffer_dirty {
            let base = self.buffer_base;
            let count = self.buffer_count;
            self.splat_arrays[0]
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(&self.buffer_a);
            self.splat_arrays[1]
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(&self.buffer_b);
            self.buffer_dirty = false;
        }
    }

    fn invalidate_buffers(&mut self) {
        self.flush_buffers();
        self.buffer_base = 0;
        self.buffer_count = 0;
        self.buffer_dirty = false;
    }

    fn prepare_buffers(&mut self, base: usize, count: usize) {
        if self.buffer_base != base || self.buffer_count != count {
            self.flush_buffers();
            self.ensure_buffers(count);
            let subarray =
                self.splat_arrays[0].subarray((base * 4) as u32, ((base + count) * 4) as u32);
            subarray.copy_to(&mut self.buffer_a[0..count * 4]);
            let subarray =
                self.splat_arrays[1].subarray((base * 4) as u32, ((base + count) * 4) as u32);
            subarray.copy_to(&mut self.buffer_b[0..count * 4]);
            self.buffer_base = base;
            self.buffer_count = count;
            self.buffer_dirty = false;
        }
    }

    fn set_batch_impl(
        &mut self,
        base: usize,
        count: usize,
        batch: &SplatProps,
        ln_scale: Option<&[f32]>,
    ) {
        let scale = ln_scale.unwrap_or(batch.scale);
        if !batch.center.is_empty()
            && !batch.opacity.is_empty()
            && !batch.rgb.is_empty()
            && !scale.is_empty()
            && !batch.quat.is_empty()
        {
            let encode = if ln_scale.is_some() {
                encode_splat_with_ln_scale
            } else {
                encode_splat
            };
            self.prepare_buffers(base, count);
            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                let center = array::from_fn(|d| batch.center[i3 + d]);
                let rgb = array::from_fn(|d| batch.rgb[i3 + d]);
                let scale = array::from_fn(|d| scale[i3 + d]);
                let quat = array::from_fn(|d| batch.quat[i4 + d]);
                encode(
                    &mut self.buffer_a[i4..i4 + 4],
                    &mut self.buffer_b[i4..i4 + 4],
                    center,
                    batch.opacity[i],
                    rgb,
                    scale,
                    quat,
                );
            }
            self.buffer_dirty = true;
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
            if !scale.is_empty() {
                if ln_scale.is_some() {
                    self.set_ln_scale(base, count, scale);
                } else {
                    self.set_scale(base, count, scale);
                }
            }
            if !batch.quat.is_empty() {
                self.set_quat(base, count, batch.quat);
            }
        }
        self.set_sh(base, count, batch.sh1, batch.sh2, batch.sh3);
    }
}

impl SplatReceiver for SplatsData {
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        let (_, _, _, max_splats) = get_splat_tex_size(init.num_splats);
        self.max_splats = max_splats;
        self.num_splats = init.num_splats;
        self.max_sh_degree = init.max_sh_degree;

        self.splat_arrays[0] = Uint32Array::new_with_length((max_splats * 4) as u32);
        self.splat_arrays[1] = Uint32Array::new_with_length((max_splats * 4) as u32);

        self.sh1 = if init.max_sh_degree < 1 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh2 = if init.max_sh_degree < 2 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh3a = if init.max_sh_degree < 3 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh3b = if init.max_sh_degree < 3 {
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
        self.invalidate_buffers();
        self.buffer_a = Vec::new();
        self.buffer_b = Vec::new();
        Ok(())
    }

    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps) {
        self.set_batch_impl(base, count, batch, None);
    }

    fn set_batch_ln_scale(
        &mut self,
        base: usize,
        count: usize,
        batch: &SplatProps,
        ln_scale: &[f32],
    ) {
        self.set_batch_impl(base, count, batch, Some(ln_scale));
    }

    fn set_center(&mut self, base: usize, count: usize, center: &[f32]) {
        self.prepare_buffers(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_center(
                &mut self.buffer_a[i4..i4 + 4],
                array::from_fn(|d| center[i3 + d]),
            );
        }
        self.buffer_dirty = true;
    }

    fn set_opacity(&mut self, base: usize, count: usize, opacity: &[f32]) {
        self.prepare_buffers(base, count);
        for i in 0..count {
            let i4 = i * 4;
            encode_splat_opacity(&mut self.buffer_a[i4..i4 + 4], opacity[i]);
        }
        self.buffer_dirty = true;
    }

    fn set_rgb(&mut self, base: usize, count: usize, rgb: &[f32]) {
        self.prepare_buffers(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_rgb(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| rgb[i3 + d]),
            );
        }
        self.buffer_dirty = true;
    }

    fn set_scale(&mut self, base: usize, count: usize, scale: &[f32]) {
        self.prepare_buffers(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_scale(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| scale[i3 + d]),
            );
        }
        self.buffer_dirty = true;
    }

    fn set_ln_scale(&mut self, base: usize, count: usize, ln_scale: &[f32]) {
        self.prepare_buffers(base, count);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_ln_scale(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| ln_scale[i3 + d]),
            );
        }
        self.buffer_dirty = true;
    }

    fn set_quat(&mut self, base: usize, count: usize, quat: &[f32]) {
        self.prepare_buffers(base, count);
        for i in 0..count {
            let i4 = i * 4;
            encode_splat_quat(
                &mut self.buffer_b[i4..i4 + 4],
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
        self.invalidate_buffers();
        self.ensure_buffer_a(count);
        if let Some(packed_sh1) = self.sh1.as_ref() {
            let buffer = &mut self.buffer_a[0..count * 4];
            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                for k in 0..3 {
                    let k3 = (i3 + k) * 3;
                    buffer[i4 + k] = encode_splat_sh_rgb([sh1[k3], sh1[k3 + 1], sh1[k3 + 2]]);
                }
            }
            packed_sh1
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(buffer);
        }
    }

    fn set_sh2(&mut self, base: usize, count: usize, sh2: &[f32]) {
        self.invalidate_buffers();
        self.ensure_buffers(count);
        if let Some(packed_sh1) = self.sh1.as_ref() {
            if let Some(packed_sh2) = self.sh2.as_ref() {
                let buffer_a = &mut self.buffer_a[0..count * 4];
                let buffer_b = &mut self.buffer_b[0..count * 4];
                packed_sh1
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_to(buffer_a);
                for i in 0..count {
                    let [i4, i5] = [i * 4, i * 5];
                    let k3 = i5 * 3;
                    buffer_a[i4 + 3] = encode_splat_sh_rgb([sh2[k3], sh2[k3 + 1], sh2[k3 + 2]]);
                    for k in 1..5 {
                        let k3 = (i5 + k) * 3;
                        buffer_b[i4 + (k - 1)] =
                            encode_splat_sh_rgb([sh2[k3], sh2[k3 + 1], sh2[k3 + 2]]);
                    }
                }
                packed_sh1
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_a);
                packed_sh2
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_b);
            }
        }
    }

    fn set_sh3(&mut self, base: usize, count: usize, sh3: &[f32]) {
        self.invalidate_buffers();
        self.ensure_buffers(count);
        if let Some(packed_sh3a) = self.sh3a.as_ref() {
            if let Some(packed_sh3b) = self.sh3b.as_ref() {
                let buffer_a = &mut self.buffer_a[0..count * 4];
                let buffer_b = &mut self.buffer_b[0..count * 4];
                for i in 0..count {
                    let [i4, i7] = [i * 4, i * 7];
                    for k in 0..4 {
                        let k3 = (i7 + k) * 3;
                        buffer_a[i4 + k] = encode_splat_sh_rgb([sh3[k3], sh3[k3 + 1], sh3[k3 + 2]]);
                    }
                    for k in 4..7 {
                        let k3 = (i7 + k) * 3;
                        buffer_b[i4 + (k - 4)] =
                            encode_splat_sh_rgb([sh3[k3], sh3[k3 + 1], sh3[k3 + 2]]);
                    }
                }
                packed_sh3a
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_a);
                packed_sh3b
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_b);
            }
        }
    }
}
