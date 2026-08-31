const PackageBuilder = {
    // 0xEDB88320 is the reversed polynomial for standard Ethernet CRC32
    crc32(data, start = 0, length = data.length) {
        let crc = 0xFFFFFFFF;
        for (let i = start; i < start + length; i++) {
            crc ^= data[i];
            for (let j = 0; j < 8; j++) {
                if (crc & 1) {
                    crc = (crc >>> 1) ^ 0xEDB88320;
                } else {
                    crc = crc >>> 1;
                }
            }
        }
        return (~crc) >>> 0; // Convert to unsigned 32-bit integer
    },

    build(resources, screenWidth = 280, screenHeight = 240) {
        if (!Array.isArray(resources) || resources.length === 0) {
            throw new Error("请至少添加一个资源");
        }
        if (resources.length > 64) {
            throw new Error("资源数量不能超过64个");
        }

        const usedIds = new Set();
        let dataPayloadSize = 0;
        for (const res of resources) {
            if (!Number.isInteger(res.id) || res.id < 1 || res.id > 65535) {
                throw new Error(`资源ID无效: ${res.id}`);
            }
            if (usedIds.has(res.id)) {
                throw new Error(`资源ID重复: ${res.id}`);
            }
            usedIds.add(res.id);

            if (!Number.isInteger(res.width) || !Number.isInteger(res.height) ||
                res.width < 1 || res.width > screenWidth || res.height < 1 || res.height > screenHeight) {
                throw new Error(`资源 ${res.id} 尺寸无效`);
            }
            const defaultX = Number.isInteger(res.defaultX) ? res.defaultX : 0;
            const defaultY = Number.isInteger(res.defaultY) ? res.defaultY : 0;
            if (defaultX < -32768 || defaultX > 32767 || defaultY < -32768 || defaultY > 32767 ||
                defaultX >= screenWidth || defaultY >= screenHeight ||
                defaultX + res.width <= 0 || defaultY + res.height <= 0) {
                throw new Error(`资源 ${res.id} 的默认位置完全超出屏幕`);
            }
            const isAnimation = res.type === "animation";
            const frameCount = isAnimation ? res.frameCount : 1;
            if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 65535) {
                throw new Error(`资源 ${res.id} 的帧数无效`);
            }
            if (isAnimation && (!Number.isInteger(res.intervalMs) || res.intervalMs < 1 || res.intervalMs > 65535)) {
                throw new Error(`动画 ${res.id} 的帧间隔无效`);
            }
            const expectedSize = res.width * res.height * 2 * frameCount;
            if (!(res.data instanceof Uint8Array) || res.data.length !== expectedSize) {
                throw new Error(`资源 ${res.id} 的RGB565数据长度错误`);
            }
            dataPayloadSize += res.data.length;
        }
        
        const DIR_SIZE = 0x1000;
        const totalLength = DIR_SIZE + dataPayloadSize;
        
        if (totalLength > 4 * 1024 * 1024) {
            throw new Error(`资源包大小超过 4MB 限制 (${(totalLength/1024/1024).toFixed(2)} MB)`);
        }

        const buffer = new ArrayBuffer(totalLength);
        const view = new DataView(buffer);
        const u8 = new Uint8Array(buffer);

        // --- 1. Fill Data Payload (at offset 0x1000) ---
        let currentDataOffset = DIR_SIZE;
        for (const res of resources) {
            /* RGB565必须从偶数地址开始；当前数据长度也是偶数，此检查防止格式扩展后破坏约束。 */
            if ((currentDataOffset & 1) !== 0) {
                currentDataOffset++;
            }
            res.computedDataOffset = currentDataOffset;
            res.computedDataSize = res.data.length;
            u8.set(res.data, currentDataOffset);
            currentDataOffset += res.computedDataSize;
        }

        // --- 2. Fill Directory (Header + Index) ---
        // ResourceHeader_t (36 bytes)
        view.setUint32(0, 0x53523748, true); // "H7RS" in little-endian
        view.setUint32(4, 1, true); // formatVersion
        view.setUint32(8, 1, true); // packageVersion
        view.setUint32(12, 1, true); // generation
        view.setUint32(16, totalLength, true); // totalLength
        view.setUint32(20, resources.length, true); // resourceCount
        view.setUint32(24, DIR_SIZE, true); // dataOffset
        
        // Compute packageCrc32 (over data payload)
        const packageCrc = this.crc32(u8, DIR_SIZE, dataPayloadSize);
        view.setUint32(28, packageCrc, true); // packageCrc32

        // ResourceIndex_t starts at offset 36
        let idxOffset = 36;
        for (const res of resources) {
            view.setUint16(idxOffset, res.id, true); // resourceId
            const isAnimation = res.type === "animation";
            view.setUint8(idxOffset + 2, isAnimation ? 1 : 0); // IMAGE=0, ANIMATION=1
            view.setUint8(idxOffset + 3, 0); // format = RESOURCE_FORMAT_RGB565_BE
            view.setUint16(idxOffset + 4, res.width, true); // width
            view.setUint16(idxOffset + 6, res.height, true); // height
            view.setUint16(idxOffset + 8, isAnimation ? res.frameCount : 1, true);
            view.setUint16(idxOffset + 10, isAnimation ? res.intervalMs : 0, true);
            view.setUint32(idxOffset + 12, res.computedDataOffset, true); // dataOffset
            view.setUint32(idxOffset + 16, res.computedDataSize, true); // dataSize
            const positionX = Number.isInteger(res.defaultX) ? res.defaultX : 0;
            const positionY = Number.isInteger(res.defaultY) ? res.defaultY : 0;
            const packedPosition = ((positionY & 0xFFFF) << 16) | (positionX & 0xFFFF);
            view.setUint32(idxOffset + 20, packedPosition >>> 0, true);
            view.setUint32(idxOffset + 24, 0, true); // indexOffset
            view.setUint32(idxOffset + 28, 0, true); // indexSize
            idxOffset += 32;
        }

        // Compute directoryCrc32
        // To compute this, magic (offset 0) and directoryCrc32 (offset 32) must be temporarily 0
        const magicBackup = view.getUint32(0, true);
        view.setUint32(0, 0, true);
        view.setUint32(32, 0, true);
        const dirCrc = this.crc32(u8, 0, DIR_SIZE);
        
        // Restore magic and set directoryCrc32
        view.setUint32(0, magicBackup, true);
        view.setUint32(32, dirCrc, true);

        return u8;
    }
};

if (typeof window !== "undefined")
{
    window.PackageBuilder = PackageBuilder;
}
if (typeof module !== "undefined")
{
    module.exports = PackageBuilder;
}
