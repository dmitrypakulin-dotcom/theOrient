(function (root) {
    'use strict';

    /**
     * Вычисляет SHA-256 хеш для переданного буфера (ArrayBuffer).
     * Используется для уникальной идентификации загруженных текстур.
     * @param {ArrayBuffer} buffer - бинарные данные картинки.
     * @returns {Promise<string>} - хеш в виде 64-символьной hex-строки.
     */
    async function hash(buffer) {
        // 1. БЫСТРЫЙ ПУТЬ: Используем встроенный Web Crypto API браузера.
        // Работает только в безопасном контексте (HTTPS или localhost).
        if (root.crypto && root.crypto.subtle) {
            return Array.from(
                new Uint8Array(await root.crypto.subtle.digest('SHA-256', buffer)), 
                (n) => n.toString(16).padStart(2, '0')
            ).join('');
        }

        // 2. РЕЗЕРВНЫЙ ПУТЬ: Если Web Crypto API недоступен (например, открыто по http://),
        // используем собственную реализацию SHA-256 на чистом JavaScript.
        
        // Генерируем константы и начальные значения на основе квадратных и кубических корней простых чисел.
        // Это стандартный алгоритм инициализации SHA-256.
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
                // Первые 8 простых чисел дают начальные значения (initial)
                if (initial.length < 8) initial.push(((Math.sqrt(n) % 1) * 4294967296) >>> 0);
                // Первые 64 простых числа дают константы (constants)
                constants.push(((Math.cbrt(n) % 1) * 4294967296) >>> 0);
            }
        }

        // Подготовка данных: добавление бита '1' и нулей в конец (padding), 
        // а также запись длины исходного сообщения в битах.
        const input = new Uint8Array(buffer),
            length = Math.ceil((input.length + 9) / 64) * 64,
            data = new Uint8Array(length);
        data.set(input);
        data[input.length] = 128; // 10000000 в двоичном виде
        
        const view = new DataView(data.buffer);
        view.setUint32(length - 8, Math.floor(input.length / 536870912));
        view.setUint32(length - 4, (input.length * 8) >>> 0);

        // Основной цикл обработки блоков по 64 байта
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
            
            // 64 раунда сжатия
            for (let i = 0; i < 64; i++) {
                const t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i];
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
            
            // Прибавляем результат текущего блока к общему хешу
            [a, b, c, d, e, f, g, h].forEach((value, i) => (initial[i] = (initial[i] + value) >>> 0));
        }
        
        // Возвращаем результат в виде hex-строки
        return initial.map((n) => n.toString(16).padStart(8, '0')).join('');
    }
    
    // Экспорт модуля
    const api = { hash };
    root.TextureUtils = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
