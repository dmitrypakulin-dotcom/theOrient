(function (root) {
    'use strict';

    /**
     * Строит 2D-геометрию «заглушки» (среза) для 3D-модели.
     * @param {THREE.BufferGeometry} source - Исходная геометрия панели.
     * @param {THREE.Plane} plane - Плоскость, которой режем модель.
     * @param {Object} THREE - Библиотека Three.js.
     * @returns {THREE.BufferGeometry} Геометрия плоского среза (с UV-координатами и контуром).
     */
    function geometry(source, plane, THREE) {
        const position = source.attributes.position,
            index = source.index;
            
        const normal = plane.normal,
            origin = normal.clone().multiplyScalar(-plane.constant); // Точка на плоскости
            
        // Создаем локальную 2D-систему координат (векторы u и v) для проекции
        // u выбираем так, чтобы он не был параллелен нормали
        const u = new THREE.Vector3(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0)
            .cross(normal)
            .normalize();
        const v = normal.clone().cross(u),
            points = new Map(), // Уникальные точки пересечения (узлы графа)
            edges = new Map();  // Ребра графа (линии пересечения)
            
        const epsilon = 1e-4; // Погрешность для сравнения чисел с плавающей точкой
        
        // Уникальный ключ для 2D-точки (округление до 4 знаков)
        function key(p) {
            return Math.round(p.x / epsilon) + ':' + Math.round(p.y / epsilon);
        }
        
        // Хелпер для получения вершины треугольника
        const vertex = (i) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i);
        
        // 1. Находим линии пересечения плоскости с треугольниками
        for (let i = 0, count = index ? index.count : position.count; i < count; i += 3) {
            const triangle = [vertex(i), vertex(i + 1), vertex(i + 2)],
                hits = [];
                
            // Считаем расстояния от вершин треугольника до плоскости
            const distances = triangle.map((p) => plane.distanceToPoint(p));
            
            // Если треугольник целиком по одну сторону — пропускаем
            if (!distances.some((d) => d > epsilon) || !distances.some((d) => d < -epsilon)) continue;
            
            // Находим точки, где ребра треугольника пересекают плоскость
            for (let j = 0; j < 3; j++) {
                const a = triangle[j],
                    b = triangle[(j + 1) % 3],
                    da = distances[j],
                    db = distances[(j + 1) % 3];
                    
                if (Math.abs(da) <= epsilon) hits.push(a.clone()); // Вершина лежит ровно на плоскости
                else if (da * db < 0) hits.push(a.clone().lerp(b, da / (da - db))); // Пересечение ребра
            }
            
            // Проецируем найденные 3D-точки на нашу 2D-плоскость (u, v)
            const projected = new Map();
            for (const hit of hits) {
                const delta = hit.sub(origin),
                    p = new THREE.Vector2(delta.dot(u), delta.dot(v));
                projected.set(key(p), p);
            }
            
            // Если получилось 2 точки — это отрезок (ребро среза)
            if (projected.size !== 2) continue;
            const [a, b] = [...projected.keys()],
                edgeKey = [a, b].sort().join('|'); // Ключ для ребра (без учета направления)
                
            if (edges.has(edgeKey)) continue; // Такое ребро уже есть
            edges.set(edgeKey, [a, b]);
            
            // Добавляем точки в граф
            for (const [id, p] of projected) if (!points.has(id)) points.set(id, { p, neighbors: [] });
            points.get(a).neighbors.push(b);
            points.get(b).neighbors.push(a);
        }

        // 2. Собираем отрезки в замкнутые контуры (петли)
        const loops = [],
            used = new Set();
            
        for (const start of points.keys()) {
            if (used.has(start)) continue;
            
            const loop = [];
            let current = start,
                previous = null,
                closed = false;
                
            // Идем по графу, пока не вернемся в начало
            while (!used.has(current)) {
                const entry = points.get(current);
                used.add(current);
                loop.push(entry.p);
                
                if (entry.neighbors.length !== 2) break; // Не замкнутый контур (разрыв)
                
                const next = entry.neighbors.find((id) => id !== previous);
                if (next === start) {
                    closed = true;
                    break;
                }
                previous = current;
                current = next;
            }
            
            if (closed && loop.length >= 3) loops.push(loop);
        }

        // 3. Определяем, где внешние контуры, а где отверстия (дырки)
        // Функция проверки, находится ли точка внутри полигона (Ray casting)
        const inside = (p, loop) => {
            let result = false;
            for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
                const a = loop[i],
                    b = loop[j];
                if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) result = !result;
            }
            return result;
        };
        
        // Считаем глубину вложенности каждой петли
        const depths = loops.map((loop, i) => loops.filter((other, j) => i !== j && inside(loop[0], other)).length);

        // 4. Триангуляция (превращение полигонов в треугольники)
        const positions = [],
            uv = [];
            
        loops.forEach((loop, i) => {
            if (depths[i] % 2) return; // Пропускаем отверстия (они добавляются в родительский контур)
            
            // Ищем отверстия, которые лежат внутри текущего контура
            const holes = loops.filter((hole, j) => depths[j] === depths[i] + 1 && inside(hole[0], loop));
            const all = loop.concat(...holes); // Общий массив всех точек
            
            // Триангулируем
            for (const face of THREE.ShapeUtils.triangulateShape(loop, holes)) {
                for (const id of face) {
                    const p = all[id],
                        // Обратное проецирование из 2D в 3D
                        world = origin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y);
                    positions.push(world.x, world.y, world.z);
                    
                    // UV-координаты (делим на 12, чтобы масштаб штриховки соответствовал 12 мм)
                    uv.push(p.x / 12, p.y / 12);
                }
            }
        });

        // 5. Формируем итоговую геометрию
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        result.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        result.computeVertexNormals();

        // 6. Создаем красный контур для обводки среза
        const outline = [];
        for (const loop of loops)
            for (let i = 0; i < loop.length; i++) {
                for (const p of [loop[i], loop[(i + 1) % loop.length]]) {
                    const world = origin.clone().addScaledVector(u, p.x).addScaledVector(v, p.y);
                    world.addScaledVector(normal, -0.03); // Чуть-чуть смещаем вглубь, чтобы линии не мерцали
                    outline.push(world.x, world.y, world.z);
                }
            }
        
        // Сохраняем контур в userData, чтобы section-tools.js мог его отрисовать
        result.userData.sectionOutline = outline;
        return result;
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { geometry };
    else root.SectionCaps = { geometry };
})(typeof globalThis !== 'undefined' ? globalThis : this);
