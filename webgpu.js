async function main() {
    // 1. Setup WebGPU
    const canvas = document.getElementById('canvas');
    if (!navigator.gpu) { alert("WebGPU not supported on this browser."); return; }
    
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const shaderCode = await fetch('shaders.wgsl').then(res => res.text());
    
    context.configure({ device, format, alphaMode: 'premultiplied' });

    // 2. Create Geometry (The Sphere)
    // We generated separate arrays, but WebGPU likes one interleaved buffer:
    // [x,y,z, nx,ny,nz, u,v, ... ]
    const sphereData = createSphere(2, 256, 256); // Radius 2, 64 segments
    
    const vertexCount = sphereData.positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 8); // 3 pos + 3 norm + 2 uv
    
    for(let i=0; i < vertexCount; i++) {
        // Position
        interleavedData[i*8+0] = sphereData.positions[i*3+0];
        interleavedData[i*8+1] = sphereData.positions[i*3+1];
        interleavedData[i*8+2] = sphereData.positions[i*3+2];
        // Normal
        interleavedData[i*8+3] = sphereData.normals[i*3+0];
        interleavedData[i*8+4] = sphereData.normals[i*3+1];
        interleavedData[i*8+5] = sphereData.normals[i*3+2];
        // UV
        interleavedData[i*8+6] = sphereData.uvs[i*2+0];
        interleavedData[i*8+7] = sphereData.uvs[i*2+1];
    }

    const vertexBuffer = device.createBuffer({
        size: interleavedData.byteLength,
        usage: GPUBufferUsage.VERTEX,
        mappedAtCreation: true
    });
    new Float32Array(vertexBuffer.getMappedRange()).set(interleavedData);
    vertexBuffer.unmap();

    const indexBuffer = device.createBuffer({
        size: sphereData.indices.byteLength,
        usage: GPUBufferUsage.INDEX,
        mappedAtCreation: true
    });
    new Uint16Array(indexBuffer.getMappedRange()).set(sphereData.indices);
    indexBuffer.unmap();

    // 3. Load Textures (Replace these URLs with your local files or direct links)
    // IMPORTANT: Polyhaven textures are large. Wait for them.
    console.log("Loading textures...");
    const diffTex = await loadTexture(device, './textures/diffuse.jpg');
    const dispTex = await loadTexture(device, './textures/disp.jpg');
    const normTex = await loadTexture(device, './textures/normal.jpg'); // purple
    const roughTex = await loadTexture(device, './textures/rough.jpg'); // b&w
    const aoTex = await loadTexture(device, './textures/ao.jpg');       // white-ish
    console.log("Textures loaded.");

    const sampler = device.createSampler({
        magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
        addressModeU: 'repeat', addressModeV: 'repeat'
    });

    // 4. Uniforms (Matrices)
    // We need space for: MVP (16 floats), Model (16 floats), CamPos (3 floats + 1 pad)
    // Total = 36 floats * 4 bytes = 144 bytes
    const uniformBufferSize = 144;
    const uniformBuffer = device.createBuffer({
        size: uniformBufferSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // 5. The Pipeline
    const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: device.createShaderModule({ code: shaderCode }),
            entryPoint: 'vs_main',
            buffers: [{
                arrayStride: 32, // 8 floats * 4 bytes
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },  // Position
                    { shaderLocation: 1, offset: 12, format: 'float32x3' }, // Normal
                    { shaderLocation: 2, offset: 24, format: 'float32x2' }  // UV
                ]
            }]
        },
        fragment: {
            module: device.createShaderModule({ code: shaderCode }),
            entryPoint: 'fs_main',
            targets: [{ format: format }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: {
            depthWriteEnabled: true,
            depthCompare: 'less',
            format: 'depth24plus',
        }
    });

    // 6. Bind Groups (Connecting Resources)
    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: diffTex.createView() },
            { binding: 3, resource: dispTex.createView() },
            { binding: 4, resource: normTex.createView() },
            { binding: 5, resource: roughTex.createView() },
            { binding: 6, resource: aoTex.createView() },
        ]
    });

    // 7. Depth Texture (Z-Buffer)
    let depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    // 8. Math Helpers (Manual Matrices)
    const aspect = canvas.width / canvas.height;
    const projection = perspective(45, aspect, 0.1, 100.0);
    //const view = SimpleMath.lookAt([0, 0, 6], [0, 0, 0], [0, 1, 0]); // Camera at (0,0,6)
    const view = lookAt(vec3(0, 0, 6), vec3(0, 0, 0), vec3(0, 1, 0));
    
    // 9. Render Loop
    function frame() {
        // A. Update Rotation
        const time = Date.now() / 1000;
        const model = rotateY(time * -10);
        
        // B. Calculate MVP
        const viewModel = mult(view, model);
        const mvp = mult(projection, viewModel);
        
        // C. Upload to GPU
        const uniformData = new Float32Array(36);
        uniformData.set(flatten(mvp), 0);       // MVP Matrix
        uniformData.set(flatten(model), 16);    // Model Matrix
        uniformData.set(new Float32Array([0, 0, 6, 0]), 32); // Camera Pos
        device.queue.writeBuffer(uniformBuffer, 0, uniformData);

        // D. Draw
        const commandEncoder = device.createCommandEncoder();
        const pass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
                loadOp: 'clear', storeOp: 'store'
            }],
            depthStencilAttachment: {
                view: depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear', depthStoreOp: 'store'
            }
        });

        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, vertexBuffer);
        pass.setIndexBuffer(indexBuffer, 'uint16');
        pass.drawIndexed(sphereData.indices.length);
        pass.end();

        device.queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(frame);
    }
    
    requestAnimationFrame(frame);
}

function createSphere(radius, widthSegments, heightSegments) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    for (let y = 0; y <= heightSegments; y++) {
        const v = y / heightSegments;
        const theta = v * Math.PI; // 0 to Pi

        for (let x = 0; x <= widthSegments; x++) {
            const u = x / widthSegments;
            const phi = u * 2 * Math.PI; // 0 to 2Pi

            // Spherical to Cartesian conversion
            const px = -radius * Math.cos(phi) * Math.sin(theta);
            const py = radius * Math.cos(theta);
            const pz = radius * Math.sin(phi) * Math.sin(theta);

            positions.push(px, py, pz);
            normals.push(px/radius, py/radius, pz/radius); // Normal is just position normalized
            uvs.push(u, 1 - v); // Invert V for WebGPU usually
        }
    }

    for (let y = 0; y < heightSegments; y++) {
        for (let x = 0; x < widthSegments; x++) {
            const first = (y * (widthSegments + 1)) + x;
            const second = first + widthSegments + 1;
            indices.push(first, second, first + 1);
            indices.push(second, second + 1, first + 1);
        }
    }

    return { 
        positions: new Float32Array(positions), 
        normals: new Float32Array(normals), 
        uvs: new Float32Array(uvs), 
        indices: new Uint16Array(indices),
        count: indices.length
    };
}

async function loadTexture(device, url) {
    const res = await fetch(url);
    const blob = await res.blob();
    const source = await createImageBitmap(blob);

    const texture = device.createTexture({
        size: [source.width, source.height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    device.queue.copyExternalImageToTexture(
        { source: source },
        { texture: texture },
        [source.width, source.height]
    );
    return texture;
}

// NEW Helper: Generates textures in memory so you don't need files
function createProceduralTexture(device, type) {
    const size = 256;
    const texData = new Uint8Array(size * size * 4); // RGBA

    for (let i = 0; i < size * size; i++) {
        const x = i % size;
        const y = Math.floor(i / size);
        
        // Create a large checkerboard pattern (32x32 pixels per square)
        const check = ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0);

        let r = 0, g = 0, b = 0, a = 255;

        if (type === 'diffuse') {
            // Red and Blue checkerboard
            r = check ? 255 : 0;
            g = 0;
            b = check ? 0 : 255;
        } else if (type === 'disp') {
            // Black and White checkerboard (High contrast for visible bumps)
            // White = Stick out, Black = Dig in
            const val = check ? 255 : 0;
            r = g = b = val;
        } else if (type === 'normal') {
            // Flat Normal map color (Purple-ish Blue)
            // Represents vector (0, 0, 1)
            r = 128; g = 128; b = 255;
        } else if (type === 'rough') {
            // Solid Grey (Medium shininess)
            r = g = b = 128; 
        } else if (type === 'ao') {
            // Solid White (No shadows)
            r = g = b = 255;
        }

        const index = i * 4;
        texData[index] = r;
        texData[index + 1] = g;
        texData[index + 2] = b;
        texData[index + 3] = a;
    }

    const texture = device.createTexture({
        size: [size, size],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    device.queue.writeTexture(
        { texture: texture },
        texData,
        { bytesPerRow: size * 4 },
        { width: size, height: size }
    );
    return texture;
}

function updateTexturePattern(device, texture, type, style) {
    const size = 256;
    const texData = new Uint8Array(size * size * 4);

    for (let i = 0; i < size * size; i++) {
        const x = i % size;
        const y = Math.floor(i / size);
        let check = false;

        // --- PATTERN LOGIC ---
        if (style === 'checker') {
            // Standard Checkerboard
            check = ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0);
        } else if (style === 'stripes') {
            // Horizontal Stripes
            check = (Math.floor(y / 16) % 2 === 0);
        }

        let r = 0, g = 0, b = 0, a = 255;

        // --- COLOR LOGIC ---
        if (type === 'diffuse') {
            if (style === 'checker') {
                r = check ? 255 : 0; b = check ? 0 : 255; // Red/Blue
            } else {
                r = check ? 218 : 30; g = check ? 165 : 30; b = check ? 32 : 30; // Gold/DarkGreen
            }
        } else if (type === 'disp') {
            const val = check ? 255 : 0; r = g = b = val; 
        } else if (type === 'normal') {
            r = 128; g = 128; b = 255; // Keep normals flat for simplicity
        } else if (type === 'rough') {
            // Stripes are shiny (black), Checker is mixed
            r = g = b = (style === 'stripes' && check) ? 10 : 128; 
        } else if (type === 'ao') {
            r = g = b = 255;
        }

        const index = i * 4;
        texData[index] = r; texData[index+1] = g; texData[index+2] = b; texData[index+3] = a;
    }

    // Upload new data to the EXISTING texture object
    device.queue.writeTexture(
        { texture: texture },
        texData,
        { bytesPerRow: size * 4 },
        { width: size, height: size }
    );
}

main();