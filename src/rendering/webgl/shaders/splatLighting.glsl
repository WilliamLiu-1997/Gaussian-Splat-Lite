uniform bool lightingEnabled;
uniform bool encodeLinear;
uniform mat4 viewToWorld;
flat in vec4 vNormalFlags;
flat in vec2 vGradient;
in vec3 vSurfaceView;

vec3 splatLighting(vec3 color) {
    vec3 point = vSurfaceView;
    float z = min(point.z + dot(vGradient, vSplatUv), -1e-6);
    point = isOrthographic ? vec3(point.xy, z) : point * (z / point.z);
    vec3 normal = normalize(vNormalFlags.xyz);
    vec3 worldNormal = normalize(mat3(viewToWorld) * normal);
    vec3 worldPoint = (viewToWorld * vec4(point, 1.0)).xyz;
    bool shadows = (uint(vNormalFlags.w) & 2u) != 0u;
    vec3 irradiance = ambientLightColor;
    IncidentLight light;
    #pragma unroll_loop_start
    for (int i = 0; i < NUM_HEMI_LIGHTS; i++) {
        irradiance += getHemisphereLightIrradiance(hemisphereLights[i], normal);
    }
    #pragma unroll_loop_end
    #pragma unroll_loop_start
    for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
        {
        getDirectionalLightInfo(directionalLights[i], light);
        float visibility = 1.0;
        #if defined(USE_SHADOWMAP) && UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS
        if (shadows && dot(normal, light.direction) > 0.0) {
            DirectionalLightShadow shadow = directionalLightShadows[i];
            vec4 coord = directionalShadowMatrix[i] * vec4(worldPoint + worldNormal * shadow.shadowNormalBias, 1.0);
            visibility = getShadow(directionalShadowMap[i], shadow.shadowMapSize, shadow.shadowIntensity, shadow.shadowBias, shadow.shadowRadius, coord);
        }
        #endif
        irradiance += light.color * max(dot(normal, light.direction), 0.0) * visibility;
        }
    }
    #pragma unroll_loop_end
    #pragma unroll_loop_start
    for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
        {
        getPointLightInfo(pointLights[i], point, light);
        float visibility = 1.0;
        #if defined(USE_SHADOWMAP) && UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS
        if (shadows && light.visible && dot(normal, light.direction) > 0.0) {
            PointLightShadow shadow = pointLightShadows[i];
            vec4 coord = pointShadowMatrix[i] * vec4(worldPoint + worldNormal * shadow.shadowNormalBias, 1.0);
            visibility = getPointShadow(pointShadowMap[i], shadow.shadowMapSize, shadow.shadowIntensity, shadow.shadowBias, shadow.shadowRadius, coord, shadow.shadowCameraNear, shadow.shadowCameraFar);
        }
        #endif
        irradiance += light.color * max(dot(normal, light.direction), 0.0) * visibility;
        }
    }
    #pragma unroll_loop_end
    #pragma unroll_loop_start
    for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
        {
        getSpotLightInfo(spotLights[i], point, light);
        float visibility = 1.0;
        #if defined(USE_SHADOWMAP) && UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS
        if (shadows && light.visible && dot(normal, light.direction) > 0.0) {
            SpotLightShadow shadow = spotLightShadows[i];
            vec4 coord = spotLightMatrix[i] * vec4(worldPoint + worldNormal * shadow.shadowNormalBias, 1.0);
            visibility = getShadow(spotShadowMap[i], shadow.shadowMapSize, shadow.shadowIntensity, shadow.shadowBias, shadow.shadowRadius, coord);
        }
        #endif
        irradiance += light.color * max(dot(normal, light.direction), 0.0) * visibility;
        }
    }
    #pragma unroll_loop_end
    // Main WebGL's canvas blending can be sRGB. Lighting is always linear.
    vec3 linearColor = encodeLinear ? color : sRGBTransferEOTF(vec4(color, 1.0)).rgb;
    linearColor *= irradiance * RECIPROCAL_PI;
    return encodeLinear ? linearColor : sRGBTransferOETF(vec4(linearColor, 1.0)).rgb;
}
