(function (root) {
    'use strict';
    class Reader {
        constructor(bytes, scalarChildren = true) {
            this.bytes = bytes;
            this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            this.pos = 0;
            this.nodes = 0;
            this.scalarChildren = scalarChildren;
        }
        need(n) {
            if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.bytes.length)
                throw new Error('Повреждённый блок B3D: выход за границы данных');
        }
        byte() {
            this.need(1);
            return this.view.getUint8(this.pos++);
        }
        int() {
            this.need(4);
            const v = this.view.getInt32(this.pos, true);
            this.pos += 4;
            return v;
        }
        double() {
            this.need(8);
            const v = this.view.getFloat64(this.pos, true);
            this.pos += 8;
            if (!Number.isFinite(v)) throw new Error('Некорректная координата');
            return v;
        }
        take(n) {
            this.need(n);
            const v = this.bytes.subarray(this.pos, this.pos + n);
            this.pos += n;
            return v;
        }
        field(names, depth = 0) {
            if (depth > 80 || ++this.nodes > 1000000) throw new Error('Слишком сложный файл');
            const index = this.int(),
                count = this.int(),
                tag = this.byte();
            if (index < -1 || index >= names.length) throw new Error('Неизвестное имя поля');
            if (count < 0 || count > 1000000) throw new Error('Некорректное число дочерних полей');
            const node = { name: index === -1 ? '' : names[index], value: null, sourceOffset: this.pos - 9 };
            switch (tag) {
                case 0:
                case 8:
                    if (count < 0 || count > 1000000) throw new Error('Некорректный список');
                    node.value = [];
                    for (let i = 0; i < count; i++) node.value.push(this.field(names, depth + 1));
                    break;
                case 1:
                    node.value = false;
                    break;
                case 2:
                    node.value = true;
                    break;
                case 3:
                    node.value = this.byte();
                    break;
                case 4:
                    node.value = this.int();
                    break;
                case 5:
                    node.value = this.double();
                    break;
                case 6:
                    node.value = new TextDecoder('utf-16le').decode(this.take(this.int() * 2));
                    break;
                case 7:
                    node.value = this.take(this.int());
                    break;
                default:
                    throw new Error('Неизвестный тип поля ' + tag + ' (' + node.name + ')');
            }

            if (this.scalarChildren && tag !== 0 && tag !== 8 && count) {
                node.children = [];
                for (let i = 0; i < count; i++) node.children.push(this.field(names, depth + 1));
            }
            return node;
        }
    }
    const get = (fields, name, fallback) => {
        const n = fields.find((n) => n.name === name);
        return n ? n.value : fallback;
    };
    function parse(buffer, inflate) {
        const bytes = new Uint8Array(buffer);
        if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'BZ85')
            throw new Error('Поддерживаются модели БАЗИС с сигнатурой BZ85');

        let start = 8;
        for (let i = 4; i + 12 <= bytes.length; i++) {
            if (
                bytes[i] === 73 &&
                bytes[i + 1] === 69 &&
                bytes[i + 2] === 78 &&
                bytes[i + 3] === 68 &&
                bytes[i - 1] === 0 &&
                bytes[i - 2] === 0 &&
                bytes[i - 3] === 0 &&
                bytes[i - 4] === 0
            ) {
                start = i + 8;
                break;
            }
        }
        let doc, names, lastError, legacySceneBoundary;
        for (let i = start; i + 2 < bytes.length; i++) {
            if (bytes[i] !== 120 || ((bytes[i] << 8) + bytes[i + 1]) % 31) continue;
            try {
                const raw = inflate(bytes.subarray(i));
                if (raw.length > 256 * 1024 * 1024) throw new Error('Распакованный файл превышает 256 МБ');
                const r = new Reader(raw),
                    count = r.int();
                if (count < 1 || count > 100000) throw new Error('Некорректная таблица строк');
                names = [];
                for (let j = 0; j < count; j++) names.push(new TextDecoder().decode(r.take(r.int())));
                if (!names.includes('Model') || !names.includes('Obj'))
                    throw new Error('Таблица полей не распознана; возможно, файл зашифрован');
                const index = r.int(),
                    children = r.int(),
                    tag = r.byte();
                if (names[index] !== 'Document' || tag !== 0 || children < 0 || children > 100000)
                    throw new Error('Не найден Document');
                const documentStart = r.pos;
                doc = [];
                let modelRead = false;
                for (let j = 0; j < children; j++) {
                    if (r.pos + 9 <= raw.length && names[r.view.getInt32(r.pos, true)] === 'Undo') break;
                    try {
                        const n = r.field(names);
                        doc.push(n);
                        if (n.name === 'Model') modelRead = true;
                    } catch (error) {
                        if (!modelRead) throw error;
                        break;
                    }
                }

                const legacy = new Reader(raw, false);
                legacy.pos = documentStart;
                try {
                    for (let j = 0; j < children; j++) legacy.field(names);
                } catch (_) {}
                legacySceneBoundary = legacy.pos;
                break;
            } catch (error) {
                lastError = error;
                doc = null;
            }
        }
        if (!doc) throw lastError || new Error('Сжатая геометрия B3D не найдена');
        const model = get(doc, 'Model', []);
        return {
            document: doc,
            model,
            scene: model.concat(doc.filter((node) => node.name === 'Obj')),
            legacySceneBoundary,
            get
        };
    }
    function contour(bytes, allowOpen = false) {
        const r = new Reader(bytes),
            count = r.int(),
            segments = [];
        if (count < 0 || count > 100000) throw new Error('Некорректное число сегментов');
        for (let i = 0; i < count; i++) {
            const tag = r.byte();
            if (tag === 16)
                segments.push([
                    [r.double(), r.double()],
                    [r.double(), r.double()]
                ]);
            else if (tag === 17 || tag === 20) {
                const x = r.double(),
                    y = r.double(),
                    radius = r.double();
                for (let j = 0; j < 48; j++) {
                    const a = (j * Math.PI) / 24,
                        b = ((j + 1) * Math.PI) / 24;
                    segments.push([
                        [x + radius * Math.cos(a), y + radius * Math.sin(a)],
                        [x + radius * Math.cos(b), y + radius * Math.sin(b)]
                    ]);
                }
            } else if (tag === 18) {
                const x = r.double(),
                    y = r.double(),
                    ax = r.double(),
                    ay = r.double(),
                    bx = r.double(),
                    by = r.double();
                r.byte();
                const a = Math.atan2(ay - y, ax - x),
                    b = Math.atan2(by - y, bx - x),
                    radius = Math.hypot(ax - x, ay - y);
                let delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
                const steps = Math.max(4, Math.ceil(Math.abs(delta) * 16));
                let previous = [ax, ay];
                for (let j = 1; j <= steps; j++) {
                    const theta = a + (delta * j) / steps,
                        next = j === steps ? [bx, by] : [x + radius * Math.cos(theta), y + radius * Math.sin(theta)];
                    segments.push([previous, next]);
                    previous = next;
                }
            } else throw new Error('Неподдерживаемый сегмент контура ' + tag);
        }
        const remaining = segments.slice(),
            loops = [],
            close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01;
        while (remaining.length) {
            const first = remaining.shift(),
                loop = [first[0], first[1]];
            while (!close(loop[0], loop[loop.length - 1])) {
                const last = loop[loop.length - 1],
                    index = remaining.findIndex((s) => close(s[0], last) || close(s[1], last));
                if (index < 0) {
                    if (allowOpen) {
                        const beginning = remaining.findIndex((s) => close(s[0], loop[0]) || close(s[1], loop[0]));
                        if (beginning < 0) break;
                        const segment = remaining.splice(beginning, 1)[0];
                        loop.unshift(close(segment[0], loop[0]) ? segment[1] : segment[0]);
                        continue;
                    }
                    throw new Error('Контур панели не замкнут');
                }
                const next = remaining.splice(index, 1)[0];
                loop.push(close(next[0], last) ? next[1] : next[0]);
            }
            if (!allowOpen && close(loop[0], loop[loop.length - 1])) loop.pop();
            if (loop.length >= (allowOpen ? 2 : 3)) loops.push(loop);
        }
        return loops;
    }
    const api = { parse, contour, get };
    root.BazisB3D = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
