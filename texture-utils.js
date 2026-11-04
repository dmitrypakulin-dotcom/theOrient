(function (root) {
    'use strict';
    async function hash(buffer) {
        if (root.crypto && root.crypto.subtle)
            return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256', buffer)), (n) =>
                n.toString(16).padStart(2, '0')
            ).join('');

        const constants = [],
            initial = [];
        for (let n = 2; constants.length < 64; n++) {
            let prime = true;
            for (let d = 2; d * d <= n; d++)
                if (n % d === 0) {
                    prime = false;
                    break;
                }
            if (prime) {
                if (initial.length < 8) initial.push(((Math.sqrt(n) % 1) * 4294967296) >>> 0);
                constants.push(((Math.cbrt(n) % 1) * 4294967296) >>> 0);
            }
        }
        const input = new Uint8Array(buffer),
            length = Math.ceil((input.length + 9) / 64) * 64,
            data = new Uint8Array(length);
        data.set(input);
        data[input.length] = 128;
        const view = new DataView(data.buffer);
        view.setUint32(length - 8, Math.floor(input.length / 536870912));
        view.setUint32(length - 4, (input.length * 8) >>> 0);
        const words = new Uint32Array(64),
            rotate = (n, bits) => (n >>> bits) | (n << (32 - bits));
        for (let offset = 0; offset < length; offset += 64) {
            for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
            for (let i = 16; i < 64; i++) {
                const a = words[i - 15],
                    b = words[i - 2];
                words[i] =
                    words[i - 16] +
                    (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
                    words[i - 7] +
                    (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
            }
            let [a, b, c, d, e, f, g, h] = initial;
            for (let i = 0; i < 64; i++) {
                const t1 =
                    h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i];
                const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
                h = g;
                g = f;
                f = e;
                e = (d + t1) | 0;
                d = c;
                c = b;
                b = a;
                a = (t1 + t2) | 0;
            }
            [a, b, c, d, e, f, g, h].forEach((value, i) => (initial[i] = (initial[i] + value) >>> 0));
        }
        return initial.map((n) => n.toString(16).padStart(8, '0')).join('');
        }
        
        const api = { hash }; // <--- ДОБАВЬТЕ ВОТ ЭТУ СТРОКУ
        
        root.TextureUtils = api;
        if (typeof module !== 'undefined' && module.exports) module.exports = api;
    })(typeof globalThis !== 'undefined' ? globalThis : this);
