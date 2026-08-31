"use strict";

/**
 * IMU Motion Studio · MSPM0G3507 单例串口通信引擎 & Bootloader 7步 OTA 升级系统
 */

// 以太网标准 Ethernet CRC32 (多项式 0xEDB88320)
function computeCrc32(data, start = 0, length = data.length)
{
    let crc = 0xFFFFFFFF;
    for (let i = start; i < start + length; i++)
    {
        crc ^= data[i];
        for (let j = 0; j < 8; j++)
        {
            if (crc & 1)
            {
                crc = (crc >>> 1) ^ 0xEDB88320;
            }
            else
            {
                crc = crc >>> 1;
            }
        }
    }
    return (~crc) >>> 0;
}

// 串口状态定义
const SerialState = {
    DISCONNECTED: "DISCONNECTED",   // 串口未打开
    PORT_OPEN: "PORT_OPEN",         // 串口已打开 (未收到有效数据)
    RECEIVING: "RECEIVING",         // 正在接收数据 (设备在线)
    BOOTLOADER: "BOOTLOADER",       // Bootloader 模式
    OTA_WRITING: "OTA_WRITING",     // OTA 升级中
    ERROR: "ERROR"                  // 串口异常
};

// =============================================================================
// 1. ImuUnifiedSerialHub: 统一单例通信与下位机协议解析引擎
// =============================================================================
class ImuUnifiedSerialHub
{
    constructor()
    {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.isConnected = false;
        this.connectionGeneration = 0;

        this.baudRate = 460800; // 固定波特率 460800 8-N-1
        this.currentState = SerialState.DISCONNECTED;

        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
        this.controlTextBuffer = "";
        this.controlTextDecoder = new TextDecoder("utf-8", { fatal: false });
        this.textEncoder = new TextEncoder();

        // 统计指标
        this.byteCount = 0;
        this.frameCount = 0;
        this.errorFrameCount = 0;
        this.droppedFrameCount = 0;
        this.connectionStartTime = 0;
        this.lastFrameTime = 0;
        this.livenessTimer = null;

        // 当前监控配置
        this.config = {
            device: "XV",      // "XV" | "ICM" | "FUS"
            format: "JF",      // "TXT" | "JF"
            dataType: "EULER", // "ACC" | "GYRO" | "EULER" | "QUAT"
            frequency: 100,    // 50 | 100 | 200 | 500 | 1000
            channelMode: "imu" // "imu" | "raw"
        };

        // 发送队列互斥锁
        this.sendQueue = Promise.resolve();

        // 外部回调
        this.onFrame = () => {};
        this.onRawData = () => {};
        this.onRawText = () => {};
        this.onCalibration = () => {};
        this.onStateChange = () => {};
        this.onError = () => {};

        // 监听热插拔
        if ("serial" in navigator)
        {
            navigator.serial.addEventListener("disconnect", e =>
            {
                if (this.port && e.target === this.port)
                {
                    this.disconnect("串口设备被物理拔出");
                }
            });
        }

        // 心跳/在线保活定时器
        this.startLivenessWatcher();
    }

    setState(newState)
    {
        if (this.currentState !== newState)
        {
            this.currentState = newState;
            this.onStateChange(newState);
        }
    }

    startLivenessWatcher()
    {
        setInterval(() =>
        {
            if (this.isConnected)
            {
                if (this.currentState === SerialState.RECEIVING)
                {
                    if (performance.now() - this.lastFrameTime > 1600)
                    {
                        this.setState(SerialState.PORT_OPEN);
                    }
                }
            }
        }, 500);
    }

    setTelemetryConfig(dev, fmt, type, freq)
    {
        this.config.device = dev;
        this.config.format = fmt;
        this.config.dataType = type;
        this.config.frequency = Number(freq) || 100;
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.controlTextBuffer = "";
    }

    setChannelMode(mode)
    {
        this.config.channelMode = mode === "raw" ? "raw" : "imu";

        // Why: 切换解析规则后丢弃旧半帧，避免 TXT/JF 或 3/4 通道残留被新模式误收。
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
    }

    get expectedChannelCount()
    {
        return this.config.dataType === "QUAT" ? 4 : 3;
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

        // Why: 只使用标准 8-N-1，避免主动改变 DTR/RTS 对不同 USB 串口产生额外副作用。
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

    async reopenAfterStartupReadError(generation)
    {
        if (!this.isConnected || generation !== this.connectionGeneration || !this.port)
        {
            return false;
        }

        // Why: 只处理驱动刚启动时的瞬态错误，先彻底释放锁再复用已授权端口。
        await this.sendQueue.catch(() => {});
        this.sendQueue = Promise.resolve();
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

    async connect()
    {
        if (!("serial" in navigator))
        {
            throw new Error("当前浏览器不支持 Web Serial API，请使用桌面版 Chrome 或 Edge");
        }
        if (this.isConnected) { return; }

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
        this.sendQueue = Promise.resolve();
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.controlTextBuffer = "";
        this.textDecoder = new TextDecoder("utf-8", { fatal: false });
        this.controlTextDecoder = new TextDecoder("utf-8", { fatal: false });
        this.byteCount = 0;
        this.frameCount = 0;
        this.errorFrameCount = 0;
        this.droppedFrameCount = 0;
        this.connectionStartTime = performance.now();
        this.isConnected = true;

        this.setState(SerialState.PORT_OPEN);
        this.readLoopPromise = this.readLoop();
    }

    async disconnect(reason = "")
    {
        if (!this.port) { return; }
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
        if (this.writer)
        {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close().catch(() => {});
        this.port = null;
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";
        this.controlTextBuffer = "";

        this.setState(reason ? SerialState.ERROR : SerialState.DISCONNECTED);
        if (reason)
        {
            this.onError(reason);
        }
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
                        this.appendReceiveData(value);
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
            const detail = unexpectedError ?
                this.formatSerialError(unexpectedError, startupRetryUsed ? "串口重试后读取中断" : "串口读取中断") :
                this.formatSerialError(null, startupRetryUsed ? "串口重试后读取流提前结束" : "串口读取流提前结束");
            this.isConnected = false;
            this.connectionGeneration++;
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
            this.readLoopPromise = null;
            this.setState(SerialState.ERROR);
            this.onError(detail);
        }
    }

    appendReceiveData(chunk)
    {
        this.byteCount += chunk.length;
        this.onRawData(chunk);

        // 1. 优先转发给 OTA 引擎 (如果 OTA 升级进行中)
        if (window.imuOtaEngine && window.imuOtaEngine.isBusy)
        {
            window.imuOtaEngine.feedRawChunk(chunk);
            return;
        }

        // 2. 检查 Bootloader / APP 重启签名
        const textSample = this.textDecoder.decode(chunk, { stream: true });
        if (textSample.includes("=== MSPM0G3507 IMU BOOT OK ==="))
        {
            this.setState(SerialState.RECEIVING);
        }

        // 校准状态始终使用独立文本通道，避免当前为 JustFloat 时无法识别。
        this.parseCalibrationControl(chunk);

        // 3. 正常遥测数据解析 (TXT 或 JustFloat)
        if (this.config.format === "TXT")
        {
            this.parseTxtFormat(chunk);
        }
        else
        {
            this.parseJustFloatFormat(chunk);
        }
    }

    parseCalibrationControl(chunk)
    {
        this.controlTextBuffer += this.controlTextDecoder.decode(chunk, { stream: true });
        const lines = this.controlTextBuffer.split(/[\r\n]+/);
        this.controlTextBuffer = lines.pop() || "";

        for (const line of lines)
        {
            const marker = line.indexOf("@CAL,");
            if (marker >= 0)
            {
                const controlLine = line.slice(marker).trim();
                this.rxBinaryBuffer = new Uint8Array(0);
                this.onCalibration(controlLine);
                this.onRawText(controlLine);
            }
        }
        if (this.controlTextBuffer.length > 4096)
        {
            const marker = this.controlTextBuffer.lastIndexOf("@CAL,");
            this.controlTextBuffer = marker >= 0 ?
                this.controlTextBuffer.slice(marker) : "";
        }
    }

    // TXT 格式解析：以 \r\n 结尾，空格分隔，3 或 4 个浮点数
    parseTxtFormat(chunk)
    {
        const text = this.textDecoder.decode(chunk, { stream: true });
        this.rxTextBuffer += text;

        const lines = this.rxTextBuffer.split(/[\r\n]+/);
        this.rxTextBuffer = lines.pop() || "";

        const rawMode = this.config.channelMode === "raw";
        const expected = this.expectedChannelCount;

        for (const line of lines)
        {
            const trimmed = line.trim();
            if (!trimmed) { continue; }

            if (trimmed.includes("@CAL,"))
            {
                continue;
            }

            this.onRawText(trimmed);

            const parts = trimmed.split(/[,;\s]+/).filter(Boolean);
            const countValid = rawMode ?
                parts.length >= 1 && parts.length <= 4 :
                parts.length === expected;
            if (!countValid)
            {
                this.errorFrameCount++;
                continue;
            }

            const rawValues = [];
            let valid = true;
            for (const p of parts)
            {
                const num = parseFloat(p);
                if (!Number.isFinite(num))
                {
                    valid = false;
                    break;
                }
                rawValues.push(num);
            }

            if (valid && (rawMode || rawValues.length === expected))
            {
                this.dispatchValidatedFrame(rawValues);
            }
            else
            {
                this.errorFrameCount++;
            }
        }

        if (this.rxTextBuffer.length > 4096)
        {
            this.rxTextBuffer = "";
        }
    }

    // JUSTFLOAT 格式解析：小端 IEEE-754 浮点，以 00 00 80 7F 结尾
    parseJustFloatFormat(chunk)
    {
        const merged = new Uint8Array(this.rxBinaryBuffer.length + chunk.length);
        merged.set(this.rxBinaryBuffer, 0);
        merged.set(chunk, this.rxBinaryBuffer.length);
        this.rxBinaryBuffer = merged;

        const tail = [0x00, 0x00, 0x80, 0x7F];
        const expectedChannelCount = this.expectedChannelCount;
        const expectedPayloadBytes = expectedChannelCount * 4;

        while (this.rxBinaryBuffer.length >= 4)
        {
            const tailIndex = this.findSequence(this.rxBinaryBuffer, tail);
            if (tailIndex < 0) { break; }

            if (tailIndex !== expectedPayloadBytes)
            {
                // Why: 不能从损坏流末尾截取“看似有限”的浮点数，否则 QUAT 缺轴或错位数据会伪装成有效姿态。
                this.droppedFrameCount++;
                this.rxBinaryBuffer = this.rxBinaryBuffer.slice(tailIndex + 4);
                continue;
            }

            const payload = this.rxBinaryBuffer.slice(0, tailIndex);
            this.rxBinaryBuffer = this.rxBinaryBuffer.slice(tailIndex + 4);

            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const rawValues = [];
            let valid = true;

            for (let i = 0; i < expectedChannelCount; i++)
            {
                const val = view.getFloat32(i * 4, true);
                if (!Number.isFinite(val) || Math.abs(val) > 1e9)
                {
                    valid = false;
                    break;
                }
                rawValues.push(val);
            }

            if (valid && rawValues.length === expectedChannelCount)
            {
                this.dispatchValidatedFrame(rawValues);
            }
            else
            {
                this.errorFrameCount++;
            }
        }

        if (this.rxBinaryBuffer.length > 8192)
        {
            this.rxBinaryBuffer = this.rxBinaryBuffer.slice(-32);
        }
    }

    // 下位机已经按统一协议把缺失轴补 0，上位机原样显示，避免同一帧在两端含义不同。
    dispatchValidatedFrame(rawValues)
    {
        this.frameCount++;
        this.lastFrameTime = performance.now();
        this.setState(SerialState.RECEIVING);

        const dev = this.config.device;
        const rawMode = this.config.channelMode === "raw";
        const type = rawMode ? "RAW_MAPPED" : this.config.dataType;
        const processedValues = rawValues.slice();

        this.onFrame({
            raw: rawValues,
            values: processedValues,
            device: dev,
            dataType: type,
            channelMode: this.config.channelMode,
            format: this.config.format,
            timestamp: this.lastFrameTime
        });
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

    async sendBytes(bytes)
    {
        if (!this.isConnected || !this.writer)
        {
            throw new Error("串口未连接");
        }
        return new Promise((resolve, reject) =>
        {
            this.sendQueue = this.sendQueue.then(async () =>
            {
                try
                {
                    await this.writer.write(bytes);
                    resolve();
                }
                catch (e)
                {
                    reject(e);
                }
            });
        });
    }

    async sendText(text)
    {
        return this.sendBytes(this.textEncoder.encode(text));
    }

    // 下发四段式配置并启动
    async applyConfig(dev, fmt, type, freq)
    {
        this.setTelemetryConfig(dev, fmt, type, freq);

        // 1. 发送 STOP 并清空缓存
        await this.sendText("STOP\r\n");
        await new Promise(r => setTimeout(r, 60));
        this.rxBinaryBuffer = new Uint8Array(0);
        this.rxTextBuffer = "";

        // 2. 发送四段式指令
        const cmd = `${dev}/${fmt}/${type}/${freq}\r\n`;
        await this.sendText(cmd);
        return cmd;
    }

    async stopMonitoring()
    {
        await this.sendText("STOP\r\n");
        this.setState(SerialState.PORT_OPEN);
    }
}

// =============================================================================
// 2. ImuOtaEngine: MSPM0G3507 7步标准 Bootloader 二进制 OTA 升级系统
// =============================================================================
class ImuOtaEngine
{
    constructor(serialHub)
    {
        this.hub = serialHub;
        this.isBusy = false;
        this.firmwareData = null;
        this.firmwareSize = 0;
        this.firmwareCrc32 = 0;

        this.seq = 0;
        this.rxBuffer = new Uint8Array(0);
        this.pendingResponse = null;
        this.appBooted = false;
        this.bootTextBuffer = "";
        this.bootTextDecoder = new TextDecoder("utf-8", { fatal: false });

        // 回调
        this.onProgress = () => {};
        this.onStepChange = () => {};
        this.onLog = () => {};
    }

    clearFirmware()
    {
        this.firmwareData = null;
        this.firmwareSize = 0;
        this.firmwareCrc32 = 0;
    }

    // 本地固件 4 项强安全校验
    validateFirmware(buffer, fileName = "")
    {
        // Why: 新文件失败时不能继续保留并误刷上一次校验成功的固件。
        this.clearFirmware();

        if (fileName && !fileName.toLowerCase().endsWith(".bin"))
        {
            throw new Error(`文件 [${fileName}] 非 .bin 格式！MSPM0G3507 Bootloader 仅支持纯二进制固件 (.bin)，禁止使用 .hex / .elf`);
        }

        const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const size = u8.length;

        if (size < 8)
        {
            throw new Error("固件大小不足 8 字节 (无法解析向量表)");
        }
        if (size > 117760) // 0x1CC00
        {
            throw new Error(`固件大小 (${size} 字节) 超过了 APP 分区上限 117,760 字节 (0x1CC00)`);
        }

        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

        // 1. 检查栈顶地址 (0x20200000 ~ 0x20208000 且 8 字节对齐)
        const stackTop = view.getUint32(0, true);
        if (stackTop < 0x20200000 || stackTop > 0x20208000 || (stackTop % 8 !== 0))
        {
            throw new Error(`非法栈顶地址: 0x${stackTop.toString(16).toUpperCase()} (必须位于 0x20200000~0x20208000 且 8 字节对齐)`);
        }

        // 2. Reset Handler 必须是 Thumb 地址，并且真实落在当前 BIN 镜像内部。
        const resetEntryRaw = view.getUint32(4, true);
        const resetEntry = resetEntryRaw & ~1;
        const appBase = 0x2000;
        const imageEnd = appBase + size;
        const appLimit = 0x1EC00;
        if ((resetEntryRaw & 1) === 0)
        {
            throw new Error(`复位入口 0x${resetEntry.toString(16).toUpperCase()} 无效 (ARM Cortex-M0+ 必须为 Thumb 奇数地址)`);
        }
        if (resetEntry < appBase || resetEntry >= imageEnd || resetEntry >= appLimit)
        {
            throw new Error(`复位入口 0x${resetEntry.toString(16).toUpperCase()} 不在当前固件镜像内 (镜像范围 0x2000 ~ 0x${(imageEnd - 1).toString(16).toUpperCase()})`);
        }

        // 3. 计算以太网标准 CRC32
        const crc = computeCrc32(u8);

        this.firmwareData = u8;
        this.firmwareSize = size;
        this.firmwareCrc32 = crc;

        return {
            size,
            crc32: crc,
            crcHex: "0x" + crc.toString(16).padStart(8, "0").toUpperCase(),
            stackTopHex: "0x" + stackTop.toString(16).toUpperCase(),
            resetEntryHex: "0x" + resetEntryRaw.toString(16).toUpperCase(),
            checks: [
                { name: "文件大小合法", pass: true, detail: `${size} / 117,760 B` },
                { name: "栈顶地址合法", pass: true, detail: `0x${stackTop.toString(16).toUpperCase()}` },
                { name: "Reset Handler 合法 (Thumb)", pass: true, detail: `0x${resetEntryRaw.toString(16).toUpperCase()}` },
                { name: "以太网 CRC32 计算完成", pass: true, detail: `0x${crc.toString(16).padStart(8, "0").toUpperCase()}` }
            ]
        };
    }

    feedRawChunk(chunk)
    {
        // Why: OTA 期间普通串口解析被暂停，因此必须在这里跨分片识别 APP 启动标识。
        const bootText = this.bootTextDecoder.decode(chunk, { stream: true });
        this.bootTextBuffer = (this.bootTextBuffer + bootText).slice(-160);
        if (this.bootTextBuffer.includes("=== MSPM0G3507 IMU BOOT OK ==="))
        {
            this.appBooted = true;
            this.hub.setState(SerialState.RECEIVING);
        }

        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;

        // 响应帧固定 16 字节: 55 AA CMD SEQ(2B) 05 00 STATUS(1B) EXPECTED_OFFSET(4B) CRC32(4B)
        while (this.rxBuffer.length >= 16)
        {
            if (this.rxBuffer[0] !== 0x55 || this.rxBuffer[1] !== 0xAA)
            {
                this.rxBuffer = this.rxBuffer.slice(1);
                continue;
            }

            const frame = this.rxBuffer.slice(0, 16);
            const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
            const cmd = frame[2];
            const seq = view.getUint16(3, true);
            const status = frame[7];
            const expectedOffset = view.getUint32(8, true);
            const frameCrc = view.getUint32(12, true);

            // 校验响应 CRC
            const calcCrc = computeCrc32(frame, 2, 10);
            if (calcCrc !== frameCrc)
            {
                this.onLog(`[警告] 响应帧 CRC 校验不一致 (收到: 0x${frameCrc.toString(16)}, 计算: 0x${calcCrc.toString(16)})`, "warning");
                this.rxBuffer = this.rxBuffer.slice(1);
                continue;
            }

            this.rxBuffer = this.rxBuffer.slice(16);

            if (this.pendingResponse && seq === this.pendingResponse.seq)
            {
                const pending = this.pendingResponse;
                this.pendingResponse = null;
                pending.resolve({
                    isAck: cmd === 0x80,
                    isNack: cmd === 0x81,
                    cmd,
                    seq,
                    status,
                    expectedOffset
                });
            }
            else if (this.pendingResponse)
            {
                this.onLog(`[忽略] 收到过期响应 SEQ=${seq}，当前等待 SEQ=${this.pendingResponse.seq}`, "warning");
            }
        }
    }

    async sendCommandFrame(cmd, payload = new Uint8Array(0))
    {
        this.seq = (this.seq + 1) & 0xFFFF;
        const requestSeq = this.seq;
        const payloadLen = payload.length;
        const frameLen = 2 + 1 + 2 + 2 + payloadLen + 4;
        const frame = new Uint8Array(frameLen);
        const view = new DataView(frame.buffer);

        frame[0] = 0x55;
        frame[1] = 0xAA;
        frame[2] = cmd;
        view.setUint16(3, requestSeq, true);
        view.setUint16(5, payloadLen, true);
        if (payloadLen > 0)
        {
            frame.set(payload, 7);
        }

        const crc = computeCrc32(frame, 2, 5 + payloadLen);
        view.setUint32(7 + payloadLen, crc, true);

        const responsePromise = new Promise((resolve, reject) =>
        {
            this.pendingResponse = { seq: requestSeq, resolve, reject };
        });

        try
        {
            await this.hub.sendBytes(frame);
        }
        catch (error)
        {
            if (this.pendingResponse && this.pendingResponse.seq === requestSeq)
            {
                this.pendingResponse = null;
            }
            throw error;
        }
        return { seq: requestSeq, responsePromise };
    }

    async executeRequest(cmd, payload = new Uint8Array(0), timeoutMs = 400, maxRetries = 3)
    {
        for (let attempt = 1; attempt <= maxRetries; attempt++)
        {
            try
            {
                const { seq, responsePromise } = await this.sendCommandFrame(cmd, payload);
                let timeoutId;
                try
                {
                    return await Promise.race([
                        responsePromise,
                        new Promise((_, reject) =>
                        {
                            timeoutId = setTimeout(() =>
                            {
                                if (this.pendingResponse && this.pendingResponse.seq === seq)
                                {
                                    this.pendingResponse = null;
                                }
                                reject(new Error(`响应超时 (SEQ=${seq})`));
                            }, timeoutMs);
                        })
                    ]);
                }
                finally
                {
                    clearTimeout(timeoutId);
                }
            }
            catch (e)
            {
                if (attempt >= maxRetries) { throw e; }
                this.onLog(`[重传] 命令 0x0${cmd} 尝试第 ${attempt} 次未响应，正在重试...`, "warning");
                await new Promise(r => setTimeout(r, 60));
            }
        }
    }

    // 1. 发送 HELLO 握手检测 Bootloader
    async detectBootloader()
    {
        this.onLog("[检测] 正在发送 HELLO (0x01) 握手...", "info");
        const res = await this.executeRequest(0x01, new Uint8Array(0), 400, 3);
        if (res.isAck && res.status === 0)
        {
            this.hub.setState(SerialState.BOOTLOADER);
            this.onLog("[成功] Bootloader 握手成功，设备就绪！", "success");
            return true;
        }
        throw new Error(`Bootloader 返回异常: STATUS=${res.status}`);
    }

    // 2. 下发 OTA\r\n 请求进入 Bootloader
    async requestEnterOta()
    {
        this.onLog("[步骤 1/7] 发送 STOP 并下发 OTA 指令...", "info");
        await this.hub.sendText("STOP\r\n");
        await new Promise(r => setTimeout(r, 80));
        this.rxBuffer = new Uint8Array(0);
        await this.hub.sendText("OTA\r\n");
        await new Promise(r => setTimeout(r, 200));
    }

    // 7 步标准全自动化升级状态机
    async startUpgrade(versionStr = "1.0.0")
    {
        if (!this.firmwareData)
        {
            throw new Error("请先选择并完成 .bin 固件合法性校验");
        }
        if (this.isBusy)
        {
            throw new Error("OTA 升级已在进行中");
        }

        this.isBusy = true;
        this.pendingResponse = null;
        this.rxBuffer = new Uint8Array(0);
        this.appBooted = false;
        this.bootTextBuffer = "";
        this.bootTextDecoder = new TextDecoder("utf-8", { fatal: false });
        this.hub.setState(SerialState.OTA_WRITING);

        const startTime = performance.now();

        try
        {
            // 步骤 1: 停止 IMU 输出
            this.onStepChange(1, "1. 停止 IMU 数据流");
            this.onLog(`[步骤 1/7] 停止 IMU 数据输出 (固件大小: ${this.firmwareSize} B, CRC32: 0x${this.firmwareCrc32.toString(16).toUpperCase()})...`, "info");
            await this.hub.sendText("STOP\r\n");
            await new Promise(r => setTimeout(r, 60));
            this.rxBuffer = new Uint8Array(0);

            // 步骤 2: 请求进入 Bootloader
            this.onStepChange(2, "2. 请求进入 Bootloader");
            this.onLog("[步骤 2/7] 发送 OTA 进入 Bootloader...", "info");
            await this.hub.sendText("OTA\r\n");
            await new Promise(r => setTimeout(r, 150));

            // 步骤 3: HELLO 握手同步
            this.onStepChange(3, "3. HELLO 握手同步协议");
            this.onLog("[步骤 3/7] 发送 HELLO (0x01) 握手同步...", "info");
            let inBoot = false;
            for (let i = 0; i < 8; i++)
            {
                try
                {
                    const res = await this.executeRequest(0x01, new Uint8Array(0), 300, 1);
                    if (res.isAck && res.status === 0)
                    {
                        inBoot = true;
                        break;
                    }
                }
                catch (_)
                {
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            if (!inBoot)
            {
                throw new Error("无法连接 Bootloader，未收到 HELLO 握手响应");
            }
            this.onLog("[成功] Bootloader 握手通过！", "success");

            // 步骤 4: BEGIN 擦除 APP (长超时 8 秒)
            this.onStepChange(4, "4. 擦除 APP Flash 扇区");
            this.onLog("[步骤 4/7] 发送 BEGIN (0x02) 请求擦除 Flash 扇区 (请稍候 1~5 秒)...", "info");
            const beginPayload = new Uint8Array(12);
            const beginView = new DataView(beginPayload.buffer);
            beginView.setUint32(0, this.firmwareSize, true);
            beginView.setUint32(4, this.firmwareCrc32, true);
            beginView.setUint32(8, 1, true); // version

            const eraseStart = performance.now();
            const beginRes = await this.executeRequest(0x02, beginPayload, 8500, 2);
            if (!beginRes.isAck || beginRes.status !== 0)
            {
                throw new Error(`Flash 擦除失败 (BEGIN NACK: ${beginRes.status})`);
            }
            const eraseDuration = ((performance.now() - eraseStart) / 1000).toFixed(2);
            this.onLog(`[成功] Flash 擦除完成 (耗时 ${eraseDuration} 秒)！开始分包传输...`, "success");

            // 步骤 5: DATA 256B 分包传输
            this.onStepChange(5, "5. 发送固件数据 (256B/包)");
            const CHUNK_SIZE = 256;
            let currentOffset = 0;
            let lastLogOffset = 0;
            let totalPackets = Math.ceil(this.firmwareSize / CHUNK_SIZE);
            let retryCount = 0;

            while (currentOffset < this.firmwareSize && this.isBusy)
            {
                const chunkSize = Math.min(CHUNK_SIZE, this.firmwareSize - currentOffset);
                const chunkData = this.firmwareData.slice(currentOffset, currentOffset + chunkSize);

                const dataPayload = new Uint8Array(4 + chunkSize);
                const dataView = new DataView(dataPayload.buffer);
                dataView.setUint32(0, currentOffset, true);
                dataPayload.set(chunkData, 4);

                let dataRes;
                try
                {
                    dataRes = await this.executeRequest(0x03, dataPayload, 450, 4);
                }
                catch (err)
                {
                    retryCount++;
                    throw err;
                }

                if (dataRes.isAck && dataRes.status === 0)
                {
                    if (dataRes.expectedOffset <= currentOffset || dataRes.expectedOffset > this.firmwareSize)
                    {
                        throw new Error(`设备返回非法下一偏移: ${dataRes.expectedOffset}`);
                    }
                    currentOffset = dataRes.expectedOffset;
                }
                else if (dataRes.status === 4) // BAD_OFFSET: 自动跳转至设备期望偏移
                {
                    if (dataRes.expectedOffset === currentOffset || dataRes.expectedOffset > this.firmwareSize)
                    {
                        throw new Error(`设备返回非法校正偏移: ${dataRes.expectedOffset}`);
                    }
                    retryCount++;
                    this.onLog(`[断点校正] 设备请求跳转至偏移: ${dataRes.expectedOffset}`, "warning");
                    currentOffset = dataRes.expectedOffset;
                }
                else
                {
                    throw new Error(`DATA 传输异常: STATUS=${dataRes.status}`);
                }

                // 进度与速率
                const pct = Math.min(100, Math.round((currentOffset / this.firmwareSize) * 100));
                const elapsedSec = (performance.now() - startTime) / 1000;
                const speedKb = elapsedSec > 0 ? ((currentOffset / 1024) / elapsedSec).toFixed(1) : "0.0";
                const remainSec = Number(speedKb) > 0 ? Math.max(0, Math.round(((this.firmwareSize - currentOffset) / 1024) / Number(speedKb))) : 0;
                const pktIdx = Math.ceil(currentOffset / CHUNK_SIZE);

                this.onProgress({
                    percent: pct,
                    currentBytes: currentOffset,
                    totalBytes: this.firmwareSize,
                    speedKb: speedKb,
                    remainSec: remainSec,
                    packetIndex: pktIdx,
                    totalPackets: totalPackets,
                    retries: retryCount,
                    offset: currentOffset
                });

                if (currentOffset - lastLogOffset >= 4096 || currentOffset >= this.firmwareSize)
                {
                    lastLogOffset = currentOffset;
                    this.onLog(`[传输] 进度: ${pct}% (${currentOffset}/${this.firmwareSize} B, ${speedKb} KB/s, 包 ${pktIdx}/${totalPackets})`, "info");
                }
            }

            if (!this.isBusy)
            {
                throw new Error("用户手动取消了升级");
            }

            // 步骤 6: END 整包校验 (长超时 4 秒)
            this.onStepChange(6, "6. 整包 CRC 校验与复位");
            this.onLog("[步骤 6/7] 数据发送完毕，发送 END (0x04) 请求整包校验与复位...", "info");
            this.appBooted = false;
            this.bootTextBuffer = "";
            this.bootTextDecoder = new TextDecoder("utf-8", { fatal: false });
            const endRes = await this.executeRequest(0x04, new Uint8Array(0), 4500, 2);
            if (!endRes.isAck || endRes.status !== 0)
            {
                throw new Error(`END 校验失败: STATUS=${endRes.status}`);
            }
            this.onLog("[成功] 整包 CRC32 校验一致！Bootloader 正在执行系统复位...", "success");

            // 步骤 7: 等待 APP 重启
            this.onStepChange(7, "7. 等待 APP 重启上线");
            this.onLog("[步骤 7/7] 等待 APP 启动标识 (=== MSPM0G3507 IMU BOOT OK ===)...", "info");
            const bootWaitStart = performance.now();
            while (performance.now() - bootWaitStart < 5000)
            {
                if (this.appBooted)
                {
                    break;
                }
                await new Promise(r => setTimeout(r, 100));
            }
            if (!this.appBooted)
            {
                throw new Error("固件校验已通过，但未检测到 APP 启动标识");
            }

            const totalDuration = ((performance.now() - startTime) / 1000).toFixed(2);
            this.onLog(`[恭喜] 固件升级全部成功！APP 正常上线 (总耗时: ${totalDuration} 秒)`, "success");
            return true;
        }
        catch (error)
        {
            this.onLog(`[错误] 固件升级终止: ${error.message}`, "error");
            this.hub.setState(SerialState.ERROR);
            throw error;
        }
        finally
        {
            this.isBusy = false;
        }
    }

    cancelUpgrade()
    {
        if (this.isBusy)
        {
            this.isBusy = false;
            if (this.pendingResponse)
            {
                const pending = this.pendingResponse;
                this.pendingResponse = null;
                pending.reject(new Error("用户手动取消了升级"));
            }
            this.onLog("[警告] 用户已手动取消升级。注意：设备 Flash 可能已被擦除，将停留在 Bootloader，必须重新完整升级才能恢复运行！", "warning");
        }
    }
}

if (typeof window !== "undefined")
{
    window.SerialState = SerialState;
    window.ImuUnifiedSerialHub = ImuUnifiedSerialHub;
    window.ImuOtaEngine = ImuOtaEngine;
    window.computeCrc32 = computeCrc32;
}
