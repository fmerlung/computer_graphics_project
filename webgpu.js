"use strict";
window.onload = function () {
    main();
};

const textureSets = {
    set1: { folder: 'bricks', name: 'bricks' },
    set2: { folder: 'tree', name: 'tree' },
    set3: { folder: 'rocks', name: 'rocks' }
};
let currentBindGroup = null;
let currentLoadedTextures = {};
let defaultTextures = {};
let pipeline = null;
let uniformBuffer = null;
let sampler = null;

async function main() {
    const canvas = document.getElementById('canvas');
    if (!navigator.gpu) { alert("WebGPU not supported"); return; }
    
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    const shaderCode = await fetch('./shaders.wgsl').then(res => res.text());
    context.configure({ device, format, alphaMode: 'premultiplied' });

    // Create default textures for when a layer is disabled in the ui
    // Diffuse Off: Grey = (128, 128, 128)
    defaultTextures.diffuse = createDefaultTexture(device, [128, 128, 128, 255]); 
    // Normal Off: Flat Blue (128, 128, 255)
    defaultTextures.normal = createDefaultTexture(device, [128, 128, 255, 255]);
    // Disp Off: Black (No height)
    defaultTextures.disp = createDefaultTexture(device, [0, 0, 0, 255]);
    // Rough Off: Grey (Medium shiny)
    defaultTextures.rough = createDefaultTexture(device, [128, 128, 128, 255]);
    // AO Off: White (No shadow)
    defaultTextures.ao = createDefaultTexture(device, [255, 255, 255, 255]);

    // Load default texture set
    await loadTextureSet(device, textureSets.set1.folder);

    // Generate sphere geometry
    const sphereData = createSphere(1.75, 128, 128);

    // Map sphere data to Float32Array
    const vertexCount = sphereData.positions.length / 3;
    const interleavedData = new Float32Array(vertexCount * 8); 
    for(let i=0; i < vertexCount; i++) {
        interleavedData[i*8+0] = sphereData.positions[i*3+0];
        interleavedData[i*8+1] = sphereData.positions[i*3+1];
        interleavedData[i*8+2] = sphereData.positions[i*3+2];
        interleavedData[i*8+3] = sphereData.normals[i*3+0];
        interleavedData[i*8+4] = sphereData.normals[i*3+1];
        interleavedData[i*8+5] = sphereData.normals[i*3+2];
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

    sampler = device.createSampler({
        magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
        addressModeU: 'repeat', addressModeV: 'repeat'
    });

    uniformBuffer = device.createBuffer({
        size: 144,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
            module: device.createShaderModule({ code: shaderCode }),
            entryPoint: 'vs_main',
            buffers: [{
                arrayStride: 32,
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' },
                    { shaderLocation: 2, offset: 24, format: 'float32x2' }
                ]
            }]
        },
        fragment: {
            module: device.createShaderModule({ code: shaderCode }),
            entryPoint: 'fs_main',
            targets: [{ format: format }]
        },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { depthWriteEnabled: true, depthCompare: 'less', format: 'depth24plus' }
    });


    let depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    document.getElementById('btnSet1').onclick = () => loadTextureSet(device, textureSets.set1.folder);
    document.getElementById('btnSet2').onclick = () => loadTextureSet(device, textureSets.set2.folder);
    document.getElementById('btnSet3').onclick = () => loadTextureSet(device, textureSets.set3.folder);
    
    const checkboxes = ['chkDiff', 'chkDisp', 'chkNorm', 'chkRough', 'chkAO'];
    checkboxes.forEach(id => {
        document.getElementById(id).onchange = () => updateBindGroup(device);
    });

    updateBindGroup(device);

    const aspect = canvas.width / canvas.height;
    const projection = perspective(45, aspect, 0.1, 100.0);
    const view = lookAt(vec3(0, 0, 6), vec3(0, 0, 0), vec3(0, 1, 0));

    // Render loop
    function frame() {
        const time = Date.now() / 1000;
        // Slowly rotate sphere over time
        const model = rotateY(time * -10); 
        const viewModel = mult(view, model);
        const mvp = mult(projection, viewModel);
        
        device.queue.writeBuffer(uniformBuffer, 0, flatten(mvp));
        device.queue.writeBuffer(uniformBuffer, 64, flatten(model));
        device.queue.writeBuffer(uniformBuffer, 128, new Float32Array([0, 0, 6, 0]));

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
        if (currentBindGroup) pass.setBindGroup(0, currentBindGroup);
        
        pass.setVertexBuffer(0, vertexBuffer);
        pass.setIndexBuffer(indexBuffer, 'uint16');
        pass.drawIndexed(sphereData.indices.length);
        pass.end();

        device.queue.submit([commandEncoder.finish()]);
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

async function loadTextureFile(device, url) {
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

async function loadTextureSet(device, folderName) {
    console.log(`Loading set: ${folderName}...`);
    try {
        currentLoadedTextures.diffuse = await loadTextureFile(device, `./textures/${folderName}/diffuse.jpg`);
        currentLoadedTextures.disp = await loadTextureFile(device, `./textures/${folderName}/disp.jpg`);
        currentLoadedTextures.normal = await loadTextureFile(device, `./textures/${folderName}/normal.jpg`);
        currentLoadedTextures.rough = await loadTextureFile(device, `./textures/${folderName}/rough.jpg`);
        currentLoadedTextures.ao = await loadTextureFile(device, `./textures/${folderName}/ao.jpg`);
        
        console.log(`Textures from 'textures/${folderName}' loaded successfully.`);
        updateBindGroup(device);
    } catch (e) {
        console.error(`Error loading textures from 'textures/${folderName}`, e);
    }
}

function updateBindGroup(device) {
    if (!pipeline || !currentLoadedTextures.diffuse) return;

    // Check if checkbox is checked, else use default texture
    const getTex = (id, type) => {
        const isChecked = document.getElementById(id).checked;
        return isChecked ? currentLoadedTextures[type] : defaultTextures[type];
    };

    currentBindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: getTex('chkDiff', 'diffuse').createView() },
            { binding: 3, resource: getTex('chkDisp', 'disp').createView() },
            { binding: 4, resource: getTex('chkNorm', 'normal').createView() },
            { binding: 5, resource: getTex('chkRough', 'rough').createView() },
            { binding: 6, resource: getTex('chkAO', 'ao').createView() },
        ]
    });
}

function createDefaultTexture(device, color) {
    const texture = device.createTexture({
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const data = new Uint8Array(color); // [R, G, B, A]
    device.queue.writeTexture(
        { texture: texture },
        data,
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
    );
    return texture;
}

function createSphere(radius, widthSegments, heightSegments) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];

    // Map position, normals and uvs
    for (let y = 0; y <= heightSegments; y++) {
        const v = y / heightSegments;
        const theta = v * Math.PI; // 0 to Pi

        for (let x = 0; x <= widthSegments; x++) {
            const u = x / widthSegments;
            const phi = u * 2 * Math.PI; // 0 to 2Pi

            // Convert to Cartesian coordinates
            const px = -radius * Math.cos(phi) * Math.sin(theta);
            const py = radius * Math.cos(theta);
            const pz = radius * Math.sin(phi) * Math.sin(theta);

            positions.push(px, py, pz);
            normals.push(px/radius, py/radius, pz/radius);
            uvs.push(u, 1 - v); // Invert V for WebGPU
        }
    }

    // Map indices
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
