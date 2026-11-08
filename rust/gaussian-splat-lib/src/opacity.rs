//! Convert linear Gaussian mass to GSL's wide-kernel opacity.
use std::{array, sync::LazyLock};

const EULER_GAMMA: f64 = 0.577_215_664_901_532_9;

pub(crate) fn sog_opacity_lookup() -> [f32; 256] {
    static VALUES: LazyLock<[f32; 256]> =
        LazyLock::new(|| array::from_fn(|byte| mass_to_opacity((byte as f32 / 204.0).powi(2))));
    *VALUES
}

pub(crate) fn mass_to_opacity(mass: f32) -> f32 {
    if mass <= 1.0 {
        return mass;
    }
    let target = f64::from(mass);
    let mut power = (target - EULER_GAMMA).exp();
    if power >= f64::from(f32::MAX) {
        return f32::MAX;
    }
    power -= 0.5;
    // Newton steps from the asymptotic inverse reach float32 precision.
    for _ in 0..3 {
        let (value, slope) = kernel_mass(power);
        power -= (value - target) / slope;
    }
    power as f32
}

fn kernel_mass(power: f64) -> (f64, f64) {
    // Full radial mass / (2π) of 1 - (1 - exp(-r²/2))^power is ψ(power + 1) + γ.
    // Evaluate ψ by recurrence and its asymptotic expansion: dlmf.nist.gov/5.11.E2.
    let mut x = power + 1.0;
    let mut mass = EULER_GAMMA;
    let mut slope = 0.0;
    while x < 8.0 {
        mass -= 1.0 / x;
        slope += 1.0 / (x * x);
        x += 1.0;
    }
    let inv = 1.0 / x;
    let inv2 = inv * inv;
    mass += x.ln()
        - 0.5 * inv
        - inv2 * (1.0 / 12.0 - inv2 * (1.0 / 120.0 - inv2 * (1.0 / 252.0 - inv2 / 240.0)));
    slope += inv
        + 0.5 * inv2
        + inv * inv2 * (1.0 / 6.0 - inv2 * (1.0 / 30.0 - inv2 * (1.0 / 42.0 - inv2 / 30.0)));
    (mass, slope)
}
