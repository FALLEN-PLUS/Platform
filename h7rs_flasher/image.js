const ImageProcessor = {
    async loadFromFile(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error("Failed to load image"));
            };
            img.src = url;
        });
    },

    process(img, targetWidth, targetHeight, scaleMode, bgColor) {
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        /* 图片、视频和 Canvas 的原始尺寸字段不同，统一取真实像素尺寸。 */
        const sourceWidth = img.videoWidth || img.naturalWidth || img.width;
        const sourceHeight = img.videoHeight || img.naturalHeight || img.height;
        if (!sourceWidth || !sourceHeight) {
            throw new Error('源图像尺寸无效，视频帧可能尚未解码');
        }

        // Fill background
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, targetWidth, targetHeight);

        let drawX = 0, drawY = 0, drawW = targetWidth, drawH = targetHeight;

        if (scaleMode === 'stretch') {
            // Default, already set
        } else if (scaleMode === 'center') {
            drawW = sourceWidth;
            drawH = sourceHeight;
            drawX = (targetWidth - drawW) / 2;
            drawY = (targetHeight - drawH) / 2;
        } else if (scaleMode === 'fit' || scaleMode === 'cover') {
            const imgRatio = sourceWidth / sourceHeight;
            const targetRatio = targetWidth / targetHeight;
            let useWidth = true;

            if (scaleMode === 'fit') {
                useWidth = imgRatio > targetRatio;
            } else { // cover
                useWidth = imgRatio < targetRatio;
            }

            if (useWidth) {
                drawW = targetWidth;
                drawH = targetWidth / imgRatio;
            } else {
                drawH = targetHeight;
                drawW = targetHeight * imgRatio;
            }
            drawX = (targetWidth - drawW) / 2;
            drawY = (targetHeight - drawH) / 2;
        }

        ctx.drawImage(img, drawX, drawY, drawW, drawH);

        const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        const rgb565 = this.rgbaToRgb565BE(imageData.data);
        return {
            canvas: canvas, // for preview
            data: rgb565
        };
    },

    rgbaToRgb565BE(rgbaData) {
        const pixelCount = rgbaData.length / 4;
        const rgb565 = new Uint8Array(pixelCount * 2);

        for (let i = 0; i < pixelCount; i++) {
            const r = rgbaData[i * 4];
            const g = rgbaData[i * 4 + 1];
            const b = rgbaData[i * 4 + 2];
            // Ignore alpha since we've already composited over a solid background

            // RGB565 conversion
            const r5 = (r >> 3) & 0x1F;
            const g6 = (g >> 2) & 0x3F;
            const b5 = (b >> 3) & 0x1F;
            const val = (r5 << 11) | (g6 << 5) | b5;

            // Big Endian
            rgb565[i * 2] = (val >> 8) & 0xFF;
            rgb565[i * 2 + 1] = val & 0xFF;
        }
        return rgb565;
    }
};
