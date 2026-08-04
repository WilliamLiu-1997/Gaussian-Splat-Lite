import { Ray, Vector3 } from "three";

const _scaledOrigin = new Vector3();
const _scaledDirection = new Vector3();
const _scaledPoint = new Vector3();
const _scaledRay = new Ray();
const _zero = new Vector3();

/**
 * Axis-aligned ellipsoid centered at the origin.
 */
class Ellipsoid {
  constructor(x = 1, y = 1, z = 1) {
    this.radius = new Vector3(x, y, z);
  }

  intersectRay(ray, target) {
    const { x, y, z } = this.radius;
    if (x <= 0 || y <= 0 || z <= 0) {
      return null;
    }

    _scaledOrigin.set(ray.origin.x / x, ray.origin.y / y, ray.origin.z / z);
    _scaledDirection.set(
      ray.direction.x / x,
      ray.direction.y / y,
      ray.direction.z / z,
    );

    // Intersect the ray with a unit sphere in ellipsoid-scaled space. Keep
    // the original ray parameter so the resulting point is in world space.
    const a = _scaledDirection.lengthSq();
    if (a === 0) {
      return null;
    }
    const halfB = _scaledOrigin.dot(_scaledDirection);
    const c = _scaledOrigin.lengthSq() - 1;
    const discriminant = halfB * halfB - a * c;
    if (discriminant < 0) {
      return null;
    }

    const sqrtDiscriminant = Math.sqrt(discriminant);
    const near = (-halfB - sqrtDiscriminant) / a;
    const far = (-halfB + sqrtDiscriminant) / a;
    const distance = near >= 0 ? near : far >= 0 ? far : null;
    return distance === null ? null : ray.at(distance, target);
  }

  getPositionToNormal(position, target) {
    const { x, y, z } = this.radius;
    target.set(
      x > 0 ? position.x / (x * x) : 0,
      y > 0 ? position.y / (y * y) : 0,
      z > 0 ? position.z / (z * z) : 0,
    );
    return target.normalize();
  }

  closestPointToRayEstimate(ray, target) {
    const intersection = this.intersectRay(ray, target);
    if (intersection) {
      return intersection;
    }

    const { x, y, z } = this.radius;
    if (x <= 0 || y <= 0 || z <= 0) {
      return target.set(0, 0, 0);
    }

    _scaledRay.origin.set(ray.origin.x / x, ray.origin.y / y, ray.origin.z / z);
    _scaledRay.direction
      .set(ray.direction.x / x, ray.direction.y / y, ray.direction.z / z)
      .normalize();
    _scaledRay.closestPointToPoint(_zero, _scaledPoint);

    // A ray through the center has no unique radial estimate. Choose the
    // surface point facing its origin, or the point opposite its direction
    // when the ray also starts at the center.
    if (_scaledPoint.lengthSq() === 0) {
      _scaledPoint.copy(_scaledRay.origin);
      if (_scaledPoint.lengthSq() === 0) {
        _scaledPoint.copy(_scaledRay.direction).negate();
      }
    }

    _scaledPoint.normalize();
    return target.set(
      _scaledPoint.x * x,
      _scaledPoint.y * y,
      _scaledPoint.z * z,
    );
  }
}

export { Ellipsoid };
