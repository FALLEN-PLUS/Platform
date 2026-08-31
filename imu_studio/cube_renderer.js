"use strict";

/**
 * IMU Motion Studio · 原生 WebGL 3D 姿态正方体渲染器 (VOFA+ 1:1 黄金比例高颜值版)
 */

class Mat4
{
    static create()
    {
        return new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
    }

    static multiply(out, a, b)
    {
        const result = new Float32Array(16);
        for (let column = 0; column < 4; column++)
        {
            for (let row = 0; row < 4; row++)
            {
                let value = 0;
                for (let index = 0; index < 4; index++)
                {
                    value += a[index * 4 + row] * b[column * 4 + index];
                }
                result[column * 4 + row] = value;
            }
        }
        out.set(result);
        return out;
    }

    static perspective(out, fovy, aspect, near, far)
    {
        const f = 1.0 / Math.tan(fovy / 2);
        const nf = 1 / (near - far);
        out[0] = f / aspect;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        out[4] = 0;
        out[5] = f;
        out[6] = 0;
        out[7] = 0;
        out[8] = 0;
        out[9] = 0;
        out[10] = (far + near) * nf;
        out[11] = -1;
        out[12] = 0;
        out[13] = 0;
        out[14] = (2 * far * near) * nf;
        out[15] = 0;
        return out;
    }

    static lookAt(out, eye, center, up)
    {
        let x0, x1, x2, y0, y1, y2, z0, z1, z2, len;
        const eyex = eye[0], eyey = eye[1], eyez = eye[2];
        const upx = up[0], upy = up[1], upz = up[2];
        const centerx = center[0], centery = center[1], centerz = center[2];

        z0 = eyex - centerx;
        z1 = eyey - centery;
        z2 = eyez - centerz;
        len = 1 / Math.hypot(z0, z1, z2);
        z0 *= len; z1 *= len; z2 *= len;

        x0 = upy * z2 - upz * z1;
        x1 = upz * z0 - upx * z2;
        x2 = upx * z1 - upy * z0;
        len = 1 / Math.hypot(x0, x1, x2);
        x0 *= len; x1 *= len; x2 *= len;

        y0 = z1 * x2 - z2 * x1;
        y1 = z2 * x0 - z0 * x2;
        y2 = z0 * x1 - z1 * x0;
        len = 1 / Math.hypot(y0, y1, y2);
        y0 *= len; y1 *= len; y2 *= len;

        out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
        out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
        out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
        out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
        out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
        out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
        out[15] = 1;
        return out;
    }

    static fromQuat(out, q)
    {
        let x = q[1], y = q[2], z = q[3], w = q[0];
        let len = Math.hypot(w, x, y, z);
        if (len < 1e-9) { len = 1; }
        const s = 1.0 / len;
        x *= s; y *= s; z *= s; w *= s;

        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;

        out[0] = 1 - (yy + zz);
        out[1] = xy + wz;
        out[2] = xz - wy;
        out[3] = 0;

        out[4] = xy - wz;
        out[5] = 1 - (xx + zz);
        out[6] = yz + wx;
        out[7] = 0;

        out[8] = xz + wy;
        out[9] = yz - wx;
        out[10] = 1 - (xx + yy);
        out[11] = 0;

        out[12] = 0;
        out[13] = 0;
        out[14] = 0;
        out[15] = 1;
        return out;
    }

    static fromEuler(out, rollRad, pitchRad, yawRad)
    {
        const cr = Math.cos(rollRad), sr = Math.sin(rollRad);
        const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);
        const cy = Math.cos(yawRad), sy = Math.sin(yawRad);

        out[0] = cy * cp;
        out[1] = sy * cp;
        out[2] = -sp;
        out[3] = 0;

        out[4] = cy * sp * sr - sy * cr;
        out[5] = sy * sp * sr + cy * cr;
        out[6] = cp * sr;
        out[7] = 0;

        out[8] = cy * sp * cr + sy * sr;
        out[9] = sy * sp * cr - cy * sr;
        out[10] = cp * cr;
        out[11] = 0;

        out[12] = 0;
        out[13] = 0;
        out[14] = 0;
        out[15] = 1;
        return out;
    }
}

class ImuCubeRenderer
{
    constructor(canvas)
    {
        this.canvas = canvas;
        this.gl = canvas.getContext("webgl", { antialias: true, alpha: true }) || canvas.getContext("experimental-webgl");
        if (!this.gl)
        {
            throw new Error("当前浏览器不支持 WebGL");
        }

        // 观察视角与显示开关
        this.cameraDistance = 4.6;
        this.cameraPitch = 0.42;
        this.cameraYaw = 0.78;
        this.showGrid = true;
        this.showAxes = true;

        this.poseMatrix = Mat4.create();
        this.sensorPoseMatrix = Mat4.create();
        this.sensorToWorldMatrix = new Float32Array([
            1, 0, 0, 0,
            0, 0, -1, 0,
            0, 1, 0, 0,
            0, 0, 0, 1
        ]);
        Mat4.multiply(this.poseMatrix, this.sensorToWorldMatrix, this.sensorPoseMatrix);
        this.currentEuler = { roll: 0, pitch: 0, yaw: 0 };
        this.currentQuat = [1, 0, 0, 0];
        this.tareOffset = { roll: 0, pitch: 0, yaw: 0 };

        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.initShaders();
        this.initBuffers();
        this.bindEvents();

        this.resize();
        this.render();
    }

    initShaders()
    {
        const gl = this.gl;

        const vsSource = `
            attribute vec3 aPosition;
            attribute vec3 aNormal;
            attribute vec4 aColor;

            uniform mat4 uProjection;
            uniform mat4 uView;
            uniform mat4 uModel;

            varying vec4 vColor;
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            varying vec3 vViewPos;

            void main() {
                vec4 worldPos = uModel * vec4(aPosition, 1.0);
                vec4 viewPos = uView * worldPos;
                gl_Position = uProjection * viewPos;
                vWorldPos = worldPos.xyz;
                vViewPos = viewPos.xyz;
                vNormal = normalize(mat3(uModel) * aNormal);
                vColor = aColor;
            }
        `;

        const fsSource = `
            precision mediump float;
            varying vec4 vColor;
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            varying vec3 vViewPos;

            void main() {
                vec3 N = normalize(vNormal);
                vec3 V = normalize(-vViewPos);
                
                // 主光源 (暖白科技主光 + Blinn-Phong 镜面高光)
                vec3 L1 = normalize(vec3(1.5, 2.4, 2.0));
                float diff1 = max(dot(N, L1), 0.0);
                vec3 H1 = normalize(L1 + V);
                float spec1 = pow(max(dot(N, H1), 0.0), 32.0) * 0.52;
                
                // 辅助轮廓背光 (冷蓝反光)
                vec3 L2 = normalize(vec3(-1.8, -1.2, -1.5));
                float diff2 = max(dot(N, L2), 0.0) * 0.26;

                // 晶体菲涅尔掠射边缘高光 (Fresnel Rim Lighting)
                float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.2) * 0.32;
                
                float ambient = 0.58;
                vec3 litColor = vColor.rgb * (ambient + diff1 * 0.42 + diff2) + vec3(1.0, 1.0, 1.0) * spec1 + vec3(0.0, 0.44, 0.89) * fresnel;
                gl_FragColor = vec4(litColor, vColor.a);
            }
        `;

        this.program = this.createProgram(vsSource, fsSource);
        this.locations = {
            aPosition: gl.getAttribLocation(this.program, "aPosition"),
            aNormal: gl.getAttribLocation(this.program, "aNormal"),
            aColor: gl.getAttribLocation(this.program, "aColor"),
            uProjection: gl.getUniformLocation(this.program, "uProjection"),
            uView: gl.getUniformLocation(this.program, "uView"),
            uModel: gl.getUniformLocation(this.program, "uModel")
        };

        const lineVsSource = `
            attribute vec3 aPosition;
            attribute vec4 aColor;
            uniform mat4 uProjection;
            uniform mat4 uView;
            uniform mat4 uModel;
            varying vec4 vColor;
            void main() {
                gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
                vColor = aColor;
            }
        `;
        const lineFsSource = `
            precision mediump float;
            varying vec4 vColor;
            void main() {
                gl_FragColor = vColor;
            }
        `;
        this.lineProgram = this.createProgram(lineVsSource, lineFsSource);
        this.lineLocations = {
            aPosition: gl.getAttribLocation(this.lineProgram, "aPosition"),
            aColor: gl.getAttribLocation(this.lineProgram, "aColor"),
            uProjection: gl.getUniformLocation(this.lineProgram, "uProjection"),
            uView: gl.getUniformLocation(this.lineProgram, "uView"),
            uModel: gl.getUniformLocation(this.lineProgram, "uModel")
        };
    }

    createProgram(vsSource, fsSource)
    {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSource);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSource);
        gl.compileShader(fs);

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        return prog;
    }

    initBuffers()
    {
        const gl = this.gl;

        // ----------------------------------------------------
        // A. 3D 正方体网格 (Apple Light Studio 浅银微晶精工材质 · 纯净通透)
        // ----------------------------------------------------
        const s = 0.80; // 黄金饱满半边长
        const cTop = [0.90, 0.94, 0.98, 0.96];    // 顶面浅冰蓝受光
        const cFront = [0.76, 0.83, 0.92, 0.96];  // 前面冷银钛金
        const cRight = [0.68, 0.76, 0.86, 0.96];  // 右侧金属灰
        const cLeft = [0.72, 0.79, 0.89, 0.96];   // 左侧微亮金属
        const cBack = [0.62, 0.70, 0.80, 0.96];   // 背面
        const cBottom = [0.52, 0.60, 0.72, 0.96]; // 底面微深

        const cubeVertices = [
            // 前面 (Z+)
            -s, -s,  s,  0, 0, 1,  ...cFront,
             s, -s,  s,  0, 0, 1,  ...cFront,
             s,  s,  s,  0, 0, 1,  ...cFront,
            -s,  s,  s,  0, 0, 1,  ...cFront,

            // 后面 (Z-)
            -s, -s, -s,  0, 0, -1,  ...cBack,
            -s,  s, -s,  0, 0, -1,  ...cBack,
             s,  s, -s,  0, 0, -1,  ...cBack,
             s, -s, -s,  0, 0, -1,  ...cBack,

            // 顶面 (Y+)
            -s,  s, -s,  0, 1, 0,  ...cTop,
            -s,  s,  s,  0, 1, 0,  ...cTop,
             s,  s,  s,  0, 1, 0,  ...cTop,
             s,  s, -s,  0, 1, 0,  ...cTop,

            // 底面 (Y-)
            -s, -s, -s,  0, -1, 0,  ...cBottom,
             s, -s, -s,  0, -1, 0,  ...cBottom,
             s, -s,  s,  0, -1, 0,  ...cBottom,
            -s, -s,  s,  0, -1, 0,  ...cBottom,

            // 右面 (X+)
             s, -s, -s,  1, 0, 0,  ...cRight,
             s,  s, -s,  1, 0, 0,  ...cRight,
             s,  s,  s,  1, 0, 0,  ...cRight,
             s, -s,  s,  1, 0, 0,  ...cRight,

            // 左面 (X-)
            -s, -s, -s, -1, 0, 0,  ...cLeft,
            -s, -s,  s, -1, 0, 0,  ...cLeft,
            -s,  s,  s, -1, 0, 0,  ...cLeft,
            -s,  s, -s, -1, 0, 0,  ...cLeft
        ];

        const cubeIndices = [
            0, 1, 2,  0, 2, 3,
            4, 5, 6,  4, 6, 7,
            8, 9, 10, 8, 10, 11,
            12, 13, 14, 12, 14, 15,
            16, 17, 18, 16, 18, 19,
            20, 21, 22, 20, 22, 23
        ];

        this.cubeVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cubeVertices), gl.STATIC_DRAW);

        this.cubeIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cubeIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(cubeIndices), gl.STATIC_DRAW);
        this.cubeIndexCount = cubeIndices.length;

        // ----------------------------------------------------
        // B. 正方体晶莹发光倒角线框 (Apple 宝蓝微光倒角线)
        // ----------------------------------------------------
        const edgeColor = [0.00, 0.44, 0.89, 0.90];
        const edgeVertices = [
            -s, -s,  s, ...edgeColor,   s, -s,  s, ...edgeColor,
             s, -s,  s, ...edgeColor,   s,  s,  s, ...edgeColor,
             s,  s,  s, ...edgeColor,  -s,  s,  s, ...edgeColor,
            -s,  s,  s, ...edgeColor,  -s, -s,  s, ...edgeColor,

            -s, -s, -s, ...edgeColor,   s, -s, -s, ...edgeColor,
             s, -s, -s, ...edgeColor,   s,  s, -s, ...edgeColor,
             s,  s, -s, ...edgeColor,  -s,  s, -s, ...edgeColor,
            -s,  s, -s, ...edgeColor,  -s, -s, -s, ...edgeColor,

            -s, -s,  s, ...edgeColor,  -s, -s, -s, ...edgeColor,
             s, -s,  s, ...edgeColor,   s, -s, -s, ...edgeColor,
             s,  s,  s, ...edgeColor,   s,  s, -s, ...edgeColor,
            -s,  s,  s, ...edgeColor,  -s,  s, -s, ...edgeColor
        ];

        this.edgeVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeVertices), gl.STATIC_DRAW);
        this.edgeVertexCount = edgeVertices.length / 7;

        // ----------------------------------------------------
        // C. 超精密航空矢量三轴指示器 (修长轴杆 + 流线航空锥)
        // ----------------------------------------------------
        const axisVertices = [];
        const axisIndices = [];
        let vOffset = 0;

        const buildVofaAxis = (dir, color) =>
        {
            const posLen = 1.65;  // 黄金修长正向延伸
            const negLen = 1.05;  // 负向穿透背面
            const r = 0.016;      // 超精密超细金属轴杆
            const headLen = 0.28; // 航空流线锥长
            const headR = 0.055;  // 航空流线锥底径
            const segments = 24;  // 更圆滑细腻的圆周采样

            let u = [0, 1, 0], v = [0, 0, 1];
            if (Math.abs(dir[0]) > 0.8) { u = [0, 1, 0]; v = [0, 0, 1]; }
            else if (Math.abs(dir[1]) > 0.8) { u = [1, 0, 0]; v = [0, 0, 1]; }
            else { u = [1, 0, 0]; v = [0, 1, 0]; }

            const baseIdx = vOffset;

            // 1. 贯穿长轴杆
            for (let i = 0; i <= segments; i++)
            {
                const theta = (i / segments) * Math.PI * 2;
                const cosT = Math.cos(theta), sinT = Math.sin(theta);
                const nx = u[0] * cosT + v[0] * sinT;
                const ny = u[1] * cosT + v[1] * sinT;
                const nz = u[2] * cosT + v[2] * sinT;

                axisVertices.push(
                    -dir[0] * negLen + nx * r, -dir[1] * negLen + ny * r, -dir[2] * negLen + nz * r,
                    nx, ny, nz,
                    color[0], color[1], color[2], 1.0
                );
                const bodyPos = posLen - headLen;
                axisVertices.push(
                    dir[0] * bodyPos + nx * r, dir[1] * bodyPos + ny * r, dir[2] * bodyPos + nz * r,
                    nx, ny, nz,
                    color[0], color[1], color[2], 1.0
                );
            }

            for (let i = 0; i < segments; i++)
            {
                const i0 = baseIdx + i * 2;
                const i1 = i0 + 1;
                const i2 = baseIdx + (i + 1) * 2;
                const i3 = i2 + 1;
                axisIndices.push(i0, i1, i2,  i2, i1, i3);
            }
            vOffset += (segments + 1) * 2;

            // 2. 正向圆锥箭头
            const coneBaseIdx = vOffset;
            const bodyPos = posLen - headLen;
            const tipPoint = [dir[0] * posLen, dir[1] * posLen, dir[2] * posLen];

            for (let i = 0; i <= segments; i++)
            {
                const theta = (i / segments) * Math.PI * 2;
                const cosT = Math.cos(theta), sinT = Math.sin(theta);
                const nx = u[0] * cosT + v[0] * sinT;
                const ny = u[1] * cosT + v[1] * sinT;
                const nz = u[2] * cosT + v[2] * sinT;

                axisVertices.push(
                    dir[0] * bodyPos + nx * headR, dir[1] * bodyPos + ny * headR, dir[2] * bodyPos + nz * headR,
                    nx, ny, nz,
                    color[0], color[1], color[2], 1.0
                );
            }

            const tipIdx = vOffset + segments + 1;
            axisVertices.push(
                tipPoint[0], tipPoint[1], tipPoint[2],
                dir[0], dir[1], dir[2],
                color[0] * 1.25, color[1] * 1.25, color[2] * 1.25, 1.0
            );

            for (let i = 0; i < segments; i++)
            {
                const p0 = coneBaseIdx + i;
                const p1 = coneBaseIdx + (i + 1);
                axisIndices.push(p0, tipIdx, p1);
            }
            vOffset += segments + 2;

            // 3. 负向精致微倒角封口
            const capIdx = vOffset;
            const capCenter = [-dir[0] * negLen, -dir[1] * negLen, -dir[2] * negLen];
            const capR = 0.024;

            for (let i = 0; i <= segments; i++)
            {
                const theta = (i / segments) * Math.PI * 2;
                const cosT = Math.cos(theta), sinT = Math.sin(theta);
                const nx = u[0] * cosT + v[0] * sinT;
                const ny = u[1] * cosT + v[1] * sinT;
                const nz = u[2] * cosT + v[2] * sinT;

                axisVertices.push(
                    capCenter[0] + nx * capR, capCenter[1] + ny * capR, capCenter[2] + nz * capR,
                    nx, ny, nz,
                    color[0] * 0.85, color[1] * 0.85, color[2] * 0.85, 1.0
                );
            }
            const capTip = vOffset + segments + 1;
            axisVertices.push(
                capCenter[0] - dir[0] * (capR * 0.6), capCenter[1] - dir[1] * (capR * 0.6), capCenter[2] - dir[2] * (capR * 0.6),
                -dir[0], -dir[1], -dir[2],
                color[0] * 0.85, color[1] * 0.85, color[2] * 0.85, 1.0
            );
            for (let i = 0; i < segments; i++)
            {
                axisIndices.push(capIdx + i, capTip, capIdx + i + 1);
            }
            vOffset += segments + 2;
        };

        // X轴 极光赤红
        buildVofaAxis([1, 0, 0], [0.95, 0.20, 0.30]);
        // Y轴 荧光翡翠绿
        buildVofaAxis([0, 1, 0], [0.06, 0.78, 0.48]);
        // Z轴 极光冰晶蓝
        buildVofaAxis([0, 0, 1], [0.02, 0.62, 0.95]);

        this.axisVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.axisVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(axisVertices), gl.STATIC_DRAW);

        this.axisIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.axisIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(axisIndices), gl.STATIC_DRAW);
        this.axisIndexCount = axisIndices.length;

        // ----------------------------------------------------
        // D. 空间底盘网格 (工控微冷灰微透视网格)
        // ----------------------------------------------------
        const gridVertices = [];
        const gridSize = 4.0;
        const gridStep = 0.5;
        const gridY = -1.6;

        for (let x = -gridSize; x <= gridSize + 1e-4; x += gridStep)
        {
            const alpha = Math.abs(x) < 1e-4 ? 0.45 : 0.18;
            gridVertices.push(x, gridY, -gridSize, 0.58, 0.66, 0.76, alpha);
            gridVertices.push(x, gridY,  gridSize, 0.58, 0.66, 0.76, alpha);
        }
        for (let z = -gridSize; z <= gridSize + 1e-4; z += gridStep)
        {
            const alpha = Math.abs(z) < 1e-4 ? 0.45 : 0.18;
            gridVertices.push(-gridSize, gridY, z, 0.58, 0.66, 0.76, alpha);
            gridVertices.push( gridSize, gridY, z, 0.58, 0.66, 0.76, alpha);
        }

        this.gridVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.gridVbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVertices), gl.STATIC_DRAW);
        this.gridVertexCount = gridVertices.length / 7;
    }

    bindEvents()
    {
        const canvas = this.canvas;

        canvas.addEventListener("pointerdown", e =>
        {
            if (e.button === 0)
            {
                this.isDragging = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                canvas.setPointerCapture(e.pointerId);
            }
        });

        canvas.addEventListener("pointermove", e =>
        {
            if (this.isDragging)
            {
                const dx = e.clientX - this.lastMouseX;
                const dy = e.clientY - this.lastMouseY;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;

                this.cameraYaw += dx * 0.008;
                this.cameraPitch = Math.max(-1.5, Math.min(1.5, this.cameraPitch + dy * 0.008));
                this.render();
            }
        });

        const stopDrag = e =>
        {
            if (this.isDragging)
            {
                this.isDragging = false;
                if (canvas.hasPointerCapture(e.pointerId))
                {
                    canvas.releasePointerCapture(e.pointerId);
                }
            }
        };

        canvas.addEventListener("pointerup", stopDrag);
        canvas.addEventListener("pointercancel", stopDrag);

        canvas.addEventListener("wheel", e =>
        {
            e.preventDefault();
            this.cameraDistance = Math.max(2.0, Math.min(12.0, this.cameraDistance + e.deltaY * 0.005));
            this.render();
        }, { passive: false });

        canvas.addEventListener("dblclick", () =>
        {
            this.resetCamera();
        });

        if (typeof window !== "undefined" && typeof window.addEventListener === "function")
        {
            window.addEventListener("resize", () => this.resize());
        }
    }

    resetCamera()
    {
        this.cameraDistance = 4.8;
        this.cameraPitch = 0.42;
        this.cameraYaw = 0.78;
        this.render();
    }

    setTare()
    {
        this.tareOffset.roll = this.currentEuler.roll;
        this.tareOffset.pitch = this.currentEuler.pitch;
        this.tareOffset.yaw = this.currentEuler.yaw;
        this.setPoseEuler(this.currentEuler.roll, this.currentEuler.pitch, this.currentEuler.yaw);
    }

    resetTare()
    {
        this.tareOffset = { roll: 0, pitch: 0, yaw: 0 };
        this.setPoseEuler(this.currentEuler.roll, this.currentEuler.pitch, this.currentEuler.yaw);
    }

    setPoseEuler(rollDeg, pitchDeg, yawDeg)
    {
        this.currentEuler.roll = rollDeg;
        this.currentEuler.pitch = pitchDeg;
        this.currentEuler.yaw = yawDeg;

        const effectiveRoll = (rollDeg - this.tareOffset.roll) * (Math.PI / 180);
        const effectivePitch = (pitchDeg - this.tareOffset.pitch) * (Math.PI / 180);
        const effectiveYaw = (yawDeg - this.tareOffset.yaw) * (Math.PI / 180);

        Mat4.fromEuler(this.sensorPoseMatrix, effectiveRoll, effectivePitch, effectiveYaw);

        // Why: WebGL 以 Y 为竖直轴，而传感器以 Z 为竖直轴；统一转换可保证欧拉角和四元数方向一致。
        Mat4.multiply(this.poseMatrix, this.sensorToWorldMatrix, this.sensorPoseMatrix);
        this.render();
    }

    setPoseQuaternion(w, x, y, z)
    {
        this.currentQuat = [w, x, y, z];
        Mat4.fromQuat(this.sensorPoseMatrix, this.currentQuat);
        Mat4.multiply(this.poseMatrix, this.sensorToWorldMatrix, this.sensorPoseMatrix);

        const sqw = w * w, sqx = x * x, sqy = y * y, sqz = z * z;
        const unit = sqx + sqy + sqz + sqw;
        const safeUnit = Math.max(1e-12, unit);
        const test = x * y + z * w;

        let roll, pitch, yaw;
        if (test > 0.499 * unit)
        {
            yaw = 2 * Math.atan2(x, w);
            pitch = Math.PI / 2;
            roll = 0;
        }
        else if (test < -0.499 * unit)
        {
            yaw = -2 * Math.atan2(x, w);
            pitch = -Math.PI / 2;
            roll = 0;
        }
        else
        {
            const sinP = Math.max(-1.0, Math.min(1.0, 2 * test / safeUnit));
            yaw = Math.atan2(2 * y * w - 2 * x * z, sqx - sqy - sqz + sqw);
            pitch = Math.asin(sinP);
            roll = Math.atan2(2 * x * w - 2 * y * z, -sqx + sqy - sqz + sqw);
        }

        this.currentEuler.roll = roll * (180 / Math.PI);
        this.currentEuler.pitch = pitch * (180 / Math.PI);
        this.currentEuler.yaw = yaw * (180 / Math.PI);

        this.render();
    }

    setPoseQuat(q)
    {
        if (Array.isArray(q) && q.length >= 4)
        {
            this.setPoseQuaternion(q[0], q[1], q[2], q[3]);
        }
    }

    resize()
    {
        const rect = this.canvas.getBoundingClientRect();
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const width = Math.max(1, Math.round(rect.width * ratio));
        const height = Math.max(1, Math.round(rect.height * ratio));

        if (this.canvas.width !== width || this.canvas.height !== height)
        {
            this.canvas.width = width;
            this.canvas.height = height;
            this.gl.viewport(0, 0, width, height);
            this.render();
        }
    }

    render()
    {
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.973, 0.980, 0.988, 1.0); // #F8FAFC 纯净微晶底色
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        const aspect = this.canvas.width / Math.max(1, this.canvas.height);
        const projection = Mat4.create();
        Mat4.perspective(projection, Math.PI / 4, aspect, 0.1, 100.0);

        // 视觉光学居中偏置 (向下平移 0.18，完美抵消顶部通道映射栏与悬浮条占用的视觉高度)
        const offsetY = 0.18;
        const camX = this.cameraDistance * Math.cos(this.cameraPitch) * Math.sin(this.cameraYaw);
        const camY = this.cameraDistance * Math.sin(this.cameraPitch) + offsetY;
        const camZ = this.cameraDistance * Math.cos(this.cameraPitch) * Math.cos(this.cameraYaw);
        const view = Mat4.create();
        Mat4.lookAt(view, [camX, camY, camZ], [0, offsetY, 0], [0, 1, 0]);

        const identityMat = Mat4.create();

        // 1. 绘制空间地平参考网格 (如果开启)
        if (this.showGrid)
        {
            gl.useProgram(this.lineProgram);
            gl.uniformMatrix4fv(this.lineLocations.uProjection, false, projection);
            gl.uniformMatrix4fv(this.lineLocations.uView, false, view);
            gl.uniformMatrix4fv(this.lineLocations.uModel, false, identityMat);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.gridVbo);
            gl.enableVertexAttribArray(this.lineLocations.aPosition);
            gl.vertexAttribPointer(this.lineLocations.aPosition, 3, gl.FLOAT, false, 28, 0);
            gl.enableVertexAttribArray(this.lineLocations.aColor);
            gl.vertexAttribPointer(this.lineLocations.aColor, 4, gl.FLOAT, false, 28, 12);
            gl.drawArrays(gl.LINES, 0, this.gridVertexCount);
        }

        // 2. 绘制 3D 姿态正方体 (应用姿态旋转矩阵)
        gl.useProgram(this.program);
        gl.uniformMatrix4fv(this.locations.uProjection, false, projection);
        gl.uniformMatrix4fv(this.locations.uView, false, view);
        gl.uniformMatrix4fv(this.locations.uModel, false, this.poseMatrix);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo);
        gl.enableVertexAttribArray(this.locations.aPosition);
        gl.vertexAttribPointer(this.locations.aPosition, 3, gl.FLOAT, false, 40, 0);
        gl.enableVertexAttribArray(this.locations.aNormal);
        gl.vertexAttribPointer(this.locations.aNormal, 3, gl.FLOAT, false, 40, 12);
        gl.enableVertexAttribArray(this.locations.aColor);
        gl.vertexAttribPointer(this.locations.aColor, 4, gl.FLOAT, false, 40, 24);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cubeIbo);
        gl.drawElements(gl.TRIANGLES, this.cubeIndexCount, gl.UNSIGNED_SHORT, 0);

        // 3. 绘制正方体晶莹高光白边轮廓线
        gl.useProgram(this.lineProgram);
        gl.uniformMatrix4fv(this.lineLocations.uProjection, false, projection);
        gl.uniformMatrix4fv(this.lineLocations.uView, false, view);
        gl.uniformMatrix4fv(this.lineLocations.uModel, false, this.poseMatrix);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeVbo);
        gl.enableVertexAttribArray(this.lineLocations.aPosition);
        gl.vertexAttribPointer(this.lineLocations.aPosition, 3, gl.FLOAT, false, 28, 0);
        gl.enableVertexAttribArray(this.lineLocations.aColor);
        gl.vertexAttribPointer(this.lineLocations.aColor, 4, gl.FLOAT, false, 28, 12);
        gl.drawArrays(gl.LINES, 0, this.edgeVertexCount);

        // 4. 绘制 VOFA+ 经典双向贯穿大三轴 (如果开启)
        if (this.showAxes)
        {
            gl.useProgram(this.program);
            gl.uniformMatrix4fv(this.locations.uProjection, false, projection);
            gl.uniformMatrix4fv(this.locations.uView, false, view);
            gl.uniformMatrix4fv(this.locations.uModel, false, this.poseMatrix);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.axisVbo);
            gl.enableVertexAttribArray(this.locations.aPosition);
            gl.vertexAttribPointer(this.locations.aPosition, 3, gl.FLOAT, false, 40, 0);
            gl.enableVertexAttribArray(this.locations.aNormal);
            gl.vertexAttribPointer(this.locations.aNormal, 3, gl.FLOAT, false, 40, 12);
            gl.enableVertexAttribArray(this.locations.aColor);
            gl.vertexAttribPointer(this.locations.aColor, 4, gl.FLOAT, false, 40, 24);

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.axisIbo);
            gl.drawElements(gl.TRIANGLES, this.axisIndexCount, gl.UNSIGNED_SHORT, 0);
        }
    }
}

if (typeof window !== "undefined")
{
    window.ImuCubeRenderer = ImuCubeRenderer;
}
