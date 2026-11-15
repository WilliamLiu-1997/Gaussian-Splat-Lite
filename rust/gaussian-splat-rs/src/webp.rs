//! libwebp shares Rust's heap and writes directly into the returned Vec.
use std::alloc::{alloc, alloc_zeroed, dealloc, Layout};
use std::ptr;

use anyhow::{ensure, Context, Result};

extern "C" {
    fn webp_info(bytes: *const u8, size: usize, result: *mut u32) -> i32;
    fn webp_decode_into(
        bytes: *const u8,
        size: usize,
        pixels: *mut u8,
        length: usize,
        width: i32,
        channels: i32,
    ) -> i32;
}

pub fn decode(bytes: &[u8]) -> Result<(Vec<u8>, usize, usize, usize)> {
    let mut info = [0; 3];
    // SAFETY: The C wrapper only reads the input and writes three u32 values.
    ensure!(
        unsafe { webp_info(bytes.as_ptr(), bytes.len(), info.as_mut_ptr()) } == 1,
        "invalid, animated or lossy WebP image"
    );
    let [width, height, channels] = info.map(|value| value as usize);
    let length = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(channels))
        .context("WebP dimensions overflow")?;
    let mut pixels = Vec::with_capacity(length);
    // SAFETY: libwebp bounds output by length. A successful decode initializes
    // every RGB(A) byte; on failure the Vec retains length zero.
    let status = unsafe {
        webp_decode_into(
            bytes.as_ptr(),
            bytes.len(),
            pixels.as_mut_ptr(),
            length,
            width as i32,
            channels as i32,
        )
    };
    ensure!(status != -1, "WebP decoder ran out of memory");
    ensure!(status == 1, "WebP decode failed");
    unsafe { pixels.set_len(length) };
    Ok((pixels, width, height, channels))
}

// C free has no size argument. Keep the allocation layout before its aligned
// pointer; only libwebp's temporary allocations use this header.
const HEADER: usize = 16;

unsafe fn allocate(size: usize, zeroed: bool) -> *mut u8 {
    let Some(total) = size.checked_add(HEADER) else {
        return ptr::null_mut();
    };
    let Ok(layout) = Layout::from_size_align(total, HEADER) else {
        return ptr::null_mut();
    };
    let memory = if zeroed {
        alloc_zeroed(layout)
    } else {
        alloc(layout)
    };
    if memory.is_null() {
        return memory;
    }
    memory.cast::<usize>().write(total);
    memory.add(HEADER)
}

#[no_mangle]
unsafe extern "C" fn gsl_webp_malloc(size: usize) -> *mut u8 {
    allocate(size, false)
}

#[no_mangle]
unsafe extern "C" fn gsl_webp_calloc(count: usize, size: usize) -> *mut u8 {
    match count.checked_mul(size) {
        Some(length) => allocate(length, true),
        None => ptr::null_mut(),
    }
}

#[no_mangle]
unsafe extern "C" fn gsl_webp_free(memory: *mut u8) {
    if !memory.is_null() {
        let start = memory.sub(HEADER);
        let total = start.cast::<usize>().read();
        dealloc(start, Layout::from_size_align_unchecked(total, HEADER));
    }
}
