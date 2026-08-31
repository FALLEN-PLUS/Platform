"use strict";

/**
 * Universal Web Serial Engine · 多协议统一串口引擎
 * 支持:
 * 1. VOFA+ FireWater (文本 CSV 模式, 换行成帧, 自适应 1~16 通道)
 * 2. JustFloat (标准二进制浮点模式, 00 00 80 7F 帧尾)
 * 3. Raw 原始数据流
 * 4. 9600 ~ 2000000 动态自由波特率
 */
class UniversalSerialEngine
{
    constructor()
    {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.isConnected = false;
        this.baudRate = 115200;
        this.protocol = "firewater"; // "firewater" | "justfloat" | "raw"

        this.rxBinaryBuffer = new Uint8Array(0);
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
        this.rxTextBuffer = "";

        this.frameCount = 0;
        this.byteCount = 0;
        this.errorCount = 0;
        this.connectionGeneration = 0;
        this.txChain = Promise.resolve();

        this.lockedChannelCount = 0; // 稳态通道数 (0 = 自动学习探测中)
        this.configuredChannelCount = 0;
        this.channelHistory = [];

        this.onFrame = () => {};
        this.onRawData = () => {};
        this.onConnectionChange = () => {};
        this.onError = () => {};
    }

    async openPort()
    {
        await this.port.open({
            baudRate: this.baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            bufferSize: 4096
        });

        // Why: 通用工具不应擅自改变 DTR/RTS，以免触发目标板复位或影响其他 USB 串口。
        await new Promise(resolve => setTimeout(resolve, 50));

        if (!this.port.readable || !this.port.writable)
        {
            throw new Error("串口读写通道不可用");
        }
        this.writer = this.port.writable.getWriter();
    }

    formatSerialError(error, prefix)
    {
        const name = error && error.name ? error.name : "Error";
        const message = error && error.message ? error.message : String(error || "未知错误");
        let device = "";

        try
        {
            const info = this.port && this.port.getInfo ? this.port.getInfo() : {};
            const vid = Number.isInteger(info.usbVendorId) ? info.usbVendorId.toString(16).toUpperCase().padStart(4, "0") : "----";
            const pid = Number.isInteger(info.usbProductId) ? info.usbProductId.toString(16).toUpperCase().padStart(4, "0") : "----";
            device = ` [VID:${vid} PID:${pid}]`;
        }
        catch (_error)
        {
            device = "";
        }

        return error ? `${prefix}: ${name}: ${message}${device}` : `${prefix}${device}`;
    }

    async settlePendingWrites(timeoutMs = 500)
    {
        const pendingWrites = this.txChain;
        this.txChain = Promise.resolve();
        let timeoutId = null;
        const completed = await Promise.race([
            pendingWrites.then(() => true, () => true),
            new Promise(resolve =>
            {
                timeoutId = window.setTimeout(() => resolve(false), timeoutMs);
            })
        ]);
        if (timeoutId !== null)
        {
            window.clearTimeout(timeoutId);
        }
        if (!completed && this.writer)
        {
            // Why: 写入阻塞不能占住断开流程，否则用户无法重新连接设备。
            await this.writer.abort(new Error("串口断开，取消未完成写入")).catch(() => {});
        }
        return completed;
    }

    async reopenAfterStartupReadError(generation)
    {
        if (!this.isConnected || generation !== this.connectionGeneration || !this.port)
        {
            return false;
        }

        // Why: 仅对首次读取的驱动瞬态错误重试，防止设备真正掉线时无限重连。
        await this.settlePendingWrites();
        if (this.writer)
        {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close().catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 300));

        if (!this.isConnected || generation !== this.connectionGeneration)
        {
            return false;
        }
        await this.openPort();
        return true;
    }

    setProtocol(protocol)
    {
        this.protocol = protocol;
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
        this.lockedChannelCount = this.configuredChannelCount;
        this.channelHistory = [];
    }

    setChannelCount(count)
    {
        const normalized = Number.isInteger(count) && count >= 1 && count <= 16 ? count : 0;
        this.configuredChannelCount = normalized;
        this.lockedChannelCount = normalized;
        this.channelHistory = [];
    }

    async connect(baudRate = 115200)
    {
        if (!("serial" in navigator))
        {
            throw new Error("当前浏览器不支持 Web Serial API，请使用桌面版 Chrome 或 Edge");
        }
        if (this.isConnected)
        {
            return;
        }

        this.baudRate = Number(baudRate) || 115200;
        this.port = await navigator.serial.requestPort();
        try
        {
            await this.openPort();
        }
        catch (error)
        {
            const detail = this.formatSerialError(error, "串口打开失败");
            if (this.writer)
            {
                this.writer.releaseLock();
                this.writer = null;
            }
            await this.port.close().catch(() => {});
            this.port = null;
            throw new Error(detail);
        }

        this.connectionGeneration++;
        this.txChain = Promise.resolve();
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
        this.lockedChannelCount = this.configuredChannelCount;
        this.channelHistory = [];
        this.frameCount = 0;
        this.byteCount = 0;
        this.errorCount = 0;
        this.isConnected = true;
        this.onConnectionChange(true);
        this.readLoopPromise = this.readLoop();
    }

    async disconnect()
    {
        if (!this.port)
        {
            return;
        }

        this.isConnected = false;
        this.connectionGeneration++;
        if (this.reader)
        {
            await this.reader.cancel().catch(() => {});
        }
        if (this.readLoopPromise)
        {
            await this.readLoopPromise.catch(() => {});
            this.readLoopPromise = null;
        }
        await this.settlePendingWrites();
        if (this.writer)
        {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close().catch(() => {});
        this.port = null;
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.lockedChannelCount = this.configuredChannelCount;
        this.channelHistory = [];
        this.onConnectionChange(false);
    }

    async readLoop()
    {
        const generation = this.connectionGeneration;
        const startupRetryDeadline = performance.now() + 1500;
        let receivedData = false;
        let startupRetryUsed = false;
        let unexpectedError = null;

        while (this.isConnected && generation === this.connectionGeneration)
        {
            let activeReader = null;
            let streamEnded = false;
            unexpectedError = null;
            try
            {
                activeReader = this.port.readable.getReader();
                this.reader = activeReader;
                while (this.isConnected && generation === this.connectionGeneration)
                {
                    const { value, done } = await activeReader.read();
                    if (done)
                    {
                        streamEnded = true;
                        break;
                    }
                    if (value && value.length > 0)
                    {
                        receivedData = true;
                        this.byteCount += value.length;
                        this.dispatchData(value);
                    }
                }
            }
            catch (error)
            {
                if (this.isConnected && generation === this.connectionGeneration)
                {
                    unexpectedError = error;
                }
            }
            finally
            {
                if (activeReader)
                {
                    activeReader.releaseLock();
                }
                if (this.reader === activeReader)
                {
                    this.reader = null;
                }
            }

            const startupReadFailed = streamEnded ||
                (unexpectedError && unexpectedError.name === "NetworkError");
            const canRetry = startupReadFailed &&
                !receivedData &&
                !startupRetryUsed &&
                performance.now() <= startupRetryDeadline &&
                this.isConnected &&
                generation === this.connectionGeneration;
            if (canRetry)
            {
                startupRetryUsed = true;
                try
                {
                    if (await this.reopenAfterStartupReadError(generation))
                    {
                        continue;
                    }
                }
                catch (retryError)
                {
                    unexpectedError = retryError;
                }
            }
            break;
        }

        if (this.isConnected && generation === this.connectionGeneration)
        {
            // Why: 读取循环不能调用并等待 disconnect()，否则会等待自己结束而无法释放串口。
            const detail = unexpectedError ?
                this.formatSerialError(unexpectedError, startupRetryUsed ? "串口重试后读取中断" : "串口读取中断") :
                this.formatSerialError(null, startupRetryUsed ? "串口重试后读取流提前结束" : "串口读取流提前结束");
            this.isConnected = false;
            this.connectionGeneration++;
            await this.settlePendingWrites();
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
            this.rxBinaryBuffer = new Uint8Array(0);
            this.rxTextBuffer = "";
            this.lockedChannelCount = this.configuredChannelCount;
            this.channelHistory = [];
            this.readLoopPromise = null;
            this.onError(new Error(detail));
            this.onConnectionChange(false);
        }
    }

    dispatchData(chunk)
    {
        this.onRawData(chunk);
        if (this.protocol === "firewater")
        {
            this.processFireWater(chunk);
        }
        else if (this.protocol === "justfloat")
        {
            this.processJustFloat(chunk);
        }
    }

    /**
     * VOFA+ FireWater 文本 CSV 协议解析引擎
     * 支持标准输出: "1.1, 2.2, 3.3\n" 或 "samples: 1.1, 2.2\n" 或空格分隔
     */
    processFireWater(chunk)
    {
        const text = this.textDecoder.decode(chunk, { stream: true });
        this.rxTextBuffer += text;

        if (this.rxTextBuffer.length > 32768)
        {
            this.rxTextBuffer = this.rxTextBuffer.slice(-4096);
        }

        let newlineIndex;
        while ((newlineIndex = this.rxTextBuffer.indexOf("\n")) >= 0)
        {
            let line = this.rxTextBuffer.slice(0, newlineIndex).trim();
            this.rxTextBuffer = this.rxTextBuffer.slice(newlineIndex + 1);

            if (line.length === 0)
            {
                continue;
            }

            const colonIndex = line.indexOf(":");
            if (colonIndex >= 0)
            {
                line = line.slice(colonIndex + 1).trim();
            }

            const parts = line.split(/[,;\s\t]+/);
            const values = [];
            for (const part of parts)
            {
                if (part.length === 0) { continue; }
                const num = Number(part);
                if (Number.isFinite(num) && Math.abs(num) <= 1e9)
                {
                    values.push(num);
                }
            }

            if (values.length > 0)
            {
                // 通道数稳态自学习
                if (this.lockedChannelCount === 0)
                {
                    this.channelHistory.push(values.length);
                    if (this.channelHistory.length >= 6)
                    {
                        const counts = {};
                        let maxCount = 0, bestC = values.length;
                        for (const c of this.channelHistory)
                        {
                            counts[c] = (counts[c] || 0) + 1;
                            if (counts[c] > maxCount) { maxCount = counts[c]; bestC = c; }
                        }
                        if (maxCount >= 4) { this.lockedChannelCount = bestC; }
                        this.channelHistory.shift();
                    }
                }

                // 严格通道防错位：丢弃断行残帧
                if (this.lockedChannelCount === 0 || values.length === this.lockedChannelCount)
                {
                    this.frameCount++;
                    this.onFrame(values);
                }
                else
                {
                    this.errorCount++;
                }
            }
        }
    }

    /**
     * JustFloat 标准二进制浮点解析引擎 (00 00 80 7F 尾帧)
     * 自适应 1～16 任意浮点通道 + 稳态防错位串台锁定
     */
    processJustFloat(chunk)
    {
        const merged = new Uint8Array(this.rxBinaryBuffer.length + chunk.length);
        merged.set(this.rxBinaryBuffer, 0);
        merged.set(chunk, this.rxBinaryBuffer.length);
        this.rxBinaryBuffer = merged;

        if (this.rxBinaryBuffer.length > 16384)
        {
            this.rxBinaryBuffer = this.rxBinaryBuffer.slice(-1024);
        }

        const tail = [0x00, 0x00, 0x80, 0x7F];

        while (this.rxBinaryBuffer.length >= 8)
        {
            const tailIndex = this.findSequence(this.rxBinaryBuffer, tail);
            if (tailIndex < 0)
            {
                return;
            }

            // 严格对齐：尾帧前的数据必须是 4 字节的整数倍 (Float32) 且通道在 1～16 之间
            if (tailIndex % 4 !== 0 || tailIndex === 0 || tailIndex > 64)
            {
                // 如果 tailIndex 不是 4 字节边界，向前滑动 1 字节重新寻找有效帧同步
                this.rxBinaryBuffer = this.rxBinaryBuffer.slice(1);
                continue;
            }

            const rawChannelCount = tailIndex / 4;

            // 通道数稳态自学习与锁定
            if (this.lockedChannelCount === 0)
            {
                this.channelHistory.push(rawChannelCount);
                if (this.channelHistory.length >= 6)
                {
                    const counts = {};
                    let maxCount = 0, bestC = rawChannelCount;
                    for (const c of this.channelHistory)
                    {
                        counts[c] = (counts[c] || 0) + 1;
                        if (counts[c] > maxCount)
                        {
                            maxCount = counts[c];
                            bestC = c;
                        }
                    }
                    if (maxCount >= 4)
                    {
                        this.lockedChannelCount = bestC;
                    }
                    this.channelHistory.shift();
                }
            }

            // 核心防御：如果已锁定通道数，遇到不等于稳态通道数的偶发丢字节坏帧/残帧，直接丢弃，绝不错位输出！
            if (this.lockedChannelCount > 0 && rawChannelCount !== this.lockedChannelCount)
            {
                this.errorCount++;
                this.rxBinaryBuffer = this.rxBinaryBuffer.slice(tailIndex + 4);
                continue;
            }

            const payload = this.rxBinaryBuffer.slice(0, tailIndex);
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const values = [];
            let valid = true;

            for (let i = 0; i < rawChannelCount; i++)
            {
                const val = view.getFloat32(i * 4, true);
                // 过滤 NaN、Inf 以及绝对值大于 1e9 的错位野浮点数 (如 1.8e38)
                if (!Number.isFinite(val) || Math.abs(val) > 1e9)
                {
                    valid = false;
                    break;
                }
                values.push(val);
            }

            if (valid)
            {
                this.frameCount++;
                this.onFrame(values);
            }
            else
            {
                this.errorCount++;
            }

            this.rxBinaryBuffer = this.rxBinaryBuffer.slice(tailIndex + 4);
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
            if (matched)
            {
                return i;
            }
        }
        return -1;
    }

    async send(data)
    {
        if (!this.isConnected || !this.writer)
        {
            throw new Error("串口尚未连接");
        }

        let buffer;
        if (typeof data === "string")
        {
            buffer = new TextEncoder().encode(data);
        }
        else if (data instanceof Uint8Array)
        {
            buffer = data;
        }
        else
        {
            buffer = new Uint8Array(data);
        }

        const generation = this.connectionGeneration;
        const op = async () =>
        {
            if (!this.isConnected || !this.writer || generation !== this.connectionGeneration)
            {
                throw new Error("串口已断开，发送取消");
            }
            await this.writer.write(buffer);
        };

        const result = this.txChain.then(op, op);
        this.txChain = result.catch(() => {});
        return result;
    }

    sendText(text)
    {
        return this.send(String(text));
    }

    sendBytes(bytes)
    {
        return this.send(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }
}

window.UniversalSerialEngine = UniversalSerialEngine;
