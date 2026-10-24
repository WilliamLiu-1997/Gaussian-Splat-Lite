use std::array;

#[cfg(test)]
mod budget_tests {
    use super::output_admission;

    #[test]
    fn rejects_header_counts_and_output_before_js_allocation() {
        assert!(output_admission(8_000_001, 0, 8_000_000, 0, u64::MAX).is_err());
        assert!(output_admission(usize::MAX, 0, usize::MAX, 0, u64::MAX).is_err());
        assert!(output_admission(1, 5, 1, 0, u64::MAX).is_err());
        // One padded row: 2048 slots, eight RGBA arrays and XYZ sort centers.
        assert_eq!(
            output_admission(1, 4, 1, 0, u64::MAX).unwrap(),
            (2048, 286_720)
        );
        assert!(output_admission(1, 4, 1, 1024, 287_743).is_err());
        assert!(output_admission(1, 4, 1, 1024, 287_744).is_ok());
    }
}

use gaussian_splat_lib::{
    decoder::{QuantizedProperty, ScalarLookup, SplatInit, SplatProps, SplatReceiver},
    splat_encode::{
        encode_splat, encode_splat_center, encode_splat_ln_scale, encode_splat_opacity,
        encode_splat_quat, encode_splat_rgb, encode_splat_scale, encode_splat_sh_rgb,
        encode_splat_with_ln_scale, get_splat_tex_size,
    },
};
use js_sys::{Float32Array, Object, Reflect, Uint32Array};
use wasm_bindgen::JsValue;

fn output_admission(
    count: usize,
    degree: usize,
    max_points: usize,
    decoder: u64,
    budget: u64,
) -> anyhow::Result<(usize, u64)> {
    anyhow::ensure!(
        count <= max_points,
        "Decoder maxPoints exceeded: header declares {} points, admitted {}",
        count,
        max_points
    );
    anyhow::ensure!(
        count as u64 <= u64::from(u32::MAX) / 4,
        "packed output exceeds the typed-array length range"
    );
    anyhow::ensure!(degree <= 4, "Invalid decoder SH degree");
    let (_, _, _, capacity) = get_splat_tex_size(count);
    anyhow::ensure!(
        capacity as u64 * 4 <= u32::MAX as u64,
        "packed output exceeds the typed-array length range"
    );
    let arrays = [2u64, 3, 4, 6, 8][degree];
    let output = capacity as u64 * (arrays * 16 + 12);
    anyhow::ensure!(
        output.saturating_add(decoder) <= budget,
        "Decoder memory budget exceeded: need at least {} bytes",
        output.saturating_add(decoder)
    );
    Ok((capacity, output))
}

pub struct SplatsData {
    pub max_splats: usize,
    pub num_splats: usize,
    pub max_sh_degree: usize,
    pub splat_arrays: [Uint32Array; 2],
    pub sort_centers: Float32Array,
    pub sh_block0: Option<Uint32Array>,
    pub sh_block1: Option<Uint32Array>,
    pub sh_block2: Option<Uint32Array>,
    pub sh_block3: Option<Uint32Array>,
    pub sh_block4: Option<Uint32Array>,
    pub sh_block5: Option<Uint32Array>,
    buffer_a: Vec<u32>,
    buffer_b: Vec<u32>,
    buffer_base: usize,
    buffer_count: usize,
    buffer_dirty: [bool; 2],
    max_points: usize,
    memory_budget: u64,
    decoder_memory: u64,
    output_memory: u64,
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
            sort_centers: Float32Array::new_with_length(0),
            sh_block0: None,
            sh_block1: None,
            sh_block2: None,
            sh_block3: None,
            sh_block4: None,
            sh_block5: None,
            buffer_a: Vec::new(),
            buffer_b: Vec::new(),
            buffer_base: 0,
            buffer_count: 0,
            buffer_dirty: [false; 2],
            max_points: usize::MAX,
            memory_budget: u64::MAX,
            decoder_memory: 0,
            output_memory: 0,
        }
    }

    pub fn with_limits(
        max_points: Option<u32>,
        memory_budget: Option<f64>,
    ) -> anyhow::Result<Self> {
        let mut data = Self::new();
        if let Some(points) = max_points {
            anyhow::ensure!(points > 0, "Decoder maxPoints must be positive");
            data.max_points = points as usize;
        }
        if let Some(bytes) = memory_budget {
            anyhow::ensure!(
                bytes.is_finite()
                    && bytes >= 0.0
                    && bytes.fract() == 0.0
                    && bytes <= 9_007_199_254_740_991.0,
                "Invalid decoder memory budget"
            );
            data.memory_budget = bytes as u64;
        }
        Ok(data)
    }

    fn check_memory(&self, output: u64, decoder: u64) -> anyhow::Result<()> {
        anyhow::ensure!(
            output.saturating_add(decoder) <= self.memory_budget,
            "Decoder memory budget exceeded: need at least {} bytes",
            output.saturating_add(decoder)
        );
        Ok(())
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
        Reflect::set(
            &object,
            &JsValue::from_str("sortCenters"),
            &JsValue::from(self.sort_centers.clone()),
        )
        .unwrap();
        if let Some(sh_block0) = self.sh_block0.as_ref() {
            Reflect::set(
                &object,
                &JsValue::from_str("shBlock0"),
                &JsValue::from(sh_block0),
            )
            .unwrap();
        }
        if let Some(sh_block1) = self.sh_block1.as_ref() {
            Reflect::set(
                &object,
                &JsValue::from_str("shBlock1"),
                &JsValue::from(sh_block1),
            )
            .unwrap();
        }
        if let Some(sh_block2) = self.sh_block2.as_ref() {
            Reflect::set(
                &object,
                &JsValue::from_str("shBlock2"),
                &JsValue::from(sh_block2),
            )
            .unwrap();
        }
        if let Some(sh_block3) = self.sh_block3.as_ref() {
            Reflect::set(
                &object,
                &JsValue::from_str("shBlock3"),
                &JsValue::from(sh_block3),
            )
            .unwrap();
        }
        if let Some(sh_block4) = self.sh_block4.as_ref() {
            Reflect::set(
                &object,
                &JsValue::from_str("shBlock4"),
                &JsValue::from(sh_block4),
            )
            .unwrap();
        }
        if let Some(sh_block5) = self.sh_block5.as_ref() {
            Reflect::set(
                &object,
                &JsValue::from_str("shBlock5"),
                &JsValue::from(sh_block5),
            )
            .unwrap();
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

    fn invalidate_buffers(&mut self) {
        let base = self.buffer_base;
        let count = self.buffer_count;
        for (index, buffer) in [&self.buffer_a, &self.buffer_b].into_iter().enumerate() {
            if self.buffer_dirty[index] {
                self.splat_arrays[index]
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(buffer);
                self.buffer_dirty[index] = false;
            }
        }
        self.buffer_base = 0;
        self.buffer_count = 0;
    }

    fn prepare_buffer(&mut self, base: usize, count: usize, index: usize, overwrite: bool) {
        if self.buffer_base != base || self.buffer_count != count {
            self.invalidate_buffers();
            self.buffer_base = base;
            self.buffer_count = count;
        }
        let buffer = if index == 0 {
            &mut self.buffer_a
        } else {
            &mut self.buffer_b
        };
        buffer.resize(count * 4, 0);
        if !overwrite && !self.buffer_dirty[index] {
            self.splat_arrays[index]
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_to(buffer);
        }
        self.buffer_dirty[index] = true;
    }

    fn copy_sort_centers(&self, base: usize, count: usize, centers: &[f32]) {
        self.sort_centers
            .subarray((base * 3) as u32, ((base + count) * 3) as u32)
            .copy_from(&centers[..count * 3]);
    }

    fn invalidate_zero_scale_sort_centers(
        &self,
        base: usize,
        count: usize,
        scales: &[f32],
        logarithmic: bool,
    ) {
        let disabled_scale = if logarithmic { f32::NEG_INFINITY } else { 0.0 };
        for index in 0..count {
            let i3 = index * 3;
            let disabled = scales[i3..i3 + 3]
                .iter()
                .all(|scale| *scale == disabled_scale);
            if disabled {
                let target = (base + index) * 3;
                for component in 0..3 {
                    self.sort_centers
                        .set_index((target + component) as u32, f32::NAN);
                }
            }
        }
    }

    fn set_batch_impl(
        &mut self,
        base: usize,
        count: usize,
        batch: &SplatProps,
        ln_scale: Option<&[f32]>,
    ) {
        if batch.opacity_packed.is_empty() {
            self.write_batch::<false>(base, count, batch, ln_scale);
        } else {
            self.write_batch::<true>(base, count, batch, ln_scale);
        }
    }

    fn write_batch<const PACKED_OPACITY: bool>(
        &mut self,
        base: usize,
        count: usize,
        batch: &SplatProps,
        ln_scale: Option<&[f32]>,
    ) {
        let scale = ln_scale.unwrap_or(batch.scale);
        if !batch.center.is_empty()
            && (PACKED_OPACITY || !batch.opacity.is_empty())
            && !batch.rgb.is_empty()
            && !scale.is_empty()
            && !batch.quat.is_empty()
        {
            self.copy_sort_centers(base, count, batch.center);
            let encode = if ln_scale.is_some() {
                encode_splat_with_ln_scale
            } else {
                encode_splat
            };
            let encode_scale = if ln_scale.is_some() {
                encode_splat_ln_scale
            } else {
                encode_splat_scale
            };
            self.prepare_buffer(base, count, 0, true);
            self.prepare_buffer(base, count, 1, true);
            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                let center = array::from_fn(|d| batch.center[i3 + d]);
                let rgb = array::from_fn(|d| batch.rgb[i3 + d]);
                let scale = array::from_fn(|d| scale[i3 + d]);
                let quat = array::from_fn(|d| batch.quat[i4 + d]);
                let a = &mut self.buffer_a[i4..i4 + 4];
                let b = &mut self.buffer_b[i4..i4 + 4];
                if PACKED_OPACITY {
                    encode_splat_center(a, center);
                    a[3] = batch.opacity_packed[i];
                    encode_splat_rgb(b, rgb);
                    encode_scale(b, scale);
                    encode_splat_quat(b, quat);
                } else {
                    encode(a, b, center, batch.opacity[i], rgb, scale, quat);
                }
            }
            self.invalidate_zero_scale_sort_centers(base, count, scale, ln_scale.is_some());
        } else {
            if !batch.center.is_empty() {
                self.set_center(base, count, batch.center);
            }
            if PACKED_OPACITY {
                self.prepare_buffer(base, count, 0, false);
                for i in 0..count {
                    self.buffer_a[i * 4 + 3] = batch.opacity_packed[i];
                }
            } else if !batch.opacity.is_empty() {
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
        self.set_sh(base, count, batch.sh1, batch.sh2, batch.sh3, batch.sh4);
    }
}

impl SplatReceiver for SplatsData {
    fn reserve_decoder_memory(&mut self, bytes: usize) -> anyhow::Result<()> {
        let bytes = self.decoder_memory.max(bytes as u64);
        self.check_memory(self.output_memory, bytes)?;
        self.decoder_memory = bytes;
        Ok(())
    }

    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        let (max_splats, output_memory) = output_admission(
            init.num_splats,
            init.max_sh_degree,
            self.max_points,
            self.decoder_memory,
            self.memory_budget,
        )?;
        self.output_memory = output_memory;
        self.max_splats = max_splats;
        self.num_splats = init.num_splats;
        self.max_sh_degree = init.max_sh_degree;

        self.splat_arrays[0] = Uint32Array::new_with_length((max_splats * 4) as u32);
        self.splat_arrays[1] = Uint32Array::new_with_length((max_splats * 4) as u32);
        self.sort_centers = Float32Array::new_with_length((max_splats * 3) as u32);

        self.sh_block0 = if init.max_sh_degree < 1 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh_block1 = if init.max_sh_degree < 2 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh_block2 = if init.max_sh_degree < 3 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh_block3 = if init.max_sh_degree < 3 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh_block4 = if init.max_sh_degree < 4 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };
        self.sh_block5 = if init.max_sh_degree < 4 {
            None
        } else {
            Some(Uint32Array::new_with_length((max_splats * 4) as u32))
        };

        self.buffer_base = 0;
        self.buffer_count = 0;
        self.buffer_dirty = [false; 2];

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
        self.copy_sort_centers(base, count, center);
        self.prepare_buffer(base, count, 0, false);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_center(
                &mut self.buffer_a[i4..i4 + 4],
                array::from_fn(|d| center[i3 + d]),
            );
        }
    }

    fn set_opacity(&mut self, base: usize, count: usize, opacity: &[f32]) {
        self.prepare_buffer(base, count, 0, false);
        for (i, value) in opacity.iter().enumerate().take(count) {
            let i4 = i * 4;
            encode_splat_opacity(&mut self.buffer_a[i4..i4 + 4], *value);
        }
    }

    fn set_rgb(&mut self, base: usize, count: usize, rgb: &[f32]) {
        self.prepare_buffer(base, count, 1, false);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_rgb(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| rgb[i3 + d]),
            );
        }
    }

    fn set_scale(&mut self, base: usize, count: usize, scale: &[f32]) {
        self.prepare_buffer(base, count, 1, false);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_scale(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| scale[i3 + d]),
            );
        }
        self.invalidate_zero_scale_sort_centers(base, count, scale, false);
    }

    fn set_ln_scale(&mut self, base: usize, count: usize, ln_scale: &[f32]) {
        self.prepare_buffer(base, count, 1, false);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            encode_splat_ln_scale(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| ln_scale[i3 + d]),
            );
        }
        self.invalidate_zero_scale_sort_centers(base, count, ln_scale, true);
    }

    fn set_quat(&mut self, base: usize, count: usize, quat: &[f32]) {
        self.prepare_buffer(base, count, 1, false);
        for i in 0..count {
            let i4 = i * 4;
            encode_splat_quat(
                &mut self.buffer_b[i4..i4 + 4],
                array::from_fn(|d| quat[i4 + d]),
            );
        }
    }

    fn set_rgb_f16(&mut self, base: usize, count: usize, rgb: &[u16]) {
        self.prepare_buffer(base, count, 1, false);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            self.buffer_b[i4] = u32::from(rgb[i3]) | (u32::from(rgb[i3 + 1]) << 16);
            self.buffer_b[i4 + 1] = (self.buffer_b[i4 + 1] & 0xffff0000) | u32::from(rgb[i3 + 2]);
        }
    }

    fn set_ln_scale_f16(&mut self, base: usize, count: usize, scales: &[u16]) {
        self.prepare_buffer(base, count, 1, false);
        for i in 0..count {
            let [i3, i4] = [i * 3, i * 4];
            self.buffer_b[i4 + 1] =
                (self.buffer_b[i4 + 1] & 0xffff) | (u32::from(scales[i3]) << 16);
            self.buffer_b[i4 + 2] = u32::from(scales[i3 + 1]) | (u32::from(scales[i3 + 2]) << 16);
            if scales[i3..i3 + 3]
                .iter()
                .all(|&bits| bits == half::f16::NEG_INFINITY.to_bits())
            {
                for d in 0..3 {
                    self.sort_centers
                        .set_index(((base + i) * 3 + d) as u32, f32::NAN);
                }
            }
        }
    }

    fn set_quantized<F: Fn(usize, usize) -> u8>(
        &mut self,
        base: usize,
        count: usize,
        property: QuantizedProperty,
        lookup: &[ScalarLookup],
        code: F,
    ) {
        let opacity = matches!(property, QuantizedProperty::Opacity);
        self.prepare_buffer(base, count, usize::from(!opacity), false);
        let buffer = if opacity {
            &mut self.buffer_a
        } else {
            &mut self.buffer_b
        };
        for i in 0..count {
            let words = &mut buffer[i * 4..i * 4 + 4];
            if opacity {
                words[3] = lookup[0].packed[code(i, 0) as usize];
                continue;
            }
            let codes: [usize; 3] = array::from_fn(|d| code(i, d) as usize);
            let packed: [u32; 3] = array::from_fn(|d| lookup[d % lookup.len()].packed[codes[d]]);
            match property {
                QuantizedProperty::Rgb => {
                    words[0] = packed[0] | (packed[1] << 16);
                    words[1] = (words[1] & 0xffff0000) | packed[2];
                }
                QuantizedProperty::LnScale => {
                    words[1] = (words[1] & 0xffff) | (packed[0] << 16);
                    words[2] = packed[1] | (packed[2] << 16);
                    if (0..3)
                        .all(|d| lookup[d % lookup.len()].values[codes[d]] == f32::NEG_INFINITY)
                    {
                        for d in 0..3 {
                            self.sort_centers
                                .set_index(((base + i) * 3 + d) as u32, f32::NAN);
                        }
                    }
                }
                QuantizedProperty::Opacity => unreachable!(),
            }
        }
    }

    fn set_sh_packed<F: Fn(usize, usize) -> u32>(
        &mut self,
        base: usize,
        count: usize,
        band: usize,
        word: F,
    ) {
        if band > self.max_sh_degree {
            return;
        }
        self.invalidate_buffers();
        self.ensure_buffer_a(count);
        // Coefficients are consecutive across blocks: SH2 starts at sh_block0.w,
        // SH4 at sh_block3.w. Partial writes must preserve the other band's words.
        let offsets = [0, 3, 8, 15, 24];
        let (start, end) = (offsets[band - 1], offsets[band]);
        let outputs = [
            &self.sh_block0,
            &self.sh_block1,
            &self.sh_block2,
            &self.sh_block3,
            &self.sh_block4,
            &self.sh_block5,
        ];
        for (block, output) in outputs
            .iter()
            .enumerate()
            .take((end - 1) / 4 + 1)
            .skip(start / 4)
        {
            let Some(output) = output else {
                continue;
            };
            let first = start.max(block * 4);
            let last = end.min(block * 4 + 4);
            let target = output.subarray((base * 4) as u32, ((base + count) * 4) as u32);
            if last - first < 4 {
                if (block == 0 && self.sh_block1.is_some())
                    || (block == 3 && self.sh_block4.is_some())
                {
                    target.copy_to(&mut self.buffer_a);
                } else {
                    self.buffer_a.fill(0);
                }
            }
            for i in 0..count {
                for k in first..last {
                    self.buffer_a[i * 4 + k % 4] = word(i, k - start);
                }
            }
            target.copy_from(&self.buffer_a);
        }
    }

    fn set_sh_palette(
        &mut self,
        base: usize,
        count: usize,
        degree: usize,
        palette: &[u32],
        labels: &[u32],
    ) {
        self.invalidate_buffers();
        self.ensure_buffer_a(count);
        let stride = [0, 4, 8, 16, 24][degree];
        for (block, output) in [
            &self.sh_block0,
            &self.sh_block1,
            &self.sh_block2,
            &self.sh_block3,
            &self.sh_block4,
            &self.sh_block5,
        ]
        .into_iter()
        .enumerate()
        .take(stride / 4)
        {
            let Some(output) = output else { continue };
            for (i, &label) in labels.iter().take(count).enumerate() {
                let offset = label as usize * stride + block * 4;
                self.buffer_a[i * 4..i * 4 + 4].copy_from_slice(&palette[offset..offset + 4]);
            }
            output
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(&self.buffer_a);
        }
    }

    fn set_sh(
        &mut self,
        base: usize,
        count: usize,
        sh1: &[f32],
        sh2: &[f32],
        sh3: &[f32],
        sh4: &[f32],
    ) {
        if !sh1.is_empty() {
            self.set_sh1(base, count, sh1);
        }
        if !sh2.is_empty() {
            self.set_sh2(base, count, sh2);
        }
        if !sh3.is_empty() {
            self.set_sh3(base, count, sh3);
        }
        if !sh4.is_empty() {
            self.set_sh4(base, count, sh4);
        }
    }

    fn set_sh1(&mut self, base: usize, count: usize, sh1: &[f32]) {
        self.invalidate_buffers();
        self.ensure_buffer_a(count);
        if let Some(sh_block0) = self.sh_block0.as_ref() {
            let buffer = &mut self.buffer_a[0..count * 4];
            if self.sh_block1.is_some() {
                // The fourth word belongs to SH2 and must survive SH1 updates.
                sh_block0
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_to(buffer);
            } else {
                buffer.fill(0);
            }
            for i in 0..count {
                let [i3, i4] = [i * 3, i * 4];
                for k in 0..3 {
                    let k3 = (i3 + k) * 3;
                    buffer[i4 + k] = encode_splat_sh_rgb([sh1[k3], sh1[k3 + 1], sh1[k3 + 2]]);
                }
            }
            sh_block0
                .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                .copy_from(buffer);
        }
    }

    fn set_sh2(&mut self, base: usize, count: usize, sh2: &[f32]) {
        self.invalidate_buffers();
        self.ensure_buffers(count);
        if let Some(sh_block0) = self.sh_block0.as_ref() {
            if let Some(sh_block1) = self.sh_block1.as_ref() {
                let buffer_a = &mut self.buffer_a[0..count * 4];
                let buffer_b = &mut self.buffer_b[0..count * 4];
                sh_block0
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
                sh_block0
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_a);
                sh_block1
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_b);
            }
        }
    }

    fn set_sh3(&mut self, base: usize, count: usize, sh3: &[f32]) {
        self.invalidate_buffers();
        self.ensure_buffers(count);
        if let Some(sh_block2) = self.sh_block2.as_ref() {
            if let Some(sh_block3) = self.sh_block3.as_ref() {
                let buffer_a = &mut self.buffer_a[0..count * 4];
                let buffer_b = &mut self.buffer_b[0..count * 4];
                // The fourth word belongs to SH4 and must survive SH3 updates.
                if self.sh_block4.is_some() {
                    sh_block3
                        .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                        .copy_to(buffer_b);
                } else {
                    for words in buffer_b.chunks_exact_mut(4) {
                        words[3] = 0;
                    }
                }
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
                sh_block2
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_a);
                sh_block3
                    .subarray((base * 4) as u32, ((base + count) * 4) as u32)
                    .copy_from(&self.buffer_b);
            }
        }
    }

    fn set_sh4(&mut self, base: usize, count: usize, sh4: &[f32]) {
        self.set_sh_packed(base, count, 4, |i, k| {
            let offset = (i * 9 + k) * 3;
            encode_splat_sh_rgb([sh4[offset], sh4[offset + 1], sh4[offset + 2]])
        });
    }
}
