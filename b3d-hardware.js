(function (root) {
    'use strict';

    function decode(bytes) {
        if (!bytes || typeof bytes.byteLength !== 'number') throw new Error('Нет TriData');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0,
            total = 0;
        const need = (n) => {
            if (!Number.isSafeInteger(n) || n < 0 || offset + n > view.byteLength) throw new Error('Повреждён TriData');
        };
        const int = () => {
            need(4);
            const n = view.getInt32(offset, true);
            offset += 4;
            return n;
        };
        const count = int();
        if (count < 1 || count > 4096) throw new Error('Неизвестный формат TriData');
        const groups = [];
        for (let group = 0; group < count; group++) {
            const length = int();
            if (length < 0 || length > 4096) throw new Error('Некорректный материал TriData');
            need(length * 2);
            const materialName = new TextDecoder('utf-16le').decode(
                new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length * 2)
            );
            offset += length * 2;
            need(129);
            const mapping = [];
            for (let i = 0; i < 16; i++) {
                const value = view.getFloat64(offset, true);
                offset += 8;
                if (!Number.isFinite(value)) throw new Error('Некорректная матрица TriData');
                mapping.push(value);
            }
            const flags = view.getUint8(offset++);
            if (flags !== 0) throw new Error('Неподдерживаемая версия TriData');
            const triangles = int();
            if (triangles < 0 || triangles > 1000000 - total) throw new Error('Слишком много треугольников фурнитуры');
            need(triangles * 112);
            total += triangles;
            const positions = new Float32Array(triangles * 9),
                normals = new Float32Array(triangles * 9),
                uvs = new Float32Array(triangles * 6);
            for (let i = 0; i < triangles; i++) {
                const start = offset + i * 112;
                for (let j = 0; j < 9; j++) {
                    const p = view.getFloat32(start + j * 4, true),
                        n = view.getFloat32(start + 36 + j * 4, true);
                    if (!Number.isFinite(p) || Math.abs(p) > 1e9 || !Number.isFinite(n))
                        throw new Error('Некорректные координаты TriData');
                    positions[i * 9 + j] = p;
                    normals[i * 9 + j] = n;
                }
                for (let vertex = 0; vertex < 3; vertex++) {
                    const index = i * 9 + vertex * 3;
                    let x = normals[index],
                        y = normals[index + 1],
                        z = normals[index + 2],
                        length = Math.hypot(x, y, z);
                    if (length < 1e-8) {
                        x = view.getFloat32(start + 72, true);
                        y = view.getFloat32(start + 76, true);
                        z = view.getFloat32(start + 80, true);
                        length = Math.hypot(x, y, z);
                    }
                    if (!Number.isFinite(length) || length < 1e-8) {
                        x = 0;
                        y = 0;
                        z = 1;
                        length = 1;
                    }
                    normals[index] = x / length;
                    normals[index + 1] = y / length;
                    normals[index + 2] = z / length;
                }
                for (let j = 0; j < 6; j++) {
                    const value = view.getFloat32(start + 84 + j * 4, true);
                    uvs[i * 6 + j] = Number.isFinite(value) ? value : 0;
                }
            }
            offset += triangles * 112;
            groups.push({ materialName, mapping, triangles, positions, normals, uvs });
        }
        if (offset !== view.byteLength) throw new Error('Неизвестные дополнительные данные TriData');
        return { groups, triangles: total };
    }
    function geometry(decoded, THREE) {
        const positions = new Float32Array(decoded.triangles * 9),
            normals = new Float32Array(decoded.triangles * 9),
            uvs = new Float32Array(decoded.triangles * 6);
        let vertex = 0;
        for (const group of decoded.groups) {
            positions.set(group.positions, vertex * 3);
            normals.set(group.normals, vertex * 3);
            uvs.set(group.uvs, vertex * 2);
            vertex += group.triangles * 3;
        }
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        result.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        result.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        result.addGroup(0, vertex, 0);
        result.computeBoundingBox();
        result.computeBoundingSphere();
        return result;
    }
    function edges(bytes, THREE) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0;
        const need = (n) => {
            if (offset + n > view.byteLength) throw new Error('Truncated Edges');
        };
        const integer = () => {
            need(4);
            const n = view.getInt32(offset, true);
            offset += 4;
            return n;
        };
        const number = () => {
            need(8);
            const n = view.getFloat64(offset, true);
            offset += 8;
            if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw new Error('Invalid Edges coordinate');
            return n;
        };
        const count = integer(),
            positions = [];
        if (count < 0 || count > 100000) throw new Error('Invalid Edges count');
        for (let i = 0; i < count; i++) {
            const type = integer();
            if (type === 3) for (let j = 0; j < 6; j++) number();
            else if (type !== 1) throw new Error('Unsupported Edges type ' + type);
            const count = integer();
            if (count < 2 || count > 1000000) throw new Error('Invalid Edges polyline');
            let previous = null;
            for (let j = 0; j < count; j++) {
                const point = [number(), number(), number()];
                if (previous) positions.push(...previous, ...point);
                previous = point;
            }
        }
        if (offset !== view.byteLength) throw new Error('Unexpected Edges data');
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        return result;
    }
    const api = { decode, geometry, edges };
    root.BazisHardware = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
