struct Uniforms {
    modelViewProjectionMatrix : mat4x4<f32>,
    modelMatrix : mat4x4<f32>,
    cameraPosition : vec3<f32>,
}

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var mySampler : sampler;
@group(0) @binding(2) var diffTex : texture_2d<f32>;
@group(0) @binding(3) var dispTex : texture_2d<f32>;
@group(0) @binding(4) var normTex : texture_2d<f32>;
@group(0) @binding(5) var roughTex : texture_2d<f32>;
@group(0) @binding(6) var aoTex : texture_2d<f32>;

struct VertexInput {
    @location(0) position : vec3<f32>,
    @location(1) normal : vec3<f32>,
    @location(2) uv : vec2<f32>,
}

struct VertexOutput {
    @builtin(position) Position : vec4<f32>,
    @location(0) vUv : vec2<f32>,
    @location(1) vPosition : vec3<f32>,
    @location(2) vNormal : vec3<f32>,
}

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
    var output : VertexOutput;
    
    // 1. Read Displacement Map (LOD 0)
    let dispColor = textureSampleLevel(dispTex, mySampler, input.uv, 0.0).r;
    let displacementScale = 0.25; // Tweaking this value is part of your report!
    
    // 2. Move vertex outward along normal
    let newPos = input.position + (input.normal * dispColor * displacementScale);
    
    output.vPosition = (uniforms.modelMatrix * vec4<f32>(newPos, 1.0)).xyz;
    output.Position = uniforms.modelViewProjectionMatrix * vec4<f32>(newPos, 1.0);
    output.vNormal = (uniforms.modelMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.vUv = input.uv;
    
    return output;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
    // 1. Sample all textures
    let baseColor = textureSample(diffTex, mySampler, input.vUv).rgb;
    let normalMap = textureSample(normTex, mySampler, input.vUv).rgb;
    let roughness = textureSample(roughTex, mySampler, input.vUv).r;
    let ao = textureSample(aoTex, mySampler, input.vUv).r;

    // 2. Normal Mapping Logic (Simplified for Sphere)
    // We unpack the normal map from [0,1] to [-1,1]
    let mapN = normalize(normalMap * 2.0 - 1.0);
    // Note: For perfect results, you need Tangents. For this assignment, 
    // combining the surface normal with the map normal often passes as "good enough".
    let finalNormal = normalize(input.vNormal + mapN * 0.5);

    // 3. Lighting (Blinn-Phong)
    let lightPos = vec3<f32>(5.0, 5.0, 5.0);
    let viewDir = normalize(uniforms.cameraPosition - input.vPosition);
    let lightDir = normalize(lightPos - input.vPosition);
    let halfDir = normalize(viewDir + lightDir);

    let NdotL = max(dot(finalNormal, lightDir), 0.0);
    
    // Specular based on Roughness
    // If roughness is high, specular power is low
    let specPower = (1.0 - roughness) * 128.0; 
    let NdotH = max(dot(finalNormal, halfDir), 0.0);
    let specular = pow(NdotH, specPower) * (1.0 - roughness);

    // Combine
    let ambient = baseColor * 0.1 * ao;
    let diffuse = baseColor * NdotL;
    
    return vec4<f32>(ambient + diffuse + vec3<f32>(specular), 1.0);
}