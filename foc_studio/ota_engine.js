"use strict";

/**
 * TI MSPM0 G3507 电机串口 OTA 固件升级引擎
 * 协议规范:
 * 1. 串口参数: 460800 baud, 8N1
 * 2. 触发进入口令: [0xFF, 0xE0, 0x4F, 0x54, 0x41, 0xFE]
 * 3. 帧格式: 55 AA CMD SEQ(2B) LEN(2B) PAYLOAD(NB) CRC32(4B) (全部小端)
 * 4. CRC32: Poly 0xEDB88320, Init 0xFFFFFFFF, Final ~val
 * 5. 命令:
 *    - HELLO (0x01): 空负载握手
 *    - BEGIN (0x02): 12字节 [size(uint32), crc32(uint32), version(uint32)]
 *    - DATA  (0x03): [offset(uint32) + 256字节数据]
 *    - END   (0x04): 完整性校验与复位重启
 * 6. ACK/NACK (0x80/0x81): 16字节 [55 AA CMD SEQ(2B) 05 00 STATUS(1B) OFFSET(4B) CRC32(4B)]
 */
class FocOtaEngine
{
    constructor(serial)
    {
        this.serial = serial;
        this.crcTable = FocOtaEngine.makeCrcTable();
        this.isRunning = false;
        this.abortRequested = false;

        this.seq = 0;
        this.firmwareBytes = null;
        this.firmwareSize = 0;
        this.firmwareCrc32 = 0;
        this.firmwareVersion = 1;

        // 回调钩子
        this.onProgress = () => {};
        this.onLog = () => {};
        this.onStateChange = () => {};
        this.onComplete = () => {};
        this.onError = () => {};
        this.onVerifyApplication = async () => {};
        this.onAbort = () => {};

        // 接收匹配等待
        this.pendingResponse = null;
        this.rxBuffer = new Uint8Array(0);
    }

    static makeCrcTable()
    {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++)
        {
            let c = i;
            for (let k = 0; k < 8; k++)
            {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c >>> 0;
        }
        return table;
    }

    /**
     * 计算指定 Uint8Array 缓冲区的 CRC32 (IEEE 802.3 标准)
     */
    computeCrc32(data, start = 0, length = data.length)
    {
        let crc = 0xFFFFFFFF;
        const end = start + length;
        for (let i = start; i < end; i++)
        {
            crc = (this.crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    validateFirmware(arrayBuffer)
    {
        const bytes = new Uint8Array(arrayBuffer);
        const appBase = 0x2000;
        const appLimit = 0x1EC00;
        const maxSize = appLimit - appBase;

        if (bytes.length < 8 || bytes.length > maxSize)
        {
            throw new Error(`固件大小无效：${bytes.length} 字节，允许范围 8-${maxSize} 字节`);
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const stackTop = view.getUint32(0, true);
        const resetRaw = view.getUint32(4, true);
        const resetEntry = resetRaw & 0xFFFFFFFE;
        const imageEnd = appBase + bytes.length;

        if (stackTop < 0x20200000 || stackTop > 0x20208000 || (stackTop & 7) !== 0)
        {
            throw new Error(`固件栈顶地址无效：0x${stackTop.toString(16).toUpperCase().padStart(8, "0")}`);
        }
        if ((resetRaw & 1) === 0)
        {
            throw new Error(`Reset Handler 不是 Thumb 地址：0x${resetRaw.toString(16).toUpperCase().padStart(8, "0")}`);
        }
        // Why: 只接受入口位于本次 BIN 实际镜像内的 APP，防止误选 Bootloader、Factory HEX 或截断固件。
        if (resetEntry < appBase || resetEntry >= imageEnd || resetEntry >= appLimit)
        {
            throw new Error(`Reset Handler 不在固件镜像内：0x${resetEntry.toString(16).toUpperCase().padStart(8, "0")}`);
        }

        return { stackTop, resetEntry, size: bytes.length };
    }

    /**
     * 打包 OTA 协议帧: 55 AA CMD SEQ_L SEQ_H LEN_L LEN_H PAYLOAD CRC32
     */
    buildFrame(cmd, payload = new Uint8Array(0))
    {
        const seq = (this.seq++) & 0xFFFF;
        const len = payload.length & 0xFFFF;
        const frameLength = 2 + 1 + 2 + 2 + payload.length + 4;
        const buf = new Uint8Array(frameLength);
        const view = new DataView(buf.buffer);

        // 帧头 55 AA
        buf[0] = 0x55;
        buf[1] = 0xAA;
        // CMD
        buf[2] = cmd & 0xFF;
        // SEQ (小端)
        view.setUint16(3, seq, true);
        // LEN (小端)
        view.setUint16(5, len, true);
        // PAYLOAD
        if (payload.length > 0)
        {
            buf.set(payload, 7);
        }

        // CRC32 计算范围: CMD + SEQ + LEN + PAYLOAD (不包含 55 AA 和 CRC32 自身)
        const crcCalcLen = 1 + 2 + 2 + payload.length;
        const crc32 = this.computeCrc32(buf, 2, crcCalcLen);
        view.setUint32(7 + payload.length, crc32, true);

        return { bytes: buf, seq };
    }

    /**
     * 接管接收流字节
     */
    feedRawBytes(chunk)
    {
        if (!this.isRunning)
        {
            return;
        }

        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;

        this.processRxBuffer();
    }

    processRxBuffer()
    {
        // ACK/NACK 固定长度 16 字节: 55 AA CMD SEQ(2B) 05 00 STATUS(1B) OFFSET(4B) CRC32(4B)
        while (this.rxBuffer.length >= 16)
        {
            // 查找帧头 55 AA
            let headerIndex = -1;
            for (let i = 0; i <= this.rxBuffer.length - 2; i++)
            {
                if (this.rxBuffer[i] === 0x55 && this.rxBuffer[i + 1] === 0xAA)
                {
                    headerIndex = i;
                    break;
                }
            }

            if (headerIndex < 0)
            {
                this.rxBuffer = this.rxBuffer.slice(-1);
                return;
            }

            if (headerIndex > 0)
            {
                this.rxBuffer = this.rxBuffer.slice(headerIndex);
            }

            if (this.rxBuffer.length < 16)
            {
                return;
            }

            const frame = this.rxBuffer.slice(0, 16);
            const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
            const cmd = frame[2];
            const seq = view.getUint16(3, true);
            const len = view.getUint16(5, true);

            // 校验 ACK/NACK 帧长度与命令类型
            if ((cmd === 0x80 || cmd === 0x81) && len === 5)
            {
                // 校验帧 CRC
                const frameCrc = this.computeCrc32(frame, 2, 10);
                const rxCrc = view.getUint32(12, true);

                if (frameCrc === rxCrc)
                {
                    const status = frame[7];
                    const offset = view.getUint32(8, true);
                    this.rxBuffer = this.rxBuffer.slice(16);
                    this.handleResponse({ cmd, isAck: cmd === 0x80, status, offset, seq });
                    continue;
                }
            }

            // CRC 或格式不匹配，滑动 1 字节重新搜寻
            this.rxBuffer = this.rxBuffer.slice(1);
        }
    }

    handleResponse(resp)
    {
        if (this.pendingResponse && resp.seq === this.pendingResponse.expectedSeq)
        {
            const pending = this.pendingResponse;
            this.pendingResponse = null;
            clearTimeout(pending.timer);
            pending.resolve(resp);
        }
    }

    /**
     * 等待指定命令响应或超时
     */
    waitForResponse(expectedSeq, timeoutMs = 1000)
    {
        if (this.pendingResponse)
        {
            throw new Error("已有 OTA 响应正在等待");
        }

        return new Promise((resolve, reject) =>
        {
            const timer = setTimeout(() =>
            {
                if (this.pendingResponse && this.pendingResponse.expectedSeq === expectedSeq)
                {
                    this.pendingResponse = null;
                    reject(new Error(`响应超时 (${timeoutMs}ms)`));
                }
            }, timeoutMs);

            this.pendingResponse = { expectedSeq, resolve, reject, timer };
        });
    }

    cancelPendingResponse(error)
    {
        if (!this.pendingResponse)
        {
            return;
        }

        const pending = this.pendingResponse;
        this.pendingResponse = null;
        clearTimeout(pending.timer);
        pending.reject(error);
    }

    async sendAndWait(frame, timeoutMs)
    {
        // Why: 先安装等待器，避免 Bootloader 的快速 ACK 在 writer.write() 返回前到达并丢失。
        const responsePromise = this.waitForResponse(frame.seq, timeoutMs);
        try
        {
            await this.serial.sendOtaBytes(frame.bytes);
            return await responsePromise;
        }
        catch (error)
        {
            this.cancelPendingResponse(error);
            await responsePromise.catch(() => {});
            throw error;
        }
    }

    getStatusText(code)
    {
        switch (code)
        {
            case 0: return "成功 (SUCCESS)";
            case 1: return "帧格式错误 (FRAME_ERROR)";
            case 2: return "状态机错误 (STATE_ERROR)";
            case 3: return "固件大小错误 (SIZE_ERROR)";
            case 4: return "偏移地址错误 (OFFSET_ERROR)";
            case 5: return "Flash 擦除/写入错误 (FLASH_ERROR)";
            case 6: return "整包 CRC32 校验错误 (CRC_ERROR)";
            case 7: return "Application 向量表错误 (VECTOR_ERROR)";
            default: return `未知错误码 (${code})`;
        }
    }

    /**
     * 启动 OTA 升级全流程
     */
    async startUpgrade(arrayBuffer, version = 1)
    {
        if (!this.serial || !this.serial.isConnected)
        {
            throw new Error("串口尚未连接，请先连接电机串口 (460800 baud)");
        }
        if (this.isRunning)
        {
            throw new Error("OTA 升级任务正在运行中");
        }

        this.validateFirmware(arrayBuffer);
        this.firmwareBytes = new Uint8Array(arrayBuffer);
        this.firmwareSize = this.firmwareBytes.length;
        this.firmwareCrc32 = this.computeCrc32(this.firmwareBytes);
        this.firmwareVersion = version;

        this.serial.beginOtaTransmission();
        this.isRunning = true;
        this.abortRequested = false;
        this.seq = 0;
        this.rxBuffer = new Uint8Array(0);

        this.log(`准备升级固件: 大小 ${this.firmwareSize} 字节, CRC32: 0x${this.firmwareCrc32.toString(16).toUpperCase().padStart(8, '0')}`, "info");

        try
        {
            // Step 1: 发送口令请求 Application 失能电机并复位进 Bootloader
            await this.stepTriggerOta();

            // Step 2: 握手 HELLO
            await this.stepHandshakeHello();

            // Step 3: 开始 BEGIN (告知固件大小与 CRC32，等待擦除 Flash)
            await this.stepBeginErase();

            // Step 4: 256 字节分包传输 DATA
            await this.stepTransferData();

            // Step 5: 发送 END (整包校验与重启)
            await this.stepFinishEnd();

            // Why: END 只证明 Flash 内容正确；收到新 APP 的合法遥测帧后才能确认程序真正启动。
            this.serial.endOtaTransmission();
            this.onStateChange("RESTARTING", 98);
            this.log("等待新 Application 启动并返回 JustFloat 遥测...", "info");
            await this.onVerifyApplication();

            this.log("✅ 已收到新 Application 的合法 JustFloat 遥测，OTA 升级完成", "success");
            this.onStateChange("SUCCESS", 100);
            this.onComplete();
        }
        catch (error)
        {
            this.log(`❌ 固件升级终止: ${error.message}`, "error");
            this.onError(error);
        }
        finally
        {
            this.cancelPendingResponse(new Error("OTA 流程已结束"));
            this.isRunning = false;
            this.serial.endOtaTransmission();
        }
    }

    abort()
    {
        if (this.isRunning)
        {
            this.abortRequested = true;
            this.cancelPendingResponse(new Error("升级已中止"));
            this.onAbort();
            this.log("⚠️ 用户请求中止 OTA 升级", "warning");
        }
    }

    async stepTriggerOta()
    {
        if (this.abortRequested) { throw new Error("升级已中止"); }
        this.onStateChange("TRIGGERING", 2);
        this.log("发送进入 OTA 口令 [FF E0 4F 54 41 FE]...", "info");

        const enterToken = new Uint8Array([0xFF, 0xE0, 0x4F, 0x54, 0x41, 0xFE]);
        await this.serial.sendOtaBytes(enterToken);
        // 等待单片机关闭 PWM、写入 REQUESTED 标志并软件复位
        await this.delay(350);
    }

    async stepHandshakeHello()
    {
        if (this.abortRequested) { throw new Error("升级已中止"); }
        this.onStateChange("HANDSHAKE", 5);
        this.log("正在与 Bootloader 握手 (发送 HELLO)...", "info");

        let connected = false;
        const maxRetries = 40; // 最大重试 4 秒

        for (let i = 0; i < maxRetries; i++)
        {
            if (this.abortRequested) { throw new Error("升级已中止"); }

            const helloFrame = this.buildFrame(0x01);

            try
            {
                const resp = await this.sendAndWait(helloFrame, 100);
                if (resp.isAck && resp.status === 0)
                {
                    connected = true;
                    this.log("✅ 成功与 Bootloader 建立通信！", "success");
                    break;
                }
            }
            catch (e)
            {
                // 等待单次超时，继续重发 HELLO
            }
        }

        if (!connected)
        {
            throw new Error("Bootloader 握手超时，未收到 HELLO ACK，请检查下位机是否支持 OTA");
        }
    }

    async stepBeginErase()
    {
        if (this.abortRequested) { throw new Error("升级已中止"); }
        this.onStateChange("ERASING", 8);
        this.log("发送 BEGIN 指令 (申请擦除 Flash 扇区，可能需要数秒)...", "info");

        // Payload 12 字节: size (uint32), crc32 (uint32), version (uint32)
        const payload = new Uint8Array(12);
        const view = new DataView(payload.buffer);
        view.setUint32(0, this.firmwareSize, true);
        view.setUint32(4, this.firmwareCrc32, true);
        view.setUint32(8, this.firmwareVersion, true);

        const beginFrame = this.buildFrame(0x02, payload);

        // Flash 擦除超时设为 6000ms
        const resp = await this.sendAndWait(beginFrame, 6000).catch(() =>
        {
            throw new Error("BEGIN 擦除 Flash 超时 (6 秒无响应)");
        });

        if (!resp.isAck || resp.status !== 0)
        {
            throw new Error(`BEGIN 擦除失败: ${this.getStatusText(resp.status)}`);
        }

        this.log("✅ Flash 擦除完成，Bootloader 已进入 WRITING 状态", "success");
    }

    async stepTransferData()
    {
        this.onStateChange("TRANSFERRING", 10);
        this.log("🚀 开始 256 字节分包极速写入 Flash...", "info");

        const packetSize = 256;
        let currentOffset = 0;
        const startTime = performance.now();
        let lastProgressTime = startTime;

        while (currentOffset < this.firmwareSize)
        {
            if (this.abortRequested) { throw new Error("升级已中止"); }

            let packetSuccess = false;
            let retryCount = 0;

            while (!packetSuccess && retryCount < 5)
            {
                const packetOffset = currentOffset;
                const chunkEnd = Math.min(packetOffset + packetSize, this.firmwareSize);
                const chunkData = this.firmwareBytes.slice(packetOffset, chunkEnd);

                // DATA Payload: offset (uint32小端) + 实际数据
                const payload = new Uint8Array(4 + chunkData.length);
                const view = new DataView(payload.buffer);
                view.setUint32(0, packetOffset, true);
                payload.set(chunkData, 4);
                const dataFrame = this.buildFrame(0x03, payload);

                try
                {
                    const resp = await this.sendAndWait(dataFrame, 1200);
                    if (resp.isAck && resp.status === 0)
                    {
                        if (resp.offset !== chunkEnd)
                        {
                            throw new Error(`DATA ACK 偏移异常: 期望 0x${chunkEnd.toString(16)}，收到 0x${resp.offset.toString(16)}`);
                        }
                        packetSuccess = true;
                        currentOffset = resp.offset;
                    }
                    else
                    {
                        retryCount++;
                        this.log(`⚠️ 分包 Offset 0x${packetOffset.toString(16)} 收到 NACK: ${this.getStatusText(resp.status)}，重试 (${retryCount}/5)`, "warning");

                        // Why: 只接受本包起点或终点，防止旧响应造成倒退、越界或跳包。
                        if (resp.offset !== packetOffset && resp.offset !== chunkEnd)
                        {
                            throw new Error(`DATA NACK 偏移异常: 当前包 0x${packetOffset.toString(16)}-0x${chunkEnd.toString(16)}，收到 0x${resp.offset.toString(16)}`);
                        }
                        if (resp.offset === chunkEnd)
                        {
                            currentOffset = chunkEnd;
                            packetSuccess = true;
                        }
                    }
                }
                catch (err)
                {
                    if (!err.message.startsWith("响应超时"))
                    {
                        throw err;
                    }
                    retryCount++;
                    this.log(`⚠️ 分包 Offset 0x${currentOffset.toString(16)} 响应超时，重试 (${retryCount}/5)...`, "warning");
                }
            }

            if (!packetSuccess)
            {
                throw new Error(`分包写入失败 (Offset 0x${currentOffset.toString(16)})，超过最大重试次数`);
            }

            // 进度节流通知
            const now = performance.now();
            if (now - lastProgressTime > 80 || currentOffset >= this.firmwareSize)
            {
                lastProgressTime = now;
                const percent = Math.min(95, 10 + (currentOffset / this.firmwareSize) * 85);
                const elapsedSec = (now - startTime) / 1000;
                const speedKbps = elapsedSec > 0 ? ((currentOffset / 1024) / elapsedSec).toFixed(1) : "0.0";
                const remainingBytes = this.firmwareSize - currentOffset;
                const etaSec = speedKbps > 0 ? (remainingBytes / (speedKbps * 1024)).toFixed(0) : "0";

                this.onProgress({
                    percent: Number(percent.toFixed(1)),
                    sentBytes: currentOffset,
                    totalBytes: this.firmwareSize,
                    speedKbps,
                    etaSeconds: etaSec
                });
            }
        }

        this.log("✅ 所有固件数据分包已 100% 发送完毕", "success");
    }

    async stepFinishEnd()
    {
        if (this.abortRequested) { throw new Error("升级已中止"); }
        this.onStateChange("VERIFYING", 96);
        this.log("发送 END 指令 (Bootloader 正在进行整包 CRC32 校验与向量表检查)...", "info");

        const endFrame = this.buildFrame(0x04);

        // 校验整包超时设为 3000ms
        const resp = await this.sendAndWait(endFrame, 3000).catch(() =>
        {
            throw new Error("END 校验超时 (3 秒无响应)");
        });

        if (!resp.isAck || resp.status !== 0)
        {
            throw new Error(`END 校验失败: ${this.getStatusText(resp.status)}`);
        }

        this.log("✅ Bootloader 整包 CRC32 校验通过，中断向量表合法，OTA 状态已清除！", "success");
    }

    delay(ms)
    {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    log(message, level = "info")
    {
        const time = new Date().toLocaleTimeString();
        this.onLog(`[${time}] ${message}`, level);
    }
}

if (typeof window !== "undefined")
{
    window.FocOtaEngine = FocOtaEngine;
}
