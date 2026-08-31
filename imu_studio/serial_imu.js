"use strict";

/**
 * IMU Motion Studio · 串口与双协议 (JustFloat 二进制 + FireWater 文本 CSV) 姿态解算引擎
 */
class ImuSerialEngine
{
    constructor()
    {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.rxBuffer = new Uint8Array(0);
        this.textBuffer = "";
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
        this.isConnected = false;

        this.frameCount = 0;
        this.byteCount = 0;
        this.resyncByteCount = 0;
        this.invalidFrameCount = 0;

        // 协议配置: "justfloat" (标准二进制) | "firewater" (VOFA+ 文本 CSV)
        this.protocol = "justfloat";

        // 通道映射配置
        // 模式: "euler" (欧拉角) | "quat" (四元数)
        this.mode = "euler";
        this.angleUnit = "deg"; // "deg" (角度) | "rad" (弧度)
        this.eulerMapping = { roll: 0, pitch: 1, yaw: 2 }; // 通道索引 0-based
        this.quatMapping = { w: 0, x: 1, y: 2, z: 3 };

        // 事件回调
        this.onPose = () => {};
        this.onFrame = () => {};
        this.onRawData = () => {};
        this.onConnectionChange = () => {};
        this.onError = () => {};
    }

    setProtocol(proto)
    {
        this.protocol = proto === "firewater" ? "firewater" : "justfloat";
        this.rxBuffer = new Uint8Array(0);
        this.textBuffer = "";
    }

    async connect(baudRate = 460800)
    {
        if (!("serial" in navigator))
        {
            throw new Error("当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge");
        }
        if (this.isConnected)
        {
            return;
        }

        this.port = await navigator.serial.requestPort();
        await this.port.open({
            baudRate: Number(baudRate) || 460800,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            flowControl: "none",
            bufferSize: 4096
        });

        this.writer = this.port.writable.getWriter();
        this.rxBuffer = new Uint8Array(0);
        this.textBuffer = "";
        this.frameCount = 0;
        this.byteCount = 0;
        this.resyncByteCount = 0;
        this.invalidFrameCount = 0;
        this.isConnected = true;
        this.onConnectionChange(true);
        this.readLoopPromise = this.readLoop();
    }

    async disconnect()
    {
        if (!this.port) { return; }
        this.isConnected = false;
        if (this.reader)
        {
            await this.reader.cancel().catch(() => {});
        }
        if (this.readLoopPromise)
        {
            await this.readLoopPromise.catch(() => {});
            this.readLoopPromise = null;
        }
        if (this.writer)
        {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close().catch(() => {});
        this.port = null;
        this.rxBuffer = new Uint8Array(0);
        this.textBuffer = "";
        this.onConnectionChange(false);
    }

    async readLoop()
    {
        this.reader = this.port.readable.getReader();
        let unexpectedError = null;

        try
        {
            while (this.isConnected)
            {
                const { value, done } = await this.reader.read();
                if (done) { break; }
                if (value && value.length > 0)
                {
                    this.appendReceiveData(value);
                }
            }
        }
        catch (error)
        {
            if (this.isConnected) { unexpectedError = error; }
        }
        finally
        {
            if (this.reader)
            {
                this.reader.releaseLock();
                this.reader = null;
            }
        }

        if (this.isConnected)
        {
            this.isConnected = false;
            if (unexpectedError)
            {
                this.onError("串口读取中断：" + unexpectedError.message);
            }
            else
            {
                this.onError("串口已断开连接");
            }
            if (this.writer)
            {
                this.writer.releaseLock();
                this.writer = null;
            }
            if (this.port)
            {
                await this.port.close().catch(() => {});
                this.port = null;
            }
            this.onConnectionChange(false);
        }
    }

    appendReceiveData(chunk)
    {
        this.byteCount += chunk.length;
        this.onRawData(chunk);

        if (this.protocol === "firewater")
        {
            this.processFireWater(chunk);
        }
        else
        {
            this.processJustFloat(chunk);
        }
    }

    // =========================================================================
    // 1. VOFA+ FireWater 文本 CSV 协议解析引擎 (如 "12.5, -25.0, 180.0\n")
    // =========================================================================
    processFireWater(chunk)
    {
        const text = this.textDecoder.decode(chunk, { stream: true });
        this.textBuffer += text;

        const lines = this.textBuffer.split(/[\r\n]+/);
        // 保留最后一个可能未接收完整的行
        this.textBuffer = lines.pop() || "";

        for (const line of lines)
        {
            const trimmed = line.trim();
            if (!trimmed) { continue; }

            // 提取所有浮点数 (支持 "1.2, 3.4, 5.6" 或 "roll:1.2 pitch:3.4 yaw:5.6")
            const numMatches = trimmed.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
            if (!numMatches || numMatches.length === 0) { continue; }

            const values = [];
            for (const s of numMatches)
            {
                const num = parseFloat(s);
                if (Number.isFinite(num))
                {
                    values.push(num);
                }
            }

            if (values.length >= 3)
            {
                this.frameCount++;
                this.onFrame(values);
                this.dispatchPose(values);
            }
            else
            {
                this.invalidFrameCount++;
            }
        }

        if (this.textBuffer.length > 4096)
        {
            this.textBuffer = "";
        }
    }

    // =========================================================================
    // 2. JustFloat 标准二进制浮点协议解析引擎 (以 00 00 80 7F 结尾)
    // =========================================================================
    processJustFloat(chunk)
    {
        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;

        const tail = [0x00, 0x00, 0x80, 0x7F];

        while (this.rxBuffer.length >= 4)
        {
            const tailIndex = this.findSequence(this.rxBuffer, tail);
            if (tailIndex < 0) { break; }

            if (tailIndex < 4)
            {
                this.resyncByteCount += tailIndex + 4;
                this.rxBuffer = this.rxBuffer.slice(tailIndex + 4);
                continue;
            }

            const channelNum = Math.floor(tailIndex / 4);
            const frameBytesLen = channelNum * 4;
            const frameStart = tailIndex - frameBytesLen;

            if (frameStart > 0)
            {
                this.resyncByteCount += frameStart;
            }

            const payload = this.rxBuffer.slice(frameStart, tailIndex);
            this.rxBuffer = this.rxBuffer.slice(tailIndex + 4);

            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const values = [];
            let valid = true;

            for (let i = 0; i < channelNum; i++)
            {
                const val = view.getFloat32(i * 4, true);
                if (!Number.isFinite(val) || Math.abs(val) > 1e9)
                {
                    valid = false;
                    break;
                }
                values.push(val);
            }

            if (valid && values.length >= 3)
            {
                this.frameCount++;
                this.onFrame(values);
                this.dispatchPose(values);
            }
            else
            {
                this.invalidFrameCount++;
            }
        }

        if (this.rxBuffer.length > 8192)
        {
            const keep = this.rxBuffer.slice(-32);
            this.resyncByteCount += this.rxBuffer.length - keep.length;
            this.rxBuffer = keep;
        }
    }

    findSequence(data, sequence)
    {
        const lastStart = data.length - sequence.length;
        for (let i = 0; i <= lastStart; i++)
        {
            let matched = true;
            for (let j = 0; j < sequence.length; j++)
            {
                if (data[i + j] !== sequence[j])
                {
                    matched = false;
                    break;
                }
            }
            if (matched) { return i; }
        }
        return -1;
    }

    dispatchPose(values)
    {
        if (this.mode === "euler")
        {
            const rollIdx = this.eulerMapping.roll;
            const pitchIdx = this.eulerMapping.pitch;
            const yawIdx = this.eulerMapping.yaw;

            let roll = rollIdx < values.length ? values[rollIdx] : 0;
            let pitch = pitchIdx < values.length ? values[pitchIdx] : 0;
            let yaw = yawIdx < values.length ? values[yawIdx] : 0;

            if (this.angleUnit === "rad")
            {
                roll *= (180 / Math.PI);
                pitch *= (180 / Math.PI);
                yaw *= (180 / Math.PI);
            }

            this.onPose({
                mode: "euler",
                roll,
                pitch,
                yaw,
                rawChannels: values
            });
        }
        else if (this.mode === "quat")
        {
            const wIdx = this.quatMapping.w;
            const xIdx = this.quatMapping.x;
            const yIdx = this.quatMapping.y;
            const zIdx = this.quatMapping.z;

            const w = wIdx < values.length ? values[wIdx] : 1;
            const x = xIdx < values.length ? values[xIdx] : 0;
            const y = yIdx < values.length ? values[yIdx] : 0;
            const z = zIdx < values.length ? values[zIdx] : 0;

            this.onPose({
                mode: "quat",
                w, x, y, z,
                rawChannels: values
            });
        }
    }
}

if (typeof window !== "undefined")
{
    window.ImuSerialEngine = ImuSerialEngine;
}
