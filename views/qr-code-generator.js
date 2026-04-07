(function (global) {
    'use strict';

    const QUIET_ZONE = 4;
    const DEFAULT_SCALE = 10;
    const FORMAT_GENERATOR = 0x537;
    const FORMAT_MASK = 0x5412;
    const VERSION_GENERATOR = 0x1F25;
    const ERROR_CORRECTION_LEVEL = {
        M: {
            formatBits: 0,
            blocks: [
                [1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43],
                [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 36, 2, 59, 37], [4, 69, 43, 1, 70, 44],
                [1, 80, 50, 4, 81, 51], [6, 58, 36, 2, 59, 37], [8, 59, 37, 1, 60, 38], [4, 64, 40, 5, 65, 41], [5, 65, 41, 5, 66, 42],
                [7, 73, 45, 3, 74, 46], [10, 74, 46, 1, 75, 47], [9, 69, 43, 4, 70, 44], [3, 70, 44, 11, 71, 45], [3, 67, 41, 13, 68, 42],
                [17, 68, 42], [17, 74, 46], [4, 75, 47, 14, 76, 48], [6, 73, 45, 14, 74, 46], [8, 75, 47, 13, 76, 48],
                [19, 74, 46, 4, 75, 47], [22, 73, 45, 3, 74, 46], [3, 73, 45, 23, 74, 46], [21, 73, 45, 7, 74, 46], [19, 75, 47, 10, 76, 48],
                [2, 74, 46, 29, 75, 47], [10, 74, 46, 23, 75, 47], [14, 74, 46, 21, 75, 47], [14, 74, 46, 23, 75, 47], [12, 75, 47, 26, 76, 48],
                [6, 75, 47, 34, 76, 48], [29, 74, 46, 14, 75, 47], [13, 74, 46, 32, 75, 47], [40, 75, 47, 7, 76, 48], [18, 75, 47, 31, 76, 48]
            ]
        }
    };
    const ALIGNMENT_PATTERN_POSITIONS = [
        [],
        [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
        [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
        [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
        [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
    ];
    const generatorCache = {};

    const EXP_TABLE = new Array(512);
    const LOG_TABLE = new Array(256);

    (function buildGaloisTables() {
        let x = 1;
        for (let i = 0; i < 255; i += 1) {
            EXP_TABLE[i] = x;
            LOG_TABLE[x] = i;
            x <<= 1;
            if (x & 0x100) x ^= 0x11D;
        }
        for (let i = 255; i < 512; i += 1) {
            EXP_TABLE[i] = EXP_TABLE[i - 255];
        }
    })();

    class BitBuffer {
        constructor() {
            this.buffer = [];
            this.length = 0;
        }

        put(num, length) {
            for (let i = length - 1; i >= 0; i -= 1) {
                this.putBit(((num >>> i) & 1) === 1);
            }
        }

        putBit(bit) {
            const bufIndex = Math.floor(this.length / 8);
            if (this.buffer.length <= bufIndex) this.buffer.push(0);
            if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
            this.length += 1;
        }
    }

    function gfMultiply(a, b) {
        if (a === 0 || b === 0) return 0;
        return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
    }

    function multiplyPolynomials(a, b) {
        const result = new Array(a.length + b.length - 1).fill(0);
        for (let i = 0; i < a.length; i += 1) {
            for (let j = 0; j < b.length; j += 1) {
                result[i + j] ^= gfMultiply(a[i], b[j]);
            }
        }
        return result;
    }

    function buildGeneratorPolynomial(degree) {
        if (generatorCache[degree]) return generatorCache[degree];

        let polynomial = [1];
        for (let i = 0; i < degree; i += 1) {
            polynomial = multiplyPolynomials(polynomial, [1, EXP_TABLE[i]]);
        }

        generatorCache[degree] = polynomial;
        return polynomial;
    }

    function calculateErrorCorrectionBytes(dataBytes, ecCount) {
        const generator = buildGeneratorPolynomial(ecCount);
        const message = dataBytes.concat(new Array(ecCount).fill(0));

        for (let i = 0; i < dataBytes.length; i += 1) {
            const factor = message[i];
            if (factor === 0) continue;

            for (let j = 0; j < generator.length; j += 1) {
                message[i + j] ^= gfMultiply(generator[j], factor);
            }
        }

        return message.slice(message.length - ecCount);
    }

    function getUtf8Bytes(text) {
        if (typeof TextEncoder !== 'undefined') {
            return Array.from(new TextEncoder().encode(text));
        }
        if (typeof Buffer !== 'undefined') {
            return Array.from(Buffer.from(text, 'utf8'));
        }
        throw new Error('Nao foi possivel codificar o texto em UTF-8.');
    }

    function getCharacterCountBitLength(version) {
        return version < 10 ? 8 : 16;
    }

    function expandBlocks(version, levelKey) {
        const blockConfig = ERROR_CORRECTION_LEVEL[levelKey].blocks[version - 1];
        if (!blockConfig) throw new Error(`Versao QR invalida: ${version}`);

        const blocks = [];
        for (let i = 0; i < blockConfig.length; i += 3) {
            const count = blockConfig[i];
            const totalCount = blockConfig[i + 1];
            const dataCount = blockConfig[i + 2];
            for (let j = 0; j < count; j += 1) {
                blocks.push({ totalCount, dataCount });
            }
        }
        return blocks;
    }

    function pickVersion(dataBytes, levelKey) {
        for (let version = 1; version <= 40; version += 1) {
            const blocks = expandBlocks(version, levelKey);
            const dataCapacity = blocks.reduce((sum, block) => sum + block.dataCount, 0) * 8;
            const requiredBits = 4 + getCharacterCountBitLength(version) + (dataBytes.length * 8);

            if (requiredBits <= dataCapacity) {
                return version;
            }
        }

        throw new Error('O texto/link esta grande demais para este gerador de QR Code.');
    }

    function createDataCodewords(version, dataBytes, levelKey) {
        const blocks = expandBlocks(version, levelKey);
        const totalDataCodewords = blocks.reduce((sum, block) => sum + block.dataCount, 0);
        const bitBuffer = new BitBuffer();

        bitBuffer.put(0x4, 4);
        bitBuffer.put(dataBytes.length, getCharacterCountBitLength(version));
        dataBytes.forEach((byte) => bitBuffer.put(byte, 8));

        const totalDataBits = totalDataCodewords * 8;
        const terminatorLength = Math.min(4, totalDataBits - bitBuffer.length);
        if (terminatorLength > 0) bitBuffer.put(0, terminatorLength);

        while (bitBuffer.length % 8 !== 0) bitBuffer.putBit(false);

        const padBytes = [0xEC, 0x11];
        let padIndex = 0;
        while (bitBuffer.buffer.length < totalDataCodewords) {
            bitBuffer.put(padBytes[padIndex % 2], 8);
            padIndex += 1;
        }

        let offset = 0;
        const dataBlocks = [];
        const ecBlocks = [];
        let maxDataCount = 0;
        let maxEcCount = 0;

        blocks.forEach((block) => {
            const blockData = bitBuffer.buffer.slice(offset, offset + block.dataCount);
            offset += block.dataCount;

            const ecCount = block.totalCount - block.dataCount;
            const blockEc = calculateErrorCorrectionBytes(blockData, ecCount);

            dataBlocks.push(blockData);
            ecBlocks.push(blockEc);
            maxDataCount = Math.max(maxDataCount, blockData.length);
            maxEcCount = Math.max(maxEcCount, blockEc.length);
        });

        const codewords = [];

        for (let i = 0; i < maxDataCount; i += 1) {
            dataBlocks.forEach((block) => {
                if (i < block.length) codewords.push(block[i]);
            });
        }

        for (let i = 0; i < maxEcCount; i += 1) {
            ecBlocks.forEach((block) => {
                if (i < block.length) codewords.push(block[i]);
            });
        }

        return codewords;
    }

    function createMatrix(size, defaultValue) {
        return Array.from({ length: size }, () => Array.from({ length: size }, () => defaultValue));
    }

    function setFunctionModule(modules, isFunction, row, col, value) {
        if (row < 0 || row >= modules.length || col < 0 || col >= modules.length) return;
        modules[row][col] = value;
        if (isFunction) isFunction[row][col] = true;
    }

    function setupFinderPattern(modules, isFunction, row, col) {
        for (let r = -1; r <= 7; r += 1) {
            for (let c = -1; c <= 7; c += 1) {
                const targetRow = row + r;
                const targetCol = col + c;
                const inBounds = targetRow >= 0 && targetRow < modules.length && targetCol >= 0 && targetCol < modules.length;
                if (!inBounds) continue;

                const isBorder = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
                const isCenter = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
                setFunctionModule(modules, isFunction, targetRow, targetCol, isBorder || isCenter);
            }
        }
    }

    function setupAlignmentPattern(modules, isFunction, row, col) {
        for (let r = -2; r <= 2; r += 1) {
            for (let c = -2; c <= 2; c += 1) {
                const targetRow = row + r;
                const targetCol = col + c;
                const value = Math.max(Math.abs(r), Math.abs(c)) !== 1;
                setFunctionModule(modules, isFunction, targetRow, targetCol, value);
            }
        }
    }

    function setupTimingPattern(modules, isFunction) {
        const size = modules.length;
        for (let i = 8; i < size - 8; i += 1) {
            if (!isFunction[i][6]) setFunctionModule(modules, isFunction, i, 6, i % 2 === 0);
            if (!isFunction[6][i]) setFunctionModule(modules, isFunction, 6, i, i % 2 === 0);
        }
    }

    function getBchDigit(value) {
        let digit = 0;
        while (value !== 0) {
            digit += 1;
            value >>>= 1;
        }
        return digit;
    }

    function getBchTypeInfo(value) {
        let data = value << 10;
        while (getBchDigit(data) - getBchDigit(FORMAT_GENERATOR) >= 0) {
            data ^= (FORMAT_GENERATOR << (getBchDigit(data) - getBchDigit(FORMAT_GENERATOR)));
        }
        return ((value << 10) | data) ^ FORMAT_MASK;
    }

    function getBchTypeNumber(value) {
        let data = value << 12;
        while (getBchDigit(data) - getBchDigit(VERSION_GENERATOR) >= 0) {
            data ^= (VERSION_GENERATOR << (getBchDigit(data) - getBchDigit(VERSION_GENERATOR)));
        }
        return (value << 12) | data;
    }

    function writeFormatInformation(modules, isFunction, maskPattern, levelKey, reserveOnly) {
        const size = modules.length;
        const data = (ERROR_CORRECTION_LEVEL[levelKey].formatBits << 3) | maskPattern;
        const bits = getBchTypeInfo(data);

        for (let i = 0; i < 15; i += 1) {
            const value = reserveOnly ? false : (((bits >>> i) & 1) === 1);

            if (i < 6) {
                setFunctionModule(modules, isFunction, i, 8, value);
            } else if (i < 8) {
                setFunctionModule(modules, isFunction, i + 1, 8, value);
            } else {
                setFunctionModule(modules, isFunction, size - 15 + i, 8, value);
            }

            if (i < 8) {
                setFunctionModule(modules, isFunction, 8, size - i - 1, value);
            } else if (i < 9) {
                setFunctionModule(modules, isFunction, 8, 7, value);
            } else {
                setFunctionModule(modules, isFunction, 8, 15 - i - 1, value);
            }
        }

        setFunctionModule(modules, isFunction, size - 8, 8, reserveOnly ? false : true);
    }

    function writeVersionInformation(modules, isFunction, version, reserveOnly) {
        if (version < 7) return;

        const size = modules.length;
        const bits = getBchTypeNumber(version);

        for (let i = 0; i < 18; i += 1) {
            const value = reserveOnly ? false : (((bits >>> i) & 1) === 1);
            const row = Math.floor(i / 3);
            const col = i % 3 + size - 11;
            setFunctionModule(modules, isFunction, row, col, value);
            setFunctionModule(modules, isFunction, col, row, value);
        }
    }

    function buildBaseMatrix(version, levelKey) {
        const size = 17 + (version * 4);
        const modules = createMatrix(size, null);
        const isFunction = createMatrix(size, false);
        const alignmentPositions = ALIGNMENT_PATTERN_POSITIONS[version - 1];

        setupFinderPattern(modules, isFunction, 0, 0);
        setupFinderPattern(modules, isFunction, size - 7, 0);
        setupFinderPattern(modules, isFunction, 0, size - 7);
        setupTimingPattern(modules, isFunction);

        alignmentPositions.forEach((row) => {
            alignmentPositions.forEach((col) => {
                const overlapsFinder =
                    (row <= 8 && col <= 8) ||
                    (row <= 8 && col >= size - 9) ||
                    (row >= size - 9 && col <= 8);
                if (!overlapsFinder) setupAlignmentPattern(modules, isFunction, row, col);
            });
        });

        setFunctionModule(modules, isFunction, size - 8, 8, true);
        writeFormatInformation(modules, isFunction, 0, levelKey, true);
        writeVersionInformation(modules, isFunction, version, true);

        return { modules, isFunction };
    }

    function cloneMatrix(matrix) {
        return matrix.map((row) => row.slice());
    }

    function getMask(maskPattern, row, col) {
        switch (maskPattern) {
            case 0: return (row + col) % 2 === 0;
            case 1: return row % 2 === 0;
            case 2: return col % 3 === 0;
            case 3: return (row + col) % 3 === 0;
            case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
            case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
            case 6: return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
            case 7: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
            default: throw new Error(`Mascara QR invalida: ${maskPattern}`);
        }
    }

    function mapCodewords(modules, isFunction, codewords, maskPattern) {
        const size = modules.length;
        let row = size - 1;
        let direction = -1;
        let byteIndex = 0;
        let bitIndex = 7;

        for (let col = size - 1; col > 0; col -= 2) {
            if (col === 6) col -= 1;

            while (true) {
                for (let c = 0; c < 2; c += 1) {
                    const currentCol = col - c;
                    if (isFunction[row][currentCol]) continue;

                    let dark = false;
                    if (byteIndex < codewords.length) {
                        dark = (((codewords[byteIndex] >>> bitIndex) & 1) === 1);
                    }

                    if (getMask(maskPattern, row, currentCol)) dark = !dark;
                    modules[row][currentCol] = dark;

                    bitIndex -= 1;
                    if (bitIndex < 0) {
                        byteIndex += 1;
                        bitIndex = 7;
                    }
                }

                row += direction;
                if (row < 0 || row >= size) {
                    row -= direction;
                    direction *= -1;
                    break;
                }
            }
        }
    }

    function scoreConsecutivePatterns(modules) {
        let penalty = 0;
        const size = modules.length;

        for (let row = 0; row < size; row += 1) {
            let current = modules[row][0];
            let runLength = 1;

            for (let col = 1; col < size; col += 1) {
                if (modules[row][col] === current) {
                    runLength += 1;
                } else {
                    if (runLength >= 5) penalty += 3 + (runLength - 5);
                    current = modules[row][col];
                    runLength = 1;
                }
            }

            if (runLength >= 5) penalty += 3 + (runLength - 5);
        }

        for (let col = 0; col < size; col += 1) {
            let current = modules[0][col];
            let runLength = 1;

            for (let row = 1; row < size; row += 1) {
                if (modules[row][col] === current) {
                    runLength += 1;
                } else {
                    if (runLength >= 5) penalty += 3 + (runLength - 5);
                    current = modules[row][col];
                    runLength = 1;
                }
            }

            if (runLength >= 5) penalty += 3 + (runLength - 5);
        }

        return penalty;
    }

    function scoreTwoByTwoBlocks(modules) {
        let penalty = 0;
        const size = modules.length;

        for (let row = 0; row < size - 1; row += 1) {
            for (let col = 0; col < size - 1; col += 1) {
                const color = modules[row][col];
                if (
                    color === modules[row][col + 1] &&
                    color === modules[row + 1][col] &&
                    color === modules[row + 1][col + 1]
                ) {
                    penalty += 3;
                }
            }
        }

        return penalty;
    }

    function hasFinderSequence(values, start) {
        const patternA = values[start] &&
            !values[start + 1] &&
            values[start + 2] &&
            values[start + 3] &&
            values[start + 4] &&
            !values[start + 5] &&
            values[start + 6] &&
            !values[start + 7] &&
            !values[start + 8] &&
            !values[start + 9] &&
            !values[start + 10];

        const patternB = !values[start] &&
            !values[start + 1] &&
            !values[start + 2] &&
            !values[start + 3] &&
            values[start + 4] &&
            !values[start + 5] &&
            values[start + 6] &&
            values[start + 7] &&
            values[start + 8] &&
            !values[start + 9] &&
            values[start + 10];

        return patternA || patternB;
    }

    function scoreFinderLikePatterns(modules) {
        let penalty = 0;
        const size = modules.length;

        for (let row = 0; row < size; row += 1) {
            for (let col = 0; col <= size - 11; col += 1) {
                if (hasFinderSequence(modules[row], col)) penalty += 40;
            }
        }

        for (let col = 0; col < size; col += 1) {
            const columnValues = [];
            for (let row = 0; row < size; row += 1) {
                columnValues.push(modules[row][col]);
            }
            for (let row = 0; row <= size - 11; row += 1) {
                if (hasFinderSequence(columnValues, row)) penalty += 40;
            }
        }

        return penalty;
    }

    function scoreDarkRatio(modules) {
        let darkCount = 0;
        const size = modules.length;
        const totalModules = size * size;

        for (let row = 0; row < size; row += 1) {
            for (let col = 0; col < size; col += 1) {
                if (modules[row][col]) darkCount += 1;
            }
        }

        const percentage = (darkCount * 100) / totalModules;
        const deviation = Math.abs(percentage - 50);
        return Math.floor(deviation / 5) * 10;
    }

    function calculatePenaltyScore(modules) {
        return scoreConsecutivePatterns(modules) +
            scoreTwoByTwoBlocks(modules) +
            scoreFinderLikePatterns(modules) +
            scoreDarkRatio(modules);
    }

    function chooseBestMatrix(version, codewords, levelKey) {
        const base = buildBaseMatrix(version, levelKey);
        let bestMatrix = null;
        let bestScore = Infinity;
        let bestMask = 0;

        for (let maskPattern = 0; maskPattern < 8; maskPattern += 1) {
            const modules = cloneMatrix(base.modules);
            mapCodewords(modules, base.isFunction, codewords, maskPattern);
            writeFormatInformation(modules, null, maskPattern, levelKey, false);
            writeVersionInformation(modules, null, version, false);

            const score = calculatePenaltyScore(modules);
            if (score < bestScore) {
                bestScore = score;
                bestMatrix = modules;
                bestMask = maskPattern;
            }
        }

        return { modules: bestMatrix, maskPattern: bestMask };
    }

    function buildPathData(matrix, margin) {
        let path = '';

        for (let row = 0; row < matrix.length; row += 1) {
            for (let col = 0; col < matrix.length; col += 1) {
                if (!matrix[row][col]) continue;
                const x = col + margin;
                const y = row + margin;
                path += `M${x} ${y}h1v1H${x}z `;
            }
        }

        return path.trim();
    }

    function toSvgString(matrix, options) {
        const margin = options && Number.isInteger(options.margin) ? options.margin : QUIET_ZONE;
        const scale = options && Number.isInteger(options.scale) ? options.scale : DEFAULT_SCALE;
        const color = options && options.color ? options.color : '#111827';
        const background = options && options.background ? options.background : '#FFFFFF';
        const logicalSize = matrix.length + (margin * 2);
        const pixelSize = logicalSize * scale;
        const pathData = buildPathData(matrix, margin);

        return [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 ${logicalSize} ${logicalSize}" shape-rendering="crispEdges">`,
            `<rect width="${logicalSize}" height="${logicalSize}" fill="${background}"/>`,
            `<path d="${pathData}" fill="${color}"/>`,
            '</svg>'
        ].join('');
    }

    function renderToCanvas(matrix, canvas, options) {
        if (!canvas || typeof canvas.getContext !== 'function') {
            throw new Error('Canvas indisponivel para renderizar o QR Code.');
        }

        const margin = options && Number.isInteger(options.margin) ? options.margin : QUIET_ZONE;
        const scale = options && Number.isInteger(options.scale) ? options.scale : DEFAULT_SCALE;
        const color = options && options.color ? options.color : '#111827';
        const background = options && options.background ? options.background : '#FFFFFF';
        const logicalSize = matrix.length + (margin * 2);
        const pixelSize = logicalSize * scale;
        const ctx = canvas.getContext('2d');

        canvas.width = pixelSize;
        canvas.height = pixelSize;
        canvas.style.width = `${pixelSize}px`;
        canvas.style.height = `${pixelSize}px`;

        ctx.fillStyle = background;
        ctx.fillRect(0, 0, pixelSize, pixelSize);
        ctx.fillStyle = color;

        for (let row = 0; row < matrix.length; row += 1) {
            for (let col = 0; col < matrix.length; col += 1) {
                if (!matrix[row][col]) continue;
                ctx.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
            }
        }

        return canvas;
    }

    function createQrCode(text, options) {
        const normalized = String(text || '');
        const levelKey = (options && options.errorCorrectionLevel) || 'M';
        const dataBytes = getUtf8Bytes(normalized);
        const version = pickVersion(dataBytes, levelKey);
        const codewords = createDataCodewords(version, dataBytes, levelKey);
        const best = chooseBestMatrix(version, codewords, levelKey);

        return {
            text: normalized,
            version,
            maskPattern: best.maskPattern,
            size: best.modules.length,
            matrix: best.modules,
            toSvgString(renderOptions) {
                return toSvgString(best.modules, renderOptions);
            },
            renderToCanvas(canvas, renderOptions) {
                return renderToCanvas(best.modules, canvas, renderOptions);
            }
        };
    }

    const api = {
        create: createQrCode,
        toSvgString,
        renderToCanvas
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    global.ResultQRCode = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
