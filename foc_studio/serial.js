"use strict";

class FocSerial
{
    constructor()
    {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.rxBuffer = new Uint8Array(0);
        this.txChain = Promise.resolve();
        this.otaTransmissionActive = false;
        this.isConnected = false;
        this.frameCount = 0;
        this.resyncByteCount = 0;
        this.invalidFrameCount = 0;
        this.connectionGeneration = 0;

        this.onFrame = () => {};
        this.onRawData = () => {};
        this.onTransmit = () => {};
        this.onConnectionChange = () => {};
        this.onError = () => {};
    }

    async openPort()
    {
        await this.port.open({
            baudRate: 460800,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            bufferSize: 4096
        });

        // Why: 不主动改变 DTR/RTS，避免不同 USB 串口或目标板复位电路产生额外副作用。
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
            // Why: 设备异常时 writer.write() 可能长期不返回，主动断开不能因此永久卡死。
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

        // Why: CH340 偶发的首次读取失败需要完整释放端口锁，再复用用户已授权的同一端口。
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

    async connect()
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
        this.otaTransmissionActive = false;
        this.rxBuffer = new Uint8Array(0);
        this.frameCount = 0;
        this.resyncByteCount = 0;
        this.invalidFrameCount = 0;
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
        this.otaTransmissionActive = false;
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
        this.rxBuffer = new Uint8Array(0);
        this.txChain = Promise.resolve();
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
                !this.otaTransmissionActive &&
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
            this.otaTransmissionActive = false;
            await this.settlePendingWrites();
            this.onError(detail);
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
            this.onConnectionChange(false);
        }
    }

    appendReceiveData(chunk)
    {
        this.onRawData(chunk);
        const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
        merged.set(this.rxBuffer, 0);
        merged.set(chunk, this.rxBuffer.length);
        this.rxBuffer = merged;
        this.processReceiveBuffer();

        if (this.rxBuffer.length > 4096)
        {
            const keep = this.rxBuffer.slice(-23);
            this.resyncByteCount += this.rxBuffer.length - keep.length;
            this.rxBuffer = keep;
        }
    }

    processReceiveBuffer()
    {
        const tail = [0x00, 0x00, 0x80, 0x7F];

        while (this.rxBuffer.length >= 4)
        {
            const tailIndex = this.findSequence(this.rxBuffer, tail);
            if (tailIndex < 0)
            {
                return;
            }

            if (tailIndex < 20)
            {
                this.resyncByteCount += tailIndex + 4;
                this.rxBuffer = this.rxBuffer.slice(tailIndex + 4);
                continue;
            }

            const frameStart = tailIndex - 20;
            if (frameStart > 0)
            {
                this.resyncByteCount += frameStart;
            }
            const payload = this.rxBuffer.slice(frameStart, tailIndex);
            this.rxBuffer = this.rxBuffer.slice(tailIndex + 4);

            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const values = [];
            let valid = true;
            for (let i = 0; i < 5; i++)
            {
                const value = view.getFloat32(i * 4, true);
                if (!Number.isFinite(value) || Math.abs(value) > 1e9)
                {
                    valid = false;
                    break;
                }
                values.push(value);
            }

            if (valid)
            {
                this.frameCount++;
                this.onFrame(values);
            }
            else
            {
                this.invalidFrameCount++;
            }
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

    sendCommand(command, rawData = 0, aux = 0)
    {
        if (!this.isConnected || !this.writer)
        {
            return Promise.reject(new Error("串口尚未连接"));
        }
        if (this.otaTransmissionActive)
        {
            return Promise.reject(new Error("OTA 升级期间不能发送普通控制命令"));
        }

        const raw = rawData & 0xFFFF;
        const generation = this.connectionGeneration;
        const frame = new Uint8Array([
            0xFF,
            command & 0xFF,
            raw & 0xFF,
            (raw >>> 8) & 0xFF,
            aux & 0xFF,
            0xFE
        ]);

        const operation = async () =>
        {
            if (!this.isConnected || !this.writer || generation !== this.connectionGeneration)
            {
                throw new Error("串口连接已变更，旧命令已丢弃");
            }
            // Why: OTA 帧和普通控制帧共用串口，升级开始后必须丢弃尚未执行的旧命令。
            if (this.otaTransmissionActive)
            {
                throw new Error("OTA 升级期间不能发送普通控制命令");
            }
            await this.writer.write(frame);
            this.onTransmit(frame);
        };

        const result = this.txChain.then(operation, operation);
        this.txChain = result.catch(() => {});
        return result;
    }

    beginOtaTransmission()
    {
        if (!this.isConnected || !this.writer)
        {
            throw new Error("串口尚未连接");
        }
        if (this.otaTransmissionActive)
        {
            throw new Error("OTA 串口发送通道已被占用");
        }
        this.otaTransmissionActive = true;
    }

    endOtaTransmission()
    {
        this.otaTransmissionActive = false;
    }

    sendOtaBytes(bytes)
    {
        if (!this.otaTransmissionActive)
        {
            return Promise.reject(new Error("OTA 串口发送通道尚未启用"));
        }

        const generation = this.connectionGeneration;
        const frame = new Uint8Array(bytes);
        const operation = async () =>
        {
            if (!this.isConnected || !this.writer || generation !== this.connectionGeneration)
            {
                throw new Error("串口连接已变更，OTA 数据未发送");
            }
            await this.writer.write(frame);
            this.onTransmit(frame);
        };

        // Why: 所有写操作共用同一队列，避免普通命令与 OTA 帧在字节流中交叉。
        const result = this.txChain.then(operation, operation);
        this.txChain = result.catch(() => {});
        return result;
    }

    static toHex(bytes)
    {
        return Array.from(bytes, value => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    }
}

window.FocSerial = FocSerial;
